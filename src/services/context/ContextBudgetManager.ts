import type { ChatMessage } from "../../core/types";
import { estimateTokensFromMessages, estimateTokensFromText, formatTokenCountCompact } from "../../core/tokenEstimate";

export type ContextBlockPriority = "critical" | "high" | "medium" | "low";

export interface ContextBlock {
  key: string;
  content: string;
  priority: ContextBlockPriority;
  maxTokens?: number;
  minTokens?: number;
  compressible?: boolean;
  /** 标记为 true 的块内容稳定不变，应放在最前面作为缓存前缀锚点 */
  cacheAnchor?: boolean;
}

export interface ContextBudgetDiagnostics {
  budgetTokens: number;
  usedTokens: number;
  systemTokens: number;
  historyTokens: number;
  userTokens: number;
  keptBlocks: string[];
  droppedBlocks: string[];
  trimmedBlocks: string[];
  keptHistoryMessages: number;
  droppedHistoryMessages: number;
  trimmedUserContext: boolean;
  omittedLoopMessages: number;
}

export interface ComposeAgentInputParams {
  budgetTokens: number;
  systemBlocks: ContextBlock[];
  history: ChatMessage[];
  userInput: string;
  userContext?: string;
  images?: string[];
  preserveTailPatterns?: RegExp[];
}

export interface ComposeAgentInputResult {
  systemPrompt: string;
  /** 稳定的系统提示词（缓存锚定部分），为空时使用 systemPrompt */
  stableSystemPrompt?: string;
  /** 动态的系统提示词部分，为空时不追加 */
  dynamicSystemPrompt?: string;
  history: ChatMessage[];
  userMessage: ChatMessage;
  diagnostics: ContextBudgetDiagnostics;
}

export interface FitMessagesOptions {
  pinnedHeadCount?: number;
  pinnedTailCount?: number;
  maxSingleMessageTokens?: number;
  summaryLabel?: string;
  preserveTailPatterns?: RegExp[];
}

export interface FitMessagesResult {
  messages: ChatMessage[];
  diagnostics: Pick<ContextBudgetDiagnostics, "budgetTokens" | "usedTokens" | "omittedLoopMessages" | "trimmedBlocks">;
}

const PRIORITY_WEIGHT: Record<ContextBlockPriority, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export class ContextBudgetManager {
  public composeAgentInput(params: ComposeAgentInputParams): ComposeAgentInputResult {
    const budgetTokens = Math.max(2000, Math.floor(params.budgetTokens || 12000));
    const systemTarget = Math.max(1200, Math.floor(budgetTokens * 0.52));
    const systemMax = Math.max(systemTarget, Math.floor(budgetTokens * 0.7));
    const userTarget = Math.max(400, Math.floor(budgetTokens * 0.18));

    const systemResult = this.buildSystemPrompt(params.systemBlocks, systemTarget, systemMax);

    // 分离稳定块和动态块（用于 DeepSeek 缓存优化）
    const stableBlocks = params.systemBlocks.filter(b => b.cacheAnchor);
    const dynamicBlocks = params.systemBlocks.filter(b => !b.cacheAnchor);
    const stableResult = stableBlocks.length > 0
      ? this.buildSystemPrompt(stableBlocks, Math.max(400, Math.floor(systemTarget * 0.55)), Math.floor(systemMax * 0.65))
      : null;

    const userResult = this.buildUserMessage(params.userInput, params.userContext, userTarget, params.images);

    const remainingForHistory = Math.max(0, budgetTokens - systemResult.tokens - userResult.tokens);
    const historyResult = this.fitHistory(params.history, remainingForHistory, params.preserveTailPatterns);

    const diagnostics: ContextBudgetDiagnostics = {
      budgetTokens,
      usedTokens: systemResult.tokens + userResult.tokens + historyResult.tokens,
      systemTokens: systemResult.tokens,
      historyTokens: historyResult.tokens,
      userTokens: userResult.tokens,
      keptBlocks: systemResult.keptBlocks,
      droppedBlocks: systemResult.droppedBlocks,
      trimmedBlocks: [...systemResult.trimmedBlocks, ...historyResult.trimmedBlocks],
      keptHistoryMessages: historyResult.messages.length,
      droppedHistoryMessages: Math.max(0, params.history.length - historyResult.messages.length),
      trimmedUserContext: userResult.trimmed,
      omittedLoopMessages: 0,
    };

    return {
      systemPrompt: systemResult.prompt,
      stableSystemPrompt: stableResult?.prompt || undefined,
      history: historyResult.messages,
      userMessage: userResult.message,
      diagnostics,
    };
  }

  public fitMessages(messages: ChatMessage[], budgetTokens: number, options?: FitMessagesOptions): FitMessagesResult {
    const budget = Math.max(1000, Math.floor(budgetTokens || 6000));
    const pinnedHeadCount = Math.max(0, options?.pinnedHeadCount ?? 1);
    const pinnedTailCount = Math.max(1, options?.pinnedTailCount ?? 8);
    const maxSingleMessageTokens = Math.max(120, options?.maxSingleMessageTokens ?? 1200);
    const preserveTailPatterns = options?.preserveTailPatterns ?? [];

    const head = messages.slice(0, pinnedHeadCount).map(msg => this.trimMessage(msg, maxSingleMessageTokens));
    const middle = messages.slice(pinnedHeadCount);
    const tailPinnedIndexes = new Set<number>();
    for (let i = middle.length - 1; i >= 0; i--) {
      const content = typeof middle[i]?.content === "string" ? middle[i].content || "" : "";
      if (preserveTailPatterns.some(pattern => pattern.test(content))) {
        tailPinnedIndexes.add(i);
      }
    }
    const keptTail: ChatMessage[] = [];

    for (let i = middle.length - 1; i >= 0; i--) {
      const trimmed = this.trimMessage(middle[i], maxSingleMessageTokens);
      const projected = estimateTokensFromMessages([...head, ...keptTail, trimmed]);
      const mustKeep = keptTail.length < pinnedTailCount || tailPinnedIndexes.has(i);
      if (mustKeep || projected <= budget) {
        keptTail.unshift(trimmed);
        continue;
      }
      break;
    }

    const omitted = Math.max(0, middle.length - keptTail.length);
    const summary = omitted > 0
      ? [{ role: "system" as const, content: `[ContextBudget] 已省略较早的 ${omitted} 条中间消息（${options?.summaryLabel || "loop"}），请优先依据最新消息、最新验证结果、最近修复状态与最新工具结果继续执行。` }]
      : [];

    let finalMessages = [...head, ...summary, ...keptTail];
    while (estimateTokensFromMessages(finalMessages) > budget && keptTail.length > 1) {
      const removableIndex = keptTail.findIndex(msg => {
        const content = typeof msg?.content === "string" ? msg.content || "" : "";
        return !preserveTailPatterns.some(pattern => pattern.test(content));
      });
      if (removableIndex === -1) break;
      keptTail.splice(removableIndex, 1);
      finalMessages = [...head, ...summary, ...keptTail];
    }

    return {
      messages: finalMessages,
      diagnostics: {
        budgetTokens: budget,
        usedTokens: estimateTokensFromMessages(finalMessages),
        omittedLoopMessages: omitted,
        trimmedBlocks: messages.length === finalMessages.length ? [] : ["loop-messages"],
      },
    };
  }

  public trimTextToTokenBudget(text: string, budgetTokens: number, label?: string): { text: string; trimmed: boolean; tokens: number } {
    const normalized = String(text || "").trim();
    if (!normalized) return { text: "", trimmed: false, tokens: 0 };

    const budget = Math.max(80, Math.floor(budgetTokens || 200));
    const currentTokens = estimateTokensFromText(normalized);
    if (currentTokens <= budget) {
      return { text: normalized, trimmed: false, tokens: currentTokens };
    }

    const headChars = Math.max(120, Math.floor(budget * 2.2));
    const tailChars = Math.max(80, Math.floor(budget * 1.1));
    const head = normalized.slice(0, headChars).trim();
    const tail = normalized.slice(-tailChars).trim();
    const prefix = label ? `[${label} 已裁剪]\n` : "[内容已裁剪]\n";
    const compact = `${prefix}${head}\n…\n${tail}`;
    return {
      text: compact,
      trimmed: true,
      tokens: estimateTokensFromText(compact),
    };
  }

  public getShortStatus(diagnostics: Pick<ContextBudgetDiagnostics, "budgetTokens" | "usedTokens" | "droppedBlocks" | "trimmedBlocks" | "droppedHistoryMessages" | "trimmedUserContext">): string {
    const parts = [`预算=${formatTokenCountCompact(diagnostics.budgetTokens)}`, `已用=${formatTokenCountCompact(diagnostics.usedTokens)}`];
    if (diagnostics.trimmedBlocks.length > 0) parts.push(`裁剪=${diagnostics.trimmedBlocks.join(",")}`);
    if (diagnostics.droppedBlocks.length > 0) parts.push(`丢弃=${diagnostics.droppedBlocks.join(",")}`);
    if (diagnostics.droppedHistoryMessages > 0) parts.push(`历史-${diagnostics.droppedHistoryMessages}`);
    if (diagnostics.trimmedUserContext) parts.push("用户上下文已裁剪");
    return parts.join("；");
  }

  private buildSystemPrompt(blocks: ContextBlock[], targetTokens: number, maxTokens: number): { prompt: string; tokens: number; keptBlocks: string[]; droppedBlocks: string[]; trimmedBlocks: string[] } {
    const keptBlocks: string[] = [];
    const droppedBlocks: string[] = [];
    const trimmedBlocks: string[] = [];
    const selected: string[] = [];
    let usedTokens = 0;

    for (const block of blocks) {
      const raw = String(block.content || "").trim();
      if (!raw) continue;

      const blockTokens = estimateTokensFromText(raw);
      const hardLimit = Math.min(maxTokens, Math.max(targetTokens, usedTokens + Math.max(block.minTokens || 0, 0)));
      const remaining = Math.max(0, hardLimit - usedTokens);

      if (blockTokens <= remaining) {
        selected.push(raw);
        keptBlocks.push(block.key);
        usedTokens += blockTokens;
        continue;
      }

      const priorityWeight = PRIORITY_WEIGHT[block.priority] || 1;
      const shouldTryTrim = block.compressible !== false && remaining >= Math.max(80, block.minTokens || 0) && priorityWeight >= 2;
      if (shouldTryTrim) {
        const trimLimit = Math.min(block.maxTokens || remaining, remaining);
        const trimmed = this.trimTextToTokenBudget(raw, trimLimit, block.key);
        if (trimmed.text) {
          selected.push(trimmed.text);
          keptBlocks.push(block.key);
          trimmedBlocks.push(block.key);
          usedTokens += trimmed.tokens;
          continue;
        }
      }

      if (block.priority === "critical" && usedTokens < maxTokens) {
        const forceBudget = Math.min(block.maxTokens || (maxTokens - usedTokens), maxTokens - usedTokens);
        const forced = this.trimTextToTokenBudget(raw, forceBudget, block.key);
        if (forced.text) {
          selected.push(forced.text);
          keptBlocks.push(block.key);
          trimmedBlocks.push(block.key);
          usedTokens += forced.tokens;
          continue;
        }
      }

      droppedBlocks.push(block.key);
    }

    const prompt = selected.join("\n\n");
    return { prompt, tokens: estimateTokensFromText(prompt), keptBlocks, droppedBlocks, trimmedBlocks };
  }

  private buildUserMessage(userInput: string, userContext: string | undefined, targetTokens: number, images?: string[]): { message: ChatMessage; tokens: number; trimmed: boolean } {
    const cleanUserInput = String(userInput || "").trim();
    const cleanContext = String(userContext || "").trim();
    if (!cleanContext) {
      const content = cleanUserInput;
      return {
        message: { role: "user", content, images },
        tokens: estimateTokensFromText(content),
        trimmed: false,
      };
    }

    const inputTokens = estimateTokensFromText(cleanUserInput);
    const contextBudget = Math.max(120, targetTokens - inputTokens - 40);
    const trimmedContext = this.trimTextToTokenBudget(cleanContext, contextBudget, "用户参考上下文");
    const content = `请参考以下上下文信息:\n${trimmedContext.text}\n\n---\n${cleanUserInput}`;
    return {
      message: { role: "user", content, images },
      tokens: estimateTokensFromText(content),
      trimmed: trimmedContext.trimmed,
    };
  }

  private fitHistory(history: ChatMessage[], budgetTokens: number, preserveTailPatterns: RegExp[] = []): { messages: ChatMessage[]; tokens: number; trimmedBlocks: string[] } {
    if (!Array.isArray(history) || history.length === 0 || budgetTokens <= 0) {
      return { messages: [], tokens: 0, trimmedBlocks: [] };
    }

    const reversed = [...history].reverse();
    const kept: ChatMessage[] = [];
    const trimmedBlocks: string[] = [];

    for (const msg of reversed) {
      const trimmed = this.trimMessage(msg, Math.max(120, Math.floor(budgetTokens * 0.45)));
      const projected = estimateTokensFromMessages([...kept, trimmed]);
      const content = typeof trimmed?.content === "string" ? trimmed.content || "" : "";
      const mustKeep = preserveTailPatterns.some(pattern => pattern.test(content));
      if (kept.length === 0 || projected <= budgetTokens || mustKeep) {
        kept.push(trimmed);
        continue;
      }
      break;
    }

    const messages = kept.reverse();
    if (messages.length < history.length) {
      trimmedBlocks.push("history");
    }
    return {
      messages,
      tokens: estimateTokensFromMessages(messages),
      trimmedBlocks,
    };
  }

  private trimMessage(message: ChatMessage, maxTokens: number): ChatMessage {
    const content = typeof message.content === "string" ? message.content : "";
    const trimmed = this.trimTextToTokenBudget(content, maxTokens, message.role === "tool" ? `tool:${message.name || "unknown"}` : message.role);
    if (!trimmed.trimmed) return message;
    return {
      ...message,
      content: trimmed.text,
    };
  }
}