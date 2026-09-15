/**
 * Plugin 工具函数（从 main.ts 提取的纯函数）
 */

/** 规范化会话入口模式（处理旧版命名兼容） */
export function normalizeEntryMode(value: string | null | undefined): string | undefined {
  const raw = String(value || '').trim();
  if (!raw) return undefined;
  const legacyMap: Record<string, string> = {
    kb: 'search',
    acp: 'agent',
    'agent-general': 'agent',
    'agent-webparser': 'agent',
    'agent-notes': 'agent',
    'agent-writing': 'agent',
    webparser: 'agent',
    notes: 'agent',
    writing: 'agent',
  };
  return legacyMap[raw] || raw;
}

/** 规范化 MCP 工具列表（去重、合并 provider+name、排序） */
export function normalizeMcpToolsList(list: any): any[] {
  const arr = Array.isArray(list) ? list : [];
  const keyOf = (p: string, n: string) => `${p}::${n}`;
  const map = new Map<string, any>();
  for (const item of arr) {
    const provider = String(item?.provider || "").trim();
    const name = String(item?.name || "").trim();
    if (!name || (provider !== "local" && provider !== "dashscope")) continue;
    const key = keyOf(provider, name);
    if (map.has(key)) {
      const existing = map.get(key) as any;
      map.set(key, {
        provider, name,
        description: existing.description || String(item?.description || ""),
        enabled: Boolean(existing.enabled) || Boolean(item?.enabled),
        lastSeenAt: Math.max(Number(existing.lastSeenAt || 0), Number(item?.lastSeenAt || 0)),
      });
    } else {
      map.set(key, {
        provider, name,
        description: String(item?.description || ""),
        enabled: Boolean(item?.enabled),
        lastSeenAt: Number(item?.lastSeenAt || 0),
      });
    }
  }
  return Array.from(map.values()).sort((a, b) => {
    if (a.provider !== b.provider) return String(a.provider).localeCompare(String(b.provider));
    return String(a.name).localeCompare(String(b.name));
  });
}
