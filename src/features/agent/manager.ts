import { App } from "obsidian";
import type { Agent, Tool } from "./types";
import * as Tools from "./tools";
import { logger } from "../../core/logger";

export class AgentManager {
  private app: App;
  private plugin: any;
  private tools: Map<string, Tool> = new Map();
  private agents: Map<string, Agent> = new Map();

  constructor(app: App, plugin: any) {
    this.app = app;
    this.plugin = plugin;
    this.registerDefaultTools();
    this.registerDefaultAgents();
  }

  private registerDefaultTools() {
    // 自动注册所有从 tools 目录导出的工具
    Object.values(Tools).forEach(ToolClass => {
      try {
        if (typeof ToolClass === 'function' && ToolClass.prototype) {
          let toolInstance: Tool;
          // 根据构造函数参数决定如何实例化
          if (ToolClass.length === 1) {
            toolInstance = new (ToolClass as any)(this.plugin);
          } else {
            toolInstance = new (ToolClass as any)();
          }
          
          if (toolInstance.definition && typeof toolInstance.execute === 'function') {
            this.registerTool(toolInstance);
          }
        }
      } catch (e) {
        logger.error("System", "注册工具失败", { toolClass: (ToolClass as any)?.name || String(ToolClass), error: e });
      }
    });
  }

  public findToolsByDescription(query: string): Tool[] {
    const lowerQuery = query.toLowerCase();
    return Array.from(this.tools.values()).filter(t => 
      t.definition.description.toLowerCase().includes(lowerQuery) ||
      t.definition.name.toLowerCase().includes(lowerQuery)
    );
  }

  public getAllToolDefinitions(): any[] {
    return Array.from(this.tools.values()).map(t => t.definition);
  }

  private registerDefaultAgents() {
    // 核心预设智能体 - 可以被用户自定义版本覆盖
    this.registerAgent({
      id: "note-assistant",
      name: "笔记助手",
      description: "可以帮你读取、查找、创建和修改笔记的智能助手。",
      systemPrompt: `你是一个 Obsidian 笔记助手。默认只使用核心笔记工具来完成读取、查找、创建、修改、移动、删除和属性处理。

**默认工作流（推荐）**：
1. 先用 list_files / search_notes / knowledge_base_query 定位目标
2. 再用 get_note_structure / read_note 确认具体内容
3. 修改时优先用 replace_in_note 做精准替换，必要时再用 modify_note 做整段写入
4. 使用 get_child_notes 获取某个笔记的所有子笔记（通过 frontmatter 中的父笔记字段）
5. 使用 get_backlinks 获取链接到某个笔记的所有反向链接

除非当前任务明确需要更专门的能力，否则不要假设可以使用代码、Canvas、MCP、命令或其他扩展工具。`,
      tools: ["read_note", "get_note_structure", "replace_in_note", "list_files", "create_note", "create_folder", "modify_note", "search_notes", "get_recent_notes", "move_item", "delete_file", "knowledge_base_query", "get_properties", "update_properties", "get_child_notes", "get_backlinks"],
      isPreset: true,
    });

    this.registerAgent({
      id: "code-assistant",
      name: "代码助手",
      description: "专注于代码理解、影响范围分析、符号定位和局部实现阅读。",
      systemPrompt: `你是一个代码助手。你擅长先定位符号、再查引用、再阅读局部实现，最后才提出修改建议。

推荐工作流：
1. 先用 find_symbol 查定义
2. 再用 find_references 看调用点
3. 用 list_code_dependencies 分析影响范围
4. 用 read_code_region 阅读局部实现

未经证据确认，不要凭空推断代码结构。`,
      tools: ["find_symbol", "find_references", "list_code_dependencies", "read_code_region", "search_notes", "list_files", "read_note", "manage_todo_list"],
      isPreset: true,
    });
    
    this.registerAgent({
      id: "writer",
      name: "写作专家",
      description: "专注于内容创作和润色，必要时可以参考现有笔记。",
      systemPrompt: `你是一位专业的写作专家。你的目标是帮助用户创作高质量的内容。

**编辑现有笔记时**：
1. 先用 get_note_structure 了解文章结构
2. 用 read_note 读取需要修改的部分
3. 用 replace_in_note 精准替换（保留其他内容不变）

你可以读取用户现有的笔记作为参考。`,
      tools: ["read_note", "get_note_structure", "replace_in_note", "search_notes", "knowledge_base_query"],
      isPreset: true,
    });

    this.registerAgent({
      id: "webparser",
      name: "网页解析",
      description: "可以调用 MCP 工具来获取和解析网页内容。",
      systemPrompt: "你是一个网页解析助手。你可以使用 MCP 工具来获取网页内容并进行分析。当用户提供 URL 时，请使用 mcp_call_tool 来获取页面内容。",
      tools: ["mcp_list_tools", "mcp_call_tool", "read_note", "create_note", "get_note_structure"],
      isPreset: true,
    });
  }
  public registerTool(tool: Tool) {
    this.tools.set(tool.definition.name, tool);
  }

  public registerAgent(agent: Agent) {
    this.agents.set(agent.id, agent);
  }

  public getAgent(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  public getAllAgents(): Agent[] {
    return Array.from(this.agents.values());
  }

  public getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  public getAllToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  public loadAgentsFromSettings(customAgents: Agent[], hiddenPresetIds: string[] = [], personas?: any[]) {
    this.agents.clear();
    this.registerDefaultAgents();
    // 移除被隐藏的预设智能体
    hiddenPresetIds.forEach(id => {
      this.agents.delete(id);
    });
    // 添加/覆盖自定义智能体
    customAgents.forEach(agent => {
      this.registerAgent(agent);
    });
    
    // 从 Personas 中提取带工具绑定的角色，注册为 Agent
    if (personas) {
      personas.forEach((persona: any) => {
        // 只有 tool-agent 类型或有工具绑定的角色才注册
        if ((persona.type === 'tool-agent' || (persona.tools && persona.tools.length > 0)) && !this.agents.has(persona.id)) {
          const agentFromPersona: Agent = {
            id: persona.id,
            name: persona.name,
            description: persona.description || '',
            systemPrompt: persona.systemPrompt || '',
            tools: persona.tools || [],
            model: persona.model,
            mbti: persona.mbti,
            isPreset: false,
          };
          this.registerAgent(agentFromPersona);
        }
      });
    }
  }

  public getToolsForAgent(agentId: string): Tool[] {
    const agent = this.getAgent(agentId);
    if (!agent) return [];
    return agent.tools
      .map(name => this.tools.get(name))
      .filter((t): t is Tool => !!t);
  }

  public getToolLabel(name: string): string {
    const labels: Record<string, string> = {
      "read_note": "读取笔记 (Read Note)",
      "get_note_structure": "笔记结构 (Note Structure)",
      "replace_in_note": "精准替换 (Replace In Note)",
      "list_files": "列出文件 (List Files)",
      "create_note": "创建笔记 (Create Note)",
      "create_folder": "创建文件夹 (Create Folder)",
      "modify_note": "修改笔记 (Modify Note)",
      "search_notes": "搜索笔记 (Search Notes)",
      "get_recent_notes": "获取最近笔记 (Recent Notes)",
      "move_item": "移动/重命名 (Move/Rename)",
      "vector_search": "语义检索 (Vector Search)",
      "append_to_note": "追加内容 (Append)",
      "get_backlinks": "获取反向链接 (Backlinks)",
      "delete_file": "删除文件 (Delete File)",
      "execute_command": "执行命令 (Execute Command)",
      "list_commands": "列出命令 (List Commands)",
      "web_search": "联网搜索 (Web Search)",
      "read_webpage": "读取网页 (Read Webpage)",
      "knowledge_base_query": "知识库检索 (Knowledge Base)",
      "mcp_call_tool": "MCP 调用工具 (MCP Call Tool)",
      "mcp_list_tools": "MCP 工具列表 (MCP List Tools)",
      "manage_todo_list": "管理待办 (Todo)",
      "get_properties": "获取属性 (Get Properties)",
      "update_properties": "更新属性 (Update Properties)",
      "read_canvas": "读取白板 (Read Canvas)",
      "create_canvas": "创建白板 (Create Canvas)",
      "create_canvas_mindmap": "创建思维导图 (Canvas Mindmap)",
      "modify_canvas": "修改白板 (Modify Canvas)",
      "explore_note_links": "探索笔记链接 (Explore Links)",
      "find_note_relationships": "笔记父子关系 (Note Relationships)",
      "discover_tools": "搜索可用工具 (Discover Tools)",
      "use_tool_from_library": "调用库工具 (Use Library Tool)",
    };
    return labels[name] || name;
  }
}
