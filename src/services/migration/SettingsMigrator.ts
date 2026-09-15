/**
 * 设置迁移服务
 * 处理旧版本 settings 数据格式到新格式的迁移
 * 每个迁移函数返回是否修改了 settings
 */
export class SettingsMigrator {
  /**
   * 迁移旧版协作模式设置到 collaborationStrategy 字段
   */
  static migrateCollaborationSettings(settings: any, raw?: any): boolean {
    if (settings.collaborationStrategy && ['simple', 'slow-thinking', 'pipeline', 'state-graph'].includes(settings.collaborationStrategy)) {
      return false;
    }
    if (raw?.enableCollaborationStateGraph === true) {
      settings.collaborationStrategy = 'state-graph';
    } else if (raw?.enableCollaborationPipelineMode === true) {
      settings.collaborationStrategy = 'pipeline';
    } else if (raw?.enableCollaborationSlowThinking === true) {
      settings.collaborationStrategy = 'slow-thinking';
    } else {
      settings.collaborationStrategy = 'simple';
    }
    delete settings.collaborationComplexity;
    delete settings.enableCollaborationSlowThinking;
    delete settings.enableCollaborationPipelineMode;
    delete settings.enableCollaborationStateGraph;
    return true;
  }

  /**
   * 迁移 MCP 工具配置到新格式
   */
  static migrateMcpTools(settings: any, raw?: any): boolean {
    let changed = false;
    if (!Array.isArray(settings.mcpTools)) {
      settings.mcpTools = [];
      changed = true;
    }
    const legacy = Array.isArray(raw?.mcpAllowedTools)
      ? raw.mcpAllowedTools
      : Array.isArray(settings.mcpAllowedTools)
        ? settings.mcpAllowedTools
        : [];
    const legacyNames = legacy
      .map((x: any) => String(x || "").trim())
      .filter((x: string) => x.length > 0);
    if (legacyNames.length > 0) {
      const keyOf = (provider: string, name: string) => `${provider}::${name}`;
      const map = new Map<string, any>();
      for (const item of Array.isArray(settings.mcpTools) ? settings.mcpTools : []) {
        if (!item) continue;
        const provider = String(item?.provider || "").trim();
        const name = String(item?.name || "").trim();
        if (!provider || !name) continue;
        map.set(keyOf(provider, name), item);
      }
      for (const name of legacyNames) {
        for (const provider of ["local", "dashscope"]) {
          const k = keyOf(provider, name);
          if (map.has(k)) continue;
          map.set(k, { provider, name, description: "", enabled: true, lastSeenAt: 0 });
          changed = true;
        }
      }
      if (changed) settings.mcpTools = Array.from(map.values());
    }
    const normalized: any[] = [];
    for (const item of Array.isArray(settings.mcpTools) ? settings.mcpTools : []) {
      const provider = String(item?.provider || "").trim();
      const name = String(item?.name || "").trim();
      if (!name || (provider !== "local" && provider !== "dashscope")) continue;
      normalized.push({
        provider, name,
        description: String(item?.description || ""),
        enabled: Boolean(item?.enabled),
        lastSeenAt: Number(item?.lastSeenAt || 0),
      });
    }
    if (normalized.length !== (Array.isArray(settings.mcpTools) ? settings.mcpTools.length : 0)) {
      settings.mcpTools = normalized;
      changed = true;
    }
    return changed;
  }

  /**
   * 迁移旧版 API 配置到 connections + modelRegistry 格式
   */
  static migrateApiConfig(settings: any): boolean {
    const version = Number(settings.apiConfigVersion || 0);
    const hasNew = Array.isArray(settings.connections) && Array.isArray(settings.modelRegistry);
    if (version >= 1 && hasNew) return false;

    const normalizeBaseUrl = (url: string) => String(url || '').trim().replace(/\/$/, "");
    const ensureId = (id: string) => String(id || '').trim() || String(Date.now());
    const connections: any[] = Array.isArray(settings.connections) ? [...settings.connections] : [];
    const registry: any[] = Array.isArray(settings.modelRegistry) ? [...settings.modelRegistry] : [];

    const addConnIfMissing = (conn: any) => {
      if (!conn) return;
      const id = ensureId(conn.id);
      if (connections.some(c => String(c.id) === id)) return;
      connections.push({ id, name: String(conn.name || id), baseUrl: normalizeBaseUrl(conn.baseUrl), apiKey: String(conn.apiKey || ''), enabled: conn.enabled !== false });
    };
    const addModel = (model: string, connectionId: string) => {
      const m = String(model || '').trim();
      const cid = String(connectionId || '').trim();
      if (!m || !cid) return;
      if (registry.some((r: any) => String(r.model) === m)) return;
      registry.push({ model: m, connectionId: cid });
    };

    const legacyDefaultBaseUrl = settings.aiProvider === 'openai' ? 'https://api.openai.com/v1' : normalizeBaseUrl(settings.customApiUrl);
    const legacyDefaultKey = settings.aiProvider === 'openai' ? String(settings.openaiApiKey || '') : String(settings.customApiKey || '');
    const defaultConnId = 'default';
    addConnIfMissing({ id: defaultConnId, name: settings.aiProvider === 'openai' ? '默认连接（OpenAI）' : '默认连接（自定义）', baseUrl: legacyDefaultBaseUrl || 'https://api.openai.com/v1', apiKey: legacyDefaultKey, enabled: true });

    const legacyProviders = Array.isArray(settings.providers) ? settings.providers : [];
    for (const p of legacyProviders) {
      const connId = `legacy-${ensureId(p?.id)}`;
      addConnIfMissing({ id: connId, name: String(p?.name || connId), baseUrl: normalizeBaseUrl(p?.baseUrl), apiKey: String(p?.apiKey || ''), enabled: true });
      const models = Array.isArray(p?.models) ? p.models : [];
      for (const m of models) addModel(String(m), connId);
    }

    const legacyChatModels = String(settings.chatModels || '').split(',').map((m: string) => m.trim()).filter(Boolean);
    for (const m of legacyChatModels) addModel(m, defaultConnId);

    const roleCandidates = [settings.defaultChatModel, settings.embeddingModel, settings.inlineAIModel, settings.routerModel, settings.plannerModel, settings.writerModel]
      .map((x: any) => String(x || '').trim()).filter(Boolean);
    for (const m of roleCandidates) {
      if (!registry.some((r: any) => String(r.model) === m)) addModel(m, defaultConnId);
    }

    if (!String(settings.defaultChatModel || '').trim()) {
      settings.defaultChatModel = legacyChatModels[0] || (registry[0]?.model ?? '');
    }

    settings.connections = connections;
    settings.modelRegistry = registry;
    settings.apiConfigVersion = 1;
    return true;
  }
}
