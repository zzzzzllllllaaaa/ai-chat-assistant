import type { AiChatAssistantSettings } from "../../core/settings";
import type { LLMProvider, ChatMessage, LLMConnectionConfig, TestConnectionResult } from "./types";
import { OpenAIProvider } from "./OpenAIProvider";
import { estimateTokensFromText } from "../../core/tokenEstimate";

export class LLMService {
    private settings: AiChatAssistantSettings;
    private providers: Map<string, LLMProvider> = new Map();

    constructor(settings: AiChatAssistantSettings) {
        this.settings = settings;
        this.initializeProviders();
    }

    private initializeProviders() {
        // Currently only OpenAI compatible provider is implemented
        // In future, we can add Anthropic, Gemini, etc.
        const openaiProvider = new OpenAIProvider(this.settings);
        this.providers.set('openai', openaiProvider);
        this.providers.set('custom', openaiProvider); // Custom is also OpenAI compatible usually
    }

    public getProvider(model: string): LLMProvider {
        // Logic to select provider based on model or settings
        // For now, we mostly rely on the OpenAI compatible provider which handles routing internally
        return this.providers.get('openai')!;
    }

    public async getCompletion(messages: ChatMessage[], model: string, tools?: any[], onUpdate?: (content: string) => void, signal?: AbortSignal): Promise<ChatMessage> {
        const provider = this.getProvider(model);
        return await provider.getCompletion(messages, model, tools, onUpdate, signal);
    }

    public async summarizeMessages(
        messages: ChatMessage[],
        model: string,
        options?: {
            maxInputTokens?: number;
            maxOutputBullets?: number;
            signal?: AbortSignal;
        }
    ): Promise<string> {
        const maxInputTokens = Math.max(600, options?.maxInputTokens || 2400);
        const maxOutputBullets = Math.max(4, options?.maxOutputBullets || 10);
        const source = this.buildSummarySource(messages, maxInputTokens);

        if (!source.trim()) {
            return "无可压缩的历史内容。";
        }

        const prompt: ChatMessage[] = [
            {
                role: 'system',
                content:
                    `你是对话压缩器。你的任务是把较长的历史对话压缩成后续模型可继续使用的“会话记忆摘要”。\n\n` +
                    `要求：\n` +
                    `- 忠实保留：用户目标、已确认事实、已做出的决定、关键约束、文件/路径/命令/工具结果、未完成事项。\n` +
                    `- 删除寒暄、重复表述、无关废话。\n` +
                    `- 如果历史里有工具调用或写入结果，要保留“做了什么、结果如何、是否失败/待修复”。\n` +
                    `- 输出使用中文。\n` +
                    `- 输出为紧凑 Markdown，不要使用代码块。\n` +
                    `- 最多 ${maxOutputBullets} 条要点。\n\n` +
                    `推荐格式：\n` +
                    `- 当前目标：...\n` +
                    `- 已确认事实：...\n` +
                    `- 已执行操作：...\n` +
                    `- 重要文件/对象：...\n` +
                    `- 未解决问题：...`
            },
            {
                role: 'user',
                content: `请压缩以下历史对话：\n\n${source}`
            }
        ];

        const response = await this.getCompletion(prompt, model, undefined, undefined, options?.signal);
        return String(response?.content || '').trim() || '历史摘要生成失败。';
    }

    public async getEmbedding(text: string): Promise<number[]> {
        const provider = this.getProvider(this.settings.embeddingModel);
        return await provider.getEmbedding(text, this.settings.embeddingModel);
    }

    /**
     * Batch embedding for multiple texts - more efficient API call
     * Falls back to sequential calls if provider doesn't support batch
     */
    public async getBatchEmbedding(texts: string[]): Promise<number[][]> {
        const provider = this.getProvider(this.settings.embeddingModel);
        if (provider.getBatchEmbedding) {
            return await provider.getBatchEmbedding(texts, this.settings.embeddingModel);
        }
        // Fallback: sequential calls
        const results: number[][] = [];
        for (const text of texts) {
            results.push(await provider.getEmbedding(text, this.settings.embeddingModel));
        }
        return results;
    }

    public async testConnection(connection: LLMConnectionConfig): Promise<TestConnectionResult> {
        const provider = this.getProvider('');
        if (!provider.testConnection) {
            throw new Error("当前 Provider 不支持连接测试。");
        }
        return await provider.testConnection(connection);
    }

    public async listModels(connection: LLMConnectionConfig): Promise<string[]> {
        const provider = this.getProvider('');
        if (!provider.listModels) {
            throw new Error("当前 Provider 不支持拉取模型列表。");
        }
        return await provider.listModels(connection);
    }

    private buildSummarySource(messages: ChatMessage[], maxInputTokens: number): string {
        if (!Array.isArray(messages) || messages.length === 0) return '';

        const serialized: string[] = [];
        let usedTokens = 0;

        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            const line = this.serializeMessageForSummary(msg);
            if (!line) continue;
            const lineTokens = estimateTokensFromText(line);
            if (serialized.length > 0 && usedTokens + lineTokens > maxInputTokens) {
                break;
            }
            serialized.unshift(line);
            usedTokens += lineTokens;
        }

        return serialized.join("\n\n");
    }

    private serializeMessageForSummary(message: ChatMessage): string {
        if (!message) return '';

        const roleMap: Record<ChatMessage['role'], string> = {
            system: '系统',
            user: '用户',
            assistant: '助手',
            tool: '工具',
        };

        const role = roleMap[message.role] || message.role;
        const parts: string[] = [];

        const content = typeof message.content === 'string' ? message.content.trim() : '';
        if (content) {
            const clipped = content.length > 1200 ? `${content.slice(0, 1200)}…` : content;
            parts.push(clipped);
        }

        if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
            const toolNames = message.tool_calls
                .map(tc => String(tc?.function?.name || '').trim())
                .filter(Boolean);
            if (toolNames.length > 0) {
                parts.push(`(已执行工具调用: ${toolNames.join(', ')})`);
            }
        }

        if (message.role === 'tool' && message.name) {
            parts.unshift(`工具名: ${message.name}`);
        }

        if (parts.length === 0) return '';
        return `[${role}] ${parts.join(' | ')}`;
    }
}
