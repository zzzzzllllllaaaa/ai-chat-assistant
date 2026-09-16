import { App, FuzzySuggestModal, FuzzyMatch, TFile } from "obsidian";
import { IAiChatView, Conversation, ContextItem } from "../../core/types";

// 兼容：保留旧的模糊搜索对话列表（备用入口）
export class ConversationSuggestModal extends FuzzySuggestModal<Conversation> {
  private view: IAiChatView;

  constructor(app: App, view: IAiChatView) {
    super(app);
    this.view = view;
    this.setPlaceholder("搜索或选择对话...");
  }

  getItems(): Conversation[] {
    const conversations = this.view.getConversations();
    const newConvItem: Conversation = { id: 'new-conversation', title: '创建新对话...', history: [], model: '' };
    return [newConvItem, ...Object.values(conversations).reverse()];
  }

  getItemText(item: Conversation): string {
    return item.title;
  }

  onChooseItem(item: Conversation): void {
    if (item.id === 'new-conversation') {
      this.view.createNewConversation();
    } else {
      this.view.switchToConversation(item.id);
    }
  }
}

// 用于选择上下文的弹出式搜索框
export class ContextSuggestModal extends FuzzySuggestModal<ContextItem> {
  onChoose: (item: ContextItem) => void;
  items: ContextItem[] | null = null;

  constructor(app: App, onChoose: (item: ContextItem) => void) {
    super(app);
    this.onChoose = onChoose;
  }

  getItems(): ContextItem[] {
    if (this.items) return this.items;

    // 包含 Markdown 文件
    const mdFiles = this.app.vault.getMarkdownFiles().map(file => ({
      type: 'file' as const, path: file.path, displayName: file.basename
    }));

    // 包含 PDF 文件
    const pdfFiles = this.app.vault.getFiles()
      .filter(f => f.extension.toLowerCase() === 'pdf')
      .map(file => ({
        type: 'file' as const, path: file.path, displayName: `📄 ${file.basename}`
      }));

    const files = [...mdFiles, ...pdfFiles];

    // 收集唯一文件夹路径（基于 markdown 文件）
    const filePaths = this.app.vault.getMarkdownFiles();
    const folderSet = new Set<string>();
    filePaths.forEach(f => {
      const idx = f.path.lastIndexOf('/');
      if (idx > 0) folderSet.add(f.path.substring(0, idx));
    });
    const folders = Array.from(folderSet).map(path => ({
      type: 'folder' as const, path, displayName: path.split('/').pop() || ''
    }));

    // 某些 Obsidian typings 没有 getTags，使用 any 访问 tags 字段以兼容不同版本
    const tagsObj = (this.app.metadataCache as any).tags || {};
    const tags = Object.keys(tagsObj).map(tag => ({
      type: 'tag' as const, path: tag, displayName: tag
    }));

    this.items = [...files, ...folders, ...tags];
    return this.items;
  }

  getItemText(item: ContextItem): string { return item.displayName; }

  renderSuggestion(match: FuzzyMatch<ContextItem>, el: HTMLElement): void {
    el.createEl("div", { text: match.item.displayName });
    el.createEl("small", { text: match.item.type, cls: "ai-chat-suggestion-type" });
  }

  onChooseItem(item: ContextItem, evt: MouseEvent | KeyboardEvent): void {
    this.onChoose(item);
  }
}

// 用于选择插入笔记的弹出式搜索框
export class NoteSuggestModal extends FuzzySuggestModal<TFile> {
  onChoose: (file: TFile) => void;

  constructor(app: App, onChoose: (file: TFile) => void) {
    super(app);
    this.onChoose = onChoose;
  }

  getItems(): TFile[] { return this.app.vault.getMarkdownFiles(); }
  getItemText(file: TFile): string { return file.basename; }
  onChooseItem(file: TFile, evt: MouseEvent | KeyboardEvent): void { this.onChoose(file); }
}

// 候选文件选择模态（用于在 AI 建议多个可能修改文件时让用户先确认）
export class CandidateFileSuggestModal extends FuzzySuggestModal<TFile> {
  private itemsList: TFile[];
  private onChooseCb: (file: TFile | null) => void;

  constructor(app: App, items: TFile[], onChoose: (file: TFile | null) => void, placeholder?: string) {
    super(app);
    this.itemsList = items;
    this.onChooseCb = onChoose;
    this.setPlaceholder(placeholder ?? '选择要修改的候选文件...');
  }

  getItems(): TFile[] { return this.itemsList; }
  getItemText(item: TFile): string { return item.path; }
  onChooseItem(item: TFile, evt: MouseEvent | KeyboardEvent): void { this.onChooseCb(item); }
  // 如果按 Esc 或取消，返回 null
  onClose() { super.onClose(); this.onChooseCb(null); }
}

export class VaultFilePickerModal extends FuzzySuggestModal<TFile> {
  private onChooseCb: (file: TFile | null) => void;
  private submitted = false;

  constructor(app: App, placeholder: string, onChoose: (file: TFile | null) => void) {
    super(app);
    this.onChooseCb = onChoose;
    this.setPlaceholder(placeholder);
  }

  getItems(): TFile[] { return this.app.vault.getMarkdownFiles(); }
  getItemText(item: TFile): string { return item.path; }

  onChooseItem(item: TFile, evt: MouseEvent | KeyboardEvent): void {
    this.submitted = true;
    this.onChooseCb(item);
    this.close();
  }

  onClose(): void {
    super.onClose();
    if (!this.submitted) this.onChooseCb(null);
  }
}

// SlashCommand 接口定义
export interface SlashCommand {
  id: string;
  name: string;
  description: string;
  icon?: string;
  action: () => void;
}

// SlashCommandSuggestModal 类定义
export class SlashCommandSuggestModal extends FuzzySuggestModal<SlashCommand> {
  private commands: SlashCommand[];

  constructor(app: App, commands: SlashCommand[]) {
    super(app);
    this.commands = commands;
    this.setPlaceholder("输入命令...");
  }

  getItems(): SlashCommand[] {
    return this.commands;
  }

  getItemText(item: SlashCommand): string {
    return `${item.name} - ${item.description}`;
  }

  onChooseItem(item: SlashCommand, evt: MouseEvent | KeyboardEvent): void {
    item.action();
  }
}
