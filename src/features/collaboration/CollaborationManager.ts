import { App, Notice } from "obsidian";
import type { IPluginContext } from "../../core/plugin-context";;
import { ChatMessage } from "../../core/types";
import { IntentResult, ExecutionPlan, PlanStep, Blackboard, BlackboardMessage } from "./types";
import { getMBTIPrompt } from "../../services/llm/mbti";
import { makeRunId } from "../../debug/ids";
import { DebugTrace } from "../../debug/trace";
import { logger } from "../../core/logger";
import { intentAnalyzer, type AnalyzedIntent, type SceneType, type ResponseMode } from "../../services/IntentAnalyzer";
import { StateGraph, createCollaborationGraph, GraphState, NodeContext } from "./StateGraph";
import { getReflectionManager } from "../agent/reflection";
import { validateAndNormalizeToolArgs, buildModelSafeParameters } from "../agent/ToolBatchExecutor";

// Extended IntentResult with scene awareness
export interface EnhancedIntentResult extends IntentResult {
    sceneType?: SceneType;
    responseMode?: ResponseMode;
    promptModifier?: string;
}

export class CollaborationManager {
    private app: App;
    private plugin: IPluginContext;
    private stateGraph: StateGraph | null = null;

    // Exposed for debugging commands; normal UI paths can ignore.
    public lastRunId: string | null = null;
    public lastDebugTrace: DebugTrace | null = null;
    public lastIntent: EnhancedIntentResult | null = null;
    public lastPlan: ExecutionPlan | null = null;
    public lastAnalyzedIntent: AnalyzedIntent | null = null;
    public lastGraphState: GraphState | null = null;

    constructor(app: App, plugin: IPluginContext) {
        this.app = app;
        this.plugin = plugin;
    }

    /**
     * 清理消息数组，确保所有 tool_calls 都有对应的 tool 响应
     * 防止 "An assistant message with 'tool_calls' must be followed by tool messages" 错误
     */
    private sanitizeMessagesForApi(messages: ChatMessage[]): ChatMessage[] {
        // 收集所有 tool 消息的 tool_call_id
        const toolResponseIds = new Set<string>();
        for (const msg of messages) {
            if (msg.role === 'tool' && msg.tool_call_id) {
                toolResponseIds.add(msg.tool_call_id);
            }
        }
        
        // 过滤消息：移除没有对应 tool 响应的 tool_calls
        return messages.map(msg => {
            if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
                // 只保留有对应 tool 响应的 tool_calls
                const validToolCalls = msg.tool_calls.filter(tc => {
                    const id = (tc as any).id;
                    return id && toolResponseIds.has(id);
                });
                
                if (validToolCalls.length === 0) {
                    // 如果所有 tool_calls 都没有对应响应，返回不带 tool_calls 的消息
                    return {
                        role: msg.role,
                        content: msg.content || ''
                    } as ChatMessage;
                } else if (validToolCalls.length < msg.tool_calls.length) {
                    // 部分有效，只保留有效的
                    return {
                        ...msg,
                        tool_calls: validToolCalls
                    };
                }
            }
            return msg;
        });
    }

    /**
     * 获取或创建状态图实例
     */
    private getStateGraph(): StateGraph {
        if (!this.stateGraph) {
            const context: NodeContext = {
                app: this.app,
                plugin: this.plugin,
                llmService: this.plugin.llmService,
                agentManager: this.plugin.agentManager,
                reflectionManager: getReflectionManager(),
                searchPlanner: this.plugin.searchPlanner,
                toolRouterAgent: this.plugin.toolRouterAgent,
                permissionManager: this.plugin.permissionManager,
                executionVerifier: this.plugin.executionVerifier,
            };
            this.stateGraph = createCollaborationGraph(context);
        }
        return this.stateGraph;
    }

    /**
     * 使用 StateGraph 状态机执行协作任务（新版本）
     * 支持动态重规划、反思机制、条件分支
     */
    public async executeWithStateGraph(
        userInput: string, 
        systemPrompt: string, 
        onUpdate: (msg: string) => void,
        signal?: AbortSignal
    ): Promise<string> {
        const graph = this.getStateGraph();
        
        const initialState: Partial<GraphState> = {
            originalGoal: userInput,
            systemPrompt,
            onUpdate,
            maxRetries: 3,
            abortSignal: signal
        };
        
        try {
            const finalState = await graph.run(initialState);
            
            // 保存状态供调试
            this.lastGraphState = finalState;
            this.lastRunId = finalState.runId;
            this.lastDebugTrace = finalState.debugTrace;
            this.lastPlan = finalState.plan;
            
            return finalState.finalOutput || "执行完成，但未生成输出。";
            
        } catch (e: any) {
            logger.error("AI", "[CollaborationManager] StateGraph execution failed", e);
            throw new Error(`状态机执行失败: ${e.message}`);
        }
    }


    /**
     * 获取最后一次意图分析结果（用于外部获取场景上下文）
     */
    public getLastAnalyzedIntent(): AnalyzedIntent | null {
        return this.lastAnalyzedIntent;
    }

    public async routeIntent(userInput: string): Promise<EnhancedIntentResult> {
        // 1. 首先进行本地意图分析（场景感知）
        const analyzedIntent = intentAnalyzer.analyze({
            userInput,
            currentDate: new Date()
        });
        this.lastAnalyzedIntent = analyzedIntent;
        
        logger.debug("AI", "Intent analyzed locally", {
            sceneType: analyzedIntent.sceneType,
            responseMode: analyzedIntent.responseMode,
            timeIntent: analyzedIntent.timeIntent,
            confidence: analyzedIntent.confidence
        });

        if (!this.plugin.settings.enableCollaboration) {
            const out: EnhancedIntentResult = { 
                level: 'assistant', 
                confidence: 1.0, 
                reasoning: "Collaboration disabled",
                sceneType: analyzedIntent.sceneType,
                responseMode: analyzedIntent.responseMode,
                promptModifier: analyzedIntent.promptModifier
            };
            this.lastIntent = out;
            return out;
        }

        // 获取协作复杂度设置
        const complexity = this.plugin.settings.collaborationComplexity || 'smart';

        // ========== 简单模式：直接基于本地规则路由，不调用 LLM ==========
        if (complexity === 'simple') {
            return this.routeIntentSimple(userInput, analyzedIntent);
        }

        // ========== 智能模式：增强的本地规则 + 快速路径 ==========
        if (complexity === 'smart') {
            return this.routeIntentSmart(userInput, analyzedIntent);
        }

        // ========== 完整模式：调用 LLM 做路由判断 ==========
        return this.routeIntentFull(userInput, analyzedIntent);
    }

    /**
     * 简单模式路由：完全基于规则，不调用 LLM
     */
    private routeIntentSimple(userInput: string, analyzedIntent: AnalyzedIntent): EnhancedIntentResult {
        const input = userInput.toLowerCase();
        
        // 检测是否需要搜索知识库
        const needsKnowledge = /找|搜|查|检索|知识|笔记|最近|有没有|记得|之前|以前/.test(input);
        
        // 检测是否需要执行操作
        const needsAction = /创建|新建|修改|删除|移动|执行|运行|索引|重建|刷新/.test(input);
        
        // 检测是否需要网络搜索
        const needsWeb = /搜索|查一下|网上|最新|新闻|天气/.test(input);
        
        let level: 'assistant' | 'specialist' | 'pm' | 'ceo' = 'assistant';
        let assignedSpecialist: string | undefined;
        let reasoning = "简单模式：直接回复";
        
        if (needsAction) {
            level = 'specialist';
            assignedSpecialist = 'executor' as const;
            reasoning = "简单模式：检测到操作意图，分配给执行者";
        } else if (needsKnowledge || needsWeb) {
            level = 'specialist';
            assignedSpecialist = 'researcher' as const;
            reasoning = "简单模式：检测到检索意图，分配给研究员";
        }
        
        const out: EnhancedIntentResult = {
            level,
            assignedSpecialist: assignedSpecialist as 'researcher' | 'analyst' | 'writer' | 'coder' | 'executor' | undefined,
            confidence: 0.9,
            reasoning,
            sceneType: analyzedIntent.sceneType,
            responseMode: analyzedIntent.responseMode,
            promptModifier: analyzedIntent.promptModifier
        };
        this.lastIntent = out;
        return out;
    }

    /**
     * 智能模式路由：增强的本地规则 + 快速路径，只在复杂情况下调用 LLM
     */
    private async routeIntentSmart(userInput: string, analyzedIntent: AnalyzedIntent): Promise<EnhancedIntentResult> {
        // 情感宣泄场景快速路径：不需要复杂路由，直接用 assistant 回应
        if (analyzedIntent.sceneType === 'emotional_venting') {
            const out: EnhancedIntentResult = { 
                level: 'assistant', 
                confidence: analyzedIntent.confidence, 
                reasoning: "智能模式：情感宣泄场景，直接回应",
                sceneType: analyzedIntent.sceneType,
                responseMode: analyzedIntent.responseMode,
                promptModifier: analyzedIntent.promptModifier
            };
            this.lastIntent = out;
            return out;
        }

        // 轻松社交场景快速路径：避免过度复杂化
        if (analyzedIntent.sceneType === 'casual_social') {
            const out: EnhancedIntentResult = { 
                level: 'assistant', 
                confidence: analyzedIntent.confidence, 
                reasoning: "智能模式：日常社交场景，直接回应",
                sceneType: analyzedIntent.sceneType,
                responseMode: analyzedIntent.responseMode,
                promptModifier: analyzedIntent.promptModifier
            };
            this.lastIntent = out;
            return out;
        }

        // 简单语言任务快速路径
        const simpleTaskRegex = /^\s*(翻译|总结|润色|解释|简述|translate|summarize|polish|explain)/i;
        if (simpleTaskRegex.test(userInput) && userInput.length < 800) {
            const out: EnhancedIntentResult = { 
                level: 'assistant', 
                confidence: 1.0, 
                reasoning: "智能模式：简单语言任务，直接回应",
                sceneType: analyzedIntent.sceneType,
                responseMode: analyzedIntent.responseMode,
                promptModifier: analyzedIntent.promptModifier
            };
            this.lastIntent = out;
            return out;
        }

        const input = userInput.toLowerCase();
        
        // 检测执行命令意图
        if (/执行|运行|索引|重建|刷新|reload|execute|run\s+command/.test(input)) {
            const out: EnhancedIntentResult = {
                level: 'specialist',
                assignedSpecialist: 'executor',
                confidence: 0.95,
                reasoning: "智能模式：检测到执行命令意图",
                sceneType: analyzedIntent.sceneType,
                responseMode: analyzedIntent.responseMode,
                promptModifier: analyzedIntent.promptModifier
            };
            this.lastIntent = out;
            return out;
        }

        // 检测知识库/笔记搜索意图
        if (/找|搜|查|检索|知识|笔记|最近|有没有|记得|之前|以前|梦|日记/.test(input)) {
            const out: EnhancedIntentResult = {
                level: 'specialist',
                assignedSpecialist: 'researcher',
                confidence: 0.9,
                reasoning: "智能模式：检测到知识库检索意图",
                sceneType: analyzedIntent.sceneType,
                responseMode: analyzedIntent.responseMode,
                promptModifier: analyzedIntent.promptModifier
            };
            this.lastIntent = out;
            return out;
        }

        // 检测文件操作意图
        if (/创建|新建|修改|删除|移动|重命名|create|modify|delete|move/.test(input)) {
            const out: EnhancedIntentResult = {
                level: 'specialist',
                assignedSpecialist: 'executor',
                confidence: 0.9,
                reasoning: "智能模式：检测到文件操作意图",
                sceneType: analyzedIntent.sceneType,
                responseMode: analyzedIntent.responseMode,
                promptModifier: analyzedIntent.promptModifier
            };
            this.lastIntent = out;
            return out;
        }

        // 检测网络搜索意图
        if (/搜索|查一下|网上|最新|新闻|天气|web\s*search/.test(input)) {
            const out: EnhancedIntentResult = {
                level: 'specialist',
                assignedSpecialist: 'researcher',
                confidence: 0.9,
                reasoning: "智能模式：检测到网络搜索意图",
                sceneType: analyzedIntent.sceneType,
                responseMode: analyzedIntent.responseMode,
                promptModifier: analyzedIntent.promptModifier
            };
            this.lastIntent = out;
            return out;
        }

        // 默认：普通对话，直接回复
        const out: EnhancedIntentResult = { 
            level: 'assistant', 
            confidence: 0.8, 
            reasoning: "智能模式：普通对话，直接回复",
            sceneType: analyzedIntent.sceneType,
            responseMode: analyzedIntent.responseMode,
            promptModifier: analyzedIntent.promptModifier
        };
        this.lastIntent = out;
        return out;
    }

    /**
     * 完整模式路由：调用 LLM 做路由判断
     */
    private async routeIntentFull(userInput: string, analyzedIntent: AnalyzedIntent): Promise<EnhancedIntentResult> {
        // 情感宣泄场景快速路径
        if (analyzedIntent.sceneType === 'emotional_venting') {
            const out: EnhancedIntentResult = { 
                level: 'assistant', 
                confidence: analyzedIntent.confidence, 
                reasoning: "Fast track: Emotional venting scene detected",
                sceneType: analyzedIntent.sceneType,
                responseMode: analyzedIntent.responseMode,
                promptModifier: analyzedIntent.promptModifier
            };
            this.lastIntent = out;
            return out;
        }

        // 轻松社交场景快速路径
        if (analyzedIntent.sceneType === 'casual_social') {
            const out: EnhancedIntentResult = { 
                level: 'assistant', 
                confidence: analyzedIntent.confidence, 
                reasoning: "Fast track: Casual social scene detected",
                sceneType: analyzedIntent.sceneType,
                responseMode: analyzedIntent.responseMode,
                promptModifier: analyzedIntent.promptModifier
            };
            this.lastIntent = out;
            return out;
        }

        // 简单语言任务快速路径
        const simpleTaskRegex = /^\s*(翻译|总结|润色|解释|简述|translate|summarize|polish|explain)/i;
        if (simpleTaskRegex.test(userInput) && userInput.length < 800) {
            const out: EnhancedIntentResult = { 
                level: 'assistant', 
                confidence: 1.0, 
                reasoning: "Fast track: Simple linguistic task",
                sceneType: analyzedIntent.sceneType,
                responseMode: analyzedIntent.responseMode,
                promptModifier: analyzedIntent.promptModifier
            };
            this.lastIntent = out;
            return out;
        }

        const prompt: ChatMessage[] = [
            {
                role: 'system',
                content: `You are the "Chief Assistant" of a Decentralized AI Agent Grid. Your job is to route the user's request to the most efficient level of execution.

On-demand Escalation Levels:
1. 'assistant': Fast Track. Direct reply for greetings, simple questions, translations, or tasks you can do immediately without searching.
2. 'specialist': Direct Handoff. For tasks requiring one specific expert tool (e.g., "Search the web", "Search my notes", "Create a file").
3. 'pm': Workflow. For tasks requiring 2-3 clear steps (e.g., "Search for X and then summarize it into a new file").
4. 'ceo': Strategic Planning. For complex, ambiguous projects requiring deep reasoning and multi-agent collaboration.

Available Specialists: 'researcher' (for searching/reading), 'analyst' (for processing), 'writer' (for drafting), 'coder' (for code), 'executor' (for file ops and Obsidian commands).

If the user asks to "execute", "run", "执行", "运行" a command or mentions specific Obsidian features like "索引", "重建", "刷新", choose 'specialist' with 'executor'.
If the user asks to "find", "search", "list", "recall" something from their vault or the web, ALWAYS choose 'specialist' with 'researcher'. Do NOT choose 'assistant'.
Default to 'assistant' or 'specialist'. ONLY choose 'pm' or 'ceo' if the user's request is EXPLICITLY a complex, multi-step project.

Return ONLY JSON: 
{
  "level": "assistant"|"specialist"|"pm"|"ceo",
  "assignedSpecialist": "researcher"|"analyst"|"writer"|"coder"|"executor"|null,
  "confidence": number,
  "reasoning": "string"
}`
            },
            { role: 'user', content: userInput }
        ];

        try {
            const response = await this.plugin.llmService.getCompletion(prompt, this.plugin.settings.routerModel);
            const content = response.content || "{}";
            const raw = this.extractJson(content);
            const parsed = this.tryParseJsonLoose(raw || content);

            const level = (parsed?.level === 'assistant' || parsed?.level === 'specialist' || parsed?.level === 'pm' || parsed?.level === 'ceo')
                ? parsed.level
                : 'assistant';
            const assigned = (parsed?.assignedSpecialist === 'researcher' || parsed?.assignedSpecialist === 'analyst' || parsed?.assignedSpecialist === 'writer' || parsed?.assignedSpecialist === 'coder' || parsed?.assignedSpecialist === 'executor')
                ? parsed.assignedSpecialist
                : undefined;
            const confidence = (typeof parsed?.confidence === 'number' && Number.isFinite(parsed.confidence))
                ? Math.max(0, Math.min(1, parsed.confidence))
                : 1.0;
            const reasoning = (typeof parsed?.reasoning === 'string') ? parsed.reasoning : "";

            const out: EnhancedIntentResult = { 
                level, 
                assignedSpecialist: assigned, 
                confidence, 
                reasoning,
                sceneType: analyzedIntent.sceneType,
                responseMode: analyzedIntent.responseMode,
                promptModifier: analyzedIntent.promptModifier
            };
            this.lastIntent = out;
            return out;
        } catch (e: any) {
            logger.error("AI", "Intent routing failed", e);
            const out: EnhancedIntentResult = { 
                level: 'assistant', 
                confidence: 0.5, 
                reasoning: "Fallback due to error",
                sceneType: analyzedIntent.sceneType,
                responseMode: analyzedIntent.responseMode,
                promptModifier: analyzedIntent.promptModifier
            };
            this.lastIntent = out;
            return out;
        }
    }

    public async generatePlan(userInput: string): Promise<ExecutionPlan> {
        const prompt: ChatMessage[] = [
            {
                role: 'system',
                content: `You are the Strategic Planner (CEO) of an AI Agent Corporation. Your job is to break down complex user goals into a high-level strategic plan.
Available Specialist Departments:
- 'researcher': Gathers information. MUST be used for any task requiring local vault retrieval (knowledge base) or web search.
- 'analyst': Processes data, identifies patterns, and structures logic. Use this for summarizing large amounts of retrieved data.
- 'writer': Drafts high-quality content, reports, or summaries.
- 'coder': Writes, debugs, or explains code.
- 'executor': Performs file operations (create, move, delete) AND executes Obsidian commands (like rebuilding index, toggling settings, running plugins).

Guidelines:
1. For "List all X" or "Find all Y" tasks, always start with a 'researcher' step to query the knowledge base.
2. If the task is complex, add an 'analyst' step after research to filter and organize the findings.
3. The final step should usually be a 'writer' or 'executor' depending on whether the user wants a report or a file change.
4. For tasks that require executing Obsidian commands ("执行", "运行", "重建索引", "刷新"), use 'executor' with list_commands + execute_command tools.

Return ONLY a JSON object:
{
  "originalGoal": "${userInput}",
  "steps": [
    { "id": 1, "description": "Clear task description for the specialist", "workerType": "researcher", "dependencies": [] },
    ...
  ]
}`
            },
            { role: 'user', content: userInput }
        ];

        try {
            const response = await this.plugin.llmService.getCompletion(prompt, this.plugin.settings.plannerModel);
            const content = response.content || "{}";
            const raw = this.extractJson(content);
            if (!raw) throw new Error("Empty JSON response from planner");
            const parsed = this.tryParseJsonLoose(raw) ?? this.tryParseJsonLoose(content);
            if (!parsed) throw new Error("Failed to parse planner JSON");
            const plan = this.normalizeExecutionPlan(parsed, userInput);
            this.lastPlan = plan;
            return plan;
        } catch (e: any) {
            logger.error("AI", "Strategic planning failed", e);
            throw new Error(`Failed to generate strategic plan: ${e?.message || String(e)}`);
        }
    }

    /**
     * Planner-less fixed workflow for retrieval-heavy tasks.
     * Flow: researcher (gather evidence) -> analyst (structure) -> writer (render).
     * Returns a markdown report which includes basic run metrics for quick comparison.
     */
    public async executePipeline(userInput: string, systemPrompt: string, onUpdate: (msg: string) => void): Promise<string> {
        const startedAt = Date.now();
        const plan: ExecutionPlan = {
            originalGoal: userInput,
            steps: [
                { id: 1, description: `围绕“${userInput}”进行本地知识库检索，找出所有相关笔记与原始片段，并尽量调用 read_note 补齐证据与时间信息。`, workerType: 'researcher', status: 'pending', dependencies: [] },
            ],
        };

        onUpdate(`🧪 启动三段式管线（Planner-less）：researcher → analyst → writer ...`);
        const output = await this.executePlan(plan, systemPrompt, onUpdate);

        const metrics = {
            mode: 'pipeline',
            durationMs: Date.now() - startedAt,
            runId: this.lastRunId,
            steps: plan.steps.length,
        };

        return (
            `\n\n---\n` +
            `### 协作执行指标（pipeline）\n` +
            `- runId: ${metrics.runId || "(unknown)"}\n` +
            `- durationMs: ${metrics.durationMs}\n` +
            `- steps: ${metrics.steps}\n` +
            `---\n\n` +
            (output || "")
        );
    }

    private extractJson(text: string): string {
        if (!text) return "";
        
        // 1. Try to find JSON block with markdown markers
        const markdownMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
        if (markdownMatch) {
            return markdownMatch[1].trim();
        }

        // 2. Try to find the first { and last }
        const firstBrace = text.indexOf('{');
        const lastBrace = text.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
            return text.substring(firstBrace, lastBrace + 1).trim();
        }

        // 3. Try to find the first [ and last ] (for arrays)
        const firstBracket = text.indexOf('[');
        const lastBracket = text.lastIndexOf(']');
        if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
            return text.substring(firstBracket, lastBracket + 1).trim();
        }

        return text.trim();
    }

    public async executePlan(plan: ExecutionPlan, systemPrompt: string, onUpdate: (msg: string) => void): Promise<string> {
        let context = "";
        let finalOutput = "";
        let hasFailure = false;

        // Normalize and order steps once so dependency logic is deterministic.
        const normalized = this.normalizeExecutionPlan(plan as any, plan?.originalGoal || "");
        this.lastPlan = normalized;
        plan.originalGoal = normalized.originalGoal;
        plan.steps = normalized.steps;

        const runId = makeRunId("collab");
        this.lastRunId = runId;
        const dbg = new DebugTrace(runId);
        this.lastDebugTrace = dbg;
        const runStartedAt = Date.now();

        dbg.add("info", "run_start", "executePlan", {
            originalGoal: plan.originalGoal,
            steps: plan.steps?.map((s: any) => ({ id: s.id, workerType: s.workerType, description: s.description }))
        });
        logger.debug("AI", `Collaboration run_start (${runId})`, { runId, steps: plan.steps?.length });

    onUpdate(`🚀 启动去中心化协作 (Decentralized Hybrid Collaboration)...`);

        // Ensure we respect dependencies even if planner returns out-of-order IDs.
        const orderedSteps = this.topoSortSteps(plan.steps);
        for (const step of orderedSteps) {
            step.status = 'running';
            onUpdate(`\n📑 [黑板模式] 正在处理步骤 ${step.id}: ${step.description} -> 秮交给 [${step.workerType}] 部门...`);
            const stepStartedAt = Date.now();
            dbg.add("info", "step_start", "step_start", {
                stepId: step.id,
                workerType: step.workerType,
                description: step.description,
                dependencies: step.dependencies || []
            });
            logger.debug("AI", `Collaboration step_start (${runId} #${step.id} ${step.workerType})`, { runId, stepId: step.id, workerType: step.workerType });

            try {
                const stepResult = await this.invokeSpecialist(step, context, systemPrompt, onUpdate, plan.originalGoal, dbg, runId);
                
                step.result = stepResult;
                step.status = 'completed';
                dbg.add("info", "step_end", "step_end", {
                    stepId: step.id,
                    workerType: step.workerType,
                    durationMs: Date.now() - stepStartedAt,
                    resultLength: (stepResult || "").length
                });
                logger.debug("AI", `Collaboration step_end (${runId} #${step.id})`, { runId, stepId: step.id, durationMs: Date.now() - stepStartedAt });
                // The 'context' here acts as the Blackboard
                context += `\n[步骤 ${step.id} (${step.workerType}) 结果]:\n${stepResult || "(无输出)"}\n`;
                
                finalOutput = stepResult;
            } catch (e) {
                const errMsg = e instanceof Error ? e.message : String(e);
                hasFailure = true;
                step.status = 'failed';
                step.result = `❌ 失败：${errMsg}`;
                dbg.add("error", "step_end", "step_failed", {
                    stepId: step.id,
                    workerType: step.workerType,
                    durationMs: Date.now() - stepStartedAt,
                    error: errMsg
                });
                logger.error("AI", `Collaboration step_failed (${runId} #${step.id})`, { runId, stepId: step.id, error: errMsg });
                onUpdate(`\n❌ 步骤 ${step.id} 执行失败: ${errMsg}`);
                context += `\n[步骤 ${step.id} (${step.workerType}) 失败]:\n${errMsg}\n`;
                // Do not throw: continue remaining steps and synthesize a final report.
            }
        }

        // 如果有多个步骤，或者最后一步结果太短，进行最终汇总
        if (plan.steps.length > 1 || finalOutput.length < 50 || hasFailure) {
            onUpdate(`\n📝 [CEO] 正在汇总各部门成果并撰写最终报告...`);
            const synthesisStartedAt = Date.now();
            dbg.add("info", "step_start", "ceo_synthesis_start", { stepId: "ceo_synthesis", workerType: "ceo" });
            const synthesisPrompt: ChatMessage[] = [
                {
                    role: 'system',
                    content: `${systemPrompt}\n你现在是 AI 协作网格的首席执行官 (CEO)。
请根据以下各部门的执行结果，为用户撰写一份完整、专业且易于阅读的最终报告。

【重要准则】
1. **严谨性**：如果研究员报告“未找到结果”，请审视其搜索词是否合理。如果原始目标是查找历史记录，而研究员只搜索了最近几天的内容，请在报告中诚实地指出这一点，并建议用户尝试更宽泛的关键词。
2. **结构化**：使用清晰的标题、列表和引用标注。
3. **完整性**：不要遗漏任何部门提供的关键细节。

【风格与真实性硬约束】
- 写作风格必须是“严谨报告/清单”，避免人设扮演、夸张修辞、戏谑、以及任何自指/元叙事（例如“我就是那个模型”等）。
- 若上游（尤其是 researcher）提供了 JSON（含 hits/path/excerpt/createdTime/modifiedTime），你必须只基于该 JSON 输出，不得脑补内容。
- 列出梦境条目时，每条必须包含：路径 path + 原文证据摘录 excerpt。
- 日期：优先用 createdTime/modifiedTime；若使用文件名推断日期，必须明确标注“（由文件名推断）”；不确定就写未知。

原始目标：${plan.originalGoal}

执行记录：
${context}`
                },
                { role: 'user', content: "请给出最终汇总报告。" }
            ];
            const response = await this.plugin.llmService.getCompletion(synthesisPrompt, this.plugin.settings.writerModel, undefined, (token) => {
                if (onUpdate) onUpdate(token);
            });
            finalOutput = response.content || finalOutput;
            dbg.add("info", "step_end", "ceo_synthesis_end", { stepId: "ceo_synthesis", durationMs: Date.now() - synthesisStartedAt, resultLength: (finalOutput || "").length });
        }

        if (!finalOutput) {
            finalOutput = context || "执行完成，但未生成有效输出。";
        }

        dbg.add("info", "run_end", "executePlan_end", { durationMs: Date.now() - runStartedAt, finalLength: (finalOutput || "").length });
        logger.debug("AI", `Collaboration run_end (${runId})`, { runId, durationMs: Date.now() - runStartedAt });

        return finalOutput;
    }

    private normalizeExecutionPlan(input: any, fallbackGoal: string): ExecutionPlan {
        const originalGoal = (typeof input?.originalGoal === 'string' && input.originalGoal.trim().length > 0)
            ? input.originalGoal
            : (fallbackGoal || "");

        const rawSteps = Array.isArray(input?.steps) ? input.steps : [];

        const normalizedSteps: PlanStep[] = rawSteps.map((s: any, idx: number) => {
            const id = (typeof s?.id === 'number' && Number.isFinite(s.id)) ? s.id : (idx + 1);
            const description = (typeof s?.description === 'string') ? s.description : "";
            const workerType = (s?.workerType === 'researcher' || s?.workerType === 'analyst' || s?.workerType === 'writer' || s?.workerType === 'coder' || s?.workerType === 'executor')
                ? s.workerType
                : 'analyst';
            const dependencies = Array.isArray(s?.dependencies)
                ? s.dependencies.filter((d: any) => typeof d === 'number' && Number.isFinite(d))
                : [];

            const status: PlanStep['status'] = 'pending';
            return { id, description, workerType, status, dependencies };
        });

        // Dedupe IDs and make them stable.
        const used = new Set<number>();
        for (let i = 0; i < normalizedSteps.length; i++) {
            let id = normalizedSteps[i].id;
            while (used.has(id)) id++;
            normalizedSteps[i].id = id;
            used.add(id);
        }

        // Remove impossible dependencies (non-existent ids, self-deps).
        const idSet = new Set(normalizedSteps.map(s => s.id));
        for (const s of normalizedSteps) {
            s.dependencies = (s.dependencies || []).filter((d) => d !== s.id && idSet.has(d));
        }

        return { originalGoal, steps: normalizedSteps };
    }

    private topoSortSteps(steps: PlanStep[]): PlanStep[] {
        // Kahn's algorithm. If cycle detected, fall back to id-ascending order.
        const nodes = new Map<number, PlanStep>();
        for (const s of steps) nodes.set(s.id, s);

        const indeg = new Map<number, number>();
        const out = new Map<number, number[]>();
        for (const s of steps) {
            indeg.set(s.id, 0);
            out.set(s.id, []);
        }

        for (const s of steps) {
            const deps = Array.isArray(s.dependencies) ? s.dependencies : [];
            for (const d of deps) {
                if (!nodes.has(d) || d === s.id) continue;
                out.get(d)!.push(s.id);
                indeg.set(s.id, (indeg.get(s.id) || 0) + 1);
            }
        }

        const queue: number[] = [];
        for (const [id, n] of indeg.entries()) {
            if (n === 0) queue.push(id);
        }
        queue.sort((a, b) => a - b);

        const ordered: PlanStep[] = [];
        while (queue.length > 0) {
            const id = queue.shift()!;
            const node = nodes.get(id);
            if (node) ordered.push(node);

            for (const nxt of out.get(id) || []) {
                const v = (indeg.get(nxt) || 0) - 1;
                indeg.set(nxt, v);
                if (v === 0) {
                    queue.push(nxt);
                    queue.sort((a, b) => a - b);
                }
            }
        }

        if (ordered.length !== steps.length) {
            // Cycle or invalid graph; deterministic fallback.
            return [...steps].sort((a, b) => a.id - b.id);
        }
        return ordered;
    }

    private tryParseJsonLoose(text: string): any | null {
        if (!text) return null;
        const cleaned = String(text)
            .replace(/```json\s*/g, "")
            .replace(/```/g, "")
            .trim();

        const candidates: string[] = [];
        const obj = this.extractFirstBalancedJson(cleaned, '{', '}');
        if (obj) candidates.push(obj);
        const arr = this.extractFirstBalancedJson(cleaned, '[', ']');
        if (arr) candidates.push(arr);
        candidates.push(cleaned);

        for (const c of candidates) {
            try {
                return JSON.parse(c);
            } catch {
                // try next
            }
        }
        return null;
    }

    private extractFirstBalancedJson(text: string, open: '{' | '[', close: '}' | ']'): string | null {
        const start = text.indexOf(open);
        if (start === -1) return null;

        let depth = 0;
        let inStr = false;
        let escape = false;

        for (let i = start; i < text.length; i++) {
            const ch = text[i];
            if (inStr) {
                if (escape) {
                    escape = false;
                } else if (ch === '\\') {
                    escape = true;
                } else if (ch === '"') {
                    inStr = false;
                }
                continue;
            }

            if (ch === '"') {
                inStr = true;
                continue;
            }

            if (ch === open) depth++;
            if (ch === close) depth--;

            if (depth === 0) {
                return text.substring(start, i + 1).trim();
            }
        }
        return null;
    }

    public async invokeSpecialist(step: PlanStep, context: string, systemPrompt: string, onUpdate: (msg: string) => void, originalGoal?: string, dbg?: DebugTrace, runId?: string): Promise<string> {
        let model = this.plugin.settings.writerModel;
        let tools: any[] = [];
        const baseTools = this.plugin.agentManager.getToolsForAgent("note-assistant");
        const systemTools = ['discover_tools', 'use_tool_from_library'];

        // Specialist-specific tool selection and model tuning
        switch (step.workerType) {
            case 'researcher':
                // Only use Deep Research if the task description implies a need for broad/deep info
                const needsDeepResearch = /调研|深度|全面|最新进展|research|deep|comprehensive/i.test(step.description);
                if (needsDeepResearch) {
                    return await this.runDeepResearch(step, context, systemPrompt, onUpdate);
                }
                model = this.plugin.settings.writerModel; // Use smarter model for research
                // 扩大研究员工具集，增加最近笔记和文件列表
                tools = baseTools.filter(t => ['search_notes', 'read_note', 'get_recent_notes', 'list_files', 'knowledge_base_query', 'vector_search', 'mcp_list_tools', 'mcp_call_tool', ...systemTools].includes(t.definition.name));
                break;
            case 'analyst':
                model = this.plugin.settings.plannerModel; // Use smartest model for analysis
                // 扩大分析师工具集，增加搜索能力
                tools = baseTools.filter(t => ['list_files', 'get_recent_notes', 'read_note', 'search_notes', 'vector_search', 'knowledge_base_query', 'mcp_list_tools', 'mcp_call_tool', ...systemTools].includes(t.definition.name));
                break;
            case 'coder':
                model = this.plugin.settings.writerModel;
                // 程序员需要读取和搜索
                tools = baseTools.filter(t => ['read_note', 'search_notes', 'list_files', 'knowledge_base_query', ...systemTools].includes(t.definition.name));
                break;
            case 'writer':
                model = this.plugin.settings.writerModel;
                tools = baseTools.filter(t => ['read_note', 'search_notes', 'knowledge_base_query', ...systemTools].includes(t.definition.name));
                break;
            case 'executor':
                model = this.plugin.settings.writerModel; // Use smarter model for file operations to avoid errors
                // executor 负责执行操作，包括文件操作和 Obsidian 命令
                tools = baseTools.filter(t => ['create_note', 'modify_note', 'move_item', 'delete_file', 'append_to_note', 'create_folder', 'read_note', 'execute_command', 'list_commands', ...systemTools].includes(t.definition.name));
                break;
        }

        const openAiTools = tools.map(t => ({
            type: "function",
            function: {
                name: t.definition.name,
                description: t.definition.description,
                parameters: buildModelSafeParameters(t.definition.parameters)
            }
        }));

        const agent = this.plugin.agentManager.getAgent(step.workerType);
        let specialistPrompt = agent ? agent.systemPrompt : "";

        // Add shared retrieval strategy for all specialists with search tools
        if (tools.some(t => ['knowledge_base_query', 'vector_search', 'search_notes'].includes(t.definition.name))) {
            specialistPrompt += `\n\n【检索策略建议】
1. 优先使用 \`knowledge_base_query\` 获取原始笔记内容。
2. 搜索时，优先使用用户的原始意图（Original Goal）作为查询词。
3. 如果一次搜不到，请尝试拆分关键词或使用更宽泛的词进行多轮搜索。
4. 除非工具明确返回“未找到”，否则不要轻易放弃。`;
        }

        // For Researchers, we strip the Memory Context to avoid bias from previous failed attempts in the conversation history.
        let effectiveSystemPrompt = systemPrompt;
        let effectiveContext = context;

        if (step.workerType === 'researcher') {
            // Aggressively strip all memory context to force a fresh search
            effectiveSystemPrompt = systemPrompt
                .replace(/\[Memory Context\][\s\S]*?(\[|$)/g, '$1')
                .replace(/\[AI 自主记忆[\s\S]*?(\[|$)/g, '$1')
                .replace(/当前日期:.*?\n/g, ''); 
            
            // Sanitize the execution context to remove "No results found" poisoning
            effectiveContext = context
                .replace(/未找到相关笔记/g, '[之前尝试未果，请重新深度检索]')
                .replace(/知识库中未找到与.*?相关的匹配项/g, '[之前尝试未果，请更换关键词检索]')
                .replace(/没有找到任何.*?内容/g, '[之前尝试未果]');

            // Add explicit override instruction
            effectiveSystemPrompt += `\n\n【CRITICAL INSTRUCTION】\nIgnore any previous conversation history or context that claims "no results found". You must perform a fresh, exhaustive search using 'knowledge_base_query'. Do not stop until you find the raw data. If you find snippets, report them even if they seem incomplete.`;
        }

        // Strong, task-specific contract for dream listing tasks.
        // Goal: make researcher output machine-consumable, evidence-based data so writer/CEO can't freely hallucinate.
        const isDreamListingTask = /梦|梦境|梦见|噩梦|春梦/.test(originalGoal || step.description);
        if (isDreamListingTask && step.workerType === 'researcher') {
            specialistPrompt += `\n\n【输出格式硬约束（必须遵守）】\n你要输出“严格 JSON”，不要夹带任何多余文字（包括 Markdown）。\n\nJSON 结构：\n{\n  "query": string,\n  "hits": [\n    {\n      "path": string,\n      "createdTime": string|null,         // 来自 read_note / 文件 stat.ctime，如未知填 null\n      "modifiedTime": string|null,        // 来自 read_note / 文件 stat.mtime，如未知填 null\n      "excerpt": string,                  // 从原文截取的证据句（<=120字），必须能看出是梦境/梦相关\n      "isDream": boolean,\n      "reason": string                    // 为什么判定为梦/为何排除（如“梦想清单为愿望列表”）\n    }\n  ]\n}\n\n规则：\n1) 先调用 knowledge_base_query 获取候选路径与片段。\n2) 对前 20-30 条候选路径，必须逐条调用 read_note（用文件路径）来拿到创建/更新时间，并从原文中截取 excerpt。\n3) 只要工具返回了片段/命中，禁止输出“未找到/无记录”。\n4) 对非梦内容（如“梦想清单”）也可以返回，但 isDream=false 并在 reason 说明。`;
        }

        if (isDreamListingTask && step.workerType === 'writer') {
            specialistPrompt += `\n\n【写作硬约束（必须遵守）】\n你只能基于上游（researcher/analyst）提供的数据输出，禁止脑补。\n\n规则：\n1) 如果上游提供了 JSON（hits 数组），你只能从 hits 里选条目输出。\n2) 每条梦都必须包含：路径 path + 证据摘录 excerpt（原文短句）。\n3) 日期优先使用 createdTime/modifiedTime；如果你从文件名推断日期，必须明确标注“（由文件名推断）”。\n4) 不允许编造不存在的路径或内容；不确定就写“信息不足”。`;
        }

        const messages: ChatMessage[] = [
            { 
                role: 'system', 
                content: `${effectiveSystemPrompt}\n\n[Specialist Role]\nYou are currently acting as a Specialist in the [${step.workerType}] department. 
${specialistPrompt}

Your goal is to complete the assigned task using the provided context and tools.
Be precise, professional, and efficient.

${originalGoal ? `【重要：原始用户意图】\n用户最初的完整请求是：“${originalGoal}”\n在进行本地知识库检索时，请优先参考这个原始请求，因为它包含了最完整的语义信息。` : ''}` 
            },
            { role: 'user', content: `Corporate Context (Previous Steps):\n${effectiveContext}\n\nYour Assigned Task: ${step.description}` }
        ];

        let stepComplete = false;
        let loopCount = 0;
        let stepResult = "";
        let lastRetrievalToolHadResults = false;
        let lastRetrievalToolSummary = "";
        let lastRetrievalToolTopPaths: string[] = [];
        let lastRetrievalToolName: string | null = null;

        // Stream tokens can arrive one-character-per-callback depending on provider.
        // Buffer them to avoid writing one token per line into debug notes.
        let streamBuffer = "";
        let lastFlushAt = 0;
        let flushCount = 0;
        let flushedChars = 0;
        const flushStream = (force = false) => {
            if (!onUpdate) return;
            const now = Date.now();
            if (!force && streamBuffer.length < 64 && now - lastFlushAt < 120) return;
            if (streamBuffer.length > 0) {
                onUpdate(streamBuffer);
                flushCount++;
                flushedChars += streamBuffer.length;
                streamBuffer = "";
                lastFlushAt = now;
            }
        };

        // Per-step tool call de-dup / throttling.
        // Some providers may emit duplicated tool_calls in streaming mode, or the model may request
        // the same tool multiple times with the same args. Without this, we can spam read_note and
        // degrade quality/latency.
        const executedToolKeys = new Set<string>();
        const inFlightToolKeys = new Set<string>();
        const makeToolKey = (name: string, args: any) => {
            let a = "";
            try {
                a = JSON.stringify(args ?? {});
            } catch {
                a = String(args);
            }
            return `${name}::${a}`;
        };

        const maxLoops = Math.max(3, Math.min(100, Number(this.plugin.settings.agentMaxSteps || 10)));
        // Increase max steps for more thorough research/execution (bounded by settings)
        while (!stepComplete && loopCount < maxLoops) {
            // 传入 onUpdate 实现流式输出
            const response = await this.plugin.llmService.getCompletion(
                messages,
                model,
                openAiTools.length > 0 ? openAiTools : undefined,
                (token) => {
                    streamBuffer += token;
                    flushStream(false);
                }
            );
            flushStream(true);
            messages.push(response);

            if (response.tool_calls && response.tool_calls.length > 0) {
                for (const [toolCallIndex, toolCall] of response.tool_calls.entries()) {
                    const toolCallId = (toolCall as any)?.id && String((toolCall as any).id).trim().length > 0
                        ? (toolCall as any).id
                        : `call_${runId ?? 'run'}_${step.id}_${loopCount}_${toolCallIndex}_${Date.now()}`;
                    (toolCall as any).id = toolCallId;

                    const toolName = toolCall.function.name;
                    if (!toolName || toolName.trim().length === 0) {
                        logger.warn("AI", "[Collaboration] Skipping empty tool name", toolCall);
                        continue;
                    }
                    let args: any = {};
                    const rawArgsText = toolCall.function.arguments;
                    try {
                        args = JSON.parse(toolCall.function.arguments);
                    } catch (e) {
                        logger.warn("AI", `Failed to parse tool arguments for ${toolName}`, {
                            toolName,
                            rawArgs: toolCall.function.arguments,
                        });
                        // Try to extract the first JSON object from the arguments text (robust against trailing commas / extra text)
                        try {
                            const raw = (toolCall.function.arguments || "").trim();
                            const firstBrace = raw.indexOf('{');
                            const lastBrace = raw.lastIndexOf('}');
                            if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                                const slice = raw.substring(firstBrace, lastBrace + 1);
                                args = JSON.parse(slice);
                            } else {
                                const fixedJson = raw.replace(/\\n/g, " ").replace(/\\'/g, "'");
                                args = JSON.parse(fixedJson);
                            }
                        } catch (e2) {
                            args = {};
                        }
                    }

                    // If the model forgot to pass required args, auto-inject from original goal.
                    if (toolName === 'knowledge_base_query') {
                        if (!args || typeof args !== 'object') args = {};
                        const og = (originalGoal || step.description || '').trim();
                        const q = (typeof args.query === 'string' ? args.query : '').trim();

                        if (!q) {
                            args.query = og;
                        } else {
                            // Guardrail: avoid query drifting away from the original user intent.
                            // If tool query doesn't include any key tokens from original goal, append it.
                            const ogTokens = og
                                .replace(/[\s\t\r\n]+/g, ' ')
                                .split(/[^\p{L}\p{N}]+/u)
                                .map(t => t.trim())
                                .filter(t => t.length >= 2)
                                .slice(0, 8);
                            const qLower = q.toLowerCase();
                            const hasOverlap = ogTokens.some(t => qLower.includes(t.toLowerCase()));
                            if (!hasOverlap && og.length > 0) {
                                args.query = `${q} ${og}`.trim();
                            } else {
                                args.query = q;
                            }
                        }
                        if (args.limit === undefined || args.limit === null) {
                            args.limit = 50;
                        }
                    }

                    // Skip duplicated tool calls within the same step.
                    const toolKey = makeToolKey(toolName, args);
                    if (executedToolKeys.has(toolKey) || inFlightToolKeys.has(toolKey)) {
                        dbg?.add("debug", "tool_call", "tool_call_dedup_skipped", {
                            runId,
                            stepId: step.id,
                            workerType: step.workerType,
                            toolName,
                            toolKey
                        });
                        
                        // 向用户显示跳过提示
                        onUpdate(`\n⏭️ [${step.workerType}] 工具 ${toolName} 已在本轮执行过，跳过重复调用`);
                        
                        // 向 AI 返回明确的响应，保持消息流完整性
                        messages.push({
                            role: 'tool',
                            tool_call_id: toolCallId,
                            name: toolName,
                            content: `[系统提示] 该工具调用已在本轮执行过，结果已在上文中。请直接使用之前的结果，不要重复调用。`
                        });
                        
                        continue;
                    }
                    inFlightToolKeys.add(toolKey);
                    
                    onUpdate(`\n🛠️ [${step.workerType}] 正在使用工具: ${toolName}...`);
                    logger.debug("AI", "[Collaboration] tool_call", {
                        workerType: step.workerType,
                        toolName,
                        args,
                    });

                    const toolStartedAt = Date.now();
                    dbg?.add("debug", "tool_call", "tool_call", {
                        runId,
                        stepId: step.id,
                        workerType: step.workerType,
                        toolName,
                        rawArgsText,
                        args
                    });
                    logger.debug("AI", `Tool call (${runId ?? toolCallId} #${step.id} ${toolName})`, { runId: runId ?? toolCallId, stepId: step.id, workerType: step.workerType, toolName, toolCallId });
                    
                    const toolInstance = this.plugin.agentManager.getTool(toolName);
                    let toolResult = "";
                    if (toolInstance) {
                        try {
                            const { ok: argsOk, args: normalizedArgs, error: argsError } = validateAndNormalizeToolArgs(toolName, args);

                            if (!argsOk) {
                                toolResult = `错误: 工具参数不合法，已跳过执行。原因: ${argsError} Args: ${JSON.stringify(args ?? {}, null, 2)}`;
                            } else {
                                toolResult = await toolInstance.execute(normalizedArgs, this.app);
                            }
                        } catch (err: any) {
                            toolResult = `错误: ${err.message}`;
                        }
                    } else {
                        toolResult = `错误: 未找到工具 ${toolName}`;
                    }

                    inFlightToolKeys.delete(toolKey);
                    executedToolKeys.add(toolKey);
                    
                    const durationMs = Date.now() - toolStartedAt;
                    const resultLength = (toolResult || "").length;
                    
                    // 向用户显示工具执行完成状态
                    if (toolResult.startsWith('错误:')) {
                        onUpdate(`\n❌ [${step.workerType}] 工具 ${toolName} 执行失败 (${durationMs}ms)`);
                    } else {
                        onUpdate(`\n✅ [${step.workerType}] 工具 ${toolName} 执行完成 (${durationMs}ms, ${resultLength} 字符)`);
                    }
                    
                    dbg?.add("debug", "tool_result", "tool_result", {
                        runId,
                        stepId: step.id,
                        workerType: step.workerType,
                        toolName,
                        durationMs,
                        resultLength
                    });

                    // Track whether retrieval tools actually returned content.
                    if (toolName === 'knowledge_base_query' || toolName === 'vector_search' || toolName === 'search_notes') {
                        const normalized = (toolResult || "").trim();
                        const isEmpty = normalized.length === 0;
                        const looksLikeNotFound = /未找到相关笔记|【未找到结果】|未找到包含/.test(normalized);
                        const hasObviousHits = /\[结果\s*\d+\b|--- \[\d+\]|相关度|Score:/.test(normalized);
                        // If the tool returned very short content, assume it might be truncated/failed and do NOT trust it as "not found".
                        const suspiciouslyShort = normalized.length > 0 && normalized.length < 120;
                        lastRetrievalToolHadResults = !isEmpty && !looksLikeNotFound && (hasObviousHits || normalized.length > 200);
                        lastRetrievalToolName = toolName;
                        // Extract top paths as a minimal structured cue for the model.
                        const pathMatches = Array.from(normalized.matchAll(/路径\s*[:：]\s*([^\]\n\r]+?)(?=\]|\n|\r|\s*---|$)/g))
                            .map(m => (m[1] || "").trim())
                            .filter(Boolean);
                        // Dedupe while preserving order
                        const deduped: string[] = [];
                        const seen = new Set<string>();
                        for (const p of pathMatches) {
                            if (!seen.has(p)) {
                                seen.add(p);
                                deduped.push(p);
                            }
                            if (deduped.length >= 25) break;
                        }
                        if (deduped.length > 0) lastRetrievalToolTopPaths = deduped;

                        lastRetrievalToolSummary = `${toolName} => len=${normalized.length}, hadResults=${lastRetrievalToolHadResults}, topPaths=${lastRetrievalToolTopPaths.length}`;
                        logger.debug("AI", "[Collaboration] tool_result_summary", {
                            workerType: step.workerType,
                            toolName,
                            length: normalized.length,
                            hadResults: lastRetrievalToolHadResults,
                            suspiciouslyShort,
                        });

                        dbg?.add("debug", "tool_result", "retrieval_summary", {
                            runId,
                            stepId: step.id,
                            workerType: step.workerType,
                            toolName,
                            length: normalized.length,
                            hadResults: lastRetrievalToolHadResults,
                            suspiciouslyShort,
                            topPaths: lastRetrievalToolTopPaths
                        });

                        // If we have results, inject a compact, structured reminder immediately.
                        // This prevents the model from claiming "not found" due to confusion/noise.
                        if (lastRetrievalToolHadResults && lastRetrievalToolTopPaths.length > 0) {
                            messages.push({
                                role: 'user',
                                content:
                                    `【系统提示：检索已命中】\n` +
                                    `工具 ${toolName} 已返回命中结果（条目片段可能很长）。你必须承认“已找到相关笔记”，` +
                                    `并基于以下命中路径工作（优先引用这些真实路径，禁止编造不存在路径）：\n` +
                                    lastRetrievalToolTopPaths.map(p => `- ${p}`).join("\n") +
                                    `\n\n请继续：从工具返回内容中提取这些笔记对应的梦境条目，并按时间或文件组织输出。`
                            });
                        }

                        // If suspiciously short, force the specialist to retry with explicit args.
                        if (toolName === 'knowledge_base_query' && suspiciouslyShort) {
                            messages.push({
                                role: 'user',
                                content: `你刚才调用 knowledge_base_query 返回内容过短（len=${normalized.length}），可能是参数缺失或解析失败。\n请立即用 JSON 参数重新调用：{\"query\": \"${(originalGoal || step.description).replace(/"/g, '\\"')}\", \"limit\": 50}，并确保 tool_call.arguments 是合法 JSON。`
                            });
                        }
                    }
                    
                    messages.push({
                        role: 'tool',
                        tool_call_id: toolCallId,
                        name: toolName,
                        content: toolResult
                    });
                }
            } else {
                stepResult = response.content || "";
                stepComplete = true;
            }
            loopCount++;
        }

        // Final flush (in case provider ended without callback)
        flushStream(true);

        // Guardrail: if retrieval tools returned results, do NOT allow a "not found" final answer.
        // Also treat claims like "无现存" / "没有记录" as not-found.
        if (lastRetrievalToolHadResults && /(没找到|未找到|找不到|无现存|没有(任何)?(相关)?(记录|笔记|条目))/i.test(stepResult)) {
            onUpdate(`\n🧭 [系统] 检测到检索工具已返回结果，但专家输出了“未找到”。正在强制纠偏并要求列出命中清单... (${lastRetrievalToolSummary})`);
            dbg?.add("warn", "guardrail_triggered", "not_found_corrected", {
                runId,
                stepId: step.id,
                workerType: step.workerType,
                toolName: lastRetrievalToolName,
                summary: lastRetrievalToolSummary,
                topPaths: lastRetrievalToolTopPaths
            });
            logger.warn("AI", `Guardrail not_found_corrected (${runId} #${step.id})`, { runId, stepId: step.id, workerType: step.workerType, toolName: lastRetrievalToolName });
            messages.push({
                role: 'user',
                content:
                    `你刚才调用检索工具已经拿到了结果（${lastRetrievalToolSummary}）。\n` +
                    `你当前的输出包含“未找到/无记录”等否定结论，这是不允许的。\n\n` +
                    `请你立刻改正，并严格按以下格式输出（不要省略）：\n` +
                    `A) 一句话确认：已找到相关笔记（不得出现任何否定词）。\n` +
                    `B) 命中路径清单（至少 20 条，来自工具返回；禁止编造）：\n` +
                    `${(lastRetrievalToolTopPaths.length > 0 ? lastRetrievalToolTopPaths.map(p => `- ${p}`).join("\n") : "(如果你没能解析出路径，请重新阅读工具返回内容并提取路径)")}` +
                    `\n` +
                    `C) 对每条路径：给出 1 句梦境摘要（来自工具片段原文，必要时引用原文短句）。\n` +
                    `D) 如果其中混入“梦想/计划”等非梦境内容，允许标注“非梦境（排除）”，但依然要列在清单里并解释为何排除。\n\n` +
                    `注意：禁止再输出“未找到/无记录/无现存”。`
            });
            // 清理消息确保 tool_calls 完整性，防止 API 错误
            const cleanedCorrectionMsgs = this.sanitizeMessagesForApi(messages);
            const corrected = await this.plugin.llmService.getCompletion(cleanedCorrectionMsgs, model, undefined, (token) => {
                streamBuffer += token;
                flushStream(false);
            });
            flushStream(true);
            stepResult = corrected.content || stepResult;
        }

        // 兜底逻辑：如果 AI 执行了工具但没有给出最终总结，强制要求它总结
        if (!stepResult && loopCount > 0) {
            onUpdate(`\n📝 [${step.workerType}] 正在整理执行结果...`);
            messages.push({ role: 'user', content: "请根据以上工具执行的结果，给出最终的详细回答。" });
            // 清理消息确保 tool_calls 完整性，防止 API 错误
            const cleanedFinalMsgs = this.sanitizeMessagesForApi(messages);
            const finalResponse = await this.plugin.llmService.getCompletion(cleanedFinalMsgs, model, undefined, (token) => {
                if (onUpdate) onUpdate(token);
            });
            stepResult = finalResponse.content || "任务已执行，但未生成文字总结。";
        }

        dbg?.add("debug", "llm_call", "stream_flush_stats", {
            runId,
            stepId: step.id,
            workerType: step.workerType,
            flushCount,
            flushedChars
        });
        return stepResult;
    }

    private async runDeepResearch(step: PlanStep, context: string, systemPrompt: string, onUpdate: (msg: string) => void): Promise<string> {
        onUpdate(`🔍 [研究员] 正在启动深度搜索模式 (Deep Research)...`);
        
        // 1. Generate multiple search queries
        const queryPrompt: ChatMessage[] = [
            {
                role: 'system',
                content: `You are a Search Expert. Based on the task, generate 3 distinct and optimized search queries to gather comprehensive information.
Task: ${step.description}
Context: ${context}

Return ONLY a JSON array of strings: ["query1", "query2", "query3"]`
            }
        ];
        
        const queryResponse = await this.plugin.llmService.getCompletion(queryPrompt, this.plugin.settings.routerModel);
        let queries: string[] = [];
        try {
            queries = JSON.parse(queryResponse.content?.replace(/```json/g, '').replace(/```/g, '').trim() || "[]");
        } catch (e) {
            queries = [step.description];
        }

        let allSearchresults = "";
        const searchTool = this.plugin.agentManager.getTool("web_search");
        const readTool = this.plugin.agentManager.getTool("read_webpage");

        // Local web tools retired: do not proceed with deep research to avoid silent failures.
        if (!searchTool || !readTool) {
            return (
                `⚠️ Deep Research 已跳过：本地联网搜索工具已下线（web_search/read_webpage 不可用）。\n\n` +
                `建议：改用 MCP 工具进行联网检索（mcp_call_tool，需在设置中启用 MCP，并在设置 → MCP → 工具权限（开关）中刷新并开启要用的工具）。`
            );
        }

        // 2. Execute searches
        for (const query of queries) {
            onUpdate(`🌐 [研究员] 正在搜索: ${query}...`);
            if (searchTool) {
                const result = await searchTool.execute({ query, count: 5 }, this.app);
                allSearchresults += `\n--- Search Results for "${query}" ---\n${result}\n`;
            }
        }

        // 3. Select top URLs to read
        const selectPrompt: ChatMessage[] = [
            {
                role: 'system',
                content: `Analyze the search results and pick the top 2 most relevant URLs to read in full for deep understanding.
Results:
${allSearchresults}

Return ONLY a JSON array of strings: ["url1", "url2"]`
            }
        ];

        const selectResponse = await this.plugin.llmService.getCompletion(selectPrompt, this.plugin.settings.routerModel);
        let urls: string[] = [];
        try {
            urls = JSON.parse(selectResponse.content?.replace(/```json/g, '').replace(/```/g, '').trim() || "[]");
        } catch (e) {
            urls = [];
        }

        // 4. Read full content
        let deepContent = "";
        for (const url of urls) {
            onUpdate(`📖 [研究员] 正在深度阅读: ${url}...`);
            if (readTool) {
                const content = await readTool.execute({ url }, this.app);
                deepContent += `\n--- Full Content from ${url} ---\n${content}\n`;
            }
        }

        // 5. Synthesize Research Report
        onUpdate(`📝 [研究员] 正在汇总研究报告...`);
        const synthPrompt: ChatMessage[] = [
            {
                role: 'system',
                content: `${systemPrompt}\nYou are a Senior Researcher. Synthesize the following search snippets and deep-read content into a comprehensive research report for the next department.
Task: ${step.description}

Search Snippets:
${allSearchresults}

Deep Content:
${deepContent}`
            },
            { role: 'user', content: "Please provide the final research report." }
        ];

        const finalResponse = await this.plugin.llmService.getCompletion(synthPrompt, this.plugin.settings.writerModel);
        return finalResponse.content || "Research failed.";
    }

    public async conductDiscussion(topic: string, agentIds: string[], rounds: number = 2, onUpdate?: (msg: string) => void): Promise<string> {
        const blackboard: Blackboard = {
            topic: topic,
            messages: []
        };

        const agents = agentIds.map(id => this.plugin.agentManager.getAgent(id)).filter(a => !!a);
        if (agents.length < 2) {
            throw new Error("Discussion requires at least 2 agents.");
        }

        onUpdate?.(`🤝 启动多智能体协作讨论: ${agents.map(a => a?.name).join(" & ")}`);

        for (let r = 0; r < rounds; r++) {
            for (const agent of agents) {
                if (!agent) continue;

                onUpdate?.(`🤔 ${agent.name} (${agent.mbti || "通用"}) 正在思考...`);

                const mbtiPrompt = agent.mbti ? getMBTIPrompt(agent.mbti) : "";
                const blackboardContext = blackboard.messages.map(m => `[${m.agentName} (${m.mbti})]: ${m.content}`).join("\n\n");

                const prompt: ChatMessage[] = [
                    {
                        role: 'system',
                        content: `${mbtiPrompt}\n你正在参加一个“团队黑板讨论”。
当前讨论主题：${topic}

黑板上的已有内容：
${blackboardContext || "（暂无内容，你是第一个发言者）"}

你的任务：
1. 基于你的性格特征 and 专业背景，对当前主题发表见解。
2. 如果黑板上已有其他人的观点，请对他们的观点进行审议、补充或提出建设性的反驳。
3. 避免重复他人的话，确保你的贡献是独立的。
4. 保持回复简洁有力，不要超过 400 字。`
                    },
                    { role: 'user', content: "请发表你的看法。" }
                ];

                const response = await this.plugin.llmService.getCompletion(prompt, agent.model || this.plugin.settings.routerModel || this.plugin.settings.chatModels.split(',')[0]);
                const content = response.content || "";

                blackboard.messages.push({
                    agentName: agent.name,
                    mbti: agent.mbti || "通用",
                    content: content,
                    timestamp: Date.now()
                });

                onUpdate?.(`💬 ${agent.name}: ${content.substring(0, 100)}...`);
            }
        }

        // Final Synthesis
        onUpdate?.(`📝 正在汇总讨论结果...`);
        const finalPrompt: ChatMessage[] = [
            {
                role: 'system',
                content: `你是一个高级协调员。请根据以下多智能体讨论的记录，汇总出一个最终的、高质量的方案。
讨论主题：${topic}

讨论记录：
${blackboard.messages.map(m => `[${m.agentName}]: ${m.content}`).join("\n\n")}

你的汇总应包含：
1. 核心共识
2. 不同视角的独特贡献
3. 最终的行动建议或结论`
            },
            { role: 'user', content: "请给出最终汇总方案。" }
        ];

        const finalResponse = await this.plugin.llmService.getCompletion(finalPrompt, this.plugin.settings.writerModel);
        return finalResponse.content || "汇总失败。";
    }
}
