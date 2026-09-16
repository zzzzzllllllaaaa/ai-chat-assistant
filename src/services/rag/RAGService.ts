import { App, TFile, Notice, requestUrl } from "obsidian";
import type { IPluginContext } from "../../core/plugin-context";;
import type { LLMService } from "../llm/LLMService";
import type { ChatMessage } from "../llm/types";
import { logger } from "../../core/logger";
import { safeNotice } from "../../utils/notice";
import { intentAnalyzer, type TimeIntent } from "../IntentAnalyzer";

export interface ReferenceItem {
  title: string;
  path: string;
  score: number;
  startOffset?: number;
  endOffset?: number;
}

export class RAGService {
  private app: App;
  private plugin: IPluginContext;
  private llmService: LLMService;

    private isDebugEnabled(): boolean {
        // Avoid adding new settings surface; enable via console: window.__AI_CHAT_RAG_DEBUG__ = true
        return (globalThis as any).__AI_CHAT_RAG_DEBUG__ === true;
    }

    private debug(...args: any[]) {
        if (this.isDebugEnabled()) {
            const msg = args.length > 0 && typeof args[0] === 'string' ? String(args[0]) : 'debug';
            const rest = args.length > 1 ? args.slice(1) : [];
            logger.debug("Database", `[RAGService] ${msg}`, rest.length > 0 ? { args: rest } : undefined);
        }
    }

  constructor(app: App, plugin: IPluginContext, llmService: LLMService) {
    this.app = app;
    this.plugin = plugin;
    this.llmService = llmService;
  }

  public isReady(): boolean {
    return this.plugin.vectorIndexManager && this.plugin.vectorIndexManager.vectorIndex.length > 0;
  }

  async search(queryText: string, count: number, contextPaths?: string[], folder?: string, frontmatterFilter?: Record<string, string>): Promise<Array<{ path: string; similarity: number; file: TFile | null; content: string; startOffset?: number; endOffset?: number; links?: string[]; frontmatter?: Record<string, any> }>> {
        if (!this.isReady()) {
            this.debug("search skipped: index not ready", { vectorItems: this.plugin.vectorIndexManager?.vectorIndex?.length });
            return [];
        }

        const startedAt = Date.now();
        this.debug("search start", { queryText, count, contextPaths });

    let searchQueries = [queryText];

    // 0. Intent Analysis for Time-based Queries (跨时间段事件检索优化)
    const intentCtx = { userInput: queryText, currentDate: new Date() };
    const analyzedIntent = intentAnalyzer.analyze(intentCtx);
    const timeIntent = analyzedIntent.timeIntent;
    
    // 如果检测到跨时间段事件（如"去年过年放了多少天假"），自动扩展检索范围
    if (timeIntent && timeIntent.isContinuousEvent && timeIntent.expandedMonths.length > 0) {
        const expandedQueries = intentAnalyzer.generateExpandedSearchQueries(timeIntent, queryText);
        searchQueries = Array.from(new Set([...searchQueries, ...expandedQueries]));
        this.debug("time intent detected, expanded queries", { 
            eventType: timeIntent.eventType, 
            expandedMonths: timeIntent.expandedMonths,
            queries: searchQueries 
        });
        // 静默扩展，不显示 Notice 提示
    }

    // 0.5. Query Rewriting / Expansion
    if (this.plugin.settings.enableQueryRewriting) {
        try {
            const rewritten = await this.rewriteQuery(queryText);
            if (rewritten) {
                const expanded = rewritten.split('\n').map(q => q.trim()).filter(q => q.length > 0);
                if (expanded.length > 0) {
                    searchQueries = Array.from(new Set([...searchQueries, ...expanded]));
                    safeNotice(`🔍 搜索已优化 (生成了 ${expanded.length} 个搜索项)`);
                }
            }
        } catch (e) {
            logger.warn("AI", "Query rewriting failed", e);
        }
    }

    this.debug("search queries", searchQueries);

    // 1. Get Embeddings and Search
    // Increase initialK significantly to ensure we don't miss relevant notes due to embedding noise
    const initialK = Math.max(this.plugin.settings.enableRerank ? count * 20 : count * 10, 200);
    const allRawResults: any[] = [];

    for (const q of searchQueries) {
        const queryVector = await this.llmService.getEmbedding(q);
        const results = await this.plugin.vectorIndexManager.search(queryVector, initialK);
        allRawResults.push(...results);
        this.debug("vector search batch", { q, initialK, returned: results.length, top: results.slice(0, 5).map(r => ({ path: r.path, sim: r.similarity })) });
    }

    // 1.5 Full Keyword Search (always runs — RRF fuses with vector results)
    const keywordRanked = await this.keywordSearch(queryText, initialK);

    // 2. Deduplicate and Merge Results (Keep highest similarity)
    const uniqueResults = new Map<string, any>();
    for (const res of allRawResults) {
        const key = `${res.path}-${res.startOffset}-${res.endOffset}`;
        if (!uniqueResults.has(key) || uniqueResults.get(key).similarity < res.similarity) {
            uniqueResults.set(key, res);
        }
    }

    let results = Array.from(uniqueResults.values());
    this.debug("deduped", { raw: allRawResults.length, unique: results.length });

    // 2.5 RRF Fusion: merge vector ranking with keyword ranking
    results = this.rrfFuse(results, keywordRanked);
    this.debug("rrf fused", { afterFusion: results.length });

    // 3. Detect Time Intent & Calculate Cutoff
    const now = Date.now();
    let cutoffTime = 0;
    let isHardFilter = false;

    const dayMatch = queryText.match(/(?:最近|近|last|past)\s*(\d+)\s*(?:天|日|days?)/i);
    const latestMatch = queryText.match(/(?:最新|最近|latest|recent)/i);
    const afterMatch = queryText.match(/after:(\d{4}-\d{2}-\d{2})/i);
    const allMatch = queryText.match(/(?:全部|所有|历年|历史|以前|过去|曾经|旧|all|every|history|past|old)/i);

    // Only apply hard filter if explicitly requested and NOT asking for "all"
    if (afterMatch && !allMatch) {
        const date = new Date(afterMatch[1]).getTime();
        if (!isNaN(date)) {
            cutoffTime = date;
            isHardFilter = true;
        }
    } else if (dayMatch && !allMatch && queryText.includes("最近")) {
        const days = parseInt(dayMatch[1]);
        cutoffTime = now - (days * 24 * 60 * 60 * 1000);
        isHardFilter = true;
    } else if (latestMatch && !allMatch) {
        // For "latest", we don't hard filter, but we set a soft cutoff for boosting (e.g., last 7 days)
        cutoffTime = now - (7 * 24 * 60 * 60 * 1000);
        isHardFilter = false;
    }

    // 4. Filter & Prepare for Rerank
    let filteredResults = [];
    for (const result of results) {
        const file = this.app.vault.getAbstractFileByPath(result.path);
        if (file instanceof TFile) {
            // Time Filter
            if (isHardFilter && file.stat.mtime < cutoffTime) continue;
            
            // Soft Time Boost
            let score = result.similarity;
            if (!isHardFilter && cutoffTime > 0 && file.stat.mtime > cutoffTime) {
                // If user explicitly asked for "latest", give a much stronger boost
                const latestMatch = queryText.match(/(?:最新|最近|latest|recent)/i);
                score *= latestMatch ? 2.0 : 1.2; 
            }

            // Read Content
            const fullContent = await this.app.vault.cachedRead(file);
            let content = fullContent;
            if (result.startOffset !== undefined && result.endOffset !== undefined) {
                content = fullContent.slice(result.startOffset, result.endOffset);
            }

            filteredResults.push({
                ...result,
                similarity: score,
                file: file,
                content: content
            });
        }
    }

    this.debug("filtered", {
      filtered: filteredResults.length,
      isHardFilter,
      cutoffTime,
      sample: filteredResults.slice(0, 5).map(r => ({ path: r.path, sim: r.similarity }))
    });

    // 4.5 Time Freshness Decay (replaces old additive keyword boosting)
    // Newer notes get higher base score via exponential decay: weight = exp(-age / half_life)
    const FRESHNESS_HALF_LIFE_DAYS = 30; // 30-day half-life — notes half as "fresh" after a month
    for (const res of filteredResults) {
        const mtime = res.file?.stat?.mtime || now;
        const ageDays = (now - mtime) / (1000 * 60 * 60 * 24);
        const freshness = Math.exp(-ageDays / FRESHNESS_HALF_LIFE_DAYS);
        // Blend: 85% RRF score + 15% freshness boost. New notes get up to +15%, old notes don't lose the RRF signal.
        res.similarity = res.similarity * 0.85 + freshness * 0.15;
    }

    // Rerank if enabled
    if (this.plugin.settings.enableRerank && filteredResults.length > 0) {
        try {
            // Use original query for reranking to maintain intent
            filteredResults = await this.rerank(queryText, filteredResults);
        } catch (e: any) {
            const errMsg = String(e?.message || e || '');
            logger.warn("AI", "Rerank failed, falling back to vector score", { error: errMsg });
            // 提供更详细的失败原因
            if (errMsg.includes('API Key')) {
                new Notice("⚠️ Rerank 失败：API Key 未配置。请在「连接管理」中检查 Rerank 模型所属连接。", 5000);
            } else if (errMsg.includes('status 4')) {
                new Notice(`⚠️ Rerank 失败（${errMsg.includes('401') ? '认证失败' : errMsg.includes('404') ? '接口不存在' : '请求被拒绝'}），降级为向量检索`, 5000);
            } else {
                new Notice(`⚠️ Rerank 失败，降级为向量检索\n${errMsg.slice(0, 80)}`, 4000);
            }
        }
    }

    // Sort by adjusted score
    filteredResults.sort((a, b) => b.similarity - a.similarity);

    // Limit initial results before graph expansion to avoid explosion
    // Use the requested count, but cap at 100 to prevent context overflow
    let finalResults = filteredResults.slice(0, Math.min(count, 100));

    // 5. Graph RAG Expansion (query-aware, context-aware)
    if (this.plugin.settings.enableGraphRAG) {
        finalResults = await this.expandWithGraph(finalResults, queryText, contextPaths);
    }

    // 6. Folder filtering (applied after all scoring, expansion, dedup)
    // This ensures vector search + Graph RAG both respect folder boundaries
    if (folder) {
      const normalizedFolder = folder.endsWith('/') ? folder : folder + '/';
      finalResults = finalResults.filter(r => r.path.startsWith(normalizedFolder));
      this.debug("folder filtered", { folder, before: finalResults.length, after: finalResults.length });
    }

    // 6.5 Frontmatter filtering (applied after folder, before final slice)
    if (frontmatterFilter && Object.keys(frontmatterFilter).length > 0) {
      finalResults = finalResults.filter(r => {
        const fm = r.frontmatter;
        if (!fm) return false; // 无 frontmatter 的记录排除
        return Object.entries(frontmatterFilter).every(([key, expected]) => {
          const actual = fm[key];
          if (actual === undefined) return false;
          // 数组值：检查是否包含
          if (Array.isArray(actual)) return actual.includes(expected);
          // 标量值：精确匹配
          return String(actual) === expected;
        });
      });
      this.debug("frontmatter filtered", { filter: frontmatterFilter, after: finalResults.length });
    }

    // Final safety slice to prevent context overflow
        const final = finalResults.slice(0, 100);
        this.debug("search done", { returned: final.length, ms: Date.now() - startedAt, top: final.slice(0, 5).map(r => ({ path: r.path, sim: r.similarity })) });
        return final;
  }

  private async rewriteQuery(query: string): Promise<string> {
      const systemPrompt = `你是一个信息检索专家。你的任务是将用户的查询重写或扩展为多个搜索词，以提高在向量数据库中的召回率。
如果查询是一个宽泛的问题（例如“我做过哪些梦？”），请生成 3-5 个不同的搜索词，涵盖该话题的不同侧面（例如：梦境记录, 梦见, 睡眠日记, 噩梦, 清醒梦）。
如果查询很具体，请提供 2-3 个同义词或相关的表达方式。
请直接输出搜索词，每行一个。不要包含任何解释、引号或序号。使用与原查询相同的语言。`;

      const messages: ChatMessage[] = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: query }
      ];
      
      // 使用 routerModel（轻量模型）进行查询重写，避免调用昂贵的主模型
      const rewriteModel = this.plugin.settings.routerModel || this.plugin.settings.chatModels.split(',')[0];
      logger.debug('AI', `[RAG/rewriteQuery] 查询重写使用模型: ${rewriteModel}`);
      const response = await this.llmService.getCompletion(messages, rewriteModel);
      return response.content ? response.content.trim() : query;
  }

  /**
   * 从 Connections 体系解析模型对应的连接信息（baseUrl / apiKey）。
   * 与 OpenAIProvider.resolveConnectionForModel 逻辑一致，但不依赖 LLM 层。
   */
  private resolveConnectionForModel(model: string): { baseUrl: string; apiKey: string; resolvedModel: string } | null {
      const connections = this.plugin.settings.connections;
      const registry = this.plugin.settings.modelRegistry;
      if (!Array.isArray(connections) || connections.length === 0) return null;

      const normalizeBaseUrl = (url: string) => String(url || '').trim().replace(/\/$/, '');
      const enabledConnections = connections.filter(c => c && c.enabled !== false);
      if (enabledConnections.length === 0) return null;

      // 解析 model@connectionId 格式
      let modelName = model;
      let connId: string | null = null;
      const atIdx = model.lastIndexOf('@');
      if (atIdx > 0) {
          modelName = model.slice(0, atIdx);
          connId = model.slice(atIdx + 1);
      }

      // 从 registry 查找
      if (!connId && Array.isArray(registry) && registry.length > 0 && modelName) {
          const hit = registry.find(r => String(r?.model || '').trim() === modelName);
          if (hit) connId = String(hit.connectionId || '').trim();
      }

      let conn = connId ? enabledConnections.find(c => String(c.id) === connId) : null;
      if (!conn) {
          conn = enabledConnections.find(c => String(c.id) === 'default') || enabledConnections[0];
      }

      const baseUrl = normalizeBaseUrl(String(conn?.baseUrl || ''));
      const apiKey = String(conn?.apiKey || '');
      if (!baseUrl) return null;
      return { baseUrl, apiKey, resolvedModel: modelName };
  }

  /**
   * 从 baseUrl 中提取 rerank 端点。
   * 用户配置的 baseUrl 可能是：
   *   - https://api.siliconflow.cn/v1
   *   - https://api.siliconflow.cn/v1/chat/completions
   *   - https://api.siliconflow.cn
   * 我们需要统一转成 https://api.siliconflow.cn/v1/rerank
   */
  private buildRerankUrl(baseUrl: string): string {
      if (!baseUrl) return '';
      // 已经是 rerank URL
      if (baseUrl.endsWith('/rerank')) return baseUrl;
      // 去掉常见子路径后缀
      let cleaned = baseUrl
          .replace(/\/chat\/completions\/?$/i, '')
          .replace(/\/embeddings\/?$/i, '')
          .replace(/\/completions\/?$/i, '')
          .replace(/\/rerank\/?$/i, '')
          .replace(/\/$/, '');
      // 如果没有 /v1，追加（绝大多数 OpenAI 兼容 API 都用 /v1）
      if (!/\/v\d+$/i.test(cleaned)) {
          cleaned += '/v1';
      }
      return `${cleaned}/rerank`;
  }

  /**
   * 检测是否为 DashScope/百炼 API
   */
  private isDashScopeUrl(url: string): boolean {
      return /dashscope\.aliyuncs\.com/i.test(url) || /dashscope/i.test(url);
  }

  /**
   * 构建 DashScope 专用的 Rerank URL
   * DashScope rerank 端点格式: https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank
   */
  private buildDashScopeRerankUrl(baseUrl: string): string {
      // 如果已经包含 rerank 路径，直接返回
      if (baseUrl.includes('/services/rerank')) return baseUrl;
      // 清理 baseUrl，提取基础域名
      // 关键：DashScope 的 rerank 端点不走 /compatible-mode 前缀
      let base = baseUrl
          .replace(/\/chat\/completions\/?$/i, '')
          .replace(/\/embeddings\/?$/i, '')
          .replace(/\/completions\/?$/i, '')
          .replace(/\/v\d+.*$/i, '') // 去掉 /v1 及之后的路径
          .replace(/\/compatible-mode\/?/i, '/') // rerank 不走 compatible-mode
          .replace(/\/api\/?$/i, '')
          .replace(/\/+$/, '')
          .replace(/\/$/, '');
      // 确保基础域名正确
      if (!base.includes('dashscope.aliyuncs.com')) {
          base = 'https://dashscope.aliyuncs.com';
      }
      return `${base}/api/v1/services/rerank/text-rerank/text-rerank`;
  }

  private async rerank(query: string, documents: any[]): Promise<any[]> {
      const model = this.plugin.settings.rerankModel || "BAAI/bge-reranker-v2-m3";

      // ---- 解析 API 凭据 ----
      const resolved = this.resolveConnectionForModel(model);
      let apiKey = resolved?.apiKey || '';
      let baseUrl = resolved?.baseUrl || '';
      const resolvedModel = resolved?.resolvedModel || model;

      // 回退到旧的独立配置
      if (!apiKey && this.plugin.settings.rerankApiKey) {
          apiKey = this.plugin.settings.rerankApiKey;
      }
      if (!baseUrl && this.plugin.settings.rerankApiUrl) {
          baseUrl = this.plugin.settings.rerankApiUrl;
      }

      if (!apiKey) {
          throw new Error("Rerank API Key 未设置。请在「连接管理」中确保 rerank 模型所属连接已配置 API Key。");
      }

      // ---- 限制文档数量和大小 ----
      const MAX_RERANK_DOCS = 64;
      const MAX_DOC_LEN = 2000;

      const sorted = [...documents].sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
      const topDocs = sorted.slice(0, MAX_RERANK_DOCS);
      const restDocs = sorted.slice(MAX_RERANK_DOCS);

      const docsToRank = topDocs.map(d => {
          const text = typeof d.content === 'string' ? d.content : '';
          return text.length > MAX_DOC_LEN ? text.slice(0, MAX_DOC_LEN) : text;
      });

      // ---- 检测 DashScope 并使用对应格式 ----
      const isDashScope = this.isDashScopeUrl(baseUrl);
      let rerankUrl: string;
      let requestBody: string;

      if (isDashScope) {
          // DashScope/百炼 Rerank API 格式
          rerankUrl = this.buildDashScopeRerankUrl(baseUrl);
          requestBody = JSON.stringify({
              model: resolvedModel,
              input: {
                  query: query,
                  documents: docsToRank
              },
              parameters: {
                  return_documents: false,
                  top_n: topDocs.length
              }
          });
      } else {
          // 标准 OpenAI 兼容格式 (SiliconFlow, Jina 等)
          rerankUrl = this.buildRerankUrl(baseUrl);
          if (!rerankUrl) {
              rerankUrl = 'https://api.siliconflow.cn/v1/rerank';
          }
          requestBody = JSON.stringify({
              model: resolvedModel,
              query: query,
              documents: docsToRank,
              top_n: topDocs.length,
              return_documents: false
          });
      }

      logger.debug('AI', `Rerank: url=${rerankUrl}, model=${resolvedModel}, docs=${docsToRank.length}/${documents.length}, isDashScope=${isDashScope}`);

      try {
          const response = await requestUrl({
              url: rerankUrl,
              method: 'POST',
              headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${apiKey}`
              },
              body: requestBody
          });

          // 解析响应 —— DashScope 和标准格式的结果路径不同
          let rerankResults: Array<{ index: number; relevance_score: number }> | null = null;

          if (response.status === 200) {
              const json = response.json;
              if (isDashScope && json?.output?.results) {
                  // DashScope 格式: { output: { results: [{ index, relevance_score }] } }
                  rerankResults = json.output.results;
              } else if (json?.results) {
                  // 标准格式: { results: [{ index, relevance_score }] }
                  rerankResults = json.results;
              }
          }

          if (rerankResults && rerankResults.length > 0) {
              const scoreMap = new Map<number, number>();
              rerankResults.forEach((r: any) => scoreMap.set(r.index, r.relevance_score));
              const reranked = topDocs.map((doc, idx) => ({
                  ...doc,
                  similarity: scoreMap.get(idx) ?? 0
              }));
              const penalizedRest = restDocs.map(d => ({ ...d, similarity: (d.similarity || 0) * 0.5 }));
              return [...reranked, ...penalizedRest];
          }

          logger.warn('AI', `Rerank returned status ${response.status}, no results`, { body: response.text?.slice(0, 500) });
          throw new Error(`Rerank API returned status ${response.status}`);
      } catch (e: any) {
          const msg = String(e?.message || e || '');
          if (msg.includes('status 4')) {
              logger.error('AI', `Rerank failed: url=${rerankUrl}, model=${resolvedModel}, isDashScope=${isDashScope}, error=${msg}`);
          }
          throw e;
      }
  }

  /**
   * 查询感知的图扩展：
   * 1. 收集初始结果的正/反向链接笔记
   * 2. 读取候选笔记概要 + 用关键词初筛
   * 3. 如果向量索引可用，用 embedding 相似度打分
   * 4. 只保留与查询确实相关的扩展笔记
   */
  private async expandWithGraph(initialResults: any[], queryText?: string, contextPaths?: string[]): Promise<any[]> {
    const depth = this.plugin.settings.graphDepth || 1;
    const enableForward = this.plugin.settings.enableForwardLinks;
    const enableBacklinks = this.plugin.settings.enableBacklinks;
    const maxExpansion = 15;
    const SNIPPET_LEN = 1500;

    const expandedResults = new Map<string, any>();

    // 初始化已有结果
    for (const res of initialResults) {
        expandedResults.set(res.path, res);
    }

    // 提取查询关键词（用于快速预筛）
    const queryKeywords: string[] = [];
    if (queryText) {
        const cjk = queryText.match(/[\u4e00-\u9fa5]{2,}/g) || [];
        const latin = queryText.match(/[a-zA-Z0-9]{2,}/g) || [];
        queryKeywords.push(...cjk, ...latin.map(w => w.toLowerCase()));
    }

    // 收集候选扩展路径（BFS）
    // 将 contextPaths（当前上下文笔记）作为额外的 BFS 起始种子
    const seedPaths = new Set(initialResults.map(r => r.path));
    const contextPathSet = new Set<string>();
    if (contextPaths && contextPaths.length > 0) {
        for (const cp of contextPaths) {
            seedPaths.add(cp);
            contextPathSet.add(cp);
        }
        this.debug("graph expansion: added context seed paths", { contextPaths });
    }
    let currentLevelPaths = Array.from(seedPaths);
    const candidatePaths = new Map<string, number>(); // path → depth
    // 记录直接从 contextPaths 链出/链入的候选（它们有结构价值保底）
    const contextDirectLinks = new Set<string>();

    // ---- 预扫描：为上下文笔记查找 frontmatter 子笔记 ----
    // Obsidian 的 resolvedLinks 不一定包含 frontmatter 属性中的链接。
    // 用户通过 frontmatter 属性（如"父笔记: [[xxx]]"）建立父子关系时，
    // 其他笔记的 frontmatter 中引用了当前笔记 → 那些笔记就是当前笔记的"子笔记"。
    // 直接扫描所有文件的 frontmatter 值来可靠地找到它们。
    if (contextPathSet.size > 0 && enableBacklinks) {
        // 收集上下文笔记的 basename 和去扩展名路径，用于灵活匹配
        const contextNoteInfo = new Map<string, { basename: string; pathNoExt: string }>(); // fullPath → info
        for (const cp of contextPathSet) {
            const f = this.app.vault.getAbstractFileByPath(cp);
            if (f instanceof TFile) {
                contextNoteInfo.set(cp, {
                    basename: f.basename,
                    pathNoExt: cp.replace(/\.md$/i, ''),
                });
            }
        }

        let fmChildrenFound = 0;
        const allMdFiles = this.app.vault.getMarkdownFiles();
        for (const mdFile of allMdFiles) {
            if (expandedResults.has(mdFile.path) || candidatePaths.has(mdFile.path) || contextPathSet.has(mdFile.path)) continue;

            const cache = this.app.metadataCache.getFileCache(mdFile);
            if (!cache?.frontmatter) continue;

            let isChild = false;
            for (const [key, value] of Object.entries(cache.frontmatter)) {
                if (key === 'position') continue;

                // 逐项检查（数组每项单独检查，避免 join 后误匹配）
                const itemsToCheck: string[] = [];
                if (Array.isArray(value)) {
                    for (const item of value) itemsToCheck.push(String(item ?? ''));
                } else if (value != null) {
                    itemsToCheck.push(String(value));
                }

                for (const strVal of itemsToCheck) {
                    if (!strVal) continue;
                    for (const [, { basename, pathNoExt }] of contextNoteInfo) {
                        // 1. [[basename]] — 标准 wikilink
                        if (strVal.includes(`[[${basename}]]`)) { isChild = true; break; }
                        // 2. [[basename|别名]] — 带别名的 wikilink
                        if (strVal.includes(`[[${basename}|`)) { isChild = true; break; }
                        // 3. [[folder/basename]] 或 [[folder/basename|别名]] — 全路径引用
                        if (pathNoExt !== basename && (strVal.includes(`[[${pathNoExt}]]`) || strVal.includes(`[[${pathNoExt}|`))) { isChild = true; break; }
                        // 4. 纯文本精确匹配（YAML 值恰好是笔记名，无 [[ ]]）
                        if (strVal.trim() === basename) { isChild = true; break; }
                    }
                    if (isChild) break;
                }
                if (isChild) break;
            }

            if (isChild) {
                candidatePaths.set(mdFile.path, 0);
                contextDirectLinks.add(mdFile.path);
                fmChildrenFound++;
            }
        }

        // 补充：尝试 Obsidian 内置 backlinks API（可能包含 frontmatter links）
        for (const [cp] of contextNoteInfo) {
            const ctxFile = this.app.vault.getAbstractFileByPath(cp);
            if (!(ctxFile instanceof TFile)) continue;
            try {
                // @ts-ignore: getBacklinksForFile may include frontmatterLinks in newer Obsidian
                const backlinks = this.app.metadataCache.getBacklinksForFile(ctxFile);
                if (backlinks?.data) {
                    for (const sourcePath of backlinks.data.keys()) {
                        if (!expandedResults.has(sourcePath) && !candidatePaths.has(sourcePath) && !contextPathSet.has(sourcePath)) {
                            candidatePaths.set(sourcePath, 0);
                            contextDirectLinks.add(sourcePath);
                            fmChildrenFound++;
                        }
                    }
                }
            } catch { /* API 可能不可用 */ }
        }

        this.debug("graph expansion: frontmatter children scan", {
            contextBasenames: Array.from(contextNoteInfo.values()).map(v => v.basename),
            childrenFound: fmChildrenFound,
            childPaths: Array.from(contextDirectLinks).slice(0, 10)
        });
    }

    for (let d = 0; d < depth; d++) {
        const nextLevelPaths = new Set<string>();

        for (const path of currentLevelPaths) {
            if (candidatePaths.size >= maxExpansion * 3) break; // 收集 3 倍候选
            const file = this.app.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) continue;

            const isContextSeed = contextPathSet.has(path);

            if (enableForward) {
                // 正文链接 + resolvedLinks 中的属性链接
                const links = this.app.metadataCache.resolvedLinks[path] || {};
                for (const linkPath of Object.keys(links)) {
                    if (!expandedResults.has(linkPath) && !candidatePaths.has(linkPath)) {
                        candidatePaths.set(linkPath, d);
                        nextLevelPaths.add(linkPath);
                        if (isContextSeed && d === 0) contextDirectLinks.add(linkPath);
                    }
                }
            }

            if (enableBacklinks) {
                // 正文反向链接（resolvedLinks 反向查找）
                for (const [sourcePath, links] of Object.entries(this.app.metadataCache.resolvedLinks)) {
                    if (links[path] && !expandedResults.has(sourcePath) && !candidatePaths.has(sourcePath)) {
                        candidatePaths.set(sourcePath, d);
                        nextLevelPaths.add(sourcePath);
                        if (isContextSeed && d === 0) contextDirectLinks.add(sourcePath);
                    }
                }
                // 注意：frontmatter 属性子笔记已在 BFS 前的预扫描中处理
            }
        }

        currentLevelPaths = Array.from(nextLevelPaths);
        if (currentLevelPaths.length === 0) break;
    }

    if (candidatePaths.size === 0) return Array.from(expandedResults.values());

    this.debug("graph expansion candidates", {
        candidates: candidatePaths.size,
        contextDirectLinks: contextDirectLinks.size,
        contextDirectLinkPaths: Array.from(contextDirectLinks).slice(0, 10),
        queryKeywords
    });

    // ---- 对候选进行打分筛选 ----
    interface ScoredCandidate {
        path: string;
        depth: number;
        content: string;
        score: number;
        file: TFile;
        isContextDirectLink: boolean;
    }

    const scored: ScoredCandidate[] = [];

    for (const [path, d] of candidatePaths) {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile) || file.extension !== 'md') continue;

        let content: string;
        try {
            content = await this.app.vault.cachedRead(file);
        } catch { continue; }

        const snippet = content.slice(0, SNIPPET_LEN);
        const isContextDirect = contextDirectLinks.has(path);

        // 基础分：连接深度衰减
        let score = 0.4 / (d + 1);

        // 上下文直接链接奖励：用户主动选择的笔记的直接链接，结构关系本身有价值
        if (isContextDirect) {
            score = Math.max(score, 0.35); // 保底 0.35，高于阈值 0.15
        }

        // 关键词匹配加分
        if (queryKeywords.length > 0) {
            const lowerSnippet = snippet.toLowerCase();
            const lowerPath = path.toLowerCase();
            let kwMatches = 0;
            for (const kw of queryKeywords) {
                if (lowerSnippet.includes(kw) || lowerPath.includes(kw)) {
                    kwMatches++;
                }
            }
            if (kwMatches > 0) {
                // 关键词匹配度奖励
                score += 0.15 * kwMatches;
            } else if (!isContextDirect) {
                // 没有任何关键词匹配且不是上下文直接链接 → 降权
                score *= 0.3;
            }
            // 上下文直接链接即使不匹配关键词也不降权（结构关系已提供保底）
        }

        scored.push({ path, depth: d, content: snippet, score, file, isContextDirectLink: isContextDirect });
    }

    // 尝试用向量相似度进一步精调（如果索引可用且查询存在）
    if (queryText && scored.length > 0 && this.plugin.vectorIndexManager?.vectorIndex?.length > 0) {
        try {
            const queryVector = await this.llmService.getEmbedding(queryText);
            if (queryVector && queryVector.length > 0) {
                // 在向量索引中查找这些候选路径的向量
                const indexEntries = this.plugin.vectorIndexManager.vectorIndex;
                const vectorMap = new Map<string, Float32Array | number[]>();
                for (const entry of indexEntries) {
                    if (candidatePaths.has(entry.path) && entry.vector) {
                        vectorMap.set(entry.path, entry.vector);
                    }
                }

                for (const candidate of scored) {
                    const vec = vectorMap.get(candidate.path);
                    if (vec) {
                        const cosSim = this.cosineSimilarity(queryVector, vec);
                        // 用向量相似度替换/增强原始分数
                        // 向量高相关 → 大幅加分；低相关 → 保持关键词分数
                        if (cosSim > 0.3) {
                            candidate.score = Math.max(candidate.score, cosSim * 0.8);
                        }
                    }
                }
            }
        } catch (e) {
            // embedding 获取失败不影响流程，仍用关键词分数
            this.debug("graph expansion embedding fallback", e);
        }
    }

    // 按 score 排序，只取 top maxExpansion 且 score > 阈值
    const MIN_EXPANSION_SCORE = 0.15;
    scored.sort((a, b) => b.score - a.score);
    let expansionCount = 0;

    for (const candidate of scored) {
        if (expansionCount >= maxExpansion) break;
        if (candidate.score < MIN_EXPANSION_SCORE) break;

        expandedResults.set(candidate.path, {
            path: candidate.path,
            similarity: candidate.score,
            file: candidate.file,
            content: candidate.content,
            isGraphNode: true
        });
        expansionCount++;
    }

    this.debug("graph expansion done", {
        expanded: expansionCount,
        total: expandedResults.size,
        contextDirectLinksIncluded: scored.filter(s => s.isContextDirectLink && s.score >= MIN_EXPANSION_SCORE).length,
        topScored: scored.slice(0, 8).map(s => ({
            path: s.path.split('/').pop(),
            score: s.score.toFixed(3),
            ctxDirect: s.isContextDirectLink,
            depth: s.depth
        }))
    });
    return Array.from(expandedResults.values());
  }

  /** 计算两个向量的余弦相似度 */
  private cosineSimilarity(a: number[] | Float32Array, b: number[] | Float32Array): number {
      if (a.length !== b.length || a.length === 0) return 0;
      let dot = 0, normA = 0, normB = 0;
      for (let i = 0; i < a.length; i++) {
          dot += a[i] * b[i];
          normA += a[i] * a[i];
          normB += b[i] * b[i];
      }
      const denom = Math.sqrt(normA) * Math.sqrt(normB);
      return denom === 0 ? 0 : dot / denom;
  }

  /**
   * 全量关键词搜索 — 对所有 Markdown 文件做 BM25-like TF-IDF 打分。
   * 返回带 score 的 ranked list，供 RRF 融合。
   */
  private async keywordSearch(query: string, topK: number): Promise<Array<{ path: string; score: number; startOffset?: number; endOffset?: number }>> {
      const startedAt = Date.now();
      
      // 提取关键词（中文按1+字符、英文按2+字符）
      const rawKeywords: string[] = [];
      const cjkMatches = query.match(/[\u4e00-\u9fa5]{1,}/g) || [];
      rawKeywords.push(...cjkMatches);
      const latinMatches = query.match(/[a-zA-Z0-9]{2,}/g) || [];
      rawKeywords.push(...latinMatches.map(w => w.toLowerCase()));

      // 去重 + 过滤停用词
      const STOP_WORDS = new Set(['的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一', '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这']);
      const keywords = Array.from(new Set(rawKeywords)).filter(kw => !STOP_WORDS.has(kw));

      if (keywords.length === 0) return [];

      const files = this.app.vault.getMarkdownFiles();
      const totalDocs = files.length;
      const results: Array<{ path: string; score: number; startOffset?: number; endOffset?: number }> = [];
      
      // 第一阶段：只扫文件名（极快），筛出候选
      const candidates: Array<{ file: typeof files[0]; nameScore: number }> = [];
      for (const file of files) {
          const fileName = file.path.toLowerCase();
          let nameScore = 0;
          for (const kw of keywords) {
              const kwLower = kw.toLowerCase();
              const hits = (fileName.match(new RegExp(this.escapeRegex(kwLower), 'g')) || []).length;
              if (hits > 0) {
                  const tf = hits / Math.max(fileName.split(/[/\\]/).pop()?.length || 1, 1) * 100;
                  const idf = Math.log((totalDocs + 0.5) / (1 + 0.5) + 1);
                  nameScore += tf * idf * 2.0;
              }
          }
          if (nameScore > 0) {
              candidates.push({ file, nameScore });
          }
      }
      
      // 文件名命中→直接加，内容只在候选前 300 名内读
      const MAX_CONTENT_READS = 300;
      for (const { file, nameScore } of candidates) {
          results.push({ path: file.path, score: nameScore });
          if (results.length >= topK * 2) continue; // 够了就不读内容了
      }
      
      // 文件名没命中的文件，只取前 N 份读内容（按最近修改时间排序，新文件优先）
      const nameHitPaths = new Set(candidates.map(c => c.file.path));
      const nonNameHitFiles = files.filter(f => !nameHitPaths.has(f.path));
      // 按 mtime 倒序，新文件更可能有匹配
      nonNameHitFiles.sort((a, b) => (b.stat?.mtime || 0) - (a.stat?.mtime || 0));
      const filesToScan = nonNameHitFiles.slice(0, MAX_CONTENT_READS);
      
      for (const file of filesToScan) {
          let score = 0;
          try {
              const content = await this.app.vault.cachedRead(file);
              const contentLower = content.toLowerCase();
              for (const kw of keywords) {
                  const kwLower = kw.toLowerCase();
                  const contentHits = (contentLower.match(new RegExp(this.escapeRegex(kwLower), 'g')) || []).length;
                  if (contentHits > 0) {
                      const tf = Math.log(1 + contentHits);
                      const idf = Math.log((totalDocs - 1 + 0.5) / (1 + 0.5) + 1);
                      score += tf * idf;
                  }
              }
          } catch {
              // cachedRead 失败跳过
          }
          if (score > 0) {
              // 如果已经在文件名结果里，加内容分；否则新增
              const existing = results.find(r => r.path === file.path);
              if (existing) {
                  existing.score += score;
              } else {
                  results.push({ path: file.path, score });
              }
          }
      }
      
      // 按 BM25 score 降序排列
      results.sort((a, b) => b.score - a.score);
      
      this.debug("keywordSearch done", {
          keywords,
          totalDocs,
          matched: results.length,
          topK,
          ms: Date.now() - startedAt,
          top5: results.slice(0, 5).map(r => ({ path: r.path.split('/').pop(), score: r.score.toFixed(2) }))
      });
      
      return results.slice(0, Math.max(topK, 100));
  }

  /** 转义正则特殊字符 */
  private escapeRegex(str: string): string {
      return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * RRF (Reciprocal Rank Fusion) — 融合两个独立排名列表。
   * k=60 是标准值，对排名位置敏感但不极端。
   * 返回融合后的结果列表，score=RRF分数。
   */
  private rrfFuse(
      vectorResults: Array<{ path: string; similarity: number; startOffset?: number; endOffset?: number; links?: string[]; frontmatter?: Record<string, any> }>,
      keywordResults: Array<{ path: string; score: number }>,
      k: number = 60
  ): Array<{ path: string; similarity: number; startOffset?: number; endOffset?: number; links?: string[]; frontmatter?: Record<string, any> }> {
      // 为每个列表建 path→rank 映射
      const vecRank = new Map<string, number>();
      vectorResults.forEach((r, i) => {
          const key = r.path;
          if (!vecRank.has(key) || vecRank.get(key)! > i) vecRank.set(key, i);
      });
      
      const kwRank = new Map<string, number>();
      keywordResults.forEach((r, i) => {
          const key = r.path;
          if (!kwRank.has(key) || kwRank.get(key)! > i) kwRank.set(key, i);
      });
      
      // 收集所有出现的 path
      const allPaths = new Set([...vecRank.keys(), ...kwRank.keys()]);
      
      // 计算 RRF 分数
      const fused = new Map<string, number>();
      for (const path of allPaths) {
          let rrf = 0;
          if (vecRank.has(path)) rrf += 1 / (k + vecRank.get(path)! + 1);
          if (kwRank.has(path)) rrf += 1 / (k + kwRank.get(path)! + 1);
          fused.set(path, rrf);
      }
      
      // 构建结果列表：复用 vector 结果的 startOffset/endOffset，新增 keyword-only 结果的占位
      const vecMap = new Map(vectorResults.map(r => [r.path, r]));
      const merged: Array<{ path: string; similarity: number; startOffset?: number; endOffset?: number; links?: string[]; frontmatter?: Record<string, any> }> = [];

      for (const [path, rrfScore] of fused) {
          const vec = vecMap.get(path);
          merged.push({
              path,
              similarity: rrfScore,
              startOffset: vec?.startOffset,
              endOffset: vec?.endOffset,
              links: vec?.links,
              frontmatter: vec?.frontmatter,
          });
      }
      
      // 按 RRF 分数降序排列
      merged.sort((a, b) => b.similarity - a.similarity);
      
      this.debug("rrfFuse done", {
          vectorCount: vectorResults.length,
          keywordCount: keywordResults.length,
          fusedCount: merged.length,
          top5: merged.slice(0, 5).map(r => ({
              path: r.path.split('/').pop(),
              rrf: r.similarity.toFixed(4),
              vecRank: vecRank.get(r.path),
              kwRank: kwRank.get(r.path)
          }))
      });
      
      return merged;
  }
}
