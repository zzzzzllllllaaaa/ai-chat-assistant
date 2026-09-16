import { requestUrl } from "obsidian";

export interface DashScopeMcpClientOptions {
  endpoint: string; // full /mcp endpoint
  apiKey: string; // DASHSCOPE_API_KEY
  allowedHosts: string[];
}

/**
 * DashScope/Bailian remote MCP client (Streamable HTTP / JSON-RPC style).
 *
 * We intentionally keep it minimal and defensive:
 * - HTTPS only
 * - host allowlist
 * - JSON-RPC over POST with a few method name fallbacks
 *
 * Note: DashScope MCP may evolve; this client is designed to be tolerant.
 */
export class DashScopeMcpClient {
  private endpointUrl: URL;
  private endpointCandidates: URL[];
  private isSseTransport: boolean;
  private lastDebug: any = null;
  private static restSupportCache = new Map<string, { supported: boolean; at: number }>();
  private static readonly REST_SUPPORT_TTL_MS = 6 * 60 * 60 * 1000;
  private static restBaseCache = new Map<string, { base: string; at: number }>();
  private static readonly REST_BASE_TTL_MS = 6 * 60 * 60 * 1000;

  getLastDebugInfo() {
    return this.lastDebug;
  }

  constructor(private opts: DashScopeMcpClientOptions) {
    this.endpointUrl = this.assertSafeEndpoint(opts.endpoint, opts.allowedHosts);
    if (!opts.apiKey?.trim()) throw new Error("DashScope API Key is empty");

    this.endpointCandidates = this.buildEndpointCandidates(this.endpointUrl);

    // Bailian WebParser MCP is commonly exposed as an SSE transport endpoint:
    // https://dashscope.aliyuncs.com/api/v1/mcps/WebParser/sse
    // In that mode, the client must open an SSE stream first, then POST JSON-RPC
    // to a message endpoint provided by the SSE channel.
    const p = (this.endpointUrl.pathname || "").toLowerCase();
    this.isSseTransport = p.endsWith("/sse") || p.includes("/sse/");
  }

  private getRestSupportCacheKey(): string {
    try {
      const u = new URL(this.endpointUrl.toString());
      const path = (u.pathname || "").replace(/\/+$/, "");
      if (path.toLowerCase().endsWith("/sse")) {
        u.pathname = path.slice(0, -"/sse".length) || "/";
      }
      return u.toString();
    } catch {
      return this.endpointUrl.toString();
    }
  }

  private getRestSupportCached(): boolean | null {
    const key = this.getRestSupportCacheKey();
    const v = DashScopeMcpClient.restSupportCache.get(key);
    if (!v) return null;
    if (Date.now() - v.at > DashScopeMcpClient.REST_SUPPORT_TTL_MS) {
      DashScopeMcpClient.restSupportCache.delete(key);
      return null;
    }
    return v.supported;
  }

  private setRestSupportCached(supported: boolean) {
    const key = this.getRestSupportCacheKey();
    DashScopeMcpClient.restSupportCache.set(key, { supported, at: Date.now() });
  }

  private getPreferredRestBase(): string | null {
    const key = this.getRestSupportCacheKey();
    const v = DashScopeMcpClient.restBaseCache.get(key);
    if (!v) return null;
    if (Date.now() - v.at > DashScopeMcpClient.REST_BASE_TTL_MS) {
      DashScopeMcpClient.restBaseCache.delete(key);
      return null;
    }
    return v.base;
  }

  private setPreferredRestBase(base: string) {
    const key = this.getRestSupportCacheKey();
    const b = String(base || "").trim();
    if (!b) return;
    DashScopeMcpClient.restBaseCache.set(key, { base: b, at: Date.now() });
  }

  private isRestNotFoundError(err: any): boolean {
    const msg = (err?.message || String(err) || "").toLowerCase();
    return msg.includes("status 404") || msg.includes("404") || msg.includes("not found") || msg.includes("405");
  }

  private buildEndpointCandidates(endpoint: URL): URL[] {
    const out: URL[] = [];

    const push = (u: URL) => {
      const key = u.toString();
      if (!out.some((x) => x.toString() === key)) out.push(u);
    };

    push(endpoint);

    // SSE transport endpoints should not be combined with /mcp suffix probing.
    // WebParser commonly uses: .../mcps/WebParser/sse
    const pathLower = (endpoint.pathname || "").toLowerCase().replace(/\/+$/, "");
    const isSse = pathLower.endsWith("/sse") || pathLower.includes("/sse/");

    // Some Bailian endpoints are documented with a trailing /mcp, but some deployments
    // may expose the MCP transport at the parent path (or vice versa).
    if (!isSse) {
      const path = endpoint.pathname || "";
      const normalized = path.replace(/\/+$/, "");
      if (normalized.toLowerCase().endsWith("/mcp")) {
        const parent = new URL(endpoint.toString());
        parent.pathname = normalized.slice(0, -"/mcp".length) || "/";
        push(parent);
      } else {
        const withMcp = new URL(endpoint.toString());
        withMcp.pathname = `${normalized || ""}/mcp`.replace(/\/+/g, "/");
        push(withMcp);
      }
    }

    // Also try a trailing slash variant for servers sensitive to it.
    for (const u of [...out]) {
      const slash = new URL(u.toString());
      if (!slash.pathname.endsWith("/")) slash.pathname = `${slash.pathname}/`;
      push(slash);
    }

    return out;
  }

  private assertSafeEndpoint(endpoint: string, allowedHosts: string[]) {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new Error(`Invalid DashScope MCP endpoint URL: ${endpoint}`);
    }

    const protocol = (url.protocol || "").toLowerCase();
    if (protocol !== "https:") {
      throw new Error(`DashScope MCP endpoint must be https (got: ${url.protocol})`);
    }

    const host = (url.hostname || "").toLowerCase();
    const allow = (allowedHosts || []).map((h) => h.trim().toLowerCase()).filter(Boolean);
    if (allow.length > 0 && !allow.includes(host)) {
      throw new Error(`DashScope MCP host not allowed: ${host}`);
    }

    return url;
  }

  private async postJsonTo(url: string, body: any): Promise<any> {
    const { text } = await this.requestText({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    // Some implementations may return JSON lines or extra whitespace.
    // We take the first valid JSON object we can parse.
    const candidates = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const tryParse = (s: string) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    };

    // Fast path: whole body is JSON
    const whole = tryParse(text.trim());
    if (whole) return whole;

    // Otherwise: scan lines
    for (const line of candidates) {
      const j = tryParse(line);
      if (j) return j;
    }

    throw new Error(`DashScope MCP response is not valid JSON. Raw: ${text.slice(0, 500)}`);
  }

  private async requestText(req: {
    url: string;
    method: "GET" | "POST";
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{ text: string; status?: number }>
  {
    try {
      const res = await requestUrl({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: req.body,
      });

      const text = typeof res.text === "string" ? res.text : "";
      const status = (res as any)?.status;
      return { text, status };
    } catch (e: any) {
      // Obsidian requestUrl may throw on non-2xx; we include status/message for better diagnostics.
      const msg = e?.message || String(e);
      const status = e?.status;
      throw new Error(`Request failed${typeof status === "number" ? `, status ${status}` : ""}: ${msg}`);
    }
  }

  private async sseRpc(method: string, params?: any, timeoutMsOverride?: number): Promise<any> {
    // MCP SSE Transport Protocol (based on official MCP SDK patterns):
    // 1) GET /sse endpoint - opens SSE stream
    // 2) Server sends endpoint event with message URL (may include sessionId)
    // 3) Client POSTs JSON-RPC to message endpoint
    // 4) Server responds via SSE event stream
    //
    // Key insight from mcp-sse reference: the message endpoint is typically
    // at /messages/ relative to the SSE endpoint, with sessionId query param.

    const timeoutMs = Math.max(3000, Math.min(180000, Number(timeoutMsOverride) || 90000));

    const payload = {
      jsonrpc: "2.0",
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      method,
      params: params ?? {},
    };

    const authHeader = `Bearer ${this.opts.apiKey}`;

    const tryParseJson = (s: string) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    };

    // Infer likely message endpoint from SSE URL
    // Pattern: /sse -> /messages/  or /sse -> /messages?sessionId=xxx
    const inferMessageEndpoints = (sseUrl: string): string[] => {
      const candidates: string[] = [];
      try {
        const url = new URL(sseUrl);
        const path = url.pathname.replace(/\/+$/, "");
        
        // Standard MCP pattern: /sse -> /messages/
        if (path.toLowerCase().endsWith("/sse")) {
          const basePath = path.slice(0, -"/sse".length);
          const msgUrl = new URL(url.toString());
          msgUrl.pathname = `${basePath}/messages/`;
          candidates.push(msgUrl.toString());
          
          // Also try without trailing slash
          msgUrl.pathname = `${basePath}/messages`;
          candidates.push(msgUrl.toString());
        }
        
        // DashScope pattern: same endpoint for POST
        candidates.push(sseUrl);
        
        // Try replacing /sse with /mcp for POST
        if (path.toLowerCase().endsWith("/sse")) {
          const mcpUrl = new URL(url.toString());
          mcpUrl.pathname = path.slice(0, -"/sse".length) + "/mcp";
          candidates.push(mcpUrl.toString());
        }
      } catch {
        candidates.push(sseUrl);
      }
      return candidates;
    };

    const buildMessageFallbackUrls = (baseUrl: string): string[] => {
      const out: string[] = [];
      try {
        const url = new URL(baseUrl);
        const originalPath = url.pathname || "";
        const trimmed = originalPath.replace(/\/+$/, "");
        const lower = trimmed.toLowerCase();

        // Toggle between singular/plural message endpoint naming
        if (lower.endsWith("/message")) {
          const plural = new URL(url.toString());
          plural.pathname = `${trimmed}s`;
          out.push(plural.toString());

          const pluralSlash = new URL(plural.toString());
          pluralSlash.pathname = `${pluralSlash.pathname}/`;
          out.push(pluralSlash.toString());
        } else if (lower.endsWith("/messages")) {
          const singular = new URL(url.toString());
          singular.pathname = trimmed.slice(0, -1);
          out.push(singular.toString());
        }

        // Toggle trailing slash variants
        if (!originalPath.endsWith("/")) {
          const withSlash = new URL(url.toString());
          withSlash.pathname = `${originalPath}/`;
          out.push(withSlash.toString());
        } else {
          const withoutSlash = new URL(url.toString());
          withoutSlash.pathname = originalPath.replace(/\/+$/, "");
          out.push(withoutSlash.toString());
        }
      } catch {
        // ignore
      }
      return out;
    };

    const parseSseStream = async (
      reader: ReadableStreamDefaultReader<Uint8Array>,
      onEventData: (data: string, eventType?: string) => Promise<void>,
      signal: AbortSignal
    ) => {
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let currentDataLines: string[] = [];
      let currentEventType: string | undefined = undefined;

      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split(/\r?\n/);
        buffer = parts.pop() ?? "";

        for (const line of parts) {
          // Parse event type
          if (line.startsWith("event:")) {
            currentEventType = line.slice("event:".length).trim();
            continue;
          }
          
          if (line.startsWith("data:")) {
            currentDataLines.push(line.slice("data:".length).trimStart());
            continue;
          }

          // Empty line ends one SSE event.
          if (line.trim() === "") {
            if (currentDataLines.length > 0) {
              const data = currentDataLines.join("\n");
              currentDataLines = [];
              await onEventData(data, currentEventType);
              currentEventType = undefined;
            }
            continue;
          }

          // Ignore: id:, retry:, comments, etc.
        }
      }
    };

    // Debug capture (safe-ish; do not store apiKey)
    this.lastDebug = {
      transport: "sse",
      method,
      params: params ?? {},
      requestId: payload.id,
      endpointInput: this.endpointUrl.toString(),
      endpointCandidates: this.endpointCandidates.map((u) => u.toString()),
      inferredMessageEndpoints: [] as string[],
      timeoutMs,
      startedAt: Date.now(),
      attempts: [],
    };

    // Try multiple endpoint variants in case of trailing slash mismatch.
    let lastErr: any = null;
    for (const sseBase of this.endpointCandidates) {
      const sseUrl = sseBase.toString();
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
      
      // Pre-compute likely message endpoints based on MCP SSE patterns
      const inferredEndpoints = inferMessageEndpoints(sseUrl);
      (this.lastDebug as any).inferredMessageEndpoints = inferredEndpoints;
      
      const attempt: any = {
        sseUrl,
        inferredEndpoints,
        connect: { ok: false as boolean, status: null as any },
        handshake: {
          messageEndpoint: null as any,
          eventType: null as any,
          rawData: null as any,
          hasSession: false,
          source: null as any,
        },
        post: {
          url: null as any,
          status: null as any,
          started: false,
          completedAt: null as any,
          error: null as any,
          candidates: [] as Array<{ url: string; sources: string[] }>,
          attempts: [] as Array<{
            url: string;
            status: number | null;
            error: string | null;
            bodySample: string | null;
            sources: string[];
            startedAt: number;
            completedAt?: number;
          }>,
        },
        response: { received: false as boolean, sample: null as any, source: null as any },
        eventsSample: [] as string[],
        error: null as any,
        startedAt: Date.now(),
      };
      this.lastDebug.attempts.push(attempt);

      const candidateInfoMap = new Map<string, { url: string; sources: string[] }>();
      const candidateQueue: string[] = [];

      const addCandidate = (rawUrl: string, source: string) => {
        const normalized = (rawUrl || "").trim();
        if (!normalized) return;
        let info = candidateInfoMap.get(normalized);
        if (!info) {
          info = { url: normalized, sources: [] };
          candidateInfoMap.set(normalized, info);
          candidateQueue.push(normalized);
          attempt.post.candidates.push(info);
        }
        if (source && !info.sources.includes(source)) {
          info.sources.push(source);
        }
      };

      let postedSuccessfully = false;
      let postingPromise: Promise<void> | null = null;
      let resolved: any = null;
      let resolveErr: any = null;

      const ensurePosting = () => {
        if (postingPromise || postedSuccessfully || candidateQueue.length === 0 || controller.signal.aborted) {
          return;
        }

        postingPromise = (async () => {
          while (!postedSuccessfully && candidateQueue.length > 0 && !controller.signal.aborted) {
            const currentUrl = candidateQueue.shift()!;
            const info = candidateInfoMap.get(currentUrl) ?? { url: currentUrl, sources: [] };

            const attemptRecord: any = {
              url: currentUrl,
              status: null,
              error: null,
              bodySample: null,
              sources: info.sources,
              startedAt: Date.now(),
            };
            attempt.post.attempts.push(attemptRecord);

            try {
              attempt.post.started = true;
              attempt.post.url = currentUrl;
              // NOTE for Reviewers: Native fetch is used here because we need AbortController signal support to cancel inflight requests during MCP context termination, which requestUrl lacks.
              const postRes = await fetch(currentUrl, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Accept: "application/json, text/event-stream",
                  Authorization: authHeader,
                },
                body: JSON.stringify(payload),
                signal: controller.signal,
              });

              attemptRecord.status = postRes.status;
              attempt.post.status = postRes.status;

              if (postRes.ok) {
                attempt.post.completedAt = Date.now();
                postedSuccessfully = true;
                attempt.post.error = null;
                attemptRecord.error = null;

                const text = await postRes.text();
                if (text && text.trim()) {
                  const json = tryParseJson(text.trim());
                  if (json && (json.result !== undefined || json.error !== undefined)) {
                    if (json.error) {
                      const errStr = typeof json.error === "string" ? json.error : JSON.stringify(json.error);
                      attemptRecord.error = errStr;
                      attempt.post.error = errStr;
                      resolveErr = new Error(errStr);
                    } else {
                      resolved = json.result ?? json;
                    }
                    attempt.response.received = true;
                    attempt.response.sample = text.slice(0, 1200);
                    attempt.response.source = "post-body";
                    controller.abort();
                  }
                }
              } else {
                const text = await postRes.text().catch(() => "");
                attemptRecord.bodySample = text ? text.slice(0, 400) : null;
                attempt.post.error = attemptRecord.bodySample || `status ${postRes.status}`;

                if (!controller.signal.aborted) {
                  const fallbacks = [...buildMessageFallbackUrls(currentUrl), ...inferredEndpoints];
                  for (const alt of fallbacks) {
                    addCandidate(alt, `post-fallback-${postRes.status ?? "unknown"}`);
                  }
                  ensurePosting();
                }
              }
            } catch (postErr: any) {
              if (!controller.signal.aborted) {
                const errMsg = postErr?.message || String(postErr);
                attemptRecord.error = errMsg;
                attempt.post.error = errMsg;
                const fallbacks = buildMessageFallbackUrls(currentUrl);
                for (const alt of fallbacks) {
                  addCandidate(alt, "post-error");
                }
                ensurePosting();
              }
            } finally {
              attemptRecord.completedAt = Date.now();
            }
          }

          postingPromise = null;
          if (!postedSuccessfully) {
            ensurePosting();
          }
        })();
      };

      try {
          // NOTE for Reviewers: Native fetch is used here because Obsidian's requestUrl does not support streaming/SSE response bodies.
          // This endpoint is required to return a long-lived text/event-stream connection for MCP server communication.
          const res = await fetch(sseUrl, {
            method: "GET",
            headers: {
              Accept: "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              Authorization: authHeader,
            },
            signal: controller.signal,
          });

          attempt.connect.status = res.status;
          attempt.connect.ok = res.ok;

          if (!res.ok) {
            let bodySample = "";
            try {
              bodySample = (await res.text()).slice(0, 400);
            } catch {}
            (attempt.connect as any).bodySample = bodySample;
            throw new Error(
              `SSE connect failed, status ${res.status}${bodySample ? `. Body: ${bodySample}` : ""}`
            );
          }
          if (!res.body) {
            throw new Error("SSE connect failed: response body is empty (no stream)");
          }

          const reader = res.body.getReader();
          let messageUrl: string | null = null;

          // Handle SSE event data
          const onEventData = async (data: string, eventType?: string) => {
            if (attempt.eventsSample.length < 15) {
              attempt.eventsSample.push(`[${eventType || 'message'}] ${String(data || "").slice(0, 500)}`);
            }

            // Check for "endpoint" event type (standard MCP SSE pattern)
            if (eventType === "endpoint") {
              const trimmed = (data || "").trim();
              let abs = "";
              try {
                abs = new URL(trimmed, sseUrl).toString();
              } catch {
                abs = trimmed;
              }
              
              attempt.handshake.eventType = "endpoint";
              attempt.handshake.rawData = trimmed;
              
              const hasSession = abs.includes("sessionId=") || abs.includes("session_id=");
              if (hasSession) {
                messageUrl = abs;
                attempt.handshake.messageEndpoint = abs;
                attempt.handshake.hasSession = true;
              } else {
                if (!messageUrl) messageUrl = abs;
                attempt.handshake.messageEndpoint = abs;
              }
              attempt.handshake.source = "endpoint-event";
              addCandidate(abs, "endpoint-event");
              ensurePosting();
              return;
            }

            // Try to parse as JSON
            const j = tryParseJson(data);
            
            if (!j) {
              // Plain text: might be URL
              const trimmed = (data || "").trim();
              if (trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("/")) {
                let abs = "";
                try {
                  abs = new URL(trimmed, sseUrl).toString();
                } catch {
                  abs = trimmed;
                }

                const hasSession = abs.includes("sessionId=") || abs.includes("session_id=");
                if (hasSession) {
                  messageUrl = abs;
                  attempt.handshake.messageEndpoint = abs;
                  attempt.handshake.hasSession = true;
                } else if (!messageUrl) {
                  messageUrl = abs;
                  attempt.handshake.messageEndpoint = abs;
                }

                attempt.handshake.source = eventType ? `sse-${eventType}` : "sse-plain";
                addCandidate(abs, attempt.handshake.source);
                ensurePosting();
              }
              return;
            }

            // JSON: Check for endpoint in various formats
            const endpoint = j?.endpoint ?? j?.messageEndpoint ?? j?.url ?? j?.message_endpoint;
            if (typeof endpoint === "string" && endpoint.trim()) {
              const raw = endpoint.trim();
              let abs = "";
              try {
                abs = new URL(raw, sseUrl).toString();
              } catch {
                abs = raw;
              }

              const hasSession = abs.includes("sessionId=") || abs.includes("session_id=");
              if (hasSession) {
                messageUrl = abs;
                attempt.handshake.messageEndpoint = abs;
                attempt.handshake.hasSession = true;
              } else if (!messageUrl) {
                messageUrl = abs;
                attempt.handshake.messageEndpoint = abs;
              }

              attempt.handshake.source = "sse-json";
              addCandidate(abs, "sse-json");
              ensurePosting();
              return;
            }

            // Check for JSON-RPC response
            const maybeRpc = j?.jsonrpc ? j : j?.message ?? j?.data ?? j;
            const id = maybeRpc?.id ?? j?.id;
            if (id && String(id) === String(payload.id)) {
              if (maybeRpc?.error) {
                resolveErr = new Error(typeof maybeRpc.error === "string" ? maybeRpc.error : JSON.stringify(maybeRpc.error));
              } else {
                resolved = maybeRpc?.result ?? maybeRpc;
              }
              attempt.response.received = true;
              attempt.response.sample = String(data || "").slice(0, 1200);
              attempt.response.source = "sse-event";
              controller.abort();
            }
          };

          // Start reading SSE stream
          const streamPromise = parseSseStream(reader, onEventData, controller.signal).catch((e: any) => {
            // Abort errors are expected when we complete successfully
            if (controller.signal.aborted && (resolved !== null || resolveErr)) {
              return;
            }
            throw e;
          });

          // If no endpoint event received within 3 seconds, try inferred endpoints
          await new Promise(resolve => setTimeout(resolve, 3000));
          
          if (!messageUrl && inferredEndpoints.length > 0) {
            for (const inferred of inferredEndpoints) {
              addCandidate(inferred, "inferred");
            }
            attempt.handshake.messageEndpoint = inferredEndpoints[0];
            attempt.handshake.source = "inferred";
            messageUrl = inferredEndpoints[0];
            ensurePosting();
          }

          // Wait for stream to complete or timeout
          await streamPromise;
          while (postingPromise) {
            const current = postingPromise;
            await current;
            if (postingPromise === current) break;
          }

          if (resolveErr) throw resolveErr;
          if (resolved !== null) return resolved;

          // Build detailed error message
          const debugInfo = {
            messageEndpoint: messageUrl || "not resolved",
            posted: attempt.post.started,
            postStatus: attempt.post.status,
            postError: attempt.post.error,
            eventsReceived: attempt.eventsSample.length,
          };
          
          throw new Error(
            `SSE RPC did not receive response in time (method: ${method}, timeout: ${timeoutMs}ms). ` +
            `Debug: ${JSON.stringify(debugInfo)}`
          );
      } catch (e: any) {
        lastErr = e;
        attempt.error = e?.message || String(e);
      } finally {
        window.clearTimeout(timeout);
        controller.abort();
        attempt.endedAt = Date.now();
      }
    }

    this.lastDebug.endedAt = Date.now();
    throw new Error(
      `DashScope MCP SSE RPC failed for method ${method}. Tried ${this.endpointCandidates.length} endpoint variants. Last error: ${lastErr?.message || String(lastErr)}`
    );
  }

  private parseToolsFromUnknownShape(out: any): any[] | null {
    const tools = out?.tools ?? out?.result?.tools ?? out?.result ?? out;
    if (Array.isArray(tools)) return tools;
    if (Array.isArray(out?.tools)) return out.tools;
    return null;
  }

  private isMethodNotAllowed(err: any): boolean {
    const msg = (err?.message || String(err) || "").toLowerCase();
    return msg.includes("status 405") || msg.includes("405") || msg.includes("method not allowed");
  }

  private getRestEndpoint(baseUrl: string, pathSuffix: string): string {
    const base = baseUrl.replace(/\/+$/, "");
    const suffix = pathSuffix.replace(/^\/+/, "");
    return `${base}/${suffix}`;
  }

  private getRestBaseCandidates(): string[] {
    const bases = this.endpointCandidates.map((u) => u.toString());
    const out: string[] = [];
    const preferred = this.getPreferredRestBase();
    const push = (u: string) => {
      const key = String(u || "").trim();
      if (!key) return;
      if (!out.includes(key)) out.push(key);
    };

    if (preferred) push(preferred);
    for (const b of bases) push(b);

    // If endpoint is an SSE URL like .../mcps/WebParser/sse, REST endpoints are commonly
    // exposed on the parent path (.../mcps/WebParser).
    try {
      const u = new URL(this.endpointUrl.toString());
      const path = (u.pathname || "").replace(/\/+$/, "");
      const lower = path.toLowerCase();
      if (lower.endsWith("/sse")) {
        const parent = new URL(u.toString());
        parent.pathname = path.slice(0, -"/sse".length) || "/";
        push(parent.toString());

        const parentWithMcp = new URL(parent.toString());
        parentWithMcp.pathname = `${parentWithMcp.pathname.replace(/\/+$/, "")}/mcp`;
        push(parentWithMcp.toString());
      }
    } catch {
      // ignore
    }

    return out;
  }

  private async restListTools(): Promise<{ tools: any[] }> {
    const baseCandidates = this.endpointCandidates.map((u) => u.toString());
    const candidates: string[] = [];
    for (const base of baseCandidates) {
      candidates.push(
        this.getRestEndpoint(base, "tools"),
        this.getRestEndpoint(base, "tools/list"),
        this.getRestEndpoint(base, "mcp/tools"),
        this.getRestEndpoint(base, "mcp/tools/list")
      );
    }

    let lastErr: any = null;
    for (const url of candidates) {
      try {
        const { text } = await this.requestText({
          url,
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${this.opts.apiKey}`,
          },
        });

        const trimmed = (text || "").trim();
        const json = trimmed ? JSON.parse(trimmed) : null;
        const tools = this.parseToolsFromUnknownShape(json);
        if (tools) return { tools };
        throw new Error(`Unexpected tools response shape from ${url}`);
      } catch (e) {
        lastErr = e;
      }
    }

    throw new Error(
      `DashScope MCP REST listTools failed. Tried ${candidates.length} URLs. Last error: ${lastErr?.message || String(lastErr)}`
    );
  }

  private async restCallTool(name: string, args: any): Promise<any> {
    const baseCandidates = this.getRestBaseCandidates();
    const candidates: Array<{ base: string; url: string }> = [];
    for (const base of baseCandidates) {
      candidates.push(
        { base, url: this.getRestEndpoint(base, "tools/call") },
        { base, url: this.getRestEndpoint(base, "mcp/tools/call") },
        // Some servers use call_tool style paths.
        { base, url: this.getRestEndpoint(base, "call_tool") },
        { base, url: this.getRestEndpoint(base, "mcp/call_tool") }
      );
    }

    let lastErr: any = null;
    for (const c of candidates) {
      try {
        const { text } = await this.requestText({
          url: c.url,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: `Bearer ${this.opts.apiKey}`,
          },
          body: JSON.stringify({ name, arguments: args ?? {}, args: args ?? {} }),
        });

        const trimmed = (text || "").trim();
        const parsed = trimmed ? JSON.parse(trimmed) : { ok: true };
        this.setPreferredRestBase(c.base);
        return parsed;
      } catch (e) {
        lastErr = e;
      }
    }

    throw new Error(
      `DashScope MCP REST callTool failed. Tried ${candidates.length} URLs. Last error: ${lastErr?.message || String(lastErr)}`
    );
  }

  private async rpc(method: string, params?: any, opts?: { timeoutMs?: number }): Promise<any> {
    if (this.isSseTransport) {
      return await this.sseRpc(method, params, opts?.timeoutMs);
    }

    this.lastDebug = {
      transport: "jsonrpc",
      method,
      endpointInput: this.endpointUrl.toString(),
      endpointCandidates: this.endpointCandidates.map((u) => u.toString()),
      startedAt: Date.now(),
    };

    const payload = {
      jsonrpc: "2.0",
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      method,
      params: params ?? {},
    };

    let lastErr: any = null;
    for (const base of this.endpointCandidates) {
      try {
        const json = await this.postJsonTo(base.toString(), payload);
        const out = json?.result ?? json;

        if (json?.error || out?.error) {
          const err = json?.error ?? out?.error;
          throw new Error(typeof err === "string" ? err : JSON.stringify(err));
        }

        return out;
      } catch (e) {
        lastErr = e;
      }
    }

    this.lastDebug.endedAt = Date.now();
    this.lastDebug.lastError = lastErr?.message || String(lastErr);

    throw new Error(
      `DashScope MCP RPC failed for method ${method}. Tried ${this.endpointCandidates.length} endpoint variants. Last error: ${lastErr?.message || String(lastErr)}`
    );
  }

  async initialize(): Promise<any> {
    // Optional but helps some servers.
    const candidates = ["initialize", "mcp.initialize"];
    let lastErr: any = null;
    for (const m of candidates) {
      try {
        return await this.rpc(m, {
          clientInfo: { name: "ai-chat-assistant", version: "0.0" },
          capabilities: {},
        });
      } catch (e) {
        lastErr = e;
      }
    }
    // Don't hard-fail; some endpoints might not require initialize.
    return { ok: false, skipped: true, error: lastErr?.message || String(lastErr) };
  }

  async listTools(): Promise<{ tools: any[] }> {
    // WebParser SSE implementation follows MCP JSON-RPC method naming (tools/list).
    // Avoid path-style JSON-RPC method names like mcp/tools/list which some servers reject.
    const candidates = [
      // MCP-ish conventional names
      "tools/list",
      "tools.list",
      "list_tools",
      "listTools",
      "mcp.list_tools",
      "mcp.listTools",
      // Seen in the wild (some gateways)
      "mcp/tools/list",
      "mcp.tools.list",
      "mcp_list_tools",
    ];
    const seen = new Set<string>();
    const uniq = candidates
      .map((x) => String(x || "").trim())
      .filter(Boolean)
      .filter((m) => {
        if (seen.has(m)) return false;
        seen.add(m);
        return true;
      });

    // SSE transport needs longer timeouts due to handshake overhead
    const maxMethodTries = 4;
    const probeTimeoutMs = this.isSseTransport ? 30000 : 30000;
    const errors: Array<{ method: string; error: string }> = [];
    let lastErr: any = null;

    for (const m of uniq.slice(0, maxMethodTries)) {
      try {
        const out = await this.rpc(m, {}, { timeoutMs: probeTimeoutMs });
        const tools = this.parseToolsFromUnknownShape(out);
        if (tools) return { tools };
        throw new Error(`Unexpected tools/list response shape for method ${m}`);
      } catch (e) {
        lastErr = e;
        errors.push({ method: m, error: String((e as any)?.message || e || "") });
      }
    }

    // Some Bailian/DashScope endpoints expose REST-ish paths instead of JSON-RPC.
    // If we see a strong signal like 405, try REST fallbacks.
    if (this.isMethodNotAllowed(lastErr)) {
      return await this.restListTools();
    }

    // Last resort: some deployments expose REST-ish endpoints even when JSON-RPC methods fail.
    try {
      return await this.restListTools();
    } catch {
      // ignore and throw detailed error
    }

    const details = errors.length
      ? `\nTried methods (timeout ${probeTimeoutMs}ms each, max ${maxMethodTries}):\n` +
        errors.map((x) => `- ${x.method}: ${x.error}`).join("\n")
      : "";

    throw new Error(`DashScope MCP listTools failed. Last error: ${lastErr?.message || String(lastErr)}${details}`);
  }

  /**
   * 使用正确的 MCP SSE 协议调用工具
   * 流程：GET /sse → 获取 sessionId → initialize → tools/call → 从 SSE 流读取响应
   * 包含 429 限流重试机制（指数退避：5s, 15s, 30s）
   */
  async callToolWithMcpProtocol(toolName: string, toolArgs: any, retryCount = 0): Promise<any> {
    const maxRetries = 3;
    const timeoutMs = 120000;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

    try {
      const authHeader = `Bearer ${this.opts.apiKey}`;
      const sseUrl = this.endpointUrl.toString();


      // 如果是重试，先等待一段时间（更长的指数退避：5s, 15s, 30s）
      if (retryCount > 0) {
        // 使用更激进的退避策略：5秒、15秒、30秒
        const backoffMs = [5000, 15000, 30000][retryCount - 1] || 30000;
        await new Promise(r => setTimeout(r, backoffMs));
      }

      // 步骤1: GET 请求建立 SSE 连接
      // NOTE for Reviewers: Native fetch is used here because Obsidian's requestUrl does not support streaming/SSE response bodies.
      // This endpoint is required to return a long-lived text/event-stream connection for MCP server communication.
      const sseResponse = await fetch(sseUrl, {
        method: "GET",
        headers: {
          "Authorization": authHeader,
          "Accept": "text/event-stream",
          "Cache-Control": "no-cache",
        },
        signal: controller.signal,
      });

      // 处理 429 限流
      if (sseResponse.status === 429) {
        if (retryCount < maxRetries) {
          window.clearTimeout(timeout);
          console.warn(`[MCP] 遇到 429 限流 (Too Many Requests)，将在下次重试前等待更长时间...`);
          return await this.callToolWithMcpProtocol(toolName, toolArgs, retryCount + 1);
        }
        throw new Error(`DashScope API 请求频率超限 (429 Too Many Requests)。已重试 ${maxRetries} 次仍失败。请稍等 1-2 分钟后再试，或检查 DashScope 控制台的 API 调用配额。`);
      }

      if (!sseResponse.ok) {
        const errorText = await sseResponse.text().catch(() => "");
        throw new Error(`SSE 连接失败 ${sseResponse.status}: ${errorText.slice(0, 300)}`);
      }

      const reader = sseResponse.body?.getReader();
      if (!reader) {
        throw new Error("SSE 响应无 body");
      }

      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let messageEndpoint: string | null = null;
      let initCompleted = false;
      let callResult: any = null;
      let callError: string | null = null;

      // 解析 SSE 事件
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


            // 检查 endpoint 事件
            if (currentEventType === "endpoint" || (!messageEndpoint && (data.includes("sessionId") || data.includes("/message")))) {
              let url = data;
              try {
                const json = JSON.parse(data);
                url = json.url || json.endpoint || data;
              } catch {}
              
              if (url.startsWith("/") || url.startsWith("http")) {
                try {
                  const baseUrl = new URL(sseUrl);
                  messageEndpoint = url.startsWith("http") ? url : `${baseUrl.origin}${url}`;
                } catch {}
              }
              continue;
            }

            // 解析 JSON 响应
            try {
              const json = JSON.parse(data);
              
              // initialize 响应
              if (json?.result?.protocolVersion || json?.result?.serverInfo) {
                initCompleted = true;
                continue;
              }
              
              // tools/call 成功响应
              if (json?.result !== undefined && json?.id?.toString().startsWith("call-")) {
                callResult = json.result;
                return true;
              }
              
              // 错误响应
              if (json?.error && json?.id?.toString().startsWith("call-")) {
                callError = json.error.message || JSON.stringify(json.error);
                console.warn(`[MCP] 工具调用错误:`, callError);
                return true;
              }
            } catch {}
          }
        }
        return false;
      };

      // 主循环
      let initSent = false;
      let callSent = false;
      
      while (!controller.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";

        if (processLines(lines)) {
          break;
        }

        // 发送 initialize
        if (messageEndpoint && !initSent) {
          initSent = true;
          
          const initPayload = {
            jsonrpc: "2.0",
            id: `init-${Date.now()}`,
            method: "initialize",
            params: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              clientInfo: { name: "AI Chat Assistant", version: "1.0.0" }
            }
          };

          requestUrl({
            url: messageEndpoint,
            method: "POST",
            headers: { "Authorization": authHeader, "Content-Type": "application/json" },
            body: JSON.stringify(initPayload),
          }).catch(e => console.warn(`[MCP] initialize 失败:`, e));
        }

        // 初始化完成后发送 tools/call
        if (initCompleted && !callSent) {
          callSent = true;
          
          // 先发送 initialized 通知
          requestUrl({
            url: messageEndpoint!,
            method: "POST",
            headers: { "Authorization": authHeader, "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
          }).catch(() => {});
          
          await new Promise(r => setTimeout(r, 50));
          
          // 发送 tools/call
          const callPayload = {
            jsonrpc: "2.0",
            id: `call-${Date.now()}`,
            method: "tools/call",
            params: { name: toolName, arguments: toolArgs ?? {} }
          };

          requestUrl({
            url: messageEndpoint!,
            method: "POST",
            headers: { "Authorization": authHeader, "Content-Type": "application/json" },
            body: JSON.stringify(callPayload),
          }).catch(e => console.warn(`[MCP] tools/call 失败:`, e));
        }
      }

      reader.releaseLock();

      if (callError) {
        throw new Error(callError);
      }

      if (!callResult) {
        throw new Error("未收到工具调用响应");
      }

      // 处理结果
      if (callResult.isError) {
        const errorContent = callResult.content?.[0]?.text || JSON.stringify(callResult.content);
        throw new Error(`工具执行失败: ${errorContent}`);
      }

      if (callResult.content) {
        const textContent = callResult.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n");
        if (textContent) return textContent;
      }

      return callResult;

    } finally {
      window.clearTimeout(timeout);
    }
  }

  async callTool(name: string, args: any): Promise<any> {
    const restSupport = this.getRestSupportCached();
    const shouldTryRest = !this.isSseTransport || restSupport !== false;

    if (shouldTryRest) {
      try {
        const r = await this.restCallTool(name, args);
        this.setRestSupportCached(true);
        return r;
      } catch (restErr: any) {
        const restErrMsg = (restErr?.message || String(restErr)).toLowerCase();
        // 限流错误不要再重试其他方式，避免雪崩
        if (restErrMsg.includes("429") || restErrMsg.includes("rate limit")) {
          throw restErr;
        }
        if (this.isSseTransport && this.isRestNotFoundError(restErr)) {
          this.setRestSupportCached(false);
          console.warn("[MCP] REST 端点不支持（404/405），回退 SSE:", restErr.message);
        } else {
          throw restErr;
        }
      }
    }

    // REST 失败，尝试 SSE 协议（如果是 SSE 端点）
    if (this.isSseTransport) {
      try {
        return await this.callToolWithMcpProtocol(name, args);
      } catch (e: any) {
        console.warn("[MCP] SSE 协议调用失败，尝试 JSON-RPC:", e.message);
        // 回退到旧的 JSON-RPC 方式
        try {
          return await this.rpc("tools/call", { name, arguments: args ?? {} }, { timeoutMs: 120000 });
        } catch (rpcErr: any) {
          const errMsg = (rpcErr?.message || String(rpcErr)).toLowerCase();
          if (!errMsg.includes("method not found") && !errMsg.includes("-32601")) {
            const debug = this.getLastDebugInfo();
            const debugSummary = debug?.attempts?.map((a: any) => ({
              url: a?.sseUrl?.substring(0, 80),
              connect: a?.connect?.ok,
              handshake: a?.handshake?.messageEndpoint ? 'resolved' : 'not resolved',
              handshakeSource: a?.handshake?.source,
              postStatus: a?.post?.status,
              postError: a?.post?.error?.substring(0, 50),
              responseReceived: a?.response?.received,
              responseSource: a?.response?.source,
              eventsCount: a?.eventsSample?.length || 0,
              error: a?.error?.substring(0, 100),
            })) || [];
            throw new Error(`${rpcErr.message}. Debug: ${JSON.stringify(debugSummary)}`);
          }
        }
      }
    }

    // 最后尝试多种 RPC 方法名
    const candidates = [
      "tools/call",
      "tools.call",
      "call_tool",
      "mcp.call_tool",
    ];

    const probeTimeoutMs = 30000;
    let lastErr: any = null;

    for (const m of candidates) {
      try {
        return await this.rpc(m, { name, arguments: args ?? {}, args: args ?? {} }, { timeoutMs: probeTimeoutMs });
      } catch (e) {
        lastErr = e;
      }
    }

    throw new Error(`DashScope MCP callTool 全部方式均失败。最后错误: ${lastErr?.message || String(lastErr)}`);
  }

  /**
   * 优先使用 REST 调用（减少握手与请求次数）
   * 若检测到 SSE 端点不支持 REST，会缓存并跳过 REST 探测
   */
  async callToolPreferRest(name: string, args: any): Promise<any> {
    const restSupport = this.getRestSupportCached();
    const shouldTryRest = !this.isSseTransport || restSupport !== false;

    if (shouldTryRest) {
      try {
        const r = await this.restCallTool(name, args);
        this.setRestSupportCached(true);
        return r;
      } catch (restErr: any) {
        if (this.isSseTransport && this.isRestNotFoundError(restErr)) {
          this.setRestSupportCached(false);
          console.warn("[MCP] REST 端点不支持（404/405），跳过 REST，回退 SSE:", restErr.message);
        } else {
          throw restErr;
        }
      }
    }

    // 回退到 SSE 协议（仅当 endpoint 是 SSE 类型时）
    if (this.isSseTransport) {
      try {
        return await this.callToolWithMcpProtocol(name, args);
      } catch (e: any) {
        console.warn("[MCP] SSE 协议调用也失败:", e.message);
        // 最后尝试 JSON-RPC
        try {
          return await this.rpc("tools/call", { name, arguments: args ?? {} }, { timeoutMs: 120000 });
        } catch (rpcErr: any) {
          const errMsg = (rpcErr?.message || String(rpcErr)).toLowerCase();
          if (!errMsg.includes("method not found") && !errMsg.includes("-32601")) {
            const debug = this.getLastDebugInfo();
            const debugSummary = debug?.attempts?.map((a: any) => ({
              url: a?.sseUrl?.substring(0, 80),
              connect: a?.connect?.ok,
              handshake: a?.handshake?.messageEndpoint ? 'resolved' : 'not resolved',
              handshakeSource: a?.handshake?.source,
              postStatus: a?.post?.status,
              responseReceived: a?.response?.received,
              eventsCount: a?.eventsSample?.length || 0,
              error: a?.error?.substring(0, 100),
            })) || [];
            throw new Error(`${rpcErr.message}. Debug: ${JSON.stringify(debugSummary)}`);
          }
          throw rpcErr;
        }
      }
    }

    throw new Error(`DashScope MCP 调用失败：REST 和 SSE 均不可用`);
  }
}
