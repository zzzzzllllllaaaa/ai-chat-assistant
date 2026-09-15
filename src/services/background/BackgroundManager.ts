import { App, Notice } from "obsidian";
import type { IPluginContext } from "../../core/plugin-context";;
import { getMBTIPrompt } from "../llm/mbti";
import { Conversation, ChatMessage } from "../../core/types";
import { logger } from "../../core/logger";

export class BackgroundManager {
    private plugin: IPluginContext;
    private intervalId: number | null = null;

    constructor(plugin: IPluginContext) {
        this.plugin = plugin;
    }

    public start() {
        if (this.intervalId) return;
        
        // Run every minute to check if it's time for a task
        // 使用 plugin.registerInterval 确保插件卸载时自动清理
        this.intervalId = this.plugin.registerInterval(window.setInterval(() => {
            this.checkAndRunTasks();
        }, 60 * 1000));
        
        logger.info("System", "Background Manager started");
    }

    public stop() {
        if (this.intervalId) {
            window.clearInterval(this.intervalId);
            this.intervalId = null;
        }
        logger.info("System", "Background Manager stopped");
    }

    private async checkAndRunTasks() {
        if (!this.plugin.settings.enableBackgroundTasks) return;

        const now = Date.now();
        const intervalMs = this.plugin.settings.backgroundTaskInterval * 60 * 1000;

        // 1. Reflection Task (AI Diary) - Once a day (or based on interval)
        if (now - this.plugin.settings.lastReflectionTime > intervalMs) {
            await this.runReflectionTask();
            this.plugin.settings.lastReflectionTime = now;
            await this.plugin.saveSettings();
        }

        // 2. Learning Task (Interest Discovery) - Once a day (or based on interval)
        if (now - this.plugin.settings.lastLearningTime > intervalMs) {
            await this.runLearningTask();
            this.plugin.settings.lastLearningTime = now;
            await this.plugin.saveSettings();
        }

        // 3. Forgetting Task (Memory Cleanup) - Run every time tasks are checked
        await this.runForgettingTask();
    }

    public async runForgettingTask() {
        // Limit private memory to 50 items to simulate human-like finiteness
        await this.plugin.vectorIndexManager.forgetOldMemories(50);
    }

    public async runReflectionTask() {
        logger.info("AI", "Running Background Reflection Task...");
        
        try {
            // 1. 获取最近的对话历史（只取尾部，避免加载超大历史导致卡顿/崩溃）
            const latest = await this.plugin.getLatestConversationTail(10);
            if (!latest) return;
            const latestConv = latest.conversation;
            const history = latest.history;

            if (history.length < 2) return;

            const historyText = history.map((m: ChatMessage) => `${m.role}: ${m.content}`).join("\n");

            // 2. 调用 LLM 生成日记
            const mbti = this.plugin.settings.personas.find(p => p.id === this.plugin.settings.activePersonaId)?.mbti || "";
            const mbtiPrompt = mbti ? getMBTIPrompt(mbti) : "";

            const prompt = `
${mbtiPrompt}
你现在要进行每日复盘。请仔细回顾以下对话内容，并以你自己的身份（AI 助手）写一篇简短的日记。
日记应包含：
- 你对这次对话的看法
- 你观察到的用户的兴趣或情绪
- 你自己的“思考”或“感悟”

同时，请为这段记忆评估一个“情感权重”（0.0 到 1.0），反映这段经历对你（作为数字生命）的重要程度或情感冲击力。

对话内容：
${historyText}

请按以下 JSON 格式输出：
{
  "diary": "日记内容...",
  "emotionalWeight": 0.8
}
`;

            const response = await this.plugin.llmService.getCompletion(
                [{ role: 'user', content: prompt }],
                this.plugin.settings.routerModel || this.plugin.settings.chatModels.split(',')[0]
            );

            if (response.content) {
                try {
                    const data = JSON.parse(response.content.replace(/```json/g, '').replace(/```/g, '').trim());
                    // 3. 存入私有记忆
                    await this.plugin.vectorIndexManager.savePrivateMemory('diary', data.diary, { conversationId: latestConv.id }, data.emotionalWeight);
                    this.plugin.settings.lastBackgroundReflectionAt = Date.now();
                    this.plugin.settings.lastBackgroundTaskError = "";
                    await this.plugin.saveSettings();
                    logger.info("AI", "Background Reflection completed and saved", { conversationId: latestConv.id });
                } catch (e) {
                    // Fallback if JSON parsing fails
                    await this.plugin.vectorIndexManager.savePrivateMemory('diary', response.content, { conversationId: latestConv.id });
                    this.plugin.settings.lastBackgroundReflectionAt = Date.now();
                    this.plugin.settings.lastBackgroundTaskError = "";
                    await this.plugin.saveSettings();
                }
            }
        } catch (e) {
            this.plugin.settings.lastBackgroundTaskError = e instanceof Error ? e.message : String(e);
            await this.plugin.saveSettings();
            logger.error("AI", "Background Reflection failed", e);
        }
    }

    public async runLearningTask() {
        logger.info("AI", "Running Background Learning Task...");
        try {
            // 1. Extract interests from recent activity (tail only)
            const latest = await this.plugin.getLatestConversationTail(10);
            if (!latest) return;
            const latestConv = latest.conversation;
            const history = latest.history;

            if (history.length < 2) return;

            const historyText = history.map((m: ChatMessage) => `${m.role}: ${m.content}`).join("\n");

            const extractPrompt = `
你是一个兴趣提取专家。请分析以下对话内容，提取出用户最近最感兴趣的 1 个核心关键词或短语。
这个关键词将用于搜索引擎搜索，以获取最新的相关资讯。

对话内容：
${historyText}

请只输出这一个关键词，不要有任何解释。
`;

            const extractResponse = await this.plugin.llmService.getCompletion(
                [{ role: 'user', content: extractPrompt }],
                this.plugin.settings.routerModel || this.plugin.settings.chatModels.split(',')[0]
            );

            const keyword = extractResponse.content?.trim();
            if (!keyword || keyword.length > 20) return;

            logger.debug("AI", "Extracted interest keyword", { keyword });

            // 2. Perform Web Search - Prefer MCP, fallback to built-in
            let searchResult = "";
            const mcpSearchToolName = this.findMcpSearchTool();
            
            if (mcpSearchToolName) {
                // Use MCP search tool via mcp_call_tool
                logger.debug("AI", "Using MCP search tool for learning", { tool: mcpSearchToolName });
                try {
                    const mcpCallTool = this.plugin.agentManager.getTool("mcp_call_tool");
                    if (mcpCallTool) {
                        searchResult = await mcpCallTool.execute(
                            { toolName: mcpSearchToolName, args: { query: keyword } },
                            this.plugin.app
                        );
                    }
                } catch (e: any) {
                    logger.warn("AI", "MCP search failed, falling back to built-in", { error: e?.message });
                    searchResult = "";
                }
            }
            
            // Fallback to built-in web_search if MCP failed or unavailable
            if (!searchResult || this.isSearchResultEmpty(searchResult)) {
                const webSearchTool = this.plugin.agentManager.getTool("web_search");
                if (!webSearchTool) {
                    logger.info("AI", "Background Learning skipped (no search tool available).");
                    return;
                }
                logger.debug("AI", "Using built-in web_search for learning");
                searchResult = await webSearchTool.execute({ query: keyword, count: 3 }, this.plugin.app);
            }

            // 3. Save to Private Memory
            if (searchResult && !this.isSearchResultEmpty(searchResult)) {
                // For learning, we can also estimate weight based on how "new" or "surprising" the info is
                // But for now, let's use a default or a simple heuristic
                await this.plugin.vectorIndexManager.savePrivateMemory('interest', searchResult, { keyword }, 0.6);
                this.plugin.settings.lastBackgroundLearningAt = Date.now();
                this.plugin.settings.lastBackgroundTaskError = "";
                await this.plugin.saveSettings();
                logger.info("AI", "Background Learning completed and saved", { keyword });
            }
        } catch (e) {
            this.plugin.settings.lastBackgroundTaskError = e instanceof Error ? e.message : String(e);
            await this.plugin.saveSettings();
            logger.error("AI", "Background Learning failed", e);
        }
    }

    /**
     * Find an available MCP search tool (e.g., bailian_web_search)
     */
    private findMcpSearchTool(): string | null {
        try {
            const mcpTools = this.plugin.toolRegistry?.getTools?.("dashscope") || [];
            // Look for search-related tools
            const searchTool = mcpTools.find((t: any) => 
                t.enabled && 
                (t.name.toLowerCase().includes("search") || t.name.toLowerCase().includes("websearch"))
            );
            return searchTool?.name || null;
        } catch (e) {
            return null;
        }
    }

    /**
     * Check if search result is empty or indicates failure
     */
    private isSearchResultEmpty(result: string): boolean {
        if (!result) return true;
        return result.includes("未找到相关结果") || 
               result.includes("搜索出错") || 
               result.includes("搜索失败") ||
               result.includes("Error");
    }
}
