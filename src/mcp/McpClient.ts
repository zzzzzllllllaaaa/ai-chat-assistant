import { requestUrl } from "obsidian";
import { McpCallToolResponse, McpListToolsResponse, McpPingResponse } from "./types";

function assertLocalhostEndpoint(endpoint: string) {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`Invalid MCP endpoint URL: ${endpoint}`);
  }

  const host = (url.hostname || "").toLowerCase();
  const isLocal = host === "localhost" || host === "127.0.0.1";
  
  // Allow local network IPs for mobile-to-desktop connections
  // e.g., 192.168.x.x, 10.x.x.x, 172.16.x.x to 172.31.x.x
  const isLocalNetwork = /^192\.168\.\d+\.\d+$/.test(host) || 
                         /^10\.\d+\.\d+\.\d+$/.test(host) || 
                         /^172\.(1[6-9]|2[0-9]|3[0-1])\.\d+\.\d+$/.test(host) ||
                         // Also allow typical tailscale/zerotier IPs if needed, but standard local is enough for now
                         host.endsWith(".local");

  if (!isLocal && !isLocalNetwork) {
    throw new Error(`MCP endpoint must be localhost or a local network IP for safety (got: ${url.hostname})`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported MCP endpoint protocol: ${url.protocol}`);
  }

  return url;
}

/**
 * Phase-1 MCP client (safe mode):
 * - localhost only
 * - read-only discovery calls (ping/list_tools)
 *
 * NOTE: MCP has multiple transports in the ecosystem (stdio/SSE/ws/etc).
 * Here we provide a minimal HTTP JSON-based probe for PoC and diagnostics.
 */
export class McpClient {
  constructor(private endpoint: string) {}

  private buildUrl(path: string) {
    const base = assertLocalhostEndpoint(this.endpoint);
    const normalized = base.toString().replace(/\/$/, "");
    const p = path.startsWith("/") ? path : `/${path}`;
    return `${normalized}${p}`;
  }

  async ping(): Promise<McpPingResponse> {
    // We try a couple of common debug endpoints.
    const candidates = ["/ping", "/health", "/mcp/ping"];
    let lastErr: any = null;

    for (const p of candidates) {
      try {
        const res = await requestUrl({ url: this.buildUrl(p), method: "GET" });
        // requestUrl may return string/arraybuffer. try parse json; fallback ok.
        const text = typeof res.text === "string" ? res.text : "";
        try {
          const json = JSON.parse(text || "{}");
          return { ok: true, ...json };
        } catch {
          return { ok: true, server: "unknown" };
        }
      } catch (e) {
        lastErr = e;
      }
    }

    throw new Error(`MCP ping failed. Last error: ${lastErr?.message || String(lastErr)}`);
  }

  async listTools(): Promise<McpListToolsResponse> {
    // Common candidates across early implementations.
    const candidates = ["/list_tools", "/tools", "/mcp/tools", "/mcp/list_tools"];
    let lastErr: any = null;

    for (const p of candidates) {
      try {
        const res = await requestUrl({ url: this.buildUrl(p), method: "GET" });
        const text = typeof res.text === "string" ? res.text : "";
        const json = JSON.parse(text || "{}") as any;

        // Normalize a few shapes:
        // { tools: [...] }  OR { result: { tools: [...] } }
        const tools = json?.tools ?? json?.result?.tools;
        if (Array.isArray(tools)) return { tools };

        // If it's already an array, accept.
        if (Array.isArray(json)) return { tools: json };

        throw new Error(`Unexpected list_tools response shape from ${p}`);
      } catch (e) {
        lastErr = e;
      }
    }

    throw new Error(`MCP listTools failed. Last error: ${lastErr?.message || String(lastErr)}`);
  }

  async callTool(name: string, args: any): Promise<McpCallToolResponse> {
    const candidates = ["/call_tool", "/tools/call", "/mcp/call_tool", "/mcp/tools/call"];
    let lastErr: any = null;
    const payload = { name, args };

    for (const p of candidates) {
      try {
        const res = await requestUrl({
          url: this.buildUrl(p),
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        const text = typeof res.text === "string" ? res.text : "";
        const json = JSON.parse(text || "{}") as any;
        const out: McpCallToolResponse = json?.result ?? json;

        if (out?.error) {
          throw new Error(typeof out.error === "string" ? out.error : JSON.stringify(out.error));
        }
        return out;
      } catch (e) {
        lastErr = e;
      }
    }

    throw new Error(`MCP callTool failed. Last error: ${lastErr?.message || String(lastErr)}`);
  }
}
