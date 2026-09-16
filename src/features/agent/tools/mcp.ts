import { App, Platform } from "obsidian";
import type { Tool } from "../types";
import { McpClient } from "../../../mcp/McpClient";
import { DashScopeMcpClient } from "../../../mcp/DashScopeMcpClient";
import { GenericMcpClient } from "../../../mcp/GenericMcpClient";
import { ToolRegistry } from "../../../mcp/ToolRegistry";
import { McpToolAuthorizeModal } from "../../../ui/modals/McpToolAuthorizeModal";
import { safeNotice } from "../../../utils/notice";

const DASHSCOPE_WEBPARSER_CACHE_TTL_MS = 3 * 60 * 1000;
const DASHSCOPE_WEBPARSER_CACHE_MAX_CHARS = 500_000;
const DASHSCOPE_WEBPARSER_CACHE_MAX_ENTRIES = 50;
const DEFAULT_DASHSCOPE_WEBPARSER_MAX_OUTPUT_CHARS = 60_000;
// WebParser on mobile is often rate-limited or flaky; throttle per host to reduce 429s.
const DEFAULT_DASHSCOPE_WEBPARSER_HOST_MIN_INTERVAL_MS = 800;
// Hard timeout to avoid lingering in-flight promises when the outer tool timeout triggers.
const DASHSCOPE_WEBPARSER_HARD_TIMEOUT_MS = 90_000;

type CacheEntry = { at: number; value: string };

const dashscopeWebparserCache = new Map<string, CacheEntry>();
const dashscopeWebparserInFlight = new Map<string, Promise<string>>();

// Per-host throttling/serialization to reduce rate-limit and flaky mobile networking.
const dashscopeWebparserHostLocks = new Map<string, { tail: Promise<void> }>();
const dashscopeWebparserHostLastAt = new Map<string, number>();

// Fallback global lock (used when URL/host cannot be inferred).
const dashscopeWebparserLock: { tail: Promise<void> } = { tail: Promise.resolve() };

function sleep(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms));
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  const timeoutMs = Math.max(1000, Math.min(180_000, Math.floor(ms)));
  let timer: number | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(`${label} 超时（>${timeoutMs}ms）`)), timeoutMs);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer !== null) window.clearTimeout(timer);
  }) as Promise<T>;
}

// 支持附加调试信息的超时包装器
function withTimeoutAndDebug<T>(
  p: Promise<T>,
  ms: number,
  label: string,
  getDebug: () => any
): Promise<T> {
  const timeoutMs = Math.max(1000, Math.min(180_000, Math.floor(ms)));
  let timer: number | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => {
      const debug = getDebug();
      const debugSummary = {
        method: debug?.method,
        params: debug?.params,
        attempts: debug?.attempts?.map((a: any) => ({
          url: a?.sseUrl?.substring(0, 80),
          connectOk: a?.connect?.ok,
          connectStatus: a?.connect?.status,
          handshake: a?.handshake?.messageEndpoint ? 'resolved' : 'not resolved',
          messageEndpoint: a?.handshake?.messageEndpoint?.substring(0, 100),
          postStarted: a?.post?.started,
          postUrl: a?.post?.url?.substring(0, 100),
          postStatus: a?.post?.status,
          postError: a?.post?.error?.substring(0, 100),
          responseReceived: a?.response?.received,
          events: a?.eventsSample?.slice(0, 3)?.map((e: string) => e?.substring(0, 200)),
          error: a?.error?.substring(0, 150),
        })) || [],
      };
      reject(new Error(`${label} 超时（>${timeoutMs}ms）。调试信息: ${JSON.stringify(debugSummary, null, 2)}`));
    }, timeoutMs);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer !== null) window.clearTimeout(timer);
  }) as Promise<T>;
}

function jitterMs(base: number): number {
  const b = Math.max(0, Math.floor(base));
  if (b <= 0) return 0;
  // Up to ~30% jitter.
  return Math.floor(Math.random() * Math.max(1, Math.floor(b * 0.3)));
}

function safeUrlHost(rawUrl: string): string {
  const u = String(rawUrl || "").trim();
  if (!u) return "";
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return "";
  }
}

function getHostFromWebparserArgs(args: any): string {
  try {
    const raw = findUrlInArgs(args);
    const normalized = normalizeUrlForCache(raw);
    return safeUrlHost(normalized);
  } catch {
    return "";
  }
}

function isLikelyWebParserToolName(toolName: string): boolean {
  return /webparser|web_parser|webpage|bailian/i.test(toolName);
}

function normalizeUrlForCache(raw: string): string {
  const s = String(raw || "").trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    u.hash = "";

    // Drop common tracking params to improve cache hit rate.
    const dropPrefix = [/^utm_/i];
    const dropExact = new Set([
      "spm",
      "_spm",
      "from",
      "source",
      "src",
      "ref",
      "ref_src",
      "fbclid",
      "gclid",
    ]);

    const kept: Array<[string, string]> = [];
    for (const [k, v] of u.searchParams.entries()) {
      if (dropExact.has(k)) continue;
      if (dropPrefix.some((re) => re.test(k))) continue;
      kept.push([k, v]);
    }

    kept.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
    u.search = "";
    for (const [k, v] of kept) u.searchParams.append(k, v);

    return u.toString();
  } catch {
    // If URL parsing fails, keep original string.
    return s;
  }
}

function findUrlInArgs(args: any): string {
  if (!args || typeof args !== "object") return "";

  const directKeys = ["url", "link", "href", "targetUrl", "target_url", "uri"];
  for (const k of directKeys) {
    const v = (args as any)[k];
    if (typeof v === "string" && /^https?:\/\//i.test(v.trim())) return v.trim();
  }

  // Best-effort: scan one level deep for the first URL-like string.
  for (const v of Object.values(args)) {
    if (typeof v === "string" && /^https?:\/\//i.test(v.trim())) return v.trim();
  }
  return "";
}

function buildWebparserCacheKey(provider: "dashscope", toolName: string, args: any): string {
  const url = normalizeUrlForCache(findUrlInArgs(args));
  if (!url) return "";
  if (!isLikelyWebParserToolName(toolName)) return "";
  return `${provider}::${toolName}::${url}`;
}

function touchCacheEntry(key: string) {
  const v = dashscopeWebparserCache.get(key);
  if (!v) return;
  // Map preserves insertion order: delete+set moves it to the end (MRU).
  dashscopeWebparserCache.delete(key);
  dashscopeWebparserCache.set(key, v);
}

function enforceCacheLimit() {
  while (dashscopeWebparserCache.size > DASHSCOPE_WEBPARSER_CACHE_MAX_ENTRIES) {
    const oldestKey = dashscopeWebparserCache.keys().next().value;
    if (!oldestKey) break;
    dashscopeWebparserCache.delete(oldestKey);
  }
}

function clampWebparserMaxOutputChars(n: any): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return DEFAULT_DASHSCOPE_WEBPARSER_MAX_OUTPUT_CHARS;
  return Math.max(1000, Math.min(500000, Math.floor(v)));
}

function clampWebparserHostMinIntervalMs(n: any): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return DEFAULT_DASHSCOPE_WEBPARSER_HOST_MIN_INTERVAL_MS;
  return Math.max(0, Math.min(10000, Math.floor(v)));
}

function extractTextFromMcpResult(res: any): string {
  const pullFromContentArray = (arr: any[]): string => {
    const parts: string[] = [];
    for (const item of arr) {
      if (!item) continue;
      if (typeof item === "string") {
        parts.push(item);
        continue;
      }
      const type = String((item as any)?.type || "");
      const t = (item as any)?.text;
      const c = (item as any)?.content;
      if (typeof t === "string" && (type === "text" || !type)) {
        parts.push(t);
        continue;
      }
      if (typeof c === "string" && (type === "text" || !type)) {
        parts.push(c);
        continue;
      }
    }
    return parts.join("\n\n").trim();
  };

  try {
    const c1 = (res as any)?.content;
    if (Array.isArray(c1)) {
      const s = pullFromContentArray(c1);
      if (s) return s;
    }
    const c2 = (res as any)?.result?.content;
    if (Array.isArray(c2)) {
      const s = pullFromContentArray(c2);
      if (s) return s;
    }
  } catch {}

  return "";
}

function truncateText(text: string, maxChars: number): string {
  const s = String(text || "");
  if (s.length <= maxChars) return s;
  const head = s.slice(0, maxChars);
  return `${head}\n\n[已截断：原始长度 ${s.length}，上限 ${maxChars}]`;
}

function formatWebparserOutput(res: any, opts: { maxChars: number; fallbackToolUsed?: string }): string {
  const prefix = opts.fallbackToolUsed
    ? `（提示：原工具名可能不兼容，已改用 ${opts.fallbackToolUsed}）\n\n`
    : "";

  const extracted = extractTextFromMcpResult(res);
  if (extracted) return prefix + truncateText(extracted, opts.maxChars);

  try {
    return prefix + truncateText(JSON.stringify(res, null, 2), opts.maxChars);
  } catch {
    return prefix + truncateText(String(res), opts.maxChars);
  }
}

function isEffectivelyEmptyWebparserOutput(text: string): boolean {
  const t = String(text || "").trim();
  if (!t) return true;
  return t === "null" || t === "{}" || t === "[]" || t === '""';
}

function looksLikeWebparserErrorObject(res: any): string {
  try {
    const e = (res as any)?.error;
    if (typeof e === "string" && e.trim()) return e.trim();
    const msg = (res as any)?.message;
    if (typeof msg === "string" && msg.trim()) return msg.trim();
    const code = (res as any)?.code;
    if (code !== undefined && code !== null) {
      const m = typeof msg === "string" ? msg.trim() : "";
      return `code=${String(code)}${m ? `, message=${m}` : ""}`;
    }
  } catch {}
  return "";
}

function getWebparserErrorHintIfAny(res: any): string {
  // Avoid false positives: if we already extracted meaningful text, treat as success.
  try {
    if (extractTextFromMcpResult(res)) return "";
  } catch {}

  const top = looksLikeWebparserErrorObject(res);
  if (top) return top;
  try {
    const nested = (res as any)?.result;
    const inner = looksLikeWebparserErrorObject(nested);
    if (inner) return inner;
  } catch {}
  return "";
}

async function runWithLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = dashscopeWebparserLock.tail;
  let release!: () => void;
  dashscopeWebparserLock.tail = new Promise<void>((r) => (release = r));
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

async function runWithHostLock<T>(host: string, fn: () => Promise<T>): Promise<T> {
  const key = String(host || "").trim().toLowerCase();
  if (!key) return await runWithLock(fn);

  const lock = dashscopeWebparserHostLocks.get(key) ?? { tail: Promise.resolve() };
  dashscopeWebparserHostLocks.set(key, lock);

  const prev = lock.tail;
  let release!: () => void;
  lock.tail = new Promise<void>((r) => (release = r));
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

async function enforceHostMinInterval(host: string, minIntervalMs: number): Promise<void> {
  const key = String(host || "").trim().toLowerCase();
  if (!key) return;
  const minMs = Math.max(0, Math.floor(minIntervalMs || 0));
  if (minMs <= 0) {
    dashscopeWebparserHostLastAt.set(key, Date.now());
    return;
  }
  const now = Date.now();
  const last = dashscopeWebparserHostLastAt.get(key) ?? 0;
  const delta = now - last;
  if (delta < minMs) {
    await sleep((minMs - delta) + jitterMs(Math.min(500, Math.max(50, Math.floor(minMs / 4)))));
  }
  dashscopeWebparserHostLastAt.set(key, Date.now());
}

function isTransientDashScopeError(err: any): boolean {
  const msg = String(err?.message || err || "");
  return (
    /timeout|timed out|ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch failed|network/i.test(msg) ||
    /rate limit|too many requests/i.test(msg) ||
    /\b429\b|\b500\b|\b502\b|\b503\b|\b504\b/i.test(msg)
  );
}

function isToolNameCompatError(err: any): boolean {
  const msg = String(err?.message || err || "");
  return (
    /method not found/i.test(msg) ||
    /tool not found/i.test(msg) ||
    /unknown tool/i.test(msg) ||
    /no such tool/i.test(msg) ||
    /not\s*supported/i.test(msg) ||
    /invalid\s*tool/i.test(msg) ||
    /\b404\b/.test(msg)
  );
}

function rankWebparserFallbackCandidates(toolNames: string[], currentToolName: string): string[] {
  const current = String(currentToolName || "").trim().toLowerCase();
  const unique = Array.from(
    new Set(
      (toolNames || [])
        .map((t) => String(t || "").trim())
        .filter(Boolean)
        .filter((t) => t.toLowerCase() !== current)
    )
  );

  const score = (name: string): number => {
    const n = name.toLowerCase();

    // 优先级排名：包含 parser 或 web 的工具名优先
    if (/(^|_)web(_|$)/.test(n) && /parser/.test(n)) return 10;
    if (/webparser|web_parser/.test(n)) return 11;
    if (/webpage.*reader|reader.*webpage/.test(n)) return 12;
    if (/parser/.test(n)) return 15;
    if (/webpage|html/.test(n)) return 25;
    return 100;
  };

  return unique.sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    return sa === sb ? a.localeCompare(b) : sa - sb;
  });
}

function normalizeToolName(t: any): string {
  const name = t?.name ?? t?.toolName ?? t?.function?.name;
  return String(name || "").trim();
}

function normalizeToolDesc(t: any): string {
  const desc = t?.description ?? t?.desc ?? t?.function?.description;
  return String(desc || "").trim();
}

function resolveDashScopeToolName(registry: ToolRegistry, requestedToolName: string): { requested: string; resolved: string; reason?: string } {
  const requested = String(requestedToolName || "").trim();
  const lower = requested.toLowerCase();

  // If it's already known, keep it.
  if (registry.hasTool("dashscope" as any, requested)) {
    return { requested, resolved: requested };
  }

  // 从已知工具列表中查找包含相关关键词的工具
  const known = registry
    .getTools("dashscope" as any)
    .map((t) => t.name)
    .filter(Boolean);

  const candidates: string[] = [];

  // WebParser aliases commonly hallucinated by models.
  if (lower === "web_parser" || lower === "webparser" || lower === "web-parser") {
    // 查找包含 parser 的工具
    candidates.push(...known.filter(n => /parser|web.*parse/i.test(n)));
  }

  // Web search aliases.
  if (lower === "web_search" || lower === "websearch" || lower === "web-search" || lower === "search_web") {
    // 查找包含 search 的工具
    candidates.push(...known.filter(n => /search/i.test(n)));
  }

  if (candidates.length === 0) {
    // Generic hint: if user asked for a web parser-ish name, pick best ranked from known list.
    if (/web|html|page|parser/.test(lower)) {
      candidates.push(...rankWebparserFallbackCandidates(known, requested).slice(0, 3));
    }
  }

  for (const c of candidates) {
    if (c && registry.hasTool("dashscope" as any, c)) {
      return { requested, resolved: c, reason: `工具名映射: ${requested} -> ${c}` };
    }
  }

  // 不再使用硬编码回退，直接返回原始请求名
  // 让用户先刷新获取真实工具名
  return { requested, resolved: requested };
}

/**
 * MCP Tool wrapper (Phase 2): allows the model to call an external MCP server tool
 * under strict safety gates:
 * - MCP must be enabled in settings
 * - endpoint must be localhost (enforced by McpClient)
 * - tool must be enabled in Settings -> MCP -> 工具权限（开关）
 * - optional confirm-before-call (uses window.confirm)
 */
export class McpCallTool implements Tool {
  private plugin: any;
  private registry: ToolRegistry;

  constructor(plugin: any) {
    this.plugin = plugin;
    this.registry = new ToolRegistry(plugin);
  }

  definition = {
    name: "mcp_call_tool",
    description:
      "(实验性) 调用 MCP Server 上的工具（本机或 DashScope/百炼远程）。必须先在设置中启用对应 MCP，并在“工具权限（开关）”里刷新工具列表、开启要用的工具。provider 可省略：会自动优先选择已启用的 MCP（移动端优先 DashScope，其次本机）。",
    parameters: {
      type: "object" as const,
      properties: {
        toolName: { type: "string", description: "MCP 工具名（需在设置 → MCP → 工具权限（开关）中开启）" },
        args: { type: "object", description: "传给 MCP 工具的参数对象" },
        callOptions: {
          type: "object",
          description:
            "(可选) 调用策略控制。主要用于 WebParser 类工具：可临时关闭缓存或调整最大输出长度。",
          properties: {
            noCache: {
              type: "boolean",
              description: "为 WebParser 类调用临时禁用 URL 缓存与 in-flight 去重。默认 false。",
            },
            maxOutputChars: {
              type: "number",
              description:
                "为 WebParser 类调用临时覆盖‘最大返回字符数’（1000-500000）。留空则使用设置值。",
            },
            hostMinIntervalMs: {
              type: "number",
              description:
                "为 WebParser 类调用临时覆盖‘同站点最小间隔（ms）’（0-10000）。0 表示关闭限流。留空则使用设置值。",
            },
          },
          required: [],
        },
      },
      required: ["toolName"],
    },
  };

  async execute(
    args: {
      provider?: string;
      toolName: string;
      args?: any;
      callOptions?: { noCache?: boolean; maxOutputChars?: number; hostMinIntervalMs?: number };
    },
    app: App
  ): Promise<string> {
    const settings = this.plugin?.settings;

    // 本地 MCP 功能已移除，默认使用 DashScope
    const inferProvider = (): "dashscope" => {
      return "dashscope";
    };

    const provider = String((args as any)?.provider || inferProvider()).trim();
    
    // 本地 MCP 已移除，如果用户指定 local 则提示使用 DashScope
    if (provider === "local") {
      return "错误: 本地 MCP 功能已移除。请使用 DashScope MCP（provider: dashscope）或直接省略 provider 参数。";
    }
    
    const isDashScope = provider === "dashscope";
    const isGeneric = provider === "generic";
    if (!isDashScope && !isGeneric) {
      try {
        (this.plugin as any).lastMcpCall = {
          provider: provider as any,
          toolName: (args?.toolName || "").trim(),
          args: (args as any)?.args ?? {},
          at: Date.now(),
          ok: false,
          error: `provider 不支持：${provider}`,
        };
      } catch {}
      return `错误: provider 不支持：${provider}（支持 dashscope 或 generic）`;
    }

    const requestedToolName = (args?.toolName || "").trim();
    if (!requestedToolName) {
      try {
        if ((this.plugin as any).lastMcpCall) {
          (this.plugin as any).lastMcpCall.ok = false;
          (this.plugin as any).lastMcpCall.error = "toolName 不能为空";
        }
      } catch {}
      return "错误: toolName 不能为空";
    }

    const resolvedTool =
      provider === "dashscope"
        ? resolveDashScopeToolName(this.registry, requestedToolName)
        : { requested: requestedToolName, resolved: requestedToolName };
    const toolName = resolvedTool.resolved;

    // Track last call for log-panel retry.
    try {
      (this.plugin as any).lastMcpCall = {
        provider: provider as any,
        toolName: requestedToolName,
        toolNameResolved: toolName,
        args: (args as any)?.args ?? {},
        at: Date.now(),
      };
    } catch {
      // ignore
    }

    const ensureAllowed = async (): Promise<boolean> => {
      return await this.registry.ensureAllowed(provider as any, toolName, {
        promptIfDisabled: true,
        autoEnableLocalDesktop: true,
      });
    };

    const allowed = await ensureAllowed();
    if (!allowed) {
      // Minimal interactive recovery: offer one-click refresh/enable/retry.
      try {
        const label = resolvedTool?.reason ? `${toolName}（由 ${requestedToolName} 映射）` : toolName;
        safeNotice(`🔐 需要开启 MCP 工具：${label}`, 4000);
        const ok = await McpToolAuthorizeModal.openAndWait(app, this.plugin, provider as any, toolName);
        if (ok) {
          // Re-check after user action.
          const allowedAfter = await this.registry.ensureAllowed(provider as any, toolName, {
            promptIfDisabled: false,
            autoEnableLocalDesktop: true,
          });
          if (allowedAfter) {
            safeNotice(`✅ 已开启工具，正在继续：${toolName}`, 3000);
          }
        }
      } catch {
        // best-effort; ignore modal failures
      }

      // If still not allowed, return a helpful error with a tool summary.
      const summary = this.registry.formatToolsSummary(provider as any, { maxItems: 25, includeDisabled: true });
      const hint = "请先使用 mcp_list_tools 获取可用工具列表，确认正确的工具名。";
      const mappedLine =
        resolvedTool?.reason && requestedToolName !== toolName
          ? `\n（已自动将工具名 ${requestedToolName} 映射为 ${toolName}）\n`
          : "\n";
      return (
        `错误: MCP 工具未被允许：${toolName}\n` +
        mappedLine +
        `已尝试自动刷新工具列表，仍未找到或未开启。请在设置 → MCP → “工具权限（开关）”中刷新并开启，或确认工具名。\n` +
        `\n当前 provider（${provider}）的工具列表摘要：\n${summary}\n` +
        hint
      );
    }

    if (settings.mcpConfirmBeforeCall) {
      const ok = window.confirm(
        `即将调用 MCP 工具：${toolName}\n\nProvider: ${provider}\n\n是否继续？`
      );
      if (!ok) {
        try {
          if ((this.plugin as any).lastMcpCall) {
            (this.plugin as any).lastMcpCall.ok = false;
            (this.plugin as any).lastMcpCall.error = "用户取消";
          }
        } catch {}
        return "已取消: 用户拒绝 MCP 工具调用";
      }
    }

    let res: any;
    let outText: string | undefined;
    
    // ─── Generic MCP Provider ───────────────────────────
    if (isGeneric) {
      const server = this.registry.getGenericServerByTool(toolName);
      if (!server) {
        return `错误: 未找到工具 ${toolName} 所属的通用 MCP 服务器。请在设置 → MCP → "通用 MCP 服务器"中添加并刷新工具列表。`;
      }
      const client = new GenericMcpClient({
        endpoint: server.endpoint,
        authHeader: server.authHeader,
        timeoutMs: 60000,
      });
      try {
        await client.initialize().catch(() => {});
        const toolArgs = (args as any)?.args ?? {};
        res = await client.callTool(toolName, toolArgs);
      } catch (e: any) {
        try {
          if ((this.plugin as any).lastMcpCall) {
            (this.plugin as any).lastMcpCall.ok = false;
            (this.plugin as any).lastMcpCall.error = e?.message || String(e);
          }
        } catch {}
        return `错误: 通用 MCP 工具调用失败（${server.name} / ${toolName}）：${e?.message || String(e)}`;
      }

      try {
        if ((this.plugin as any).lastMcpCall) {
          (this.plugin as any).lastMcpCall.ok = true;
        }
      } catch {}

      try {
        return JSON.stringify(res, null, 2);
      } catch {
        return String(res);
      }
    }

    // ─── DashScope MCP Provider ────────────────────────
    // 本地 MCP 功能已移除，只保留 DashScope MCP
    if (!settings?.enableDashScopeMcp) {
      return "错误: DashScope MCP 未启用。请在设置中开启 DashScope MCP。";
    }

    const dashTools = this.registry.getTools("dashscope");
    const toolMeta = dashTools.find((t) => String(t.name || "").trim() === toolName);

    // 优先使用新的服务结构获取 endpoint
    const endpoint = this.registry.getToolEndpoint("dashscope", toolName) 
      || String((toolMeta as any)?.endpoint || settings.dashScopeMcpEndpoint || "").trim();
    if (!endpoint) {
      return "错误: 未找到可用的 DashScope MCP endpoint。请点击“刷新 DashScope 工具”或手动填写正确的服务地址（如 WebParser 的 /sse 或 /mcp）。";
    }

    const apiKey = (settings.dashScopeApiKey || "").trim();
    if (!apiKey) {
      return "错误: DashScope API Key 为空。请在设置中填写 DASHSCOPE_API_KEY";
    }

    const allowedHosts: string[] = []; // 白名单已移除

    const client = new DashScopeMcpClient({ endpoint, apiKey, allowedHosts });
    // 能用优先：WebParser 固定走 REST，不依赖 initialize/listTools。
    // initialize 对部分部署会触发 method not found 或增加等待时间。
    const shouldInit = !isLikelyWebParserToolName(toolName);
    if (shouldInit) await client.initialize().catch(() => {});

    const toolArgs = (args as any)?.args ?? {};
    const callOptions = (args as any)?.callOptions ?? {};
    const noCache = Boolean((callOptions as any)?.noCache);
    const cacheKey = noCache ? "" : buildWebparserCacheKey("dashscope", toolName, toolArgs);
    const hostKey = cacheKey ? getHostFromWebparserArgs(toolArgs) : "";
      const hostMinIntervalMs = clampWebparserHostMinIntervalMs(
        (callOptions as any)?.hostMinIntervalMs ??
          settings?.dashScopeWebParserHostMinIntervalMs ??
          DEFAULT_DASHSCOPE_WEBPARSER_HOST_MIN_INTERVAL_MS
      );
      const maxOutChars = clampWebparserMaxOutputChars(
        (callOptions as any)?.maxOutputChars ?? settings?.dashScopeWebParserMaxOutputChars
      );
      if (cacheKey) {
        const cached = dashscopeWebparserCache.get(cacheKey);
        if (cached && Date.now() - cached.at < DASHSCOPE_WEBPARSER_CACHE_TTL_MS) {
          outText = cached.value;
          touchCacheEntry(cacheKey);
        } else {
          dashscopeWebparserCache.delete(cacheKey);
        }
      }

      if (!outText && cacheKey) {
        const inflight = dashscopeWebparserInFlight.get(cacheKey);
        if (inflight) {
          try {
            outText = await withTimeout(inflight, DASHSCOPE_WEBPARSER_HARD_TIMEOUT_MS, "DashScope WebParser in-flight");
          } catch {
            // If the previous in-flight got stuck (e.g. outer tool timeout), drop it and retry.
            dashscopeWebparserInFlight.delete(cacheKey);
          }
        }
      }

      if (!outText) {
        const enabledWebTools = this.registry
          .getTools("dashscope")
          .filter((t) => t.enabled)
          .map((t) => t.name)
          .filter((n) => isLikelyWebParserToolName(n));

        const callWithRetries = async (name: string) => {
          const doCall = async () => {
            // Serialize WebParser calls; leave other tools unaffected.
            if (cacheKey) {
              return await runWithHostLock(hostKey, async () => {
                await enforceHostMinInterval(hostKey, hostMinIntervalMs);
                if (isLikelyWebParserToolName(name)) {
                  // 能用优先：WebParser 直接 REST 调用
                  return await client.callToolPreferRest(name, toolArgs);
                }
                return await client.callTool(name, toolArgs);
              });
            }
            if (isLikelyWebParserToolName(name)) {
              return await client.callToolPreferRest(name, toolArgs);
            }
            return await client.callTool(name, toolArgs);
          };

          let attempt = 0;
          while (true) {
            try {
              const r = await doCall();

              // Some MCP backends return error-like objects instead of throwing.
              // For WebParser we treat these as failures so retries / tool-name fallback can kick in.
              const hint = getWebparserErrorHintIfAny(r);
              if (hint) {
                if (isToolNameCompatError(hint)) throw new Error(hint);
                if (isTransientDashScopeError(hint)) throw new Error(hint);
              }

              return r;
            } catch (e: any) {
              attempt += 1;
              if (!cacheKey || attempt > 2 || !isTransientDashScopeError(e)) throw e;
              // 对 429 限流使用更长的退避时间：3秒、8秒（加上随机抖动）
              const is429 = /429|rate.?limit|too many requests/i.test(String(e?.message || ""));
              const base = is429 ? (attempt === 1 ? 3000 : 8000) : (attempt === 1 ? 500 : 1500);
              await sleep(base + jitterMs(base));
            }
          }
        };

        const promise = (async () => {
          try {
            // 能用优先：对“泛 WebParser 名称”，强制落到 bailian_web_parser。
            const primary = isLikelyWebParserToolName(toolName) ? "bailian_web_parser" : toolName;
            return await callWithRetries(primary);
          } catch (e: any) {
            // Tool-name compatibility fallback: only for likely WebParser calls.
            if (!cacheKey || !isToolNameCompatError(e)) throw e;

            // Try up to 2 alternative enabled WebParser-like tools.
            const candidates = rankWebparserFallbackCandidates(enabledWebTools, toolName).slice(0, 2);
            if (candidates.length === 0) {
              const summary = this.registry.formatToolsSummary("dashscope" as any, { maxItems: 25, includeDisabled: true });
              return (
                `错误: WebParser 工具名可能不兼容：${toolName}\n` +
                `原因: ${String(e?.message || e || "")}\n\n` +
                `当前未找到其它已开启的 WebParser 相关工具可用于自动降级。\n` +
                `请在设置 → MCP → “工具权限（开关）”中刷新并开启 WebParser 相关工具后重试。\n\n` +
                `DashScope 工具列表摘要：\n${summary}`
              );
            }
            for (const alt of candidates) {
              try {
                const r = await callWithRetries(alt);
                // Make it explicit we used a fallback tool name.
                (r as any).__fallback_tool_used = alt;
                return r;
              } catch {
                // continue
              }
            }

            throw e;
          }
        })();

        if (cacheKey) {
          const inflight = withTimeoutAndDebug(
            promise.then((r) => {
              const used = String((r as any)?.__fallback_tool_used || "").trim();
              const formatted = formatWebparserOutput(r, { maxChars: maxOutChars, fallbackToolUsed: used || undefined });
              if (formatted.length <= DASHSCOPE_WEBPARSER_CACHE_MAX_CHARS) {
                dashscopeWebparserCache.set(cacheKey, { at: Date.now(), value: formatted });
                enforceCacheLimit();
              }
              return formatted;
            }),
            DASHSCOPE_WEBPARSER_HARD_TIMEOUT_MS,
            "DashScope WebParser",
            () => client.getLastDebugInfo()
          );
          dashscopeWebparserInFlight.set(cacheKey, inflight);
        }

        try {
          res = await withTimeoutAndDebug(promise, DASHSCOPE_WEBPARSER_HARD_TIMEOUT_MS, "DashScope WebParser", () => client.getLastDebugInfo());
        } finally {
          if (cacheKey) dashscopeWebparserInFlight.delete(cacheKey);
        }
      }

    try {
      if ((this.plugin as any).lastMcpCall) {
        (this.plugin as any).lastMcpCall.ok = true;
      }
    } catch {
      // ignore
    }

    if (outText !== undefined) return outText;

    // WebParser-like dashscope calls can be huge: summarize + cap output.
    try {
      const used = String((res as any)?.__fallback_tool_used || "").trim();
      if (provider === "dashscope" && buildWebparserCacheKey("dashscope", toolName, (args as any)?.args ?? {})) {
        const maxOutChars = clampWebparserMaxOutputChars(settings?.dashScopeWebParserMaxOutputChars);
        const formatted = formatWebparserOutput(res, { maxChars: maxOutChars, fallbackToolUsed: used || undefined });

        // Extra fallback: if WebParser returns empty-ish output, guide the user/model to retry with enabled tools.
        if (isEffectivelyEmptyWebparserOutput(formatted)) {
          const errorHint = looksLikeWebparserErrorObject(res);
          const enabledWebTools = this.registry
            .getTools("dashscope")
            .filter((t) => t.enabled)
            .map((t) => t.name)
            .filter((n) => isLikelyWebParserToolName(n));

          const toolsLine = enabledWebTools.length
            ? enabledWebTools.slice(0, 15).map((x) => `- ${x}`).join("\n")
            : "(empty)";

          return (
            `⚠️ WebParser 返回结果为空或不可解析。\n` +
            (errorHint ? `提示：${errorHint}\n` : "") +
            `\n建议：\n` +
            `- 确认 URL 可访问（需要登录/反爬/跳转可能导致空结果）\n` +
            `- 在设置 → MCP → 工具权限（开关）中刷新并开启正确的 WebParser 工具\n` +
            `- 重试一次（已内置短退避重试）\n` +
            `\n当前已开启的 DashScope WebParser 相关工具：\n${toolsLine}`
          );
        }

        return formatted;
      }
    } catch {}

    // Avoid returning huge blobs. But keep it simple for now.
    try {
      return JSON.stringify(res, null, 2);
    } catch {
      return String(res);
    }
  }
}

/**
 * MCP discovery tool: lists tools from enabled MCP providers (local/dashscope)
 * and annotates whether each tool is enabled by Settings -> MCP -> 工具权限（开关）.
 */
export class McpListToolsTool implements Tool {
  private plugin: any;
  private registry: ToolRegistry;

  constructor(plugin: any) {
    this.plugin = plugin;
    this.registry = new ToolRegistry(plugin);
  }

  definition = {
    name: "mcp_list_tools",
    description:
      "列出已启用的 MCP（本机/ DashScope）可用工具及其说明，并标注是否已在“工具权限（开关）”中开启。用于让智能体确认工具名与用途。",
    parameters: {
      type: "object" as const,
      properties: {
        
      },
      required: [],
    },
  };

  async execute(args: { provider?: string }, app: App): Promise<string> {
    const settings = this.plugin?.settings;
    const isEnabled = (provider: any, name: string) => this.registry.isEnabled(provider as any, name);

    const isMobile = Platform.isMobile;

    const want = String((args as any)?.provider || "").trim();
    const providers: Array<"local" | "dashscope" | "generic"> = [];

    const localEnabled = Boolean(settings?.enableMcp) && String(settings?.mcpEndpoint || "").trim().length > 0;
    // 简化检查：只要启用且有 API Key 即可（endpoint 从服务列表获取）
    const dashEnabled =
      Boolean(settings?.enableDashScopeMcp) &&
      String(settings?.dashScopeApiKey || "").trim().length > 0;

    if (want === "local") {
      if (isMobile) {
        return "错误: 移动端无法使用本机 MCP（127.0.0.1 指向手机/平板本机）。请改用 DashScope MCP，或在桌面端使用本机 MCP。";
      }
      providers.push("local");
    } else if (want === "dashscope") {
      providers.push("dashscope");
    } else if (want === "generic") {
      providers.push("generic");
    } else {
      // On mobile, skip local by default to avoid noisy connect errors.
      if (!isMobile && localEnabled) providers.push("local");
      if (dashEnabled) providers.push("dashscope");
      // 通用 MCP 服务器只要有配置就加入
      const genericServers = this.registry.getGenericServers().filter(s => s.enabled);
      if (genericServers.length > 0) providers.push("generic");
    }

    if (providers.length === 0) {
      return "错误: 未启用任何 MCP 服务。请在设置中开启 DashScope MCP 或添加通用 MCP 服务器。";
    }

    if (settings?.mcpConfirmBeforeCall) {
      const ok = window.confirm(
        `即将获取 MCP 工具列表（list_tools）\n\nProviders: ${providers.join(", ")}\n\n是否继续？`
      );
      if (!ok) return "已取消: 用户拒绝获取 MCP 工具列表";
    }

    const outLines: string[] = [];
    outLines.push("MCP 工具列表（含工具权限/开关状态）：");
    outLines.push("");

    for (const p of providers) {
      try {
        if (p === "local") {
          if (!localEnabled) {
            outLines.push("- Provider local: 未启用或 endpoint 为空");
            outLines.push("");
            continue;
          }
          const endpoint = String(settings?.mcpEndpoint || "").trim();
          const client = new McpClient(endpoint);
          const res = await client.listTools();
          const tools = Array.isArray(res?.tools) ? res.tools : [];
          outLines.push(`- Provider local (${endpoint})`);
          for (const t of tools) {
            const name = normalizeToolName(t);
            if (!name) continue;
            const desc = normalizeToolDesc(t);
            const enabled = isEnabled("local", name) ? "✅已开启" : "❌未开启";
            outLines.push(`  - ${name} ${enabled}${desc ? `: ${desc}` : ""}`);
          }
          outLines.push("");
          continue;
        }

        // dashscope
        if (p === "generic") {
          // 通用 MCP 服务器
          const servers = this.registry.getGenericServers().filter(s => s.enabled);
          if (servers.length === 0) {
            outLines.push("- Provider generic: 未配置或未启用任何通用 MCP 服务器");
            outLines.push("");
            continue;
          }
          outLines.push(`- Provider generic (${servers.length} 个通用 MCP 服务器)`);
          for (const server of servers) {
            const statusIcon = server.lastStatus === 'ok' ? '✅' : server.lastStatus === 'error' ? '❌' : '❓';
            outLines.push(`  📦 服务器: ${server.name} ${statusIcon} (${server.endpoint})`);
            if (server.description) {
              outLines.push(`     描述: ${server.description}`);
            }
            if (server.tools && server.tools.length > 0) {
              for (const tool of server.tools) {
                const toolEnabled = isEnabled("generic", tool.name) ? "✅已开启" : "❌未开启";
                outLines.push(`     🔧 工具名: "${tool.name}" ${toolEnabled}${tool.description ? ` - ${tool.description}` : ""}`);
                if (tool.inputSchema?.properties) {
                  const params = Object.keys(tool.inputSchema.properties).join(", ");
                  if (params) {
                    outLines.push(`        参数: ${params}`);
                  }
                }
              }
            } else {
              outLines.push(`     (未获取到工具，请刷新)`);
            }
            if (server.lastError) {
              outLines.push(`     最后错误: ${server.lastError}`);
            }
          }
          outLines.push("");
          continue;
        }

        if (!dashEnabled) {
          outLines.push("- Provider dashscope: 未启用或 endpoint/API Key 为空");
          outLines.push("");
          continue;
        }

        // 能用优先：DashScope 端点常见 listTools 方法不可用（-32601）。
        // 这里不再请求远端 listTools，直接展示本地缓存（包含内置回退清单）。
        try {
          await this.registry.maybeAutoRefresh("dashscope" as any);
        } catch {
          // ignore
        }
        
        // 获取服务列表（新结构）
        const services = this.registry.getServices("dashscope" as any);
        const tools = this.registry.getTools("dashscope" as any);
        
        outLines.push(`- Provider dashscope (${services.length} 个服务)`);
        if (services.length === 0 && tools.length === 0) {
          outLines.push("  - (empty)");
        } else if (services.length > 0) {
          // 展示服务和工具，重点强调工具名才是调用时使用的名称
          for (const svc of services) {
            const enabled = svc.enabled ? "✅" : "❌";
            outLines.push(`  📦 服务: ${svc.name} ${enabled}`);
            if (svc.tools && svc.tools.length > 0) {
              for (const tool of svc.tools) {
                outLines.push(`     🔧 工具名: "${tool.name}" - ${tool.description || svc.description}`);
                if (tool.inputSchema) {
                  const params = tool.inputSchema?.properties ? Object.keys(tool.inputSchema.properties).join(", ") : "";
                  if (params) {
                    outLines.push(`        参数: ${params}`);
                  }
                }
              }
            } else {
              outLines.push(`     (无工具信息)`);
            }
          }
          outLines.push("");
          outLines.push("  ⚠️ 重要：调用 mcp_call_tool 时，tool_name 必须使用上面的「工具名」（如 bailian_web_search），而不是服务名！");
        } else {
          // 回退到旧的工具列表展示
          for (const t of tools) {
            const name = String(t?.name || "").trim();
            if (!name) continue;
            const desc = String((t as any)?.description || "").trim();
            const ep = String((t as any)?.endpoint || "").trim();
            const enabled = isEnabled("dashscope", name) ? "✅已开启" : "❌未开启";
            outLines.push(`  - ${name} ${enabled}${desc ? `: ${desc}` : ""}${ep ? `\n    endpoint: ${ep}` : ""}`);
          }
        }
        outLines.push("");
      } catch (e: any) {
        outLines.push(`- Provider ${p}: 获取失败：${e?.message || String(e)}`);
        outLines.push("");
      }
    }

    outLines.push("提示：若某个工具显示 ❌未开启，请到设置 → MCP → “工具权限（开关）”中刷新并开启对应工具。");
    return outLines.join("\n");
  }
}
