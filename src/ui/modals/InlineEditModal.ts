import { App, Modal, Setting, Editor, Notice } from "obsidian";
import type { IPluginContext } from "../../core/plugin-context";;

export class InlineEditModal extends Modal {
    private instruction: string = "";
    private onSubmit: (instruction: string) => void;

    constructor(app: App, onSubmit: (instruction: string) => void) {
        super(app);
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: "AI 行内编辑" });

        new Setting(contentEl)
            .setName("修改指令")
            .setDesc("例如：'润色这段文字'、'将其转换为表格'、'修复代码中的错误'")
            .addTextArea((text) => {
                text.setPlaceholder("输入指令...")
                    .onChange((value) => {
                        this.instruction = value;
                    });
                text.inputEl.setCssStyles({ width: "100%" });
                text.inputEl.setCssStyles({ height: "100px" });
                text.inputEl.focus();
            });

        new Setting(contentEl)
            .addButton((btn) =>
                btn
                    .setButtonText("提交 (Enter)")
                    .setCta()
                    .onClick(() => {
                        if (this.instruction.trim()) {
                            this.onSubmit(this.instruction);
                            this.close();
                        }
                    })
            )
            .addButton((btn) =>
                btn.setButtonText("取消").onClick(() => {
                    this.close();
                })
            );

        // Handle Enter key
        this.scope.register([], "Enter", (evt) => {
            if (evt.isComposing) return;
            if (this.instruction.trim()) {
                this.onSubmit(this.instruction);
                this.close();
            }
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
