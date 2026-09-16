import { App, Platform } from "obsidian";
import { logger } from "../../core/logger";
import type { ChatMessage, AgentRunSnapshot } from "../../core/types";
import { getReflectionManager } from "./reflection";
import type { PermissionManager } from "./PermissionManager";
import type { ExecutionVerifier } from "./ExecutionVerifier";
import type { ToolRouter } from "./ToolRouter";
import type { RepairLoop } from "./RepairLoop";
import type { ExecutionSession, ExecutedToolRecord } from "./ExecutionSession";
import type { AgentManager } from "./manager";
import type { Tool } from "./types";
import { safeNotice } from "../../utils/notice";

export interface ToolBatchExecutorServices {
  app: App;
  agentManager: AgentManager;
  permissionManager: PermissionManager;
  executionVerifier: ExecutionVerifier;
  toolRouterAgent: ToolRouter;
  triggerToolReflection: (
    toolName: string,
    toolArgs: any,
    errorMessage: string,
    contextMessages: ChatMessage[]
  ) => Promise<void>;
}

export interface ToolBatchExecutorOptions {
  policyName: string;
  isToolAllowedByPreset: (name: string) => boolean;
  tools: Tool[];
  executionSession: ExecutionSession;
  repairLoop: RepairLoop;
  signal?: AbortSignal;
  onRunSnapshot?: (patch: Partial<AgentRunSnapshot>) => void;
  onAgentUpdate?: (content: string, options?: { verbose?: boolean }) => void;
  getCompletedToolCalls: () => number;
  setCompletedToolCalls: (value: number) => void;
  getTotalPlannedSteps: () => number;
}

interface PreparedToolCall {
  idx: number;
  toolCall: any;
  toolCallId: string;
  toolName: string;
  tool: Tool | undefined;
  parsedArgs: any;
  argsOk: boolean;
  args: any;
  argsError?: string;
  isParallelSafe: boolean;
}

interface ExecuteSingleResult {
  toolCallId: string;
  toolName: string;
  result: string;
  verification?: any;
  isWrite: boolean;
}

export const WRITE_TOOL_NAMES = ["modify_note", "append_to_note", "create_note", "prepend_to_note", "replace_in_note", "move_item", "delete_file", "create_folder", "modify_canvas", "create_canvas", "create_canvas_mindmap", "update_properties"] as const;
const WRITE_TOOL_NAME_SET = new Set<string>(WRITE_TOOL_NAMES);

export interface GuardedToolExecutionServices {
  app: App;
  agentManager: AgentManager;
  permissionManager: PermissionManager;
  executionVerifier: ExecutionVerifier;
  toolRouterAgent: ToolRouter;
}

export interface GuardedToolExecutionInput {
  toolName: string;
  tool: Tool;
  args: any;
  timeoutMs?: number;
  showNotice?: boolean;
}

export interface GuardedToolExecutionResult {
  result: string;
  verification: any;
  isWrite: boolean;
  permissionDenied: boolean;
  permissionSummary?: string;
}

export interface ToolArgsValidationResult {
  ok: boolean;
  args: any;
  error?: string;
}

function normalizeVaultPathArg(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\\/g, "/");
}

function ensureMd(p: string): string {
  return p.toLowerCase().endsWith(".md") ? p : `${p}.md`;
}

function sanitizeSchemaForModel(schema: any): any {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return schema;
  }

  const normalized: any = { ...schema };

  if (normalized.type === "object") {
    const rawProperties = normalized.properties && typeof normalized.properties === "object" && !Array.isArray(normalized.properties)
      ? normalized.properties
      : {};
    const properties: Record<string, any> = {};
    for (const [key, value] of Object.entries(rawProperties)) {
      properties[key] = sanitizeSchemaForModel(value);
    }
    normalized.properties = properties;
    const rawRequired = Array.isArray(normalized.required) ? normalized.required : [];
    normalized.required = rawRequired.filter((key: string) => Object.prototype.hasOwnProperty.call(properties, key));
    if (typeof normalized.additionalProperties === "undefined") {
      normalized.additionalProperties = false;
    }
  }

  if (normalized.type === "array" && normalized.items) {
    normalized.items = sanitizeSchemaForModel(normalized.items);
  }

  if (normalized.properties && typeof normalized.properties === "object" && !Array.isArray(normalized.properties) && normalized.type !== "object") {
    const properties: Record<string, any> = {};
    for (const [key, value] of Object.entries(normalized.properties)) {
      properties[key] = sanitizeSchemaForModel(value);
    }
    normalized.properties = properties;
  }

  if (Array.isArray(normalized.anyOf)) {
    normalized.anyOf = normalized.anyOf.map((item: any) => sanitizeSchemaForModel(item));
  }
  if (Array.isArray(normalized.oneOf)) {
    normalized.oneOf = normalized.oneOf.map((item: any) => sanitizeSchemaForModel(item));
  }
  if (Array.isArray(normalized.allOf)) {
    normalized.allOf = normalized.allOf.map((item: any) => sanitizeSchemaForModel(item));
  }

  return normalized;
}

export function buildModelSafeParameters(parameters: { type: "object"; properties: Record<string, any>; required: string[] }) {
  return sanitizeSchemaForModel({
    type: "object",
    properties: parameters?.properties && typeof parameters.properties === "object" ? parameters.properties : {},
    required: Array.isArray(parameters?.required) ? parameters.required : [],
  });
}

export function validateAndNormalizeToolArgs(toolName: string, raw: any): ToolArgsValidationResult {
  const args = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
  const requireString = (key: string): string | null => normalizeVaultPathArg(args[key]);

  if (toolName === "create_note") {
    let p = requireString("path");
    const title = typeof args.title === "string" ? args.title.trim() : "";
    const folder = requireString("folder");
    if (!p && title) p = folder ? `${folder}/${title}` : title;
    if (!p) {
      return { ok: false, args, error: "create_note 缺少必填参数 path (string)。也可以提供 title (string) 生成文件名。" };
    }
    args.path = ensureMd(p);
    if (typeof args.content !== "string") {
      return { ok: false, args, error: "create_note 缺少必填参数 content (string)。" };
    }
    return { ok: true, args };
  }

  if (toolName === "read_note" || toolName === "delete_file" || toolName === "get_backlinks" || toolName === "create_folder") {
    const p = requireString("path");
    if (!p) return { ok: false, args, error: `${toolName} 缺少必填参数 path (string)。` };
    args.path = p;
    if (toolName === "read_note") {
      const hasStartLine = typeof args.startLine !== "undefined";
      const hasEndLine = typeof args.endLine !== "undefined";
      if (hasStartLine !== hasEndLine) {
        return { ok: false, args, error: "read_note 的 startLine 和 endLine 必须同时提供。" };
      }
      if (hasStartLine && hasEndLine) {
        const startLine = Number(args.startLine);
        const endLine = Number(args.endLine);
        if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) {
          return { ok: false, args, error: "read_note 的 startLine 和 endLine 必须是 number。" };
        }
        args.startLine = Math.floor(startLine);
        args.endLine = Math.floor(endLine);
      }
      if (typeof args.heading !== "undefined") {
        if (typeof args.heading !== "string" || args.heading.trim().length === 0) {
          return { ok: false, args, error: "read_note 的 heading 必须是非空 string。" };
        }
        args.heading = args.heading.trim();
      }
    }
    return { ok: true, args };
  }

  if (toolName === "append_to_note") {
    const p = requireString("path");
    if (!p) return { ok: false, args, error: "append_to_note 缺少必填参数 path (string)。" };
    args.path = p;
    if (typeof args.content !== "string") {
      return { ok: false, args, error: "append_to_note 缺少必填参数 content (string)。" };
    }
    return { ok: true, args };
  }

  if (toolName === "modify_note") {
    const p = requireString("path");
    if (!p) return { ok: false, args, error: "modify_note 缺少必填参数 path (string)。" };
    args.path = p;
    if (typeof args.content !== "string") {
      return { ok: false, args, error: "modify_note 缺少必填参数 content (string)。" };
    }
    const rawMode = typeof args.mode === "string" ? args.mode.trim().toLowerCase() : "append";
    if (!["append", "prepend", "overwrite"].includes(rawMode)) {
      return { ok: false, args, error: `modify_note 的 mode 只能是 append / prepend / overwrite，收到: ${String(args.mode)}` };
    }
    args.mode = rawMode;
    return { ok: true, args };
  }

  if (toolName === "replace_in_note") {
    const p = requireString("path");
    if (!p) return { ok: false, args, error: "replace_in_note 缺少必填参数 path (string)。" };
    args.path = p;
    if (typeof args.oldText !== "string") {
      return { ok: false, args, error: "replace_in_note 缺少必填参数 oldText (string)。" };
    }
    if (typeof args.newText !== "string") {
      return { ok: false, args, error: "replace_in_note 缺少必填参数 newText (string)。" };
    }
    if (typeof args.replaceAll !== "undefined") {
      args.replaceAll = args.replaceAll === true;
    }
    return { ok: true, args };
  }

  if (toolName === "search_notes" || toolName === "knowledge_base_query" || toolName === "vector_search") {
    if (typeof args.query !== "string" || args.query.trim().length === 0) {
      return { ok: false, args, error: `${toolName} 缺少必填参数 query (string)。` };
    }
    args.query = args.query.trim();
    if (typeof args.limit !== "undefined") {
      const num = Number(args.limit);
      if (!Number.isFinite(num)) return { ok: false, args, error: `${toolName} 的 limit 必须是 number。` };
      args.limit = Math.floor(num);
    }
    if (toolName === "search_notes") {
      if (typeof args.maxResults !== "undefined") {
        const num = Number(args.maxResults);
        if (!Number.isFinite(num)) return { ok: false, args, error: "search_notes 的 maxResults 必须是 number。" };
        args.maxResults = Math.floor(num);
      }
      if (typeof args.maxScanFiles !== "undefined") {
        const num = Number(args.maxScanFiles);
        if (!Number.isFinite(num)) return { ok: false, args, error: "search_notes 的 maxScanFiles 必须是 number。" };
        args.maxScanFiles = Math.floor(num);
      }
      if (typeof args.maxScanMs !== "undefined") {
        const num = Number(args.maxScanMs);
        if (!Number.isFinite(num)) return { ok: false, args, error: "search_notes 的 maxScanMs 必须是 number。" };
        args.maxScanMs = Math.floor(num);
      }
    }
    if (toolName === "knowledge_base_query") {
      if (typeof args.maxSnippetChars !== "undefined") {
        const num = Number(args.maxSnippetChars);
        if (!Number.isFinite(num)) return { ok: false, args, error: "knowledge_base_query 的 maxSnippetChars 必须是 number。" };
        args.maxSnippetChars = Math.floor(num);
      }
      if (typeof args.offset !== "undefined") {
        const num = Number(args.offset);
        if (!Number.isFinite(num)) return { ok: false, args, error: "knowledge_base_query 的 offset 必须是 number。" };
        args.offset = Math.floor(num);
      }
    }
    return { ok: true, args };
  }

  if (toolName === "explore_note_links") {
    const p = requireString("path");
    if (!p) return { ok: false, args, error: "explore_note_links 缺少必填参数 path (string)。" };
    args.path = p;
    const rawDirection = typeof args.direction === "string" ? args.direction.trim().toLowerCase() : "both";
    if (!["both", "forward", "backlinks"].includes(rawDirection)) {
      return { ok: false, args, error: `explore_note_links 的 direction 只能是 both / forward / backlinks，收到: ${String(args.direction)}` };
    }
    args.direction = rawDirection;
    if (typeof args.depth !== "undefined") {
      const num = Number(args.depth);
      if (!Number.isFinite(num)) return { ok: false, args, error: "explore_note_links 的 depth 必须是 number。" };
      args.depth = Math.floor(num);
    }
    if (typeof args.includeContent !== "undefined") {
      args.includeContent = args.includeContent === true;
    }
    if (typeof args.maxSnippetChars !== "undefined") {
      const num = Number(args.maxSnippetChars);
      if (!Number.isFinite(num)) return { ok: false, args, error: "explore_note_links 的 maxSnippetChars 必须是 number。" };
      args.maxSnippetChars = Math.floor(num);
    }
    return { ok: true, args };
  }

  if (toolName === "find_note_relationships") {
    const p = requireString("path");
    if (!p) return { ok: false, args, error: "find_note_relationships 缺少必填参数 path (string)。" };
    args.path = p;
    const rawRelationship = typeof args.relationship === "string" ? args.relationship.trim().toLowerCase() : "all";
    if (!["children", "parent", "siblings", "descendants", "all"].includes(rawRelationship)) {
      return { ok: false, args, error: `find_note_relationships 的 relationship 只能是 children / parent / siblings / descendants / all，收到: ${String(args.relationship)}` };
    }
    args.relationship = rawRelationship;
    if (typeof args.parentProperty !== "undefined") {
      if (typeof args.parentProperty !== "string") return { ok: false, args, error: "find_note_relationships 的 parentProperty 必须是 string。" };
      args.parentProperty = args.parentProperty.trim();
    }
    if (typeof args.depth !== "undefined") {
      const num = Number(args.depth);
      if (!Number.isFinite(num)) return { ok: false, args, error: "find_note_relationships 的 depth 必须是 number。" };
      args.depth = Math.floor(num);
    }
    if (typeof args.includeContent !== "undefined") {
      args.includeContent = args.includeContent === true;
    }
    if (typeof args.maxSnippetChars !== "undefined") {
      const num = Number(args.maxSnippetChars);
      if (!Number.isFinite(num)) return { ok: false, args, error: "find_note_relationships 的 maxSnippetChars 必须是 number。" };
      args.maxSnippetChars = Math.floor(num);
    }
    return { ok: true, args };
  }

  if (toolName === "move_item") {
    const sourcePath = requireString("sourcePath");
    const destinationPath = requireString("destinationPath");
    if (!sourcePath) return { ok: false, args, error: "move_item 缺少必填参数 sourcePath (string)。" };
    if (!destinationPath) return { ok: false, args, error: "move_item 缺少必填参数 destinationPath (string)。" };
    args.sourcePath = sourcePath;
    args.destinationPath = destinationPath;
    return { ok: true, args };
  }

  if (toolName === "list_files") {
    const fp = typeof args.folderPath === "string" ? args.folderPath : "";
    args.folderPath = fp;
    return { ok: true, args };
  }

  if (toolName === "execute_command") {
    if (typeof args.commandId !== "string" || args.commandId.trim().length === 0) {
      return { ok: false, args, error: "execute_command 缺少必填参数 commandId (string)。" };
    }
    args.commandId = args.commandId.trim();
    return { ok: true, args };
  }

  if (toolName === "get_properties") {
    const p = requireString("path");
    if (!p) return { ok: false, args, error: "get_properties 缺少必填参数 path (string)。" };
    args.path = p;
    return { ok: true, args };
  }

  if (toolName === "update_properties") {
    const p = requireString("path");
    if (!p) return { ok: false, args, error: "update_properties 缺少必填参数 path (string)。" };
    if (!args.properties || typeof args.properties !== "object" || Array.isArray(args.properties)) {
      return { ok: false, args, error: "update_properties 缺少必填参数 properties (object)。" };
    }
    args.path = p;
    return { ok: true, args };
  }

  return { ok: true, args };
}

export function tryParseToolArgsLoose(raw: any): any {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === "object") return raw;
  const text = String(raw);
  const cleaned = text.replace(/```json\s*/g, "").replace(/```/g, "").trim();

  const extractBalanced = (open: "{" | "[", close: "}" | "]") => {
    const start = cleaned.indexOf(open);
    if (start === -1) return null;
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (inStr) {
        if (escape) {
          escape = false;
        } else if (ch === "\\") {
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
      if (depth === 0) return cleaned.substring(start, i + 1).trim();
    }
    return null;
  };

  const candidates = [extractBalanced("{", "}"), extractBalanced("[", "]"), cleaned].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // try next
    }
  }
  return {};
}

export async function executeToolWithGuards(
  services: GuardedToolExecutionServices,
  input: GuardedToolExecutionInput,
): Promise<GuardedToolExecutionResult> {
  const profile = services.toolRouterAgent.getProfile(input.toolName);
  const permissionDecision = await services.permissionManager.ensureAuthorized({
    toolName: input.toolName,
    toolLabel: services.agentManager.getToolLabel(input.toolName),
    toolDescription: input.tool.definition.description,
    args: input.args,
    profile,
  });

  const isWrite = WRITE_TOOL_NAME_SET.has(input.toolName);
  if (!permissionDecision.allowed) {
    return {
      result: `权限拒绝: ${permissionDecision.summary}`,
      verification: null,
      isWrite,
      permissionDenied: true,
      permissionSummary: permissionDecision.summary,
    };
  }

  if (input.showNotice !== false) {
    safeNotice(`🤖 Agent 正在执行: ${services.agentManager.getToolLabel(input.toolName)}`);
  }

  const rawResult = typeof input.timeoutMs === "number"
    ? await withTimeout(input.tool.execute(input.args, services.app), input.timeoutMs, `工具 ${services.agentManager.getToolLabel(input.toolName)}`)
    : await input.tool.execute(input.args, services.app);

  let verification: any = null;
  let result = rawResult;
  if (isWrite) {
    verification = await services.executionVerifier.verify(input.toolName, input.args, rawResult);
    result = services.executionVerifier.appendToToolResult(rawResult, verification);
  }

  return {
    result,
    verification,
    isWrite,
    permissionDenied: false,
    permissionSummary: permissionDecision.summary,
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: number | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(`${label} 超时（>${ms}ms）`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer !== null) window.clearTimeout(timer);
  }) as Promise<T>;
}

export class ToolBatchExecutor {
  private readonly executedToolResults = new Map<string, string>();
  private readonly writeTools = new Set<string>(WRITE_TOOL_NAMES);
  private readonly parallelSafeTools = new Set(["read_note", "get_note_structure", "list_files", "search_notes", "get_recent_notes", "vector_search", "get_backlinks", "list_commands", "mcp_list_tools", "knowledge_base_query", "explore_note_links", "find_note_relationships", "read_canvas", "get_properties", "manage_todo_list"]);

  constructor(
    private readonly services: ToolBatchExecutorServices,
    private readonly options: ToolBatchExecutorOptions,
  ) {}

  public async executeToolCalls(toolCalls: any[], loopCount: number, msgs: ChatMessage[], newMsgs: ChatMessage[]): Promise<void> {
    const prepared = this.prepareToolCalls(toolCalls, loopCount, msgs, newMsgs);
    const allParallel = prepared.length > 1 && prepared.every(p => p.isParallelSafe);

    if (allParallel) {
      logger.info("AI", `并行执行 ${prepared.length} 个只读工具`, { tools: prepared.map(p => p.toolName) });
      safeNotice(`🤖 Agent 并行执行 ${prepared.length} 个工具...`);
      const results = await Promise.all(prepared.map(p => this.executeSingleTool(p, msgs)));
      this.finalizeBatch(results, msgs, newMsgs, true);
      return;
    }

    let i = 0;
    while (i < prepared.length) {
      const batch: PreparedToolCall[] = [];
      while (i < prepared.length && prepared[i].isParallelSafe) {
        batch.push(prepared[i]);
        i++;
      }

      if (batch.length > 1) {
        logger.info("AI", `并行执行 ${batch.length} 个只读工具`, { tools: batch.map(p => p.toolName) });
        const results = await Promise.all(batch.map(p => this.executeSingleTool(p, msgs)));
        this.finalizeBatch(results, msgs, newMsgs, false);
      } else if (batch.length === 1) {
        const result = await this.executeSingleTool(batch[0], msgs);
        this.finalizeBatch([result], msgs, newMsgs, false);
      }

      if (i < prepared.length && !prepared[i].isParallelSafe) {
        const result = await this.executeSingleTool(prepared[i], msgs);
        this.finalizeBatch([result], msgs, newMsgs, false);
        i++;
      }
    }
  }

  public buildOpenAiToolsForCurrentPhase(toolRoutingAllowedToolNames: string[], getSuggestedTools: () => string[]): any[] {
    let phaseToolNames = this.services.toolRouterAgent.filterByPhase(toolRoutingAllowedToolNames, this.options.executionSession.getCurrentPhase());
    if (this.options.executionSession.getCurrentPhase() === "repair") {
      const suggested = getSuggestedTools();
      if (suggested.length > 0) {
        const merged = new Set([...phaseToolNames, ...suggested.filter(name => toolRoutingAllowedToolNames.includes(name))]);
        phaseToolNames = Array.from(merged);
      }
    }

    const phaseToolSet = new Set(phaseToolNames);
    return this.options.tools
      .filter(t => phaseToolSet.has(t.definition.name))
      .map(t => ({
        type: "function",
        function: {
          name: t.definition.name,
          description: t.definition.description,
          parameters: buildModelSafeParameters(t.definition.parameters),
        },
      }));
  }

  private prepareToolCalls(toolCalls: any[], loopCount: number, msgs: ChatMessage[], newMsgs: ChatMessage[]): PreparedToolCall[] {
    const prepared: PreparedToolCall[] = [];
    const seenReadOnlyKeys = new Set<string>();
    const perToolBudget = new Map<string, number>();

    for (const [idx, toolCall] of toolCalls.entries()) {
      const toolCallId = (toolCall as any)?.id && String((toolCall as any).id).trim().length > 0
        ? (toolCall as any).id
        : `call_${loopCount}_${idx}_${Date.now()}`;
      (toolCall as any).id = toolCallId;

      const toolName = toolCall?.function?.name;
      if (!toolName || String(toolName).trim().length === 0) {
        const toolMessage: ChatMessage = {
          role: "tool",
          tool_call_id: toolCallId,
          name: toolName || "(empty)",
          content: "错误: tool_calls.function.name 为空，无法执行工具",
        };
        msgs.push(toolMessage);
        newMsgs.push(toolMessage);
        continue;
      }

      const rawArgs = toolCall?.function?.arguments;
      const parsedArgs = tryParseToolArgsLoose(rawArgs);
      const { ok: argsOk, args, error: argsError } = validateAndNormalizeToolArgs(toolName, parsedArgs);
      const tool = this.services.agentManager.getTool(toolName);
      const isParallelSafe = this.parallelSafeTools.has(toolName) && !this.writeTools.has(toolName);

      if (isParallelSafe && argsOk) {
        const currentCount = perToolBudget.get(toolName) || 0;
        const maxPerTool = toolName === "read_note" ? 2 : 1;
        if (currentCount >= maxPerTool) {
          logger.info("AI", "Skipped readonly tool by per-tool batch limit", { toolName, args, maxPerTool });
          const toolMessage: ChatMessage = {
            role: "tool",
            tool_call_id: toolCallId,
            name: toolName,
            content: `[限流] 本轮 ${toolName} 已达到批次上限 ${maxPerTool}，已跳过额外重复调用。`,
          };
          msgs.push(toolMessage);
          newMsgs.push(toolMessage);
          continue;
        }

        let argsKey = "";
        try {
          argsKey = JSON.stringify(args ?? {});
        } catch {
          argsKey = String(args);
        }
        const dedupKey = `${toolName}::${argsKey}`;
        if (seenReadOnlyKeys.has(dedupKey)) {
          logger.info("AI", "Skipped duplicate readonly tool call in same batch", { toolName, args });
          const toolMessage: ChatMessage = {
            role: "tool",
            tool_call_id: toolCallId,
            name: toolName,
            content: `[去重] 本轮已存在相同只读工具调用，已跳过重复执行：${toolName}`,
          };
          msgs.push(toolMessage);
          newMsgs.push(toolMessage);
          continue;
        }
        seenReadOnlyKeys.add(dedupKey);
        perToolBudget.set(toolName, currentCount + 1);
      }

      prepared.push({ idx, toolCall, toolCallId, toolName, tool, parsedArgs, argsOk, args, argsError, isParallelSafe });
    }

    return prepared;
  }

  private async executeSingleTool(p: PreparedToolCall, msgs: ChatMessage[]): Promise<ExecuteSingleResult> {
    let result = "";
    let verification: any = null;
    const nextStep = this.options.getCompletedToolCalls() + 1;
    this.options.onRunSnapshot?.({
      phase: this.options.executionSession.getCurrentPhase(),
      currentStep: nextStep,
      totalSteps: Math.max(this.options.getTotalPlannedSteps(), this.options.getCompletedToolCalls() + 1),
      lastToolName: p.toolName,
      lastToolSummary: "准备执行工具",
    });

    if (p.tool) {
      try {
        if (!this.options.isToolAllowedByPreset(p.toolName)) {
          result = `错误: 当前策略（${this.options.policyName}）不允许调用工具：${p.toolName}`;
        } else if (!p.argsOk) {
          result = `错误: 工具参数不合法，已跳过执行。${p.argsError ? `\n原因: ${p.argsError}` : ""}\nArgs: ${JSON.stringify(p.parsedArgs ?? {}, null, 2)}`;
        } else {
          const toolKey = this.makeToolKey(p.toolName, p.args);
          const cachedResult = this.executedToolResults.get(toolKey);
          if (cachedResult !== undefined) {
            result = `[去重] 此工具已用相同参数执行过，直接复用之前的结果：\n${cachedResult}`;
          } else {
            const execution = await executeToolWithGuards(this.services, {
              toolName: p.toolName,
              tool: p.tool,
              args: p.args,
              timeoutMs: this.resolveToolTimeoutMs(p.toolName),
              showNotice: true,
            });
            result = execution.result;
            verification = execution.verification;

            if (execution.permissionDenied) {
              this.options.onRunSnapshot?.({
                phase: this.options.executionSession.getCurrentPhase(),
                lastToolName: p.toolName,
                lastToolSummary: execution.permissionSummary,
                stopReason: execution.permissionSummary,
              });
              return { toolCallId: p.toolCallId, toolName: p.toolName, result, verification, isWrite: this.writeTools.has(p.toolName) };
            }

            if (verification) {
              logger.info("AI", `执行后验证: ${p.toolName}`, { ok: verification.ok, summary: verification.summary });
            }

            this.executedToolResults.set(toolKey, result);
            if (this.writeTools.has(p.toolName) && p.args?.path) {
              this.invalidateReadCacheForPath(p.args.path);
            }
          }
        }
      } catch (e: any) {
        result = `工具执行出错: ${e?.message || String(e)}`;
      }
    } else {
      result = `错误: 未找到工具 ${p.toolName}`;
    }

    const reflectionMgr = getReflectionManager();
    const shouldReflect = reflectionMgr.isToolError(result) || verification?.ok === false;
    if (shouldReflect) {
      this.services.triggerToolReflection(p.toolName, p.args, result, msgs).catch(e => {
        logger.warn("Reflection", "Failed to trigger reflection", e);
      });
    }

    const completed = this.options.getCompletedToolCalls() + 1;
    this.options.setCompletedToolCalls(completed);
    this.options.onRunSnapshot?.({
      phase: this.options.executionSession.getCurrentPhase(),
      currentStep: completed,
      completedSteps: completed,
      totalSteps: Math.max(this.options.getTotalPlannedSteps(), completed),
      lastToolName: p.toolName,
      lastToolSummary: verification?.summary || (result ? String(result).slice(0, 160) : "工具执行完成"),
    });

    return { toolCallId: p.toolCallId, toolName: p.toolName, result, verification, isWrite: this.writeTools.has(p.toolName) };
  }

  private finalizeBatch(results: ExecuteSingleResult[], msgs: ChatMessage[], newMsgs: ChatMessage[], emitBatchNotice: boolean) {
    const executedRecords: ExecutedToolRecord[] = results.map(r => ({ toolName: r.toolName, isWrite: r.isWrite, verification: r.verification }));
    this.options.repairLoop.registerBatch(executedRecords);
    this.options.executionSession.advanceAfterBatch(executedRecords);
    this.options.onRunSnapshot?.({
      phase: this.options.executionSession.getCurrentPhase(),
      completedSteps: this.options.getCompletedToolCalls(),
      totalSteps: Math.max(this.options.getTotalPlannedSteps(), this.options.getCompletedToolCalls()),
      lastToolSummary: this.options.executionSession.getShortStatus(),
      repairSummary: this.options.repairLoop.getSnapshotSummary(),
      lastVerificationSummary: this.options.executionSession.getLastVerificationSummary(),
      businessStatus: this.options.executionSession.getBusinessStatus(),
      businessSummary: this.options.executionSession.getBusinessSummary(),
    });

    for (const r of results) {
      const toolMessage: ChatMessage = { role: "tool", tool_call_id: r.toolCallId, name: r.toolName, content: r.result };
      msgs.push(toolMessage);
      newMsgs.push(toolMessage);
    }

    if (emitBatchNotice) return;
  }

  private makeToolKey(name: string, args: any) {
    let a = "";
    try {
      a = JSON.stringify(args ?? {});
    } catch {
      a = String(args);
    }
    return `${name}::${a}`;
  }

  private invalidateReadCacheForPath(path: string) {
    if (!path) return;
    const normalizedPath = String(path).replace(/^\/+/, "").replace(/\.md$/i, "");
    const keysToDelete: string[] = [];
    for (const key of this.executedToolResults.keys()) {
      if (key.startsWith("read_note::") && key.includes(normalizedPath)) {
        keysToDelete.push(key);
      }
    }
    for (const k of keysToDelete) {
      this.executedToolResults.delete(k);
    }
  }

  private resolveToolTimeoutMs(toolName: string): number {
    const name = String(toolName || "").trim();
    const isMobile = Platform.isMobile;

    if (name.startsWith("mcp_")) return isMobile ? 45_000 : 75_000;
    if (/^(read_note|search_notes|list_files|vector_search|knowledge_base_query|get_note_structure|explore_note_links|find_note_relationships|find_symbol|find_references|read_code_region|list_code_dependencies|read_canvas)$/.test(name)) {
      return isMobile ? 15_000 : 20_000;
    }
    if (/^(replace_in_note|modify_note|append_to_note|create_note|move_item|create_folder|update_properties|modify_canvas|create_canvas|create_canvas_mindmap)$/.test(name)) {
      return isMobile ? 20_000 : 30_000;
    }
    return isMobile ? 25_000 : 35_000;
  }
}
