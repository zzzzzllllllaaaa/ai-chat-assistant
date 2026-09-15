/**
 * Agent v2 — Skill 优先架构的类型定义
 */
import type { ChatMessage } from "../../core/types";
import type { Tool, ToolDefinition } from "../agent/types";
import type { Skill } from "../skills/types";

/** Agent v2 执行选项 */
export interface AgentV2Options {
  /** 可用工具列表 (默认从 ctx 获取) */
  tools?: Tool[];
  /** 是否启用工具调用循环 (默认 true) */
  enableToolLoop?: boolean;
  /** 最大工具调用轮次 (默认 5) */
  maxToolRounds?: number;
  /** 中止信号 */
  signal?: AbortSignal;
  /** 流式输出回调 */
  onToken?: (token: string) => void;
  /** 工具调用回调 */
  onToolCall?: (toolName: string, args: any) => void;
  /** 工具结果回调 */
  onToolResult?: (toolName: string, result: string) => void;
}

/** Agent v2 执行结果 */
export interface AgentV2Result {
  /** 最终回复内容 */
  content: string;
  /** 是否成功 */
  success: boolean;
  /** 错误信息 */
  error?: string;
  /** 工具调用记录 */
  toolCalls: Array<{
    name: string;
    args: any;
    result: string;
    success: boolean;
  }>;
}

/** 技能路由结果 */
export interface SkillRoute {
  skill: Skill;
  /** 剥离 @mention 后的用户查询 */
  userQuery: string;
  /** 技能类型 */
  type: 'search' | 'code' | 'writing' | 'general';
}

/** 构建给 LLM 的 messages，将工具定义转为 OpenAI function calling 格式 */
export function buildToolDefinitions(tools: Tool[]): any[] {
  return tools.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.definition.name,
      description: tool.definition.description,
      parameters: tool.definition.parameters,
    },
  }));
}
