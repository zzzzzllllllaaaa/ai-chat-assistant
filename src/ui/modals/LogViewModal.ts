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
        header.setCssStyles({ display: "flex" });
        header.setCssStyles({ justifyContent: "space-between" });
        header.setCssStyles({ alignItems: "center" });
        header.setCssStyles({ marginBottom: "15px" });
        
        const title = header.createEl("h2", { text: "插件运行日志" });
        title.setCssStyles({ margin: "0" });

        // Controls
        const controls = header.createDiv({ cls: "log-controls" });
        controls.setCssStyles({ display: "flex" });
        controls.setCssStyles({ gap: "10px" });

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
        this.logContainer.setCssStyles({ height: "500px" });
        this.logContainer.setCssStyles({ overflowY: "auto" });
        this.logContainer.setCssStyles({ border: "1px solid var(--background-modifier-border)" });
        this.logContainer.setCssStyles({ borderRadius: "4px" });
        this.logContainer.setCssStyles({ padding: "10px" });
        this.logContainer.setCssStyles({ backgroundColor: "var(--background-primary)" });
        this.logContainer.setCssStyles({ fontFamily: "monospace" });
        this.logContainer.setCssStyles({ fontSize: "12px" });
        this.logContainer.setCssStyles({ whiteSpace: "pre-wrap" });

        this.renderLogs();
    }

    private renderLogs() {
        this.logContainer.empty();
        const logs = logger.getLogs().reverse(); // Show newest first

        if (logs.length === 0) {
            const emptyMsg = this.logContainer.createDiv({ 
                text: "暂无日志记录..."
            });
            emptyMsg.setCssStyles({ color: "var(--text-muted)" });
            emptyMsg.setCssStyles({ textAlign: "center" });
            emptyMsg.setCssStyles({ paddingTop: "20px" });
            return;
        }

        logs.forEach(log => {
            const line = this.logContainer.createDiv({ cls: "log-entry" });
            line.setCssStyles({ marginBottom: "6px" });
            line.setCssStyles({ borderBottom: "1px solid var(--background-modifier-border)" });
            line.setCssStyles({ paddingBottom: "6px" });
            
            const timeStr = log.timestamp.toLocaleTimeString();
            const time = line.createSpan({ text: `[${timeStr}] `, cls: "log-time" });
            time.setCssStyles({ color: "var(--text-muted)" });
            
            const level = line.createSpan({ text: `[${log.level}] `, cls: `log-level-${log.level.toLowerCase()}` });
            level.setCssStyles({ fontWeight: "bold" });
            if (log.level === LogLevel.ERROR) level.setCssStyles({ color: "var(--text-error)" });
            else if (log.level === LogLevel.WARN) level.setCssStyles({ color: "var(--text-warning)" });
            else if (log.level === LogLevel.INFO) level.setCssStyles({ color: "var(--text-accent)" });
            else level.setCssStyles({ color: "var(--text-muted)" });
            
            line.createSpan({ text: log.message, cls: "log-message" });
            
            if (log.context) {
                const contextEl = line.createDiv({ cls: "log-context" });
                contextEl.setCssStyles({ fontSize: "0.9em" });
                contextEl.setCssStyles({ color: "var(--text-muted)" });
                contextEl.setCssStyles({ marginLeft: "20px" });
                contextEl.setCssStyles({ marginTop: "4px" });
                contextEl.setCssStyles({ backgroundColor: "var(--background-secondary)" });
                contextEl.setCssStyles({ padding: "4px" });
                contextEl.setCssStyles({ borderRadius: "2px" });
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
