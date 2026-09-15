import { Notice } from "obsidian";
import { logger } from "../../core/logger";
import type { ChatMessage } from "../../core/types";
import type { AiChatAssistantSettings } from "../../core/settings";
import type { ContextBlock, ContextBudgetDiagnostics, ContextBudgetManager } from "../../services/context/ContextBudgetManager";
import type { LLMService } from "../../services/llm/LLMService";
import type { SearchSubagent } from "./SearchSubagent";
import type { ExecutionSession } from "./ExecutionSession";
import type { RepairLoop } from "./RepairLoop";
import type { SearchPlannerResult } from "./SearchPlanner";
import type { SkillRegistry } from "../skills/SkillRegistry";
import { SkillMatcher } from "../skills/SkillMatcher";

const RECENT_CHOICE_PATTERNS = [
  /(方案|选项)\s*[A-D]/i,
  /[A-D]\s*方案/i,
  /选择\s*[A-D]/i,
  /选\s*[A-D]/i,
  /完善并写入|完善后写入|直接写入|写回去/i,
];

const shouldPinRecentHistory = (text: string): boolean => {
  const normalized = String(text || "").trim();
  if (!normalized) return false;
  return RECENT_CHOICE_PATTERNS.some(pattern => pattern.test(normalized));
};

export interface ComposeAgentRuntimeInputParams {
  settings: AiChatAssistantSettings;
  llmService: LLMService;
  contextBudgetManager: ContextBudgetManager;
  replacePromptPlaceholders: (text: string, charName?: string) => string;
  searchSubagent: SearchSubagent;
  agentName: string;
  agentSystemPrompt: string;
  agentMbtiPrompt: string;
  datePrompt: string;
  memoryContext: string;
  privateMemoryContext: string;
  memoryUsageRules: string;
  userInput: string;
  context: string;
  images?: string[];
  history: ChatMessage[];
  routingContext: string;
  evidenceBundle: any;
  executionSession: ExecutionSession;
  repairLoop: RepairLoop;
  searchPlan?: SearchPlannerResult;
  reflectionContext?: string;
  selectedAgentModel: string;
  signal?: AbortSignal;
  emitAgentUpdate?: (content: string, options?: { verbose?: boolean }) => void;
  availableToolsPrompt?: string;
  skillRegistry?: SkillRegistry;
}

export interface ComposeAgentRuntimeInputResult {
  systemPrompt: string;
  stableSystemPrompt?: string;
  history: ChatMessage[];
  userMessage: ChatMessage;
  finalUserInput: string;
  diagnostics?: ContextBudgetDiagnostics;
  contextBudgetEnabled: boolean;
  contextBudgetTokens: number;
  compressedHistoryCount: number;
  shortStatus: string;
  promptBlocks: ContextBlock[];
}

export class AgentInputComposer {
  private skillMatcher: SkillMatcher;

  constructor() {
    this.skillMatcher = new SkillMatcher();
  }

  public async compose(params: ComposeAgentRuntimeInputParams): Promise<ComposeAgentRuntimeInputResult> {
    const {
      settings,
      llmService,
      contextBudgetManager,
      replacePromptPlaceholders,
      searchSubagent,
      agentName,
      agentSystemPrompt,
      agentMbtiPrompt,
      datePrompt,
      memoryContext,
      privateMemoryContext,
      memoryUsageRules,
      userInput,
      context,
      images,
      history,
      routingContext,
      evidenceBundle,
      executionSession,
      repairLoop,
      searchPlan,
      reflectionContext,
      selectedAgentModel,
      signal,
      emitAgentUpdate,
    } = params;

    const maxHistory = settings.maxHistoryMessages;
    let slicedHistory = maxHistory > 0 ? history.slice(-maxHistory) : history;
    let compressedHistoryCount = 0;
    const pinRecentHistory = shouldPinRecentHistory(userInput);

    if (pinRecentHistory && maxHistory > 0 && history.length > maxHistory) {
      const pinnedTail = history.slice(-Math.max(maxHistory + 4, Math.min(history.length, maxHistory + 8)));
      slicedHistory = pinnedTail;
    }

    if (settings.enableContextCompression && history.length > settings.compressionThreshold) {
      const keepCount = Math.floor(settings.compressionThreshold / 2);
      const toCompress = history.slice(0, history.length - keepCount);
      const toKeep = history.slice(history.length - keepCount);

      if (toCompress.length > 0) {
        new Notice("正在压缩历史上下文...");
        try {
          emitAgentUpdate?.(`🗜️ [Compression] 正在压缩 ${toCompress.length} 条历史消息...\n`, { verbose: true });
          const compressionModel = settings.writerModel || settings.plannerModel || selectedAgentModel;
          const summary = await llmService.summarizeMessages(toCompress, compressionModel, {
            maxInputTokens: 2400,
            maxOutputBullets: 8,
            signal,
          });
          compressedHistoryCount = toCompress.length;
          slicedHistory = [
            {
              role: "system",
              content:
                `[Previous Conversation Summary]\n` +
                `以下为较早历史消息的压缩摘要，请将其视为已确认的会话上下文，仅在与后续消息不冲突时使用：\n${summary}`,
            },
            ...toKeep,
          ];
          emitAgentUpdate?.(`🗜️ [Compression] 已压缩 ${toCompress.length} 条历史消息。\n`, { verbose: true });
        } catch (e) {
          logger.error("AI", "Context compression failed", e);
          slicedHistory = maxHistory > 0 ? history.slice(-maxHistory) : history;
          emitAgentUpdate?.(`⚠️ [Compression] 历史压缩失败，已回退到常规截断。\n`, { verbose: true });
        }
      }
    }

    const isFocused = searchPlan?.executionMode === "focused";
    const isDeep = searchPlan?.executionMode === "deep";

    const isChitchatOrNoTools = searchPlan?.isChitchat || executionSession.getCurrentPhase() === "answer";
    
    // chitchat 约束块：不修改 agent-core 缓存锚点，改为独立追加动态块
    const chitchatOverrideBlocks: ContextBlock[] = [];
    if (isChitchatOrNoTools) {
      chitchatOverrideBlocks.push({
        key: "chitchat-override",
        content: "【当前模式：纯聊天模式】你现在是一个友好的对话助手。当前没有开启任何文件读取、修改或创建权限。**绝对禁止**输出任何带有 JSON 格式的工具调用代码块，或声称/暗示你能操作文件。",
        priority: "critical",
        maxTokens: 200,
        compressible: false,
      });
      chitchatOverrideBlocks.push({
        key: "chitchat-no-tool-reminder",
        content: "【工具约束覆盖】以下三条工具使用规则在当前聊天模式下不适用，请忽略：\n1. 不要求先搜索/读取确认目标\n2. 不要求用 replace_in_note 精准替换\n3. 不要求用 modify_note 整段写入",
        priority: "high",
        maxTokens: 120,
      });
    }

    const promptBlocks: ContextBlock[] = [
      ...(searchPlan?.isChitchat ? [{ key: "chitchat-constraint", content: "【⚠️绝对指令】当前处于纯聊天模式，你的所有笔记读写、创建工具**已被系统物理移除**。你现在**完全没有能力**操作任何笔记或文件。绝不允许在回复中假装、声称或暗示你“已经创建了笔记”、“为你写好了计划文件”。如果你想给出计划，必须明确告诉用户“我只能在这里用文字为你提供建议”，然后直接在对话框里写出来。严禁欺骗用户！同时，**绝对禁止**输出任何带有 JSON 格式的工具调用代码块，这毫无意义系统也不会执行。", priority: "critical", compressible: false } as ContextBlock] : []),
      { key: "anti-hallucination", content: `【⚠️行为真实性红线】如果你要为用户创建、修改或写入笔记，你**必须且只能**通过实际调用相应的工具（如 create_note, modify_note 等）来完成。**绝对禁止**在没有成功调用工具并获得返回结果的情况下，在对话中声称\u201c我已经帮你创建了笔记\u201d、\u201c已整理到xx笔记中\u201d或\u201c已写入\u201d。如果你当前没有工具可用，或者你选择只输出纯文本，你必须诚实地告诉用户：\u201c我在此用文字为你提供计划/建议，请你自行创建笔记。\u201d 严禁通过纯文本伪造操作成功的假象！`, priority: "critical", compressible: false, cacheAnchor: true },
      { key: "agent-core", content: agentSystemPrompt, priority: "critical", compressible: false, cacheAnchor: true },
      { key: "date", content: datePrompt, priority: "low", maxTokens: 80 },
      { key: "agent-mbti", content: agentMbtiPrompt, priority: "low", maxTokens: 120 },
      { key: "memory-rules", content: memoryUsageRules, priority: "high", maxTokens: 280 },
    ];

    if (params.availableToolsPrompt) {
      promptBlocks.push({ key: "available-tools", content: params.availableToolsPrompt, priority: "high", maxTokens: 800 });
    }

    if (executionSession.hasActiveDecisionState()) {
      promptBlocks.push({ key: "decision-state", content: executionSession.formatDecisionStateForPrompt(), priority: "critical", maxTokens: 320, compressible: false });
    }

    if (memoryContext) promptBlocks.push({ key: "memory-context", content: memoryContext, priority: "medium", maxTokens: 700 });
    if (privateMemoryContext) promptBlocks.push({ key: "private-memory", content: privateMemoryContext, priority: "medium", maxTokens: 700 });

    if (isDeep) {
      promptBlocks.push({ key: "routing-context", content: routingContext, priority: "high", maxTokens: 520 });
    } else if (!isFocused) {
      // For structured mode, keep it brief
      promptBlocks.push({ key: "routing-context", content: "【任务路由】使用当前提供的最小必要工具完成任务。先找证据再执行。", priority: "low", maxTokens: 100 });
    }

    promptBlocks.push({ key: "evidence-bundle", content: searchSubagent.formatForPrompt(evidenceBundle), priority: "high", maxTokens: 720 });

    if (executionSession.getCurrentPhase() !== "answer" && (isDeep || executionSession.getCurrentPhase() !== "act")) {
      promptBlocks.push({ key: "execution-phase", content: executionSession.formatForPrompt(), priority: "high", maxTokens: 280 });
    }
    
    if (repairLoop.hasPendingIssues()) {
      promptBlocks.push({ key: "repair-loop", content: repairLoop.formatForPrompt(), priority: "medium", maxTokens: 220 });
    }

    if (reflectionContext && isDeep) {
      promptBlocks.push({ key: "reflection", content: reflectionContext, priority: "medium", maxTokens: 320 });
    }

    // 动态技能注入：根据用户输入匹配相关技能
    if (params.skillRegistry && settings.enableSkillInjection !== false) {
      const enabledSkills = params.skillRegistry.getEnabledSkills();
      const maxSkillsToInject = settings.maxSkillsToInject || 2;
      
      if (enabledSkills.length > 0) {
        const matchedSkills = this.skillMatcher.matchSkills(userInput, enabledSkills, maxSkillsToInject);
        
        if (matchedSkills.length > 0) {
          emitAgentUpdate?.(`🎯 [Skills] 匹配到 ${matchedSkills.length} 个相关技能: ${matchedSkills.map(s => s.name).join(', ')}\n`, { verbose: true });
          
          for (const skill of matchedSkills) {
            if (this.skillMatcher.shouldInjectSkill(skill)) {
              const skillPrompt = this.skillMatcher.formatSkillPrompt(skill);
              promptBlocks.push({
                key: `skill-${skill.id}`,
                content: skillPrompt,
                priority: "medium",
                maxTokens: 1500, // 限制单个技能的最大 token 数
              });
            }
          }
        }
      }
    }

    // 追加 chitchat 模式覆盖块（不修改 agent-core 缓存锚点）
    for (const block of chitchatOverrideBlocks) {
      promptBlocks.push(block);
    }

    const contextBudgetEnabled = settings.enableContextBudgetManager !== false;
    const contextBudgetTokens = Math.max(2000, settings.agentContextBudgetTokens || 12000);
    const composedAgentInput = contextBudgetEnabled
      ? contextBudgetManager.composeAgentInput({
          budgetTokens: contextBudgetTokens,
          systemBlocks: promptBlocks,
          history: slicedHistory,
          userInput,
          userContext: context,
          images,
          preserveTailPatterns: pinRecentHistory ? RECENT_CHOICE_PATTERNS : undefined,
        })
      : null;

    let systemPrompt = composedAgentInput
      ? composedAgentInput.systemPrompt
      : promptBlocks.map(block => String(block.content || "").trim()).filter(Boolean).join("\n\n");
    systemPrompt = replacePromptPlaceholders(systemPrompt, agentName);

    const finalUserInput = composedAgentInput?.userMessage.content || userInput;
    const finalHistory = composedAgentInput?.history || slicedHistory;
    const userMessage = composedAgentInput?.userMessage || { role: "user" as const, content: finalUserInput, images };
    const shortStatusParts = [
      executionSession.getShortStatus(),
      composedAgentInput ? contextBudgetManager.getShortStatus(composedAgentInput.diagnostics) : "",
    ].filter(Boolean);

    return {
      systemPrompt,
      stableSystemPrompt: composedAgentInput?.stableSystemPrompt || undefined,
      history: finalHistory,
      userMessage,
      finalUserInput,
      diagnostics: composedAgentInput?.diagnostics,
      contextBudgetEnabled,
      contextBudgetTokens,
      compressedHistoryCount,
      shortStatus: shortStatusParts.join("｜"),
      promptBlocks,
    };
  }
}
