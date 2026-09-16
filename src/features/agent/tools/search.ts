import { App, TFile } from "obsidian";
import type { Tool } from "../types";
import type { ChatMessage } from "../../../services/llm/types";
import { logger } from "../../../core/logger";

export class SearchNotesTool implements Tool {
  definition = {
    name: "search_notes",
    description: "快速关键词搜索。按文件名和正文中的字面文本匹配笔记，适合已知词语、标题、短语或精确片段；如果你要按语义找相关内容或先收集证据片段，优先使用 knowledge_base_query。",
    parameters: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "搜索关键词",
        },
        maxResults: {
          type: "number",
          description: "最多返回多少条匹配结果（默认 5）",
        },
        maxScanFiles: {
          type: "number",
          description: "最多扫描的文件数量（默认 80，用于避免大库全量扫描导致卡顿/超时）",
        },
        maxScanMs: {
          type: "number",
          description: "最大扫描耗时（毫秒，默认 2000，用于保证快速反馈）",
        },
      },
      required: ["query"],
    },
  };

  async execute(args: { query: string; maxResults?: number; maxScanFiles?: number; maxScanMs?: number }, app: App): Promise<string> {
    const { query, maxResults = 5 } = args;
    const files = app.vault.getMarkdownFiles();
    const fileCount = files.length;
    const maxScanFiles = Number.isFinite(args.maxScanFiles as any)
      ? Math.max(1, Math.floor(args.maxScanFiles as any))
      : (fileCount > 3000 ? 240 : fileCount > 1500 ? 160 : 80);
    const maxScanMs = Number.isFinite(args.maxScanMs as any)
      ? Math.max(50, Math.floor(args.maxScanMs as any))
      : (fileCount > 3000 ? 3000 : fileCount > 1500 ? 2500 : 2000);
    const startedAt = Date.now();
    const normalizedQuery = String(query || "").trim();
    const queryLower = normalizedQuery.toLowerCase();
    const stopWords = new Set([
      "请", "帮我", "麻烦", "一下", "看看", "查一下", "搜索", "查找", "检索", "找到", "列出", "全部", "所有", "逐个", "分别", "补全", "补充", "完善", "内容", "笔记", "文件", "里面", "当前", "这个", "那个", "相关", "以及", "并且", "然后", "再", "如果", "目标", "内链"
    ]);
    const keywordTerms = Array.from(new Set(
      normalizedQuery
        .split(/[\s,，。！？、:：;；()（）【】\[\]\-\/\\]+/)
        .map(s => s.trim())
        .filter(Boolean)
        .filter(s => /[\u4e00-\u9fa5A-Za-z0-9]/.test(s))
        .filter(s => s.length >= 2 && s.length <= 24)
        .filter(s => !stopWords.has(s))
    )).slice(0, 6);
    const effectiveTerms = keywordTerms.length > 0 ? keywordTerms : [normalizedQuery].filter(Boolean);
    const results: string[] = [];
    let scanned = 0;
    let stoppedEarly = false;

    for (const file of files) {
      if (results.length >= maxResults) break;

      if (scanned >= maxScanFiles) {
        stoppedEarly = true;
        break;
      }
      if (Date.now() - startedAt > maxScanMs) {
        stoppedEarly = true;
        break;
      }
      scanned++;

      const lowerBase = file.basename.toLowerCase();
      const lowerPath = file.path.toLowerCase();
      const fileHitTerm = effectiveTerms.find(term => lowerBase.includes(term.toLowerCase()) || lowerPath.includes(term.toLowerCase()));
      if (fileHitTerm) {
        results.push(`- [文件名/路径匹配] ${file.path} (term: ${fileHitTerm})`);
        continue;
      }

      try {
        const content = await app.vault.cachedRead(file);
        const lower = content.toLowerCase();
        const hitTerm = effectiveTerms.find(term => lower.includes(term.toLowerCase()));
        if (hitTerm) {
          const hitLower = hitTerm.toLowerCase();
          const index = lower.indexOf(hitLower);
          const start = Math.max(0, index - 30);
          const end = Math.min(content.length, index + hitTerm.length + 80);
          const snippet = content.substring(start, end).replace(/\n/g, " ");
          results.push(`- [内容匹配] ${file.path}: "...${snippet}..." (term: ${hitTerm})`);
        }
      } catch {
        // 忽略读取错误
      }
    }

    const meta = `\n（query=${JSON.stringify(normalizedQuery)}；terms=${effectiveTerms.join(", ")}；已扫描 ${scanned}/${Math.min(files.length, maxScanFiles)} 个文件${stoppedEarly ? '，为保证速度已提前停止' : ''}）`;
    if (results.length === 0) {
      return `未找到包含 "${normalizedQuery}" 的笔记。${meta}`;
    }

    return `搜索结果 ("${normalizedQuery}"):\n${results.join("\n")}${meta}`;
  }
}

export class VectorSearchTool implements Tool {
  private plugin: any;

  constructor(plugin: any) {
    this.plugin = plugin;
  }

  definition = {
    name: "vector_search",
    description: "直接做向量相似度检索，返回语义上接近的笔记片段。它和 knowledge_base_query 能力相近，但更偏底层检索入口；默认主路径优先使用 knowledge_base_query，只有在你明确需要直接调用向量检索时再用这个工具。",
    parameters: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "语义检索查询文本",
        },
        limit: {
          type: "number",
          description: "返回结果数量 (默认 5)",
        },
      },
      required: ["query"],
    },
  };

  async execute(args: { query: string; limit?: number }, app: App): Promise<string> {
    const { query, limit = (this.plugin as any).settings.retrievalCount || 5 } = args;
    const retriever = this.plugin.ragService; // Updated to use ragService
    
    if (!retriever || !retriever.isReady()) {
      return "错误: 知识库索引未加载或不可用。";
    }

    try {
      const results = await retriever.search(query, limit);

      if (results.length === 0) {
        return "未找到相关笔记。";
      }

      let output = `找到 ${results.length} 个相关笔记:\n`;
      for (const res of results) {
        const similarity = (res.similarity * 100).toFixed(1);
        const snippet = res.content.slice(0, 150).replace(/[\r\n]+/g, ' ').trim();
        output += `- [${similarity}%] ${res.path}\n  摘要: ${snippet}...\n`;
      }
      return output;
    } catch (e: any) {
      return `检索失败: ${e.message}`;
    }
  }
}

export class GetRecentNotesTool implements Tool {
  definition = {
    name: "get_recent_notes",
    description: "获取最近修改或创建的笔记列表。用于总结近期的工作或关注点。",
    parameters: {
      type: "object" as const,
      properties: {
        days: {
          type: "number",
          description: "获取最近几天的笔记 (默认 7 天)",
        },
        limit: {
          type: "number",
          description: "最大返回数量 (默认 20)",
        },
      },
      required: [],
    },
  };

  async execute(args: { days?: number; limit?: number }, app: App): Promise<string> {
    const days = args.days || 7;
    const limit = args.limit || 20;
    const now = Date.now();
    const msPerDay = 24 * 60 * 60 * 1000;
    const threshold = now - (days * msPerDay);

    const files = app.vault.getMarkdownFiles();
    
    const recentFiles = files
      .filter(f => f.stat.mtime >= threshold || f.stat.ctime >= threshold)
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, limit);

    if (recentFiles.length === 0) {
      return `在过去 ${days} 天内没有找到修改过的笔记。`;
    }

    const list = recentFiles.map(f => {
      const mtime = new Date(f.stat.mtime).toLocaleString();
      return `- ${f.path} (修改时间: ${mtime})`;
    }).join("\n");

    return `过去 ${days} 天内最近修改的笔记 (前 ${limit} 条):\n${list}`;
  }
}

export class KnowledgeBaseQueryTool implements Tool {
  private plugin: any;

  constructor(plugin: any) {
    this.plugin = plugin;
  }

  definition = {
    name: "knowledge_base_query",
    description: "从本地知识库中检索最相关的笔记片段，返回可继续阅读的证据列表。适合回答“我之前写过什么 / 哪些笔记和这个主题相关 / 先找相关片段再展开读”；默认只返回路径、相似度和短摘录，如需全文再用 read_note。",
    parameters: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "问题、主题或关键词；会按语义检索相关笔记片段",
        },
        limit: {
          type: "number",
          description: "返回的结果数量 (默认 10，最大 50)",
        },
        maxSnippetChars: {
          type: "number",
          description: "每条结果最多返回多少字符作为摘录 (默认 600，最大 2000)",
        },
        offset: {
          type: "number",
          description: "分页偏移（默认 0）。例如 offset=10, limit=10 表示取第 11-20 条。",
        },
      },
      required: ["query"],
    },
  };

  async execute(
    args: { query: string; limit?: number; maxSnippetChars?: number; offset?: number },
    app: App
  ): Promise<string> {
    const query = args.query;
    const limit = Math.min(Math.max(1, args.limit ?? 10), 50);
    const offset = Math.max(0, args.offset ?? 0);
    const maxSnippetChars = Math.min(Math.max(100, args.maxSnippetChars ?? 600), 2000);
    const ragService = (this.plugin as any).ragService;
    
    if (!ragService || !ragService.isReady()) {
      return "错误: 知识库未就绪或索引为空。请确保已在设置中完成索引。";
    }

    try {
      const requested = Math.min(50, offset + limit);
      logger.debug("Database", "KnowledgeBaseQueryTool: search", { query, limit, offset, maxSnippetChars, requested });
      // 移除污染向量空间的 "全部 历史" 词汇，保持语义纯净
      const results = await ragService.search(query, requested);
      
      if (results.length === 0) {
        // Fallback 1: Use LLM to extract core keywords (Most robust method)
        const llmService = (this.plugin as any).llmService;
        if (llmService) {
             const extractionPrompt: ChatMessage[] = [
                 { role: 'system', content: 'You are a keyword extraction tool. Extract the core subject keywords from the user query for database search. Return ONLY the keywords separated by space. No explanations. Example: "List all my dreams" -> "梦 梦境"' },
                 { role: 'user', content: query }
             ];
             try {
                 const model = (this.plugin as any).settings.routerModel || (this.plugin as any).settings.chatModels.split(',')[0];
                 const keywordResponse = await llmService.getCompletion(extractionPrompt, model);
                 const extractedKeywords = keywordResponse.content ? keywordResponse.content.trim() : "";
                 
                 if (extractedKeywords && extractedKeywords !== query && extractedKeywords.length > 0) {
                   logger.debug("AI", "KnowledgeBaseQueryTool: LLM extracted keywords", { extractedKeywords, query });
                     // 同样不加污染词
                     const fallbackResults = await ragService.search(extractedKeywords, requested);
                     if (fallbackResults.length > 0) {
                         const sliced = fallbackResults.slice(offset, offset + limit);
                         let output = `[智能重试成功] 使用关键词 "${extractedKeywords}" 找到 ${fallbackResults.length} 条候选结果（当前返回 ${sliced.length} 条，offset=${offset}, limit=${limit}）：\n\n`;
                         sliced.forEach((res: any, idx: number) => {
                           const similarity = (res.similarity * 100).toFixed(1);
                           const snippet = String(res.content || "")
                             .replace(/[\r\n]+/g, ' ')
                             .trim()
                             .slice(0, maxSnippetChars);
                           output += `- [${offset + idx + 1}] [${similarity}%] ${res.path}\n  摘录: ${snippet}${snippet.length >= maxSnippetChars ? '…' : ''}\n`;
                         });
                         output += `\n提示：如需某条结果全文，请对该 path 调用 read_note。\n`;
                         if (fallbackResults.length > offset + limit) {
                           output += `如需更多结果：使用 offset=${offset + limit}, limit=${limit} 继续调用 knowledge_base_query。\n`;
                         }
                         return output;
                     }
                 }
             } catch (err) {
               logger.warn("AI", "LLM keyword extraction failed", err);
             }
        }

        // Fallback 2: Strip common command words (Legacy regex method)
        const cleanQuery = query.replace(/帮我|列出|全部|所有|查找|搜索|显示|关于|的|笔记|内容|记录|我做过的|我写的|提到的|相关的|一下/g, ' ').trim();
        if (cleanQuery && cleanQuery !== query && cleanQuery.length > 0) {
             logger.debug("Database", "KnowledgeBaseQueryTool: regex fallback search", { cleanQuery, query });
             const fallbackResults = await ragService.search(cleanQuery, requested);
             if (fallbackResults.length > 0) {
                 const sliced = fallbackResults.slice(offset, offset + limit);
                 let output = `[关键词重试成功] 使用关键词 "${cleanQuery}" 找到 ${fallbackResults.length} 条候选结果（当前返回 ${sliced.length} 条，offset=${offset}, limit=${limit}）：\n\n`;
                 sliced.forEach((res: any, idx: number) => {
                   const similarity = (res.similarity * 100).toFixed(1);
                   const snippet = String(res.content || "")
                     .replace(/[\r\n]+/g, ' ')
                     .trim()
                     .slice(0, maxSnippetChars);
                   output += `- [${offset + idx + 1}] [${similarity}%] ${res.path}\n  摘录: ${snippet}${snippet.length >= maxSnippetChars ? '…' : ''}\n`;
                 });
                 output += `\n提示：如需某条结果全文，请对该 path 调用 read_note。\n`;
                 if (fallbackResults.length > offset + limit) {
                   output += `如需更多结果：使用 offset=${offset + limit}, limit=${limit} 继续调用 knowledge_base_query。\n`;
                 }
                 return output;
             }
        }
        
        return `【未找到结果】知识库中未找到与 "${query}" 相关的匹配项。请注意：这可能是因为关键词过于具体。建议尝试搜索更宽泛的词汇，或者直接搜索“梦”。`;
      }

      const sliced = results.slice(offset, offset + limit);
      let output = `找到 ${results.length} 条候选结果（当前返回 ${sliced.length} 条，offset=${offset}, limit=${limit}）：\n\n`;
      sliced.forEach((res: any, idx: number) => {
        const similarity = (res.similarity * 100).toFixed(1);
        const snippet = String(res.content || "")
          .replace(/[\r\n]+/g, ' ')
          .trim()
          .slice(0, maxSnippetChars);
        output += `- [${offset + idx + 1}] [${similarity}%] ${res.path}\n  摘录: ${snippet}${snippet.length >= maxSnippetChars ? '…' : ''}\n`;
      });
      output += `\n提示：如需某条结果全文，请对该 path 调用 read_note。\n`;
      if (results.length > offset + limit) {
        output += `如需更多结果：使用 offset=${offset + limit}, limit=${limit} 继续调用 knowledge_base_query。\n`;
      }

  logger.debug("Database", "KnowledgeBaseQueryTool: return results", { returned: sliced.length, totalCandidates: results.length, offset, limit });
      return output;
    } catch (e: any) {
      return `知识库检索失败: ${e.message}`;
    }
  }
}

/**
 * 图谱探索工具 — 让智能体按需探索笔记间的链接关系
 * 相比自动图扩展，这是按需调用、可控的方式
 */
export class GraphExploreTool implements Tool {
  private plugin: any;

  constructor(plugin: any) {
    this.plugin = plugin;
  }

  definition = {
    name: "explore_note_links",
    description: "按 wiki 链接关系探索一篇笔记的出链和入链。适合顺着链接网络扩展上下文、查看某篇笔记连到了哪里/被哪些笔记引用；如果你要找 frontmatter 层级关系（父子、同级、后代），请改用 find_note_relationships。",
    parameters: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "要探索的笔记路径",
        },
        direction: {
          type: "string",
          description: "链接方向：both=同时看出链和入链；forward=只看当前笔记指向谁；backlinks=只看谁链接到当前笔记",
        },
        depth: {
          type: "number",
          description: "探索深度（默认 1，最大 3）。depth=1 只看直接链接，depth=2 还会看链接的链接",
        },
        includeContent: {
          type: "boolean",
          description: "是否包含每个关联笔记的内容摘录（默认 true，设为 false 只返回路径列表）",
        },
        maxSnippetChars: {
          type: "number",
          description: "每个笔记摘录的最大字符数（默认 400）",
        },
      },
      required: ["path"],
    },
  };

  async execute(
    args: { path: string; direction?: string; depth?: number; includeContent?: boolean; maxSnippetChars?: number },
    app: App
  ): Promise<string> {
    const targetPath = String(args.path || '').trim();
    if (!targetPath) return "错误: 缺少参数 path";

    const direction = (args.direction || 'both').toLowerCase();
    const maxDepth = Math.min(Math.max(1, args.depth || 1), 3);
    const includeContent = args.includeContent !== false;
    const maxSnippetChars = Math.min(Math.max(100, args.maxSnippetChars || 400), 2000);

    // 解析文件
    const file = app.metadataCache.getFirstLinkpathDest(targetPath, '') ||
                 app.vault.getAbstractFileByPath(targetPath);
    if (!(file instanceof TFile)) {
      return `错误: 未找到笔记 "${targetPath}"`;
    }

    const resolvedLinks = app.metadataCache.resolvedLinks;
    const visited = new Set<string>();
    visited.add(file.path);

    // 直接扫描 frontmatter 属性值来查找子笔记（属性中引用了目标笔记的笔记）
    // frontmatterLinks API 不可靠，直接读 frontmatter 值最稳定
    // 支持多种引用格式：[[basename]]、[[basename|别名]]、[[path/basename]]、纯文本
    const fmChildrenOf = (targetPath: string): string[] => {
        const targetFile = app.vault.getAbstractFileByPath(targetPath);
        if (!(targetFile instanceof TFile)) return [];
        const targetBasename = targetFile.basename;
        const targetPathNoExt = targetPath.replace(/\.md$/i, '');
        const children: string[] = [];
        for (const mdFile of app.vault.getMarkdownFiles()) {
            if (mdFile.path === targetPath || visited.has(mdFile.path)) continue;
            const cache = app.metadataCache.getFileCache(mdFile);
            if (!cache?.frontmatter) continue;
            let found = false;
            for (const [key, value] of Object.entries(cache.frontmatter)) {
                if (key === 'position') continue;
                // 逐项检查（数组每项单独，避免 join 后误匹配）
                const items: string[] = [];
                if (Array.isArray(value)) {
                    for (const item of value) items.push(String(item ?? ''));
                } else if (value != null) {
                    items.push(String(value));
                }
                for (const strVal of items) {
                    if (!strVal) continue;
                    // 1. [[basename]] 标准 wikilink
                    if (strVal.includes(`[[${targetBasename}]]`)) { found = true; break; }
                    // 2. [[basename|别名]] 带别名
                    if (strVal.includes(`[[${targetBasename}|`)) { found = true; break; }
                    // 3. [[folder/basename]] 或 [[folder/basename|别名]] 全路径
                    if (targetPathNoExt !== targetBasename && (strVal.includes(`[[${targetPathNoExt}]]`) || strVal.includes(`[[${targetPathNoExt}|`))) { found = true; break; }
                    // 4. 纯文本精确匹配（YAML 值恰好是笔记名）
                    if (strVal.trim() === targetBasename) { found = true; break; }
                }
                if (found) break;
            }
            if (found) children.push(mdFile.path);
        }
        // 补充：Obsidian backlinks API（可能包含 frontmatter links）
        try {
            // @ts-ignore
            const backlinks = app.metadataCache.getBacklinksForFile(targetFile);
            if (backlinks?.data) {
                for (const sourcePath of backlinks.data.keys()) {
                    if (sourcePath !== targetPath && !visited.has(sourcePath) && !children.includes(sourcePath)) {
                        children.push(sourcePath);
                    }
                }
            }
        } catch { /* API 可能不可用 */ }
        return children;
    };

    interface LinkInfo {
      path: string;
      depth: number;
      direction: 'forward' | 'backlink';
      viaPath: string;
    }

    const allLinks: LinkInfo[] = [];
    let currentPaths = [file.path];

    for (let d = 1; d <= maxDepth; d++) {
      const nextPaths: string[] = [];

      for (const currentPath of currentPaths) {
        // 正向链接（resolvedLinks 包含正文链接和部分属性链接）
        if (direction === 'both' || direction === 'forward') {
          const outgoing = resolvedLinks[currentPath] || {};
          for (const linkPath of Object.keys(outgoing)) {
            if (!visited.has(linkPath)) {
              visited.add(linkPath);
              allLinks.push({ path: linkPath, depth: d, direction: 'forward', viaPath: currentPath });
              nextPaths.push(linkPath);
            }
          }
        }

        // 反向链接（resolvedLinks 反向查找 + frontmatter 属性子笔记扫描）
        if (direction === 'both' || direction === 'backlinks') {
          // 方法1：resolvedLinks 反向查找
          for (const [sourcePath, links] of Object.entries(resolvedLinks)) {
            if (links[currentPath] && !visited.has(sourcePath)) {
              visited.add(sourcePath);
              allLinks.push({ path: sourcePath, depth: d, direction: 'backlink', viaPath: currentPath });
              nextPaths.push(sourcePath);
            }
          }
          // 方法2：frontmatter 属性值扫描（覆盖通过"父笔记"等属性建立的父子关系）
          const fmChildren = fmChildrenOf(currentPath);
          for (const childPath of fmChildren) {
            if (!visited.has(childPath)) {
              visited.add(childPath);
              allLinks.push({ path: childPath, depth: d, direction: 'backlink', viaPath: currentPath });
              nextPaths.push(childPath);
            }
          }
        }
      }

      currentPaths = nextPaths;
      if (currentPaths.length === 0) break;
    }

    if (allLinks.length === 0) {
      return `笔记 "${file.path}" 没有找到任何${direction === 'forward' ? '正向' : direction === 'backlinks' ? '反向' : ''}链接。`;
    }

    // 按深度分组输出
    let output = `📊 笔记 "${file.path}" 的链接图谱（共 ${allLinks.length} 个关联笔记）：\n\n`;

    for (let d = 1; d <= maxDepth; d++) {
      const atDepth = allLinks.filter(l => l.depth === d);
      if (atDepth.length === 0) continue;

      const forwardLinks = atDepth.filter(l => l.direction === 'forward');
      const backLinks = atDepth.filter(l => l.direction === 'backlink');

      output += `### 第 ${d} 层（`;
      const parts: string[] = [];
      if (forwardLinks.length > 0) parts.push(`${forwardLinks.length} 个出链`);
      if (backLinks.length > 0) parts.push(`${backLinks.length} 个入链`);
      output += parts.join('，') + '）\n\n';

      for (const link of atDepth) {
        const icon = link.direction === 'forward' ? '→' : '←';
        const label = link.direction === 'forward' ? '出链' : '入链';
        output += `- ${icon} [${label}] ${link.path}`;
        if (d > 1) output += ` (via ${link.viaPath})`;
        output += '\n';

        if (includeContent) {
          const linkedFile = app.vault.getAbstractFileByPath(link.path);
          if (linkedFile instanceof TFile && linkedFile.extension === 'md') {
            try {
              const content = await app.vault.cachedRead(linkedFile);
              const snippet = content.slice(0, maxSnippetChars).replace(/[\r\n]+/g, ' ').trim();
              output += `  摘录: ${snippet}${content.length > maxSnippetChars ? '…' : ''}\n`;
            } catch {
              output += `  (读取失败)\n`;
            }
          }
        }
      }
      output += '\n';
    }

    output += `提示：如需某笔记全文，请调用 read_note。如需继续沿某条链路深入探索，可再次调用 explore_note_links 并指定该笔记的 path。\n`;
    return output;
  }
}

/**
 * 笔记关系查询工具 — 通过 frontmatter 属性发现笔记的父子和兄弟关系
 */
export class NoteRelationshipTool implements Tool {
  private plugin: any;

  constructor(plugin: any) {
    this.plugin = plugin;
  }

  definition = {
    name: "find_note_relationships",
    description: "按 frontmatter 中的父笔记字段查层级关系，返回父笔记、子笔记、兄弟笔记或后代笔记。适合有明确层级结构的知识库；如果你只是想看普通 wiki 链接网络，而不是父子归属关系，请改用 explore_note_links。",
    parameters: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "要查询的笔记路径或文件名",
        },
        relationship: {
          type: "string",
          description: "要查询的层级关系：children=直接子笔记；parent=父笔记；siblings=同级笔记；descendants=递归后代；all=全部关系",
        },
        depth: {
          type: "number",
          description: "子笔记递归检索深度（默认 1 即只找直接子笔记，设为 2 可找子笔记的子笔记，最大 5）。对 children 和 descendants 生效。",
        },
        parentProperty: {
          type: "string",
          description: "用于标识父笔记的 frontmatter 属性名（默认自动检测常见属性名：父笔记、parent、上级等）",
        },
        includeContent: {
          type: "boolean",
          description: "是否包含每个关联笔记的内容摘录（默认 true）",
        },
        maxSnippetChars: {
          type: "number",
          description: "每个笔记摘录的最大字符数（默认 400）",
        },
      },
      required: ["path"],
    },
  };

  // 常见的"父笔记"属性名列表
  private static PARENT_PROPERTY_NAMES = ['父笔记', 'parent', '上级', '上级笔记', 'parent_note', '母笔记', '从属于', '属于', 'belongs_to'];

  async execute(
    args: { path: string; relationship?: string; parentProperty?: string; depth?: number; includeContent?: boolean; maxSnippetChars?: number },
    app: App
  ): Promise<string> {
    const targetPath = String(args.path || '').trim();
    if (!targetPath) return "错误: 缺少参数 path";

    const relationship = (args.relationship || 'all').toLowerCase();
    const includeContent = args.includeContent !== false;
    const maxSnippetChars = Math.min(Math.max(100, args.maxSnippetChars || 400), 2000);
    const customParentProp = args.parentProperty?.trim();
    const maxDepth = Math.min(Math.max(1, args.depth || (relationship === 'descendants' ? 5 : 1)), 5);

    // 解析目标文件
    const file = app.metadataCache.getFirstLinkpathDest(targetPath, '') ||
                 app.vault.getAbstractFileByPath(targetPath);
    if (!(file instanceof TFile)) {
      return `错误: 未找到笔记 "${targetPath}"`;
    }

    const parentPropNames = customParentProp
      ? [customParentProp]
      : NoteRelationshipTool.PARENT_PROPERTY_NAMES;

    let output = `📊 笔记 "${file.path}" 的关系查询结果：\n\n`;

    // ---- 查找父笔记 ----
    const parents: { path: string; propertyName: string }[] = [];
    if (relationship === 'all' || relationship === 'parent' || relationship === 'siblings') {
      const cache = app.metadataCache.getFileCache(file);
      if (cache?.frontmatter) {
        for (const propName of parentPropNames) {
          const value = cache.frontmatter[propName];
          if (value == null) continue;
          const refs = this.extractNoteReferences(value);
          for (const ref of refs) {
            const parentFile = app.metadataCache.getFirstLinkpathDest(ref, file.path);
            if (parentFile instanceof TFile) {
              parents.push({ path: parentFile.path, propertyName: propName });
            }
          }
        }
      }
    }

    // ---- 查找子笔记（支持递归） ----
    const needChildren = relationship === 'all' || relationship === 'children' || relationship === 'siblings' || relationship === 'descendants';
    // childrenByDepth[0] = 直接子笔记, [1] = 孙子笔记, ...
    const childrenByDepth: Array<{ path: string; propertyName: string; parentPath: string }[]> = [];
    const visitedChildren = new Set<string>([file.path]);

    if (needChildren) {
      let currentParentPaths = [file.path];

      for (let d = 0; d < maxDepth; d++) {
        const levelChildren: { path: string; propertyName: string; parentPath: string }[] = [];

        for (const parentPath of currentParentPaths) {
          const found = this.findDirectChildren(app, parentPath, parentPropNames, visitedChildren);
          for (const child of found) {
            visitedChildren.add(child.path);
            levelChildren.push({ ...child, parentPath });
          }
        }

        if (levelChildren.length === 0) break;
        childrenByDepth.push(levelChildren);
        currentParentPaths = levelChildren.map(c => c.path);
      }
    }

    // 所有子笔记的扁平列表（用于兄弟计算）
    const allChildren = childrenByDepth.flat();

    // ---- 查找兄弟笔记 ----
    const siblings: { path: string; sharedParent: string }[] = [];
    if (relationship === 'all' || relationship === 'siblings') {
      if (parents.length > 0) {
        const childPaths = new Set(allChildren.map(c => c.path));
        for (const parent of parents) {
          const siblingCandidates = this.findDirectChildren(app, parent.path, parentPropNames, new Set([file.path]));
          for (const sib of siblingCandidates) {
            if (!childPaths.has(sib.path)) {
              siblings.push({ path: sib.path, sharedParent: parent.path });
            }
          }
        }
      }
    }

    // ---- 格式化输出 ----
    let hasResults = false;

    if (relationship === 'all' || relationship === 'parent') {
      output += `### 父笔记 (${parents.length} 个)\n\n`;
      if (parents.length === 0) {
        output += `（未发现父笔记属性）\n\n`;
      } else {
        hasResults = true;
        for (const p of parents) {
          output += `- ⬆️ ${p.path} (属性: ${p.propertyName})\n`;
          if (includeContent) {
            output += await this.getSnippet(app, p.path, maxSnippetChars);
          }
        }
        output += '\n';
      }
    }

    if (relationship === 'all' || relationship === 'children' || relationship === 'descendants') {
      const totalChildren = allChildren.length;
      const label = relationship === 'descendants' ? '后代笔记' : '子笔记';
      output += `### ${label} (${totalChildren} 个${maxDepth > 1 ? `，递归深度 ${maxDepth}` : ''})\n\n`;
      if (totalChildren === 0) {
        output += `（未发现引用本笔记的子笔记）\n\n`;
      } else {
        hasResults = true;
        for (let d = 0; d < childrenByDepth.length; d++) {
          const levelChildren = childrenByDepth[d];
          if (childrenByDepth.length > 1) {
            const depthLabel = d === 0 ? '直接子笔记' : `第 ${d + 1} 层${'子'.repeat(d + 1)}笔记`;
            output += `#### ${depthLabel} (${levelChildren.length} 个)\n\n`;
          }
          const indent = '  '.repeat(d);
          for (const c of levelChildren) {
            output += `${indent}- ⬇️ ${c.path} (属性: ${c.propertyName}${d > 0 ? `，父: ${c.parentPath.split('/').pop()}` : ''})\n`;
            if (includeContent) {
              output += indent + (await this.getSnippet(app, c.path, maxSnippetChars));
            }
          }
        }
        output += '\n';
      }
    }

    if (relationship === 'all' || relationship === 'siblings') {
      output += `### 兄弟笔记 (${siblings.length} 个)\n\n`;
      if (siblings.length === 0) {
        output += `（未发现同父笔记的兄弟笔记）\n\n`;
      } else {
        hasResults = true;
        for (const s of siblings) {
          output += `- ↔️ ${s.path} (共同父笔记: ${s.sharedParent})\n`;
          if (includeContent) {
            output += await this.getSnippet(app, s.path, maxSnippetChars);
          }
        }
        output += '\n';
      }
    }

    if (!hasResults && (relationship === 'all' || relationship === 'descendants')) {
      output += `未发现任何通过 frontmatter 属性建立的层级关系。\n`;
      output += `提示：确保笔记的 frontmatter 中使用了 "父笔记" 等属性来标识层级关系。\n`;
      output += `示例：\n\`\`\`yaml\n父笔记: "[[父级笔记名]]"\n\`\`\`\n`;
    }

    output += `\n提示：如需查看某笔记全文，请调用 read_note；如需探索链接图谱，请调用 explore_note_links。`;
    if (maxDepth === 1 && allChildren.length > 0) {
      output += `\n💡 如需查找子笔记的子笔记，可设置 depth=2 或使用 relationship='descendants'。`;
    }
    return output;
  }

  /**
   * 查找某笔记的直接子笔记（frontmatter 属性中引用了该笔记的笔记）
   */
  private findDirectChildren(
    app: App,
    parentPath: string,
    parentPropNames: string[],
    visited: Set<string>
  ): { path: string; propertyName: string }[] {
    const parentFile = app.vault.getAbstractFileByPath(parentPath);
    if (!(parentFile instanceof TFile)) return [];

    const parentBasename = parentFile.basename;
    const parentPathNoExt = parentPath.replace(/\.md$/i, '');
    const children: { path: string; propertyName: string }[] = [];
    const addedPaths = new Set<string>();

    // 方法1：遍历所有 md 文件，检查 frontmatter 属性引用
    for (const mdFile of app.vault.getMarkdownFiles()) {
      if (mdFile.path === parentPath || visited.has(mdFile.path) || addedPaths.has(mdFile.path)) continue;
      const cache = app.metadataCache.getFileCache(mdFile);
      if (!cache?.frontmatter) continue;

      for (const propName of parentPropNames) {
        const value = cache.frontmatter[propName];
        if (value == null) continue;

        const refs = this.extractNoteReferences(value);
        let matched = false;
        for (const ref of refs) {
          if (ref === parentBasename || ref === parentPathNoExt || ref === parentPath) {
            matched = true;
            break;
          }
          const resolved = app.metadataCache.getFirstLinkpathDest(ref, mdFile.path);
          if (resolved && resolved.path === parentPath) {
            matched = true;
            break;
          }
        }
        if (matched) {
          children.push({ path: mdFile.path, propertyName: propName });
          addedPaths.add(mdFile.path);
          break;
        }
      }
    }

    // 方法2：Obsidian backlinks API 补充
    try {
      // @ts-ignore
      const backlinks = app.metadataCache.getBacklinksForFile(parentFile);
      if (backlinks?.data) {
        for (const sourcePath of backlinks.data.keys()) {
          if (sourcePath === parentPath || visited.has(sourcePath) || addedPaths.has(sourcePath)) continue;
          const srcFile = app.vault.getAbstractFileByPath(sourcePath);
          if (!(srcFile instanceof TFile)) continue;
          const srcCache = app.metadataCache.getFileCache(srcFile);
          if (!srcCache?.frontmatter) continue;

          for (const propName of parentPropNames) {
            if (srcCache.frontmatter[propName] == null) continue;
            const refs = this.extractNoteReferences(srcCache.frontmatter[propName]);
            for (const ref of refs) {
              const resolved = app.metadataCache.getFirstLinkpathDest(ref, sourcePath);
              if (resolved && resolved.path === parentPath) {
                children.push({ path: sourcePath, propertyName: propName });
                addedPaths.add(sourcePath);
                break;
              }
            }
            break;
          }
        }
      }
    } catch { /* API 可能不可用 */ }

    return children;
  }

  /** 从 frontmatter 值中提取笔记引用（支持 wikilink、纯文本、数组等多种格式） */
  private extractNoteReferences(value: any): string[] {
    const refs: string[] = [];

    const extract = (v: any) => {
      if (v == null) return;
      if (Array.isArray(v)) {
        for (const item of v) extract(item);
        return;
      }

      const str = String(v).trim();
      if (!str) return;

      // 提取所有 [[...]] 中的引用
      const wikiLinkRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
      let match;
      let hasWikiLink = false;
      while ((match = wikiLinkRegex.exec(str)) !== null) {
        refs.push(match[1].trim());
        hasWikiLink = true;
      }

      // 如果没有 wikilink，则将整个值视为笔记名
      if (!hasWikiLink && str.length > 0 && str.length < 200) {
        refs.push(str);
      }
    };

    extract(value);
    return refs;
  }

  /** 获取笔记摘录 */
  private async getSnippet(app: App, path: string, maxChars: number): Promise<string> {
    const f = app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile) || f.extension !== 'md') return '';
    try {
      const content = await app.vault.cachedRead(f);
      const snippet = content.slice(0, maxChars).replace(/[\r\n]+/g, ' ').trim();
      return `  摘录: ${snippet}${content.length > maxChars ? '…' : ''}\n`;
    } catch {
      return '  (读取失败)\n';
    }
  }
}
