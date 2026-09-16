import type { ConversationTemplate } from "./settings";
import { TFile } from "obsidian";
import { ParsedDiff } from 'diff';

export interface ReferenceItem {
  title: string;
  path: string;
  score: number;
  startOffset?: number;
  endOffset?: number;
  /** Obsidian subpath for fragment-level linking, e.g. "#heading" or "#^blockId" */
  subpath?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  references?: ReferenceItem[];
  images?: string[]; // Base64 data URIs
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string; // Optional name for tool messages or function calls
  intermediateMessages?: ChatMessage[]; // For agent steps
  reasoning_content?: string; // DeepSeek reasoning model's reasoning content
  internalOnly?: boolean;
  /** 缓存锚定标记：标记为 true 的 system 消息内容稳定不变，作为 DeepSeek KV cache 前缀锚点 */
  cacheAnchor?: boolean;
}

export type ConversationModelSource = 'conversation' | 'agent' | 'mode-default' | 'default-chat';
export type AgentRunStatus = 'idle' | 'running' | 'cancelled' | 'failed' | 'completed';
export type AgentRunPhase = 'inspect' | 'act' | 'repair' | 'answer';

export type AgentBusinessStatus = 'unknown' | 'no-write' | 'verified-write' | 'unverified-write' | 'failed-write';
export type DecisionApprovalStatus = 'idle' | 'proposed' | 'selected' | 'approved' | 'executing' | 'completed' | 'failed' | 'cancelled';
export type DecisionTriggerType = 'user-input' | 'planner' | 'assistant' | 'system' | 'unknown';

export interface DecisionOption {
  id: string;
  label: string;
  summary: string;
  details?: string;
}

export interface DecisionProposal {
  id: string;
  title?: string;
  summary: string;
  options: DecisionOption[];
  sourceMessageIndex?: number;
  createdAt: number;
}

export interface DecisionSelection {
  proposalId: string;
  optionId: string;
  reason?: string;
  selectedAt: number;
}

export interface PendingDecisionTarget {
  kind: 'write' | 'edit' | 'create' | 'reply' | 'unknown';
  summary: string;
  notePath?: string;
  sectionLabel?: string;
  instructions?: string;
  updatedAt: number;
}

export interface ConversationDecisionState {
  currentProposal?: DecisionProposal;
  selection?: DecisionSelection;
  approvalStatus?: DecisionApprovalStatus;
  pendingTarget?: PendingDecisionTarget;
  triggerType?: DecisionTriggerType;
  lastUpdatedAt?: number;
}

export interface AgentRunSnapshot {
  runId: string;
  status: AgentRunStatus;
  phase: AgentRunPhase;
  currentStep?: number;
  completedSteps?: number;
  totalSteps?: number;
  lastToolName?: string;
  lastToolSummary?: string;
  lastVerificationSummary?: string;
  repairSummary?: string;
  abortReason?: string;
  stopReason?: string;
  businessStatus?: AgentBusinessStatus;
  businessSummary?: string;
  batchTotal?: number;
  batchCompleted?: number;
  currentTarget?: string;
  completedTargets?: string[];
  updatedAt: number;
}

export interface RoleplayStateEntity {
  name?: string;
  [key: string]: string | number | boolean | undefined;
}

export interface ConversationRoleplayState {
  version?: number;
  updatedAt?: number;
  rawDataBlock?: string;
  player?: RoleplayStateEntity;
  partners?: RoleplayStateEntity[];
  npcs?: RoleplayStateEntity[];
  quests?: RoleplayStateEntity[];
  beauties?: RoleplayStateEntity[];
  worldEvents?: RoleplayStateEntity[];
  messages?: RoleplayStateEntity[];
  variables?: Record<string, string | number | boolean>;
}

export interface Conversation {
  id: string;
  title: string;
  history: ChatMessage[];
  /**
   * Internal flag: whether history has been loaded from disk.
   * Used to avoid loading all histories at startup.
   */
  historyLoaded?: boolean;
  model: string;
  todoList?: TodoItem[];
  lastContextTokensEstimate?: number;
  pinned?: boolean;
  starred?: boolean;
  archived?: boolean;
  tags?: string[];
  templateId?: string | null;
  createdAt?: number;
  updatedAt?: number;
  personaId?: string;
  messageCount?: number;
  previewText?: string;
  firstUserText?: string;
  /** Agent ID associated with this conversation (for agent mode) */
  agentId?: string;
  /** Tool policy bound to this conversation for agent execution. */
  toolPolicyId?: string;
  /** Resolved model source for explainability/UI alignment. */
  modelSource?: ConversationModelSource;

  /**
   * UI state: last selected entry/work mode in chat panel.
   * Stored to restore the mode when switching conversations.
   */
  uiEntryMode?: string;
  /** In-memory only lightweight agent execution snapshot. */
  agentRunSnapshot?: AgentRunSnapshot;
  /** Persisted conversation-level decision state for proposal/selection/approval continuity. */
  decisionState?: ConversationDecisionState;
  /** Persisted roleplay state parsed from assistant <data_block>. */
  roleplayState?: ConversationRoleplayState;
}

export type TodoStatus = 'not-started' | 'in-progress' | 'completed';

export interface TodoItem {
  id: number;
  title: string;
  description: string;
  status: TodoStatus;
}

export interface NewConversationOptions {
  templateId?: string;
  title?: string;
  tags?: string[];
}

export interface IAiChatView {
  getConversations(): Record<string, Conversation>;
  getConversationTemplates(): ConversationTemplate[];
  createNewConversation(options?: NewConversationOptions): void;
  switchToConversation(id: string): void;
  toggleConversationPin(id: string): void;
  toggleConversationStar(id: string): void;
  setConversationArchived(id: string, archived: boolean): void;
  updateConversationTags(id: string, tags: string[]): void;
  exportConversationToNote(conversation: Conversation): void;
  exportConversationAsMarkdown(conversation: Conversation): void;
  deleteConversation(id: string): void;
  deleteConversations(ids: string[]): void;
  deleteAllConversations(): void;
  sortConversations(conversations: Conversation[]): Conversation[];
  saveSettings(): Promise<void>;
}

export interface ContextItem {
  type: 'file' | 'folder' | 'tag';
  path: string;
  displayName: string;
  actualPath?: string;
}

export type AssistantSegmentType = 'preface' | 'modification' | 'reference' | 'suggestion' | 'unknown';

export interface AssistantMessageSegment {
  id: string;
  title: string;
  body: string;
  type: AssistantSegmentType;
  snippet: string;
  defaultSelected: boolean;
}

export type DiffLine = {
  sign: ' ' | '+' | '-';
  text: string;
  oldNumber?: number;
  newNumber?: number;
};

export interface UiDiffHunk {
  index: number;
  header: string;
  lines: DiffLine[];
  oldText: string;
  newText: string;
}

export interface DiffComputationResult {
  patch: ParsedDiff;
  hunks: UiDiffHunk[];
}
