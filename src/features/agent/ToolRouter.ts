import type { SearchPlannerResult } from "./SearchPlanner";
import type { ExecutionPhase } from "./ExecutionSession";
import type { LearnedToolSignal } from "./SearchEvidenceBuilder";
import type { ToolDefinition } from "./types";
import { getAllowedToolsForMode } from "./ToolPolicy";

export type ToolRiskLevel = "low" | "medium" | "high";
export type ToolCapabilityTag = "read" | "write" | "search" | "network" | "exec" | "canvas" | "metadata" | "todo";

export interface ToolProfile {
  name: string;
  capabilityTags: ToolCapabilityTag[];
  riskLevel: ToolRiskLevel;
  requiresConfirmation?: boolean;
  requiresPrefetch?: boolean;
}

export interface ToolRoutingInput {
  toolNames: string[];
  planner: SearchPlannerResult;
  preferredStartTools?: string[];
  learnedToolSignals?: LearnedToolSignal[];
  ragReady?: boolean;
  isCustomAgent?: boolean;
}

export interface ToolRoutingDecision {
  allowedToolNames: string[];
  prioritizedToolNames: string[];
  blockedToolNames: string[];
  firstRoundToolNames: string[];
  learnedToolSignals: LearnedToolSignal[];
  reasoning: string[];
  riskSummary: string;
}

const DEFAULT_TOOL_PROFILES: Record<string, ToolProfile> = {
  read_note: { name: "read_note", capabilityTags: ["read"], riskLevel: "low" },
  get_note_structure: { name: "get_note_structure", capabilityTags: ["read", "metadata"], riskLevel: "low", requiresPrefetch: true },
  list_files: { name: "list_files", capabilityTags: ["read", "search"], riskLevel: "low" },
  search_notes: { name: "search_notes", capabilityTags: ["search", "read"], riskLevel: "low" },
  vector_search: { name: "vector_search", capabilityTags: ["search", "read"], riskLevel: "low" },
  knowledge_base_query: { name: "knowledge_base_query", capabilityTags: ["search", "read"], riskLevel: "low" },
  get_recent_notes: { name: "get_recent_notes", capabilityTags: ["read", "search"], riskLevel: "low" },
  get_backlinks: { name: "get_backlinks", capabilityTags: ["read", "metadata"], riskLevel: "low" },
  explore_note_links: { name: "explore_note_links", capabilityTags: ["read", "search", "metadata"], riskLevel: "low" },
  find_note_relationships: { name: "find_note_relationships", capabilityTags: ["read", "search", "metadata"], riskLevel: "low" },

  replace_in_note: { name: "replace_in_note", capabilityTags: ["write"], riskLevel: "medium", requiresPrefetch: true },
  modify_note: { name: "modify_note", capabilityTags: ["write"], riskLevel: "medium", requiresPrefetch: true },
  append_to_note: { name: "append_to_note", capabilityTags: ["write"], riskLevel: "medium", requiresPrefetch: true },
  create_note: { name: "create_note", capabilityTags: ["write"], riskLevel: "medium" },
  create_folder: { name: "create_folder", capabilityTags: ["write"], riskLevel: "medium" },
  move_item: { name: "move_item", capabilityTags: ["write"], riskLevel: "medium", requiresPrefetch: true },
  delete_file: { name: "delete_file", capabilityTags: ["write"], riskLevel: "high", requiresConfirmation: true, requiresPrefetch: true },
  update_properties: { name: "update_properties", capabilityTags: ["write", "metadata"], riskLevel: "medium", requiresPrefetch: true },
  get_properties: { name: "get_properties", capabilityTags: ["read", "metadata"], riskLevel: "low" },

  read_canvas: { name: "read_canvas", capabilityTags: ["read", "canvas"], riskLevel: "low" },
  create_canvas: { name: "create_canvas", capabilityTags: ["write", "canvas"], riskLevel: "medium" },
  create_canvas_mindmap: { name: "create_canvas_mindmap", capabilityTags: ["write", "canvas"], riskLevel: "medium" },
  modify_canvas: { name: "modify_canvas", capabilityTags: ["write", "canvas"], riskLevel: "medium", requiresPrefetch: true },

  mcp_list_tools: { name: "mcp_list_tools", capabilityTags: ["network", "metadata"], riskLevel: "low" },
  mcp_call_tool: { name: "mcp_call_tool", capabilityTags: ["network"], riskLevel: "high", requiresConfirmation: true },
  read_webpage: { name: "read_webpage", capabilityTags: ["network", "read"], riskLevel: "medium" },
  web_search: { name: "web_search", capabilityTags: ["network", "search"], riskLevel: "medium" },

  list_commands: { name: "list_commands", capabilityTags: ["exec", "metadata"], riskLevel: "medium" },
  execute_command: { name: "execute_command", capabilityTags: ["exec"], riskLevel: "high", requiresConfirmation: true },

  manage_todo_list: { name: "manage_todo_list", capabilityTags: ["todo", "metadata"], riskLevel: "low" },

  find_symbol: { name: "find_symbol", capabilityTags: ["read", "search", "metadata"], riskLevel: "low" },
  find_references: { name: "find_references", capabilityTags: ["read", "search", "metadata"], riskLevel: "low" },
  list_code_dependencies: { name: "list_code_dependencies", capabilityTags: ["read", "metadata", "search"], riskLevel: "low" },
  read_code_region: { name: "read_code_region", capabilityTags: ["read", "metadata"], riskLevel: "low" },
};

const TOOL_SETS = {
  note_execution: [
    "read_note", "get_note_structure", "list_files", "search_notes", "get_recent_notes", "knowledge_base_query", "vector_search",
    "create_note", "modify_note", "replace_in_note", "append_to_note", "move_item", "delete_file", "create_folder",
    "get_properties", "update_properties", "manage_todo_list", "explore_note_links", "find_note_relationships"
  ],
  code_execution: [
    "read_note", "list_files", "search_notes", "read_code_region", "find_symbol", "find_references", "list_code_dependencies",
    "modify_note", "replace_in_note", "append_to_note", "execute_command", "list_commands"
  ],
  deep_research: [
    "read_note", "search_notes", "knowledge_base_query", "vector_search", "web_search", "read_webpage",
    "mcp_list_tools", "mcp_call_tool", "create_note", "append_to_note"
  ],
  canvas_collaboration: [
    "read_canvas", "create_canvas", "modify_canvas", "create_canvas_mindmap",
    "read_note", "search_notes", "knowledge_base_query", "vector_search"
  ]
};

export class ToolRouter {
  private dynamicProfiles = new Map<string, ToolProfile>();

  public registerToolDefinitions(defs: ToolDefinition[]): void {
    this.dynamicProfiles.clear();
    for (const def of defs) {
      if (DEFAULT_TOOL_PROFILES[def.name]) continue;
      const tags = (def.capabilityTags || []) as ToolCapabilityTag[];
      const risk = def.riskLevel || "medium";
      this.dynamicProfiles.set(def.name, {
        name: def.name,
        capabilityTags: tags.length > 0 ? tags : ["read"],
        riskLevel: risk,
        requiresConfirmation: def.requiresConfirmation,
        requiresPrefetch: def.requiresPrefetch,
      });
    }
  }

  public route(input: ToolRoutingInput): ToolRoutingDecision {
    const ragReady = Boolean((input as any)?.plugin?.ragService?.isReady?.()) || Boolean((input as any)?.ragReady);
    const initialAvailable = Array.from(new Set((input.toolNames || []).filter(name => {
      if (ragReady) return true;
      return name !== 'knowledge_base_query' && name !== 'vector_search';
    })));

    const reasoning: string[] = [];
    const mode = input.planner.executionMode;
    const intent = input.planner.intent;
    
    let allow = new Set<string>();

    if (input.planner.isChitchat) {
      reasoning.push('纯闲聊问候：为防止 LLM 强行寻找话题，收起所有工具。');
    } else {
      let selectedSet = TOOL_SETS.note_execution;
      let setName = '默认笔记执行集合';

      if (intent === 'code') {
        selectedSet = TOOL_SETS.code_execution;
        setName = '默认代码执行集合';
      } else if (mode === 'deep' || intent === 'web') {
        selectedSet = TOOL_SETS.deep_research;
        setName = '深度研究集合';
      } else if (intent === 'canvas') {
        selectedSet = TOOL_SETS.canvas_collaboration;
        setName = '高级协作集合（白板）';
      }

      reasoning.push(`基于意图 [${intent}] 与模式 [${mode}] 切换至: ${setName}`);

      // Intersect with initialAvailable to ensure we don't allow tools not configured for the agent
      const initialSet = new Set(initialAvailable);
      for (const t of selectedSet) {
        if (initialSet.has(t)) {
          allow.add(t);
        }
      }

      // Add extra allowed tools based on mode policy for backward compatibility and flexibility
      const allowedByMode = getAllowedToolsForMode(mode, initialAvailable);
      for (const t of allowedByMode) {
        allow.add(t);
      }

      // 修复: 如果是用户自定义的智能体（非预设），则默认不进行基于 intent 的工具裁剪，
      // 以免用户显式为该角色绑定的工具被意外过滤掉。
      if (input.isCustomAgent) {
        reasoning.push('检测到用户自定义智能体，保留其所有已绑定工具。');
        for (const t of initialAvailable) {
          allow.add(t);
        }
      }
    }

    if (!ragReady && (initialAvailable.includes('knowledge_base_query') || initialAvailable.includes('vector_search'))) {
      reasoning.push('知识库索引未就绪：已移除知识库相关搜索工具。');
      allow.delete('knowledge_base_query');
      allow.delete('vector_search');
    }

    if (input.planner.shouldInspectBeforeWrite) {
      reasoning.push('写入前检查规则已启用：建议优先使用结构/读取工具。');
    }

    const blocked = new Set<string>();
    for (const name of initialAvailable) {
      if (!allow.has(name)) blocked.add(name);
    }

    const firstRoundToolNames = (input.preferredStartTools || []).filter(name => allow.has(name));
    const learnedToolSignals = (input.learnedToolSignals || []).filter(signal => allow.has(signal.toolName)).slice(0, 8);
    
    if (firstRoundToolNames.length > 0) {
      reasoning.push(`首轮工具提示已启用：${firstRoundToolNames.join(', ')}`);
    }
    if (learnedToolSignals.length > 0) {
      reasoning.push(`搜索证据学习到的排序线索：${learnedToolSignals.slice(0, 3).map(signal => `${signal.toolName}(${signal.score})`).join(', ')}`);
    }

    const prioritizedToolNames = this.prioritize(Array.from(allow), input.planner, firstRoundToolNames, learnedToolSignals);
    const riskSummary = this.summarizeRisk(prioritizedToolNames);

    return {
      allowedToolNames: prioritizedToolNames,
      prioritizedToolNames,
      blockedToolNames: Array.from(blocked),
      firstRoundToolNames,
      learnedToolSignals,
      reasoning,
      riskSummary,
    };
  }

    public formatForPrompt(decision: ToolRoutingDecision): string {
    const lines: string[] = [];
    lines.push("【ToolRouter 约束】");
    lines.push(`- 当前允许工具: ${decision.allowedToolNames.join(", ") || "无（工具列表为空，绝对不可调用工具！）"}`);
    if (decision.allowedToolNames.length > 0 && decision.blockedToolNames.length > 0) {
      // 只有在还有其他工具可用时，才展示被收起的工具。如果是纯聊天（全部收起），则不要展示，防止大模型尝试强行使用
      lines.push(`- 已暂时收起工具: ${decision.blockedToolNames.join(", ")}`);
    }
    if (decision.reasoning.length > 0) {
      lines.push(`- 路由依据: ${decision.reasoning.join("；")}`);
    }
    if (decision.firstRoundToolNames.length > 0) {
      lines.push(`- 首轮优先工具: ${decision.firstRoundToolNames.join(", ")}`);
    }
    if (decision.learnedToolSignals.length > 0) {
      lines.push(`- 搜索子代理学习排序: ${decision.learnedToolSignals.slice(0, 4).map(signal => `${signal.toolName}(${signal.score})`).join(", ")}`);
    }
    lines.push(`- 风险概览: ${decision.riskSummary}`);
    lines.push("- 执行要求: 先在当前允许工具内完成任务；若确实缺少关键工具，再明确说明缺口，不要跳出约束随意调用。");
    return lines.join("\n");
  }

  public getShortStatus(decision: ToolRoutingDecision): string {
    const visible = decision.firstRoundToolNames.slice(0, 3).join(", ") || decision.allowedToolNames.slice(0, 4).join(", ") || "无";
    return `工具=${decision.allowedToolNames.length}；优先=${visible}`;
  }

  public filterByPhase(toolNames: string[], phase: ExecutionPhase): string[] {
    const names = Array.from(new Set(toolNames || []));
    switch (phase) {
      case "inspect":
        return names.filter(name => {
          const profile = this.getProfile(name);
          if (profile.riskLevel === "high") return false;
          return profile.capabilityTags.some(tag => ["read", "search", "metadata", "todo", "canvas"].includes(tag));
        });
      case "repair":
        return names.filter(name => {
          const profile = this.getProfile(name);
          return profile.capabilityTags.some(tag => ["read", "search", "metadata", "write", "canvas", "todo"].includes(tag));
        });
      case "answer":
        return [];
      case "act":
      default:
        return names;
    }
  }

  public getProfile(toolName: string): ToolProfile {
    return DEFAULT_TOOL_PROFILES[toolName]
      || this.dynamicProfiles.get(toolName)
      || { name: toolName, capabilityTags: ["read"], riskLevel: "medium" };
  }

  private prioritize(
    toolNames: string[],
    planner: SearchPlannerResult,
    preferredStartTools: string[] = [],
    learnedToolSignals: LearnedToolSignal[] = [],
  ): string[] {
    const ranking = new Map<string, number>();
    const learnedScores = new Map<string, number>();
    preferredStartTools.forEach((name, idx) => ranking.set(name, idx - 100));
    learnedToolSignals.forEach(signal => learnedScores.set(signal.toolName, signal.score));
    planner.recommendedTools.forEach((name, idx) => {
      if (!ranking.has(name)) ranking.set(name, idx);
    });

    return [...toolNames].sort((a, b) => {
      const aRank = ranking.has(a) ? (ranking.get(a) as number) : Number.MAX_SAFE_INTEGER;
      const bRank = ranking.has(b) ? (ranking.get(b) as number) : Number.MAX_SAFE_INTEGER;
      if (aRank !== bRank) return aRank - bRank;

      const aLearned = learnedScores.get(a) || 0;
      const bLearned = learnedScores.get(b) || 0;
      if (aLearned !== bLearned) {
        return bLearned - aLearned;
      }

      const aProfile = this.getProfile(a);
      const bProfile = this.getProfile(b);
      const riskWeight = { low: 0, medium: 1, high: 2 };
      if (riskWeight[aProfile.riskLevel] !== riskWeight[bProfile.riskLevel]) {
        return riskWeight[aProfile.riskLevel] - riskWeight[bProfile.riskLevel];
      }
      return a.localeCompare(b);
    });
  }

  private summarizeRisk(toolNames: string[]): string {
    const counts = { low: 0, medium: 0, high: 0 };
    for (const toolName of toolNames) {
      counts[this.getProfile(toolName).riskLevel]++;
    }
    return `low=${counts.low}, medium=${counts.medium}, high=${counts.high}`;
  }
}
