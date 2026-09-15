import { App, requestUrl } from "obsidian";
import type { Tool } from "../types";
import { logger } from "../../../core/logger";
import { SearchCache } from "./SearchCache";
import { RetryHelper } from "./RetryHelper";

export class WebSearchTool implements Tool {
  private plugin: any;
  private searchCache: SearchCache;

  constructor(plugin: any) {
    this.plugin = plugin;
    // 初始化缓存: 最多 100 条,有效期 60 分钟
    this.searchCache = new SearchCache(100, 60);
  }

  definition = {
    name: "web_search",
    description: "[内置后备] 搜索互联网实时信息。注意：如果用户已配置 MCP 搜索工具（如 bailian_web_search），请优先使用 mcp_call_tool 调用它；本工具仅在 MCP 不可用时作为后备。",
    parameters: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "搜索关键词",
        },
        count: {
          type: "number",
          description: "返回结果数量 (建议 10, 默认 10)",
        },
        time_range: {
          type: "string",
          enum: ["day", "week", "month", "year", "all"],
          description: "时间范围过滤 (默认 all)。当用户询问'今天'、'最近'、'最新'的新闻时，请务必设置为 'day' 或 'week'。",
        }
      },
      required: ["query"],
    },
  };

  async execute(args: { query: string; count?: number; time_range?: string }, app: App): Promise<string> {
    const count = args.count || 10;
    const timeRange = args.time_range || 'all';
    
    logger.info("Network", "WebSearchTool 开始执行", { query: args.query, count, time_range: timeRange });

    // 1. 检测并尝试使用 MCP 搜索工具
    const mcpSearchTool = this.detectMCPSearchTool();
    if (mcpSearchTool) {
      // 检查 MCP 缓存
      const cachedResult = this.searchCache.get(args.query, count, timeRange, `mcp:${mcpSearchTool}`);
      if (cachedResult) {
        logger.info("Network", "命中 MCP 搜索缓存", { tool: mcpSearchTool, cacheStats: this.searchCache.getStats() });
        return cachedResult + "\n\n(注: 此结果来自缓存)";
      }

      logger.info("Network", `检测到 MCP 搜索工具: ${mcpSearchTool}，优先使用`);
      try {
        const mcpResult = await this.executeMCPSearch(mcpSearchTool, args);
        if (mcpResult && !this.isResultEmpty(mcpResult)) {
          logger.info("Network", "MCP 搜索成功", { tool: mcpSearchTool, resultLength: mcpResult.length });
          // 缓存成功的结果
          this.searchCache.set(args.query, count, timeRange, `mcp:${mcpSearchTool}`, mcpResult);
          return mcpResult;
        }
        logger.warn("Network", "MCP 搜索返回空结果，降级到内置搜索", { tool: mcpSearchTool });
      } catch (e: any) {
        logger.warn("Network", "MCP 搜索失败，降级到内置搜索", { tool: mcpSearchTool, error: e.message });
      }
    } else {
      logger.info("Network", "未检测到可用的 MCP 搜索工具，使用内置搜索");
    }

    // 2. 使用内置搜索引擎（现有逻辑）
    return await this.executeBuiltinSearch(args);
  }

  /**
   * 检测可用的 MCP 搜索工具
   * 返回第一个可用的搜索工具名称，如果没有则返回 null
   */
  private detectMCPSearchTool(): string | null {
    try {
      const toolRegistry = this.plugin?.toolRegistry;
      if (!toolRegistry) {
        logger.debug("Network", "ToolRegistry 不可用");
        return null;
      }

      // 获取所有已启用的 MCP 工具
      const dashscopeTools = toolRegistry.getTools("dashscope").filter((t: any) => t.enabled);
      const genericTools = toolRegistry.getTools("generic").filter((t: any) => t.enabled);
      const allMcpTools = [...dashscopeTools, ...genericTools];

      logger.debug("Network", `检测到 ${allMcpTools.length} 个已启用的 MCP 工具`, { 
        tools: allMcpTools.map((t: any) => t.name) 
      });

      // 搜索工具的关键词列表（按优先级排序）
      const searchKeywords = [
        'web_search',      // 百炼 WebSearch
        'websearch',
        'search',
        'bailian_web_search',
        'exa_search',      // Exa 搜索
        'brave_search',    // Brave 搜索
        'tavily_search',   // Tavily 搜索
        'google_search',
        'bing_search'
      ];

      // 按优先级查找匹配的搜索工具
      for (const keyword of searchKeywords) {
        const tool = allMcpTools.find((t: any) => {
          const name = t.name.toLowerCase();
          return name === keyword || name.includes(keyword);
        });
        
        if (tool) {
          logger.info("Network", `找到匹配的 MCP 搜索工具: ${tool.name}`, { 
            keyword, 
            description: tool.description 
          });
          return tool.name;
        }
      }

      logger.debug("Network", "未找到匹配的 MCP 搜索工具");
      return null;
    } catch (e: any) {
      logger.error("Network", "检测 MCP 搜索工具时出错", { error: e.message });
      return null;
    }
  }

  /**
   * 通过 MCP 执行搜索
   */
  private async executeMCPSearch(toolName: string, args: { query: string; count?: number; time_range?: string }): Promise<string> {
    try {
      logger.info("Network", `开始通过 MCP 执行搜索`, { tool: toolName, query: args.query });

      // 获取 MCP 工具实例
      const mcpTool = this.plugin?.agentManager?.getTool("mcp_call_tool");
      if (!mcpTool) {
        throw new Error("mcp_call_tool 工具不可用");
      }

      // 构建 MCP 调用参数
      const mcpArgs: any = {
        toolName: toolName,
        arguments: {
          query: args.query
        }
      };

      // 添加可选参数（如果 MCP 工具支持）
      if (args.count) {
        mcpArgs.arguments.count = args.count;
        mcpArgs.arguments.num = args.count;  // 有些工具用 num
        mcpArgs.arguments.max_results = args.count;  // 有些工具用 max_results
      }

      if (args.time_range && args.time_range !== 'all') {
        mcpArgs.arguments.time_range = args.time_range;
        mcpArgs.arguments.freshness = args.time_range;  // Bing 风格
      }

      logger.debug("Network", "MCP 调用参数", { mcpArgs });

      // 执行 MCP 调用
      const result = await mcpTool.execute(mcpArgs, this.plugin.app);
      
      logger.info("Network", "MCP 搜索完成", { 
        tool: toolName, 
        resultLength: result?.length || 0 
      });

      return result;
    } catch (e: any) {
      logger.error("Network", "MCP 搜索执行失败", { 
        tool: toolName, 
        error: e.message,
        stack: e.stack 
      });
      throw e;
    }
  }

  /**
   * 执行内置搜索（原有逻辑）
   */
  private async executeBuiltinSearch(args: { query: string; count?: number; time_range?: string }): Promise<string> {
    const provider = this.plugin.settings.webSearchProvider || 'duckduckgo';
    const count = args.count || 10;
    const timeRange = args.time_range || 'all';

    // 检查内置搜索缓存
    const cachedResult = this.searchCache.get(args.query, count, timeRange, provider);
    if (cachedResult) {
      logger.info("Network", "命中内置搜索缓存", { provider, cacheStats: this.searchCache.getStats() });
      return cachedResult + "\n\n(注: 此结果来自缓存)";
    }

    logger.info("Network", `使用内置搜索引擎: ${provider}`, { query: args.query });

    let result = "";
    
    if (provider === 'duckduckgo') {
        result = await this.searchDuckDuckGo(args.query, count, timeRange);
    } else if (provider === 'baidu') {
        result = await this.searchBaidu(args.query, count, timeRange);
    } else if (provider === 'bing_free') {
        result = await this.searchBingFree(args.query, count, timeRange);
    } else if (provider === 'google') {
        result = await this.searchGoogle(args.query, count, timeRange);
    } else {
        result = await this.searchBing(args.query, count, timeRange);
    }

    if (this.isResultEmpty(result)) {
        logger.warn("Network", `${provider} 搜索无结果，尝试降级`);
        if (provider !== 'bing_free') {
             const fbResult = await this.searchBingFree(args.query, count, timeRange);
             if (!this.isResultEmpty(fbResult)) {
               logger.info("Network", "降级到 Bing CN 成功");
               // 缓存降级结果
               this.searchCache.set(args.query, count, timeRange, 'bing_free', fbResult);
               return fbResult + "\n(注: 由于首选搜索引擎无结果，已自动切换至 Bing CN)";
             }
        }
        if (provider !== 'duckduckgo') {
             const fbResult = await this.searchDuckDuckGo(args.query, count, timeRange);
             if (!this.isResultEmpty(fbResult)) {
               logger.info("Network", "降级到 DuckDuckGo 成功");
               // 缓存降级结果
               this.searchCache.set(args.query, count, timeRange, 'duckduckgo', fbResult);
               return fbResult + "\n(注: 由于首选搜索引擎无结果，已自动切换至 DuckDuckGo)";
             }
        }
    } else {
      // 缓存成功的结果
      this.searchCache.set(args.query, count, timeRange, provider, result);
    }

    return result;
  }

  private isResultEmpty(result: string): boolean {
      return !result || result.includes("未找到相关结果") || result.includes("搜索出错") || result.includes("搜索失败");
  }

  private async searchBaidu(query: string, count: number, timeRange: string): Promise<string> {
      return await RetryHelper.withRetry(async () => {
          let url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`;
          if (timeRange === 'day') url += '&lm=1';
          else if (timeRange === 'week') url += '&lm=7';
          else if (timeRange === 'month') url += '&lm=30';
          else if (timeRange === 'year') url += '&lm=365';

          const response = await requestUrl({ 
              url: url,
              headers: {
                  'User-Agent': RetryHelper.getRandomUserAgent()
              }
          });
          
          const parser = new DOMParser();
          const doc = parser.parseFromString(response.text, "text/html");
          const results: any[] = [];
          const elements = doc.querySelectorAll('.result.c-container');
          
          for (let i = 0; i < elements.length && results.length < count; i++) {
              const el = elements[i];
              const titleEl = el.querySelector('h3.t a');
              const snippetEl = el.querySelector('.c-abstract') || el.querySelector('.content-right_8Zs40') || el.querySelector('.c-span18');
              if (titleEl) {
                  results.push({
                      title: titleEl.textContent?.trim(),
                      link: (titleEl as HTMLAnchorElement).href,
                      snippet: snippetEl?.textContent?.trim() || "暂无摘要"
                  });
              }
          }
          if (results.length === 0) return "Baidu 未找到相关结果。";
          return `Baidu 搜索结果 (${timeRange === 'all' ? '全部时间' : timeRange}):\n` + results.map((item, index) => 
              `[${index + 1}] ${item.title}\n链接: ${item.link}\n摘要: ${item.snippet}\n`
          ).join("\n---\n");
      }, { maxRetries: 2 }, 'Baidu 搜索').catch((error: any) => {
          return `Baidu 搜索出错: ${error.message}`;
      });
  }

  private async searchBingFree(query: string, count: number, timeRange: string): Promise<string> {
      return await RetryHelper.withRetry(async () => {
          let url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}`;
          if (timeRange === 'day') url += '&filters=ex1:"ez1"';
          else if (timeRange === 'week') url += '&filters=ex1:"ez2"';
          else if (timeRange === 'month') url += '&filters=ex1:"ez3"';

          const response = await requestUrl({ 
              url: url,
              headers: {
                  'User-Agent': RetryHelper.getRandomUserAgent(),
                  'Accept-Language': 'zh-CN,zh;q=0.9'
              }
          });
          
          const parser = new DOMParser();
          const doc = parser.parseFromString(response.text, "text/html");
          const results: any[] = [];
          const elements = doc.querySelectorAll('#b_results > .b_algo');
          
          for (let i = 0; i < elements.length && results.length < count; i++) {
              const el = elements[i];
              const titleEl = el.querySelector('h2 a');
              const snippetEl = el.querySelector('.b_caption p') || el.querySelector('.b_snippet');
              if (titleEl) {
                  results.push({
                      title: titleEl.textContent?.trim(),
                      link: (titleEl as HTMLAnchorElement).href,
                      snippet: snippetEl?.textContent?.trim() || "暂无摘要"
                  });
              }
          }
          if (results.length === 0) return "Bing CN 未找到相关结果。";
          return `Bing CN 搜索结果 (${timeRange === 'all' ? '全部时间' : timeRange}):\n` + results.map((item, index) => 
              `[${index + 1}] ${item.title}\n链接: ${item.link}\n摘要: ${item.snippet}\n`
          ).join("\n---\n");
      }, { maxRetries: 2 }, 'Bing CN 搜索').catch((error: any) => {
          return `Bing CN 搜索出错: ${error.message}`;
      });
  }

  private async searchDuckDuckGo(query: string, count: number, timeRange: string): Promise<string> {
      return await RetryHelper.withRetry(async () => {
          let url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
          if (timeRange === 'day') url += '&df=d';
          else if (timeRange === 'week') url += '&df=w';
          else if (timeRange === 'month') url += '&df=m';
          else if (timeRange === 'year') url += '&df=y';

          const response = await requestUrl({ 
              url: url,
              headers: {
                  'User-Agent': RetryHelper.getRandomUserAgent()
              }
          });
          
          const parser = new DOMParser();
          const doc = parser.parseFromString(response.text, "text/html");
          const results: any[] = [];
          const elements = doc.querySelectorAll('.result');
          
          for (let i = 0; i < elements.length && results.length < count; i++) {
              const el = elements[i];
              const titleEl = el.querySelector('.result__title .result__a');
              const snippetEl = el.querySelector('.result__snippet');
              if (titleEl && snippetEl) {
                  let link = (titleEl as HTMLAnchorElement).href;
                  try {
                      const urlObj = new URL(link, 'https://html.duckduckgo.com');
                      const uddg = urlObj.searchParams.get('uddg');
                      if (uddg) link = decodeURIComponent(uddg);
                  } catch (e) { }
                  results.push({
                      title: titleEl.textContent?.trim(),
                      link: link,
                      snippet: snippetEl.textContent?.trim()
                  });
              }
          }
          if (results.length === 0) return "DuckDuckGo 未找到相关结果。";
          return `DuckDuckGo 搜索结果 (${timeRange === 'all' ? '全部时间' : timeRange}):\n` + results.map((item, index) => 
              `[${index + 1}] ${item.title}\n链接: ${item.link}\n摘要: ${item.snippet}\n`
          ).join("\n---\n");
      }, { maxRetries: 2 }, 'DuckDuckGo 搜索').catch((error: any) => {
          return `DuckDuckGo 搜索出错: ${error.message}`;
      });
  }

  private async searchGoogle(query: string, count: number, timeRange: string): Promise<string> {
      const apiKey = this.plugin.settings.googleApiKey;
      const cx = this.plugin.settings.googleCx;
      if (!apiKey || !cx) return "错误: 未配置 Google API Key 或 Search Engine ID (CX)。";

      let url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(query)}&num=${count}`;
      if (timeRange === 'day') url += '&dateRestrict=d1';
      else if (timeRange === 'week') url += '&dateRestrict=w1';
      else if (timeRange === 'month') url += '&dateRestrict=m1';
      else if (timeRange === 'year') url += '&dateRestrict=y1';

      try {
          const response = await requestUrl({ url: url });
          const data = response.json;
          if (!data.items) return "Google 未找到相关结果。";
          return `Google 搜索结果 (${timeRange === 'all' ? '全部时间' : timeRange}):\n` + data.items.map((item: any, index: number) => 
              `[${index + 1}] ${item.title}\n链接: ${item.link}\n摘要: ${item.snippet}\n`
          ).join("\n---\n");
      } catch (error: any) {
          return `Google 搜索出错: ${error.message}`;
      }
  }

  private async searchBing(query: string, count: number, timeRange: string): Promise<string> {
    const apiKey = this.plugin.settings.bingApiKey;
    if (!apiKey) return "错误: 未配置 Bing Search API Key。";
    let url = `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&count=${count}`;
    if (timeRange === 'day') url += '&freshness=Day';
    else if (timeRange === 'week') url += '&freshness=Week';
    else if (timeRange === 'month') url += '&freshness=Month';

    try {
      const response = await requestUrl({
        url: url,
        method: "GET",
        headers: { "Ocp-Apim-Subscription-Key": apiKey },
      });
      if (response.status !== 200) return `搜索失败: HTTP ${response.status}`;
      const data = response.json;
      if (!data.webPages || !data.webPages.value) return "未找到相关结果。";
      const results = data.webPages.value.map((item: any, index: number) => {
        return `[${index + 1}] ${item.name}\n链接: ${item.url}\n摘要: ${item.snippet}\n`;
      }).join("\n---\n");
      return `Bing 搜索结果 (${timeRange === 'all' ? '全部时间' : timeRange}):\n${results}`;
    } catch (error: any) {
      return `搜索出错: ${error.message}`;
    }
  }
}

export class ReadWebPageTool implements Tool {
  definition = {
    name: "read_webpage",
    description: "读取指定网页的详细内容。当搜索结果的摘要信息不足以回答问题时，使用此工具深入阅读网页全文。",
    parameters: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "网页链接 URL",
        },
      },
      required: ["url"],
    },
  };

  async execute(args: { url: string }, app: App): Promise<string> {
    try {
      const response = await requestUrl({ 
          url: args.url,
          headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
          }
      });
      const parser = new DOMParser();
      const doc = parser.parseFromString(response.text, "text/html");
      const scripts = doc.querySelectorAll('script, style, noscript, iframe, svg');
      scripts.forEach(s => s.remove());
      const main = doc.querySelector('main') || doc.querySelector('article') || doc.querySelector('#content') || doc.querySelector('.content') || doc.body;
      let text = main.textContent || "";
      text = text.replace(/\s+/g, ' ').trim();
      const maxLength = 3000;
      if (text.length > maxLength) text = text.substring(0, maxLength) + "...(内容过长已截断)";
      return `--- 网页内容: ${args.url} ---\n${text}`;
    } catch (error: any) {
      return `读取网页失败: ${error.message}`;
    }
  }
}
