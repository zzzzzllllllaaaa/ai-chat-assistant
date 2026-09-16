import { App, MarkdownRenderer, setIcon, Notice, MarkdownView, Component } from "obsidian";
import { ChatMessage } from "../../../core/types";
import AiChatAssistantPlugin from "../../../../main";;
import { NoteModificationModal } from "../../../ui/modals/DiffModals";
import { safeNotice } from "../../../utils/notice";

export interface MessageActionCallbacks {
    onRegenerate: (index: number) => void;
    onEdit: (messageEl: HTMLElement, index: number) => void;
    onDelete: (index: number) => void;
    onInsert?: (content: string) => void;
    onCreateNote?: (content: string) => void;
    getAvatar?: () => string | null;
}

export type MessageSegmentType = 'text' | 'thought' | 'plan' | 'step' | 'tool';

export interface MessageSegment {
    type: MessageSegmentType;
    content: string;
}

export class MessageRenderer {
    private app: App;
    private plugin: AiChatAssistantPlugin;
    private container: HTMLElement;
    private callbacks?: MessageActionCallbacks;
    /** MarkdownRenderer 需要一个短生命周期的组件来挂清理回调（不要直接用插件实例：生命周期太长会泄漏） */
    private mdComponent: Component;

    constructor(app: App, plugin: AiChatAssistantPlugin, container: HTMLElement, callbacks?: MessageActionCallbacks) {
        this.app = app;
        this.plugin = plugin;
        this.container = container;
        this.callbacks = callbacks;
        this.mdComponent = new Component();
        this.mdComponent.load();
    }

    /** 视图关闭时调用，释放 MarkdownRenderer 注册的子组件 */
    public unload(): void {
        this.mdComponent.unload();
    }

    public async renderMessage(message: ChatMessage, index: number, isStreaming: boolean = false) {
        if (message.role === 'tool' && !this.plugin.settings.showToolLogs) {
            return;
        }

        const msgDiv = this.container.createDiv({ cls: `ai-chat-message ${message.role}` });
        msgDiv.dataset.index = String(index);
        
        // Avatar
        const avatar = msgDiv.createDiv({ cls: "ai-chat-avatar" });
        if (message.role === 'user') {
            setIcon(avatar, "user");
        } else if (message.role === 'assistant') {
            // 尝试获取当前角色的头像
            const personaAvatar = this.callbacks?.getAvatar ? this.callbacks.getAvatar() : this.getActivePersonaAvatar();
            if (personaAvatar) {
                const img = avatar.createEl('img', { 
                    cls: 'ai-chat-avatar-img',
                    attr: { src: personaAvatar }
                });
                img.onerror = () => {
                    img.remove();
                    setIcon(avatar, "bot");
                };
            } else {
                setIcon(avatar, "bot");
            }
        } else {
            setIcon(avatar, "settings");
        }

        // Content
        const contentDiv = msgDiv.createDiv({ cls: "ai-chat-content" });
        
        // Render Images if any
        if (message.images && message.images.length > 0) {
            const imagesContainer = contentDiv.createDiv({ cls: "ai-chat-images-container" });
            message.images.forEach(imgData => {
                const img = imagesContainer.createEl("img", { cls: "ai-chat-message-image" });
                img.src = imgData;
            });
        }

        if (message.role === 'assistant') {
            await this.renderAssistantMessage(contentDiv, message.content || '', isStreaming, message.references);
            
            // Render References if any
            if (message.references && message.references.length > 0) {
                this.renderReferences(contentDiv, message.references);
            }
        } else {
            await MarkdownRenderer.render(this.app, message.content || '', contentDiv, '', this.mdComponent);
        }

        // Toolbar (Copy, etc.)
        if (!isStreaming) {
            // Render toolbar inside contentDiv for better layout control
            this.renderMessageToolbar(contentDiv, msgDiv, message, index);
        }
    }

    private async renderAssistantMessage(container: HTMLElement, content: string, isStreaming: boolean, references?: any[]) {
        const visibleContent = String(content || '').replace(/<data_block>[\s\S]*?<\/data_block>/gi, '').trim();
        // 解析内容为不同类型的段落
        const segments = this.parseAssistantMessage(visibleContent);
        
        for (const segment of segments) {
            if (segment.type === 'thought') {
                await this.renderThoughtBlock(container, segment.content);
            } else if (segment.type === 'plan') {
                this.renderPlanBlock(container, segment.content);
            } else if (segment.type === 'step') {
                this.renderStepBlock(container, segment.content);
            } else if (segment.type === 'tool') {
                this.renderToolCallBlock(container, segment.content);
            } else {
                await this.renderTextBlock(container, segment.content, references);
            }
        }

        if (isStreaming) {
            container.createSpan({ cls: "ai-chat-cursor" });
        }

        this.postProcessCodeBlocks(container);
    }

    private async renderThoughtBlock(container: HTMLElement, content: string) {
        const thoughtDiv = container.createDiv({ cls: "ai-chat-thought-block collapsed" });
        const header = thoughtDiv.createDiv({ cls: "ai-chat-thought-header" });
        header.createSpan({ text: "💭 思考过程" });
        const icon = header.createSpan({ cls: "ai-chat-thought-icon" });
        setIcon(icon, "chevron-right");
        
        const body = thoughtDiv.createDiv({ cls: "ai-chat-thought-body" });
        await MarkdownRenderer.render(this.app, content, body, '', this.mdComponent);
        
        header.addEventListener("click", () => {
            thoughtDiv.classList.toggle("collapsed");
            setIcon(icon, thoughtDiv.classList.contains("collapsed") ? "chevron-right" : "chevron-down");
        });
    }

    private renderPlanBlock(container: HTMLElement, jsonContent: string) {
        try {
            const plan = JSON.parse(jsonContent);
            const planDiv = container.createDiv({ cls: "ai-chat-plan-block" });
            
            const header = planDiv.createDiv({ cls: "ai-chat-plan-header" });
            const headerIcon = header.createSpan();
            setIcon(headerIcon, "list-checks");
            header.createSpan({ text: `执行计划 (${plan.steps?.length || 0} 步)` });
            const toggleIcon = header.createSpan({ cls: "plan-toggle" });
            setIcon(toggleIcon, "chevron-down");
            
            const body = planDiv.createDiv({ cls: "ai-chat-plan-body" });
            
            if (plan.goal) {
                const goalDiv = body.createDiv({ cls: "ai-chat-plan-goal" });
                goalDiv.createEl("strong", { text: "目标：" });
                goalDiv.appendText(plan.goal);
            }
            
            if (plan.steps && Array.isArray(plan.steps)) {
                const stepsDiv = body.createDiv({ cls: "ai-chat-plan-steps" });
                plan.steps.forEach((step: any, idx: number) => {
                    const stepDiv = stepsDiv.createDiv({ cls: "ai-chat-plan-step" });
                    stepDiv.createDiv({ cls: "ai-chat-plan-step-num", text: String(idx + 1) });
                    
                    const contentDiv = stepDiv.createDiv({ cls: "ai-chat-plan-step-content" });
                    if (step.title) {
                        contentDiv.createDiv({ cls: "ai-chat-plan-step-title", text: step.title });
                    }
                    if (step.instruction) {
                        contentDiv.createDiv({ cls: "ai-chat-plan-step-desc", text: step.instruction });
                    }
                    if (step.preferredTools && step.preferredTools.length > 0) {
                        const toolsDiv = contentDiv.createDiv({ cls: "ai-chat-plan-step-tools" });
                        step.preferredTools.forEach((tool: string) => {
                            toolsDiv.createSpan({ cls: "ai-chat-plan-step-tool", text: tool });
                        });
                    }
                });
            }
            
            header.addEventListener("click", () => {
                planDiv.classList.toggle("collapsed");
                setIcon(toggleIcon, planDiv.classList.contains("collapsed") ? "chevron-right" : "chevron-down");
            });
        } catch {
            // JSON 解析失败，回退到普通代码块
            const pre = container.createEl("pre");
            pre.createEl("code", { text: jsonContent });
        }
    }

    private renderStepBlock(container: HTMLElement, stepInfo: string) {
        const stepDiv = container.createDiv({ cls: "ai-chat-step-block" });
        const header = stepDiv.createDiv({ cls: "ai-chat-step-header" });
        const icon = header.createSpan({ cls: "step-icon" });
        setIcon(icon, "arrow-right");
        
        // 解析步骤信息 "【步骤 1/3: 标题】 指令"
        const match = stepInfo.match(/【步骤\s*(\d+)\/(\d+)(?::\s*(.+?))?】\s*(.*)/s);
        if (match) {
            header.createSpan({ text: `步骤 ${match[1]}/${match[2]}${match[3] ? `: ${match[3]}` : ''}` });
            if (match[4]) {
                stepDiv.createDiv({ cls: "ai-chat-step-instruction", text: match[4].trim() });
            }
        } else {
            header.createSpan({ text: stepInfo.substring(0, 50) });
        }
    }

    private renderToolCallBlock(container: HTMLElement, toolInfo: string) {
        // 解析工具调用信息
        const toolDiv = container.createDiv({ cls: "ai-chat-tool-call collapsed" });
        
        // 尝试解析结构化工具信息
        let toolName = "工具调用";
        let status = "";
        let args = "";
        let result = "";
        
        // 匹配 "使用标准协议调用工具: xxx" 或 "调用工具 xxx"
        const nameMatch = toolInfo.match(/(?:使用.*调用工具|调用工具)[:\s]*([a-z_]+)/i);
        if (nameMatch) {
            const rawName = nameMatch[1];
            // 优先使用中文标签
            toolName = this.plugin.agentManager?.getToolLabel(rawName) || rawName;
        }
        
        // 检测状态
        if (toolInfo.includes("成功") || toolInfo.includes("✅")) {
            status = "success";
            toolDiv.addClass("success");
        } else if (toolInfo.includes("失败") || toolInfo.includes("错误") || toolInfo.includes("❌")) {
            status = "error";
            toolDiv.addClass("error");
        }
        
        const header = toolDiv.createDiv({ cls: "ai-chat-tool-header" });
        const headerIcon = header.createSpan();
        setIcon(headerIcon, status === "success" ? "check-circle" : status === "error" ? "x-circle" : "terminal");
        header.createSpan({ cls: "ai-chat-tool-name", text: toolName });
        
        if (status) {
            header.createSpan({ 
                cls: "ai-chat-tool-status", 
                text: status === "success" ? "成功" : "失败"
            });
        }
        
        const toggleIcon = header.createSpan({ cls: "ai-chat-tool-toggle" });
        setIcon(toggleIcon, "chevron-right");
        
        const body = toolDiv.createDiv({ cls: "ai-chat-tool-body" });
        
        // 简化显示
        const detailSection = body.createDiv({ cls: "ai-chat-tool-section" });
        detailSection.createDiv({ cls: "ai-chat-tool-section-title", text: "详情" });
        const pre = detailSection.createEl("pre");
        pre.createEl("code", { text: toolInfo.trim() });
        
        header.addEventListener("click", () => {
            toolDiv.classList.toggle("collapsed");
            setIcon(toggleIcon, toolDiv.classList.contains("collapsed") ? "chevron-right" : "chevron-down");
        });
    }

    private async renderTextBlock(container: HTMLElement, content: string, references?: any[]) {
        const textDiv = container.createDiv({ cls: "ai-chat-text-block" });
        
        // Process citations [1], [2] -> [[NoteName|[1]]]
        let processedContent = content;
        if (references && references.length > 0 && this.plugin.settings.showCitations) {
            processedContent = processedContent.replace(/\[(\d+)\]/g, (match, numStr) => {
                const index = parseInt(numStr) - 1;
                if (index >= 0 && index < references.length) {
                    const ref = references[index];
                    const linkTarget = ref.subpath ? `${ref.path}${ref.subpath}` : ref.path;
                    return `[[${linkTarget}|[${numStr}]]]`;
                }
                return match;
            });
        }

        await MarkdownRenderer.render(this.app, processedContent, textDiv, '', this.mdComponent);

        // Add click listener for internal links
        textDiv.addEventListener('click', async (e) => {
            const target = e.target as HTMLElement;
            if (target.tagName === 'A' && target.hasClass('internal-link')) {
                e.preventDefault();
                const linkText = target.getAttribute('data-href');
                if (linkText) {
                     // 使用 openLinkText 以支持 subpath（如 path#heading）自动跳转到片段
                     await this.app.workspace.openLinkText(linkText, "", false);
                }
            }
        });
    }

    private escapeHtml(text: string): string {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    private postProcessCodeBlocks(container: HTMLElement) {
        const codeBlocks = container.querySelectorAll("pre > code");
        codeBlocks.forEach((codeEl) => {
            const pre = codeEl.parentElement;
            if (!pre) return;
            
            if (pre.classList.contains("ai-chat-code-processed")) return;
            pre.classList.add("ai-chat-code-processed");
            pre.setCssStyles({ position: "relative" });

            const toolbar = pre.createDiv({ cls: "ai-chat-code-toolbar" });

            // Copy
            const copyBtn = toolbar.createEl("button", { cls: "ai-chat-code-btn", attr: { "aria-label": "Copy" } });
            setIcon(copyBtn, "copy");
            copyBtn.addEventListener("click", () => {
                navigator.clipboard.writeText(codeEl.textContent || "");
                new Notice("Code copied!");
            });

            // Insert
            if (this.callbacks?.onInsert) {
                const insertBtn = toolbar.createEl("button", { cls: "ai-chat-code-btn", attr: { "aria-label": "Insert" } });
                setIcon(insertBtn, "arrow-down-circle");
                insertBtn.addEventListener("click", () => {
                    this.callbacks?.onInsert?.(codeEl.textContent || "");
                });
            }

            // Apply to current file
            const applyBtn = toolbar.createEl("button", { cls: "ai-chat-code-btn", attr: { "aria-label": "Apply to current file" } });
            setIcon(applyBtn, "check-check");
            applyBtn.addEventListener("click", async () => {
                const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!activeView || !activeView.file) {
                    new Notice("没有打开的笔记可供应用");
                    return;
                }

                const file = activeView.file;
                const oldContent = await this.app.vault.read(file);
                const newContent = codeEl.textContent || "";

                new NoteModificationModal(this.app, file, oldContent, newContent, async (apply) => {
                    if (apply) {
                        await this.app.vault.modify(file, newContent);
                        safeNotice(`已应用修改到: ${file.basename}`);
                    }
                }).open();
            });
        });
    }

    private renderMessageToolbar(container: HTMLElement, messageWrapper: HTMLElement, message: ChatMessage, index: number) {
        const toolbar = container.createDiv({ cls: "ai-chat-message-toolbar" });
        
        // Copy
        const copyBtn = toolbar.createEl("button", { cls: "ai-chat-tool-btn", attr: { "aria-label": "复制" } });
        setIcon(copyBtn, "copy");
        copyBtn.addEventListener("click", () => {
            navigator.clipboard.writeText(message.content || "");
            new Notice("已复制到剪贴板");
        });

        // Insert (Only for assistant messages)
        if (message.role === 'assistant' && this.callbacks?.onInsert) {
            const insertBtn = toolbar.createEl("button", { cls: "ai-chat-tool-btn", attr: { "aria-label": "插入到当前位置" } });
            setIcon(insertBtn, "arrow-down-circle");
            insertBtn.addEventListener("click", () => {
                this.callbacks?.onInsert?.(message.content || "");
            });
        }

        // Create note (Only for assistant messages)
        if (message.role === 'assistant' && this.callbacks?.onCreateNote) {
            const createNoteBtn = toolbar.createEl("button", { cls: "ai-chat-tool-btn", attr: { "aria-label": "创建笔记" } });
            setIcon(createNoteBtn, "file-plus");
            createNoteBtn.addEventListener("click", () => {
                this.callbacks?.onCreateNote?.(message.content || "");
            });
        }

        // Regenerate (Only for assistant messages)
        if (message.role === 'assistant') {
            const regenBtn = toolbar.createEl("button", { cls: "ai-chat-tool-btn", attr: { "aria-label": "重新生成" } });
            setIcon(regenBtn, "refresh-cw");
            regenBtn.addEventListener("click", () => this.callbacks?.onRegenerate(index));
        }

        // Edit (Only for user messages)
        if (message.role === 'user') {
            const editBtn = toolbar.createEl("button", { cls: "ai-chat-tool-btn", attr: { "aria-label": "编辑" } });
            setIcon(editBtn, "edit");
            editBtn.addEventListener("click", () => this.callbacks?.onEdit(messageWrapper, index));
        }

        // Delete
        const deleteBtn = toolbar.createEl("button", { cls: "ai-chat-tool-btn", attr: { "aria-label": "删除" } });
        setIcon(deleteBtn, "trash");
        deleteBtn.addEventListener("click", () => this.callbacks?.onDelete(index));
    }

    private parseAssistantMessage(content: string): MessageSegment[] {
        const segments: MessageSegment[] = [];
        this.parseContentBlocks(content, segments);
        return segments;
    }
    
    private parseContentBlocks(content: string, segments: MessageSegment[]) {
        // 按行分割处理特殊块
        const lines = content.split('\n');
        let buffer = '';
        let inCodeBlock = false;
        let codeBlockLang = '';
        let codeBlockContent = '';
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            
            // 检测代码块开始/结束
            if (line.startsWith('```')) {
                if (!inCodeBlock) {
                    // 保存之前的文本
                    if (buffer.trim()) {
                        this.parseTextBuffer(buffer, segments);
                        buffer = '';
                    }
                    inCodeBlock = true;
                    codeBlockLang = line.slice(3).trim();
                    codeBlockContent = '';
                } else {
                    // 代码块结束
                    inCodeBlock = false;
                    
                    // 检查是否是执行计划 JSON
                    if (codeBlockLang === 'json' && codeBlockContent.includes('"goal"') && codeBlockContent.includes('"steps"')) {
                        segments.push({ type: 'plan' as any, content: codeBlockContent });
                    } else {
                        // 普通代码块，保留原样
                        buffer += '```' + codeBlockLang + '\n' + codeBlockContent + '```\n';
                    }
                    codeBlockLang = '';
                    codeBlockContent = '';
                }
                continue;
            }
            
            if (inCodeBlock) {
                codeBlockContent += line + '\n';
            } else {
                buffer += line + '\n';
            }
        }
        
        // 处理剩余内容
        if (buffer.trim()) {
            this.parseTextBuffer(buffer, segments);
        }
    }

    private parseTextBuffer(text: string, segments: MessageSegment[]) {
        // 处理思考链
        const thoughtRegex = /<thought>([\s\S]*?)<\/thought>/g;
        let lastIndex = 0;
        let match;

        while ((match = thoughtRegex.exec(text)) !== null) {
            if (match.index > lastIndex) {
                const before = text.substring(lastIndex, match.index);
                this.parseOtherContent(before, segments);
            }
            segments.push({ type: 'thought', content: match[1] });
            lastIndex = thoughtRegex.lastIndex;
        }

        if (lastIndex < text.length) {
            this.parseOtherContent(text.substring(lastIndex), segments);
        }
    }

    private parseOtherContent(text: string, segments: MessageSegment[]) {
        // 检测步骤块
        const stepRegex = /(【步骤\s*\d+\/\d+[^】]*】[^\n]*(?:\n(?!【步骤)[^\n]*)*)/g;
        // 检测工具调用块
        const toolRegex = /(\[MCP\][^\n]*(?:\n(?!\[MCP\]|\n\n)[^\n]*)*)/g;
        
        let remaining = text;
        let result: MessageSegment[] = [];
        
        // 按顺序解析
        const parts: { start: number; end: number; type: string; content: string }[] = [];
        
        let m;
        while ((m = stepRegex.exec(text)) !== null) {
            parts.push({ start: m.index, end: m.index + m[0].length, type: 'step', content: m[1] });
        }
        
        stepRegex.lastIndex = 0;
        
        // 按位置排序
        parts.sort((a, b) => a.start - b.start);
        
        let pos = 0;
        for (const part of parts) {
            if (part.start > pos) {
                const before = text.substring(pos, part.start).trim();
                if (before) {
                    segments.push({ type: 'text', content: before });
                }
            }
            segments.push({ type: part.type as any, content: part.content });
            pos = part.end;
        }
        
        // 只有当有 parts 时才处理剩余内容，否则在下面统一处理
        if (parts.length > 0 && pos < text.length) {
            const after = text.substring(pos).trim();
            if (after) {
                segments.push({ type: 'text', content: after });
            }
        }
        
        // 当没有找到任何特殊块时，直接添加整个文本
        if (parts.length === 0 && text.trim()) {
            segments.push({ type: 'text', content: text });
        }
    }

    private renderReferences(container: HTMLElement, references: any[]) {
        const refContainer = container.createDiv({ cls: "ai-chat-references" });
        const details = refContainer.createEl("details");
        const summary = details.createEl("summary", { text: `📚 参考资料 (${references.length})`, cls: "ai-chat-references-title" });
        
        if (references.length <= 3) {
            details.open = true;
        }

        const list = details.createEl("ul");
        
        references.forEach((ref, index) => {
            const li = list.createEl("li");
            const linkTarget = ref.subpath ? `${ref.path}${ref.subpath}` : ref.path;
            const link = li.createEl("a", { text: `[${index + 1}] ${ref.title}`, cls: "internal-link", attr: { "data-href": linkTarget } });
            link.addEventListener("click", (e) => {
                e.preventDefault();
                this.app.workspace.openLinkText(linkTarget, "", false);
            });
            li.createSpan({ text: ` (相似度: ${(ref.score * 100).toFixed(1)}%)`, cls: "ai-chat-ref-score" });
        });
    }

    /**
     * 获取当前激活角色的头像
     * 支持 URL、Base64、vault 路径
     */
    private getActivePersonaAvatar(): string | null {
        const activePersonaId = this.plugin.settings.activePersonaId;
        if (!activePersonaId) return null;
        
        const persona = this.plugin.settings.personas.find(p => p.id === activePersonaId);
        if (!persona?.avatar) return null;
        
        const avatar = persona.avatar;
        
        // URL 或 Base64 直接返回
        if (avatar.startsWith('http') || avatar.startsWith('data:')) {
            return avatar;
        }
        
        // vault 路径转换为资源路径
        return this.app.vault.adapter.getResourcePath(avatar);
    }
}
