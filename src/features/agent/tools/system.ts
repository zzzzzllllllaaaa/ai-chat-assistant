import { App } from "obsidian";
import type { Tool } from "../types";

export class DiscoverToolsTool implements Tool {
  private plugin: any;

  constructor(plugin: any) {
    this.plugin = plugin;
  }

  definition = {
    name: "discover_tools",
    description: "在工具库中搜索可用的工具。当你发现当前工具无法满足需求时，可以使用此工具查找是否有更合适的工具。",
    parameters: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "搜索关键词（如 'git', 'database', 'image'）",
        },
      },
      required: ["query"],
    },
  };

  async execute(args: { query: string }, app: App): Promise<string> {
    const tools = this.plugin.agentManager.findToolsByDescription(args.query);
    
    if (tools.length === 0) {
      return `在工具库中未找到与 "${args.query}" 相关的工具。`;
    }

    const list = tools.map((t: Tool) => `- ${t.definition.name}: ${t.definition.description}`).join("\n");
    return `找到以下相关工具:\n${list}\n\n你可以请求将这些工具分配给你或相关专家。`;
  }
}

export class UseToolFromLibraryTool implements Tool {
  private plugin: any;

  constructor(plugin: any) {
    this.plugin = plugin;
  }

  definition = {
    name: "use_tool_from_library",
    description: "从全局工具库中临时加载并执行一个工具。当你发现当前分配的工具不足以完成任务，且通过 discover_tools 找到了合适的工具时使用。",
    parameters: {
      type: "object" as const,
      properties: {
        toolName: {
          type: "string",
          description: "工具名称",
        },
        arguments: {
          type: "object",
          description: "传递给该工具的参数",
        },
      },
      required: ["toolName", "arguments"],
    },
  };

  async execute(args: { toolName: string; arguments: any }, app: App): Promise<string> {
    const tool = this.plugin.agentManager.getTool(args.toolName);
    if (!tool) {
      return `错误: 在工具库中未找到工具 "${args.toolName}"。请先使用 discover_tools 确认。`;
    }

    try {
      return await tool.execute(args.arguments, app);
    } catch (e: any) {
      return `执行工具 "${args.toolName}" 失败: ${e.message}`;
    }
  }
}
