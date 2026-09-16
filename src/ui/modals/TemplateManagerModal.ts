import { App, Modal } from "obsidian";
import { IAiChatView } from "../../core/types";
import { ConversationTemplate } from "../../core/settings";

export class TemplateManagerModal extends Modal {
  private view: IAiChatView;
  private templates: ConversationTemplate[];

  constructor(app: App, view: IAiChatView) {
    super(app);
    this.view = view;
    this.templates = this.view.getConversationTemplates();
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('conversation-manager-modal'); // Reuse styles
    const header = contentEl.createDiv({ cls: 'conversation-manager-header' });
    header.createEl('h2', { text: '模板管理' });
    const newBtn = header.createEl('button', { text: '新建模板', cls: 'mod-cta' });
    newBtn.addEventListener('click', () => {
      this.createNewTemplate();
    });

    const listContainer = contentEl.createDiv({ cls: 'conversation-template-section' });
    this.renderList(listContainer);
  }

  private renderList(container: HTMLElement) {
    container.empty();
    if (this.templates.length === 0) {
      container.createEl('p', { text: '暂无模板，请点击右上角新建。', cls: 'template-description' });
      return;
    }

    this.templates.forEach((tpl, index) => {
      const card = container.createDiv({ cls: 'conversation-template-card' });
      const summary = card.createDiv({ cls: 'conversation-template-summary' });
      summary.setAttr('style', 'padding: 10px 12px; display: flex; align-items: center; justify-content: space-between;');
      
      const infoDiv = summary.createDiv();
      infoDiv.setAttr('style', 'display: flex; flex-direction: column; gap: 4px;');
      const nameRow = infoDiv.createDiv({ cls: 'template-name-row' });
      nameRow.setAttr('style', 'display: flex; align-items: center; gap: 6px;');
      if (tpl.slashCommand) {
        const cmdBadge = nameRow.createSpan({ text: `/${tpl.slashCommand}`, cls: 'ai-slash-cmd-tag' });
      }
      nameRow.createSpan({ cls: 'template-name', text: tpl.name || `模板 ${index + 1}` });
      // presetPrompt preview
      if (tpl.presetPrompt) {
        const preview = tpl.presetPrompt.length > 60 ? tpl.presetPrompt.slice(0, 60) + '...' : tpl.presetPrompt;
        infoDiv.createSpan({ cls: 'template-meta', text: preview });
      }

      const actionsDiv = summary.createDiv();
      actionsDiv.setAttr('style', 'display: flex; gap: 8px;');
      const editBtn = actionsDiv.createEl('button', { text: '编辑' });
      editBtn.addEventListener('click', () => {
        new TemplateEditorModal(this.app, tpl, async (updatedTpl) => {
          if (updatedTpl) {
            this.templates[index] = updatedTpl;
            await this.view.saveSettings();
            this.renderList(container);
          }
        }).open();
      });

      const deleteBtn = actionsDiv.createEl('button', { text: '删除', cls: 'mod-warning' });
      deleteBtn.addEventListener('click', async () => {
        this.templates.splice(index, 1);
        await this.view.saveSettings();
        this.renderList(container);
      });
    });
  }

  private createNewTemplate() {
    const newTpl: ConversationTemplate = {
      id: `tpl-${Date.now()}`,
      name: '新模板',
      presetPrompt: '',
    };
    new TemplateEditorModal(this.app, newTpl, async (createdTpl) => {
      if (createdTpl) {
        this.templates.push(createdTpl);
        await this.view.saveSettings();
        this.renderList(this.contentEl.querySelector('.conversation-template-section') as HTMLElement);
      }
    }).open();
  }

  onClose() {
    this.contentEl.empty();
  }
}

export class TemplateEditorModal extends Modal {
  private template: ConversationTemplate;
  private onSubmit: (tpl: ConversationTemplate | null) => void;

  constructor(app: App, template: ConversationTemplate, onSubmit: (tpl: ConversationTemplate | null) => void) {
    super(app);
    this.template = JSON.parse(JSON.stringify(template)); // Deep copy
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('new-conversation-modal'); // Reuse styles
    contentEl.createEl('h2', { text: this.template.name ? `编辑模板: ${this.template.name}` : '新建模板' });

    const form = contentEl.createDiv();

    // Name
    const nameGroup = form.createDiv({ cls: 'form-group' });
    nameGroup.createEl('label', { text: '模板名称' });
    const nameInput = nameGroup.createEl('input', { type: 'text', value: this.template.name });
    nameInput.addEventListener('input', () => this.template.name = nameInput.value);

    // Slash Command
    const slashGroup = form.createDiv({ cls: 'form-group' });
    slashGroup.createEl('label', { text: '斜杠指令' });
    const slashHint = slashGroup.createEl('small', { text: '在输入框输入 / 加此触发词即可快速引用，如: translate', cls: 'setting-item-description' });
    slashHint.setAttr('style', 'display: block; margin-bottom: 4px; opacity: 0.7;');
    const slashInput = slashGroup.createEl('input', { type: 'text', value: this.template.slashCommand || '', placeholder: '例如: translate、summarize、rewrite' });
    slashInput.addEventListener('input', () => {
      // Auto-strip leading "/" and spaces
      this.template.slashCommand = slashInput.value.replace(/^\//, '').trim();
    });

    // Preset Prompt
    const promptGroup = form.createDiv({ cls: 'form-group' });
    promptGroup.createEl('label', { text: '指令内容' });
    const promptInput = promptGroup.createEl('textarea', { text: this.template.presetPrompt });
    promptInput.rows = 5;
    promptInput.placeholder = '输入指令提示词内容，如：请将以下内容翻译成英文：';
    promptInput.addEventListener('input', () => this.template.presetPrompt = promptInput.value);

    const actionBar = contentEl.createDiv({ cls: 'modal-button-bar' });
    const saveBtn = actionBar.createEl('button', { text: '保存', cls: 'mod-cta' });
    const cancelBtn = actionBar.createEl('button', { text: '取消', cls: 'mod-cancel' });

    saveBtn.addEventListener('click', () => {
      this.onSubmit(this.template);
      this.close();
    });
    cancelBtn.addEventListener('click', () => {
      this.onSubmit(null);
      this.close();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}
