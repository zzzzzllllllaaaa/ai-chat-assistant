import { ItemView, WorkspaceLeaf, Notice, TFile, MarkdownView } from "obsidian";
import type { IPluginContext } from "../../core/plugin-context";;
import { logger } from "../../core/logger";

export const VIEW_TYPE_SMART_CONTEXT = "ai-chat-smart-context";

export class SmartContextView extends ItemView {
  plugin: IPluginContext;
  container!: HTMLElement;
  debounceTimer: number | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: IPluginContext) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE_SMART_CONTEXT;
  }

  getDisplayText() {
    return "Smart Context";
  }

  getIcon() {
    return "lightbulb";
  }

  async onOpen() {
    this.container = this.contentEl;
    this.container.empty();
    this.container.createEl("h4", { text: "Smart Context (被动感知)" });
    this.container.createEl("p", { text: "正在监听编辑器...", cls: "text-muted" });

    // Register event listener
    this.registerEvent(
      this.app.workspace.on("editor-change", (editor, info) => {
        if (!this.plugin.settings.enableSmartContext) return;
        
        if (this.debounceTimer) window.clearTimeout(this.debounceTimer);
        this.debounceTimer = window.setTimeout(() => {
          this.updateContext(editor);
        }, 3000); // 3s debounce
      })
    );
    
    // Initial update
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView) {
        this.updateContext(activeView.editor);
    }
  }

  async updateContext(editor: any) {
    if (!this.plugin.settings.enableSmartContext) return;

    const cursor = editor.getCursor();
    const lineText = editor.getLine(cursor.line);
    
    // Only search if line has meaningful content
    if (lineText.trim().length < 5) return;

    // Get surrounding context (e.g. 3 lines)
    const startLine = Math.max(0, cursor.line - 1);
    const endLine = Math.min(editor.lineCount() - 1, cursor.line + 1);
    const contextText = editor.getRange({ line: startLine, ch: 0 }, { line: endLine, ch: 0 });

    this.container.empty();
    this.container.createEl("h4", { text: "Smart Context" });
    const loadingEl = this.container.createEl("div", { text: "正在分析...", cls: "text-muted" });

    try {
        // Use vector search (or keyword search)
        // We reuse KnowledgeRetriever but maybe with a lighter weight method?
        // For now, let's use the standard search but limit count
        
        // We need a vector for the contextText
        // This might be expensive if we do it too often. 
        // Ideally we should use a local lightweight embedding or just keyword search.
        // Let's try keyword search first if no vector available, or just use the retriever.
        
        // To avoid heavy computation, let's just use keyword extraction + search for now?
        // Or if we have vector index, use it.
        
        // Let's assume we use the standard retriever which handles vector generation
        const embeddingModel = this.plugin.settings.embeddingModel;
        // Note: This calls API. Be careful with cost.
        // Maybe we should only do this if Local LLM is enabled or user explicitly allows?
        // For now, we proceed.
        
        // Generate vector for query
        // const { getEmbedding } = require("./api"); // Lazy import to avoid circular dep issues if any
        // const queryVector = await getEmbedding(contextText, this.plugin.settings);
        
        const results = await this.plugin.ragService.search(contextText, 5);
        
        loadingEl.remove();
        
        if (results.length === 0) {
            this.container.createEl("div", { text: "暂无相关笔记。", cls: "text-muted" });
            return;
        }

        const list = this.container.createEl("div", { cls: "smart-context-list" });
        
        results.forEach((res: any) => {
            // Skip current file
            const activeFile = this.app.workspace.getActiveFile();
            if (activeFile && res.path === activeFile.path) return;

            const item = list.createDiv({ cls: "smart-context-item" });
            item.setCssStyles({ padding: "8px" });
            item.setCssStyles({ borderBottom: "1px solid var(--background-modifier-border)" });
            item.setCssStyles({ cursor: "pointer" });
            
            const title = item.createEl("div", { text: res.file ? res.file.basename : res.path, cls: "smart-context-title" });
            title.setCssStyles({ fontWeight: "bold" });
            
            const score = item.createEl("div", { text: `相关度: ${(res.similarity * 100).toFixed(0)}%`, cls: "text-muted" });
            score.setCssStyles({ fontSize: "0.8em" });
            
            // Preview snippet
            if (res.file) {
                this.app.vault.cachedRead(res.file).then(content => {
                    const snippet = content.slice(0, 100).replace(/\n/g, " ") + "...";
                    item.createEl("div", { text: snippet, cls: "text-muted", attr: { style: "font-size: 0.85em; margin-top: 4px;" } });
                });
            }

            item.addEventListener("click", () => {
                this.app.workspace.openLinkText(res.path, "", true);
            });
        });

    } catch (e) {
        loadingEl.setText("分析出错");
      logger.error("UI", "Smart context analysis failed", e);
    }
  }

  async onClose() {
    // Cleanup
  }
}
