import { ItemView, WorkspaceLeaf, App, TFile, TFolder, MarkdownRenderer, MarkdownView, Notice, setIcon, SuggestModal, Modal, Platform } from "obsidian";
import { structuredPatch, applyPatch, ParsedDiff, Hunk } from 'diff';
import { ChatMessage, ConversationModelSource, AgentRunSnapshot } from "../../core/types";
import AiChatAssistantPlugin from "../../../main";;
import { ConversationTemplate } from "../../core/settings";
import { IAiChatView, Conversation, ContextItem, AssistantMessageSegment, AssistantSegmentType, UiDiffHunk, DiffLine, NewConversationOptions, DiffComputationResult } from "../../core/types";
import { ConversationManagerModal } from "../modals/ConversationManagerModal";
import { NewConversationModal } from "../modals/NewConversationModal";
import { TemplateManagerModal } from "../modals/TemplateManagerModal";
import { RolePickerModal } from "../modals/RolePickerModal";
import { ConversationSuggestModal, ContextSuggestModal, CandidateFileSuggestModal, VaultFilePickerModal, SlashCommandSuggestModal, SlashCommand } from "../modals/SuggestionModals";
import { DiffReviewModal, ConflictModal, NoteModificationModal, SegmentSelectionModal } from "../modals/DiffModals";
import { MessageRenderer } from "../components/chat/MessageRenderer";
import { InputManager } from "../components/chat/InputManager";
import { SearchableModelSelect, ModelOption } from "../components/SearchableModelSelect";
import { estimateTokensFromMessages, estimateTokensFromText, formatTokenCountCompact } from "../../core/tokenEstimate";
import type { TodoItem } from "../../core/types";
import { safeNotice } from "../../utils/notice";
import { getBuiltinToolPolicies } from "../../features/agent/ToolPolicy"; // 暂保留用于后续工具策略 UI
import { isPdf, extractPdfTextFormatted } from "../../utils/pdfExtractor";
import { logger } from "../../core/logger";
import { extractWikilinks, extractContextBlocks, extractConversationTargetInfo, extractRoleplayDataBlock, tryParseTodoListFromToolOutput } from "./chat-helpers";
import { ConversationListPanel } from "./ConversationListPanel";
import { SkillAwareAgent } from "../../features/agent-v2";

export const VIEW_TYPE_AI_CHAT = "ai-chat-view";

// Keep transient UI state across view recreation (e.g. switching the right leaf between LogView and ChatView).
// Keyed by conversation id.
type ChatScrollState = {
  top: number;
  ratio: number; // top / maxScrollTop
  atBottom: boolean;
  updatedAt: number;
  anchorIndex?: number;
  anchorOffset?: number; // scrollElTop - anchorMsgTop (px), can be negative
};
const chatScrollStateCache = new Map<string, ChatScrollState>();

type IndexedHunk = Hunk & { __index?: number };

interface MultiFileSection {
  id: string;
  title: string;
  body: string;
  fileHint?: string;
}

// Helper Modals
class NoteSuggestModal extends SuggestModal<TFile> {
    onChoose: (file: TFile) => void;

    constructor(app: App, onChoose: (file: TFile) => void) {
        super(app);
        this.onChoose = onChoose;
    }

    getSuggestions(query: string): TFile[] {
        const files = this.app.vault.getMarkdownFiles();
        return files.filter(file => file.path.toLowerCase().includes(query.toLowerCase()));
    }

    renderSuggestion(file: TFile, el: HTMLElement) {
        el.createEl("div", { text: file.basename });
        el.createEl("small", { text: file.path });
    }

    onChooseSuggestion(file: TFile, evt: MouseEvent | KeyboardEvent) {
        this.onChoose(file);
    }
}

class NoteTitleInputModal extends Modal {
    result: string | null = null;
    onSubmit: (result: string) => void;
    placeholder: string;

    constructor(app: App, placeholder: string, onSubmit: (result: string) => void) {
        super(app);
        this.placeholder = placeholder;
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h2", { text: "输入笔记标题" });

        const input = contentEl.createEl("input", { type: "text", value: this.placeholder });
        input.select();

        const btn = contentEl.createEl("button", { text: "确定" });
        btn.onclick = () => {
            this.onSubmit(input.value);
            this.close();
        };
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

type ChatEntryMode = 'chat' | 'search' | 'agent' | 'collaboration' | 'groupchat';

export class AiChatView extends ItemView implements IAiChatView {
  private plugin: AiChatAssistantPlugin;
  private conversations: Record<string, Conversation> = {};
  private activeConversationId: string | null = null;
  private chatContainer!: HTMLElement;
  private contextContainer!: HTMLElement;
  private contextItems: ContextItem[] = [];
  private conversationListEl: HTMLElement | null = null;
  private conversationListPanel!: ConversationListPanel;
  private topTokenBadgeEl: HTMLElement | null = null;
  private topRoleplayStateBadgeEl: HTMLElement | null = null;
  
  // New Components
  private messageRenderer!: MessageRenderer;
  private inputManager!: InputManager;

  private modelSelectEl!: HTMLSelectElement;
  private searchableModelSelect: SearchableModelSelect | null = null;
  private personaSelectEl!: HTMLButtonElement;
  private chatMode: 'normal' | 'kb' | 'agent' | 'collaboration' | 'groupchat' = 'normal';
  /** 标志：是否正在切换模式，用于防止递归调用 */
  private isSwitchingMode = false;
  /** 记住每个模式下最后使用的对话 ID，用于模式切换时恢复 */
  private lastConversationByMode: Record<string, string> = {};

  // 群聊相关状态
  private groupChatManager?: any; // GroupChatManager
  private activeGroupRoomId: string | null = null;
  private activeGroupConversation: any | null = null; // GroupConversation
  private isGroupChatAutoMode = false;

  private entrySelectEl?: HTMLSelectElement;
  private applyEntryMode?: (entry: string, options?: { persist?: boolean; skipConversationSwitch?: boolean }) => Promise<void>;
  private compactActionMode = false;
  private actionMediaQuery: MediaQueryList | null = null;
  private actionMediaQueryListener?: (event: MediaQueryListEvent) => void;
  private actionResizeObserver?: ResizeObserver;
  private lastActionPanelWidth = 999;
  private latestAgentRunSnapshot: AgentRunSnapshot | null = null;
  private lastActionModelSource: ConversationModelSource | undefined;
  private restoreRunId = 0;
  private lastUserScrollAt = 0;
  private suppressCaptureUntil = 0;
  private lastAutoRestoreAt = 0;
  
  // 防止在消息处理过程中重复渲染
  private isProcessingMessage = false;

  // Agent v2 (skill-first architecture)
  private _agentV2: SkillAwareAgent | null = null;
  private get agentV2(): SkillAwareAgent {
    if (!this._agentV2) {
      this._agentV2 = new SkillAwareAgent(this.plugin as any);
    }
    return this._agentV2;
  }

  // 标记对话数据是否已从磁盘加载完毕，防止在加载前意外执行保存操作
  private conversationsReady = false;

  // 记录最后活动的 Markdown 编辑器，用于插入内容时定位
  private lastActiveMarkdownLeaf: WorkspaceLeaf | null = null;
  private lastActiveMarkdownFile: TFile | null = null;
  private currentNoteFilePath: string | null = null;

  private isThisLeafActive(): boolean {
    try {
      return this.app.workspace.activeLeaf === this.leaf;
    } catch {
      return false;
    }
  }

  private getActiveScrollEl(): HTMLElement | null {
    // Prefer chatContainer, but fall back to the nearest scrollable ancestor.
    const start = this.chatContainer as HTMLElement | undefined;
    if (!start) return null;

    const isScrollable = (el: HTMLElement) => {
      const style = window.getComputedStyle(el);
      const overflowY = style.overflowY;
      const canScroll = (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay');
      return canScroll && el.scrollHeight > el.clientHeight + 1;
    };

    const isOverflowing = (el: HTMLElement) => el.scrollHeight > el.clientHeight + 1;

    if (isScrollable(start)) return start;

    // Walk up through view containers. On mobile, the real scroll container is often `contentEl` or `containerEl`.
    const stops: Array<HTMLElement | null | undefined> = [
      this.contentEl,
      // @ts-ignore - ItemView has containerEl at runtime
      (this as any).containerEl as HTMLElement | undefined,
    ];

    let cur: HTMLElement | null = start;
    const seen = new Set<HTMLElement>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      if (isScrollable(cur)) return cur;
      if (stops.includes(cur)) break;
      cur = cur.parentElement;
    }

    // If none match overflow styles, fall back to the first overflowing ancestor (some Obsidian containers scroll with non-standard overflow values).
    cur = start;
    seen.clear();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      if (isOverflowing(cur)) return cur;
      if (stops.includes(cur)) break;
      cur = cur.parentElement;
    }

    // One more level above containerEl/contentEl (some themes nest a scrolling wrapper outside the view root).
    for (const stop of stops) {
      const parent = stop?.parentElement as HTMLElement | null;
      if (parent && isScrollable(parent)) return parent;
      if (parent && isOverflowing(parent)) return parent;
    }

    // On mobile, scrolling can fall back to the document scroller.
    const docScrollEl = (document.scrollingElement as HTMLElement | null);
    if (docScrollEl && (isScrollable(docScrollEl) || isOverflowing(docScrollEl))) return docScrollEl;

    // As a last resort, if chatContainer isn't scrollable yet (content not rendered), return it anyway.
    return start;
  }

  private captureScrollForConversation(conversationId: string) {
    if (Date.now() < this.suppressCaptureUntil) return;
    const scrollEl = this.getActiveScrollEl();
    if (!scrollEl) return;

    // On mobile, when the leaf is not visible, Obsidian may collapse the view (0 height),
    // which would overwrite a valid scroll state with zeros. Ignore those samples.
    if (scrollEl.clientHeight <= 0 || scrollEl.scrollHeight <= 0) return;

    const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
    const top = scrollEl.scrollTop;
    const ratio = maxScrollTop > 0 ? top / maxScrollTop : 0;
    const atBottom = maxScrollTop > 0 ? (maxScrollTop - top) <= 4 : true;

    // Anchor: find the first visible message element inside the scroll viewport.
    let anchorIndex: number | undefined;
    let anchorOffset: number | undefined;
    try {
      const scrollRect = scrollEl.getBoundingClientRect();
      if (scrollRect.height <= 0) {
        // Not laid out (hidden); skip anchor capture.
        throw new Error('scrollRect not ready');
      }
      const messages = Array.from(this.chatContainer?.querySelectorAll<HTMLElement>('.ai-chat-message') ?? []);
      for (const el of messages) {
        const rect = el.getBoundingClientRect();
        // First element that intersects viewport (bottom below top).
        if (rect.bottom > scrollRect.top + 1) {
          const idxStr = el.dataset.index;
          const idx = idxStr ? Number(idxStr) : NaN;
          if (Number.isNaN(idx)) {
            // Skip transient elements (e.g., thinking/streaming placeholders).
            continue;
          }
          anchorIndex = idx;
          anchorOffset = scrollRect.top - rect.top;
          break;
        }
      }
    } catch {
      // ignore
    }

    chatScrollStateCache.set(conversationId, {
      top,
      ratio,
      atBottom,
      updatedAt: Date.now(),
      anchorIndex,
      anchorOffset,
    });
  }

  private restoreScrollForConversation(conversationId: string) {
    const scrollEl = this.getActiveScrollEl();
    if (!scrollEl) return;

    const state = chatScrollStateCache.get(conversationId);
    const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);

    if (!state) {
      // No saved state yet: default to bottom (chat-friendly).
      this.suppressCaptureUntil = Date.now() + 200;
      scrollEl.scrollTop = maxScrollTop;
      return;
    }

    if (state.atBottom) {
      this.suppressCaptureUntil = Date.now() + 200;
      scrollEl.scrollTop = maxScrollTop;
      return;
    }

    // Prefer anchor-based restore (more stable under async rendering / image loads).
    if (typeof state.anchorIndex === 'number') {
      const anchorEl = this.chatContainer?.querySelector<HTMLElement>(`.ai-chat-message[data-index="${state.anchorIndex}"]`);
      if (anchorEl) {
        // IMPORTANT: Avoid scrollIntoView() on mobile because it may scroll an inner container
        // and leave the real scroll container (often document.scrollingElement) unchanged.
        const desiredOffset = -(state.anchorOffset ?? 0); // anchorRect.top - scrollRect.top
        try {
          const scrollRect = scrollEl.getBoundingClientRect();
          const anchorRect = anchorEl.getBoundingClientRect();
          const currentOffset = anchorRect.top - scrollRect.top;
          const delta = currentOffset - desiredOffset;
          const nextTop = Math.min(maxScrollTop, Math.max(0, scrollEl.scrollTop + delta));
          this.suppressCaptureUntil = Date.now() + 200;
          scrollEl.scrollTop = nextTop;
        } catch {
          // Fallback to best-effort stored top.
          const desiredFromTop = Math.min(state.top, maxScrollTop);
          this.suppressCaptureUntil = Date.now() + 200;
          scrollEl.scrollTop = desiredFromTop;
        }
        return;
      }
    }

    // Prefer absolute top, but if layout changed a lot, ratio is a safer fallback.
    const desiredFromTop = Math.min(state.top, maxScrollTop);
    const desiredByRatio = Math.min(maxScrollTop, Math.max(0, Math.round(state.ratio * maxScrollTop)));

    // If saved top would clamp heavily (content shrunk), use ratio.
    const desired = (state.top > maxScrollTop && maxScrollTop > 0) ? desiredByRatio : desiredFromTop;
    this.suppressCaptureUntil = Date.now() + 200;
    scrollEl.scrollTop = desired;
  }

  private scheduleRestoreScroll(conversationId: string) {
    // Content height/scroll container can change after activation on mobile; keep re-applying until stable.
    const runId = ++this.restoreRunId;
    let stableTicks = 0;
    let lastSig = '';

    const isMobile = Platform?.isMobileApp ?? Platform?.isMobile ?? false;
    const maxDurationMs = isMobile ? 10_000 : 2_500;
    const stableNeeded = isMobile ? 24 : 12;

    const computeError = (el: HTMLElement) => {
      const state = chatScrollStateCache.get(conversationId);
      const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
      if (!state) return Math.abs(maxScrollTop - el.scrollTop);
      if (state.atBottom) return Math.abs(maxScrollTop - el.scrollTop);
      if (typeof state.anchorIndex === 'number') {
        const anchorEl = this.chatContainer?.querySelector<HTMLElement>(`.ai-chat-message[data-index="${state.anchorIndex}"]`);
        if (anchorEl) {
          const desiredOffset = -(state.anchorOffset ?? 0);
          try {
            const scrollRect = el.getBoundingClientRect();
            const anchorRect = anchorEl.getBoundingClientRect();
            const currentOffset = anchorRect.top - scrollRect.top;
            return Math.abs(currentOffset - desiredOffset);
          } catch {
            return Math.abs(Math.min(state.top, maxScrollTop) - el.scrollTop);
          }
        }
      }
      return Math.abs(Math.min(state.top, maxScrollTop) - el.scrollTop);
    };

    const applyOnce = () => {
      if (this.restoreRunId !== runId) return;
      const el = this.getActiveScrollEl();
      if (!el) return;

      // When the view is hidden/collapsed on mobile, dimensions can be 0; wait until it's laid out.
      if (el.clientHeight <= 0 || el.scrollHeight <= 0) {
        stableTicks = 0;
        return;
      }

      this.restoreScrollForConversation(conversationId);

      const sig = `${el.scrollHeight}|${el.clientHeight}|${el.scrollTop}`;
      const err = computeError(el);
      if (err <= 2) stableTicks += 1;
      else stableTicks = 0;
      lastSig = sig;
    };

    const startedAt = Date.now();
    const rafLoop = () => {
      if (this.restoreRunId !== runId) return;
      applyOnce();
      // Allow longer window on mobile (Obsidian may reset scroll after leaf activation/layout).
      const elapsed = Date.now() - startedAt;
      if (elapsed < maxDurationMs && stableTicks < stableNeeded) requestAnimationFrame(rafLoop);
    };
    requestAnimationFrame(rafLoop);

    // Delayed "extra punches" for mobile: some layouts reset scrollTop after animations/layout.
    window.setTimeout(() => {
      if (this.restoreRunId !== runId) return;
      applyOnce();
    }, 3500);
    window.setTimeout(() => {
      if (this.restoreRunId !== runId) return;
      applyOnce();
    }, 7000);

    // Observe chat container mutations (message render, image load placeholders, etc.)
    const mo = new MutationObserver(() => applyOnce());
    const ro = new ResizeObserver(() => applyOnce());
    try { mo.observe(this.chatContainer, { childList: true, subtree: true, characterData: true }); } catch {}
    try { ro.observe(this.chatContainer); } catch {}
    window.setTimeout(() => {
      if (this.restoreRunId !== runId) return;
      mo.disconnect();
      ro.disconnect();
    }, maxDurationMs + 200);
  }

  private captureActiveConversationScroll() {
    if (!this.activeConversationId) return;
    this.captureScrollForConversation(this.activeConversationId);
  }

  private restoreActiveConversationScrollOrBottom() {
    if (!this.activeConversationId) return;
    this.scheduleRestoreScroll(this.activeConversationId);
  }

  constructor(leaf: WorkspaceLeaf, plugin: AiChatAssistantPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  public async saveSettings() {
    await this.plugin.saveSettings();
  }

  private insertContent(content: string) {
      this.insertTextAtCursor(content);
  }

  getViewType(): string {
    return VIEW_TYPE_AI_CHAT;
  }

  getDisplayText(): string {
    return "AI 聊天助手";
  }

  getIcon(): string {
    return 'message-circle';
  }

  public getConversationTemplates(): ConversationTemplate[] {
    const templates = this.plugin.settings.conversationTemplates;
    return Array.isArray(templates) ? templates : [];
  }

  public getConversations(): Record<string, Conversation> {
    return this.conversations;
  }

  public debugDumpScroll(): string {
    const lines: string[] = [];
    const convId = this.activeConversationId;
    lines.push(`[ai-chat] scroll debug @ ${new Date().toISOString()}`);
    lines.push(`activeConversationId: ${convId ?? '(none)'}`);

    const describeEl = (label: string, el: HTMLElement | null | undefined) => {
      if (!el) {
        lines.push(`${label}: (null)`);
        return;
      }
      const style = window.getComputedStyle(el);
      const cls = (el.className || '').toString().trim();
      const id = (el.id || '').toString().trim();
      lines.push(`${label}: <${el.tagName.toLowerCase()}>${id ? `#${id}` : ''}${cls ? `.${cls.split(/\s+/).join('.')}` : ''}`);
      let rectH = 0;
      try { rectH = Math.round(el.getBoundingClientRect().height); } catch { rectH = 0; }
      lines.push(`  isConnected=${(el as any).isConnected ?? '(n/a)'} rectH=${rectH}`);
      lines.push(`  display=${style.display} visibility=${style.visibility} overflowY=${style.overflowY}`);
      lines.push(`  scrollTop=${Math.round(el.scrollTop)} clientHeight=${Math.round(el.clientHeight)} scrollHeight=${Math.round(el.scrollHeight)}`);
    };

    describeEl('chatContainer', this.chatContainer);
    describeEl('activeScrollEl', this.getActiveScrollEl());
    describeEl('document.scrollingElement', document.scrollingElement as HTMLElement | null);

    if (convId) {
      const state = chatScrollStateCache.get(convId);
      if (!state) {
        lines.push('savedState: (none)');
      } else {
        lines.push(`savedState: top=${Math.round(state.top)} ratio=${state.ratio.toFixed(4)} atBottom=${state.atBottom} updatedAt=${new Date(state.updatedAt).toISOString()}`);
        lines.push(`  anchorIndex=${state.anchorIndex ?? '(none)'} anchorOffset=${state.anchorOffset ?? '(none)'}`);
        if (typeof state.anchorIndex === 'number') {
          const anchorEl = this.chatContainer?.querySelector<HTMLElement>(`.ai-chat-message[data-index="${state.anchorIndex}"]`);
          if (anchorEl) {
            try {
              const r = anchorEl.getBoundingClientRect();
              lines.push(`  anchorRect: top=${Math.round(r.top)} bottom=${Math.round(r.bottom)} height=${Math.round(r.height)}`);
            } catch {
              lines.push('  anchorRect: (error)');
            }
          } else {
            lines.push('  anchorEl: (not found in DOM)');
          }
        }
      }
    }

    return lines.join('\n');
  }

  public createNewConversation(options?: NewConversationOptions) {
    const now = Date.now();
    const registry = Array.isArray((this.plugin.settings as any).modelRegistry) ? (this.plugin.settings as any).modelRegistry : [];
    const registryFirst = registry.length > 0 ? String(registry[0]?.model || '').trim() : '';
    const fallbackModel = String((this.plugin.settings as any).defaultChatModel || '').trim()
      || registryFirst
      || this.plugin.settings.chatModels.split(',').map(m => m.trim()).find(Boolean)
      || 'gpt-3.5-turbo';
    const normalizeTags = (tags?: string[]) => Array.from(new Set((tags ?? []).map(tag => tag.trim()).filter(Boolean)));

    // 根据当前chatMode确定uiEntryMode，而不是依赖下拉框的值
    const modeToEntry: Record<string, string> = {
      'normal': 'chat',
      'kb': 'search',
      'agent': 'agent',
      'collaboration': 'collaboration',
      'groupchat': 'groupchat',
    };
    const fallbackEntry = this.normalizeEntryMode(modeToEntry[this.chatMode] || (this.entrySelectEl?.value || '').trim() || 'chat');
    const resolvedModel = this.plugin.resolveConversationModel(undefined, this.chatMode === 'kb' ? 'search' : this.chatMode === 'groupchat' ? 'normal' : this.chatMode, this.chatMode === 'agent' ? this.plugin.settings.activeAgentId : undefined);
    const conversation: Conversation = {
      id: `conv-${now}`,
      title: options?.title?.trim() || `新对话 ${new Date(now).toLocaleTimeString()}`,
      history: [],
      historyLoaded: true,
      model: resolvedModel.model,
      pinned: false,
      starred: false,
      archived: false,
      tags: normalizeTags(options?.tags),
      templateId: null,
      createdAt: now,
      updatedAt: now,
      personaId: this.plugin.settings.activePersonaId,
      // 如果当前是智能体模式，记录智能体ID
      agentId: this.chatMode === 'agent' ? this.plugin.settings.activeAgentId : undefined,
      toolPolicyId: this.chatMode === 'agent' ? this.plugin.resolveConversationToolPolicy(undefined, this.plugin.settings.activeAgentId) : undefined,
      modelSource: resolvedModel.source,
      uiEntryMode: fallbackEntry,
    };

    // 根据当前模式选择正确的开场白
    let greeting = '';
    if (this.chatMode === 'agent') {
      // 智能体模式：使用智能体的开场白
      const activeAgent = this.plugin.agentManager.getAgent(this.plugin.settings.activeAgentId);
      greeting = (activeAgent as any)?.greeting || '';
    } else {
      // 其他模式：使用角色的开场白
      const activePersona = this.plugin.settings.personas.find(p => p.id === this.plugin.settings.activePersonaId);
      greeting = (activePersona as any)?.greeting || '';
    }
    // 替换 {{user}} 和 {{char}} 占位符
    if (greeting) {
      greeting = this.plugin.replacePromptPlaceholders(greeting);
    }
    if (greeting) {
      conversation.history.push({ role: 'assistant', content: String(greeting) });
    }

    this.conversations[conversation.id] = conversation;

    this.activeConversationId = conversation.id;
    this.plugin.setActiveConversationId(this.activeConversationId);
    this.resetContextItemsExceptAuto();

    void this.renderConversation(conversation);
    this.updateContextTokenBadge(conversation);
    if (this.searchableModelSelect) this.searchableModelSelect.setValue(conversation.model);
    this.renderConversationList();
    this.saveConversations();
    this.inputManager.setText('');
    this.inputManager.focus();
  }

  private resetContextItemsExceptAuto() {
    const autoItem = this.contextItems.find(item => item.path === 'current-note-auto');
    this.contextItems = autoItem ? [autoItem] : [];
    this.renderContextItems();
  }

  // --- 公开方法 ---
  public switchToConversation(id: string) {
    // 如果已经是当前对话，跳过切换
    if (this.activeConversationId === id && this.lastRenderedConversationId === id) {
      return;
    }
    
    // Save current scroll position before switching.
    this.captureActiveConversationScroll();

    this.activeConversationId = id;
    this.plugin.setActiveConversationId(id);
    const conversation = this.conversations[id];
    if (!conversation) return;
    this.syncGlobalSelectorsFromConversation(conversation);

    void (async () => {
      await this.plugin.ensureConversationHistoryLoaded(id);
      void this.renderConversation(conversation);

      this.restoreConversationEntryMode(conversation);

      if (this.searchableModelSelect) this.searchableModelSelect.setValue(conversation.model);
      // renderConversationList 仍然可以用来处理可能的UI状态，比如高亮
      this.renderConversationList();

      this.updateContextTokenBadge(conversation);
    })();
  }

  private getVisibleEntryModes(): ChatEntryMode[] {
    const visible: ChatEntryMode[] = ['chat', 'search', 'agent'];
    if (this.plugin.isCollaborationModeAvailable()) {
      visible.push('collaboration');
    }
    if (this.plugin.settings.enableExperimentalGroupChatMode) {
      visible.push('groupchat');
    }
    return visible;
  }

  private isEntryModeVisible(entry: ChatEntryMode): boolean {
    return this.getVisibleEntryModes().includes(entry);
  }

  private resolveVisibleEntryMode(entry: ChatEntryMode): ChatEntryMode {
    return this.isEntryModeVisible(entry) ? entry : 'chat';
  }

  private restoreConversationEntryMode(conversation: Conversation) {
    // 如果正在切换模式，不要恢复对话的模式（避免递归）
    if (this.isSwitchingMode) return;

    const normalized = this.getConversationEntryMode(conversation);
    const visibleEntry = this.resolveVisibleEntryMode(normalized);
    if (!this.entrySelectEl || !this.applyEntryMode) return;

    // Avoid firing native change event; we drive the switch explicitly.
    // 恢复对话模式时跳过对话切换，避免循环
    this.entrySelectEl.value = visibleEntry;
    void this.applyEntryMode(visibleEntry, { persist: false, skipConversationSwitch: true });
  }

  private normalizeEntryMode(value: string | null | undefined): 'chat' | 'search' | 'agent' | 'collaboration' | 'groupchat' {
    const raw = String(value || '').trim();
    const legacyMap: Record<string, 'chat' | 'search' | 'agent' | 'collaboration' | 'groupchat'> = {
      kb: 'search',
      acp: 'agent',
      'agent-general': 'agent',
      'agent-webparser': 'agent',
      'agent-notes': 'agent',
      'agent-writing': 'agent',
      webparser: 'agent',
      notes: 'agent',
      writing: 'agent',
    };
    const normalized = legacyMap[raw] || raw || 'chat';
    if (normalized === 'search' || normalized === 'agent' || normalized === 'collaboration' || normalized === 'groupchat') {
      return normalized;
    }
    return 'chat';
  }

  private entryModeToChatMode(entry: 'chat' | 'search' | 'agent' | 'collaboration' | 'groupchat'): 'normal' | 'kb' | 'agent' | 'collaboration' | 'groupchat' {
    switch (entry) {
      case 'search': return 'kb';
      case 'agent': return 'agent';
      case 'collaboration': return 'collaboration';
      case 'groupchat': return 'groupchat';
      default: return 'normal';
    }
  }

  private getConversationEntryMode(conversation: Conversation | null | undefined): 'chat' | 'search' | 'agent' | 'collaboration' | 'groupchat' {
    return this.normalizeEntryMode(conversation?.uiEntryMode);
  }

  private getConversationMode(conversation: Conversation | null | undefined): 'normal' | 'kb' | 'agent' | 'collaboration' | 'groupchat' {
    return this.entryModeToChatMode(this.getConversationEntryMode(conversation));
  }

  private syncGlobalSelectorsFromConversation(conversation: Conversation | null | undefined) {
    if (!conversation) return;
    const entryMode = this.getConversationEntryMode(conversation);
    if (entryMode === 'agent' && conversation.agentId) {
      if (this.plugin.settings.activeAgentId !== conversation.agentId) {
        this.plugin.settings.activeAgentId = conversation.agentId;
        void this.plugin.saveSettings();
      }
    } else if (entryMode !== 'agent') {
      const personaId = conversation.personaId || 'default';
      if (this.plugin.settings.activePersonaId !== personaId) {
        this.plugin.settings.activePersonaId = personaId;
        void this.plugin.saveSettings();
      }
    }
    if (conversation.toolPolicyId && this.plugin.settings.activePresetId !== conversation.toolPolicyId) {
      this.plugin.settings.activePresetId = conversation.toolPolicyId;
      void this.plugin.saveSettings();
    }
  }

  private findLatestConversationForEntry(entry: 'chat' | 'search' | 'agent' | 'collaboration' | 'groupchat', options?: { agentId?: string; personaId?: string }): Conversation | null {
    const mode = this.entryModeToChatMode(entry);
    const targetAgentId = String(options?.agentId || this.plugin.settings.activeAgentId || '').trim();
    const targetPersonaId = String(options?.personaId || this.plugin.settings.activePersonaId || 'default').trim() || 'default';
    const isDefaultPersona = targetPersonaId === 'default';
    const conversations = Object.values(this.conversations)
      .filter(c => {
        if (c.archived) return false;
        const convEntry = this.getConversationEntryMode(c);
        if (convEntry !== entry) return false;
        if (mode === 'agent') return c.agentId === targetAgentId;
        if (mode === 'groupchat') return true;
        if (isDefaultPersona) return !c.personaId || c.personaId === 'default';
        return c.personaId === targetPersonaId;
      })
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return conversations[0] || null;
  }

  private updateConversationRunSnapshot(snapshot: AgentRunSnapshot | null) {
    this.latestAgentRunSnapshot = snapshot;
    const conv = this.activeConversationId ? this.conversations[this.activeConversationId] : null;
    if (conv) {
      conv.agentRunSnapshot = snapshot || undefined;
    }
  }

  private renderRunSnapshot(snapshot: AgentRunSnapshot | null) {
    if (!snapshot || !this.inputManager) return;
    const phaseMap: Record<string, string> = {
      inspect: '正在查看上下文',
      act: '正在处理',
      repair: '正在修正结果',
      answer: '正在整理回复',
    };
    const phaseText = snapshot.phase ? (phaseMap[snapshot.phase] || '正在处理') : '正在处理';
    const detail = snapshot.lastVerificationSummary || snapshot.repairSummary || snapshot.lastToolSummary || '';
    const phaseProgress = snapshot.batchTotal && snapshot.batchTotal > 0
      ? ` ${Math.min(snapshot.batchCompleted || 0, snapshot.batchTotal)}/${snapshot.batchTotal}`
      : '';
    const currentTargetText = snapshot.currentTarget ? ` · 当前：${snapshot.currentTarget.replace(/\.md$/i, '')}` : '';
    const runningLabel = detail
      ? `${phaseText}${phaseProgress}${currentTargetText} · ${detail}`
      : `${phaseText}${phaseProgress}${currentTargetText}`;
    const businessLabel = snapshot.businessSummary || snapshot.lastVerificationSummary || snapshot.repairSummary || '';
    const completedBatchLabel = snapshot.completedTargets && snapshot.completedTargets.length > 0
      ? `已完成：${snapshot.completedTargets.map(name => name.replace(/\.md$/i, '')).join('、')}`
      : '';
    const finalReason = snapshot.abortReason || snapshot.stopReason || '';
    const normalizedFinalReason = /连续两轮未产生工具动作/.test(finalReason)
      ? '智能体未执行实际动作，已停止空转'
      : finalReason;
    const statusLabel = snapshot.status === 'running'
      ? runningLabel
      : [normalizedFinalReason, businessLabel, completedBatchLabel].filter(Boolean).join(' · ') || '已结束';
    this.inputManager.showProcessingState(statusLabel, () => {
      const controller = (this as any).currentAbortController as AbortController | undefined;
      controller?.abort();
      this.inputManager.hideProcessingState();
      this.inputManager.setDisabled(false);
      new Notice('已停止生成');
    });
  }

  private extractContextBlocks(contextContent: string): Array<{ key: string; content: string }> {
    return extractContextBlocks(contextContent);
  }

  private latestContextInjectionMeta: null | {
    selectedItems: number;
    totalBlocks: number;
    uniqueBlocks: number;
    injectedBlocks: number;
    injectedChars: number;
    maxBlocks: number;
    maxChars: number;
    truncatedByBlockLimit: boolean;
    truncatedByCharLimit: boolean;
  } = null;

  private buildStructuredContextContent(contextContent: string, implicitContext: string): string {
    return this.buildStructuredContextContentWithMeta(contextContent, implicitContext).text;
  }

  private buildStructuredContextContentWithMeta(
    contextContent: string,
    implicitContext: string
  ): {
    text: string;
    meta: {
      totalBlocks: number;
      uniqueBlocks: number;
      injectedBlocks: number;
      injectedChars: number;
      maxBlocks: number;
      maxChars: number;
      truncatedByBlockLimit: boolean;
      truncatedByCharLimit: boolean;
    };
  } {
    const MAX_BLOCKS = 12;
    const MAX_CHARS = 16000;

    const blocks = [
      ...this.extractContextBlocks(contextContent),
      ...this.extractContextBlocks(implicitContext),
    ];

    const seen = new Set<string>();
    const uniqueBlocks = blocks.filter(block => {
      if (!block.content) return false;
      if (seen.has(block.key)) return false;
      seen.add(block.key);
      return true;
    });

    const limited = uniqueBlocks.slice(0, MAX_BLOCKS);

    let charCount = 0;
    const rendered: string[] = [];
    let truncatedByCharLimit = false;

    for (const block of limited) {
      const remaining = MAX_CHARS - charCount;
      if (remaining <= 0) {
        truncatedByCharLimit = true;
        break;
      }
      const willTruncateThisBlock = block.content.length > remaining;
      const content = willTruncateThisBlock
        ? `${block.content.slice(0, Math.max(0, remaining - 32))}\n...[context truncated]`
        : block.content;
      if (willTruncateThisBlock) truncatedByCharLimit = true;

      rendered.push(`--- ${block.key} ---\n${content}`);
      charCount += content.length;
    }

    return {
      text: rendered.join('\n\n').trim(),
      meta: {
        totalBlocks: blocks.length,
        uniqueBlocks: uniqueBlocks.length,
        injectedBlocks: limited.length,
        injectedChars: charCount,
        maxBlocks: MAX_BLOCKS,
        maxChars: MAX_CHARS,
        truncatedByBlockLimit: uniqueBlocks.length > MAX_BLOCKS,
        truncatedByCharLimit,
      },
    };
  }

  private extractConversationTargetInfo(conversation: Conversation | null | undefined) {
    return extractConversationTargetInfo(conversation);
  }

  private extractWikilinks(text: string): string[] {
    return extractWikilinks(text);
  }

  private async buildImplicitContextForMessage(message: string): Promise<string> {
    let out = "";

    // 检查用户是否在UI中保留了当前笔记引用（current-note-auto）
    // 如果用户移除了这个引用，就不再添加当前笔记提示
    const hasCurrentNoteInContext = this.contextItems.some(item => item.path === 'current-note-auto');
    
    const active = this.app.workspace.getActiveFile();
    if (active && hasCurrentNoteInContext) {
      out += `--- 当前打开笔记: ${active.path} ---\n`;
    }

    // Inline wikilinks: include small excerpts so non-chat modes can “see” referenced notes.
    const refs = this.extractWikilinks(message);
    if (!refs.length) return out;

    out += `--- 引用提示 ---\n`;
    out += `用户消息中包含引用：${refs.map(r => `[[${r}]]`).join(' ')}\n`;
    out += `如果用户已用 [[...]] 指定目标，请优先使用这些引用来确定/读取/写入目标文件；不要先通过 list_files/search_notes 扫描笔记库结构来“找文件”。仅当引用无法解析或目标文件不存在时，才允许使用搜索类工具。\n`;

    const sourcePath = active?.path || "";
    const maxFiles = 3;
    const maxCharsPerFile = 5000;
    const maxTotal = 12000;
    let total = out.length;

    const resolved: string[] = [];

    for (const ref of refs.slice(0, maxFiles)) {
      const file = this.app.metadataCache.getFirstLinkpathDest(ref, sourcePath);
      if (!file) continue;
      if (file.extension !== 'md' && file.extension !== 'canvas' && !isPdf(file.extension)) continue;

      resolved.push(`${ref} -> ${file.path}`);

      try {
        let content: string;
        if (isPdf(file.extension)) {
          const buffer = await this.app.vault.readBinary(file);
          content = await extractPdfTextFormatted(buffer, file.name, 20, maxCharsPerFile);
        } else {
          content = await this.app.vault.cachedRead(file);
        }
        const clipped = content.length > maxCharsPerFile ? content.slice(0, maxCharsPerFile) + '…' : content;
        const block = `\n--- 引用笔记: ${file.path} ---\n${clipped}\n`;
        if (total + block.length > maxTotal) break;
        out += block;
        total += block.length;
      } catch {
        // ignore read errors
      }
    }

    if (resolved.length) {
      out += `\n--- 引用解析结果 ---\n${resolved.join('\n')}\n`;
    } else {
      out += `\n--- 引用解析结果 ---\n未能解析到任何可读取的目标文件。请确认引用名称是否存在，或直接给出完整路径（例如 folder/note.md）。\n`;
    }

    return out;
  }
  // --- 结束公开方法 ---

  async onOpen() {
    const container = this.contentEl;
    container.empty();
    container.addClass("ai-chat-view-container");

    // 防御性设置：确保父容器有 position: relative，让 absolute 布局生效
    // 某些主题或 Obsidian 版本的 .view-content 没有正确的高度/定位
    const parent = container.parentElement;
    if (parent) {
      parent.setCssStyles({ position: 'relative' });
      parent.setCssStyles({ overflow: 'hidden' });
    }

    // Top Bar
    const topBar = container.createDiv({ cls: "ai-chat-top-bar" });
    this.createTopBar(topBar);

    // Main Area
    const mainArea = container.createDiv({ cls: "ai-chat-main-area" });
    
    // Chat Area
    this.chatContainer = mainArea.createDiv({ cls: "ai-chat-history" });

    // Track scroll position so we can restore when the view gets recreated.
    this.registerDomEvent(this.chatContainer, 'scroll', () => {
      if (!this.activeConversationId) return;
      if (Date.now() < this.suppressCaptureUntil) return;
      // Only capture when this view is the active leaf; otherwise mobile pane switching can
      // trigger scroll resets (e.g. scrollTop=0) that would overwrite the real saved state.
      if (!this.isThisLeafActive()) return;
      this.lastUserScrollAt = Date.now();
      this.captureScrollForConversation(this.activeConversationId);
    });

    // Capture scroll from the actual scroll container even if it's not chatContainer.
    // scroll doesn't bubble, but it can be captured.
    this.registerDomEvent(this.contentEl, 'scroll', (evt: Event) => {
      if (!this.activeConversationId) return;
      if (Date.now() < this.suppressCaptureUntil) return;
      if (!this.isThisLeafActive()) return;
      const target = evt.target as HTMLElement | null;
      if (!target) return;
      const activeScrollEl = this.getActiveScrollEl();
      if (activeScrollEl && target === activeScrollEl) {
        this.lastUserScrollAt = Date.now();
        this.captureScrollForConversation(this.activeConversationId);
      }
    }, { capture: true, passive: true } as any);

    // On mobile, the scroll container can be outside contentEl; capture from containerEl as well.
    // @ts-ignore - ItemView has containerEl at runtime
    const viewContainerEl: HTMLElement | undefined = (this as any).containerEl;
    if (viewContainerEl) {
      this.registerDomEvent(viewContainerEl, 'scroll', (evt: Event) => {
        if (!this.activeConversationId) return;
        if (Date.now() < this.suppressCaptureUntil) return;
        if (!this.isThisLeafActive()) return;
        const target = evt.target as HTMLElement | null;
        if (!target) return;
        const activeScrollEl = this.getActiveScrollEl();
        if (activeScrollEl && target === activeScrollEl) {
          this.lastUserScrollAt = Date.now();
          this.captureScrollForConversation(this.activeConversationId);
        }
      }, { capture: true, passive: true } as any);
    }

    // Some mobile layouts scroll the document; capture window scroll too.
    this.registerDomEvent(window, 'scroll', () => {
      if (!this.activeConversationId) return;
      if (Date.now() < this.suppressCaptureUntil) return;
      if (!this.isThisLeafActive()) return;
      this.lastUserScrollAt = Date.now();
      this.captureScrollForConversation(this.activeConversationId);
    }, { passive: true } as any);

    this.messageRenderer = new MessageRenderer(this.app, this.plugin, this.chatContainer, {
      onRegenerate: (index) => this.regenerateResponse(index),
      onEdit: (el, index) => this.editMessage(el, index),
      onDelete: (index) => this.deleteMessage(index),
      onInsert: (content) => this.insertTextAtCursor(content),
      onCreateNote: (content) => this.createNoteFromContent(content),
      getAvatar: () => {
         if (this.chatMode === 'agent' || this.chatMode === 'kb') {
             return null; 
         }
         const activePersonaId = this.plugin.settings.activePersonaId;
         if (!activePersonaId) return null;
         const persona = this.plugin.settings.personas.find(p => p.id === activePersonaId);
         if (!persona?.avatar) return null;
         const avatar = persona.avatar;
         if (avatar.startsWith('http') || avatar.startsWith('data:')) {
             return avatar;
         }
         return this.app.vault.adapter.getResourcePath(avatar);
      }
    });

    // Context Panel (Hidden by default)
    this.contextContainer = mainArea.createDiv({ cls: "ai-chat-context-panel" });
    this.contextContainer.setCssStyles({ display: "none" });

    // Input Area
    const inputAreaContainer = container.createDiv({ cls: "ai-chat-input-container" });
    this.inputManager = new InputManager(this.app, this.plugin, inputAreaContainer);

    this.inputManager.setOnDraftChange((draft) => {
      if (!this.activeConversationId) return;
      const conv = this.conversations[this.activeConversationId];
      if (!conv) return;
      this.updateContextTokenBadge(conv, draft);
    });
    
    this.inputManager.onSubmit((text, images) => {
        this.handleUserMessage(text, images);
    });

    this.inputManager.setOnContextSelect(() => {
        new ContextSuggestModal(this.app, (item) => {
            this.addContextItem(item);
        }).open();
    });

    // Slash command template support
    this.inputManager.setGetTemplates(() => this.getConversationTemplates());

    // 延迟加载对话数据，让视图先渲染出来（提升移动端侧滑流畅度）
    requestAnimationFrame(async () => {
      await this.loadConversations();
      
      // 根据当前 persona 过滤对话，避免先显示其他角色对话再切换
      const activePersonaId = this.plugin.settings.activePersonaId;
      const isDefaultPersona = activePersonaId === 'default' || !activePersonaId;
      
      const availableConvs = Object.values(this.conversations).filter(c => {
        if (c.archived) return false;
        if (isDefaultPersona) {
          return c.personaId === 'default' || !c.personaId;
        }
        return c.personaId === activePersonaId;
      });
      
      if (availableConvs.length === 0) {
        this.createNewConversation();
      } else {
        // 优先恢复上次活跃的对话
        const lastId = this.plugin.getActiveConversationId();
        const lastConv = lastId ? availableConvs.find(c => c.id === lastId) : null;
        if (lastConv) {
          this.switchToConversation(lastConv.id);
        } else {
          const sorted = [...availableConvs].sort((a, b) => ConversationListPanel.compare(a, b));
          this.switchToConversation(sorted[0].id);
        }
      }
    });

    // When switching between panes/leaves, persist & restore scroll for this view.
    this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
      if (!leaf) return;
      
      // 记录最后活动的 Markdown 编辑器（在切换到聊天视图之前）
      // 这样插入内容时可以定位到用户之前编辑的笔记
      if (leaf !== this.leaf && leaf.view instanceof MarkdownView) {
        this.lastActiveMarkdownLeaf = leaf;
        this.lastActiveMarkdownFile = leaf.view.file;
      }
      
      if (leaf === this.leaf) {
        this.restoreActiveConversationScrollOrBottom();
      } else {
        // Do not capture on losing focus: on mobile Obsidian may reset scrollTop during
        // leaf switches, which would overwrite a valid saved position.
      }
    }));

    // Some mobile transitions do not trigger active-leaf-change (same leaf, different view state),
    // but they do trigger layout recalculations. Use those as an additional restore trigger.
    this.registerEvent(this.app.workspace.on('layout-change', () => {
      if (!this.activeConversationId) return;
      if (!this.isThisLeafActive()) return;
      this.restoreActiveConversationScrollOrBottom();
    }));

    this.registerDomEvent(window, 'resize', () => {
      if (!this.activeConversationId) return;
      if (!this.isThisLeafActive()) return;
      this.restoreActiveConversationScrollOrBottom();
    }, { passive: true } as any);

    // Guard against late scrollTop resets on mobile: if scroll snaps to top while we have
    // a deep savedState and the user hasn't interacted, re-apply restore.
    this.registerInterval(window.setInterval(() => {
      const convId = this.activeConversationId;
      if (!convId) return;
      if (!this.isThisLeafActive()) return;
      const scrollEl = this.getActiveScrollEl();
      if (!scrollEl) return;
      if (scrollEl.clientHeight <= 0 || scrollEl.scrollHeight <= 0) return;
      const state = chatScrollStateCache.get(convId);
      if (!state) return;

      const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
      const desiredTop = state.atBottom
        ? maxScrollTop
        : Math.min(maxScrollTop, Math.max(0, state.top));

      // Consider it a bad reset if we're at (near) top but desiredTop is far down.
      const looksResetToTop = scrollEl.scrollTop <= 2 && desiredTop >= 80;
      const userIdleMs = Date.now() - this.lastUserScrollAt;
      const sinceAutoRestoreMs = Date.now() - this.lastAutoRestoreAt;
      if (looksResetToTop && userIdleMs > 800 && sinceAutoRestoreMs > 1200) {
        this.lastAutoRestoreAt = Date.now();
        this.scheduleRestoreScroll(convId);
      }
    }, 500));

    // 注册事件，自动处理当前笔记上下文
    this.registerEvent(this.app.workspace.on('file-open', (file) => this.handleFileOpen(file)));
    // 首次打开时，立即处理一次
    this.handleFileOpen(this.app.workspace.getActiveFile());

    // (Removed duplicated initialization block)
    
  }

  // 这个方法现在是可选的，因为列表主要在 Modal 中。
  // 但为了避免在 switchToConversation 中出错，我们保留它，并让它安全地失败。
  private createConversationPanel(parent: HTMLElement) {
    const header = parent.createEl("div", { cls: "ai-chat-conversation-header" });
    header.createEl("h4", { text: "对话列表" });
    header.createEl("button", { text: "新对话" }).addEventListener("click", () => this.createNewConversation());
    this.conversationListPanel = new ConversationListPanel(parent);
    this.conversationListEl = this.conversationListPanel.element;
  }

  private renderConversationList() {
    if (!this.conversationListPanel) return;
    this.conversationListPanel.render(
      Object.values(this.conversations),
      this.activeConversationId,
      this.plugin.settings.activePersonaId,
      (id) => this.switchToConversation(id)
    );
  }


  private extractRoleplayDataBlock(rawContent: string) {
    return extractRoleplayDataBlock(rawContent);
  }

  private updateRoleplayStateBadge(conversation?: Conversation) {
    if (!this.topRoleplayStateBadgeEl) return;
    const rp = conversation?.roleplayState;
    if (!rp?.player) {
      this.topRoleplayStateBadgeEl.setText('');
      this.topRoleplayStateBadgeEl.toggleClass('is-hidden', true);
      return;
    }

    const rank = String((rp.player as any)?.rank || '').trim();
    const clan = String((rp.player as any)?.clan || '').trim();
    const location = String((rp.player as any)?.location || '').trim();
    const summary = [rank, clan, location].filter(Boolean).slice(0, 3).join(' · ');
    this.topRoleplayStateBadgeEl.setText(summary || 'RP 状态已同步');
    this.topRoleplayStateBadgeEl.toggleClass('is-hidden', !summary);
  }

  private touchConversation(conversation?: Conversation) {
    if (!conversation) return;
    conversation.updatedAt = Date.now();
  }

  private updateContextTokenBadge(conversation?: Conversation, draft?: string) {
    const setBadge = (text: string) => {
      if (!this.topTokenBadgeEl) return;
      this.topTokenBadgeEl.setText(text);
      this.topTokenBadgeEl.toggleClass("is-hidden", !text);
    };

    if (!conversation) {
      setBadge("");
      return;
    }

    const draftText = typeof draft === 'string' ? draft : '';
    const hasAny = conversation.history.length > 0 || draftText.trim().length > 0;
    if (!hasAny) {
      setBadge("");
      return;
    }

    // Prefer the more accurate estimate computed in main send pipeline when available,
    // but still provide a live approximation while typing.
    let tokens: number;
    if (conversation.lastContextTokensEstimate && !draftText.trim()) {
      tokens = conversation.lastContextTokensEstimate;
    } else {
      const slice = conversation.history.slice(-20);
      const messages: ChatMessage[] = [...slice];
      if (draftText.trim()) {
        messages.push({ role: 'user', content: draftText });
      }
      tokens = estimateTokensFromMessages(messages);

      // If we have a previous accurate estimate, use it as a baseline for display stability.
      if (conversation.lastContextTokensEstimate) {
        const draftTokens = estimateTokensFromText(draftText);
        tokens = Math.max(tokens, conversation.lastContextTokensEstimate + draftTokens);
      }
    }

    setBadge(`上下文≈${formatTokenCountCompact(tokens)} tokens`);
  }

  private tryParseTodoListFromToolOutput(content: string): TodoItem[] | null {
    return tryParseTodoListFromToolOutput(content);
  }

  private extractInternalLog(content: string): { type: string; summary: string; trace?: any } | null {
    const raw = String(content || '');
    const match = raw.match(/<internal-log>([\s\S]*?)<\/internal-log>/i);
    if (!match?.[1]) return null;
    try {
      const parsed = JSON.parse(match[1]);
      return {
        type: String(parsed?.type || 'unknown'),
        summary: String(parsed?.summary || '').trim(),
        trace: parsed?.trace,
      };
    } catch {
      return null;
    }
  }

  private extractStepSummaryLog(content: string): { summary: string; trace?: any } | null {
    const raw = String(content || '');
    if (!raw.includes('<step-summary>')) return null;
    const summaryMatch = raw.match(/<step-summary>([\s\S]*?)<\/step-summary>/i);
    if (!summaryMatch?.[1]) return null;
    const inner = summaryMatch[1].trim();
    const traceMatch = inner.match(/<execution-trace>([\s\S]*?)<\/execution-trace>/i);
    let trace: any = undefined;
    let summary = inner;
    if (traceMatch?.[1]) {
      try {
        trace = JSON.parse(traceMatch[1]);
      } catch {
        trace = traceMatch[1];
      }
      summary = inner.replace(traceMatch[0], '').trim();
    }
    return { summary, trace };
  }

  // Strip <step-summary> from content so it doesn't pollute the UI/context
  private stripStepSummary(content: string): string {
      return String(content || '').replace(/<step-summary>[\s\S]*?<\/step-summary>/gi, '').trim();
  }

  public sortConversations(list: Conversation[]): Conversation[] {
    return [...list].sort((a, b) => ConversationListPanel.compare(a, b));
  }

  public toggleConversationPin(conversationId: string) {
    const conv = this.conversations[conversationId];
    if (!conv) return;
    conv.pinned = !conv.pinned;
    this.touchConversation(conv);
    this.saveConversations();
    this.renderConversationList();
  }

  public toggleConversationStar(conversationId: string) {
    const conv = this.conversations[conversationId];
    if (!conv) return;
    conv.starred = !conv.starred;
    this.touchConversation(conv);
    this.saveConversations();
    this.renderConversationList();
  }

  public setConversationArchived(conversationId: string, archived: boolean) {
    const conv = this.conversations[conversationId];
    if (!conv) return;
    conv.archived = archived;
    this.touchConversation(conv);
    this.saveConversations();
    if (archived && this.activeConversationId === conversationId) {
      const available = Object.values(this.conversations).filter(c => !c.archived);
      if (available.length) this.switchToConversation(this.sortConversations(available)[0].id);
      else this.createNewConversation();
    }
    this.renderConversationList();
  }

  public updateConversationTags(conversationId: string, tags: string[]) {
    const conv = this.conversations[conversationId];
    if (!conv) return;
    conv.tags = Array.from(new Set(tags.map(tag => tag.trim()).filter(Boolean)));
    this.touchConversation(conv);
    this.saveConversations();
  }

  public deleteConversation(conversationId: string) {
    this.deleteConversations([conversationId]);
  }

  public deleteConversations(conversationIds: string[]) {
    if (!conversationIds.length) return;
    let activeRemoved = false;
    conversationIds.forEach(id => {
      if (!this.conversations[id]) return;
      delete this.conversations[id];
      if (this.activeConversationId === id) activeRemoved = true;
    });

    if (activeRemoved) {
      const remaining = Object.values(this.conversations).filter(conv => !conv.archived);
      if (remaining.length) this.switchToConversation(this.sortConversations(remaining)[0].id);
      else this.createNewConversation();
    } else {
      this.renderConversationList();
    }

    this.saveConversations();
  }

  public deleteAllConversations() {
    this.conversations = {};
    this.activeConversationId = null;
    this.plugin.saveConversations(this.conversations, { force: true });
    this.renderConversationList();
    this.createNewConversation();
  }

  public async exportConversationToNote(conversation: Conversation) {
    const markdown = this.formatConversationMarkdown(conversation);
    new NoteSuggestModal(this.app, async (file) => {
      await this.app.vault.append(file, `\n\n${markdown}`);
      safeNotice(`会话已导出到笔记: ${file.basename}`);
    }).open();
  }

  public async exportConversationAsMarkdown(conversation: Conversation) {
    try {
      const folderPath = "AI Exports";
      const sanitizedTitle = conversation.title.replace(/[\\/:*?"<>|]/g, "-") || conversation.id;
      const fileName = `${sanitizedTitle}-${Date.now()}.md`;
      const targetPath = `${folderPath}/${fileName}`;
      if (!this.app.vault.getAbstractFileByPath(folderPath)) {
        await this.app.vault.createFolder(folderPath).catch(() => {});
      }
      await this.app.vault.create(targetPath, this.formatConversationMarkdown(conversation));
      safeNotice(`会话已导出到: ${targetPath}`);
    } catch (error: any) {
      safeNotice(`导出失败: ${error?.message || String(error)}`);
    }
  }

  private formatConversationMarkdown(conversation: Conversation): string {
    const created = conversation.createdAt ? new Date(conversation.createdAt) : null;
    const updated = conversation.updatedAt ? new Date(conversation.updatedAt) : null;
    const metaLines = [
      `- 模型: ${conversation.model}`,
      created ? `- 创建时间: ${created.toLocaleString()}` : '',
      updated ? `- 最近更新: ${updated.toLocaleString()}` : '',
      (conversation.tags && conversation.tags.length) ? `- 标签: ${conversation.tags.join(', ')}` : '',
      conversation.templateId ? `- 模板: ${conversation.templateId}` : '',
    ].filter(Boolean);

    const history = conversation.history.map((msg, idx) => {
      const speaker = msg.role === 'user' ? '用户' : msg.role === 'assistant' ? 'AI' : '系统';
      return `### ${idx + 1}. ${speaker}\n\n${msg.content}`;
    }).join('\n\n');

    return `# ${conversation.title}\n\n${metaLines.join('\n')}\n\n---\n\n${history}`.trim();
  }

  private async saveConversations() {
    if (!this.conversationsReady) {
      // 对话数据尚未从磁盘加载完毕，跳过本次保存以避免空数据覆盖
      return;
    }
    await this.plugin.saveConversations(this.conversations);
  }

  private async loadConversations() {
    // 等待插件对话数据加载完毕（onLayoutReady 延迟加载）
    await this.plugin.conversationsReady;
    this.conversations = await this.plugin.loadConversations();
    this.normalizeConversations();
    this.conversationsReady = true;
  }

  private normalizeConversations() {
    const now = Date.now();
    Object.values(this.conversations ?? {}).forEach((conv) => {
      conv.pinned = conv.pinned ?? false;
      conv.starred = conv.starred ?? false;
      conv.archived = conv.archived ?? false;
      conv.tags = Array.from(new Set((conv.tags ?? []).map(tag => tag.trim()).filter(Boolean)));
      conv.createdAt = conv.createdAt ?? now;
      conv.updatedAt = conv.updatedAt ?? conv.createdAt ?? now;
      if (!Array.isArray(conv.history)) conv.history = [];
    });
  }

  private createModelSelector(parent: HTMLElement) {
    // 使用可搜索的模型选择器
    this.searchableModelSelect = new SearchableModelSelect(parent, {
      placeholder: '搜索模型...',
      onSelect: (value: string) => {
        if (this.activeConversationId) {
          this.conversations[this.activeConversationId].model = value;
          this.conversations[this.activeConversationId].modelSource = 'conversation';
          this.saveConversations();
        }
        // 保存到当前模式的默认模型（群聊模式除外）
        if (this.chatMode && this.chatMode !== 'groupchat') {
          const modeModels = this.plugin.settings.modeModels || { normal: '', kb: '', agent: '', collaboration: '' };
          if ((modeModels as any)[this.chatMode] !== value) {
            (modeModels as any)[this.chatMode] = value;
            this.plugin.settings.modeModels = modeModels;
            void this.plugin.saveSettings();
          }
        }
      }
    });
    
    // 填充模型选项
    this.populateModelSelector();
    
    // 保留 modelSelectEl 引用以兼容现有代码
    this.modelSelectEl = this.searchableModelSelect['containerEl'].querySelector('input') as any;
  }

  /**
   * 刷新模型选择器（当连接或模型注册表变化时调用）
   */
  public refreshModelSelector() {
    if (!this.searchableModelSelect) return;

    const isDisabledMode = false;
    this.searchableModelSelect.setDisabled(isDisabledMode);

    if (isDisabledMode) {
      this.searchableModelSelect.setPlaceholder(`本地Agent模式（模型由外部控制）`);
    } else {
      this.searchableModelSelect.setPlaceholder('搜索模型...');
    }

    this.populateModelSelector();
    const conv = this.activeConversationId ? this.conversations[this.activeConversationId] : null;
    const resolved = this.plugin.resolveConversationModel(conv, this.chatMode === 'kb' ? 'search' : this.chatMode === 'groupchat' ? 'normal' : this.chatMode, conv?.agentId);
    this.lastActionModelSource = resolved.source;
    if (resolved.model) {
      this.searchableModelSelect.setValue(resolved.model);
    }
  }

  /**
   * 填充模型选择器选项
   */
  private populateModelSelector() {
    if (!this.searchableModelSelect) return;
    
    const registry = Array.isArray((this.plugin.settings as any).modelRegistry) ? (this.plugin.settings as any).modelRegistry : [];
    const connections = Array.isArray((this.plugin.settings as any).connections) ? (this.plugin.settings as any).connections : [];
    
    // 构建连接ID到名称的映射
    const connIdToName: Record<string, string> = {};
    for (const conn of connections) {
      if (conn?.id && conn?.name) {
        connIdToName[conn.id] = conn.name;
      }
    }
    
    // 检查是否有重复的模型名（出现在多个连接中）
    const modelCounts: Record<string, number> = {};
    for (const r of registry) {
      const model = String(r?.model || '').trim();
      if (model) {
        modelCounts[model] = (modelCounts[model] || 0) + 1;
      }
    }
    
    // 构建模型选项
    const modelOptions: ModelOption[] = [];
    const seenValues = new Set<string>();
    const seenModels = new Set<string>(); // 用于跟踪已添加的模型名（不含连接ID）
    
    for (const r of registry) {
      const model = String(r?.model || '').trim();
      const connId = String(r?.connectionId || '').trim();
      if (!model) continue;
      
      // 如果模型名出现在多个连接中，使用 model@connectionId 作为唯一标识
      const isDuplicate = modelCounts[model] > 1;
      const value = isDuplicate && connId ? `${model}@${connId}` : model;
      
      if (seenValues.has(value)) continue;
      seenValues.add(value);
      seenModels.add(model); // 记录模型名
      
      const connName = connId ? connIdToName[connId] : '';
      // 显示文本：始终显示连接名（如果有），与设置页保持一致
      const displayText = connName ? `${model} (${connName})` : model;
      
      modelOptions.push({ value, displayText, model, connectionName: connName || undefined });
    }
    
    // 默认模型放到最前面
    const defaultChatModel = String((this.plugin.settings as any).defaultChatModel || '').trim();
    if (defaultChatModel) {
      // 查找默认模型是否在列表中
      const existingIndex = modelOptions.findIndex(opt => opt.model === defaultChatModel || opt.value === defaultChatModel);
      if (existingIndex > 0) {
        // 移到最前面
        const [item] = modelOptions.splice(existingIndex, 1);
        modelOptions.unshift(item);
      } else if (existingIndex === -1) {
        // 不在列表中，添加到最前面
        modelOptions.unshift({ value: defaultChatModel, displayText: defaultChatModel, model: defaultChatModel });
      }
    }

    this.searchableModelSelect.setOptions(modelOptions);
    
    // 设置初始值
    if (this.activeConversationId && this.conversations[this.activeConversationId]) {
      this.searchableModelSelect.setValue(this.conversations[this.activeConversationId].model);
    }
  }

  private createPersonaSelector(parent: HTMLElement) {
    const wrap = parent.createDiv({ cls: "ai-chat-persona-selector-wrap" });
    this.personaSelectEl = wrap.createEl("button", { cls: "ai-chat-persona-button", attr: { "aria-label": "选择角色或智能体" } });
    this.personaSelectEl.type = "button";

    const label = this.personaSelectEl.createSpan({ cls: "ai-chat-persona-label" });
    const chevron = this.personaSelectEl.createSpan({ cls: "ai-chat-persona-chevron" });
    setIcon(chevron, "chevron-down");

    this.personaSelectEl.onclick = () => {
      const mode = this.chatMode === "agent" ? "agent" : "persona";
      new RolePickerModal(this.app, this.plugin, mode, async (id) => {
        await this.applyRoleSelection(id);
        this.refreshPersonaSelector();
      }).open();
    };

    this.refreshPersonaSelector();
  }

  private async applyRoleSelection(newId: string) {
    if (this.chatMode === 'agent') {
      this.plugin.settings.activeAgentId = newId;
      await this.plugin.saveSettings();
      const agentName = this.plugin.agentManager.getAgent(newId)?.name;
      safeNotice(`已切换智能体为: ${agentName}`);
      this.latestAgentRunSnapshot = null;

      const target = this.findLatestConversationForEntry('agent', { agentId: newId });
      if (target) {
        if (this.activeConversationId === target.id) {
          await this.plugin.ensureConversationHistoryLoaded(target.id);
          void this.renderConversation(target);
          this.renderConversationList();
        } else {
          this.switchToConversation(target.id);
        }
      } else {
        this.createNewConversation();
      }
      return;
    }

    this.plugin.settings.activePersonaId = newId;
    await this.plugin.saveSettings();
    safeNotice(`已切换角色为: ${this.plugin.settings.personas.find(p => p.id === newId)?.name}`);

    const target = this.findLatestConversationForEntry(this.chatMode === 'kb' ? 'search' : this.chatMode === 'collaboration' ? 'collaboration' : 'chat', { personaId: newId });
    if (target) {
      if (this.activeConversationId === target.id) {
        await this.plugin.ensureConversationHistoryLoaded(target.id);
        void this.renderConversation(target);
        this.renderConversationList();
      } else {
        this.switchToConversation(target.id);
      }
    } else {
      this.createNewConversation();
    }
  }

  public refreshPersonaSelector() {
    if (!this.personaSelectEl) return;

    const labelEl = this.personaSelectEl.querySelector<HTMLElement>(".ai-chat-persona-label");
    if (!labelEl) return;

    // 普通模式下，角色/智能体选择器可用
    if (this.chatMode === 'agent') {
      const agents = this.plugin.agentManager.getAllAgents();
      const currentAgentId = this.plugin.settings.activeAgentId;
      const current = agents.find(a => a.id === currentAgentId) || agents[0];
      if (current && current.id !== currentAgentId) {
        this.plugin.settings.activeAgentId = current.id;
        this.plugin.saveSettings();
      }
      labelEl.textContent = current ? `🤖 ${current.name}` : "选择智能体";
      return;
    }

    const currentVal = this.plugin.settings.activePersonaId;
    const current = this.plugin.settings.personas.find(p => p.id === currentVal) || this.plugin.settings.personas[0];
    if (current && current.id !== currentVal) {
      this.plugin.settings.activePersonaId = current.id;
      this.plugin.saveSettings();
    }
    labelEl.textContent = current ? `👤 ${current.name}` : "选择角色";
  }

  private handleFileOpen(file: TFile | null) {
    this.currentNoteFilePath = file?.path || null;
    const oldIndex = this.contextItems.findIndex(i => i.path === 'current-note-auto');
    if (oldIndex > -1) this.contextItems.splice(oldIndex, 1);
    if (file) {
      this.addContextItem({
        type: 'file',
        path: 'current-note-auto',
        actualPath: file.path,
        displayName: `${file.basename} (当前)`
      });
    }
    this.renderContextItems();
  }

  private addContextItem(item: ContextItem) {
    if (!this.contextItems.some(existing => existing.displayName === item.displayName)) {
      this.contextItems.push(item);
      this.renderContextItems();
    }
  }

   private renderContextItems() {
     this.contextContainer.empty();
     if (this.contextItems.length === 0) {
         this.contextContainer.setCssStyles({ display: "none" });
         return;
     }
     this.contextContainer.setCssStyles({ display: "flex" });

     // Injection summary (computed right before send)
     if (this.latestContextInjectionMeta) {
       const m = this.latestContextInjectionMeta;
       const truncated = m.truncatedByBlockLimit || m.truncatedByCharLimit;
       const summary = `上下文注入：已选${m.selectedItems}项 · 实际注入${m.injectedBlocks}/${m.uniqueBlocks}块 · ${m.injectedChars}/${m.maxChars}字${truncated ? '（已截断）' : ''}`;
       this.contextContainer.createEl('div', {
         cls: 'ai-chat-context-summary',
         text: summary,
       });
     }
     
     this.contextItems.forEach((item, index) => {
       const pill = this.contextContainer.createEl("div", { cls: "ai-chat-context-pill", text: item.displayName });
       const removeBtn = pill.createEl("span", { text: "❌", cls: "ai-chat-context-remove" });
       removeBtn.addEventListener("click", () => {
         this.contextItems.splice(index, 1);
         // Reset meta because injection will change next send
         this.latestContextInjectionMeta = null;
         this.renderContextItems();
       });
     });
   }


  private setupResponsiveActionWatcher(panel: HTMLElement) {
    this.teardownResponsiveActionWatcher();

    let initialCompact = false;

    if (typeof window !== 'undefined' && 'matchMedia' in window) {
      this.actionMediaQuery = window.matchMedia('(max-width: 900px)');
      this.actionMediaQueryListener = (event: MediaQueryListEvent) => {
        const shouldCompact = event.matches || this.lastActionPanelWidth < 460;
        this.updateCompactActionMode(shouldCompact);
      };
      this.actionMediaQuery.addEventListener('change', this.actionMediaQueryListener);
      initialCompact = this.actionMediaQuery.matches;
    }

    if (typeof ResizeObserver !== 'undefined') {
      this.actionResizeObserver = new ResizeObserver((entries) => {
        const width = entries[0]?.contentRect.width ?? panel.clientWidth;
        this.lastActionPanelWidth = width;
        const shouldCompact = width < 460 || (this.actionMediaQuery?.matches ?? false);
        this.updateCompactActionMode(shouldCompact);
      });
      this.actionResizeObserver.observe(panel);
    }

    this.lastActionPanelWidth = panel.clientWidth;
    if (this.lastActionPanelWidth < 460) initialCompact = true;

    this.updateCompactActionMode(initialCompact);
  }

  private updateCompactActionMode(shouldCompact: boolean) {
    if (this.compactActionMode === shouldCompact) return;
    this.compactActionMode = shouldCompact;
    this.rerenderActiveConversation();
  }

  private rerenderActiveConversation() {
    if (!this.activeConversationId) return;
    const conversation = this.conversations[this.activeConversationId];
    if (conversation) void this.renderConversation(conversation);
  }

  private teardownResponsiveActionWatcher() {
    if (this.actionMediaQuery && this.actionMediaQueryListener) {
      this.actionMediaQuery.removeEventListener('change', this.actionMediaQueryListener);
    }
    this.actionMediaQuery = null;
    this.actionMediaQueryListener = undefined;
    if (this.actionResizeObserver) {
      this.actionResizeObserver.disconnect();
      this.actionResizeObserver = undefined;
    }
  }

  private resolveCurrentContextFilePath(item?: ContextItem): string {
    if (item?.actualPath) return item.actualPath;
    if (this.currentNoteFilePath) return this.currentNoteFilePath;

    const markdownLeaves = this.app.workspace.getLeavesOfType('markdown');
    for (const leaf of markdownLeaves) {
      const file = (leaf.view as MarkdownView).file;
      if (file?.path) return file.path;
    }

    return this.app.workspace.getActiveFile()?.path || '';
  }

  private async getContextContent(): Promise<string> {
    let contextString = "";
    for (const item of this.contextItems) {
      if (item.type === 'file') {
        let fileToRead: TFile | null;
        if (item.path === 'current-note-auto') {
          const resolvedPath = this.resolveCurrentContextFilePath(item);
          const abstractFile = resolvedPath ? this.app.vault.getAbstractFileByPath(resolvedPath) : null;
          fileToRead = abstractFile instanceof TFile ? abstractFile : null;
        }
        else {
          const abstractFile = this.app.vault.getAbstractFileByPath(item.path);
          fileToRead = abstractFile instanceof TFile ? abstractFile : null;
        }
        if (fileToRead) {
          let content = "";
          if (fileToRead.extension === 'canvas') {
             // Special handling for canvas files to avoid dumping huge JSON
             try {
                 const rawContent = await this.app.vault.read(fileToRead);
                 const canvasData = JSON.parse(rawContent);
                 content = `[Canvas File: ${fileToRead.basename}]\n`;
                 content += `Nodes: ${canvasData.nodes?.length || 0}, Edges: ${canvasData.edges?.length || 0}\n`;
                 // Simple summary of text nodes
                 if (canvasData.nodes) {
                     content += "Text Nodes:\n";
                     canvasData.nodes.forEach((n: any) => {
                         if (n.type === 'text') content += `- [ID: ${n.id}] Text: "${n.text.substring(0, 100).replace(/\n/g, ' ')}"\n`;
                         else if (n.type === 'file') content += `- [ID: ${n.id}] File: [[${n.file}]]\n`;
                         else if (n.type === 'group') content += `- [ID: ${n.id}] Group: ${n.label || "Untitled"}\n`;
                     });
                 }
            } catch (e: any) {
                content = `[Error reading canvas: ${e.message}]`;
             }
          } else if (isPdf(fileToRead.extension)) {
             // PDF 文件：使用 Obsidian 内置 pdfjs 提取文本
             try {
               const buffer = await this.app.vault.readBinary(fileToRead);
               content = await extractPdfTextFormatted(buffer, fileToRead.name);
             } catch (e: any) {
               content = `[PDF 文件: ${fileToRead.name}，提取文本失败: ${e?.message || '未知错误'}]`;
             }
          } else {
             content = await this.app.vault.cachedRead(fileToRead);
          }
          contextString += `--- 文件: [[${fileToRead.basename}]] ---\n${content}\n\n`;
        }
      } else if (item.type === 'folder') {
        const folderPath = item.path;
        contextString += `--- 文件夹: ${folderPath} ---\n`;
        const files = this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(folderPath + '/'));
        for (const file of files) {
          const content = await this.app.vault.cachedRead(file);
          contextString += `--- 子文件: [[${file.basename}]] ---\n${content}\n\n`;
        }
      } else if (item.type === 'tag') {
        contextString += `--- 标签: ${item.path} ---\n`;
      }
    }
    return contextString;
  }

  private createModeToggle(parent: HTMLElement) {
    type UiChatMode = 'normal' | 'kb' | 'agent' | 'collaboration' | 'groupchat';
    const modeMeta: Record<UiChatMode, { label: string; placeholder: string; icon?: string }> = {
      normal: { label: '聊天', placeholder: '在普通模式下提问...' },
      kb: { label: '检索', placeholder: '基于您的知识库提问...' },
      agent: { label: '智能体', placeholder: '选择智能体并下达任务...' },
      collaboration: { label: '协作', placeholder: '输入复杂任务，AI 将自动规划并执行...' },
      groupchat: { label: '群聊', placeholder: '与多个 AI 角色对话，可使用 @角色名 指定发言者...' },
    };

    const toggleContainer = parent.createEl('div', { cls: 'ai-chat-mode-toggle' });

    const entryMeta: Record<ChatEntryMode, { label: string; mode: UiChatMode; presetId?: string; placeholder?: string }> = {
      chat: { label: '聊天', mode: 'normal', placeholder: modeMeta.normal.placeholder },
      search: { label: '检索', mode: 'kb', placeholder: modeMeta.kb.placeholder },
      agent: { label: '智能体', mode: 'agent', presetId: 'default', placeholder: modeMeta.agent.placeholder },
      collaboration: { label: '协作', mode: 'collaboration', placeholder: modeMeta.collaboration.placeholder },
      groupchat: { label: '群聊', mode: 'groupchat', placeholder: modeMeta.groupchat.placeholder },
    };

    const entrySelect = toggleContainer.createEl('select', { cls: 'ai-chat-mode-entry' });
    this.entrySelectEl = entrySelect;
    entrySelect.setAttribute('aria-label', '工作模式');
    const addEntryOptions = () => {
      entrySelect.empty();
      this.getVisibleEntryModes().forEach((key) => {
        entrySelect.createEl('option', { value: key, text: entryMeta[key].label });
      });
    };
    addEntryOptions();

    const applyMode = (mode: UiChatMode, options?: { suppressAutoPreset?: boolean; skipConversationSwitch?: boolean }) => {
      const previousMode = this.chatMode;

      this.chatMode = mode;
      if (this.inputManager) {
        this.inputManager.setPlaceholder(modeMeta[mode].placeholder);
      }

      if (mode === 'groupchat') {
        this.enterGroupChatMode();
        return;
      } else if (this.activeGroupRoomId) {
        this.exitGroupChatMode();
      }

      this.refreshPersonaSelector();
      this.refreshModelSelector();

      if (mode === 'agent' && this.plugin.settings.agentAutoPresetOnEnter && !options?.suppressAutoPreset) {
        const target = (this.plugin.settings.agentAutoPresetId || 'default').trim() || 'default';
        if (this.plugin.settings.activePresetId !== target) {
          this.plugin.settings.activePresetId = target;
          void this.plugin.saveSettings();
        }
      }

      this.refreshPersonaSelector();

      if (options?.skipConversationSwitch) {
        return;
      }

      if (this.activeConversationId && previousMode) {
        this.lastConversationByMode[previousMode] = this.activeConversationId;
      }

      this.isSwitchingMode = true;
      try {
        const lastConvId = this.lastConversationByMode[mode];
        const lastConv = lastConvId ? this.conversations[lastConvId] : null;
        if (lastConv && !lastConv.archived && this.getConversationMode(lastConv) === mode) {
          this.switchToConversation(lastConvId);
          return;
        }

        const entry = mode === 'kb' ? 'search' : mode === 'collaboration' ? 'collaboration' : mode === 'agent' ? 'agent' : 'chat';
        const targetConversation = this.findLatestConversationForEntry(entry, {
          agentId: mode === 'agent' ? this.plugin.settings.activeAgentId : undefined,
          personaId: mode !== 'agent' ? this.plugin.settings.activePersonaId : undefined,
        });

        if (targetConversation) {
          this.switchToConversation(targetConversation.id);
        } else {
          this.createNewConversation();
        }
      } finally {
        this.isSwitchingMode = false;
      }
    };

    const applyEntry = async (next: ChatEntryMode, options?: { persist?: boolean; skipConversationSwitch?: boolean }) => {
      const meta = entryMeta[next] || entryMeta.chat;
      const activeConv = this.activeConversationId ? this.conversations?.[this.activeConversationId] : null;

      if (meta.mode === 'agent') {
        const presetId = this.plugin.resolveConversationToolPolicy(activeConv, activeConv?.agentId || this.plugin.settings.activeAgentId, meta.presetId || 'default');
        if (this.plugin.settings.activePresetId !== presetId) {
          this.plugin.settings.activePresetId = presetId;
          await this.plugin.saveSettings();
        }
      }

      applyMode(meta.mode, {
        suppressAutoPreset: meta.mode === 'agent',
        skipConversationSwitch: options?.skipConversationSwitch
      });

      if (this.inputManager && meta.placeholder) {
        this.inputManager.setPlaceholder(meta.placeholder);
      }

      const convId = this.activeConversationId;
      const conv = convId ? this.conversations?.[convId] : null;
      if (conv) {
        if (options?.persist !== false) {
          conv.uiEntryMode = next;
        }
        if (next === 'agent') {
          conv.agentId = conv.agentId || this.plugin.settings.activeAgentId;
          conv.toolPolicyId = conv.toolPolicyId || this.plugin.resolveConversationToolPolicy(conv, conv.agentId || this.plugin.settings.activeAgentId, this.plugin.settings.activePresetId);
        }
        const resolvedModel = this.plugin.resolveConversationModel(conv, meta.mode === 'kb' ? 'search' : meta.mode === 'groupchat' ? 'normal' : meta.mode, conv.agentId);
        conv.model = resolvedModel.model;
        conv.modelSource = resolvedModel.source;
        if (this.searchableModelSelect) this.searchableModelSelect.setValue(resolvedModel.model);
        this.lastActionModelSource = resolvedModel.source;
        if (options?.persist !== false) {
          this.touchConversation(conv);
          void this.saveConversations();
        }
      }
    };

    this.applyEntryMode = async (entry: string, options?: { persist?: boolean; skipConversationSwitch?: boolean }) => {
      const raw = String(entry || '').trim();
      const legacyMap: Record<string, ChatEntryMode> = {
        'kb': 'search',
        'acp': 'agent',
        'agent-general': 'agent',
        'agent-webparser': 'agent',
        'agent-notes': 'agent',
        'agent-writing': 'agent',
        'webparser': 'agent',
        'notes': 'agent',
        'writing': 'agent',
      };
      const normalized = (legacyMap[raw] || raw || 'chat') as ChatEntryMode;
      const key = (entryMeta as any)[normalized] ? normalized : ('chat' as ChatEntryMode);
      const visibleKey = this.resolveVisibleEntryMode(key);
      await applyEntry(visibleKey, options);
    };

    entrySelect.addEventListener('change', async () => {
      const next = (entrySelect.value || 'chat') as ChatEntryMode;
      await applyEntry(next, { persist: true });
    });

    const conv = this.activeConversationId ? this.conversations?.[this.activeConversationId] : null;
    const initial = this.resolveVisibleEntryMode(this.getConversationEntryMode(conv));
    entrySelect.value = initial;
    void applyEntry(initial as ChatEntryMode, { persist: false, skipConversationSwitch: true });
  }

  private async handleUserMessage(message: string, images: string[] = []) {
    // 群聊模式特殊处理
    if (!this.activeConversationId) return;

    // 防止重复处理
    if (this.isProcessingMessage) return;
    this.isProcessingMessage = true;

    // 群聊走独立处理链路
    if (this.chatMode === 'groupchat') {
      try {
        await this.handleGroupChatMessage(message);
      } finally {
        this.isProcessingMessage = false;
      }
      return;
    }

    const conversation = this.conversations[this.activeConversationId];
    if (!conversation) {
      this.isProcessingMessage = false;
      return;
    }
    await this.plugin.ensureConversationHistoryLoaded(conversation.id);
    this.latestAgentRunSnapshot = conversation.agentRunSnapshot || null;
    
    // 允许仅发送图片
    if (!message && images.length === 0) {
      this.isProcessingMessage = false;
      return;
    }

    // 检查是否有被提及的技能 (@技能名) — 使用 agent-v2
    const mentionedSkillId = this.detectMentionedSkill(message);
    if (mentionedSkillId) {
      try {
        const cleanMessage = message
          .replace(/@skill:\s*"[^"]*"/g, '')
          .replace(/@skill:\s*\S+/g, '')
          .replace(/@\S+/g, '')
          .trim();
        
        // 显示激活提示
        const skill = this.plugin.skillRegistry.getSkill(mentionedSkillId);
        conversation.history.push({ 
          role: 'system', 
          content: `⚡ 已激活技能: ${skill?.name || mentionedSkillId}` 
        });
        
        // 使用 agent-v2 处理 (传入完整对话历史以保持上下文)
        const agentResult = await this.agentV2.process(
          [{ role: 'user', content: message }],
          conversation.model || this.plugin.settings.defaultChatModel
        );
        
        // 调试: 输出 agent 结果
        
        conversation.history.push({ role: 'user', content: cleanMessage || message });
        await this.messageRenderer.renderMessage(
          { role: 'user', content: cleanMessage || message },
          conversation.history.length - 1
        );
        
        const response = agentResult.content || '技能已执行，无返回内容';
        conversation.history.push({ role: 'assistant', content: response });
        await this.messageRenderer.renderMessage(
          { role: 'assistant', content: response },
          conversation.history.length - 1
        );
        
        this.touchConversation(conversation);
        await this.saveConversations();
        this.scrollToBottom();
      } finally {
        this.inputManager.clearMentionedSkill();
        this.isProcessingMessage = false;
      }
      return;
    }

    // Always re-enable input even if anything throws.
    this.inputManager.setDisabled(true);

    // 创建中止控制器
    const abortController = new AbortController();
    (this as any).currentAbortController = abortController;

    // 准备流式输出的容器
    let streamingMessageEl: HTMLElement | null = null;
    let streamingContent = "";
    let userMessageIndex = -1;
    try {
      this.inputManager.showProcessingState("AI 正在思考...", () => {
        abortController.abort();
        this.inputManager.hideProcessingState();
        this.inputManager.setDisabled(false);
        new Notice("已停止生成");
      });

      conversation.history.push({ role: 'user', content: message, images: images });
      this.touchConversation(conversation);
      userMessageIndex = conversation.history.length - 1;
      await this.messageRenderer.renderMessage({ role: 'user', content: message, images: images }, userMessageIndex);
      // Keep the start of the user's message visible (long prompts won't require scrolling up after reply).
      this.scrollToMessageStart(userMessageIndex);

      const contextContent = await this.getContextContent();
      const implicitContext = await this.buildImplicitContextForMessage(message);
      const composed = this.buildStructuredContextContentWithMeta(contextContent, implicitContext);
      const finalContext = composed.text;

      // Save injection meta for UI display (pills + truncation awareness)
      this.latestContextInjectionMeta = {
        selectedItems: this.contextItems.length,
        ...composed.meta,
      };
      this.renderContextItems();

      const resolvedRuntime = this.plugin.resolveConversationModel(conversation, this.chatMode === 'kb' ? 'search' : this.chatMode, conversation.agentId);
      conversation.model = resolvedRuntime.model;
      conversation.modelSource = resolvedRuntime.source;
      this.lastActionModelSource = resolvedRuntime.source;
      if (this.searchableModelSelect) this.searchableModelSelect.setValue(resolvedRuntime.model);
      this.refreshModelSelector();
      const activeAgentId = this.chatMode === 'agent'
        ? String(conversation.agentId || this.plugin.settings.activeAgentId || '').trim() || this.plugin.settings.activeAgentId
        : undefined;
      if (this.chatMode === 'agent' && activeAgentId && conversation.agentId !== activeAgentId) {
        conversation.agentId = activeAgentId;
      }
      if (this.chatMode === 'agent') {
        conversation.toolPolicyId = this.plugin.resolveConversationToolPolicy(conversation, activeAgentId, this.plugin.settings.activePresetId);
      }

      const response = await this.plugin.handleSendMessage(
        message,
        this.chatMode,
        conversation.history,
        finalContext,
        conversation.model,
        images,
        (token) => {
          // 检查是否已中止
          if (abortController.signal.aborted) return;
          
          // 流式回调
          if (!streamingMessageEl) {
            // 创建一个新的 assistant 消息元素
            streamingMessageEl = this.chatContainer.createDiv({ cls: "ai-chat-message assistant" });
            const avatar = streamingMessageEl.createDiv({ cls: "ai-chat-avatar" });
            setIcon(avatar, "bot");
            const contentDiv = streamingMessageEl.createDiv({ cls: "ai-chat-content" });
            contentDiv.createSpan({ cls: "ai-chat-cursor" });
          }
          this.inputManager.showProcessingState("AI 正在回复...", () => {
            abortController.abort();
            this.inputManager.hideProcessingState();
            this.inputManager.setDisabled(false);
            new Notice("已停止生成");
          });
          streamingContent += token;
          
          const contentDiv = streamingMessageEl.querySelector(".ai-chat-content") as HTMLElement;
          if (contentDiv) {
             contentDiv.empty();
             // 简单渲染，不处理复杂 Markdown 以提高性能
             contentDiv.innerText = streamingContent; 
             contentDiv.createSpan({ cls: "ai-chat-cursor" });
          }
        }
        ,
        (meta) => {
          conversation.lastContextTokensEstimate = meta.contextTokensEstimate;
          this.updateContextTokenBadge(conversation);
        },
        (snapshot) => {
          this.updateConversationRunSnapshot(snapshot);
          this.renderRunSnapshot(snapshot);
        },
        abortController.signal,
        {
          conversation,
          effectiveAgentId: activeAgentId,
          toolPolicyId: conversation.toolPolicyId,
          modelSource: resolvedRuntime.source,
        },
      );

      if (streamingMessageEl) {
        (streamingMessageEl as HTMLElement).remove();
      }
      this.inputManager.hideProcessingState();

      // 防止重复渲染的标记
      let alreadyRenderedResponse = false;

      // 如果有中间过程消息（如 Agent 的工具调用），先添加到历史并渲染
      if (response.decisionState) {
        conversation.decisionState = response.decisionState;
      }
      if (response.intermediateMessages && response.intermediateMessages.length > 0) {
        for (const msg of response.intermediateMessages) {
          if (msg.internalOnly) {
            const internalLog = this.extractInternalLog(String(msg.content || ''));
            if (internalLog) {
              logger.log('INFO' as any, 'AI', `[AgentInternal:${internalLog.type}]`, internalLog.trace, internalLog.summary);
              continue;
            }
            const stepLog = this.extractStepSummaryLog(String(msg.content || ''));
            if (stepLog) {
              logger.log('INFO' as any, 'AI', '[AgentStep] 执行步骤详情', stepLog.trace, stepLog.summary);
            } else {
              logger.log('INFO' as any, 'AI', '[AgentStep] 收到内部步骤消息', undefined, String(msg.content || '').slice(0, 2000));
            }
            continue;
          }
          
          if (msg.content) {
              msg.content = this.stripStepSummary(msg.content);
          }
          
          conversation.history.push(msg);

          if (msg.role === 'tool' && msg.name === 'manage_todo_list' && typeof msg.content === 'string') {
            const parsed = this.tryParseTodoListFromToolOutput(msg.content);
            if (parsed) {
              conversation.todoList = parsed;
              this.touchConversation(conversation);
            }
          }

          await this.messageRenderer.renderMessage(msg, conversation.history.length - 1);
        }
      }

      // 保存 assistant 消息前，提取并剥离 <data_block>
      const extracted = this.extractRoleplayDataBlock(String(response.content || ''));
      if (extracted.roleplayState) {
        conversation.roleplayState = extracted.roleplayState;
        this.touchConversation(conversation);
        this.updateRoleplayStateBadge(conversation);
      }

      const visibleContentStripped = this.stripStepSummary(extracted.visibleContent);

      // 保存 assistant 消息，包括 reasoning_content（DeepSeek reasoning 模型需要）
      const assistantMsg: ChatMessage = { 
        role: 'assistant', 
        content: visibleContentStripped, 
        references: response.references 
      };
      if (response.reasoning_content) {
        assistantMsg.reasoning_content = response.reasoning_content;
      }
      conversation.history.push(assistantMsg);
      this.touchConversation(conversation);
      
      // 检查消息是否已经被渲染（可能由于 renderConversation 被触发）
      const existingMsgCount = this.chatContainer.querySelectorAll('.ai-chat-message.assistant').length;
      const expectedAssistantCount = conversation.history.filter(m => m.role === 'assistant').length;
      
      if (existingMsgCount < expectedAssistantCount) {
        await this.messageRenderer.renderMessage({ role: 'assistant', content: visibleContentStripped, references: response.references }, conversation.history.length - 1);
      }
      
      this.saveConversations();

      // 滚动到 AI 回复的开头，而非用户消息的开头，方便阅读回复内容
      const assistantMessageIndex = conversation.history.length - 1;
      if (assistantMessageIndex >= 0) {
        this.scrollToMessageStart(assistantMessageIndex);
      }

      if (response.meta?.contextTokensEstimate) {
        conversation.lastContextTokensEstimate = response.meta.contextTokensEstimate;
        this.updateContextTokenBadge(conversation);
      }
      const finalSnapshot = conversation.agentRunSnapshot || this.latestAgentRunSnapshot;
      if (finalSnapshot) {
        this.updateConversationRunSnapshot({
          ...finalSnapshot,
          updatedAt: Date.now(),
        });
      }

    } catch (error: any) {
      console.error('[AiChat] handleSendMessage failed', error, error?.stack);
      // 清理中止控制器
      (this as any).currentAbortController = null;
      
      try { (streamingMessageEl as any)?.remove?.(); } catch {}
      this.inputManager.hideProcessingState();
      
      // 如果是用户主动中止，保留已生成的内容
      if (abortController.signal.aborted) {
        this.updateConversationRunSnapshot({
          ...(conversation.agentRunSnapshot || this.latestAgentRunSnapshot || {
            runId: `agent-${Date.now()}`,
            phase: 'answer',
            status: 'cancelled',
            updatedAt: Date.now(),
          }),
          status: 'cancelled',
          stopReason: '用户取消',
          updatedAt: Date.now(),
        });
        if (streamingContent.trim()) {
          conversation.history.push({ role: 'assistant', content: streamingContent + "\n\n*（已手动停止）*" });
          this.touchConversation(conversation);
          await this.messageRenderer.renderMessage({ role: 'assistant', content: streamingContent + "\n\n*（已手动停止）*" }, conversation.history.length - 1);
          this.saveConversations();
        }
        return;
      }
      
      // 错误消息仅在 UI 中临时展示，不保存到对话历史（避免消耗 token 和污染上下文）
      this.updateConversationRunSnapshot({
        ...(conversation.agentRunSnapshot || this.latestAgentRunSnapshot || {
          runId: `agent-${Date.now()}`,
          phase: 'answer',
          status: 'failed',
          updatedAt: Date.now(),
        }),
        status: 'failed',
        stopReason: error.message,
        updatedAt: Date.now(),
      });
      const errorMsg = `❌ 请求失败: ${error.message}`;
      const errorEl = this.chatContainer.createDiv({ cls: 'ai-chat-error-bubble' });
      errorEl.createDiv({ cls: 'ai-chat-error-content', text: errorMsg });
      const retryBtn = errorEl.createEl('button', { text: '重试', cls: 'ai-chat-error-retry' });
      retryBtn.addEventListener('click', () => {
        errorEl.remove();
        // 取出最后一条用户消息重发
        const lastUserMsg = [...conversation.history].reverse().find(m => m.role === 'user');
        if (lastUserMsg) {
          this.handleUserMessage(lastUserMsg.content || '', lastUserMsg.images);
        }
      });
      const dismissBtn = errorEl.createEl('button', { text: '关闭', cls: 'ai-chat-error-dismiss' });
      dismissBtn.addEventListener('click', () => { errorEl.remove(); });
      this.scrollToBottom();
    } finally {
      try { (streamingMessageEl as any)?.remove?.(); } catch {}
      this.inputManager.hideProcessingState();
      this.inputManager.setDisabled(false);
      this.latestAgentRunSnapshot = null;
      try { this.inputManager.focus(); } catch {}
      this.isProcessingMessage = false;
      (this as any).currentAbortController = null;
    }
  }

  /**
   * 检测消息中提及的技能
   */
  private detectMentionedSkill(message: string): string | null {
    // 匹配两种格式：
    //   @skillName       → 简单格式
    //   @skill:"name"    → 完整格式（引号内为技能名）
    
    // 先尝试完整格式 @skill:"name" 或 @skill:name
    const colonMatch = message.match(/@skill:\s*"([^"]+)"|@skill:\s*([^\s@]+)/i);
    if (colonMatch) {
      const skillName = (colonMatch[1] || colonMatch[2] || '').trim();
      if (skillName) {
        const allSkills = this.plugin.skillRegistry.getAllSkills();
        const skill = allSkills.find(s => 
          s.name === skillName || s.id === skillName ||
          s.name.toLowerCase() === skillName.toLowerCase()
        );
        if (skill) return skill.id;
        // 模糊匹配
        const fuzzyMatch = allSkills.find(s =>
          s.name.toLowerCase().includes(skillName.toLowerCase())
        );
        if (fuzzyMatch) return fuzzyMatch.id;
      }
      return null;
    }
    
    // 再尝试简单格式 @skillName
    const mentionRegex = /@([^\s@]+)/g;
    const matches = message.match(mentionRegex);
    if (!matches || matches.length === 0) return null;
    
    const allSkills = this.plugin.skillRegistry.getAllSkills();
    for (const match of matches) {
      const skillName = match.slice(1);
      const skill = allSkills.find(s => 
        s.name === skillName || s.id === skillName ||
        s.name.toLowerCase() === skillName.toLowerCase()
      );
      if (skill) return skill.id;
    }
    
    return null;
  }

  /**
   * 执行技能并继续对话
   */
  private async executeSkillAndContinue(skillId: string, userInput: string, images: string[] = []) {
    const conversation = this.conversations[this.activeConversationId!];
    if (!conversation) return;

    this.inputManager.setDisabled(true);
    
    // 创建中止控制器
    const abortController = new AbortController();
    (this as any).currentAbortController = abortController;

    try {
      this.inputManager.showProcessingState("正在执行技能...", () => {
        abortController.abort();
        this.inputManager.hideProcessingState();
        this.inputManager.setDisabled(false);
        new Notice("已停止执行");
      });

      // 添加用户消息到历史
      conversation.history.push({ role: 'user', content: userInput, images: images });
      this.touchConversation(conversation);
      const userMessageIndex = conversation.history.length - 1;
      await this.messageRenderer.renderMessage({ role: 'user', content: userInput, images: images }, userMessageIndex);
      this.scrollToMessageStart(userMessageIndex);

      // 创建技能执行状态消息
      let statusMessageEl: HTMLElement | null = null;
      let statusContent = "";

      // 执行技能
      const result = await this.plugin.skillRegistry.executeSkill(
        skillId,
        userInput,
        (message) => {
          // 检查是否已中止
          if (abortController.signal.aborted) return;
          
          // 更新状态消息
          if (!statusMessageEl) {
            statusMessageEl = this.chatContainer.createDiv({ cls: "ai-chat-message assistant" });
            const avatar = statusMessageEl.createDiv({ cls: "ai-chat-avatar" });
            setIcon(avatar, "zap");
            const contentDiv = statusMessageEl.createDiv({ cls: "ai-chat-content" });
            contentDiv.createSpan({ cls: "ai-chat-cursor" });
          }
          
          statusContent += message + "\n";
          const contentDiv = statusMessageEl.querySelector(".ai-chat-content") as HTMLElement;
          if (contentDiv) {
            contentDiv.empty();
            contentDiv.innerText = statusContent;
            contentDiv.createSpan({ cls: "ai-chat-cursor" });
          }
          
          this.scrollToBottom();
        },
        abortController.signal
      );

      // 清理状态消息
      if (statusMessageEl) {
        (statusMessageEl as HTMLElement).remove();
      }

      // 保存技能执行结果到历史
      const resultMessage = result.success 
        ? `✅ 技能执行成功\n\n${result.output}`
        : `❌ 技能执行失败\n\n${result.error || '未知错误'}`;
      
      conversation.history.push({ role: 'assistant', content: resultMessage });
      this.touchConversation(conversation);
      await this.messageRenderer.renderMessage({ role: 'assistant', content: resultMessage }, conversation.history.length - 1);
      
      this.saveConversations();
      this.scrollToBottom();

    } catch (error: any) {
      console.error('[AiChat] executeSkillAndContinue failed', error);
      
      if (abortController.signal.aborted) {
        new Notice("技能执行已取消");
        return;
      }
      
      const errorMsg = `❌ 技能执行失败: ${error.message}`;
      const errorEl = this.chatContainer.createDiv({ cls: 'ai-chat-error-bubble' });
      errorEl.createDiv({ cls: 'ai-chat-error-content', text: errorMsg });
      const dismissBtn = errorEl.createEl('button', { text: '关闭', cls: 'ai-chat-error-dismiss' });
      dismissBtn.addEventListener('click', () => { errorEl.remove(); });
      this.scrollToBottom();
      
    } finally {
      this.inputManager.hideProcessingState();
      this.inputManager.setDisabled(false);
      this.inputManager.focus();
      (this as any).currentAbortController = null;
    }
  }

  private lastRenderedConversationId: string | null = null;
  /** 渲染版本号：每次 renderConversation 递增，用于取消已过期的异步渲染 */
  private renderGeneration = 0;
  
  private async renderConversation(conversation: Conversation) {
    // 如果正在处理消息，跳过完整重新渲染以避免重复
    if (this.isProcessingMessage) {
      return;
    }
    
    // 递增渲染版本号，使此前正在进行的异步渲染自动中止
    const generation = ++this.renderGeneration;
    
    // 记录当前渲染的对话ID
    this.lastRenderedConversationId = conversation.id;
    
    this.chatContainer.empty();
    
    // 分批渲染优化：移动端长对话一次性渲染会卡顿
    const history = conversation.history;
    const BATCH_SIZE = 15; // 每批渲染15条消息
    
    for (let i = 0; i < history.length; i += BATCH_SIZE) {
      // 检查渲染是否已被新的渲染取代（竞态保护）
      if (this.renderGeneration !== generation) return;
      
      const batch = history.slice(i, i + BATCH_SIZE);
      
      // 并行渲染当前批次
      await Promise.all(batch.map((message, batchIndex) =>
        this.messageRenderer.renderMessage(message, i + batchIndex).catch(() => {})
      ));
      
      // 批次之间让出主线程，避免阻塞 UI
      if (i + BATCH_SIZE < history.length) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    // 最终检查：如果在渲染过程中已触发了新的渲染，不要执行滚动恢复
    if (this.renderGeneration !== generation) return;
    this.updateRoleplayStateBadge(conversation);
    
    this.restoreActiveConversationScrollOrBottom();

  }

  private renderMessage(message: ChatMessage, index: number) {
    if (this.messageRenderer) {
      this.messageRenderer.renderMessage(message, index);
    }
  }

  private createTopBar(parent: HTMLElement) {
    const surface = parent.createDiv({ cls: "ai-chat-top-surface" });
    const left = surface.createDiv({ cls: "ai-chat-header-left" });
    
    // Collapse/Expand Button (Toggles Top Bar Content)
    const toggleBtn = left.createEl("button", { cls: "ai-chat-tool-btn clickable-icon", attr: { "aria-label": "收起/展开顶部栏" } });
    setIcon(toggleBtn, "chevrons-up"); // Default: Expanded, so show "Up" to collapse
    
    // Container for collapsible elements
    const collapsibleContainer = surface.createDiv({ cls: "ai-chat-top-bar-collapsible" });

    // Collapsed-mode info area (shown when top bar is collapsed)
    const collapsedInfo = surface.createDiv({ cls: "ai-chat-top-collapsed-info" });
    this.topTokenBadgeEl = collapsedInfo.createSpan({ cls: "ai-chat-token-badge is-hidden", text: "" });
    this.topRoleplayStateBadgeEl = collapsedInfo.createSpan({ cls: "ai-chat-roleplay-badge is-hidden", text: "" });

    toggleBtn.onclick = () => {
      const willCollapse = !parent.hasClass("is-collapsed");
      parent.toggleClass("is-collapsed", willCollapse);
      if (willCollapse) {
        setIcon(toggleBtn, "chevrons-down");
        toggleBtn.setAttribute("aria-label", "展开顶部栏");
      } else {
        setIcon(toggleBtn, "chevrons-up");
        toggleBtn.setAttribute("aria-label", "收起顶部栏");
      }
    };

    // Move controls into collapsible container
    // Conversation Controls
    const historyBtn = collapsibleContainer.createEl("button", { cls: "ai-chat-tool-btn clickable-icon", attr: { "aria-label": "历史记录" } });
    setIcon(historyBtn, "history");
    historyBtn.onclick = () => {
        new ConversationManagerModal(this.app, this).open();
    };

    const newChatBtn = collapsibleContainer.createEl("button", { cls: "ai-chat-tool-btn clickable-icon", attr: { "aria-label": "新对话" } });
    setIcon(newChatBtn, "plus-circle");
    newChatBtn.onclick = () => {
        new NewConversationModal(this.app, this).open();
    };

    // Template Manager
    const templateBtn = collapsibleContainer.createEl("button", { cls: "ai-chat-tool-btn clickable-icon", attr: { "aria-label": "模板管理" } });
    setIcon(templateBtn, "layout-template");
    templateBtn.onclick = () => {
        new TemplateManagerModal(this.app, this).open();
    };

    // Persona Selector
    this.createPersonaSelector(collapsibleContainer);

    // Model Selector
    this.createModelSelector(collapsibleContainer);
    
    // Mode Toggle
    this.createModeToggle(collapsibleContainer);
  }

  private async regenerateResponse(index: number) {
    if (!this.activeConversationId) return;
    const conversation = this.conversations[this.activeConversationId];
    if (!conversation) return;

    // Remove messages from index onwards
    const historyToKeep = conversation.history.slice(0, index);
    const lastUserMsg = historyToKeep[historyToKeep.length - 1];
    
    if (lastUserMsg && lastUserMsg.role === 'user') {
        // Pop the user message so handleUserMessage can re-add it
        conversation.history = historyToKeep.slice(0, -1);
        this.plugin.markConversationHistoryForRewrite(conversation.id);

        // 从 DOM 中仅移除 index 位置及之后的消息元素，避免 container.empty() 导致整个界面跳到顶部
        const allMsgEls = this.chatContainer.querySelectorAll<HTMLElement>('.ai-chat-message[data-index]');
        for (const el of Array.from(allMsgEls)) {
          const elIndex = parseInt(el.dataset.index || '-1', 10);
          // 移除要重新生成的用户消息（index-1）及其后所有消息
          if (elIndex >= index - 1) {
            el.remove();
          }
        }

        // Now re-submit the user message (it will be appended to history & container)
        this.handleUserMessage(lastUserMsg.content || "", lastUserMsg.images || []);
    }
  }

  private editMessage(messageEl: HTMLElement, index: number) {
    if (!this.activeConversationId) return;
    const conversation = this.conversations[this.activeConversationId];
    if (!conversation || !conversation.history[index]) return;

    const msg = conversation.history[index];
    const contentDiv = messageEl.querySelector('.ai-chat-content');
    if (!contentDiv) return;

    // Hide original content and toolbar
    (contentDiv as HTMLElement).setCssStyles({ display: 'none' });
    const toolbar = messageEl.querySelector('.ai-chat-message-toolbar');
    if (toolbar) (toolbar as HTMLElement).setCssStyles({ display: 'none' });

    // Create edit area
    const editContainer = messageEl.createDiv({ cls: 'ai-chat-message-edit-area' });
    const textarea = editContainer.createEl('textarea', { 
        text: msg.content || '',
        cls: 'ai-chat-edit-area'
    });
    
    // Auto-resize textarea
    textarea.setCssStyles({ height: 'auto' });
    textarea.setCssStyles({ height: String(textarea.scrollHeight + 'px') });
    textarea.addEventListener('input', () => {
        textarea.setCssStyles({ height: 'auto' });
        textarea.setCssStyles({ height: String(textarea.scrollHeight + 'px') });
    });

    const btnGroup = editContainer.createDiv({ cls: 'ai-chat-edit-actions' });
    
    const saveBtn = btnGroup.createEl('button', { text: '保存', cls: 'mod-cta' });
    let saveAndSubmitBtn: HTMLButtonElement | null = null;
    if (msg.role === 'user') {
      saveAndSubmitBtn = btnGroup.createEl('button', { text: '保存并重发', cls: 'mod-cta' });
    }
    const cancelBtn = btnGroup.createEl('button', { text: '取消' });

    const cleanup = () => {
      editContainer.remove();
      (contentDiv as HTMLElement).setCssStyles({ display: '' });
      if (toolbar) (toolbar as HTMLElement).setCssStyles({ display: '' });
    };

    if (saveAndSubmitBtn) {
      saveAndSubmitBtn.onclick = async () => {
        const newContent = textarea.value.trim();
        if (newContent) {
          msg.content = newContent;
          // Keep history up to this message (excluding this message itself because handleUserMessage will add it)
          conversation.history = conversation.history.slice(0, index);
          this.plugin.markConversationHistoryForRewrite(conversation.id);
          
          const allMsgEls = this.chatContainer.querySelectorAll<HTMLElement>('.ai-chat-message[data-index]');
          for (const el of Array.from(allMsgEls)) {
            const elIndex = parseInt(el.dataset.index || '-1', 10);
            if (elIndex >= index) el.remove();
          }

          // Use the edited content to resubmit
          await this.handleUserMessage(newContent, msg.images);
        }
      };
    }

    saveBtn.onclick = async () => {
        const newContent = textarea.value.trim();
        if (newContent && newContent !== msg.content) {
            msg.content = newContent;
        this.plugin.markConversationHistoryForRewrite(conversation.id);
            await this.saveConversations();
            void this.renderConversation(conversation);
        } else {
            cleanup();
        }
    };

    cancelBtn.onclick = cleanup;
  }

  private deleteMessage(index: number) {
    if (!this.activeConversationId) return;
    const conversation = this.conversations[this.activeConversationId];
    if (!conversation) return;

    conversation.history.splice(index, 1);
    this.plugin.markConversationHistoryForRewrite(conversation.id);
    this.touchConversation(conversation);
    this.saveConversations();
    void this.renderConversation(conversation);
  }

  private scrollToBottom() {
    if (this.chatContainer) {
        this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
    }
  }

  private scrollToMessageStart(index: number, behavior: ScrollBehavior = 'auto') {
    if (!this.chatContainer) return;
    const el = this.chatContainer.querySelector<HTMLElement>(`.ai-chat-message[data-index="${index}"]`);
    if (!el) return;
    try {
      // 使用 scrollTop 精确滚动，避免 scrollIntoView 在最后一条消息时因底部空间不足而滚到末尾
      const scrollEl = this.chatContainer;
      const elTop = el.offsetTop;
      if (behavior === 'smooth') {
        scrollEl.scrollTo({ top: elTop, behavior: 'smooth' });
      } else {
        scrollEl.scrollTop = elTop;
      }
    } catch {
      // ignore
    }
  }

  private async prepareContentForModification(rawContent: string): Promise<string | null> {
    // Placeholder for missing method
    return rawContent; 
  }

  private async reviewAndApplyDiff(file: TFile, oldContent: string, newContent: string) {
     // Placeholder for missing method
     new Notice("Diff review not implemented yet");
  }

  private async performNoteModification(file: TFile, content: string) {
      await this.app.vault.append(file, `\n\n${content}`);
      safeNotice(`已追加到笔记: ${file.basename}`);
  }

  private parseAssistantSegments(rawContent: string): AssistantMessageSegment[] {
      return [];
  }

  // --- 新增：增强的插入内容方法 ---
  private insertTextAtCursor(content: string) {
    // 方案0（优先）：使用记录的最后活动 Markdown 编辑器
    // 这是最可靠的方式，因为当用户点击聊天面板的插入按钮时，
    // 活动视图已经是聊天面板而不是 Markdown 编辑器
    if (this.lastActiveMarkdownLeaf && 
        this.lastActiveMarkdownLeaf.view instanceof MarkdownView && 
        this.lastActiveMarkdownLeaf.view.editor) {
      const editor = this.lastActiveMarkdownLeaf.view.editor;
      const file = this.lastActiveMarkdownLeaf.view.file;
      editor.replaceSelection(content);
      // 聚焦到该编辑器，让用户看到插入结果
      this.app.workspace.setActiveLeaf(this.lastActiveMarkdownLeaf, { focus: true });
      new Notice(`已插入到笔记: ${file?.basename || '未知'}`);
      return;
    }

    // 方案1：标准方式 - 获取当前活动的 MarkdownView
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView && activeView.editor) {
      activeView.editor.replaceSelection(content);
      return;
    }

    // 方案2：替代方式 - 通过 activeLeaf 获取
    const activeLeaf = this.app.workspace.activeLeaf;
    if (activeLeaf && activeLeaf.view instanceof MarkdownView && activeLeaf.view.editor) {
      activeLeaf.view.editor.replaceSelection(content);
      return;
    }

    // 方案3：遍历所有 Markdown 叶子，寻找活动状态的编辑器
    const leaves = this.app.workspace.getLeavesOfType('markdown');
    for (const leaf of leaves) {
      if (leaf.view instanceof MarkdownView && leaf.view.editor && leaf.view.editor.hasFocus()) {
        leaf.view.editor.replaceSelection(content);
        return;
      }
    }

    // 方案4：通过自动引用的当前笔记查找编辑器
    const currentNoteContext = this.contextItems.find(item => item.path === 'current-note-auto');
    if (currentNoteContext) {
      const currentPath = this.resolveCurrentContextFilePath(currentNoteContext);
      const currentAbstract = currentPath ? this.app.vault.getAbstractFileByPath(currentPath) : null;
      const currentFile = currentAbstract instanceof TFile ? currentAbstract : null;
      if (currentFile) {
        // 尝试找到正在编辑该文件的叶子
        const targetLeaf = leaves.find(l => (l.view instanceof MarkdownView) && (l.view as MarkdownView).file?.path === currentFile.path);
        if (targetLeaf && targetLeaf.view instanceof MarkdownView && targetLeaf.view.editor) {
          targetLeaf.view.editor.replaceSelection(content);
          return;
        }
        // 如果找不到编辑器，追加到文件末尾
        this.app.vault.append(currentFile, `\n\n${content}`);
        new Notice("已追加到当前笔记末尾");
        return;
      }
    }

    // 方案5：弹出笔记选择器，让用户手动选择
    new Notice("无法定位到活动笔记，请选择要插入的笔记。");
    new NoteSuggestModal(this.app, (file) => {
      // 先尝试找到该文件的编辑器
      const targetLeaf = this.app.workspace.getLeavesOfType('markdown').find(
        l => (l.view instanceof MarkdownView) && 
             (l.view as MarkdownView).file?.path === file.path
      );
      if (targetLeaf && targetLeaf.view instanceof MarkdownView && targetLeaf.view.editor) {
        targetLeaf.view.editor.replaceSelection(content);
        new Notice("已插入到笔记");
      } else {
        // 如果找不到编辑器，追加到文件
        this.app.vault.append(file, `\n\n${content}`);
        safeNotice(`已追加到笔记: ${file.basename}`);
      }
    }).open();
  }

  private async promptForNoteName(placeholder: string): Promise<string | null> {
      return new Promise((resolve) => {
          const modal = new NoteTitleInputModal(this.app, placeholder, (name) => resolve(name));
          modal.open();
      });
  }

  private async createNoteFromContent(content: string) {
    const title = await this.promptForNoteName("新笔记");
    if (!title) return;
    
    try {
        const file = await this.app.vault.create(`${title}.md`, content);
        const leaf = this.app.workspace.getLeaf(true);
        await leaf.openFile(file);
        safeNotice(`已创建笔记: ${title}`);
    } catch (e) {
      safeNotice(`创建笔记失败: ${(e as any)?.message || String(e)}`);
    }
  }

  private async applyChangesToNote(content: string) {
      // Placeholder for apply changes logic
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile) {
          await this.app.vault.append(activeFile, `\n\n${content}`);
          new Notice("已追加到当前笔记");
      } else {
          new Notice("没有活动的笔记");
      }
  }

  // ============ 群聊功能 ============

  /**
   * 进入群聊模式
   */
  private async enterGroupChatMode() {
    // 动态导入群聊模块
    const { GroupChatManager } = await import('../../features/groupchat/GroupChatManager');
    const { GroupChatRoomModal } = await import('../modals/GroupChatRoomModal');

    if (!this.groupChatManager) {
      this.groupChatManager = new GroupChatManager(this.app, this.plugin);
    }

    const rooms = this.groupChatManager.getRooms();
    
    if (rooms.length === 0) {
      // 没有群聊房间，打开创建弹窗
      new GroupChatRoomModal(this.app, this.plugin, (room) => {
        this.startGroupChat(room);
      }).open();
    } else if (rooms.length === 1) {
      // 只有一个房间，直接进入
      this.startGroupChat(rooms[0]);
    } else {
      // 多个房间，让用户选择
      new GroupChatRoomModal(this.app, this.plugin, (room) => {
        this.startGroupChat(room);
      }).open();
    }
  }

  /**
   * 开始群聊
   */
  private startGroupChat(room: any) {
    this.activeGroupRoomId = room.id;
    this.activeGroupConversation = this.groupChatManager.createConversation(room);
    
    // 清空聊天区域并显示群聊欢迎消息
    this.chatContainer.empty();
    
    // 显示群聊信息栏
    this.renderGroupChatHeader(room);
    
    // 渲染初始消息
    this.renderGroupChatMessages();
    
    safeNotice(`已进入群聊：${room.name}`);
  }

  /**
   * 退出群聊模式
   */
  private exitGroupChatMode() {
    if (this.isGroupChatAutoMode && this.activeGroupConversation) {
      this.groupChatManager?.stopAutoConversation(this.activeGroupConversation);
    }
    this.activeGroupRoomId = null;
    this.activeGroupConversation = null;
    this.isGroupChatAutoMode = false;
    
    // 恢复正常对话视图
    if (this.activeConversationId) {
      const conv = this.conversations[this.activeConversationId];
      if (conv) {
        void this.renderConversation(conv);
      }
    }
  }

  /**
   * 渲染群聊头部信息
   */
  private renderGroupChatHeader(room: any) {
    const header = this.chatContainer.createDiv({ cls: 'groupchat-info-header' });
    
    // 房间信息
    const info = header.createDiv({ cls: 'groupchat-room-info' });
    info.createEl('h3', { text: room.name });
    
    const members = this.groupChatManager.getRooms()
      .find((r: any) => r.id === room.id)?.memberIds || [];
    const memberNames = members.map((id: string) => {
      const persona = this.plugin.settings.personas.find(p => p.id === id);
      return persona?.name || id;
    }).join('、');
    info.createEl('span', { text: `成员：${memberNames}`, cls: 'groupchat-members' });

    // 控制按钮
    const controls = header.createDiv({ cls: 'groupchat-controls' });
    
    // 自动对话按钮
    const autoBtn = controls.createEl('button', { 
      text: this.isGroupChatAutoMode ? '停止自动对话' : '开始自动对话',
      cls: 'mod-cta'
    });
    autoBtn.onclick = () => {
      if (this.isGroupChatAutoMode) {
        this.stopGroupChatAuto();
        autoBtn.textContent = '开始自动对话';
        autoBtn.removeClass('is-active');
      } else {
        this.startGroupChatAuto();
        autoBtn.textContent = '停止自动对话';
        autoBtn.addClass('is-active');
      }
    };
    
    // 切换房间按钮
    const switchBtn = controls.createEl('button', { text: '切换房间' });
    switchBtn.onclick = async () => {
      const { GroupChatRoomModal } = await import('../modals/GroupChatRoomModal');
      new GroupChatRoomModal(this.app, this.plugin, (room) => {
        this.startGroupChat(room);
      }).open();
    };
  }

  /**
   * 渲染群聊消息
   */
  private renderGroupChatMessages() {
    if (!this.activeGroupConversation) return;

    // 清空消息区域（保留头部）
    const header = this.chatContainer.querySelector('.groupchat-info-header');
    this.chatContainer.empty();
    if (header) {
      this.chatContainer.appendChild(header);
    }

    const messagesContainer = this.chatContainer.createDiv({ cls: 'groupchat-messages' });

    for (const msg of this.activeGroupConversation.history) {
      this.renderGroupChatMessage(messagesContainer, msg);
    }

    // 滚动到底部
    this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
  }

  /**
   * 渲染单条群聊消息
   */
  private renderGroupChatMessage(container: HTMLElement, msg: any) {
    const msgDiv = container.createDiv({ 
      cls: `groupchat-message ${msg.role === 'user' ? 'user' : 'assistant'}`
    });

    // 头像
    const avatarDiv = msgDiv.createDiv({ cls: 'groupchat-avatar' });
    if (msg.role === 'user') {
      setIcon(avatarDiv, 'user');
    } else if (msg.speakerAvatar) {
      const avatarUrl = this.resolveAvatarUrl(msg.speakerAvatar);
      if (avatarUrl) {
        const img = avatarDiv.createEl('img', { attr: { src: avatarUrl } });
        img.onerror = () => {
          img.remove();
          avatarDiv.addClass('groupchat-avatar-placeholder');
          avatarDiv.textContent = (msg.speakerName || 'AI').charAt(0).toUpperCase();
        };
      } else {
        avatarDiv.addClass('groupchat-avatar-placeholder');
        avatarDiv.textContent = (msg.speakerName || 'AI').charAt(0).toUpperCase();
      }
    } else {
      avatarDiv.addClass('groupchat-avatar-placeholder');
      avatarDiv.textContent = (msg.speakerName || 'AI').charAt(0).toUpperCase();
    }

    // 消息内容
    const bubbleDiv = msgDiv.createDiv({ cls: 'groupchat-bubble' });
    
    // 发言者名称（AI 消息）
    if (msg.role === 'assistant' && msg.speakerName) {
      bubbleDiv.createEl('div', { text: msg.speakerName, cls: 'groupchat-speaker-name' });
    }

    // 消息正文
    const contentDiv = bubbleDiv.createDiv({ cls: 'groupchat-content' });
    MarkdownRenderer.render(this.app, msg.content || '', contentDiv, '', this);

    // 时间戳
    if (msg.timestamp) {
      const time = new Date(msg.timestamp).toLocaleTimeString();
      bubbleDiv.createEl('div', { text: time, cls: 'groupchat-timestamp' });
    }
  }

  /**
   * 解析头像 URL
   */
  private resolveAvatarUrl(avatar: string): string {
    if (!avatar) return '';
    if (avatar.startsWith('data:') || avatar.startsWith('http')) return avatar;
    const file = this.app.vault.getAbstractFileByPath(avatar);
    if (file) {
      return this.app.vault.getResourcePath(file as any);
    }
    return avatar;
  }

  /**
   * 开始自动对话模式
   */
  private async startGroupChatAuto() {
    if (!this.activeGroupConversation || !this.groupChatManager) return;
    
    this.isGroupChatAutoMode = true;
    
    await this.groupChatManager.startAutoConversation(
      this.activeGroupConversation,
      (msg: any) => {
        // 新消息回调，更新视图
        this.appendGroupChatMessage(msg);
      },
      () => {
        // 停止回调
        this.isGroupChatAutoMode = false;
      }
    );
  }

  /**
   * 停止自动对话
   */
  private stopGroupChatAuto() {
    if (!this.activeGroupConversation || !this.groupChatManager) return;
    this.groupChatManager.stopAutoConversation(this.activeGroupConversation);
    this.isGroupChatAutoMode = false;
  }

  /**
   * 追加群聊消息到视图
   */
  private appendGroupChatMessage(msg: any) {
    const messagesContainer = this.chatContainer.querySelector('.groupchat-messages');
    if (messagesContainer) {
      this.renderGroupChatMessage(messagesContainer as HTMLElement, msg);
      this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
    }
  }

  /**
   * 处理群聊用户消息
   */
  private async handleGroupChatMessage(content: string) {
    if (!this.activeGroupConversation || !this.groupChatManager) return;

    try {
      // 先创建并渲染用户消息
      const messagesContainer = this.chatContainer.querySelector('.groupchat-messages');
      if (messagesContainer) {
        const userMsg = {
          id: `msg-${Date.now()}`,
          role: 'user' as const,
          content,
          speakerId: 'user',
          speakerName: '你',
          timestamp: Date.now(),
          mentions: []
        };
        this.renderGroupChatMessage(messagesContainer as HTMLElement, userMsg);
        this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
      }

      // 发送用户消息并获取回复
      const responses = await this.groupChatManager.sendUserMessage(
        this.activeGroupConversation,
        content,
        (msg: any) => {
          this.appendGroupChatMessage(msg);
        }
      );

      // 滚动到底部
      this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
    } catch (error) {
      console.error('群聊消息处理失败:', error);
      safeNotice('消息发送失败，请重试');
    }
  }

  async onClose() {
    // Persist the last scroll position so toggling views doesn't jump to top.
    this.captureActiveConversationScroll();

    // Clean up
    if (this.actionResizeObserver) {
      this.actionResizeObserver.disconnect();
    }
    if (this.actionMediaQuery && this.actionMediaQueryListener) {
      this.actionMediaQuery.removeEventListener('change', this.actionMediaQueryListener);
    }
    if (this.messageRenderer) {
      this.messageRenderer.unload();
    }
  }
}
