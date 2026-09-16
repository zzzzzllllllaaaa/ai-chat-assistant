import { App, Modal, setIcon } from "obsidian";
import { IAiChatView, Conversation } from "../../core/types";
import { NewConversationModal } from "./NewConversationModal";

const TITLE_LIMIT = 18;
const PREVIEW_LIMIT = 96;
const VISIBLE_TAG_LIMIT = 2;

function compactText(text: string | null | undefined): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export class ConversationManagerModal extends Modal {
  private view: IAiChatView;
  private searchTerm: string = '';
  private selectedModel: string = 'all';
  private onlyPinned = false;
  private onlyStarred = false;
  private showArchived = false;
  private tagFilters: Set<string> = new Set();
  private listEl!: HTMLElement;
  private tagFilterEl!: HTMLElement;
  private bulkBarEl!: HTMLElement;
  private bulkMenuEl!: HTMLElement;
  private bulkInfoEl!: HTMLElement;
  private bulkToggleBtn!: HTMLButtonElement;
  private deleteSelectedBtn!: HTMLButtonElement;
  private deleteAllBtn!: HTMLButtonElement;
  private clearSelectionBtn!: HTMLButtonElement;
  private selectAllBtn!: HTMLButtonElement;
  private bulkOutsideHandler?: (event: MouseEvent) => void;
  private bulkCloseMenu?: () => void;
  private selectedIds: Set<string> = new Set();
  private currentFiltered: Conversation[] = [];

  constructor(app: App, view: IAiChatView) {
    super(app);
    this.view = view;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('conversation-manager-modal');

    const header = contentEl.createDiv({ cls: 'conversation-manager-header' });
    header.createEl('h2', { text: '对话管理' });
    const newBtn = header.createEl('button', { text: '新对话', cls: 'mod-cta' });
    newBtn.addEventListener('click', () => {
      this.close();
      new NewConversationModal(this.app, this.view).open();
    });

    const filters = contentEl.createDiv({ cls: 'conversation-manager-filters' });
    const topRow = filters.createDiv({ cls: 'filter-row' });
    const searchInput = topRow.createEl('input', { type: 'search', placeholder: '搜索标题、首条问题或最后一条消息' }) as HTMLInputElement;
    searchInput.addEventListener('input', () => {
      this.searchTerm = searchInput.value.trim().toLowerCase();
      this.renderList();
    });

    const modelFilter = topRow.createDiv({ cls: 'conversation-model-filter' });
    modelFilter.createSpan({ cls: 'conversation-model-filter-label', text: '模型' });
    const modelSelect = modelFilter.createEl('select', { attr: { 'aria-label': '按模型筛选对话' } });
    modelSelect.addClass('conversation-model-select');
    modelSelect.createEl('option', { value: 'all', text: '全部模型' });
    const models = new Set(Object.values(this.view.getConversations()).map(conv => conv.model));
    Array.from(models).forEach(model => {
      modelSelect.createEl('option', { value: model, text: model });
    });
    modelSelect.addEventListener('change', () => {
      this.selectedModel = modelSelect.value;
      this.renderList();
    });

    const statusFilters = filters.createDiv({ cls: 'status-filters' });
    statusFilters.createSpan({ cls: 'status-filters-label', text: '筛选' });
    const createFilterButton = (icon: string, label: string, active: boolean, onClick: () => void) => {
      const btn = statusFilters.createEl('button', { cls: `filter-icon-btn ${active ? 'active' : ''}`, attr: { 'aria-label': label, title: label } });
      setIcon(btn, icon);
      btn.addEventListener('click', () => {
        onClick();
        this.renderList();
      });
    };

    createFilterButton('pin', '仅置顶', this.onlyPinned, () => { this.onlyPinned = !this.onlyPinned; });
    createFilterButton('star', '仅加星', this.onlyStarred, () => { this.onlyStarred = !this.onlyStarred; });
    createFilterButton('archive', '显示归档', this.showArchived, () => { this.showArchived = !this.showArchived; });

    this.tagFilterEl = contentEl.createDiv({ cls: 'conversation-tag-filters' });
    this.listEl = contentEl.createDiv({ cls: 'conversation-manager-list' });

    this.bulkBarEl = contentEl.createDiv({ cls: 'conversation-bulk-anchor' });
    this.bulkToggleBtn = this.bulkBarEl.createEl('button', {
      cls: 'conversation-bulk-dot',
      text: '批量',
      attr: { 'aria-label': '批量操作' }
    }) as HTMLButtonElement;
    this.bulkMenuEl = this.bulkBarEl.createDiv({ cls: 'conversation-bulk-menu' });
    this.bulkInfoEl = this.bulkMenuEl.createSpan({ cls: 'bulk-info', text: '未选择任何会话' });
    const bulkButtons = this.bulkMenuEl.createDiv({ cls: 'bulk-buttons' });
    this.selectAllBtn = bulkButtons.createEl('button', { text: '全选' }) as HTMLButtonElement;
    this.clearSelectionBtn = bulkButtons.createEl('button', { text: '清空' }) as HTMLButtonElement;
    this.deleteSelectedBtn = bulkButtons.createEl('button', { text: '删选中', cls: 'danger' }) as HTMLButtonElement;
    this.deleteAllBtn = bulkButtons.createEl('button', { text: '删全部', cls: 'danger' }) as HTMLButtonElement;

    this.selectAllBtn.addEventListener('click', () => {
      this.currentFiltered.forEach(conv => this.selectedIds.add(conv.id));
      this.renderList();
    });
    this.clearSelectionBtn.addEventListener('click', () => {
      this.selectedIds.clear();
      this.renderList();
    });
    this.deleteSelectedBtn.addEventListener('click', () => {
      if (!this.selectedIds.size) return;
      if (!confirm(`确定删除选中的 ${this.selectedIds.size} 个对话吗？`)) return;
      this.view.deleteConversations(Array.from(this.selectedIds));
      this.selectedIds.clear();
      this.renderList();
    });
    this.deleteAllBtn.addEventListener('click', () => {
      if (!confirm('确定要删除全部对话吗？该操作不可撤销。')) return;
      this.view.deleteAllConversations();
      this.selectedIds.clear();
      this.renderList();
    });

    const openBulkMenu = () => {
      this.bulkBarEl.addClass('open');
      this.bulkOutsideHandler = (event: MouseEvent) => {
        if (!this.bulkBarEl.contains(event.target as Node)) this.bulkCloseMenu?.();
      };
      setTimeout(() => {
        if (this.bulkOutsideHandler) document.addEventListener('click', this.bulkOutsideHandler);
      }, 0);
    };

    this.bulkCloseMenu = () => {
      this.bulkBarEl.removeClass('open');
      if (this.bulkOutsideHandler) {
        document.removeEventListener('click', this.bulkOutsideHandler);
        this.bulkOutsideHandler = undefined;
      }
    };

    this.bulkToggleBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.bulkBarEl.hasClass('open')) this.bulkCloseMenu?.();
      else openBulkMenu();
    });

    this.renderList();
    this.updateBulkControls();
  }

  private getConversationSummary(conv: Conversation): { title: string; searchText: string; preview: string; messageCount: number } {
    const loadedHistory = conv.historyLoaded ? conv.history : [];
    const firstUserFromHistory = loadedHistory.find(msg => msg.role === 'user')?.content;
    const lastNonSystemFromHistory = [...loadedHistory].reverse().find(msg => msg.role !== 'system')?.content;

    const firstUserText = compactText(firstUserFromHistory || conv.firstUserText || conv.title);
    const previewSource = compactText(lastNonSystemFromHistory || conv.previewText || firstUserText || conv.title);
    const titleSource = firstUserText || compactText(conv.title) || '未命名对话';
    const preview = previewSource || '暂无内容';
    const searchText = [conv.title, firstUserText, previewSource, ...(conv.tags ?? [])].map(compactText).filter(Boolean).join('\n').toLowerCase();
    const messageCount = conv.historyLoaded ? loadedHistory.length : (conv.messageCount ?? 0);

    return {
      title: truncateText(titleSource, TITLE_LIMIT),
      searchText,
      preview: truncateText(preview, PREVIEW_LIMIT),
      messageCount,
    };
  }

  private renderList() {
    if (!this.listEl) return;
    const allConversations = Object.values(this.view.getConversations());
    const existingIds = new Set(allConversations.map(conv => conv.id));
    Array.from(this.selectedIds).forEach(id => {
      if (!existingIds.has(id)) this.selectedIds.delete(id);
    });

    const availableTags = Array.from(new Set(allConversations.flatMap(conv => conv.tags ?? [])));
    this.renderTagFilters(availableTags);

    let filtered = allConversations.slice();
    if (!this.showArchived) filtered = filtered.filter(conv => !conv.archived);
    if (this.onlyPinned) filtered = filtered.filter(conv => conv.pinned);
    if (this.onlyStarred) filtered = filtered.filter(conv => conv.starred);
    if (this.selectedModel !== 'all') filtered = filtered.filter(conv => conv.model === this.selectedModel);
    if (this.tagFilters.size) {
      filtered = filtered.filter(conv => {
        const tags = new Set(conv.tags ?? []);
        return Array.from(this.tagFilters).every(tag => tags.has(tag));
      });
    }
    if (this.searchTerm) {
      filtered = filtered.filter(conv => this.getConversationSummary(conv).searchText.includes(this.searchTerm));
    }

    const sorted = this.view.sortConversations(filtered);
    this.currentFiltered = sorted;
    this.listEl.empty();

    if (!sorted.length) {
      const emptyState = this.listEl.createDiv({ cls: 'conversation-empty-state' });
      emptyState.createDiv({ cls: 'empty-state-icon', text: '📭' });
      emptyState.createDiv({ cls: 'empty-state-title', text: '没有符合条件的对话' });
      emptyState.createDiv({ cls: 'empty-state-hint', text: this.searchTerm || this.tagFilters.size || this.onlyPinned || this.onlyStarred || this.selectedModel !== 'all' || this.showArchived ? '试试调整搜索词、筛选条件或标签。' : '点击右上角“新对话”开始新的会话。' });
      this.updateBulkControls();
      return;
    }

    sorted.forEach(conv => {
      const summary = this.getConversationSummary(conv);
      const row = this.listEl.createDiv({ cls: 'conversation-row' });
      row.toggleClass('is-archived', !!conv.archived);
      row.toggleClass('is-selected', this.selectedIds.has(conv.id));

      const selectContainer = row.createDiv({ cls: 'conversation-row-select-container' });
      const selectBox = selectContainer.createEl('input', { type: 'checkbox', cls: 'conversation-row-select' }) as HTMLInputElement;
      selectBox.checked = this.selectedIds.has(conv.id);
      selectBox.addEventListener('change', () => {
        this.toggleSelection(conv.id, selectBox.checked);
        row.toggleClass('is-selected', selectBox.checked);
      });

      const body = row.createDiv({ cls: 'conversation-row-body' });
      const titleRow = body.createDiv({ cls: 'conversation-row-title-row' });
      titleRow.createDiv({ cls: 'conversation-row-title', text: summary.title, attr: { title: compactText(conv.firstUserText || conv.title || summary.title) } });
      const statusBadges = titleRow.createDiv({ cls: 'conversation-row-status' });
      if (conv.pinned) statusBadges.createSpan({ cls: 'badge', text: '置顶' });
      if (conv.starred) statusBadges.createSpan({ cls: 'badge star', text: '加星' });

      const metaRow = body.createDiv({ cls: 'conversation-row-meta' });
      const updated = conv.updatedAt ? new Date(conv.updatedAt).toLocaleString() : '未知时间';
      metaRow.setText(`${conv.model} · ${updated} · ${summary.messageCount} 条消息`);

      const previewRow = body.createDiv({ cls: 'conversation-row-preview', text: summary.preview });
      previewRow.setAttr('title', compactText(conv.previewText || summary.preview));

      if (conv.tags?.length) {
        const tagRow = body.createDiv({ cls: 'conversation-row-tags' });
        conv.tags.slice(0, VISIBLE_TAG_LIMIT).forEach(tag => tagRow.createSpan({ cls: 'tag-pill', text: tag }));
        if (conv.tags.length > VISIBLE_TAG_LIMIT) {
          tagRow.createSpan({ cls: 'tag-pill more', text: `+${conv.tags.length - VISIBLE_TAG_LIMIT}` });
        }
      }

      const actions = row.createDiv({ cls: 'conversation-row-actions' });
      const openBtn = actions.createEl('button', { text: '打开', cls: 'primary small-btn conversation-open-btn' });
      openBtn.addEventListener('click', () => {
        this.view.switchToConversation(conv.id);
        this.close();
      });

      const menuWrap = actions.createDiv({ cls: 'conversation-card-menu' });
      const menuBtn = menuWrap.createEl('button', { text: '···', cls: 'more-icon-btn', attr: { 'aria-label': '更多操作' } });
      const menuPanel = menuWrap.createDiv({ cls: 'conversation-card-menu-panel', attr: { 'aria-hidden': 'true' } });

      const closeMenu = () => {
        menuPanel.removeClass('open');
        menuBtn.removeClass('open');
        menuPanel.setAttr('aria-hidden', 'true');
        row.removeClass('has-menu-open');
        document.removeEventListener('click', handleDocumentClick);
      };
      const handleDocumentClick = (event: MouseEvent) => {
        if (!menuWrap.contains(event.target as Node)) closeMenu();
      };
      const openMenu = () => {
        const rect = menuBtn.getBoundingClientRect();
        const modalRect = this.contentEl.getBoundingClientRect();
        const spaceBelow = modalRect.bottom - rect.bottom;
        menuPanel.removeClass('open-upwards');
        if (spaceBelow < 220) menuPanel.addClass('open-upwards');
        menuPanel.addClass('open');
        menuBtn.addClass('open');
        menuPanel.setAttr('aria-hidden', 'false');
        row.addClass('has-menu-open');
        setTimeout(() => document.addEventListener('click', handleDocumentClick));
      };
      menuBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (menuPanel.hasClass('open')) closeMenu();
        else openMenu();
      });

      const addMenuItem = (label: string, handler: () => void, cls?: string) => {
        const item = menuPanel.createEl('button', { text: label });
        if (cls) item.addClass(cls);
        item.addEventListener('click', () => {
          closeMenu();
          handler();
        });
      };

      addMenuItem(conv.pinned ? '取消置顶' : '置顶', () => { this.view.toggleConversationPin(conv.id); this.renderList(); });
      addMenuItem(conv.starred ? '取消加星' : '加星', () => { this.view.toggleConversationStar(conv.id); this.renderList(); });
      addMenuItem(conv.archived ? '取消归档' : '归档', () => { this.view.setConversationArchived(conv.id, !conv.archived); this.renderList(); });
      addMenuItem('编辑标签', () => {
        new TagEditorModal(this.app, conv.tags ?? [], (tags) => {
          if (!tags) return;
          this.view.updateConversationTags(conv.id, tags);
          this.renderList();
        }).open();
      });
      addMenuItem('导出到笔记', () => this.view.exportConversationToNote(conv));
      addMenuItem('导出 Markdown', () => this.view.exportConversationAsMarkdown(conv));
      addMenuItem('删除', () => {
        if (confirm(`确定要删除对话「${conv.title}」吗？`)) {
          this.view.deleteConversation(conv.id);
          this.selectedIds.delete(conv.id);
          this.renderList();
        }
      }, 'danger');
    });

    this.updateBulkControls();
  }

  private renderTagFilters(tags: string[]) {
    this.tagFilterEl.empty();
    this.tagFilterEl.toggleClass('is-empty', tags.length === 0);
    if (!tags.length) {
      return;
    }

    this.tagFilterEl.createSpan({ cls: 'tag-filter-label', text: '标签筛选：' });
    const pills = this.tagFilterEl.createDiv({ cls: 'tag-filter-pills' });

    tags.forEach(tag => {
      const pill = pills.createSpan({ cls: `tag-filter-pill ${this.tagFilters.has(tag) ? 'active' : ''}`, text: tag });
      pill.addEventListener('click', () => {
        if (this.tagFilters.has(tag)) this.tagFilters.delete(tag);
        else this.tagFilters.add(tag);
        this.renderList();
      });
    });
  }

  private toggleSelection(conversationId: string, enabled: boolean) {
    if (enabled) this.selectedIds.add(conversationId);
    else this.selectedIds.delete(conversationId);
    this.updateBulkControls();
  }

  private updateBulkControls() {
    if (!this.bulkBarEl || !this.bulkInfoEl) return;
    const selectedCount = this.selectedIds.size;
    if (selectedCount) {
      this.bulkBarEl.addClass('has-selection');
      this.bulkInfoEl.setText(`已选择 ${selectedCount} 个会话`);
    } else {
      this.bulkBarEl.removeClass('has-selection');
      this.bulkInfoEl.setText('未选择任何会话');
    }

    const currentTotal = this.currentFiltered.length;
    if (this.selectAllBtn) this.selectAllBtn.disabled = currentTotal === 0 || selectedCount === currentTotal;
    if (this.clearSelectionBtn) this.clearSelectionBtn.disabled = selectedCount === 0;
    if (this.deleteSelectedBtn) this.deleteSelectedBtn.disabled = selectedCount === 0;
    if (this.deleteAllBtn) this.deleteAllBtn.disabled = Object.keys(this.view.getConversations()).length === 0;
  }
}

export class TagEditorModal extends Modal {
  private initialTags: string[];
  private onSubmit: (tags: string[] | null) => void;
  private input!: HTMLInputElement;

  constructor(app: App, initialTags: string[], onSubmit: (tags: string[] | null) => void) {
    super(app);
    this.initialTags = initialTags;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('tag-editor-modal');
    contentEl.createEl('h2', { text: '编辑标签' });
    contentEl.createEl('p', { text: '使用逗号分隔多个标签。' });
    this.input = contentEl.createEl('input', { type: 'text' }) as HTMLInputElement;
    this.input.value = this.initialTags.join(', ');

    const actionBar = contentEl.createDiv({ cls: 'modal-button-bar' });
    const saveBtn = actionBar.createEl('button', { text: '保存', cls: 'mod-cta' });
    const cancelBtn = actionBar.createEl('button', { text: '取消', cls: 'mod-cancel' });

    saveBtn.addEventListener('click', () => {
      const tags = this.input.value.split(',').map(tag => tag.trim()).filter(Boolean);
      this.onSubmit(tags);
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
