/**
 * ToolEquippedLLM — 带工具执行循环的 LLM 调用
 * 
 * 每次 LLM 调用都带上工具定义，LLM 可以返回 function_call。
 * 自动执行工具并将结果反馈给 LLM，直到 LLM 返回最终文本。
 */
import type { App } from "obsidian";
import type { ChatMessage } from "../../core/types";
import type { Tool } from "../agent/types";
import type { LLMService } from "../../services/llm/LLMService";
import { buildToolDefinitions, type AgentV2Options } from "./types";
import { logger } from "../../core/logger";

export class ToolEquippedLLM {
  private llmService: LLMService;
  private app: App;
  private tools: Tool[];
  private toolDefs: any[];
  private maxRounds: number;

  constructor(
    llmService: LLMService,
    app: App,
    tools: Tool[],
    maxRounds: number = 5
  ) {
    this.llmService = llmService;
    this.app = app;
    this.tools = tools;
    this.toolDefs = buildToolDefinitions(tools);
    this.maxRounds = maxRounds;
  }

  /**
   * 执行带工具的 LLM 对话
   * 支持多轮 function calling 循环
   */
  async chat(
    messages: ChatMessage[],
    model: string,
    opts: AgentV2Options = {}
  ): Promise<string> {
    const signal = opts.signal;
    let rounds = 0;
    let finalContent = "";

    while (rounds < this.maxRounds) {
      // 检查中止
      if (signal?.aborted) throw new Error("已中止");

      rounds++;
      logger.debug("AI", `LLM 调用 (第 ${rounds} 轮)`, {
        messageCount: messages.length,
        toolCount: this.toolDefs.length,
      });

      // 调用 LLM，带上工具定义
      const response = await this.llmService.getCompletion(
        messages,
        model,
        this.toolDefs,
        opts.onToken,
        signal
      );

      // 检查是否有 function call
      const toolCalls = (response as any)?.tool_calls;
      const hasToolCall = Array.isArray(toolCalls) && toolCalls.length > 0;

      if (!hasToolCall) {
        // 没有工具调用 → LLM 返回最终文本
        finalContent = response.content || "";
        break;
      }

      // 有工具调用 → 执行工具 + 将结果加入 messages
      const assistantMsg: any = {
        role: "assistant",
        content: response.content || null,
        tool_calls: toolCalls,
      };
      messages.push(assistantMsg);

      for (const tc of toolCalls) {
        const fnName = tc?.function?.name || "";
        const fnArgs = this.safeParseJSON(tc?.function?.arguments || "{}");

        opts.onToolCall?.(fnName, fnArgs);

        const tool = this.tools.find(t => t.definition.name === fnName);
        let result: string;

        if (tool) {
          try {
            result = await tool.execute(fnArgs, this.app);
            opts.onToolResult?.(fnName, result);
            logger.info("AI", `工具执行成功: ${fnName}`);
          } catch (e: any) {
            result = `工具执行失败: ${e.message}`;
            opts.onToolResult?.(fnName, result);
            logger.warn("AI", `工具执行失败: ${fnName}`, { error: e.message });
          }
        } else {
          result = `错误: 未找到工具 "${fnName}"。可用工具: ${this.tools.map(t => t.definition.name).join(", ")}`;
        }

        messages.push({
          role: "tool",
          tool_call_id: tc.id || String(Date.now()),
          content: result,
        } as any);
      }
    }

    if (!finalContent && rounds >= this.maxRounds) {
      finalContent = "已达到最大工具调用轮次，对话终止。";
    }

    return finalContent;
  }

  private safeParseJSON(str: string): any {
    try {
      return JSON.parse(str);
    } catch {
      return {};
    }
  }
}
