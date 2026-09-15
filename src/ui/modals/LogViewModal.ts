import { App, Modal, ButtonComponent, setIcon } from "obsidian";
import { logger, LogLevel } from "../../core/logger";

export class LogViewModal extends Modal {
    private logContainer!: HTMLElement;

    constructor(app: App) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("ai-chat-log-modal");
        
        // Header
        const header = contentEl.createDiv({ cls: "modal-header" });
        header.style.display = "flex";
        header.style.justifyContent = "space-between";
        header.style.alignItems = "center";
        header.style.marginBottom = "15px";
        
        const title = header.createEl("h2", { text: "插件运行日志" });
        title.style.margin = "0";

        // Controls
        const controls = header.createDiv({ cls: "log-controls" });
        controls.style.display = "flex";
        controls.style.gap = "10px";

        new ButtonComponent(controls)
            .setButtonText("刷新")
            .onClick(() => this.renderLogs());
        
        new ButtonComponent(controls)
            .setButtonText("复制全部")
            .onClick(() => {
                const text = logger.getLogs().map(l => `[${l.timestamp.toISOString()}] [${l.level}] ${l.message} ${l.context ? JSON.stringify(l.context) : ''}`).join("\n");
                navigator.clipboard.writeText(text);
                new ButtonComponent(controls).setButtonText("已复制!").setDisabled(true);
                setTimeout(() => this.renderLogs(), 2000); // Reset button text
            });

        new ButtonComponent(controls)
            .setButtonText("清空")
            .setWarning()
            .onClick(() => {
                logger.clearLogs();
                this.renderLogs();
            });

        // Log Container
        this.logContainer = contentEl.createDiv({ cls: "log-container" });
        this.logContainer.style.height = "500px";
        this.logContainer.style.overflowY = "auto";
        this.logContainer.style.border = "1px solid var(--background-modifier-border)";
        this.logContainer.style.borderRadius = "4px";
        this.logContainer.style.padding = "10px";
        this.logContainer.style.backgroundColor = "var(--background-primary)";
        this.logContainer.style.fontFamily = "monospace";
        this.logContainer.style.fontSize = "12px";
        this.logContainer.style.whiteSpace = "pre-wrap";

        this.renderLogs();
    }

    private renderLogs() {
        this.logContainer.empty();
        const logs = logger.getLogs().reverse(); // Show newest first

        if (logs.length === 0) {
            const emptyMsg = this.logContainer.createDiv({ 
                text: "暂无日志记录..."
            });
            emptyMsg.style.color = "var(--text-muted)";
            emptyMsg.style.textAlign = "center";
            emptyMsg.style.paddingTop = "20px";
            return;
        }

        logs.forEach(log => {
            const line = this.logContainer.createDiv({ cls: "log-entry" });
            line.style.marginBottom = "6px";
            line.style.borderBottom = "1px solid var(--background-modifier-border)";
            line.style.paddingBottom = "6px";
            
            const timeStr = log.timestamp.toLocaleTimeString();
            const time = line.createSpan({ text: `[${timeStr}] `, cls: "log-time" });
            time.style.color = "var(--text-muted)";
            
            const level = line.createSpan({ text: `[${log.level}] `, cls: `log-level-${log.level.toLowerCase()}` });
            level.style.fontWeight = "bold";
            if (log.level === LogLevel.ERROR) level.style.color = "var(--text-error)";
            else if (log.level === LogLevel.WARN) level.style.color = "var(--text-warning)";
            else if (log.level === LogLevel.INFO) level.style.color = "var(--text-accent)";
            else level.style.color = "var(--text-muted)";
            
            line.createSpan({ text: log.message, cls: "log-message" });
            
            if (log.context) {
                const contextEl = line.createDiv({ cls: "log-context" });
                contextEl.style.fontSize = "0.9em";
                contextEl.style.color = "var(--text-muted)";
                contextEl.style.marginLeft = "20px";
                contextEl.style.marginTop = "4px";
                contextEl.style.backgroundColor = "var(--background-secondary)";
                contextEl.style.padding = "4px";
                contextEl.style.borderRadius = "2px";
                try {
                    contextEl.setText(JSON.stringify(log.context, null, 2));
                } catch (e) {
                    contextEl.setText(String(log.context));
                }
            }
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
