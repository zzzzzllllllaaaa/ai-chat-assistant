import { App, setIcon, TFile } from "obsidian";
import type { IPluginContext } from "../../../core/plugin-context";;
import { ConversationTemplate } from "../../../core/settings";

export class InputManager {
    private app: App;
    private plugin: IPluginContext;
    private container: HTMLElement;
    private inputEl!: HTMLTextAreaElement;
    private sendBtnEl!: HTMLButtonElement;
    private inputWrapperEl!: HTMLElement;
    private submitCallback! : (text: string, images: string[]) => void;
    private pendingImages: string[] = [];
    private imagePreviewContainer!: HTMLElement;
    private onContextSelect?: () => void;
    private onAddActiveNote?: () => void;
    private onDraftChange?: (text: string) => void;
    private defaultPlaceholder = "输入消息... (Shift+Enter 换行)";
    private isProcessing = false;
    private processingStopCallback: (() => void) | null = null;
    
    // Slash command popup state
    private slashPopupEl: HTMLElement | null = null;
    private slashSelectedIndex = 0;
    private slashFilteredTemplates: ConversationTemplate[] = [];
    private getTemplates?: () => ConversationTemplate[];
    
    // Skill mention popup state (@技能)
    private skillPopupEl: HTMLElement | null = null;
    private skillSelectedIndex = 0;
    private skillFilteredList: Array<{ id: string; name: string; description: string }> = [];
    private mentionedSkillId: string | null = null;

    constructor(app: App, plugin: IPluginContext, container: HTMLElement) {
        this.app = app;
        this.plugin = plugin;
        this.container = container;
        this.render();
    }

    private render() {
        this.container.empty();
        this.container.addClass("ai-chat-input-area");

        // Image Preview Area
        this.imagePreviewContainer = this.container.createDiv({ cls: "ai-chat-image-preview-container" });
        this.imagePreviewContainer.setCssStyles({ display: "none" });

        // Input Wrapper
        const inputWrapper = this.container.createDiv({ cls: "ai-chat-input-wrapper" });
        this.inputWrapperEl = inputWrapper;

        // Left Tools (Upload, Context) - Moved inside wrapper for compact layout
        const leftTools = inputWrapper.createDiv({ cls: "ai-chat-input-tools-left" });
        
        // Upload Image
        const uploadBtn = leftTools.createEl("button", { cls: "ai-chat-tool-btn", attr: { "aria-label": "上传图片" } });
        setIcon(uploadBtn, "image");
        uploadBtn.addEventListener("click", () => this.triggerImageUpload());

        // Context Reference
        const contextBtn = leftTools.createEl("button", { cls: "ai-chat-tool-btn", attr: { "aria-label": "引用上下文" } });
        setIcon(contextBtn, "link");
        contextBtn.addEventListener("click", () => this.triggerContextSelection());
        
        this.inputEl = inputWrapper.createEl("textarea", {
            cls: "ai-chat-input",
            attr: { placeholder: this.defaultPlaceholder }
        });

        // Auto-resize
        this.inputEl.addEventListener("input", () => {
            this.inputEl.setCssStyles({ height: "auto" });
            this.inputEl.setCssStyles({ height: `${Math.min(this.inputEl.scrollHeight, 200)}px` });

            if (this.onDraftChange) this.onDraftChange(this.inputEl.value);
            
            // Skill mention detection (@)
            this.handleSkillMention();
            
            // Slash command detection
            this.handleSlashInput();
        });

        // Key handling
        this.inputEl.addEventListener("keydown", (e) => {
            // If skill popup is visible, intercept navigation keys
            if (this.skillPopupEl && this.skillFilteredList.length > 0) {
                if (e.key === "ArrowDown") {
                    e.preventDefault();
                    this.skillSelectedIndex = Math.min(this.skillSelectedIndex + 1, this.skillFilteredList.length - 1);
                    this.renderSkillPopupItems();
                    return;
                }
                if (e.key === "ArrowUp") {
                    e.preventDefault();
                    this.skillSelectedIndex = Math.max(this.skillSelectedIndex - 1, 0);
                    this.renderSkillPopupItems();
                    return;
                }
                if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                    e.preventDefault();
                    this.selectSkill(this.skillSelectedIndex);
                    return;
                }
                if (e.key === "Escape") {
                    e.preventDefault();
                    this.hideSkillPopup();
                    return;
                }
            }
            
            // If slash popup is visible, intercept navigation keys
            if (this.slashPopupEl && this.slashFilteredTemplates.length > 0) {
                if (e.key === "ArrowDown") {
                    e.preventDefault();
                    this.slashSelectedIndex = Math.min(this.slashSelectedIndex + 1, this.slashFilteredTemplates.length - 1);
                    this.renderSlashPopupItems();
                    return;
                }
                if (e.key === "ArrowUp") {
                    e.preventDefault();
                    this.slashSelectedIndex = Math.max(this.slashSelectedIndex - 1, 0);
                    this.renderSlashPopupItems();
                    return;
                }
                if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                    e.preventDefault();
                    this.selectSlashTemplate(this.slashSelectedIndex);
                    return;
                }
                if (e.key === "Escape") {
                    e.preventDefault();
                    this.hideSlashPopup();
                    return;
                }
            }
            
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                this.submit();
            }
        });

        // Send Button
        this.sendBtnEl = inputWrapper.createEl("button", { cls: "ai-chat-send-btn" });
        setIcon(this.sendBtnEl, "send");
        this.sendBtnEl.addEventListener("click", () => this.handleSendBtnClick());

        // File Drop
        this.inputEl.addEventListener("paste", (e) => this.handlePaste(e));
        this.container.addEventListener("dragover", (e) => e.preventDefault());
        this.container.addEventListener("drop", (e) => this.handleDrop(e));
    }

    public onSubmit(callback: (text: string, images: string[]) => void) {
        this.submitCallback = callback;
    }

    public focus() {
        this.inputEl.focus();
    }

    public setDisabled(disabled: boolean) {
        this.inputEl.disabled = disabled;
        // Don't disable send button during processing — it acts as stop button
        if (!this.isProcessing) {
            this.sendBtnEl.disabled = disabled;
        }
    }

    public clear() {
        this.inputEl.value = "";
        this.inputEl.setCssStyles({ height: "auto" });
        this.pendingImages = [];
        this.updateImagePreview();
    }

    public setText(text: string) {
        this.inputEl.value = text;
        this.inputEl.dispatchEvent(new Event("input"));
    }

    public setPlaceholder(text: string) {
        this.inputEl.placeholder = text;
    }

    public showProcessingState(text: string, onStop?: () => void) {
        this.isProcessing = true;
        this.processingStopCallback = onStop ?? null;

        // Swap send button → stop button and ensure it's clickable
        this.sendBtnEl.disabled = false;
        this.sendBtnEl.classList.add("ai-chat-send-btn--stop");
        setIcon(this.sendBtnEl, "square");

        // Show thinking text as placeholder & disable input
        this.inputEl.placeholder = text;
        this.inputEl.disabled = true;
        this.inputWrapperEl.classList.add("ai-chat-input-wrapper--processing");
    }

    public hideProcessingState() {
        this.isProcessing = false;
        this.processingStopCallback = null;

        // Restore send button
        this.sendBtnEl.classList.remove("ai-chat-send-btn--stop");
        setIcon(this.sendBtnEl, "send");

        // Restore input
        this.inputEl.placeholder = this.defaultPlaceholder;
        this.inputEl.disabled = false;
        this.inputWrapperEl.classList.remove("ai-chat-input-wrapper--processing");
    }

    private handleSendBtnClick() {
        if (this.isProcessing && this.processingStopCallback) {
            this.processingStopCallback();
        } else {
            this.submit();
        }
    }

    private submit() {
        const text = this.inputEl.value.trim();
        if (!text && this.pendingImages.length === 0) return;
        
        if (this.submitCallback) {
            this.submitCallback(text, [...this.pendingImages]);
            this.clear();
        }
    }

    private async handlePaste(e: ClipboardEvent) {
        if (e.clipboardData && e.clipboardData.items) {
            for (let i = 0; i < e.clipboardData.items.length; i++) {
                const item = e.clipboardData.items[i];
                if (item.type.indexOf("image") !== -1) {
                    e.preventDefault();
                    const blob = item.getAsFile();
                    if (blob) await this.processImageFile(blob);
                }
            }
        }
    }

    private async handleDrop(e: DragEvent) {
        e.preventDefault();
        if (e.dataTransfer && e.dataTransfer.files) {
            for (let i = 0; i < e.dataTransfer.files.length; i++) {
                const file = e.dataTransfer.files[i];
                if (file.type.startsWith("image/")) {
                    await this.processImageFile(file);
                }
            }
        }
    }

    private triggerImageUpload() {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.multiple = true;
        input.onchange = async (e) => {
            const files = (e.target as HTMLInputElement).files;
            if (files) {
                for (let i = 0; i < files.length; i++) {
                    await this.processImageFile(files[i]);
                }
            }
        };
        input.click();
    }

    private triggerContextSelection() {
        // This should ideally trigger a modal or callback to the view
        // For now, let's just emit a custom event or use a callback if we had one for context
        // Or we can implement a simple file picker here
        // But context selection is complex (files, folders, tags).
        // Let's expose a callback for this.
        if (this.onContextSelect) {
            this.onContextSelect();
        }
    }

    public setOnContextSelect(callback: () => void) {
        this.onContextSelect = callback;
    }

    public setOnAddActiveNote(callback: () => void) {
        this.onAddActiveNote = callback;
    }

    public setOnDraftChange(callback: (text: string) => void) {
        this.onDraftChange = callback;
    }

    public setGetTemplates(getter: () => ConversationTemplate[]) {
        this.getTemplates = getter;
    }

    private async processImageFile(file: File) {
        const reader = new FileReader();
        reader.onload = (e) => {
            if (e.target?.result) {
                this.pendingImages.push(e.target.result as string);
                this.updateImagePreview();
            }
        };
        reader.readAsDataURL(file);
    }

    private updateImagePreview() {
        this.imagePreviewContainer.empty();
        if (this.pendingImages.length > 0) {
            this.imagePreviewContainer.setCssStyles({ display: "flex" });
            this.pendingImages.forEach((imgData, index) => {
                const wrapper = this.imagePreviewContainer.createDiv({ cls: "ai-chat-image-preview-item" });
                const img = wrapper.createEl("img", { attr: { src: imgData } });
                const removeBtn = wrapper.createEl("button", { cls: "ai-chat-image-remove-btn" });
                setIcon(removeBtn, "x");
                removeBtn.addEventListener("click", () => {
                    this.pendingImages.splice(index, 1);
                    this.updateImagePreview();
                });
            });
        } else {
            this.imagePreviewContainer.setCssStyles({ display: "none" });
        }
    }

    // ============ Slash Command Popup ============

    private handleSlashInput() {
        const text = this.inputEl.value;
        // Only trigger when text starts with "/" and there's no newline before the first /
        if (!text.startsWith("/") || !this.getTemplates) {
            this.hideSlashPopup();
            return;
        }

        // Extract the query part after "/"
        const firstLine = text.split("\n")[0];
        const query = firstLine.slice(1).trim().toLowerCase();

        const allTemplates = this.getTemplates();
        if (allTemplates.length === 0) {
            // 显示提示而不是隐藏
            this.showEmptySlashPopup("暂无模板，请在设置中创建指令模板");
            return;
        }

        // Filter templates: match by slashCommand or name
        this.slashFilteredTemplates = allTemplates.filter(tpl => {
            if (!query) return true; // Show all when just "/"
            const cmd = (tpl.slashCommand || "").toLowerCase();
            const name = (tpl.name || "").toLowerCase();
            return cmd.includes(query) || name.includes(query);
        });

        if (this.slashFilteredTemplates.length === 0) {
            this.showEmptySlashPopup("无匹配的模板");
            return;
        }

        this.slashSelectedIndex = Math.min(this.slashSelectedIndex, this.slashFilteredTemplates.length - 1);
        this.showSlashPopup();
    }

    private showSlashPopup() {
        if (!this.slashPopupEl) {
            this.slashPopupEl = this.container.createDiv({ cls: "ai-slash-popup" });
        }
        this.renderSlashPopupItems();
        this.slashPopupEl.setCssStyles({ display: "block" });
    }

    private hideSlashPopup() {
        if (this.slashPopupEl) {
            this.slashPopupEl.setCssStyles({ display: "none" });
        }
        this.slashSelectedIndex = 0;
        this.slashFilteredTemplates = [];
    }

    private showEmptySlashPopup(message: string) {
        if (!this.slashPopupEl) {
            this.slashPopupEl = this.container.createDiv({ cls: "ai-slash-popup" });
        }
        this.slashPopupEl.empty();
        const emptyDiv = this.slashPopupEl.createDiv({ cls: "ai-slash-popup-empty" });
        emptyDiv.createSpan({ text: message, cls: "ai-slash-popup-empty-text" });
        this.slashPopupEl.setCssStyles({ display: "block" });
    }

    private renderSlashPopupItems() {
        if (!this.slashPopupEl) return;
        this.slashPopupEl.empty();

        const header = this.slashPopupEl.createDiv({ cls: "ai-slash-popup-header" });
        header.createSpan({ text: "指令模板", cls: "ai-slash-popup-title" });
        header.createSpan({ text: `${this.slashFilteredTemplates.length} 个匹配`, cls: "ai-slash-popup-count" });

        const list = this.slashPopupEl.createDiv({ cls: "ai-slash-popup-list" });

        this.slashFilteredTemplates.forEach((tpl, i) => {
            const item = list.createDiv({
                cls: `ai-slash-popup-item ${i === this.slashSelectedIndex ? "is-selected" : ""}`
            });

            const iconEl = item.createDiv({ cls: "ai-slash-popup-item-icon" });
            setIcon(iconEl, "zap");

            const textDiv = item.createDiv({ cls: "ai-slash-popup-item-text" });
            const nameRow = textDiv.createDiv({ cls: "ai-slash-popup-item-name" });
            
            if (tpl.slashCommand) {
                nameRow.createSpan({ text: `/${tpl.slashCommand}`, cls: "ai-slash-cmd-tag" });
            }
            nameRow.createSpan({ text: tpl.name });

            // Show a preview of presetPrompt
            if (tpl.presetPrompt) {
                const preview = tpl.presetPrompt.length > 80 
                    ? tpl.presetPrompt.slice(0, 80) + "..." 
                    : tpl.presetPrompt;
                textDiv.createDiv({ text: preview, cls: "ai-slash-popup-item-desc" });
            }

            item.addEventListener("mouseenter", () => {
                this.slashSelectedIndex = i;
                // Only toggle CSS class — do NOT re-render DOM (would destroy element under cursor and break click)
                list.querySelectorAll(".ai-slash-popup-item").forEach((el, idx) => {
                    el.classList.toggle("is-selected", idx === i);
                });
            });
            item.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.selectSlashTemplate(i);
            });
        });

        // Scroll selected item into view
        const selectedItem = list.querySelector(".is-selected") as HTMLElement;
        if (selectedItem) {
            selectedItem.scrollIntoView({ block: "nearest" });
        }
    }

    private selectSlashTemplate(index: number) {
        const tpl = this.slashFilteredTemplates[index];
        if (!tpl) return;

        this.hideSlashPopup();

        // Replace the slash command text with the template's presetPrompt
        const text = this.inputEl.value;
        const firstLineEnd = text.indexOf("\n");
        const restOfText = firstLineEnd >= 0 ? text.slice(firstLineEnd + 1) : "";
        
        // Build the new text: presetPrompt + any text after first line
        const prompt = tpl.presetPrompt || "";
        const newText = restOfText ? `${prompt}\n${restOfText}` : prompt;
        
        this.inputEl.value = newText;
        this.inputEl.setCssStyles({ height: "auto" });
        this.inputEl.setCssStyles({ height: `${Math.min(this.inputEl.scrollHeight, 200)}px` });
        this.inputEl.focus();

        // Place cursor at the end of inserted prompt
        const cursorPos = prompt.length;
        this.inputEl.setSelectionRange(cursorPos, cursorPos);
        
        if (this.onDraftChange) this.onDraftChange(this.inputEl.value);
    }

    // ============ Skill Mention Popup (@技能) ============

    private handleSkillMention() {
        const text = this.inputEl.value;
        const cursorPos = this.inputEl.selectionStart;
        
        // 查找光标前最近的 @ 符号
        const textBeforeCursor = text.slice(0, cursorPos);
        const lastAtIndex = textBeforeCursor.lastIndexOf('@');
        
        // 如果没有 @ 或者 @ 后面有空格/换行，隐藏弹窗
        if (lastAtIndex === -1) {
            this.hideSkillPopup();
            return;
        }
        
        // 提取 @ 后面的查询文本，支持两种格式：
        //   @skillName    → 简单格式
        //   @skill:"name" → 完整格式（带 skill: 前缀和引号）
        const rawQuery = textBeforeCursor.slice(lastAtIndex + 1);
        
        // 解析 skill: 前缀和引号，提取纯粹的搜索关键词
        let queryText = rawQuery;
        const skillPrefixRe = /^skill:\s*/i;
        if (skillPrefixRe.test(queryText)) {
            queryText = queryText.replace(skillPrefixRe, '');
        }
        // 去除首尾引号（支持 "全栈开发" 和 「全栈开发」）
        queryText = queryText.replace(/^["「](.*)["」]$/, '$1').replace(/^["「]/, '');
        
        // 如果不是 @skill:"..." 格式且包含空格/换行，隐藏弹窗
        const isQuotedFormat = /^@skill:\s*["「]/i.test(rawQuery);
        if (!isQuotedFormat && (rawQuery.includes(' ') || rawQuery.includes('\n'))) {
            this.hideSkillPopup();
            return;
        }
        
        // 获取所有技能
        const allSkills = this.plugin.skillRegistry.getAllSkills();
        if (allSkills.length === 0) {
            this.showEmptySkillPopup("暂无技能，请在设置中安装技能 (Skills)");
            return;
        }
        
        // 过滤技能：匹配名称或 ID
        const query = queryText.toLowerCase();
        this.skillFilteredList = allSkills
            .filter(skill => {
                if (!query) return true; // 显示所有技能
                const name = skill.name.toLowerCase();
                const id = skill.id.toLowerCase();
                return name.includes(query) || id.includes(query);
            })
            .map(skill => ({
                id: skill.id,
                name: skill.name,
                description: skill.description || ''
            }));
        
        if (this.skillFilteredList.length === 0) {
            this.showEmptySkillPopup("无匹配的技能");
            return;
        }
        
        this.skillSelectedIndex = Math.min(this.skillSelectedIndex, this.skillFilteredList.length - 1);
        this.showSkillPopup();
    }

    private showSkillPopup() {
        if (!this.skillPopupEl) {
            this.skillPopupEl = this.container.createDiv({ cls: "ai-skill-popup" });
        }
        this.renderSkillPopupItems();
        this.skillPopupEl.setCssStyles({ display: "block" });
    }

    private hideSkillPopup() {
        if (this.skillPopupEl) {
            this.skillPopupEl.setCssStyles({ display: "none" });
        }
        this.skillSelectedIndex = 0;
        this.skillFilteredList = [];
    }

    private showEmptySkillPopup(message: string) {
        if (!this.skillPopupEl) {
            this.skillPopupEl = this.container.createDiv({ cls: "ai-skill-popup" });
        }
        this.skillPopupEl.empty();
        const emptyDiv = this.skillPopupEl.createDiv({ cls: "ai-skill-popup-empty" });
        emptyDiv.createSpan({ text: message, cls: "ai-skill-popup-empty-text" });
        this.skillPopupEl.setCssStyles({ display: "block" });
    }

    private renderSkillPopupItems() {
        if (!this.skillPopupEl) return;
        this.skillPopupEl.empty();

        const header = this.skillPopupEl.createDiv({ cls: "ai-skill-popup-header" });
        header.createSpan({ text: "选择技能", cls: "ai-skill-popup-title" });
        header.createSpan({ text: `${this.skillFilteredList.length} 个匹配`, cls: "ai-skill-popup-count" });

        const list = this.skillPopupEl.createDiv({ cls: "ai-skill-popup-list" });

        this.skillFilteredList.forEach((skill, i) => {
            const item = list.createDiv({
                cls: `ai-skill-popup-item ${i === this.skillSelectedIndex ? "is-selected" : ""}`
            });

            const iconEl = item.createDiv({ cls: "ai-skill-popup-item-icon" });
            setIcon(iconEl, "zap");

            const textDiv = item.createDiv({ cls: "ai-skill-popup-item-text" });
            const nameRow = textDiv.createDiv({ cls: "ai-skill-popup-item-name" });
            
            nameRow.createSpan({ text: `@${skill.name}`, cls: "ai-skill-mention-tag" });

            // 显示技能描述
            if (skill.description) {
                const preview = skill.description.length > 80 
                    ? skill.description.slice(0, 80) + "..." 
                    : skill.description;
                textDiv.createDiv({ text: preview, cls: "ai-skill-popup-item-desc" });
            }

            item.addEventListener("mouseenter", () => {
                this.skillSelectedIndex = i;
                list.querySelectorAll(".ai-skill-popup-item").forEach((el, idx) => {
                    el.classList.toggle("is-selected", idx === i);
                });
            });
            item.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.selectSkill(i);
            });
        });

        // 滚动选中项到可见区域
        const selectedItem = list.querySelector(".is-selected") as HTMLElement;
        if (selectedItem) {
            selectedItem.scrollIntoView({ block: "nearest" });
        }
    }

    private selectSkill(index: number) {
        const skill = this.skillFilteredList[index];
        if (!skill) return;

        this.hideSkillPopup();

        // 替换 @ 提及为技能名称
        const text = this.inputEl.value;
        const cursorPos = this.inputEl.selectionStart;
        const textBeforeCursor = text.slice(0, cursorPos);
        const lastAtIndex = textBeforeCursor.lastIndexOf('@');
        
        if (lastAtIndex === -1) return;
        
        // 构建新文本：支持 @skillName 和 @skill:"name" 两种格式
        const beforeAt = text.slice(0, lastAtIndex);
        const afterCursor = text.slice(cursorPos);
        
        // 判断用户是否以 @skill: 格式输入
        const atQuery = textBeforeCursor.slice(lastAtIndex);
        const isSkillColonFormat = /^@skill:/i.test(atQuery);
        const mentionText = isSkillColonFormat
            ? `@skill:"${skill.name}"` // 完整格式
            : `@${skill.name}`;        // 简单格式
        
        const newText = `${beforeAt}${mentionText} ${afterCursor}`;
        
        this.inputEl.value = newText;
        this.inputEl.setCssStyles({ height: "auto" });
        this.inputEl.setCssStyles({ height: `${Math.min(this.inputEl.scrollHeight, 200)}px` });
        this.inputEl.focus();

        // 将光标放在技能名称后面
        const newCursorPos = beforeAt.length + mentionText.length + 1; // +1 for space
        this.inputEl.setSelectionRange(newCursorPos, newCursorPos);
        
        // 记录被提及的技能 ID
        this.mentionedSkillId = skill.id;
        
        if (this.onDraftChange) this.onDraftChange(this.inputEl.value);
    }

    /**
     * 获取当前提及的技能 ID
     */
    public getMentionedSkillId(): string | null {
        return this.mentionedSkillId;
    }

    /**
     * 清除提及的技能
     */
    public clearMentionedSkill() {
        this.mentionedSkillId = null;
    }
}

