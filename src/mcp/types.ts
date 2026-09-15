export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: any;
}

export interface McpListToolsResponse {
  tools: McpToolInfo[];
}

/**
 * Minimal HTTP-ish MCP client contract for Phase 1.
 * We intentionally keep the types loose because different MCP servers may vary
 * and we don't want to lock to a specific draft prematurely.
 */
export interface McpPingResponse {
  ok: boolean;
  server?: string;
  version?: string;
}

export interface McpCallToolResponse {
  content?: any;
  result?: any;
  error?: any;
}
