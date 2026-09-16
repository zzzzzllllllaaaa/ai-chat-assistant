import { App, Modal, Notice, TFile } from "obsidian";
import { UiDiffHunk, AssistantMessageSegment, AssistantSegmentType } from "../../core/types";

export class SegmentSelectionModal extends Modal {
  private segments: AssistantMessageSegment[];
  private selected: Set<string>;
  private onSubmit: (result: string[] | null) => void;
  private submitted = false;

  constructor(app: App, segments: AssistantMessageSegment[], defaultSelection: string[], onSubmit: (result: string[] | null) => void) {
    super(app);
    this.segments = segments;
    this.onSubmit = onSubmit;
    this.selected = new Set(defaultSelection);
    if (!this.selected.size && segments.length) {
      this.selected.add(segments[segments.length - 1].id);
    }
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('segment-selection-modal');
    contentEl.createEl('h2', { text: '选择要应用的段落' });
    contentEl.createEl('p', { text: 'AI 回复包含多个部分，默认只勾选看似是修改稿的段落。' });

    const listEl = contentEl.createDiv({ cls: 'segment-card-list' });

    const syncCheckboxes = () => {
      listEl.querySelectorAll('input[type="checkbox"][data-segment-id]').forEach((node) => {
        const input = node as HTMLInputElement;
        const id = input.dataset.segmentId || '';
        input.checked = this.selected.has(id);
      });
    };

    this.segments.forEach((segment) => {
      const card = listEl.createDiv({ cls: `segment-card segment-type-${segment.type}` });
      const header = card.createDiv({ cls: 'segment-card-header' });
      const checkbox = header.createEl('input', { type: 'checkbox' }) as HTMLInputElement;
      checkbox.dataset.segmentId = segment.id;
      checkbox.checked = this.selected.has(segment.id);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) this.selected.add(segment.id);
        else this.selected.delete(segment.id);
      });

      header.createDiv({ cls: 'segment-card-title', text: segment.title });
      header.createDiv({ cls: 'segment-card-tag', text: this.describeType(segment.type) });

      card.createDiv({ cls: 'segment-card-snippet', text: segment.snippet });

      const details = card.createEl('details', { cls: 'segment-card-details' });
      details.createEl('summary', { text: '展开/收起预览' });
      details.createEl('pre', { text: segment.body });
    });

    const footer = contentEl.createDiv({ cls: 'segment-selection-footer' });
    const selectAllBtn = footer.createEl('button', { text: '全选', cls: 'ghost' });
    const clearBtn = footer.createEl('button', { text: '全不选', cls: 'ghost' });
    const confirmBtn = footer.createEl('button', { text: '继续', cls: 'primary' });
    const cancelBtn = footer.createEl('button', { text: '取消', cls: 'ghost' });

    selectAllBtn.addEventListener('click', () => {
      this.selected = new Set(this.segments.map(seg => seg.id));
      syncCheckboxes();
    });

    clearBtn.addEventListener('click', () => {
      this.selected.clear();
      syncCheckboxes();
    });

    confirmBtn.addEventListener('click', () => {
      if (!this.selected.size) {
        new Notice('请至少选择一个段落');
        return;
      }
      this.closeWithResult(Array.from(this.selected));
    });

    cancelBtn.addEventListener('click', () => {
      this.closeWithResult(null);
    });
  }

  private describeType(type: AssistantSegmentType): string {
    switch (type) {
      case 'preface': return 'AI 前言';
      case 'modification': return '修改稿';
      case 'reference': return '原文/参考';
      case 'suggestion': return '建议说明';
      default: return '未分类';
    }
  }

  private closeWithResult(result: string[] | null) {
    if (!this.submitted) {
      this.submitted = true;
      this.onSubmit(result);
    }
    this.close();
  }

  onClose() {
    if (!this.submitted) {
      this.onSubmit(null);
    }
    this.contentEl.empty();
  }
}

// 新增：笔记修改预览对话框
export class NoteModificationModal extends Modal {
  file: TFile;
  oldContent: string;
  newContent: string;
  onSubmit: (apply: boolean) => void;

  constructor(app: App, file: TFile, oldContent: string, newContent: string, onSubmit: (apply: boolean) => void) {
    super(app);
    this.file = file;
    this.oldContent = oldContent;
    this.newContent = newContent;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: `修改笔记: ${this.file.basename}` });

    // 创建一个对比视图
    const comparisonContainer = contentEl.createDiv({ cls: "note-modification-comparison" });

    // 原始内容
    const oldSection = comparisonContainer.createDiv({ cls: "comparison-section" });
    oldSection.createEl("h3", { text: "原始内容" });
    const oldDiv = oldSection.createDiv({ cls: "comparison-content old-content" });
    oldDiv.createEl("pre", { text: this.oldContent });

    // 新内容
    const newSection = comparisonContainer.createDiv({ cls: "comparison-section" });
    newSection.createEl("h3", { text: "新内容" });
    const newDiv = newSection.createDiv({ cls: "comparison-content new-content" });
    newDiv.createEl("pre", { text: this.newContent });

    // 按钮组
    const buttonGroup = contentEl.createDiv({ cls: "button-group" });
    buttonGroup.createEl("button", { text: "应用修改" }).addEventListener("click", () => {
      this.onSubmit(true);
      this.close();
    });

    buttonGroup.createEl("button", { text: "取消" }).addEventListener("click", () => {
      this.onSubmit(false);
      this.close();
    });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

// 新增：笔记标题输入对话框
export class NoteTitleInputModal extends Modal {
  prompt: string;
  onSubmit: (name: string | null) => void;
  inputValue: string = "";

  constructor(app: App, prompt: string, onSubmit: (name: string | null) => void) {
    super(app);
    this.prompt = prompt;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: this.prompt });

    // 输入框
    const inputEl = contentEl.createEl("input", {
      type: "text",
      placeholder: "输入笔记名称（不包括.md扩展名）"
    }) as HTMLInputElement;
    inputEl.setCssStyles({ width: "100%" });
    inputEl.setCssStyles({ padding: "8px" });
    inputEl.setCssStyles({ marginBottom: "16px" });
    inputEl.focus();

    // 按钮组
    const buttonGroup = contentEl.createDiv({ cls: "button-group" });
    buttonGroup.createEl("button", { text: "确定" }).addEventListener("click", () => {
      const name = inputEl.value.trim();
      if (!name) {
        new Notice("请输入笔记名称");
        return;
      }
      this.onSubmit(name);
      this.close();
    });

    buttonGroup.createEl("button", { text: "取消" }).addEventListener("click", () => {
      this.onSubmit(null);
      this.close();
    });

    // 回车提交
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const name = inputEl.value.trim();
        if (!name) {
          new Notice("请输入笔记名称");
          return;
        }
        this.onSubmit(name);
        this.close();
      }
    });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

export class DiffReviewModal extends Modal {
  private file: TFile;
  private hunks: UiDiffHunk[];
  private onSubmit: (selected: number[] | null) => void;
  private submitted = false;

  constructor(app: App, file: TFile, hunks: UiDiffHunk[], onSubmit: (selected: number[] | null) => void) {
    super(app);
    this.file = file;
    this.hunks = hunks;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('diff-review-modal');
    contentEl.createEl('h2', { text: `审阅修改: ${this.file.basename}` });
    contentEl.createEl('p', { text: `共 ${this.hunks.length} 处差异，选择需要应用的修改。` });

    const listEl = contentEl.createDiv({ cls: 'diff-hunk-list' });

    this.hunks.forEach((hunk) => {
      const card = listEl.createDiv({ cls: 'diff-hunk-card' });
      const header = card.createDiv({ cls: 'diff-hunk-card-header' });
      const checkbox = header.createEl('input', { type: 'checkbox' }) as HTMLInputElement;
      checkbox.dataset.hunkIndex = String(hunk.index);
      checkbox.checked = true;
      header.createDiv({ cls: 'diff-hunk-title', text: hunk.header });
      header.createDiv({ cls: 'diff-hunk-meta', text: `段落 ${hunk.index + 1}` });
      const foldBtn = header.createEl('button', { text: '折叠', cls: 'diff-hunk-fold' });

      const body = card.createDiv({ cls: 'diff-hunk-body' });
      hunk.lines.forEach((line) => {
        const row = body.createDiv({ cls: `diff-line diff-line-${line.sign === '+' ? 'add' : line.sign === '-' ? 'del' : 'ctx'}` });
        row.createDiv({ cls: 'diff-line-num old', text: line.oldNumber !== undefined ? String(line.oldNumber) : '' });
        row.createDiv({ cls: 'diff-line-num new', text: line.newNumber !== undefined ? String(line.newNumber) : '' });
        row.createDiv({ cls: 'diff-line-text', text: `${line.sign} ${line.text}` });
      });

      foldBtn.addEventListener('click', () => {
        const collapsed = body.hasClass('collapsed');
        body.toggleClass('collapsed', !collapsed);
        foldBtn.setText(collapsed ? '折叠' : '展开');
      });
    });

    const footer = contentEl.createDiv({ cls: 'diff-review-footer' });
    const applySelectedBtn = footer.createEl('button', { text: '应用选中' });
    const applyAllBtn = footer.createEl('button', { text: '全部应用' });
    const cancelBtn = footer.createEl('button', { text: '取消', cls: 'ghost' });

    applySelectedBtn.addEventListener('click', () => {
      const selected = this.collectSelected(listEl);
      this.closeWithResult(selected);
    });

    applyAllBtn.addEventListener('click', () => {
      const all = this.hunks.map(h => h.index);
      this.closeWithResult(all);
    });

    cancelBtn.addEventListener('click', () => {
      this.closeWithResult(null);
    });
  }

  private collectSelected(container: HTMLElement): number[] {
    const selected: number[] = [];
    container.querySelectorAll('input[type="checkbox"][data-hunk-index]').forEach((el) => {
      const input = el as HTMLInputElement;
      if (input.checked) selected.push(Number(input.dataset.hunkIndex));
    });
    return selected;
  }

  private closeWithResult(result: number[] | null) {
    if (!this.submitted) {
      this.submitted = true;
      this.onSubmit(result);
    }
    this.close();
  }

  onClose() {
    if (!this.submitted) {
      this.onSubmit(null);
    }
    this.contentEl.empty();
  }
}

// 冲突处理模态
export class ConflictModal extends Modal {
  file: TFile;
  currentContent: string;
  finalContent: string;
  onChoice: (choice: 'open' | 'backup' | 'cancel') => void;

  constructor(app: App, file: TFile, currentContent: string, finalContent: string, onChoice: (choice: 'open' | 'backup' | 'cancel') => void) {
    super(app);
    this.file = file;
    this.currentContent = currentContent;
    this.finalContent = finalContent;
    this.onChoice = onChoice;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: `检测到外部修改: ${this.file.basename}` });
    contentEl.createEl('p', { text: '在你审阅期间，目标笔记已经被外部修改。请选择如何处理：' });

    const btns = contentEl.createDiv({ cls: 'button-group' });
    btns.createEl('button', { text: '打开笔记并手动合并' }).addEventListener('click', () => {
      this.onChoice('open');
      this.close();
    });

    btns.createEl('button', { text: '备份当前并覆盖' }).addEventListener('click', () => {
      this.onChoice('backup');
      this.close();
    });

    btns.createEl('button', { text: '取消' }).addEventListener('click', () => {
      this.onChoice('cancel');
      this.close();
    });
  }

  onClose() { this.contentEl.empty(); }
}
