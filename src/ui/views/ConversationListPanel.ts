/**
 * 对话列表面板组件
 * 
 * 从 view.ts 提取，负责：
 * - 渲染对话列表（筛选、排序、高亮）
 * - 处理点击切换
 */
import type { Conversation } from "../../core/types";

export class ConversationListPanel {
  private el: HTMLElement;

  constructor(container: HTMLElement) {
    this.el = container.createEl("div", { cls: "ai-chat-conversation-list" });
  }

  get element(): HTMLElement {
    return this.el;
  }

  /** 渲染对话列表 */
  render(
    conversations: Conversation[],
    activeConversationId: string | null,
    activePersonaId: string | undefined,
    onSwitch: (id: string) => void
  ) {
    this.el.empty();

    const isDefaultPersona = activePersonaId === "default" || !activePersonaId;

    const sorted = conversations
      .filter(conv => {
        if (conv.archived) return false;
        if (isDefaultPersona) {
          return conv.personaId === "default" || !conv.personaId;
        }
        return conv.personaId === activePersonaId;
      })
      .sort((a, b) => ConversationListPanel.compare(a, b));

    sorted.forEach(conv => {
      const convEl = this.el.createEl("div", {
        cls: `ai-chat-conversation-item ${conv.id === activeConversationId ? 'active' : ''}`,
        text: conv.title
      });
      convEl.addEventListener("click", () => onSwitch(conv.id));
    });
  }

  /** 排序规则：置顶 > 星标 > 更新时间 */
  static compare(a: Conversation, b: Conversation): number {
    if ((a.pinned ?? false) !== (b.pinned ?? false)) return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
    if ((a.starred ?? false) !== (b.starred ?? false)) return (b.starred ? 1 : 0) - (a.starred ? 1 : 0);
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  }
}
