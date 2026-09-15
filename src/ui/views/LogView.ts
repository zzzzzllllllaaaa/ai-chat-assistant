import { ItemView, WorkspaceLeaf, setIcon, Menu, Notice } from "obsidian";
import { logger, LogEntry, LogLevel } from "../../core/logger";
import { safeNotice } from "../../utils/notice";

export const VIEW_TYPE_LOG = "ai-chat-log-view";

export class LogView extends ItemView {
    private logContainer!: HTMLElement;
    private autoScroll: boolean = true;
    private filterLevel: LogLevel | 'ALL' = 'ALL';
    private logListener! : (entry: LogEntry) => void;

    constructor(leaf: WorkspaceLeaf) {
        super(leaf);
    }

    private getPluginInstance(): any {
        try {
            return (this.app as any)?.plugins?.getPlugin?.("ai-chat-assistant");
        } catch {
            return null;
        }
    }

    private formatLogEntryForCopy(entry: LogEntry): string {
        const ts = entry.timestamp instanceof Date
            ? entry.timestamp.toISOString()
            : new Date(entry.timestamp as any).toISOString();

        const parts: string[] = [];
        parts.push(`[${ts}] [${entry.level}] [${entry.category}] ${entry.message}`);

        if (entry.details) {
            parts.push(`details:\n${entry.details}`);
        }

        if (entry.context !== undefined) {
            try {
                parts.push(`context:\n${JSON.stringify(entry.context, null, 2)}`);
            } catch {
                parts.push(`context:\n[unserializable] ${String(entry.context)}`);
            }
        }

        return parts.join("\n") + "\n";
    }

    private getVisibleLogs(): LogEntry[] {
        const logs = logger.getLogs();
        if (this.filterLevel === 'ALL') return logs;
        return logs.filter(l => l.level === this.filterLevel);
    }

    private async copyTextToClipboard(text: string): Promise<boolean> {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            // Fallback for environments where clipboard API is not available
            try {
                const textarea = document.createElement('textarea');
                textarea.value = text;
                textarea.style.position = 'fixed';
                textarea.style.left = '-9999px';
                textarea.style.top = '0';
                document.body.appendChild(textarea);
                textarea.focus();
                textarea.select();
                const ok = document.execCommand('copy');
                document.body.removeChild(textarea);
                return ok;
            } catch {
                return false;
            }
        }
    }

    getViewType(): string {
        return VIEW_TYPE_LOG;
    }

    getDisplayText(): string {
        return "AI 助手日志";
    }

    getIcon(): string {
        return "bug";
    }

    async onOpen() {
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        container.addClass("ai-chat-log-view-container");
        container.style.display = "flex";
        container.style.flexDirection = "column";
        container.style.height = "100%";
        container.style.padding = "0";

        // 1. Toolbar
        const toolbar = container.createDiv({ cls: "nav-header" });
        toolbar.style.padding = "8px";
        toolbar.style.borderBottom = "1px solid var(--background-modifier-border)";
        toolbar.style.display = "flex";
        toolbar.style.justifyContent = "space-between";
        toolbar.style.alignItems = "center";
        toolbar.style.flexShrink = "0";

        const leftTools = toolbar.createDiv({ cls: "nav-buttons-container" });
        leftTools.style.display = "flex";
        leftTools.style.gap = "4px";

        // Clear Button
        const clearBtn = leftTools.createEl("div", { cls: "clickable-icon nav-action-button", attr: { "aria-label": "清空日志" } });
        setIcon(clearBtn, "trash-2");
        clearBtn.addEventListener("click", () => {
            logger.clearLogs();
            this.renderLogs();
        });

        // Copy Button
        const copyBtn = leftTools.createEl("div", { cls: "clickable-icon nav-action-button", attr: { "aria-label": "复制全部（含详情）" } });
        setIcon(copyBtn, "copy");
        copyBtn.addEventListener("click", async () => {
            const logs = this.getVisibleLogs();
            const text = logs.map(l => this.formatLogEntryForCopy(l)).join("\n---\n");
            const ok = await this.copyTextToClipboard(text);
            if (ok) safeNotice(`已复制 ${logs.length} 条日志（含详情）`);
            else new Notice("复制失败：系统剪贴板不可用");
        });

        // Retry last MCP call
        const retryMcpBtn = leftTools.createEl("div", { cls: "clickable-icon nav-action-button", attr: { "aria-label": "重试上一次 MCP 调用" } });
        setIcon(retryMcpBtn, "rotate-ccw");
        retryMcpBtn.addEventListener("click", async () => {
            const plugin = this.getPluginInstance();
            const last = plugin?.lastMcpCall;
            if (!last || !last.toolName) {
                new Notice("暂无可重试的 MCP 调用记录", 4000);
                return;
            }

            const tool = plugin?.agentManager?.getTool?.("mcp_call_tool");
            if (!tool) {
                new Notice("未找到工具：mcp_call_tool", 4000);
                return;
            }

            const args = {
                provider: last.provider,
                toolName: last.toolName,
                args: last.args ?? {},
            };

            safeNotice(`正在重试 MCP 调用：${args.toolName}（${args.provider}）...`, 4000);
            logger.log(LogLevel.INFO, 'AI', 'Retry MCP tool call', { ...args });

            try {
                const out = await tool.execute(args, this.app);
                const outStr = String(out || "");
                const ok = !outStr.startsWith("错误:") && !outStr.startsWith("已取消:");

                logger.log(
                    ok ? LogLevel.INFO : LogLevel.WARN,
                    'AI',
                    ok ? 'Retry MCP tool call success' : 'Retry MCP tool call returned error',
                    { ...args },
                    outStr.slice(0, 20000)
                );

                new Notice(ok ? "✅ 重试成功（详情见日志）" : "⚠️ 重试未成功（详情见日志）", 6000);
                this.renderLogs();
            } catch (e: any) {
                logger.log(LogLevel.ERROR, 'AI', 'Retry MCP tool call failed', { ...args }, e?.message || String(e));
                    safeNotice(`❌ 重试失败：${e?.message || String(e)}`, 8000);
                this.renderLogs();
            }
        });

        // Filter Button
        const filterBtn = leftTools.createEl("div", { cls: "clickable-icon nav-action-button", attr: { "aria-label": "过滤级别" } });
        setIcon(filterBtn, "filter");
        filterBtn.addEventListener("click", (e) => {
            const menu = new Menu();
            ['ALL', 'INFO', 'WARN', 'ERROR', 'DEBUG'].forEach((level) => {
                menu.addItem((item) => {
                    item.setTitle(level)
                        .setChecked(this.filterLevel === level)
                        .onClick(() => {
                            this.filterLevel = level as LogLevel | 'ALL';
                            this.renderLogs();
                        });
                });
            });
            menu.showAtMouseEvent(e);
        });

        const rightTools = toolbar.createDiv();
        
        // Auto-scroll Toggle
        const scrollBtn = rightTools.createEl("div", { cls: "clickable-icon nav-action-button", attr: { "aria-label": "自动滚动" } });
        setIcon(scrollBtn, this.autoScroll ? "arrow-down-circle" : "pause-circle");
        if (this.autoScroll) scrollBtn.style.color = "var(--interactive-accent)";
        
        scrollBtn.addEventListener("click", () => {
            this.autoScroll = !this.autoScroll;
            setIcon(scrollBtn, this.autoScroll ? "arrow-down-circle" : "pause-circle");
            scrollBtn.style.color = this.autoScroll ? "var(--interactive-accent)" : "";
        });

        // 2. Log Container
        this.logContainer = container.createDiv({ cls: "ai-chat-log-list" });
        this.logContainer.style.flexGrow = "1";
        this.logContainer.style.overflowY = "auto";
        this.logContainer.style.padding = "10px";
        this.logContainer.style.fontFamily = "var(--font-monospace)";
        this.logContainer.style.fontSize = "12px";
        this.logContainer.style.userSelect = "text";

        // Initial Render
        this.renderLogs();

        // Subscribe to updates
        this.logListener = (entry) => {
            if (this.filterLevel !== 'ALL' && entry.level !== this.filterLevel) return;
            this.appendLogEntry(entry);
            if (this.autoScroll) {
                this.logContainer.scrollTop = this.logContainer.scrollHeight;
            }
        };
        logger.addListener(this.logListener);
    }

    async onClose() {
        if (this.logListener) {
            logger.removeListener(this.logListener);
        }
    }

    private renderLogs() {
        this.logContainer.empty();
        const logs = logger.getLogs();
        logs.forEach(entry => {
            if (this.filterLevel !== 'ALL' && entry.level !== this.filterLevel) return;
            this.appendLogEntry(entry);
        });
        if (this.autoScroll) {
            this.logContainer.scrollTop = this.logContainer.scrollHeight;
        }
    }

    private appendLogEntry(entry: LogEntry) {
        const row = this.logContainer.createDiv({ cls: "log-row" });
        row.style.marginBottom = "4px";
        row.style.borderBottom = "1px solid var(--background-modifier-border-hover)";
        row.style.paddingBottom = "4px";
        row.style.display = "flex";
        row.style.flexDirection = "column";

        // Header Line: Time | Level | Category
        const headerLine = row.createDiv({ cls: "log-header" });
        headerLine.style.display = "flex";
        headerLine.style.gap = "8px";
        headerLine.style.fontSize = "0.9em";
        headerLine.style.color = "var(--text-muted)";

        const timeStr = entry.timestamp.toLocaleTimeString();
        headerLine.createSpan({ text: timeStr });

        const levelSpan = headerLine.createSpan({ text: entry.level });
        levelSpan.style.fontWeight = "bold";
        if (entry.level === LogLevel.ERROR) levelSpan.style.color = "var(--text-error)";
        else if (entry.level === LogLevel.WARN) levelSpan.style.color = "var(--text-warning)";
        else if (entry.level === LogLevel.DEBUG) levelSpan.style.color = "var(--text-faint)";
        else levelSpan.style.color = "var(--text-accent)";

        headerLine.createSpan({ text: `[${entry.category}]` });

        const rowActions = headerLine.createDiv({ cls: "log-row-actions" });
        rowActions.style.marginLeft = "auto";
        rowActions.style.display = "flex";
        rowActions.style.gap = "6px";

        const copyOneBtn = rowActions.createEl("button", { text: "复制", cls: "log-copy-btn" });
        copyOneBtn.style.fontSize = "0.8em";
        copyOneBtn.style.padding = "1px 6px";
        copyOneBtn.style.background = "transparent";
        copyOneBtn.style.border = "1px solid var(--background-modifier-border)";
        copyOneBtn.style.cursor = "pointer";
        copyOneBtn.addEventListener("click", async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const ok = await this.copyTextToClipboard(this.formatLogEntryForCopy(entry));
            if (ok) new Notice("已复制该条日志（含详情）");
            else new Notice("复制失败：系统剪贴板不可用");
        });

        // Message Line
        const msgDiv = row.createDiv({ cls: "log-message", text: entry.message });
        msgDiv.style.whiteSpace = "pre-wrap";
        msgDiv.style.wordBreak = "break-all";

        // Context/Details (Collapsible)
        if (entry.context || entry.details) {
            const detailsBtn = row.createEl("button", { text: "查看详情", cls: "log-details-btn" });
            detailsBtn.style.fontSize = "0.8em";
            detailsBtn.style.padding = "2px 6px";
            detailsBtn.style.marginTop = "4px";
            detailsBtn.style.width = "fit-content";
            detailsBtn.style.background = "transparent";
            detailsBtn.style.border = "1px solid var(--background-modifier-border)";
            detailsBtn.style.cursor = "pointer";

            const detailsArea = row.createDiv({ cls: "log-details-area" });
            detailsArea.style.display = "none";
            detailsArea.style.marginTop = "4px";
            detailsArea.style.backgroundColor = "var(--background-secondary)";
            detailsArea.style.padding = "8px";
            detailsArea.style.borderRadius = "4px";
            detailsArea.style.fontSize = "0.9em";

            if (entry.details) {
                const d = detailsArea.createDiv({ text: entry.details });
                d.style.marginBottom = "8px";
                d.style.color = "var(--text-normal)";
            }
            
            if (entry.context) {
                const p = detailsArea.createEl("pre", { text: JSON.stringify(entry.context, null, 2) });
                p.style.margin = "0";
            }

            detailsBtn.addEventListener("click", () => {
                if (detailsArea.style.display === "none") {
                    detailsArea.style.display = "block";
                    detailsBtn.setText("收起详情");
                } else {
                    detailsArea.style.display = "none";
                    detailsBtn.setText("查看详情");
                }
            });
        }
    }
}
