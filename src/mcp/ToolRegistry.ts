import { Platform, requestUrl } from "obsidian";
import { McpClient } from "./McpClient";
import { DashScopeMcpClient } from "./DashScopeMcpClient";
import { GenericMcpClient } from "./GenericMcpClient";
import type { McpService, McpToolDefinition, McpProvider, McpServerConfig } from "../core/settings";

export interface McpToolItem {
  provider: McpProvider;
  name: string;
  description?: string;
  enabled: boolean;
  endpoint?: string;
  lastSeenAt?: number;
}

const STALE_MS = 24 * 3600 * 1000;
const THROTTLE_MS = 60 * 1000;
const DASHSCOPE_DIRECTORY_URL = "https://dashscope.aliyuncs.com/api/v1/mcps/user/list?pageNo=1&pageSize=100";

// Fallback services when directory API fails
const DASHSCOPE_FALLBACK_SERVICES: McpService[] = [
  {
    id: "WebParser",
    name: "网页解析",
    description: "百炼 WebParser：解析网页内容",
    endpoint: "https://dashscope.aliyuncs.com/api/v1/mcps/WebParser/sse",
    enabled: true,
    provider: "dashscope",
    tools: [],  // 从服务器获取真实工具名
  },
  {
    id: "WebSearch",
    name: "联网搜索",
    description: "百炼 WebSearch：联网搜索",
    endpoint: "https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/sse",
    enabled: true,
    provider: "dashscope",
    tools: [],  // 从服务器获取真实工具名
  },
];

function isDashscopeListToolsUnsupported(err: any): boolean {
  const msg = String(err?.message || err || "");
  return (
    /method not found/i.test(msg) ||
    /-32601/.test(msg) ||
    /mcp\.list_tools/i.test(msg) ||
    /tools\/list/i.test(msg)
  );
}

/**
 * 将驼峰命名转为蛇形命名 (WebSearch -> web_search, QwenImage -> qwen_image)
 */
function camelToSnake(str: string): string {
  return str
    .replace(/([A-Z])/g, "_$1")
    .toLowerCase()
    .replace(/^_/, "")
    .replace(/_+/g, "_");
}

export class ToolRegistry {
  private plugin: any;
  private lastAutoRefresh: Record<McpProvider, number> = { local: 0, dashscope: 0, generic: 0 };

  constructor(plugin: any) {
    this.plugin = plugin;
  }

  /**
   * 从 DashScope 目录 API 拉取用户已启用的 MCP 服务列表
   */
  private async fetchDashScopeDirectory(): Promise<McpService[]> {
    const apiKey = String(this.settings?.dashScopeApiKey || "").trim();
    if (!apiKey) throw new Error("DashScope API Key 为空");

    const res = await requestUrl({
      url: DASHSCOPE_DIRECTORY_URL,
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      throw: false,
    });

    if (res.status && res.status >= 400) {
      const body = typeof res.text === "string" ? res.text.slice(0, 200) : "";
      throw new Error(`DashScope MCP 列表接口返回 ${res.status}${body ? `: ${body}` : ""}`);
    }

    const raw = (res as any)?.json ?? (() => {
      try {
        return JSON.parse(typeof res.text === "string" ? res.text : "{}");
      } catch {
        return null;
      }
    })();

    const list = (raw as any)?.data || (raw as any)?.result || raw;
    if (!Array.isArray(list)) throw new Error("DashScope MCP 列表响应格式异常（缺少 data 数组）");

    // 调试：打印原始响应以便查看结构

    // 将 API 返回的数据转换为 McpService 结构
    const services = list
      .map((item: any): McpService | null => {
        // 调试：打印每个 item 的关键字段
        
        const id = String(item?.id || item?.mcpId || item?.name || "").trim();
        const name = String(item?.name || item?.mcpName || id).trim();
        const endpoint = String(item?.operationalUrl || item?.sseUrl || item?.endpoint || item?.baseUrl || "").trim();
        
        if (!id || !endpoint) return null;

        // 不在这里生成工具名，让 refresh 方法通过 fetchServiceTools 获取真实工具列表
        // 如果 fetchServiceTools 失败，会在 refresh 方法中生成回退工具名

        return {
          id,
          name,
          description: String(item?.description || item?.desc || "").trim(),
          endpoint,
          enabled: true,
          provider: "dashscope" as McpProvider,
          tools: [],  // 留空，让 refresh 方法去获取
          lastSeenAt: Date.now(),
        };
      })
      .filter((s): s is McpService => s !== null);

    return services;
  }

  /**
   * 对单个服务的 endpoint 调用 tools/list 获取真正的工具列表
   * 使用正确的 MCP SSE 协议流程：
   * 1. GET /sse 建立 SSE 连接
   * 2. 接收 endpoint 事件获取 sessionId
   * 3. POST /message?sessionId=xxx 发送 JSON-RPC 消息
   * 4. 从 SSE 流中读取响应
   * 包含 429 限流重试机制（指数退避：5s, 10s）
   */
  private async fetchServiceTools(service: McpService, retryCount = 0): Promise<McpToolDefinition[]> {
    const apiKey = String(this.settings?.dashScopeApiKey || "").trim();
    if (!apiKey) return [];

    const maxRetries = 2;
    const timeoutMs = 30000;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

    try {
      // 如果是重试，先等待（更长的指数退避：5s, 10s）
      if (retryCount > 0) {
        const backoffMs = [5000, 10000][retryCount - 1] || 10000;
        await new Promise(r => setTimeout(r, backoffMs));
      }


      // 步骤1: GET 请求建立 SSE 连接
      const sseResponse = await fetch(service.endpoint!, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Accept": "text/event-stream",
          "Cache-Control": "no-cache",
        },
        signal: controller.signal,
      });

      // 处理 429 限流
      if (sseResponse.status === 429) {
        if (retryCount < maxRetries) {
          window.clearTimeout(timeout);
          console.warn(`[MCP] 服务 ${service.id} 遇到 429 限流 (Too Many Requests)，将在下次重试前等待更长时间...`);
          return await this.fetchServiceTools(service, retryCount + 1);
        }
        console.warn(`[MCP] 服务 ${service.id} 多次限流 (429)，跳过。请稍后再刷新工具列表。`);
        return [];
      }

      if (!sseResponse.ok) {
        const errorText = await sseResponse.text().catch(() => "");
        console.warn(`[MCP] SSE 连接失败 ${sseResponse.status}: ${errorText.slice(0, 200)}`);
        return [];
      }

      const reader = sseResponse.body?.getReader();
      if (!reader) return [];

      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let messageEndpoint: string | null = null;
      const tools: McpToolDefinition[] = [];
      let toolsReceived = false;

      // 解析 SSE 事件的函数
      const processLines = (lines: string[]): boolean => {
        let currentEventType = "";
        
        for (const line of lines) {
          if (line.startsWith("event:")) {
            currentEventType = line.slice("event:".length).trim();
            continue;
          }
          
          if (line.startsWith("data:")) {
            const data = line.slice("data:".length).trim();
            if (!data) continue;


            // 检查是否是 endpoint 事件
            if (currentEventType === "endpoint" || (!messageEndpoint && (data.includes("sessionId") || data.includes("/message")))) {
              let url = data;
              try {
                const json = JSON.parse(data);
                url = json.url || json.endpoint || data;
              } catch {
                // 不是 JSON，直接使用原始数据
              }
              
              if (url.startsWith("/") || url.startsWith("http")) {
                try {
                  const baseUrl = new URL(service.endpoint);
                  messageEndpoint = url.startsWith("http") ? url : `${baseUrl.origin}${url}`;
                } catch (e) {
                  console.warn(`[MCP] 解析消息端点失败:`, e);
                }
              }
              continue;
            }

            // 尝试解析 JSON-RPC 响应
            try {
              const json = JSON.parse(data);
              
              // 检查是否是 initialize 响应
              if (json?.result?.protocolVersion || json?.result?.serverInfo) {
                initCompleted = true;
                continue;
              }
              
              // 检查是否是 tools/list 响应
              if (json?.result?.tools && Array.isArray(json.result.tools)) {
                for (const t of json.result.tools) {
                  tools.push({
                    name: String(t?.name || "").trim(),
                    description: String(t?.description || "").trim(),
                    inputSchema: t?.inputSchema || undefined,
                  });
                }
                toolsReceived = true;
                return true; // 停止解析
              }
              
              // 检查错误响应
              if (json?.error) {
                console.warn(`[MCP] 收到错误响应:`, json.error);
              }
            } catch {
              // 不是 JSON，忽略
            }
          }
        }
        return false;
      };

      // 步骤2-4: 读取 SSE 流，获取 endpoint，发送请求，接收响应
      let initSent = false;
      let initCompleted = false;
      let listSent = false;
      
      while (!controller.signal.aborted && !toolsReceived) {
        const { value, done } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";

        // 处理收到的行
        if (processLines(lines)) {
          break; // 收到工具列表，退出
        }

        // 如果已获取到消息端点但还没发送初始化请求
        if (messageEndpoint && !initSent) {
          initSent = true;
          
          // 发送 initialize 请求
          const initPayload = {
            jsonrpc: "2.0",
            id: `init-${Date.now()}`,
            method: "initialize",
            params: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: { listChanged: true } },
              clientInfo: { name: "AI Chat Assistant", version: "1.0.0" }
            }
          };

          
          fetch(messageEndpoint, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(initPayload),
          }).catch(e => console.warn(`[MCP] initialize POST 失败:`, e));
        }

        // 如果初始化完成但还没发送 tools/list 请求
        if (initCompleted && !listSent) {
          listSent = true;
          
          // 等待一下再发送，避免请求太密集
          await new Promise(r => setTimeout(r, 500));
          
          // 先发送 initialized 通知
          fetch(messageEndpoint!, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              method: "notifications/initialized"
            }),
          }).catch(e => console.warn(`[MCP] initialized 通知失败:`, e));
          
          // 稍等一下再发送 tools/list
          await new Promise(r => setTimeout(r, 500));
          
          // 发送 tools/list 请求
          const listToolsPayload = {
            jsonrpc: "2.0",
            id: `list-${Date.now()}`,
            method: "tools/list",
            params: null
          };

          
          fetch(messageEndpoint!, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(listToolsPayload),
          }).catch(e => console.warn(`[MCP] tools/list POST 失败:`, e));
        }
      }

      reader.releaseLock();
      return tools.filter(t => t.name);

    } catch (e: any) {
      if (e.name === "AbortError") {
        console.warn(`[MCP] 获取服务 ${service.id} 工具列表超时`);
      } else {
        console.warn(`[MCP] 获取服务 ${service.id} 工具列表失败:`, e);
      }
      return [];
    } finally {
      window.clearTimeout(timeout);
    }
  }

  private get settings() {
    return this.plugin?.settings || {};
  }

  private ensureServices() {
    if (!Array.isArray(this.settings.mcpServices)) {
      this.settings.mcpServices = [];
    }
  }

  // 兼容旧代码的方法
  private ensureList() {
    if (!Array.isArray(this.settings.mcpTools)) this.settings.mcpTools = [];
    this.ensureServices();
  }

  private normalizeToolName(t: any): string {
    const name = t?.name ?? t?.toolName ?? t?.function?.name;
    return String(name || "").trim();
  }

  private normalizeToolDesc(t: any): string {
    const desc = t?.description ?? t?.desc ?? t?.function?.description;
    return String(desc || "").trim();
  }

  private mergeTools(provider: McpProvider, tools: any[]) {
    this.ensureList();
    const now = Date.now();
    const key = (p: McpProvider, n: string) => `${p}::${n}`;
    const map = new Map<string, McpToolItem>();

    for (const item of this.settings.mcpTools as McpToolItem[]) {
      if (!item) continue;
      const name = String(item.name || "").trim();
      const p = String((item as any).provider || "").trim() as McpProvider;
      if (!name || (p !== "local" && p !== "dashscope" && p !== "generic")) continue;
      map.set(key(p, name), {
        provider: p,
        name,
        description: String((item as any).description || ""),
        enabled: Boolean((item as any).enabled),
        endpoint: String((item as any).endpoint || ""),
        lastSeenAt: Number((item as any).lastSeenAt || 0),
      });
    }

    for (const t of tools || []) {
      const name = this.normalizeToolName(t);
      if (!name) continue;
      const desc = this.normalizeToolDesc(t);
      const k = key(provider, name);
      const existing = map.get(k);
      if (existing) {
        existing.description = desc || existing.description || "";
        existing.endpoint = String((t as any)?.endpoint || existing.endpoint || "");
        existing.lastSeenAt = now;
        map.set(k, existing);
      } else {
        map.set(k, {
          provider,
          name,
          description: desc || "",
          enabled: false,
          endpoint: String((t as any)?.endpoint || ""),
          lastSeenAt: now,
        });
      }
    }

    this.settings.mcpTools = Array.from(map.values()).sort((a, b) => {
      if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
      return a.name.localeCompare(b.name);
    });
  }

  isEnabled(provider: McpProvider, toolName: string): boolean {
    const items = Array.isArray(this.settings?.mcpTools) ? this.settings.mcpTools : [];
    return items.some(
      (x: any) =>
        String(x?.provider || "").trim() === provider &&
        String(x?.name || "").trim() === toolName &&
        Boolean(x?.enabled)
    );
  }

  hasTool(provider: McpProvider, toolName: string): boolean {
    const items = Array.isArray(this.settings?.mcpTools) ? this.settings.mcpTools : [];
    return items.some(
      (x: any) => String(x?.provider || "").trim() === provider && String(x?.name || "").trim() === toolName
    );
  }

  getTools(provider?: McpProvider): McpToolItem[] {
    const items = Array.isArray(this.settings?.mcpTools) ? (this.settings.mcpTools as any[]) : [];
    const normalized: McpToolItem[] = items
      .map((x: any) => ({
        provider: String(x?.provider || '').trim() as McpProvider,
        name: String(x?.name || '').trim(),
        description: String(x?.description || '').trim(),
        enabled: Boolean(x?.enabled),
        endpoint: String(x?.endpoint || '').trim(),
        lastSeenAt: Number(x?.lastSeenAt || 0),
      }))
      .filter((x: any) => x.name && (x.provider === 'local' || x.provider === 'dashscope'));

    const filtered = provider ? normalized.filter(x => x.provider === provider) : normalized;
    return filtered.sort((a, b) => {
      if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
      return a.name.localeCompare(b.name);
    });
  }

  formatToolsSummary(provider: McpProvider, opts?: { maxItems?: number; includeDisabled?: boolean }): string {
    const maxItems = Math.max(1, Math.min(200, opts?.maxItems ?? 30));
    const includeDisabled = opts?.includeDisabled !== false;

    const list = this.getTools(provider)
      .filter(t => includeDisabled ? true : t.enabled)
      .slice(0, maxItems);

    if (list.length === 0) return '(empty)';

    const lines: string[] = [];
    for (const t of list) {
      const flag = t.enabled ? '✅已开启' : '❌未开启';
      const desc = t.description ? `: ${t.description}` : '';
      lines.push(`- ${t.name} ${flag}${desc}`);
    }
    return lines.join('\n');
  }

  getLastSeen(provider: McpProvider): number | null {
    const list = Array.isArray(this.settings?.mcpTools) ? this.settings.mcpTools : [];
    const ts = list
      .filter((x: any) => String(x?.provider || "").trim() === provider)
      .map((x: any) => Number(x?.lastSeenAt || 0))
      .filter((n: number) => n > 0);
    if (!ts.length) return null;
    return Math.max(...ts);
  }

  private normalizeListAndSave = async () => {
    this.ensureList();
    const key = (p: string, n: string) => `${p}::${n}`;
    const map = new Map<string, any>();
    for (const item of this.settings.mcpTools as any[]) {
      if (!item) continue;
      const provider = String(item?.provider || "").trim();
      const name = String(item?.name || "").trim();
      if (!name || (provider !== "local" && provider !== "dashscope" && provider !== "generic")) continue;
      const k = key(provider, name);
      if (map.has(k)) {
        const ex = map.get(k);
        map.set(k, {
          provider,
          name,
          description: ex.description || String(item?.description || ""),
          enabled: Boolean(ex.enabled) || Boolean(item?.enabled),
          endpoint: String(ex.endpoint || item?.endpoint || ""),
          lastSeenAt: Math.max(Number(ex.lastSeenAt || 0), Number(item?.lastSeenAt || 0)),
        });
      } else {
        map.set(k, {
          provider,
          name,
          description: String(item?.description || ""),
          enabled: Boolean(item?.enabled),
          endpoint: String(item?.endpoint || ""),
          lastSeenAt: Number(item?.lastSeenAt || 0),
        });
      }
    }
    this.settings.mcpTools = Array.from(map.values()).sort((a: any, b: any) => {
      if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
      return a.name.localeCompare(b.name);
    });
    await this.plugin?.saveSettings?.();
  };

  async refresh(provider: McpProvider): Promise<void> {
    const settings = this.settings;
    if (provider === "local") {
      if (Platform.isMobile) throw new Error("移动端无法刷新本机 MCP（127.0.0.1 指向手机本机）");
      if (!settings.enableMcp) throw new Error("本机 MCP 未启用");
      const endpoint = String(settings.mcpEndpoint || "").trim();
      if (!endpoint) throw new Error("MCP Endpoint 为空");
      const client = new McpClient(endpoint);
      const res = await client.listTools();
      const tools = Array.isArray((res as any)?.tools) ? (res as any).tools : [];
      this.mergeTools("local", tools);
      await this.normalizeListAndSave();
      return;
    }

    if (provider === "generic") {
      await this.refreshAllGenericServers();
      return;
    }

    // DashScope: 使用目录 API 拉取服务列表
    if (!settings.enableDashScopeMcp) throw new Error("DashScope MCP 未启用");
    
    let services: McpService[];
    try {
      services = await this.fetchDashScopeDirectory();
    } catch (e) {
      // 如果目录 API 失败，使用内置回退服务
      services = DASHSCOPE_FALLBACK_SERVICES;
    }

    if (!services || services.length === 0) {
      services = DASHSCOPE_FALLBACK_SERVICES;
    }

    // 对每个服务调用 fetchServiceTools 获取真实的工具列表
    // 添加延迟避免 429 限流
    let serviceIndex = 0;
    for (const svc of services) {
      try {
        // 每个服务之间等待 3 秒，避免 429 限流
        if (serviceIndex > 0) {
          await new Promise(r => setTimeout(r, 3000));
        }
        serviceIndex++;
        
        const tools = await this.fetchServiceTools(svc);
        if (tools.length > 0) {
          svc.tools = tools;
        } else {
          // 如果获取失败，使用服务 ID 生成一个默认工具名
          const fallbackToolName = `bailian_${camelToSnake(svc.id)}`;
          svc.tools = [{ name: fallbackToolName, description: svc.description }];
        }
      } catch (e) {
        // 忽略单个服务的工具获取失败
        const fallbackToolName = `bailian_${camelToSnake(svc.id)}`;
        svc.tools = [{ name: fallbackToolName, description: svc.description }];
        console.warn(`[MCP] ❌ 服务 ${svc.id} 获取工具失败，使用默认工具名:`, fallbackToolName, e);
      }
    }

    // 合并服务列表到 mcpServices
    this.mergeServices(services);

    // 兼容旧的 mcpTools 结构（用于工具权限检查）
    const toolsFromServices: any[] = [];
    for (const svc of services) {
      for (const tool of svc.tools || []) {
        toolsFromServices.push({
          name: tool.name,
          description: tool.description,
          endpoint: svc.endpoint,
        });
      }
    }
    this.mergeTools("dashscope", toolsFromServices);

    await this.normalizeListAndSave();
  }

  /**
   * 合并服务列表，保留用户的 enabled 状态
   */
  private mergeServices(newServices: McpService[]) {
    this.ensureServices();
    const now = Date.now();
    const existingMap = new Map<string, McpService>();
    
    for (const svc of this.settings.mcpServices as McpService[]) {
      if (svc && svc.id) {
        existingMap.set(svc.id, svc);
      }
    }

    const merged: McpService[] = [];
    for (const svc of newServices) {
      const existing = existingMap.get(svc.id);
      merged.push({
        ...svc,
        enabled: existing?.enabled ?? svc.enabled,
        lastSeenAt: now,
      });
      existingMap.delete(svc.id);
    }

    // 保留用户之前有但现在API没返回的服务（可能是临时下线）
    for (const [, svc] of existingMap) {
      if (svc.provider === "dashscope") {
        merged.push(svc);
      }
    }

    this.settings.mcpServices = merged.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * 获取服务列表
   */
  getServices(provider?: McpProvider): McpService[] {
    this.ensureServices();
    const services = this.settings.mcpServices as McpService[];
    if (!provider) return services;
    return services.filter(s => s.provider === provider);
  }

  /**
   * 根据工具名查找对应的服务及 endpoint
   */
  findServiceByTool(toolName: string): McpService | undefined {
    this.ensureServices();
    const services = this.settings.mcpServices as McpService[];
    for (const svc of services) {
      if (svc.tools?.some(t => t.name === toolName)) {
        return svc;
      }
    }
    // 尝试从服务名猜测（如工具名包含服务名）
    const lowerToolName = toolName.toLowerCase();
    for (const svc of services) {
      const svcIdLower = svc.id.toLowerCase().replace(/-/g, "_");
      if (lowerToolName.includes(svcIdLower) || lowerToolName.includes(svc.name.toLowerCase())) {
        return svc;
      }
    }
    return undefined;
  }

  /**
   * 获取工具对应的 endpoint
   */
  getToolEndpoint(provider: McpProvider, toolName: string): string | undefined {
    if (provider === "local") {
      return this.settings.mcpEndpoint;
    }
    
    // 先从服务列表查找
    const svc = this.findServiceByTool(toolName);
    if (svc?.endpoint) return svc.endpoint;
    
    // 回退：从旧的 mcpTools 中查找
    const tools = this.getTools(provider);
    const tool = tools.find(t => t.name === toolName);
    if (tool?.endpoint) return tool.endpoint;
    
    return undefined;
  }

  async maybeAutoRefresh(provider: McpProvider) {
    if (this.settings?.mcpAutoRefreshEnabled === false) return;
    const now = Date.now();
    const lastSeen = this.getLastSeen(provider) || 0;
    const shouldRefresh = !lastSeen || now - lastSeen > STALE_MS;
    const throttled = now - (this.lastAutoRefresh[provider] || 0) < THROTTLE_MS;
    if (shouldRefresh && !throttled) {
      try {
        await this.refresh(provider);
        this.lastAutoRefresh[provider] = now;
      } catch (e) {
        // ignore auto-refresh failures
      }
    }
  }

  enableTool(provider: McpProvider, toolName: string) {
    this.ensureList();
    const idx = this.settings.mcpTools.findIndex(
      (x: any) => String(x?.provider || "").trim() === provider && String(x?.name || "").trim() === toolName
    );
    if (idx >= 0) {
      this.settings.mcpTools[idx].enabled = true;
    }
  }

  async ensureAllowed(
    provider: McpProvider,
    toolName: string,
    opts: { promptIfDisabled?: boolean; autoEnableLocalDesktop?: boolean } = {}
  ): Promise<boolean> {
    const { promptIfDisabled = true, autoEnableLocalDesktop = true } = opts;
    await this.maybeAutoRefresh(provider);

    const isEnabled = this.isEnabled(provider, toolName);
    const has = this.hasTool(provider, toolName);

    if (provider === "local" && !Platform.isMobile && autoEnableLocalDesktop && has && !isEnabled) {
      this.enableTool(provider, toolName);
      await this.plugin?.saveSettings?.();
      return true;
    }

    if (isEnabled) return true;

    // If we already have this tool in cache but it's disabled, don't force listTools refresh.
    // DashScope listTools can be unsupported and repeated refresh attempts are noisy.
    let exists = has;

    if (!exists) {
      // Force refresh once if tool not in cache (best-effort)
      try {
        await this.refresh(provider);
      } catch (e) {
        // ignore
      }
      exists = this.hasTool(provider, toolName);
    }

    if (this.isEnabled(provider, toolName)) return true;

    if (exists && promptIfDisabled) {
      const ask = this.settings?.mcpConfirmBeforeCall !== false;
      if (!ask || window.confirm(`检测到 MCP 工具未开启：${toolName}\n\n是否临时开启并继续？`)) {
        this.enableTool(provider, toolName);
        await this.plugin?.saveSettings?.();
        return true;
      }
    }

    return false;
  }

  // ─── 通用 MCP Server 支持 ───────────────────────────

  /**
   * 获取通用 MCP 服务器列表
   */
  getGenericServers(): McpServerConfig[] {
    return Array.isArray(this.settings?.mcpServers) ? this.settings.mcpServers : [];
  }

  /**
   * 刷新所有通用 MCP 服务器的工具列表
   */
  async refreshAllGenericServers(): Promise<void> {
    const servers = this.getGenericServers().filter(s => s.enabled);
    if (servers.length === 0) return;

    const allTools: any[] = [];
    for (const server of servers) {
      try {
        const result = await this.refreshGenericServer(server.id);
        if (result.tools) {
          for (const tool of result.tools) {
            allTools.push({
              name: tool.name,
              description: tool.description,
              endpoint: server.endpoint,
            });
          }
        }
      } catch (e) {
        console.warn(`[MCP] 通用服务器 ${server.name} 刷新失败:`, e);
      }
    }

    this.mergeTools("generic", allTools);
    await this.normalizeListAndSave();
  }

  /**
   * 刷新单个通用 MCP 服务器
   */
  async refreshGenericServer(serverId: string): Promise<{ tools: McpToolDefinition[]; error?: string }> {
    const servers = this.getGenericServers();
    const server = servers.find(s => s.id === serverId);
    if (!server) return { tools: [], error: "服务器不存在" };

    const client = new GenericMcpClient({
      endpoint: server.endpoint,
      authHeader: server.authHeader,
      timeoutMs: 30000,
    });

    try {
      // 初始化握手
      await client.initialize().catch(() => {
        // 有些服务器不需要 initialize，忽略
      });

      // 获取工具列表
      const tools = await client.listTools();
      const toolDefs: McpToolDefinition[] = tools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));

      // 更新服务器的工具缓存和状态
      const idx = servers.findIndex(s => s.id === serverId);
      if (idx >= 0) {
        this.settings.mcpServers[idx].tools = toolDefs;
        this.settings.mcpServers[idx].lastSeenAt = Date.now();
        this.settings.mcpServers[idx].lastStatus = 'ok';
        this.settings.mcpServers[idx].lastError = undefined;
      }

      return { tools: toolDefs };
    } catch (e: any) {
      const errMsg = e?.message || String(e);
      const idx = servers.findIndex(s => s.id === serverId);
      if (idx >= 0) {
        this.settings.mcpServers[idx].lastStatus = 'error';
        this.settings.mcpServers[idx].lastError = errMsg;
      }
      console.error(`[MCP] ❌ 通用服务器 ${server.name} 刷新失败:`, errMsg);
      return { tools: [], error: errMsg };
    }
  }

  /**
   * 获取通用服务器中某工具的 endpoint
   */
  getGenericToolEndpoint(toolName: string): string | undefined {
    const servers = this.getGenericServers();
    for (const server of servers) {
      if (!server.enabled) continue;
      if (server.tools?.some(t => t.name === toolName)) {
        return server.endpoint;
      }
    }
    return undefined;
  }

  /**
   * 获取通用服务器中某工具所属的服务器配置
   */
  getGenericServerByTool(toolName: string): McpServerConfig | undefined {
    const servers = this.getGenericServers();
    for (const server of servers) {
      if (!server.enabled) continue;
      if (server.tools?.some(t => t.name === toolName)) {
        return server;
      }
    }
    return undefined;
  }
}
