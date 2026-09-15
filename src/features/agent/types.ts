import { App } from "obsidian";

export interface ToolParameter {
  type: string;
  description: string;
  enum?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  capabilityTags?: string[];
  riskLevel?: "low" | "medium" | "high";
  requiresConfirmation?: boolean;
  requiresPrefetch?: boolean;
  /** 当该工具执行失败时，建议优先使用哪些工具进行修复 */
  repairHint?: string[];
  parameters: {
    type: "object";
    properties: Record<string, any>;
    required: string[];
  };
}

export interface Tool {
  definition: ToolDefinition;
  execute: (args: any, app: App) => Promise<string>;
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[]; // List of tool names
  model?: string;
  mbti?: string; // MBTI personality type
  isPreset?: boolean; // 是否为预设智能体（可通过设置标记为可删除）
  greeting?: string; // 智能体开场白
}
