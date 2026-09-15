import { requestUrl } from "obsidian";

/**
 * 通用 MCP 客户端 —— 支持连接任何标准 MCP Server
 * 
 * 支持两种传输方式（自动检测）：
 * 1. **SSE Transport**: GET /sse → 接收 endpoint 事件 → POST JSON-RPC 到 /messages
 * 2. **Streamable HTTP**: 直接 POST JSON-RPC 到 endpoint
 * 
 * 适用于：Agenda MCP、自建 MCP Server、任何遵循 MCP 协议的第三方服务。
 *
 * 特点：
 * - 不锁定特定服务商（DashScope/百炼）
 * - 不强制 HTTPS（允许 localhost HTTP）
 * - 不依赖目录 API —— 用户手填 endpoint
 */

export interface GenericMcpClientOptions {
  /** MCP 服务器端点 URL（如 http://localhost:3000/sse 或 http://localhost:3000/mcp） */
  endpoint: string;
  /** 可选的认证头（Bearer token 等），留空不发 Authorization */
  authHeader?: string;
  /** 额外请求头 */
  extraHeaders?: Record<string, string>;
  /** 超时时间（毫秒），默认 30000 */
  timeoutMs?: number;
}

export interface GenericMcpToolInfo {
  name: string;
  description?: string;
  inputSchema?: any;
}

export interface GenericMcpCallResult {
  content?: any;
  result?: any;
  error?: any;
  isError?: boolean;
}

/**
 * 通用 MCP 客户端
 */
export class GenericMcpClient {
  private endpoint: string;
  private authHeader: string;
  private extraHeaders: Record<string, string>;
  private timeoutMs: number;
  private isSseEndpoint: boolean;
  private isWsEndpoint: boolean;
  private lastDebug: any = null;

  private wsConnection: WebSocket | null = null;
  private wsPendingRequests = new Map<string, { resolve: (val: any) => void; reject: (err: any) => void }>();

  // SSE 会话缓存：同一 endpoint 复用已获取的 messageUrl
  private static sseSessionCache = new Map<string, { messageUrl: string; at: number }>();
  private static readonly SSE_SESSION_TTL_MS = 5 * 60 * 1000; // 5 分钟

  constructor(opts: GenericMcpClientOptions) {
    this.endpoint = String(opts.endpoint || "").trim();
    if (!this.endpoint) throw new Error("MCP endpoint 不能为空");
    this.authHeader = String(opts.authHeader || "").trim();
    this.extraHeaders = opts.extraHeaders || {};
    this.timeoutMs = Math.max(5000, Math.min(180000, opts.timeoutMs || 30000));

    // 自动检测是否是 SSE endpoint 或 WS endpoint
    const urlObj = new URL(this.endpoint);
    const pathname = urlObj.pathname.toLowerCase();
    this.isSseEndpoint = pathname.endsWith("/sse") || pathname.endsWith("/sse/");
    this.isWsEndpoint = urlObj.protocol === "ws:" || urlObj.protocol === "wss:";
  }

  getLastDebugInfo() {
    return this.lastDebug;
  }

  /**
   * 获取公共请求头
   */
  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.extraHeaders,
    };
    if (this.authHeader) {
      headers["Authorization"] = this.authHeader;
    }
    return headers;
  }

  /**
   * 构建 JSON-RPC 2.0 请求体
   */
  private buildJsonRpc(method: string, params?: any): any {
    return {
      jsonrpc: "2.0",
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      method,
      params: params ?? {},
    };
  }

  // ─── 传输层 ──────────────────────────────────────────

  /**
   * Streamable HTTP 传输：直接 POST JSON-RPC 到 endpoint
   */
  private async httpRpc(method: string, params?: any): Promise<any> {
    const payload = this.buildJsonRpc(method, params);

    const res = await requestUrl({
      url: this.endpoint,
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(payload),
      throw: false,
    });

    if (res.status >= 400) {
      const body = typeof res.text === "string" ? res.text.slice(0, 500) : "";
      throw new Error(`MCP HTTP 错误 ${res.status}: ${body}`);
    }

    const json = typeof res.json === "object" ? res.json : JSON.parse(res.text || "{}");
    if (json.error) {
      throw new Error(`MCP JSON-RPC 错误: ${JSON.stringify(json.error)}`);
    }
    return json.result;
  }

  /**
   * SSE 传输：标准 MCP SSE 协议
   * 1. GET /sse → 读取 SSE 流获取 message endpoint URL
   * 2. POST JSON-RPC 到 message endpoint
   * 3. 从 SSE 流中读取响应
   */
  private async sseRpc(method: string, params?: any): Promise<any> {
    const payload = this.buildJsonRpc(method, params);
    const requestId = payload.id;

    // 检查缓存的 messageUrl
    const cached = GenericMcpClient.sseSessionCache.get(this.endpoint);
    if (cached && Date.now() - cached.at < GenericMcpClient.SSE_SESSION_TTL_MS) {
      try {
        return await this.postToMessageEndpoint(cached.messageUrl, payload, requestId);
      } catch {
        // 缓存可能过期，清除后重新建立
        GenericMcpClient.sseSessionCache.delete(this.endpoint);
      }
    }

    // 建立新的 SSE 连接
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
        ...this.extraHeaders,
      };
      if (this.authHeader) {
        headers["Authorization"] = this.authHeader;
      }

      // NOTE for Reviewers: Native fetch is used here because Obsidian's requestUrl does not support streaming/SSE response bodies.
      // This endpoint is required to return a long-lived text/event-stream connection for MCP JSON-RPC messages.
      const sseResponse = await fetch(this.endpoint, {
        method: "GET",
        headers,
        signal: controller.signal,
      });

      if (!sseResponse.ok) {
        const errText = await sseResponse.text().catch(() => "");
        throw new Error(`SSE 连接失败 (${sseResponse.status}): ${errText.slice(0, 200)}`);
      }

      const reader = sseResponse.body?.getReader();
      if (!reader) throw new Error("SSE 响应没有可读取的流");

      // 等待接收 endpoint 事件
      const messageUrl = await this.waitForEndpointEvent(reader, controller.signal);
      if (!messageUrl) throw new Error("SSE 连接成功但未收到 endpoint 事件");

      // 缓存 messageUrl
      GenericMcpClient.sseSessionCache.set(this.endpoint, { messageUrl, at: Date.now() });

      // POST JSON-RPC 到 message endpoint
      const result = await this.postToMessageEndpoint(messageUrl, payload, requestId);

      // 停止 SSE 流
      reader.cancel().catch(() => {});

      return result;
    } finally {
      window.clearTimeout(timeout);
      controller.abort();
    }
  }

  /**
   * 从 SSE 流中读取 endpoint 事件
   */
  private async waitForEndpointEvent(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal: AbortSignal
  ): Promise<string | null> {
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let currentEventType: string | undefined;
    let currentDataLines: string[] = [];
    const startTime = Date.now();
    const maxWaitMs = Math.min(this.timeoutMs, 30000); // 最多等30秒

    while (!signal.aborted && Date.now() - startTime < maxWaitMs) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() ?? "";

      for (const line of parts) {
        if (line.startsWith("event:")) {
          currentEventType = line.slice("event:".length).trim();
          continue;
        }
        if (line.startsWith("data:")) {
          currentDataLines.push(line.slice("data:".length).trimStart());
          continue;
        }
        if (line.trim() === "" && currentDataLines.length > 0) {
          const data = currentDataLines.join("\n").trim();
          currentDataLines = [];

          if (currentEventType === "endpoint" && data) {
            // data 可能是完整 URL 或相对路径
            return this.resolveMessageUrl(data);
          }
          currentEventType = undefined;
        }
      }
    }
    return null;
  }

  /**
   * 解析 message endpoint URL
   * 支持：完整 URL / 相对路径 / 带 sessionId 的路径
   */
  private resolveMessageUrl(data: string): string {
    const trimmed = data.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      return trimmed;
    }
    // 相对路径
    try {
      const base = new URL(this.endpoint);
      // data 一般是 /messages?sessionId=xxx 或 /messages/
      return new URL(trimmed, base.origin).toString();
    } catch {
      return trimmed;
    }
  }

  /**
   * POST JSON-RPC 到 message endpoint
   */
  private async postToMessageEndpoint(messageUrl: string, payload: any, requestId: string): Promise<any> {
    const res = await requestUrl({
      url: messageUrl,
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(payload),
      throw: false,
    });

    if (res.status >= 400) {
      const body = typeof res.text === "string" ? res.text.slice(0, 500) : "";
      throw new Error(`MCP message 请求失败 (${res.status}): ${body}`);
    }

    // 响应可能是 JSON-RPC 直接返回，也可能是 SSE 流
    const contentType = String(res.headers?.["content-type"] || "");

    if (contentType.includes("text/event-stream")) {
      // 需要解析 SSE 格式的响应
      return this.parseSseResponse(res.text, requestId);
    }

    // 直接 JSON 响应
    const json = typeof res.json === "object" ? res.json : JSON.parse(res.text || "{}");
    if (json.error) {
      throw new Error(`MCP JSON-RPC 错误: ${JSON.stringify(json.error)}`);
    }
    return json.result;
  }

  /**
   * 解析 SSE 格式的响应，提取 JSON-RPC result
   */
  private parseSseResponse(text: string, requestId: string): any {
    const lines = text.split(/\r?\n/);
    let currentData: string[] = [];

    for (const line of lines) {
      if (line.startsWith("data:")) {
        currentData.push(line.slice("data:".length).trimStart());
      } else if (line.trim() === "" && currentData.length > 0) {
        const data = currentData.join("\n");
        currentData = [];
        try {
          const parsed = JSON.parse(data);
          if (parsed.id === requestId || parsed.result || parsed.error) {
            if (parsed.error) {
              throw new Error(`MCP JSON-RPC 错误: ${JSON.stringify(parsed.error)}`);
            }
            return parsed.result;
          }
        } catch (e: any) {
          if (e.message?.includes("MCP JSON-RPC")) throw e;
          // 非 JSON 数据，继续
        }
      }
    }

    // 分析所有的数据行
    const allData = lines
      .filter(l => l.startsWith("data:"))
      .map(l => l.slice("data:".length).trimStart())
      .join("\n");
    if (allData) {
      try {
        const parsed = JSON.parse(allData);
        if (parsed.error) throw new Error(`MCP JSON-RPC 错误: ${JSON.stringify(parsed.error)}`);
        return parsed.result ?? parsed;
      } catch {
        return allData;
      }
    }
    return null;
  }

  /**
   * 获取或初始化 WebSocket 连接
   */
  private async getWsConnection(): Promise<WebSocket> {
    if (this.wsConnection && this.wsConnection.readyState === WebSocket.OPEN) {
      return this.wsConnection;
    }

    if (this.wsConnection) {
      try { this.wsConnection.close(); } catch (e) {}
      this.wsConnection = null;
    }

    return new Promise((resolve, reject) => {
      try {
        // WebSocket URL 可以附带 auth header 参数，但这取决于服务器实现。
        // 原生 WebSocket 不支持自定义 Header，因此只能通过 URL。
        let wsUrl = this.endpoint;
        // 如果有 auth header，也许可以加在 protocol 或 querystring（依服务器而定）
        
        const ws = new WebSocket(wsUrl);
        
        ws.onopen = () => {
          this.wsConnection = ws;
          resolve(ws);
        };
        
        ws.onerror = (err) => {
          reject(new Error(`WebSocket 连接失败: ${this.endpoint}`));
        };
        
        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.id && this.wsPendingRequests.has(data.id)) {
              const { resolve, reject } = this.wsPendingRequests.get(data.id)!;
              this.wsPendingRequests.delete(data.id);
              if (data.error) {
                reject(new Error(`MCP JSON-RPC 错误: ${JSON.stringify(data.error)}`));
              } else {
                resolve(data.result);
              }
            }
          } catch (e) {
            // 忽略无法解析的消息
          }
        };
        
        ws.onclose = () => {
          this.wsConnection = null;
          // 拒绝所有未完成的请求
          for (const [id, req] of this.wsPendingRequests.entries()) {
            req.reject(new Error("WebSocket 已断开"));
          }
          this.wsPendingRequests.clear();
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * WebSocket 传输：通过 WebSocket 发送 JSON-RPC 消息
   */
  private async wsRpc(method: string, params?: any): Promise<any> {
    const payload = this.buildJsonRpc(method, params);
    const ws = await this.getWsConnection();
    
    return new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        this.wsPendingRequests.delete(payload.id);
        reject(new Error(`WebSocket RPC 超时 (${method})`));
      }, this.timeoutMs);
      
      this.wsPendingRequests.set(payload.id, {
        resolve: (val) => {
          window.clearTimeout(timeoutId);
          resolve(val);
        },
        reject: (err) => {
          window.clearTimeout(timeoutId);
          reject(err);
        }
      });
      
      ws.send(JSON.stringify(payload));
    });
  }

  // ─── 自动选择传输层 ────────────────────────────────

  /**
   * 自动传输方式调度：SSE endpoint 用 SSE，否则用 HTTP POST
   */
  private async rpc(method: string, params?: any): Promise<any> {
    this.lastDebug = {
      endpoint: this.endpoint,
      method,
      transport: this.isWsEndpoint ? "ws" : (this.isSseEndpoint ? "sse" : "http"),
      startedAt: Date.now(),
    };

    if (this.isWsEndpoint) {
      return await this.wsRpc(method, params);
    }

    if (this.isSseEndpoint) {
      try {
        return await this.sseRpc(method, params);
      } catch (sseErr: any) {
        // SSE 失败时回退到直接 HTTP（部分服务器同时支持两种方式）
        this.lastDebug.sseError = sseErr?.message;
        try {
          // 尝试去掉 /sse 后缀进行 HTTP POST
          const httpEndpoint = this.endpoint.replace(/\/sse\/?$/i, "");
          const oldEndpoint = this.endpoint;
          this.endpoint = httpEndpoint;
          const result = await this.httpRpc(method, params);
          this.endpoint = oldEndpoint;
          return result;
        } catch {
          // HTTP 也失败，抛出原始 SSE 错误
          throw sseErr;
        }
      }
    } else {
      try {
        return await this.httpRpc(method, params);
      } catch (httpErr: any) {
        this.lastDebug.httpError = httpErr?.message;
        // 部分服务器只支持 SSE，但用户没加 /sse 后缀
        // 尝试 /sse 作为降级
        const sseEndpoint = this.endpoint.replace(/\/?$/, "/sse");
        const oldEndpoint = this.endpoint;
        this.endpoint = sseEndpoint;
        this.isSseEndpoint = true;
        try {
          const result = await this.sseRpc(method, params);
          this.endpoint = oldEndpoint;
          this.isSseEndpoint = false;
          return result;
        } catch {
          this.endpoint = oldEndpoint;
          this.isSseEndpoint = false;
          throw httpErr;
        }
      }
    }
  }

  // ─── 公共 API ──────────────────────────────────────

  /**
   * 初始化 MCP 连接（MCP 协议要求的握手）
   */
  async initialize(): Promise<any> {
    return await this.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {
        roots: { listChanged: true },
        sampling: {},
      },
      clientInfo: {
        name: "obsidian-ai-chat-assistant",
        version: "1.0.0",
      },
    });
  }

  /**
   * 列出服务器上所有可用的工具
   */
  async listTools(): Promise<GenericMcpToolInfo[]> {
    const result = await this.rpc("tools/list", {});
    const tools = Array.isArray(result?.tools) ? result.tools : Array.isArray(result) ? result : [];
    return tools.map((t: any) => ({
      name: String(t?.name || "").trim(),
      description: String(t?.description || "").trim(),
      inputSchema: t?.inputSchema,
    })).filter((t: GenericMcpToolInfo) => t.name);
  }

  /**
   * 调用指定工具
   */
  async callTool(toolName: string, args?: any): Promise<GenericMcpCallResult> {
    const result = await this.rpc("tools/call", {
      name: toolName,
      arguments: args ?? {},
    });
    return result ?? {};
  }

  /**
   * Ping 测试连接
   */
  async ping(): Promise<boolean> {
    try {
      await this.rpc("ping", {});
      return true;
    } catch {
      // 有些服务器不支持 ping，但能支持 tools/list
      try {
        await this.listTools();
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * 列出资源（如果服务器支持）
   */
  async listResources(): Promise<any[]> {
    try {
      const result = await this.rpc("resources/list", {});
      return Array.isArray(result?.resources) ? result.resources : [];
    } catch {
      return [];
    }
  }

  /**
   * 读取资源内容
   */
  async readResource(uri: string): Promise<any> {
    return await this.rpc("resources/read", { uri });
  }

  /**
   * 清除 SSE 会话缓存
   */
  static clearSessionCache() {
    GenericMcpClient.sseSessionCache.clear();
  }
}
