import { App } from "obsidian";
import type { Tool } from "../types";

export class FindSymbolTool implements Tool {
  private plugin: any;

  constructor(plugin: any) {
    this.plugin = plugin;
  }

  definition = {
    name: "find_symbol",
    description: "在代码文件中查找类、函数、接口、类型、常量等符号定义。适合回答‘这个函数在哪里定义’之类的问题。",
    capabilityTags: ["read", "search", "metadata"],
    riskLevel: "low" as const,
    parameters: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "符号名或其一部分" },
        exact: { type: "boolean", description: "是否精确匹配，默认 false" },
        limit: { type: "number", description: "最多返回结果数，默认 10" },
      },
      required: ["query"],
    },
  };

  async execute(args: { query: string; exact?: boolean; limit?: number }, app: App): Promise<string> {
    const query = String(args?.query || "").trim();
    if (!query) return "错误: find_symbol 缺少必填参数 query (string)";
    const results = await this.plugin.symbolIndex.findSymbols(query, args?.exact === true, Number(args?.limit || 10));
    if (results.length === 0) return `未找到符号: ${query}`;
    return [
      `符号搜索结果 (${query}):`,
      ...results.map((r: any) => `- ${r.kind} ${r.name} @ ${r.path}:${r.line}\n  ${r.preview}`),
    ].join("\n");
  }
}

export class FindReferencesTool implements Tool {
  private plugin: any;

  constructor(plugin: any) {
    this.plugin = plugin;
  }

  definition = {
    name: "find_references",
    description: "在代码文件中查找某个符号的引用位置。适合回答‘这个函数在哪里被调用’。",
    capabilityTags: ["read", "search", "metadata"],
    riskLevel: "low" as const,
    parameters: {
      type: "object" as const,
      properties: {
        symbol: { type: "string", description: "要查找引用的符号名" },
        limit: { type: "number", description: "最多返回结果数，默认 20" },
      },
      required: ["symbol"],
    },
  };

  async execute(args: { symbol: string; limit?: number }, app: App): Promise<string> {
    const symbol = String(args?.symbol || "").trim();
    if (!symbol) return "错误: find_references 缺少必填参数 symbol (string)";
    const refs = await this.plugin.symbolIndex.findReferences(symbol, Number(args?.limit || 20));
    if (refs.length === 0) return `未找到引用: ${symbol}`;
    return [
      `引用搜索结果 (${symbol}):`,
      ...refs.map((r: any) => `- ${r.path}:${r.line}\n  ${r.preview}`),
    ].join("\n");
  }
}

export class ListCodeDependenciesTool implements Tool {
  private plugin: any;

  constructor(plugin: any) {
    this.plugin = plugin;
  }

  definition = {
    name: "list_code_dependencies",
    description: "列出某个代码文件的 import 依赖和反向依赖。适合判断改动影响范围。",
    capabilityTags: ["read", "metadata", "search"],
    riskLevel: "low" as const,
    parameters: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "代码文件路径" },
      },
      required: ["path"],
    },
  };

  async execute(args: { path: string }, app: App): Promise<string> {
    const path = String(args?.path || "").trim();
    if (!path) return "错误: list_code_dependencies 缺少必填参数 path (string)";
    const dep = await this.plugin.symbolIndex.listDependencies(path);
    if (!dep) return `未找到代码文件: ${path}`;
    return [
      `依赖分析: ${dep.path}`,
      `- imports (${dep.imports.length}): ${dep.imports.join(", ") || "无"}`,
      `- importedBy (${dep.importedBy.length}): ${dep.importedBy.join(", ") || "无"}`,
    ].join("\n");
  }
}

export class ReadCodeRegionTool implements Tool {
  private plugin: any;

  constructor(plugin: any) {
    this.plugin = plugin;
  }

  definition = {
    name: "read_code_region",
    description: "读取代码文件的指定符号附近片段，或按行号范围读取。适合在修改前先查看相关实现。",
    capabilityTags: ["read", "metadata"],
    riskLevel: "low" as const,
    parameters: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "代码文件路径" },
        symbol: { type: "string", description: "可选：按符号名读取其附近代码" },
        startLine: { type: "number", description: "可选：起始行号（1-based）" },
        endLine: { type: "number", description: "可选：结束行号（1-based）" },
      },
      required: ["path"],
    },
  };

  async execute(args: { path: string; symbol?: string; startLine?: number; endLine?: number }, app: App): Promise<string> {
    const path = String(args?.path || "").trim();
    if (!path) return "错误: read_code_region 缺少必填参数 path (string)";
    const text = await this.plugin.symbolIndex.readCodeRegion(path, {
      symbol: typeof args?.symbol === "string" ? args.symbol.trim() : undefined,
      startLine: args?.startLine,
      endLine: args?.endLine,
    });
    if (!text) return `未找到代码片段: ${path}`;
    return `代码片段: ${path}\n${text}`;
  }
}
