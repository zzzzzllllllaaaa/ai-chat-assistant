import { App, ButtonComponent, Modal } from "obsidian";
import { AgentPermissionScope } from "../../core/settings";

export type ToolPermissionDecision = "once" | "session-target" | "session" | "always-target" | "always-scope" | "deny";

export interface ToolPermissionModalInput {
  toolName: string;
  toolLabel: string;
  scope: AgentPermissionScope;
  risk: "low" | "medium" | "high";
  reason: string;
  argsPreview?: string;
  targetKey?: string;
  targetLabel?: string;
  targetType?: 'path' | 'domain' | 'mcp-server' | 'mcp-tool';
}

export class ToolPermissionModal extends Modal {
  private resolve!: (decision: ToolPermissionDecision) => void;
  private resolved = false;

  constructor(app: App, private input: ToolPermissionModalInput) {
    super(app);
  }

  static openAndWait(app: App, input: ToolPermissionModalInput): Promise<ToolPermissionDecision> {
    return new Promise<ToolPermissionDecision>((resolve) => {
      const modal = new ToolPermissionModal(app, input);
      modal.resolve = resolve;
      modal.open();
    });
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "智能体工具审批" });
    contentEl.createEl("p", {
      text: `智能体准备执行工具：${this.input.toolLabel}`,
    });

    const metaEl = contentEl.createDiv({ cls: "ai-tool-permission-meta" });
    metaEl.createEl("div", { text: `工具名：${this.input.toolName}` });
    metaEl.createEl("div", { text: `权限范围：${this.getScopeLabel(this.input.scope)}` });
    metaEl.createEl("div", { text: `风险等级：${this.getRiskLabel(this.input.risk)}` });
    metaEl.createEl("div", { text: `原因：${this.input.reason}` });
    if (this.input.targetLabel) {
      metaEl.createEl("div", { text: `目标对象：${this.input.targetLabel}` });
    }

    if (this.input.argsPreview) {
      contentEl.createEl("h3", { text: "参数预览" });
      const pre = contentEl.createEl("pre", { cls: "ai-tool-permission-args" });
      pre.setText(this.input.argsPreview);
      pre.setCssStyles({ maxHeight: "240px" });
      pre.setCssStyles({ overflow: "auto" });
      pre.setCssStyles({ whiteSpace: "pre-wrap" });
      pre.setCssStyles({ wordBreak: "break-word" });
    }

    const buttonRow = contentEl.createDiv();
    buttonRow.setCssStyles({ display: "flex" });
    buttonRow.setCssStyles({ gap: "8px" });
    buttonRow.setCssStyles({ flexWrap: "wrap" });
    buttonRow.setCssStyles({ marginTop: "16px" });

    new ButtonComponent(buttonRow)
      .setButtonText("仅这次允许")
      .setCta()
      .onClick(() => this.finish("once"));

    new ButtonComponent(buttonRow)
      .setButtonText("本次会话允许此目标")
      .onClick(() => this.finish("session-target"));

    new ButtonComponent(buttonRow)
      .setButtonText("本次会话允许此范围")
      .onClick(() => this.finish("session"));

    new ButtonComponent(buttonRow)
      .setButtonText(`始终允许此目标`)
      .onClick(() => this.finish("always-target"));

    new ButtonComponent(buttonRow)
      .setButtonText(`始终允许此范围（${this.getScopeLabel(this.input.scope)}）`)
      .onClick(() => this.finish("always-scope"));

    new ButtonComponent(buttonRow)
      .setButtonText("拒绝")
      .onClick(() => this.finish("deny"));
  }

  onClose() {
    if (!this.resolved) {
      this.finish("deny");
      return;
    }
    this.contentEl.empty();
  }

  private finish(decision: ToolPermissionDecision) {
    if (this.resolved) return;
    this.resolved = true;
    try {
      this.resolve(decision);
    } finally {
      this.close();
    }
  }

  private getScopeLabel(scope: AgentPermissionScope): string {
    switch (scope) {
      case "read": return "读文件";
      case "write": return "写文件";
      case "exec": return "命令执行";
      case "network": return "联网访问";
      case "mcp": return "MCP 工具";
      default: return scope;
    }
  }

  private getRiskLabel(risk: "low" | "medium" | "high"): string {
    switch (risk) {
      case "low": return "低";
      case "medium": return "中";
      case "high": return "高";
      default: return risk;
    }
  }
}