import { App } from "obsidian";
import type { Conversation, TodoItem } from "../../../core/types";
import type { Tool, ToolDefinition } from "../types";

type TodoAction = "get" | "set" | "clear";

export class ManageTodoListTool implements Tool {
  definition: ToolDefinition;
  private plugin: any;

  constructor(plugin: any) {
    this.plugin = plugin;
    this.definition = {
      name: "manage_todo_list",
      description:
        "读取或更新当前会话的待办列表（todo list）。当你需要维护一个可执行的计划时使用。返回 JSON。",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "操作类型：get=读取，set=覆盖写入，clear=清空",
            enum: ["get", "set", "clear"],
          },
          todoList: {
            type: "array",
            description:
              "待办列表（当 action=set 时使用）。每个条目包含 id/title/description/status。",
            items: {
              type: "object",
              properties: {
                id: { type: "number", description: "待办 ID（正整数）" },
                title: { type: "string", description: "简短标题（3-7 个词左右）" },
                description: { type: "string", description: "补充说明/验收标准" },
                status: {
                  type: "string",
                  description: "状态",
                  enum: ["not-started", "in-progress", "completed"],
                },
              },
              required: ["id", "title", "description", "status"],
            },
          },
        },
        required: [],
      },
    };
  }

  async execute(args: any, _app: App): Promise<string> {
    const convId: string | null =
      typeof this.plugin?.getActiveConversationId === "function"
        ? this.plugin.getActiveConversationId()
        : null;

    if (!convId) {
      return "错误: 未找到当前激活会话（请先在聊天视图中选中一个会话）。";
    }

    const conversations: Record<string, Conversation> =
      typeof this.plugin?.getConversations === "function" ? this.plugin.getConversations() : {};

    const conv = conversations?.[convId];
    if (!conv) {
      return `错误: 会话不存在或已被删除: ${convId}`;
    }

    const action: TodoAction | undefined = args?.action;

    if (action === "clear") {
      conv.todoList = [];
      conv.updatedAt = Date.now();
      if (typeof this.plugin?.saveConversations === "function") {
        await this.plugin.saveConversations(conversations);
      }
      return this.formatTodoList(conv.todoList);
    }

    if (action === "set" || (Array.isArray(args?.todoList) && action !== "get")) {
      const normalized = this.normalizeTodoList(args?.todoList);
      if (!normalized) {
        return "错误: todoList 格式不正确。请传入 todoList 数组，元素包含 id/title/description/status。";
      }
      conv.todoList = normalized;
      conv.updatedAt = Date.now();
      if (typeof this.plugin?.saveConversations === "function") {
        await this.plugin.saveConversations(conversations);
      }
      return this.formatTodoList(conv.todoList);
    }

    // default: get
    return this.formatTodoList(conv.todoList ?? []);
  }

  private normalizeTodoList(input: any): TodoItem[] | null {
    if (!Array.isArray(input)) return null;

    const allowed = new Set(["not-started", "in-progress", "completed"]);

    const out: TodoItem[] = [];
    for (const item of input) {
      const idRaw = item?.id;
      const id = typeof idRaw === "number" ? idRaw : typeof idRaw === "string" ? Number.parseInt(idRaw, 10) : NaN;
      const title = typeof item?.title === "string" ? item.title.trim() : "";
      const description = typeof item?.description === "string" ? item.description : "";
      const statusRaw = typeof item?.status === "string" ? item.status : "not-started";
      const status = (allowed.has(statusRaw) ? statusRaw : "not-started") as TodoItem["status"];

      if (!Number.isFinite(id) || id <= 0) continue;
      if (!title) continue;

      out.push({ id, title, description, status });
    }

    if (!out.length) return [];
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  private formatTodoList(todoList: TodoItem[]): string {
    return `\n\`\`\`json\n${JSON.stringify({ todoList }, null, 2)}\n\`\`\`\n`;
  }
}
