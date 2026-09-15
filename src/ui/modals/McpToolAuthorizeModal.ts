import { App, Modal, Setting, Notice, ButtonComponent } from "obsidian";
import type { IPluginContext } from "../../core/plugin-context";;
import { ToolRegistry } from "../../mcp/ToolRegistry";
import { safeNotice } from "../../utils/notice";

type McpProvider = "local" | "dashscope";

export class McpToolAuthorizeModal extends Modal {
  private plugin: IPluginContext;
  private registry: ToolRegistry;
  private provider: McpProvider;
  private toolName: string;

  private resolve!: (enabled: boolean) => void;
  private resolved = false;

  private statusEl!: HTMLElement;
  private listEl!: HTMLElement;

  constructor(app: App, plugin: IPluginContext, provider: McpProvider, toolName: string) {
    super(app);
    this.plugin = plugin;
    this.registry = new ToolRegistry(plugin);
    this.provider = provider;
    this.toolName = toolName;
  }

  static openAndWait(app: App, plugin: IPluginContext, provider: McpProvider, toolName: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const modal = new McpToolAuthorizeModal(app, plugin, provider, toolName);
      modal.resolve = resolve;
      modal.open();
    });
  }

  private finish(enabled: boolean) {
    if (this.resolved) return;
    this.resolved = true;
    try {
      this.resolve(enabled);
    } finally {
      this.close();
    }
  }

  private setStatus(text: string) {
    if (this.statusEl) this.statusEl.setText(text);
  }

  private async refreshTools() {
    this.setStatus("正在刷新工具列表...");
    try {
      await this.registry.refresh(this.provider);
      this.setStatus("刷新完成。请选择开启工具并继续。");
    } catch (e: any) {
      this.setStatus(`刷新失败：${e?.message || String(e)}`);
        safeNotice(`MCP 工具刷新失败：${e?.message || String(e)}`);
    }
    this.renderToolList();
  }

  private async enableAndSave(name: string) {
    this.registry.enableTool(this.provider, name);
    await (this.plugin as any)?.saveSettings?.();
  }

  private renderToolList() {
    if (!this.listEl) return;
    this.listEl.empty();

    const tools = this.registry.getTools(this.provider);
    const hasTarget = tools.some(t => t.name === this.toolName);

    if (tools.length === 0) {
      this.listEl.createEl("div", { text: "暂无缓存的工具列表。请先点击“刷新工具列表”。", cls: "text-muted" });
      return;
    }

    if (!hasTarget) {
      this.listEl.createEl("div", {
        text: `未在列表中找到工具：${this.toolName}。请确认工具名，或先点击“刷新工具列表”。`,
        cls: "text-muted",
      });
    }

    // Put target tool on top if present.
    const ordered = [...tools].sort((a, b) => {
      if (a.name === this.toolName) return -1;
      if (b.name === this.toolName) return 1;
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    // Avoid huge modal; cap list size.
    const max = 60;
    const shown = ordered.slice(0, max);
    if (ordered.length > max) {
      this.listEl.createEl("div", { text: `仅显示前 ${max} 个工具（共 ${ordered.length} 个）。`, cls: "text-muted" });
    }

    for (const t of shown) {
      const row = this.listEl.createDiv({ cls: "ai-mcp-tool-row" });
      new Setting(row)
        .setName(t.name)
        .setDesc(t.description || "")
        .addToggle(toggle =>
          toggle.setValue(Boolean(t.enabled)).onChange(async (value) => {
            // Keep it simple: only support enabling here to avoid surprises.
            if (!value) {
              new Notice("为避免误操作，此窗口仅支持开启工具。请到设置页关闭工具。");
              this.renderToolList();
              return;
            }
            await this.enableAndSave(t.name);
            this.renderToolList();
          })
        );
    }
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "MCP 工具授权" });

    const info = contentEl.createEl("p");
    info.setText(`当前尝试调用的工具未开启：${this.toolName}（provider: ${this.provider}）。\n你可以刷新工具列表、开启该工具，然后一键继续。`);

    this.statusEl = contentEl.createDiv({ cls: "text-muted" });
    this.statusEl.style.marginBottom = "8px";
    this.setStatus("请选择操作。")

    const controls = contentEl.createDiv();
    controls.style.display = "flex";
    controls.style.gap = "8px";
    controls.style.marginBottom = "12px";

    new ButtonComponent(controls)
      .setButtonText("刷新工具列表")
      .onClick(() => this.refreshTools());

    new ButtonComponent(controls)
      .setButtonText(`开启并继续（${this.toolName}）`)
      .setCta()
      .onClick(async () => {
        // If tool is not in cache, try refresh once before failing.
        if (!this.registry.hasTool(this.provider, this.toolName)) {
          await this.refreshTools();
        }
        if (!this.registry.hasTool(this.provider, this.toolName)) {
          new Notice("仍未找到该工具：请确认工具名是否正确。");
          return;
        }
        await this.enableAndSave(this.toolName);
        this.finish(true);
      });

    new ButtonComponent(controls)
      .setButtonText("取消")
      .onClick(() => this.finish(false));

    this.listEl = contentEl.createDiv();
    this.listEl.style.maxHeight = "420px";
    this.listEl.style.overflowY = "auto";
    this.listEl.style.border = "1px solid var(--background-modifier-border)";
    this.listEl.style.borderRadius = "6px";
    this.listEl.style.padding = "8px";

    this.renderToolList();
  }

  onClose() {
    if (!this.resolved) {
      this.finish(false);
      return;
    }
    this.contentEl.empty();
  }
}
