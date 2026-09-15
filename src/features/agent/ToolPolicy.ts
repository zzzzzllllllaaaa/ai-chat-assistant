export type ToolPolicyId = "default" | "local-notes" | "webparser" | "writing";

export interface ToolPolicy {
  id: ToolPolicyId;
  name: string;
  description: string;
  /**
   * If provided, agent tools will be intersected with this allowlist.
   * If omitted, no extra restriction is applied.
   */
  allowedTools?: string[];
}

export type ExecutionMode = "focused" | "structured" | "deep";

export const ExecutionModePolicy: Record<ExecutionMode, string[]> = {
  focused: [
    "read_note",
    "get_note_structure",
    "list_files",
    "search_notes",
    "get_recent_notes",
    "knowledge_base_query",
    "create_note",
    "modify_note",
    "replace_in_note",
    "append_to_note",
    "manage_todo_list"
  ],
  structured: [
    "read_note",
    "get_note_structure",
    "list_files",
    "search_notes",
    "get_recent_notes",
    "knowledge_base_query",
    "create_note",
    "modify_note",
    "replace_in_note",
    "append_to_note",
    "manage_todo_list",
    "get_properties",
    "update_properties",
    "move_item",
    "create_folder",
    "delete_file",
    "read_canvas",
    "create_canvas",
    "modify_canvas",
    "create_canvas_mindmap",
    "find_symbol",
    "find_references",
    "list_code_dependencies",
    "read_code_region",
    "mcp_list_tools",
    "mcp_call_tool"
  ],
  deep: [] // Empty means all tools available
};

export function getAllowedToolsForMode(mode: string, availableTools: string[]): string[] {
  if (mode === "deep" || !mode) {
    return [...availableTools];
  }
  const allowedSet = new Set(ExecutionModePolicy[mode as ExecutionMode] || []);
  return availableTools.filter(t => allowedSet.has(t));
}

const BUILTIN_TOOL_POLICIES: ToolPolicy[] = [
  {
    id: "default",
    name: "默认（不限制工具）",
    description: "不额外限制智能体的可用工具（仍受 Agent 自身 tools 列表与 MCP 工具开关约束）。",
  },
  {
    id: "local-notes",
    name: "仅本地笔记（禁用外部工具）",
    description: "只允许读取/检索/编辑本地笔记与知识库，默认聚焦核心 Obsidian 动作，不暴露外部联网、MCP、代码、Canvas 等扩展工具。",
    allowedTools: [
      // Core read/search
      "read_note",
      "get_note_structure",
      "list_files",
      "search_notes",
      "get_recent_notes",
      "knowledge_base_query",
      // Core write/edit
      "create_note",
      "modify_note",
      "replace_in_note",
      "move_item",
      "delete_file",
      "create_folder",
      // Metadata
      "get_properties",
      "update_properties",
    ],
  },
  {
    id: "webparser",
    name: "网页解析（WebParser/MCP）",
    description: "只保留网页解析相关的 MCP 工具，以及必要的笔记写入工具用于保存结果。默认优先核心写入工具，不依赖 append_to_note。",
    allowedTools: [
      "mcp_list_tools",
      "mcp_call_tool",
      "read_note",
      "create_note",
      "modify_note",
      "replace_in_note",
      "manage_todo_list",
    ],
  },
  {
    id: "writing",
    name: "写作/润色（最少工具）",
    description: "以写作为主，仅允许参考和修改笔记，默认使用精准替换而非追加式多工具组合。",
    allowedTools: [
      "read_note",
      "get_note_structure",
      "create_note",
      "modify_note",
      "replace_in_note",
      "search_notes",
      "knowledge_base_query",
    ],
  },
];

export function getBuiltinToolPolicies(): ToolPolicy[] {
  return BUILTIN_TOOL_POLICIES;
}

export function getToolPolicyById(id: string | null | undefined): ToolPolicy {
  const wanted = String(id || "").trim() as ToolPolicyId;
  const hit = BUILTIN_TOOL_POLICIES.find(p => p.id === wanted);
  return hit || BUILTIN_TOOL_POLICIES[0];
}

export function filterToolNamesByPolicy(policyId: string | null | undefined, toolNames: string[]): {
  policy: ToolPolicy;
  toolNames: string[];
  filtered: boolean;
} {
  const policy = getToolPolicyById(policyId);
  const allow = policy.allowedTools;
  if (!allow || allow.length === 0) {
    return { policy, toolNames, filtered: false };
  }
  const allowSet = new Set(allow);
  const filteredNames = toolNames.filter(n => allowSet.has(n));
  return { policy, toolNames: filteredNames, filtered: true };
}
