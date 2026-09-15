import { App, Modal } from "obsidian";
import { IAiChatView } from "../../core/types";

export class NewConversationModal extends Modal {
  private view: IAiChatView;
  private titleInput!: HTMLInputElement;
  private tagsInput!: HTMLInputElement;

  constructor(app: App, view: IAiChatView) {
    super(app);
    this.view = view;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('new-conversation-modal');
    contentEl.createEl('h2', { text: '创建新对话' });

    const titleGroup = contentEl.createDiv({ cls: 'form-group' });
    titleGroup.createEl('label', { text: '对话标题（可选）' });
    this.titleInput = titleGroup.createEl('input', { type: 'text', placeholder: '默认使用当前时间' }) as HTMLInputElement;

    const tagsGroup = contentEl.createDiv({ cls: 'form-group' });
    tagsGroup.createEl('label', { text: '标签（逗号分隔，可选）' });
    this.tagsInput = tagsGroup.createEl('input', { type: 'text', placeholder: '如：日报,周报' }) as HTMLInputElement;

    const actionBar = contentEl.createDiv({ cls: 'modal-button-bar' });
    const createBtn = actionBar.createEl('button', { text: '创建', cls: 'mod-cta' });
    const cancelBtn = actionBar.createEl('button', { text: '取消', cls: 'mod-cancel' });

    createBtn.addEventListener('click', () => this.submit());
    cancelBtn.addEventListener('click', () => this.close());
  }

  private submit() {
    const title = this.titleInput.value.trim();
    const tags = this.tagsInput.value.split(',').map(tag => tag.trim()).filter(Boolean);
    this.view.createNewConversation({ title, tags });
    this.close();
  }
}
