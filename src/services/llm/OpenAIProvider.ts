import { Platform, requestUrl } from "obsidian";
import type { AiChatAssistantSettings } from "../../core/settings";
import { logger } from "../../core/logger";
import type { ChatMessage, LLMProvider, LLMConnectionConfig, TestConnectionResult } from "./types";

/** 可重试的 HTTP 状态码（网关/临时错误） */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

/** 最大重试次数 */
const MAX_RETRIES = 2;

/** 计算重试延迟（带抖动），单位 ms */
function getRetryDelay(attempt: number, baseMs = 1000): number {
    const exponential = baseMs * Math.pow(2, attempt);
    const jitter = Math.random() * 500;
    return Math.min(exponential + jitter, 10000); // 最大 10s
}

/** 检查是否应该重试 */
function shouldRetry(status: number, attempt: number): boolean {
    return attempt < MAX_RETRIES && RETRYABLE_STATUS_CODES.has(status);
}

/** 休眠指定毫秒 */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export class OpenAIProvider implements LLMProvider {
    id = 'openai';
    name = 'OpenAI Compatible';
    private settings: AiChatAssistantSettings;

    constructor(settings: AiChatAssistantSettings) {
        this.settings = settings;
    }

    private newRequestId(prefix: string): string {
        return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    }

    private safeJsonStringify(value: unknown, fallback = "[unserializable]"): string {
        try {
            return JSON.stringify(value);
        } catch {
            return fallback;
        }
    }

    private truncateText(text: string, maxLen: number): string {
        if (!text) return "";
        if (text.length <= maxLen) return text;
        return text.slice(0, maxLen) + `\n... (truncated, total=${text.length})`;
    }

    private truncateToolOutput(content: string, toolName?: string): string {
        // Some providers (and reverse proxies) reject very large tool messages with 400.
        // Keep UI/history intact elsewhere; only truncate what we send to the model.
        const maxLen = 12000;
        if (!content || content.length <= maxLen) return content;

        const namePart = toolName ? ` 工具=${toolName}` : "";
        return (
            content.slice(0, maxLen) +
            `\n\n[tool-output-truncated]${namePart} 原长度=${content.length}，已保留前 ${maxLen} 字符。` +
            `\n如需更多内容：请让用户缩小查询范围/减少返回条数/指定文件路径。`
        );
    }

    /**
     * Check if a model supports vision/multimodal (image_url content type).
     * Models that don't support it will get 400 errors if we send image_url.
     */
    private supportsVision(model: string): boolean {
        const m = model.toLowerCase();
        // Known vision-capable model patterns
        const visionPatterns = [
            'gpt-4o',           // gpt-4o, gpt-4o-mini
            'gpt-4-vision',
            'gpt-4-turbo',      // gpt-4-turbo supports vision
            'claude-3',         // claude-3-opus, claude-3-sonnet, claude-3-haiku
            'claude-3.5',
            'gemini',           // gemini-pro-vision, gemini-1.5-pro
            'qwen-vl',          // qwen-vl-plus, qwen-vl-max
            'qwen2-vl',
            'glm-4v',           // zhipu GLM-4V
            'yi-vision',
            'llava',
            'cogvlm',
            'internvl',
        ];
        return visionPatterns.some(pattern => m.includes(pattern));
    }

    /**
     * 清理消息数组，确保 tool_calls 和 tool 消息成对出现。
     * 解决因历史消息截断导致的 API 400 错误：
     * "An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'."
     * 
     * 策略：
     * 1. 找出所有 assistant 消息中的 tool_call_ids
     * 2. 找出所有 tool 消息的 tool_call_ids
     * 3. 如果某个 tool_call_id 没有对应的 tool 消息，移除该 assistant 消息的 tool_calls
     * 4. 如果某个 tool 消息没有对应的 tool_call，移除该 tool 消息
     */
    private sanitizeToolMessages(messages: ChatMessage[]): ChatMessage[] {
        // 收集所有 assistant 消息中的 tool_call_ids
        const assistantToolCallIds = new Set<string>();
        const assistantMsgsWithToolCalls: number[] = [];
        
        messages.forEach((msg, idx) => {
            if (msg.role === 'assistant' && Array.isArray((msg as any).tool_calls)) {
                const toolCalls = (msg as any).tool_calls as any[];
                if (toolCalls.length > 0) {
                    assistantMsgsWithToolCalls.push(idx);
                    toolCalls.forEach(tc => {
                        if (tc?.id) assistantToolCallIds.add(tc.id);
                    });
                }
            }
        });

        // 收集所有 tool 消息的 tool_call_ids
        const toolMsgCallIds = new Set<string>();
        messages.forEach(msg => {
            if (msg.role === 'tool' && msg.tool_call_id) {
                toolMsgCallIds.add(msg.tool_call_id);
            }
        });

        // 找出不匹配的情况
        const orphanedToolCallIds = new Set<string>();  // assistant 有 tool_call 但没有对应 tool 消息
        const orphanedToolMsgIds = new Set<string>();   // tool 消息没有对应 assistant tool_call
        
        assistantToolCallIds.forEach(id => {
            if (!toolMsgCallIds.has(id)) {
                orphanedToolCallIds.add(id);
            }
        });
        
        toolMsgCallIds.forEach(id => {
            if (!assistantToolCallIds.has(id)) {
                orphanedToolMsgIds.add(id);
            }
        });

        // 如果没有不匹配，直接返回
        if (orphanedToolCallIds.size === 0 && orphanedToolMsgIds.size === 0) {
            return messages;
        }

        logger.warn("AI", "[OpenAIProvider] Detected orphaned tool messages, sanitizing", {
            orphanedToolCallIds: Array.from(orphanedToolCallIds),
            orphanedToolMsgIds: Array.from(orphanedToolMsgIds)
        });

        // 清理消息
        const result: ChatMessage[] = [];
        for (const msg of messages) {
            // 跳过孤立的 tool 消息
            if (msg.role === 'tool' && msg.tool_call_id && orphanedToolMsgIds.has(msg.tool_call_id)) {
                continue;
            }

            // 处理 assistant 消息的 tool_calls
            if (msg.role === 'assistant' && Array.isArray((msg as any).tool_calls)) {
                const toolCalls = (msg as any).tool_calls as any[];
                const validToolCalls = toolCalls.filter(tc => tc?.id && !orphanedToolCallIds.has(tc.id));
                
                if (validToolCalls.length === 0) {
                    // 所有 tool_calls 都是孤立的，移除 tool_calls 属性
                    const cleanedMsg = { ...msg };
                    delete (cleanedMsg as any).tool_calls;
                    // 如果移除 tool_calls 后没有 content，添加一个占位符
                    if (!cleanedMsg.content) {
                        cleanedMsg.content = "(工具调用记录因历史截断已省略)";
                    }
                    result.push(cleanedMsg);
                } else if (validToolCalls.length < toolCalls.length) {
                    // 部分 tool_calls 是孤立的，只保留有效的
                    const cleanedMsg = { ...msg };
                    (cleanedMsg as any).tool_calls = validToolCalls;
                    result.push(cleanedMsg);
                } else {
                    result.push(msg);
                }
            } else {
                result.push(msg);
            }
        }

        return result;
    }

    /**
     * Build a clean, OpenAI-compatible messages array from internal ChatMessage[].
     * - Merges multiple system messages into one (many gateways like qwen-max only accept a single system).
     * - EXCEPTION: cacheAnchor system messages are kept as separate messages at the front,
     *   enabling DeepSeek's context caching prefix match optimization.
     * - Strips internal fields (references/intermediateMessages/images for non-multimodal).
     * - Keeps assistant.content as null when tool_calls present (per OpenAI spec).
     */
    private buildApiMessages(messages: ChatMessage[], hasTools: boolean, model?: string): any[] {
        // 首先清理消息，确保 tool_calls 和 tool 消息成对出现
        const sanitizedMessages = this.sanitizeToolMessages(messages);
        
        const systemParts: string[] = [];
        const cacheAnchorParts: string[] = [];
        const nonSystemMsgs: any[] = [];
        const canUseVision = model ? this.supportsVision(model) : false;

        for (const msg of sanitizedMessages) {
            const role = msg.role;

            // If we are NOT sending tools, skip tool-role and tool_calls entirely.
            if (!hasTools) {
                if (role === 'tool') continue;
                if (role === 'assistant' && Array.isArray((msg as any).tool_calls)) {
                    const content = typeof msg.content === 'string' ? msg.content : "";
                    if (!content) continue;
                    nonSystemMsgs.push({ role: 'assistant', content });
                    continue;
                }
            }

            if (role === 'system') {
                const text = typeof msg.content === 'string' ? msg.content.trim() : "";
                if (!text) continue;
                // 分离缓存锚定消息和动态消息
                if ((msg as any).cacheAnchor) {
                    cacheAnchorParts.push(text);
                } else {
                    systemParts.push(text);
                }
                continue;
            }

            // user with images → multimodal content array (only if model supports vision)
            if (role === 'user' && Array.isArray(msg.images) && msg.images.length > 0) {
                const textContent = typeof msg.content === 'string' ? msg.content : "";
                if (canUseVision) {
                    nonSystemMsgs.push({
                        role: 'user',
                        content: [
                            { type: "text", text: textContent || "" },
                            ...msg.images.map((img: string) => ({
                                type: "image_url",
                                image_url: { url: img }
                            }))
                        ]
                    });
                } else {
                    const imgNote = `[图片已省略：当前模型 ${model || '未知'} 不支持图片输入，共 ${msg.images.length} 张图片]`;
                    nonSystemMsgs.push({
                        role: 'user',
                        content: textContent ? `${textContent}\n\n${imgNote}` : imgNote
                    });
                }
                continue;
            }

            if (role === 'assistant') {
                const hasToolCalls = hasTools && Array.isArray((msg as any).tool_calls) && (msg as any).tool_calls.length > 0;
                const content = hasToolCalls
                    ? (msg.content ?? null)
                    : (typeof msg.content === 'string' ? msg.content : "");
                const out: any = { role: 'assistant', content };
                if (hasToolCalls) {
                    out.tool_calls = (msg as any).tool_calls;
                }
                if (msg.reasoning_content) {
                    out.reasoning_content = msg.reasoning_content;
                }
                nonSystemMsgs.push(out);
                continue;
            }

            if (role === 'tool') {
                const truncated = typeof msg.content === 'string'
                    ? this.truncateToolOutput(msg.content, msg.name)
                    : "";
                nonSystemMsgs.push({
                    role: 'tool',
                    tool_call_id: msg.tool_call_id,
                    content: truncated,
                });
                continue;
            }

            // user default
            const contentText = typeof msg.content === 'string' ? msg.content : "";
            nonSystemMsgs.push({ role, content: contentText });
        }

        const result: any[] = [];
        // 缓存锚定消息：每条独立发送，作为 DeepSeek 缓存前缀锚点
        for (const part of cacheAnchorParts) {
            result.push({ role: 'system', content: part });
        }
        // 动态 system 消息合并为一条（兼容只接受单条 system 的网关）
        if (systemParts.length > 0) {
            result.push({ role: 'system', content: systemParts.join("\n\n---\n\n") });
        }
        result.push(...nonSystemMsgs);
        return result;
    }

    private redactSecrets(text: string): string {
        if (!text) return "";
        // Avoid leaking common key patterns if they ever appear in logs.
        return text
            .replace(/sk-[A-Za-z0-9]{8,}/g, "sk-***")
            .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer ***");
    }

    private buildChatRequestSummary(body: any): any {
        const msgs: any[] = Array.isArray(body?.messages) ? body.messages : [];
        const roles = msgs.map(m => String(m?.role || ""));
        const roleCounts = roles.reduce<Record<string, number>>((acc, r) => {
            acc[r] = (acc[r] || 0) + 1;
            return acc;
        }, {});

        const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
        const lastRole = String(lastMsg?.role || "");
        const lastContent = typeof lastMsg?.content === 'string'
            ? lastMsg.content
            : this.safeJsonStringify(lastMsg?.content, "");

        const toolRoleCount = roles.filter(r => r === 'tool').length;
        const assistantToolCallsCount = msgs
            .filter(m => m?.role === 'assistant' && Array.isArray(m?.tool_calls))
            .reduce((sum, m) => sum + (m.tool_calls?.length || 0), 0);
        const toolCallIdsMissing = msgs
            .filter(m => m?.role === 'assistant' && Array.isArray(m?.tool_calls))
            .some(m => (m.tool_calls || []).some((tc: any) => !tc?.id));

        const tools: any[] = Array.isArray(body?.tools) ? body.tools : [];
        const toolsCount = tools.length;
        const toolSchemaSummary = tools.slice(0, 8).map((tool: any) => {
            const fn = tool?.function || {};
            const parameters = fn?.parameters || {};
            const properties = parameters?.properties && typeof parameters.properties === 'object' ? parameters.properties : {};
            const propertyKeys = Object.keys(properties);
            const required = Array.isArray(parameters?.required) ? parameters.required : [];
            return {
                name: fn?.name,
                propertyKeys,
                required,
            };
        });
        return {
            model: body?.model,
            stream: !!body?.stream,
            messagesCount: msgs.length,
            roleCounts,
            toolRoleCount,
            toolsCount,
            toolSchemaSummary,
            assistantToolCallsCount,
            toolCallIdsMissing,
            lastRole,
            lastContentPreview: this.truncateText(this.redactSecrets(String(lastContent || "")), 280),
            lastContentLength: String(lastContent || "").length,
        };
    }

    private isMobileApp(): boolean {
        return (Platform as any)?.isMobileApp ?? (Platform as any)?.isMobile ?? false;
    }

    private getHttpHintForUrl(url: string): string | null {
        try {
            const parsed = new URL(url);
            if (String(parsed.protocol || "").toLowerCase() !== "http:") return null;
            if (!this.isMobileApp()) return null;
            return "检测到移动端使用 http 明文地址。部分系统/网络环境会拦截明文请求或长连接，建议改用 https 或在网关侧开启 TLS。";
        } catch {
            return null;
        }
    }

    private classifyProviderError(status: number, errorTextOrJson: any): Error {
        let rawText = "";
        let errObj: any = null;

        if (typeof errorTextOrJson === 'string') {
            rawText = errorTextOrJson;
            try {
                errObj = JSON.parse(errorTextOrJson);
            } catch {
                errObj = null;
            }
        } else {
            errObj = errorTextOrJson;
            try {
                rawText = JSON.stringify(errorTextOrJson);
            } catch {
                rawText = String(errorTextOrJson);
            }
        }

        const apiError = errObj?.error ?? errObj;
        const message: string = String(apiError?.message ?? "");
        const code: string = String(apiError?.code ?? "");
        const type: string = String(apiError?.type ?? "");
        const combined = `${message} ${code} ${type} ${rawText}`.toLowerCase();

        // Debug: log the actual error for troubleshooting
        console.log('[OpenAIProvider] parseApiError:', { status, message, code, type, rawText: rawText.slice(0, 500) });

        // Billing / quota / account status issues - be more specific to avoid false positives
        const isArrearageError = combined.includes('arrearage') || 
            combined.includes('good standing') || 
            combined.includes('insufficient_quota') ||
            (combined.includes('quota') && combined.includes('insufficient')) ||
            (combined.includes('quota') && combined.includes('exceeded')) ||
            (combined.includes('billing') && combined.includes('not active'));
        
        if (isArrearageError) {
            return new Error(
                "账号欠费/额度不可用，模型接口拒绝访问（Arrearage/Quota）。\n" +
                "处理方式：请到该 Base URL 对应的平台充值/续费/开通额度，或在设置里切换到有额度的模型/服务商。\n" +
                `原始信息：${message || rawText.slice(0, 200)}`
            );
        }

        // Auth issues
        if (status === 401 || combined.includes('invalid api key') || combined.includes('unauthorized')) {
            return new Error("API Key 无效或无权限（401/Unauthorized）。请检查设置中的 API Key 与 Base URL 是否匹配。");
        }

        if (status === 403 || combined.includes('forbidden')) {
            return new Error(
                "接口拒绝访问（403/Forbidden）。\n" +
                "可能原因：API Key 无权限/被封禁、服务端策略限制（IP 白名单/区域/模型未开通）、Base URL 路由到不支持的上游。\n" +
                "处理方式：检查该模型是否在该服务商已开通；确认 API Key、Base URL、模型名与网关一致；必要时更换模型或服务商。"
            );
        }

        // Default
        const brief = message || rawText || 'Unknown error';
        if (status === 400) {
            return new Error(`API Error: ${status} - ${brief}\n这通常是上游网关拒绝了请求格式；请查看控制台中的 request.toolSchemaSummary 和 responseText。`);
        }
        return new Error(`API Error: ${status} - ${brief}`);
    }

    private getBaseUrl(model: string): string {
        const resolved = this.resolveConnectionForModel(model);
        if (resolved?.baseUrl) return resolved.baseUrl;

        // Local LLM toggle (kept as feature)
        if (this.settings.enableLocalLLM) return this.settings.localLLMUrl.replace(/\/$/, "");

        // Fallback: default/first enabled connection
        const connections = Array.isArray((this.settings as any)?.connections) ? (this.settings as any).connections as any[] : [];
        const enabled = connections.filter(c => c && c.enabled !== false);
        const conn = enabled.find(c => String(c.id) === 'default') || enabled[0];
        const baseUrl = String(conn?.baseUrl || '').trim().replace(/\/$/, "");
        if (!baseUrl) {
            throw new Error("未配置任何可用连接（Connections）。请到设置 → Model → 连接 (Connections) 添加 Base URL / API Key。");
        }
        return baseUrl;
    }

    private getApiKey(model: string): string {
        const resolved = this.resolveConnectionForModel(model);
        if (resolved) return resolved.apiKey;

        if (this.settings.enableLocalLLM) return "ollama";

        // Fallback: default/first enabled connection
        const connections = Array.isArray((this.settings as any)?.connections) ? (this.settings as any).connections as any[] : [];
        const enabled = connections.filter(c => c && c.enabled !== false);
        const conn = enabled.find(c => String(c.id) === 'default') || enabled[0];
        return String(conn?.apiKey || '');
    }

    private normalizeBaseUrl(url: string): string {
        return String(url || '').trim().replace(/\/$/, "");
    }

    /**
     * Log DeepSeek context caching metrics from API response usage.
     * prompt_cache_hit_tokens: number of input tokens served from cache (90% cheaper!)
     * prompt_cache_miss_tokens: number of input tokens that missed the cache
     */
    private logCacheMetrics(usage: any, requestId: string, model?: string): void {
        if (!usage) return;
        const hitTokens = typeof usage.prompt_cache_hit_tokens === 'number' ? usage.prompt_cache_hit_tokens : -1;
        const missTokens = typeof usage.prompt_cache_miss_tokens === 'number' ? usage.prompt_cache_miss_tokens : -1;
        if (hitTokens < 0 && missTokens < 0) return; // No cache info (not DeepSeek or older API)

        const total = hitTokens + missTokens;
        const hitRate = total > 0 ? ((hitTokens / total) * 100).toFixed(1) : '0.0';
        const promptTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : total;
        const completionTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0;

        logger.info('AI', `Cache metrics${model ? ` [${model}]` : ''}`, {
            requestId,
            cacheHitTokens: hitTokens,
            cacheMissTokens: missTokens,
            cacheHitRate: `${hitRate}%`,
            promptTokens,
            completionTokens,
        });
    }

    private buildAuthHeaders(apiKey?: string): Record<string, string> {
        const key = String(apiKey || '');
        if (!key) return {};
        return { 'Authorization': `Bearer ${key}` };
    }

    async testConnection(connection: LLMConnectionConfig): Promise<TestConnectionResult> {
        const baseUrl = this.normalizeBaseUrl(connection?.baseUrl);
        if (!baseUrl) {
            return { ok: false, message: 'Base URL 为空', durationMs: 0 };
        }

        const startedAt = Date.now();
        const details: TestConnectionResult['details'] = {};
        let availableModels: string[] = [];

        // === 第1步：连通性 + 认证测试（GET /models） ===
        try {
            const modelsUrl = `${baseUrl}/models`;
            const resp = await requestUrl({
                url: modelsUrl,
                method: 'GET',
                headers: this.buildAuthHeaders(connection?.apiKey),
            });

            const status = resp.status ?? 0;
            const data = resp.json;

            if (status === 401 || (data?.error && String(data.error?.type || data.error?.code || '').toLowerCase().includes('auth'))) {
                details.connectivity = { ok: true, message: '地址可访问' };
                details.auth = { ok: false, message: 'API Key 无效或无权限（401），请检查 Key 是否正确、是否过期。' };
                return {
                    ok: false, status, durationMs: Date.now() - startedAt,
                    message: '❌ API Key 验证失败：Key 无效或无权限。请检查 API Key 是否正确填写。',
                    details,
                };
            }

            if (status === 403) {
                details.connectivity = { ok: true, message: '地址可访问' };
                details.auth = { ok: false, message: '访问被拒绝（403），可能是 IP 限制、区域限制或 Key 无权限。' };
                return {
                    ok: false, status, durationMs: Date.now() - startedAt,
                    message: '❌ 访问被拒绝（403）：可能是 IP/区域限制，或 API Key 权限不足。',
                    details,
                };
            }

            if ((status && status >= 400) || data?.error) {
                // For 404 or some API specific errors on /models, don't fail immediately.
                // Many providers (like Minimax, Moonshot) don't fully support /v1/models or require different params.
                if (status === 404 || status === 400 || status === 405 || status === 500) {
                    details.connectivity = { ok: true, message: '地址可访问（但 /models 不受支持或报错）' };
                    details.auth = { ok: true, message: `模型列表接口返回 ${status}，将尝试验证对话接口` };
                    availableModels = [];
                } else {
                    const rawText = (resp as any)?.text ? String((resp as any).text) : this.safeJsonStringify(data, "");
                    const err = this.classifyProviderError(status || 400, data?.error ? data : rawText);
                    details.connectivity = { ok: true, message: '地址可访问' };
                    details.auth = { ok: false, message: err.message };
                    return {
                        ok: false, status, durationMs: Date.now() - startedAt,
                        message: `❌ ${err.message}`,
                        details,
                    };
                }
            } else {
                // 成功获取模型列表
                availableModels = this.extractModelIds(data);
                details.connectivity = { ok: true, message: '地址可访问' };
                details.auth = { ok: true, message: 'API Key 有效' };
                details.model = {
                    ok: availableModels.length > 0,
                    message: availableModels.length > 0 ? `发现 ${availableModels.length} 个模型` : '未解析到模型列表（部分服务商不支持 /models 接口）',
                    availableModels: availableModels.slice(0, 20),  // 只返回前20个
                };
            }

        } catch (e: any) {
            // Obsidian's requestUrl throws on non-2xx statuses. We need to handle 404/400 etc. here too
            const status = e?.status ?? e?.response?.status ?? 0;
            if (status === 404 || status === 400 || status === 405 || status === 500) {
                details.connectivity = { ok: true, message: '地址可访问（但 /models 不受支持或报错）' };
                details.auth = { ok: true, message: `模型列表接口返回 ${status}，将尝试验证对话接口` };
                availableModels = [];
            } else if (status === 401) {
                details.connectivity = { ok: true, message: '地址可访问' };
                details.auth = { ok: false, message: 'API Key 无效或无权限（401），请检查 Key 是否正确、是否过期。' };
                return {
                    ok: false, status, durationMs: Date.now() - startedAt,
                    message: '❌ API Key 验证失败：Key 无效或无权限。请检查 API Key 是否正确填写。',
                    details,
                };
            } else if (status === 403) {
                details.connectivity = { ok: true, message: '地址可访问' };
                details.auth = { ok: false, message: '访问被拒绝（403），可能是 IP 限制、区域限制或 Key 无权限。' };
                return {
                    ok: false, status, durationMs: Date.now() - startedAt,
                    message: '❌ 访问被拒绝（403）：可能是 IP/区域限制，或 API Key 权限不足。',
                    details,
                };
            } else {
                const errMsg = e?.message || String(e);
                // 区分网络错误类型给出更精确的提示
                const isTimeout = errMsg.toLowerCase().includes('timeout') || errMsg.toLowerCase().includes('timed out');
                const isDns = errMsg.toLowerCase().includes('getaddrinfo') || errMsg.toLowerCase().includes('dns') || errMsg.toLowerCase().includes('enotfound');
                const isRefused = errMsg.toLowerCase().includes('econnrefused') || errMsg.toLowerCase().includes('connection refused');
                const isSsl = errMsg.toLowerCase().includes('ssl') || errMsg.toLowerCase().includes('certificate') || errMsg.toLowerCase().includes('cert');

                let friendlyMsg = errMsg;
                if (isDns) {
                    friendlyMsg = `域名无法解析，请检查 Base URL 是否拼写正确。常见错误：\n• api.openai.com 不要写成 api.openapi.com\n• api.deepseek.com 不要写成 api.deekseek.com\n原始错误: ${errMsg}`;
                } else if (isRefused) {
                    friendlyMsg = `连接被拒绝，目标服务器未响应。请确认：\n• Base URL 地址是否正确\n• 是否需要 VPN/代理\n• 本地服务是否已启动\n原始错误: ${errMsg}`;
                } else if (isTimeout) {
                    friendlyMsg = `连接超时。请确认：\n• 网络是否正常\n• 是否需要 VPN/代理访问该地址\n• 服务器是否在线\n原始错误: ${errMsg}`;
                } else if (isSsl) {
                    friendlyMsg = `SSL/证书错误。请确认 Base URL 的 https:// 是否正确，或尝试使用 http://。\n原始错误: ${errMsg}`;
                }

                details.connectivity = { ok: false, message: friendlyMsg };
                return {
                    ok: false, durationMs: Date.now() - startedAt,
                    message: `❌ 连接失败：${friendlyMsg}`,
                    details,
                };
            }
        }

        // === 第2步：如果指定了测试模型，验证模型可用性 + 轻量对话测试 ===
        const testModel = connection.testModel;
        if (testModel) {
            // 检查模型是否在列表中
            if (availableModels.length > 0) {
                const modelExists = availableModels.some(m =>
                    m.toLowerCase() === testModel.toLowerCase() ||
                    m.toLowerCase().includes(testModel.toLowerCase()) ||
                    testModel.toLowerCase().includes(m.toLowerCase())
                );
                if (!modelExists) {
                    details.model = {
                        ok: false,
                        message: `模型 "${testModel}" 未在该连接的模型列表中找到。可用模型（前10个）：${availableModels.slice(0, 10).join(', ')}`,
                        availableModels: availableModels.slice(0, 20),
                    };
                    // 不直接返回失败 — 有些服务商的 /models 列表不全但模型可用，继续尝试 chat
                }
            }

            // 尝试轻量 chat completion 测试
            try {
                const chatUrl = `${baseUrl}/chat/completions`;
                const chatResp = await requestUrl({
                    url: chatUrl,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...this.buildAuthHeaders(connection?.apiKey),
                    },
                    body: JSON.stringify({
                        model: testModel,
                        messages: [{ role: 'user', content: 'Hi' }],
                        max_tokens: 1,
                        stream: false,
                    }),
                });

                const chatStatus = chatResp.status ?? 0;
                const chatData = chatResp.json;

                if (chatStatus === 404 || (chatData?.error && String(chatData.error?.code || chatData.error?.message || '').toLowerCase().includes('not found'))) {
                    details.chat = { ok: false, message: `模型 "${testModel}" 不存在或未开通。请检查模型名称是否正确。` };
                    return {
                        ok: false, status: chatStatus, durationMs: Date.now() - startedAt,
                        message: `⚠️ 连接正常，但模型 "${testModel}" 不可用。请检查模型名称是否正确，或在该服务商是否已开通。`,
                        details,
                    };
                }

                if ((chatStatus && chatStatus >= 400) || chatData?.error) {
                    const rawText = (chatResp as any)?.text ? String((chatResp as any).text) : this.safeJsonStringify(chatData, "");
                    const errMsg = chatData?.error?.message || rawText.slice(0, 200);
                    details.chat = { ok: false, message: `对话测试失败（${chatStatus}）：${errMsg}` };
                    return {
                        ok: false, status: chatStatus, durationMs: Date.now() - startedAt,
                        message: `⚠️ 连接正常，但对话测试失败：${errMsg}`,
                        details,
                    };
                }

                // Chat test succeeded
                details.chat = { ok: true, message: `模型 "${testModel}" 对话测试通过` };

            } catch (chatErr: any) {
                // Obsidian's requestUrl throws an error for non-2xx status codes
                const chatStatus = chatErr?.status ?? chatErr?.response?.status ?? 0;
                if (chatStatus === 404) {
                    details.chat = { ok: false, message: `模型 "${testModel}" 不存在或未开通。请检查模型名称是否正确。` };
                    return {
                        ok: false, status: chatStatus, durationMs: Date.now() - startedAt,
                        message: `⚠️ 连接正常，但模型 "${testModel}" 不可用。请检查模型名称是否正确，或在该服务商是否已开通。`,
                        details,
                    };
                }

                details.chat = { ok: false, message: `对话测试异常：${chatErr?.message || String(chatErr)}` };
                // 不因 chat 测试失败而标记整体失败，连接本身是通的
            }
        }

        // === 汇总结果 ===
        const durationMs = Date.now() - startedAt;
        const parts: string[] = ['✅ 连接正常'];
        if (details.auth?.ok) parts.push('Key 有效');
        if (availableModels.length > 0) parts.push(`${availableModels.length} 个模型`);
        if (details.chat?.ok) parts.push(`模型 "${testModel}" 可用`);
        else if (details.chat && !details.chat.ok) parts.push(`⚠️ 模型测试: ${details.chat.message}`);

        return {
            ok: true,
            status: 200,
            message: parts.join('，'),
            durationMs,
            details,
        };
    }

    private extractModelIds(data: any): string[] {
        // OpenAI: { object:'list', data:[{id:'gpt-4o', ...}, ...] }
        const arr = Array.isArray(data?.data) ? data.data
            : Array.isArray(data?.models) ? data.models
                : Array.isArray(data) ? data
                    : [];

        const models = arr
            .map((m: any) => {
                if (typeof m === 'string') return m;
                return String(m?.id || m?.name || '').trim();
            })
            .filter(Boolean);

        return Array.from(new Set(models));
    }

    async listModels(connection: LLMConnectionConfig): Promise<string[]> {
        const baseUrl = this.normalizeBaseUrl(connection?.baseUrl);
        if (!baseUrl) throw new Error('Base URL 为空');

        const url = `${baseUrl}/models`;
        const resp = await requestUrl({
            url,
            method: 'GET',
            headers: this.buildAuthHeaders(connection?.apiKey),
        });

        const status = resp.status ?? 0;
        const data = resp.json;
        if ((status && status >= 400) || data?.error) {
            const rawText = (resp as any)?.text ? String((resp as any).text) : this.safeJsonStringify(data, "");
            throw this.classifyProviderError(status || 400, data?.error ? data : rawText);
        }

        return this.extractModelIds(data);
    }

    /**
     * 解析模型标识符，支持 "model" 和 "model@connectionId" 两种格式
     * @returns { modelName: 纯模型名, connectionIdHint: 显式指定的连接ID（如果有） }
     */
    private parseModelIdentifier(modelInput: string): { modelName: string; connectionIdHint: string | null } {
        const input = String(modelInput || '').trim();
        // 检查是否包含 @ 符号来指定连接
        const atIndex = input.lastIndexOf('@');
        if (atIndex > 0 && atIndex < input.length - 1) {
            // 格式：model@connectionId
            const modelName = input.slice(0, atIndex).trim();
            const connectionIdHint = input.slice(atIndex + 1).trim();
            return { modelName, connectionIdHint };
        }
        return { modelName: input, connectionIdHint: null };
    }

    private resolveConnectionForModel(model: string): { baseUrl: string; apiKey: string; resolvedModel: string } | null {
        const connections = (this.settings as any)?.connections as any[] | undefined;
        const registry = (this.settings as any)?.modelRegistry as any[] | undefined;
        if (!Array.isArray(connections) || connections.length === 0) return null;

        const normalizeBaseUrl = (url: string) => String(url || '').trim().replace(/\/$/, "");
        const enabledConnections = connections.filter(c => c && c.enabled !== false);
        if (enabledConnections.length === 0) return null;

        // 解析模型标识符（可能包含 @connectionId）
        const { modelName, connectionIdHint } = this.parseModelIdentifier(model);
        let connId: string | null = connectionIdHint;

        // 如果没有显式指定连接ID，从 registry 查找
        if (!connId && Array.isArray(registry) && registry.length > 0 && modelName) {
            const hit = registry.find(r => String(r?.model || '').trim() === modelName);
            if (hit) connId = String(hit.connectionId || '').trim();
        }

        let conn = connId
            ? enabledConnections.find(c => String(c.id) === connId)
            : null;

        if (!conn) {
            // default connection preference: id=default
            conn = enabledConnections.find(c => String(c.id) === 'default') || enabledConnections[0];
        }

        const baseUrl = normalizeBaseUrl(String(conn?.baseUrl || ''));
        const apiKey = String(conn?.apiKey || '');
        if (!baseUrl) return null;
        return { baseUrl, apiKey, resolvedModel: modelName };
    }

    async getEmbedding(text: string, model: string): Promise<number[]> {
        // 解析模型标识符，获取纯模型名
        const resolved = this.resolveConnectionForModel(model);
        const baseUrl = resolved?.baseUrl || this.getBaseUrl(model);
        const apiKey = resolved?.apiKey ?? this.getApiKey(model);
        
        // Special handling for Local LLM embedding model if needed
        let embeddingModel = resolved?.resolvedModel || this.parseModelIdentifier(model).modelName;
        if (this.settings.enableLocalLLM) {
             // Assuming settings.embeddingModel is correct for local
             embeddingModel = this.settings.embeddingModel;
        }

        const embeddingUrl = `${baseUrl}/embeddings`;
        logger.debug('AI', `Generating embedding: model=${embeddingModel}, url=${embeddingUrl}, textLen=${text.length}, resolvedConn=${resolved ? 'yes' : 'fallback'}`);

        try {
            const response = await requestUrl({
                url: embeddingUrl,
                method: 'POST',
                contentType: 'application/json',
                headers: { 'Authorization': `Bearer ${apiKey}` },
                body: JSON.stringify({ input: text, model: embeddingModel }),
            });

            const data = response.json;
            if (data && data.data && data.data[0] && data.data[0].embedding) {
                return data.data[0].embedding;
            } else {
                logger.error('AI', "Invalid embedding response", data);
                throw new Error("从API返回的向量数据格式无效。");
            }
        } catch (e: any) {
            // 增强错误信息，附带实际请求的 URL 和模型名，方便排查
            const status = (e as any)?.status || '';
            const enhanced = `Embedding 请求失败 (status ${status}): url=${embeddingUrl}, model=${embeddingModel}, inputModel=${model}. ${e?.message || String(e)}`;
            logger.error('AI', enhanced);
            throw new Error(enhanced);
        }
    }

    /**
     * Batch embedding for multiple texts in one API call.
     * OpenAI API supports sending an array of inputs.
     * Max batch size varies by provider (OpenAI: 2048, others may differ).
     */
    async getBatchEmbedding(texts: string[], model: string): Promise<number[][]> {
        if (texts.length === 0) return [];
        if (texts.length === 1) {
            return [await this.getEmbedding(texts[0], model)];
        }

        const resolved = this.resolveConnectionForModel(model);
        const baseUrl = resolved?.baseUrl || this.getBaseUrl(model);
        const apiKey = resolved?.apiKey ?? this.getApiKey(model);
        
        let embeddingModel = resolved?.resolvedModel || this.parseModelIdentifier(model).modelName;
        if (this.settings.enableLocalLLM) {
            embeddingModel = this.settings.embeddingModel;
        }

        const embeddingUrl = `${baseUrl}/embeddings`;
        logger.debug('AI', `Batch embedding: model=${embeddingModel}, count=${texts.length}, url=${embeddingUrl}`);

        try {
            const response = await requestUrl({
                url: embeddingUrl,
                method: 'POST',
                contentType: 'application/json',
                headers: { 'Authorization': `Bearer ${apiKey}` },
                body: JSON.stringify({ input: texts, model: embeddingModel }),
            });

            const data = response.json;
            if (data?.data && Array.isArray(data.data)) {
                // OpenAI returns embeddings in same order as input
                // Sort by index to be safe
                const sorted = data.data.sort((a: any, b: any) => a.index - b.index);
                return sorted.map((item: any) => item.embedding);
            } else {
                logger.error('AI', "Invalid batch embedding response", data);
                throw new Error("从 API 返回的批量向量数据格式无效。");
            }
        } catch (e: any) {
            const status = (e as any)?.status || '';
            const enhanced = `Batch Embedding 请求失败 (status ${status}): url=${embeddingUrl}, model=${embeddingModel}, count=${texts.length}. ${e?.message || String(e)}`;
            logger.error('AI', enhanced);
            throw new Error(enhanced);
        }
    }

    private classifyRequestProfile(body: any): { hasTools: boolean; isSimpleTask: boolean; timeoutMs: number; maxRetries: number } {
        const hasTools = Array.isArray(body?.tools) && body.tools.length > 0;
        const messages = Array.isArray(body?.messages) ? body.messages : [];
        const joined = messages.map((m: any) => String(m?.content || "")).join("\n");
        const isSimpleTask = joined.length <= 4000 && !/(复杂|多步骤|分步|逐步|深入|全面|exhaustive|step by step|multi-step)/i.test(joined);
        if (isSimpleTask) {
            return { hasTools, isSimpleTask, timeoutMs: 45000, maxRetries: 0 };
        }
        if (hasTools) return { hasTools, isSimpleTask, timeoutMs: 75000, maxRetries: 1 };
        return { hasTools, isSimpleTask, timeoutMs: 120000, maxRetries: MAX_RETRIES };
    }

    private buildFallbackTools(tools: any[]): any[] {
        const toolList = Array.isArray(tools) ? tools : [];
        const preferred = [
            "create_note",
            "read_note",
            "list_files",
            "get_note_structure",
            "search_notes",
            "modify_note",
            "replace_in_note",
        ];
        const preferredSet = new Set(preferred);
        const narrowed = toolList.filter((tool: any) => preferredSet.has(String(tool?.function?.name || "")));
        if (narrowed.length > 0) return narrowed;
        return toolList.slice(0, Math.min(6, toolList.length));
    }

    async getCompletion(messages: ChatMessage[], model: string, tools?: any[], onUpdate?: (content: string) => void, signal?: AbortSignal): Promise<ChatMessage> {
        let targetModel = model;
        if (this.settings.enableLocalLLM) {
            targetModel = this.settings.localLLMModel;
        }

        // 解析模型标识符，获取纯模型名和连接信息
        const resolved = this.resolveConnectionForModel(targetModel);
        const baseUrl = resolved?.baseUrl || this.getBaseUrl(targetModel);
        const apiKey = resolved?.apiKey ?? this.getApiKey(targetModel);
        // 使用纯模型名发送请求（不带 @connectionId）
        const actualModelName = resolved?.resolvedModel || this.parseModelIdentifier(targetModel).modelName;

        // Many OpenAI-compatible providers do NOT reliably stream tool_calls (name/arguments may be missing across chunks).
        // To keep agent/tool mode stable, we disable streaming whenever tools are present.
        const hasTools = !!(tools && tools.length > 0);
        const shouldStream = !!(this.settings.streamOutput && onUpdate && !hasTools);

        logger.info('AI', `Calling Chat Completion API. Model: ${actualModelName}, Stream: ${shouldStream}`);

        // IMPORTANT: Some OpenAI-compatible gateways are strict about message shapes.
        // Our internal ChatMessage contains extra fields (e.g. references/intermediateMessages/images),
        // which MUST NOT be sent upstream or it may 400.
        // Additionally, many gateways (e.g. qwen-max) only accept ONE system message; we merge multiples.
        const apiMessages = this.buildApiMessages(messages, hasTools, actualModelName);

        const requestBody: any = {
            model: actualModelName,
            messages: apiMessages,
            // temperature: this.settings.temperature, // Not in settings yet
            // max_tokens: this.settings.maxTokens, // Not in settings yet
            stream: shouldStream,
        };

        if (tools && tools.length > 0) {
            requestBody.tools = tools;
            requestBody.tool_choice = "auto";
        }

        const requestProfile = this.classifyRequestProfile(requestBody);
        logger.info('AI', 'Chat request profile', {
            model: actualModelName,
            stream: shouldStream,
            hasTools,
            toolCount: Array.isArray(requestBody.tools) ? requestBody.tools.length : 0,
            timeoutMs: requestProfile.timeoutMs,
            maxRetries: requestProfile.maxRetries,
            messageCount: apiMessages.length,
            isSimpleTask: requestProfile.isSimpleTask,
        });

        if (shouldStream && onUpdate) {
            return await this.handleStreamRequest(baseUrl, apiKey, requestBody, onUpdate, signal);
        } else {
            try {
                return await this.handleNormalRequest(baseUrl, apiKey, requestBody, signal, requestProfile);
            } catch (error: any) {
                const hasToolsInRequest = Array.isArray(requestBody.tools) && requestBody.tools.length > 0;
                const message = String(error?.message || "");
                const looksLikeToolSchema400 = hasToolsInRequest && /API Error: 400|tool|schema|Invalid schema|required|additionalProperties/i.test(message);
                if (!looksLikeToolSchema400) {
                    throw error;
                }

                const fallbackTools = this.buildFallbackTools(requestBody.tools);
                const fallbackNames = fallbackTools.map((tool: any) => String(tool?.function?.name || "")).filter(Boolean);
                const originalNames = requestBody.tools.map((tool: any) => String(tool?.function?.name || "")).filter(Boolean);
                if (fallbackTools.length === 0 || fallbackTools.length >= requestBody.tools.length) {
                    throw error;
                }

                logger.warn('AI', 'Retrying chat completion with narrowed tool set after tool schema rejection', {
                    model: actualModelName,
                    originalToolCount: originalNames.length,
                    fallbackToolCount: fallbackNames.length,
                    originalTools: originalNames,
                    fallbackTools: fallbackNames,
                    reason: message,
                });

                const fallbackRequestBody = {
                    ...requestBody,
                    tools: fallbackTools,
                    tool_choice: "auto",
                };
                return await this.handleNormalRequest(baseUrl, apiKey, fallbackRequestBody, signal, requestProfile);
            }
        }
    }

    private async handleNormalRequest(baseUrl: string, apiKey: string, body: any, signal?: AbortSignal, requestProfile?: { hasTools: boolean; isSimpleTask: boolean; timeoutMs: number; maxRetries: number }): Promise<ChatMessage> {
        // Check if already aborted
        if (signal?.aborted) {
            throw new Error("请求已被用户取消");
        }

        const url = `${baseUrl}/chat/completions`;
        const requestId = this.newRequestId("chat");
        const REQUEST_TIMEOUT = requestProfile?.timeoutMs ?? 120000;
        const maxRetries = requestProfile?.maxRetries ?? MAX_RETRIES;

        let lastError: Error | null = null;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            // Check abort before each attempt
            if (signal?.aborted) {
                throw new Error("请求已被用户取消");
            }

            const startedAt = Date.now();
            let timeoutId: ReturnType<typeof setTimeout> | null = null;

            try {
                // Use Obsidian's requestUrl for cross-platform compatibility.
                // Unlike fetch(), requestUrl bypasses CORS restrictions on mobile (Android/iOS WebView),
                // which is essential for APIs like Volcengine Ark that may not return CORS headers.
                // Add manual timeout since requestUrl doesn't support AbortSignal.
                const requestPromise = requestUrl({
                    url,
                    method: 'POST',
                    contentType: 'application/json',
                    headers: { 'Authorization': `Bearer ${apiKey}` },
                    body: JSON.stringify(body),
                });

                const timeoutPromise = new Promise<never>((_, reject) => {
                    timeoutId = setTimeout(() => {
                        reject(new Error(`请求超时 (${REQUEST_TIMEOUT / 1000}s)`));
                    }, REQUEST_TIMEOUT);
                });

                // Race against abort signal so user can cancel mid-flight
                const racers: Promise<any>[] = [requestPromise, timeoutPromise];
                if (signal) {
                    racers.push(new Promise<never>((_, reject) => {
                        if (signal.aborted) { reject(new Error("请求已被用户取消")); return; }
                        signal.addEventListener('abort', () => reject(new Error("请求已被用户取消")), { once: true });
                    }));
                }

                const response = await Promise.race(racers);
                if (timeoutId) clearTimeout(timeoutId);

                const durationMs = Date.now() - startedAt;
                const data = response.json;

                // Log cache metrics from DeepSeek context caching
                this.logCacheMetrics(data?.usage, requestId, data?.model);

                // Log success after retry
                if (attempt > 0) {
                    logger.info('AI', `Chat completion succeeded after ${attempt} retries`, { requestId, attempt, timeoutMs: REQUEST_TIMEOUT, maxRetries });
                }

                return data.choices[0].message;
            } catch (error: any) {
                // Clear timeout to prevent memory leak
                if (timeoutId) clearTimeout(timeoutId);

                // Check if aborted by user
                if (signal?.aborted) {
                    throw new Error("请求已被用户取消");
                }

                const durationMs = Date.now() - startedAt;

                // requestUrl throws with .status for HTTP errors
                const status = Number(error?.status ?? error?.response?.status ?? 0) || 0;

                // Check if we should retry (retryable HTTP status or network-level error)
                if ((attempt < maxRetries && shouldRetry(status, attempt)) || (attempt < maxRetries && !status)) {
                    const delay = getRetryDelay(attempt);
                    logger.warn('AI', `Chat completion failed, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries + 1})`, {
                        requestId,
                        url,
                        status: status || undefined,
                        errorName: error?.name,
                        errorMessage: error?.message,
                        attempt,
                    });
                    lastError = error;
                    await sleep(delay);
                    continue; // Retry
                }

                // Extract error details from requestUrl error object
                const errJson = error?.json ?? error?.response?.json;
                const errText = typeof error?.text === 'string'
                    ? error.text
                    : (typeof error?.response === 'string'
                        ? error.response
                        : (typeof error?.responseText === 'string'
                            ? error.responseText
                            : ""));
                const rawText = errText || (errJson ? this.safeJsonStringify(errJson, "") : "");
                const safeText = rawText ? this.truncateText(this.redactSecrets(rawText), 4000) : "";

                logger.error('AI', 'Chat completion request exception (normal)', {
                    requestId,
                    url,
                    durationMs,
                    status: status || undefined,
                    responseText: safeText || undefined,
                    errorName: error?.name,
                    errorMessage: error?.message,
                    stack: error?.stack,
                    request: this.buildChatRequestSummary(body),
                    attempt,
                });

                if (status && status >= 400) {
                    const err = this.classifyProviderError(status, errJson ?? safeText ?? error?.message);
                    err.message = `${err.message}\n(requestId=${requestId})`;
                    throw err;
                }

                throw error;
            }
        }

        // If we exhausted retries, throw the last error
        throw lastError || new Error(`请求失败，已重试 ${MAX_RETRIES} 次\n(requestId=${requestId})`);
    }

    private async handleStreamRequest(baseUrl: string, apiKey: string, body: any, onUpdate: (content: string) => void, signal?: AbortSignal): Promise<ChatMessage> {
        // Check if already aborted
        if (signal?.aborted) {
            throw new Error("请求已被用户取消");
        }

        const url = `${baseUrl}/chat/completions`;
        const requestId = this.newRequestId("chat_stream");
        const httpHint = this.getHttpHintForUrl(url);

        // Retry loop for initial connection only
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            if (signal?.aborted) {
                throw new Error("请求已被用户取消");
            }

            // Use a simple timeout for the initial connection only, but also respect external signal
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s connection timeout

            // Link external signal to our controller
            if (signal) {
                signal.addEventListener('abort', () => {
                    controller.abort();
                });
            }

            const startedAt = Date.now();

            // Keep track of any already-streamed text so we can avoid duplication if we fallback.
            let streamedContent = "";

            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`
                    },
                    body: JSON.stringify(body),
                    signal: controller.signal
                });

                clearTimeout(timeoutId);

                if (!response.ok) {
                    const errorText = await response.text();
                    const durationMs = Date.now() - startedAt;
                    const safeText = this.truncateText(this.redactSecrets(errorText || ""), 4000);
                    const status = response.status;

                    // Check if we should retry this error (only before streaming starts)
                    if (shouldRetry(status, attempt)) {
                        const delay = getRetryDelay(attempt);
                        logger.warn('AI', `Chat completion (stream) failed with ${status}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES + 1})`, {
                            requestId,
                            url,
                            status,
                            durationMs,
                            attempt,
                        });
                        await sleep(delay);
                        continue; // Retry
                    }

                    logger.error('AI', 'Chat completion failed (stream)', {
                        requestId,
                        url,
                        status,
                        durationMs,
                        responseText: safeText,
                        request: this.buildChatRequestSummary(body),
                        attempt,
                    });

                    const err = this.classifyProviderError(status, safeText);
                    err.message = `${err.message}\n(requestId=${requestId})`;
                    throw err;
                }

                if (!response.body) throw new Error("No response body");
                
                // Log success after retry
                if (attempt > 0) {
                    logger.info('AI', `Chat completion (stream) connected after ${attempt} retries`, { requestId, attempt });
                }

                // Once streaming starts, we can't retry - process the stream
                const reader = response.body.getReader();
                const decoder = new TextDecoder("utf-8");
                let fullContent = "";
                let fullReasoningContent = "";
                // Use Map to track tool_calls by index for correct parallel tool handling
                const toolCallsMap = new Map<number, { id: string; type: string; function: { name: string; arguments: string } }>();
                let buffer = "";
                let streamUsage: any = null;  // Track usage from stream for cache metrics

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || ""; // Keep the last partial line

                    for (const line of lines) {
                        const trimmedLine = line.trim();
                        if (!trimmedLine || trimmedLine === 'data: [DONE]') continue;
                        
                        if (trimmedLine.startsWith('data:')) {
                            try {
                                const jsonStr = trimmedLine.substring(5).trim();
                                if (!jsonStr) continue;

                                const data = JSON.parse(jsonStr);
                                
                                // Track usage for cache metrics (usually in final chunk)
                                if (data.usage) {
                                    streamUsage = data.usage;
                                }
                                
                                const delta = data.choices[0].delta;

                                if (delta.content) {
                                    fullContent += delta.content;
                                    streamedContent = fullContent;
                                    onUpdate(delta.content);
                                }

                                // DeepSeek reasoning models stream reasoning_content
                                if (delta.reasoning_content) {
                                    fullReasoningContent += delta.reasoning_content;
                                }

                                if (delta.tool_calls) {
                                    for (const tc of delta.tool_calls) {
                                        // Use index to track parallel tool calls correctly
                                        const idx = tc.index ?? 0;
                                        let toolCall = toolCallsMap.get(idx);
                                        
                                        if (!toolCall) {
                                            // Initialize new tool call entry
                                            toolCall = {
                                                id: tc.id || "",
                                                type: tc.type || "function",
                                                function: { name: "", arguments: "" }
                                            };
                                            toolCallsMap.set(idx, toolCall);
                                        }
                                        
                                        // Update id if provided (some providers send id in later chunks)
                                        if (tc.id && !toolCall.id) {
                                            toolCall.id = tc.id;
                                        }
                                        
                                        // Accumulate function name and arguments
                                        if (tc.function?.name) {
                                            toolCall.function.name = tc.function.name;
                                        }
                                        if (tc.function?.arguments) {
                                            toolCall.function.arguments += tc.function.arguments;
                                        }
                                    }
                                }
                            } catch (e) {
                                logger.warn("Network", "Error parsing stream chunk", { error: e, line: trimmedLine });
                            }
                        }
                    }
                }
                
                // Process any remaining buffer (in case the last line didn't have a newline)
                if (buffer.trim().startsWith('data:')) {
                     try {
                        const jsonStr = buffer.trim().substring(5).trim();
                        if (jsonStr && jsonStr !== '[DONE]') {
                            const data = JSON.parse(jsonStr);
                            const delta = data.choices[0].delta;
                            if (delta.content) {
                                fullContent += delta.content;
                                onUpdate(delta.content);
                            }
                        }
                     } catch (e) {
                         // Ignore incomplete JSON at the very end
                     }
                }
                
                // Convert toolCallsMap to sorted array by index
                const toolCalls = Array.from(toolCallsMap.entries())
                    .sort((a, b) => a[0] - b[0])
                    .map(([_, tc]) => tc);

                const result: ChatMessage = {
                    role: 'assistant',
                    content: fullContent
                };

                if (toolCalls.length > 0) {
                    result.tool_calls = toolCalls;
                }

                // DeepSeek reasoning models return reasoning_content
                if (fullReasoningContent) {
                    result.reasoning_content = fullReasoningContent;
                }

                // Log cache metrics from stream
                this.logCacheMetrics(streamUsage, requestId, body?.model);

                return result;
            } catch (error: any) {
                clearTimeout(timeoutId);

                if (error.name === 'AbortError') {
                    if (signal?.aborted) {
                        throw new Error("请求已被用户取消");
                    }
                    const hint = httpHint ? `\n\n提示：${httpHint}` : "";
                    throw new Error(`API 连接超时，请检查网络。\n(requestId=${requestId})${hint}`);
                }

                const errorName = error?.name;
                const errorMessage = String(error?.message || "");
                // Detect network-level fetch failures across platforms:
                // Chrome/Android: "Failed to fetch", Firefox: "NetworkError", Safari/iOS: "Load failed"
                const isNetworkTypeError = errorName === 'TypeError' && 
                    (/network\s*error|failed\s*to\s*fetch|load\s*failed/i.test(errorMessage));

                // Check if we should retry network errors (only before streaming starts)
                if (attempt < MAX_RETRIES && isNetworkTypeError) {
                    const delay = getRetryDelay(attempt);
                    logger.warn('AI', `Chat completion (stream) network error, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES + 1})`, {
                        requestId,
                        url,
                        errorName,
                        errorMessage,
                        attempt,
                    });
                    await sleep(delay);
                    continue; // Retry
                }

                // If fetch() itself is blocked (CORS on mobile, etc.), fall back to non-streaming via requestUrl
                if (isNetworkTypeError) {
                    logger.warn('AI', 'Streaming fetch unavailable (likely CORS/mobile), falling back to non-streaming via requestUrl', {
                        requestId, url, errorName, errorMessage,
                    });
                    try {
                        const nonStreamBody = { ...body, stream: false };
                        const result = await this.handleNormalRequest(baseUrl, apiKey, nonStreamBody, signal);
                        if (result.content && onUpdate) {
                            onUpdate(result.content);
                        }
                        return result;
                    } catch (fallbackError: any) {
                        logger.error('AI', 'Non-streaming fallback also failed', {
                            requestId, url, errorMessage: fallbackError?.message,
                        });
                        throw fallbackError;
                    }
                }

                // If already classified error, just throw it
                if (error.message?.includes('requestId=')) {
                    throw error;
                }

                throw error;
            }
        }

        // If we exhausted retries, throw generic error
        throw new Error(`请求失败，已重试 ${MAX_RETRIES} 次\n(requestId=${requestId})`);
    }
}
