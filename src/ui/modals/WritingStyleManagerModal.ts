/**
 * 文风管理模态框
 * 独立的文风库管理，可保存、编辑、删除文风，供角色卡复用
 */

import { Modal, App, Setting, TextAreaComponent, Notice, ButtonComponent } from "obsidian";
import type { IPluginContext } from "../../core/plugin-context";;
import { SavedWritingStyle } from "../../core/settings";
import { buildStyleAnalysisPrompt, parseStyleAnalysisResponse, WRITING_STYLE_PRESETS } from "../../features/character/WritingStyleAnalyzer";

export class WritingStyleManagerModal extends Modal {
  private plugin: IPluginContext;
  private styles: SavedWritingStyle[];
  private selectedStyleId: string | null = null;
  private onSelect?: (style: SavedWritingStyle) => void;
  private selectMode: boolean;

  constructor(app: App, plugin: IPluginContext, options?: { selectMode?: boolean; onSelect?: (style: SavedWritingStyle) => void }) {
    super(app);
    this.plugin = plugin;
    this.styles = [...(plugin.settings.savedWritingStyles || [])];
    this.selectMode = options?.selectMode || false;
    this.onSelect = options?.onSelect;
  }

  onOpen() {
    // 每次打开时刷新数据，确保获取最新的文风列表
    this.styles = [...(this.plugin.settings.savedWritingStyles || [])];
    
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("writing-style-manager-modal");

    contentEl.createEl("h2", { text: this.selectMode ? "选择文风" : "文风库管理" });

    if (!this.selectMode) {
      // 添加新文风按钮
      const headerRow = contentEl.createDiv({ cls: "writing-style-header" });
      
      new ButtonComponent(headerRow)
        .setButtonText("+ 新建文风")
        .setCta()
        .onClick(() => this.createNewStyle());

      new ButtonComponent(headerRow)
        .setButtonText("从预设创建")
        .onClick(() => this.createFromPreset());
    }

    // 文风列表
    const listContainer = contentEl.createDiv({ cls: "writing-style-list" });
    this.renderStyleList(listContainer);

    // 详情/编辑区域
    const detailContainer = contentEl.createDiv({ cls: "writing-style-detail" });
    if (this.selectedStyleId) {
      this.renderStyleDetail(detailContainer);
    } else {
      detailContainer.createEl("p", { 
        text: this.styles.length > 0 ? "请选择一个文风查看详情" : "暂无保存的文风，点击上方按钮创建",
        cls: "writing-style-hint"
      });
    }
  }

  private renderStyleList(container: HTMLElement) {
    container.empty();

    if (this.styles.length === 0) {
      container.createEl("p", { text: "暂无保存的文风", cls: "writing-style-empty" });
      return;
    }

    for (const style of this.styles) {
      const item = container.createDiv({ 
        cls: `writing-style-item ${style.id === this.selectedStyleId ? 'is-selected' : ''}` 
      });
      
      const info = item.createDiv({ cls: "writing-style-item-info" });
      info.createEl("div", { text: style.name, cls: "writing-style-item-name" });
      if (style.description) {
        info.createEl("div", { text: style.description, cls: "writing-style-item-desc" });
      }
      
      item.addEventListener("click", () => {
        this.selectedStyleId = style.id;
        this.onOpen(); // 刷新
      });

      if (this.selectMode && this.onSelect) {
        const selectBtn = item.createEl("button", { text: "选择", cls: "writing-style-select-btn" });
        selectBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.onSelect!(style);
          this.close();
        });
      }
    }
  }

  private renderStyleDetail(container: HTMLElement) {
    container.empty();
    
    const style = this.styles.find(s => s.id === this.selectedStyleId);
    if (!style) return;

    container.createEl("h3", { text: style.name });

    // 文风描述
    new Setting(container)
      .setName("文风描述")
      .setDesc("将注入到 AI 提示词中");
    
    const descTextarea = new TextAreaComponent(container);
    descTextarea.inputEl.addClass("writing-style-textarea");
    descTextarea.setValue(style.styleDescription || "");
    descTextarea.onChange(value => {
      style.styleDescription = value;
      style.updatedAt = Date.now();
    });

    // 维度参数
    if (style.dimensions) {
      const dimensionsEl = container.createDiv({ cls: "writing-style-dimensions" });
      dimensionsEl.createEl("h4", { text: "文风维度" });
      
      const dims = style.dimensions;
      this.renderDimensionSlider(dimensionsEl, "信息密度", dims.informationDensity || 5, (v) => { dims.informationDensity = v; style.updatedAt = Date.now(); });
      this.renderDimensionSlider(dimensionsEl, "情感强度", dims.emotionalIntensity || 5, (v) => { dims.emotionalIntensity = v; style.updatedAt = Date.now(); });
      this.renderDimensionSlider(dimensionsEl, "叙事节奏", dims.narrativePace || 5, (v) => { dims.narrativePace = v; style.updatedAt = Date.now(); });
      this.renderDimensionSlider(dimensionsEl, "修辞程度", dims.rhetoricalLevel || 5, (v) => { dims.rhetoricalLevel = v; style.updatedAt = Date.now(); });
      this.renderDimensionSlider(dimensionsEl, "口语化", dims.colloquialLevel || 5, (v) => { dims.colloquialLevel = v; style.updatedAt = Date.now(); });
      this.renderDimensionSlider(dimensionsEl, "细节描写", dims.detailLevel || 5, (v) => { dims.detailLevel = v; style.updatedAt = Date.now(); });
    }

    // 额外指令
    new Setting(container)
      .setName("额外指令")
      .setDesc("补充的特定要求");
    
    const instrTextarea = new TextAreaComponent(container);
    instrTextarea.inputEl.addClass("writing-style-textarea-small");
    instrTextarea.setValue(style.customInstructions || "");
    instrTextarea.onChange(value => {
      style.customInstructions = value;
      style.updatedAt = Date.now();
    });

    // 样本文本
    if (style.sampleText) {
      const sampleEl = container.createDiv({ cls: "writing-style-sample" });
      sampleEl.createEl("h4", { text: "参考样本" });
      sampleEl.createEl("pre", { text: style.sampleText.slice(0, 500) + (style.sampleText.length > 500 ? '...' : '') });
    }

    // 元信息
    const metaEl = container.createDiv({ cls: "writing-style-meta" });
    if (style.analyzedBy) {
      metaEl.createEl("span", { text: `分析模型: ${style.analyzedBy}` });
    }
    metaEl.createEl("span", { text: `更新于: ${new Date(style.updatedAt).toLocaleString()}` });

    // 操作按钮
    const actionsEl = container.createDiv({ cls: "writing-style-actions" });
    
    if (!this.selectMode) {
      new ButtonComponent(actionsEl)
        .setButtonText("保存")
        .setCta()
        .onClick(() => this.saveStyles());

      new ButtonComponent(actionsEl)
        .setButtonText("重新分析")
        .onClick(() => this.reanalyzeStyle(style));

      new ButtonComponent(actionsEl)
        .setButtonText("重命名")
        .onClick(() => this.renameStyle(style));

      new ButtonComponent(actionsEl)
        .setButtonText("删除")
        .setWarning()
        .onClick(() => this.deleteStyle(style));
    }

    if (this.selectMode && this.onSelect) {
      new ButtonComponent(actionsEl)
        .setButtonText("选择此文风")
        .setCta()
        .onClick(() => {
          this.onSelect!(style);
          this.close();
        });
    }
  }

  private renderDimensionSlider(container: HTMLElement, label: string, value: number, onChange: (v: number) => void) {
    const row = container.createDiv({ cls: "writing-style-dim-row" });
    row.createEl("span", { text: label, cls: "writing-style-dim-label" });
    
    const slider = row.createEl("input", { type: "range" }) as HTMLInputElement;
    slider.min = "1";
    slider.max = "10";
    slider.value = String(value);
    slider.classList.add("writing-style-dim-slider");
    
    const valueEl = row.createEl("span", { text: String(value), cls: "writing-style-dim-value" });
    
    slider.addEventListener("input", () => {
      const v = parseInt(slider.value);
      valueEl.textContent = String(v);
      onChange(v);
    });
  }

  private async createNewStyle() {
    const style: SavedWritingStyle = {
      id: `style-${Date.now()}`,
      name: "新文风",
      description: "",
      styleDescription: "",
      dimensions: {
        informationDensity: 5,
        emotionalIntensity: 5,
        narrativePace: 5,
        rhetoricalLevel: 5,
        colloquialLevel: 5,
        detailLevel: 5,
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    
    this.styles.push(style);
    this.selectedStyleId = style.id;
    await this.saveStyles();
    this.onOpen();
  }

  private async createFromPreset() {
    // 显示预设选择
    const modal = new PresetSelectModal(this.app, async (preset) => {
      const style: SavedWritingStyle = {
        id: `style-${Date.now()}`,
        name: preset.name,
        description: preset.description,
        styleDescription: preset.style.styleDescription || "",
        dimensions: preset.style.dimensions ? { ...preset.style.dimensions } : undefined,
        customInstructions: preset.style.customInstructions,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      
      this.styles.push(style);
      this.selectedStyleId = style.id;
      await this.saveStyles();
      this.onOpen();
    });
    modal.open();
  }

  private async reanalyzeStyle(style: SavedWritingStyle) {
    // 显示输入样本文本的弹窗
    const modal = new SampleTextInputModal(this.app, this.plugin, async (sampleText, result) => {
      style.sampleText = sampleText;
      style.styleDescription = result.styleDescription || style.styleDescription;
      if (result.dimensions) {
        style.dimensions = result.dimensions;
      }
      style.analyzedBy = this.plugin.settings.defaultChatModel || "unknown";
      style.updatedAt = Date.now();
      
      await this.saveStyles();
      this.onOpen();
      new Notice("文风分析完成");
    });
    modal.open();
  }

  private async renameStyle(style: SavedWritingStyle) {
    const newName = await this.promptInput("重命名文风", style.name);
    if (newName && newName !== style.name) {
      style.name = newName;
      style.updatedAt = Date.now();
      await this.saveStyles();
      this.onOpen();
    }
  }

  private async deleteStyle(style: SavedWritingStyle) {
    if (confirm(`确定要删除文风「${style.name}」吗？`)) {
      this.styles = this.styles.filter(s => s.id !== style.id);
      this.selectedStyleId = null;
      await this.saveStyles();
      this.onOpen();
      new Notice("文风已删除");
    }
  }

  private async saveStyles() {
    this.plugin.settings.savedWritingStyles = [...this.styles]; // 确保是新数组
    await this.plugin.saveSettings();
  }

  private promptInput(title: string, defaultValue: string): Promise<string | null> {
    return new Promise(resolve => {
      const modal = new InputModal(this.app, title, defaultValue, resolve);
      modal.open();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

/**
 * 预设选择弹窗
 */
class PresetSelectModal extends Modal {
  private onSelect: (preset: typeof WRITING_STYLE_PRESETS[0]) => void;

  constructor(app: App, onSelect: (preset: typeof WRITING_STYLE_PRESETS[0]) => void) {
    super(app);
    this.onSelect = onSelect;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "选择预设文风" });

    for (const preset of WRITING_STYLE_PRESETS) {
      const item = contentEl.createDiv({ cls: "preset-select-item" });
      item.createEl("div", { text: preset.name, cls: "preset-select-name" });
      item.createEl("div", { text: preset.description, cls: "preset-select-desc" });
      item.addEventListener("click", () => {
        this.onSelect(preset);
        this.close();
      });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

/**
 * 样本文本输入弹窗
 */
class SampleTextInputModal extends Modal {
  private plugin: IPluginContext;
  private onAnalyze: (sampleText: string, result: any) => void;

  constructor(app: App, plugin: IPluginContext, onAnalyze: (sampleText: string, result: any) => void) {
    super(app);
    this.plugin = plugin;
    this.onAnalyze = onAnalyze;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "分析文风" });
    contentEl.createEl("p", { text: "粘贴参考文本，AI 将分析其文风特征" });

    const textarea = new TextAreaComponent(contentEl);
    textarea.inputEl.addClass("sample-text-input");
    textarea.inputEl.rows = 10;
    textarea.setPlaceholder("粘贴 500-2000 字的参考文本...");

    const btnRow = contentEl.createDiv({ cls: "sample-text-buttons" });
    
    new ButtonComponent(btnRow)
      .setButtonText("分析")
      .setCta()
      .onClick(async () => {
        const sampleText = textarea.getValue().trim();
        if (!sampleText || sampleText.length < 100) {
          new Notice("请输入至少 100 字的参考文本");
          return;
        }

        new Notice("正在分析文风...");
        
        try {
          const prompt = buildStyleAnalysisPrompt(sampleText);
          const model = this.plugin.settings.defaultChatModel || this.plugin.settings.chatModels.split(',')[0] || 'gpt-4o-mini';
          const response = await this.plugin.llmService.getCompletion(
            [{ role: 'user', content: prompt }],
            model
          );

          if (!response?.content) {
            new Notice("分析失败：未收到响应");
            return;
          }

          const result = parseStyleAnalysisResponse(response.content);
          if (!result.success) {
            new Notice(`分析失败：${result.error}`);
            return;
          }

          this.onAnalyze(sampleText, result);
          this.close();
        } catch (e) {
          console.error("Style analysis error:", e);
          new Notice(`分析失败：${e}`);
        }
      });

    new ButtonComponent(btnRow)
      .setButtonText("取消")
      .onClick(() => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}

/**
 * 简单输入弹窗
 */
class InputModal extends Modal {
  private title: string;
  private defaultValue: string;
  private onSubmit: (value: string | null) => void;

  constructor(app: App, title: string, defaultValue: string, onSubmit: (value: string | null) => void) {
    super(app);
    this.title = title;
    this.defaultValue = defaultValue;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: this.title });

    const input = contentEl.createEl("input", { type: "text" }) as HTMLInputElement;
    input.value = this.defaultValue;
    input.classList.add("input-modal-input");
    input.focus();

    const btnRow = contentEl.createDiv({ cls: "input-modal-buttons" });
    
    new ButtonComponent(btnRow)
      .setButtonText("确定")
      .setCta()
      .onClick(() => {
        this.onSubmit(input.value);
        this.close();
      });

    new ButtonComponent(btnRow)
      .setButtonText("取消")
      .onClick(() => {
        this.onSubmit(null);
        this.close();
      });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        this.onSubmit(input.value);
        this.close();
      }
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}
