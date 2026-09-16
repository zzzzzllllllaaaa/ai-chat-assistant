import { App, Platform } from "obsidian";
import type { AiChatAssistantSettings } from "../../core/settings";
import type { ChatMessage, ReferenceItem, AgentRunSnapshot, ConversationDecisionState, DecisionOption, DecisionProposal, PendingDecisionTarget } from "../../core/types";
import type { LLMService } from "../../services/llm/LLMService";
import type { ContextBudgetManager } from "../../services/context/ContextBudgetManager";
import { estimateTokensFromMessages } from "../../core/tokenEstimate";
import { logger } from "../../core/logger";
import { buildToolSurface } from "./ToolSurfaceBuilder";
import { SearchPlanner } from "./SearchPlanner";
import { SearchSubagent } from "./SearchSubagent";
import { ToolRouter } from "./ToolRouter";
import { PermissionManager } from "./PermissionManager";
import { ExecutionVerifier } from "./ExecutionVerifier";
import { ExecutionSession } from "./ExecutionSession";
import { RepairLoop } from "./RepairLoop";
import { AgentInputComposer } from "./AgentInputComposer";
import { ToolBatchExecutor, buildModelSafeParameters } from "./ToolBatchExecutor";
import { getReflectionManager } from "./reflection";
import { AgentManager } from "./manager";
import { getMBTIPrompt } from "../../services/llm/mbti";
import type { SkillExecutionResult } from "../skills";

export interface AgentExecutionParams {
  userInput: string;
  mode: "agent";
  history: ChatMessage[];
  context: string;
  images?: string[];
  onUpdate?: (content: string) => void;
  onMeta?: (meta: { contextTokensEstimate: number; mode: string; model: string }) => void;
  onRunSnapshot?: (snapshot: AgentRunSnapshot) => void;
  signal?: AbortSignal;
  effectiveAgentId: string;
  effectiveModel: string;
  toolPolicyId: string;
  datePrompt: string;
  memoryContext: string;
  privateMemoryContext: string;
  memoryUsageRules: string;
  decisionState?: ConversationDecisionState;
}

export interface AgentExecutionResult {
  content: string;
  references?: ReferenceItem[];
  intermediateMessages?: ChatMessage[];
  reasoning_content?: string;
  meta?: { contextTokensEstimate: number };
  decisionState?: ConversationDecisionState;
}

export interface AgentExecutorServices {
  app: App;
  settings: AiChatAssistantSettings;
  llmService: LLMService;
  ragService?: { isReady?: () => boolean };
  agentManager: AgentManager;
  searchPlanner: SearchPlanner;
  searchSubagent: SearchSubagent;
  toolRouterAgent: ToolRouter;
  permissionManager: PermissionManager;
  executionVerifier: ExecutionVerifier;
  contextBudgetManager: ContextBudgetManager;
  skillRegistry?: any; // SkillRegistry
  executeSkill?: (
    skillId: string,
    userInput: string,
    onUpdate?: (message: string) => void,
    signal?: AbortSignal
  ) => Promise<SkillExecutionResult>;
  replacePromptPlaceholders: (text: string, charName?: string) => string;
  formatStepSummary: (
    stepHeader: string,
    instruction: string,
    result: string,
    stepMessages: ChatMessage[],
    hasToolCalls: boolean
  ) => string;
  triggerToolReflection: (
    toolName: string,
    toolArgs: any,
    errorMessage: string,
    contextMessages: ChatMessage[]
  ) => Promise<void>;
  triggerUserFeedbackReflection: (
    userFeedback: string,
    recentHistory: ChatMessage[]
  ) => Promise<void>;
}

type InternalStepLogPayload = {
  type: "step-summary" | "decision-state";
  summary: string;
  trace?: any;
};

export class AgentExecutor {
  constructor(private readonly services: AgentExecutorServices) {}

  public async execute(params: AgentExecutionParams): Promise<AgentExecutionResult> {
    const {
      userInput,
      mode,
      history,
      context,
      images,
      onUpdate,
      onMeta,
      onRunSnapshot,
      signal,
      effectiveAgentId,
      effectiveModel,
      toolPolicyId,
      datePrompt,
      memoryContext,
      privateMemoryContext,
      memoryUsageRules,
      decisionState,
    } = params;

    // if (Platform.isMobile && onUpdate) {
    //   onUpdate("📱 *移动端提示：请保持 Obsidian 在前台运行，切换到后台可能导致任务中断。*\n\n");
    // }

    const agentId = effectiveAgentId;
    const agent = this.services.agentManager.getAgent(agentId);
    if (!agent) throw new Error(`未找到智能体: ${agentId}`);

    const runId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let completedToolCalls = 0;
    let totalPlannedSteps = 0;

    const reflectionMgr = getReflectionManager();
    const relevantReflections = reflectionMgr.getRelevantReflections({
      toolNames: agent.tools,
      limit: 5,
    });
    const reflectionContext = reflectionMgr.formatReflectionsForContext(relevantReflections);

    const presetId = this.services.settings.activePresetId || "default";
    const agentMbtiPrompt = agent.mbti ? getMBTIPrompt(agent.mbti) : "";
    let tools = this.services.agentManager.getToolsForAgent(agentId);

    const searchPlan = await this.services.searchPlanner.plan({
      userInput,
      context,
      mode,
      agentName: agent.name,
      isCustomAgent: !agent.isPreset,
      availableTools: tools.map(t => t.definition.name),
    });
    logger.info("AI", "Agent search plan", {
      agentId: effectiveAgentId,
      intent: searchPlan.intent,
      confidence: searchPlan.confidence,
      executionMode: searchPlan.executionMode,
      taskScope: searchPlan.taskScope,
      needsPlan: searchPlan.needsPlan,
      shouldUseSynth: searchPlan.shouldUseSynth,
      shouldInspectBeforeWrite: searchPlan.shouldInspectBeforeWrite,
      candidateFiles: searchPlan.candidateFiles.map(f => f.path),
      recommendedTools: searchPlan.recommendedTools,
    });
    totalPlannedSteps = Math.max(searchPlan.recommendedTools?.length || 0, searchPlan.candidateFiles?.length || 0, 1);

    const evidenceBundle = await this.services.searchSubagent.run({
      userInput,
      context,
      planner: searchPlan,
    });

    const firstActionPlan = this.services.searchPlanner.selectFirstActions(
      searchPlan,
      evidenceBundle,
      tools.map(t => t.definition.name),
    );

    const { policy, policyAllowedToolNames: allowedToolNames, filtered, toolRouting, tools: preparedTools } = buildToolSurface({
      tools,
      toolPolicyId,
      planner: searchPlan,
      toolRouter: this.services.toolRouterAgent,
      preferredStartTools: firstActionPlan.firstRoundToolNames,
      learnedToolSignals: evidenceBundle.learnedToolSignals,
      ragReady: Boolean(this.services.ragService?.isReady?.()),
      isCustomAgent: !agent.isPreset,
    });
    logger.info("AI", "Agent tool surface", {
      policyId: toolPolicyId,
      policyFiltered: filtered,
      policyAllowedCount: allowedToolNames.length,
      allowedTools: toolRouting.allowedToolNames,
      firstRoundTools: toolRouting.firstRoundToolNames,
      blockedTools: toolRouting.blockedToolNames,
      reasoning: toolRouting.reasoning,
    });

    const executionSession = new ExecutionSession({
      shouldInspectBeforeWrite: searchPlan.shouldInspectBeforeWrite,
      userGoal: userInput,
    });
    executionSession.hydrateDecisionState(decisionState);

    const primeDecisionStateBeforeCompose = () => {
      const currentState = executionSession.getDecisionState();
      if (!currentState.currentProposal) {
        const assistantMessages = [...(history || [])]
          .reverse()
          .filter(msg => msg?.role === "assistant" && typeof msg?.content === "string");
        for (const msg of assistantMessages.slice(0, 6)) {
          const lines = String(msg.content || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
          const options: DecisionOption[] = [];
          for (const line of lines) {
            const match = line.match(/^(?:[-*]\s*)?(?:方案|选项)?\s*([A-D])(?:\s*[：:.-]\s*|\s+)(.+)$/i);
            if (!match) continue;
            const id = match[1].toUpperCase();
            const summary = match[2].trim();
            if (!summary || options.some(option => option.id === id)) continue;
            options.push({ id, label: `方案 ${id}`, summary });
          }
          if (options.length >= 2) {
            executionSession.applyDecisionEvent({
              type: "proposal.created",
              proposal: {
                id: `proposal-${Date.now()}`,
                title: "最近候选方案",
                summary: lines.slice(0, 3).join(" ").slice(0, 200),
                options,
                createdAt: Date.now(),
              },
              triggerType: "assistant",
            });
            break;
          }
        }
      }

      const proposal = executionSession.getDecisionState().currentProposal;
      const selectionMatch = String(userInput || "").trim().match(/(?:方案|选项)?\s*([A-D])\b|\b([A-D])\s*方案\b/i);
      const selectedOptionId = (selectionMatch?.[1] || selectionMatch?.[2] || "").toUpperCase();
      if (proposal && selectedOptionId && proposal.options.some(option => option.id === selectedOptionId)) {
        executionSession.applyDecisionEvent({
          type: "proposal.selected",
          selection: {
            proposalId: proposal.id,
            optionId: selectedOptionId,
            reason: String(userInput || "").trim(),
            selectedAt: Date.now(),
          },
          triggerType: "user-input",
        });
      }

      if (searchPlan.reasoning.some(item => /明确批准执行|act-first/i.test(item))) {
        executionSession.applyDecisionEvent({ type: "proposal.approved", triggerType: "user-input" });
        const state = executionSession.getDecisionState();
        const selectedOption = state.currentProposal?.options?.find(option => option.id === state.selection?.optionId);
        const baseSummary = selectedOption?.summary || state.pendingTarget?.summary || String(userInput || "").trim();
        if (baseSummary) {
          executionSession.applyDecisionEvent({
            type: "target.defined",
            target: {
              kind: /(创建|新建|新增)/i.test(baseSummary) ? "create" : "edit",
              summary: baseSummary,
              instructions: String(userInput || "").trim(),
              updatedAt: Date.now(),
            },
            triggerType: "user-input",
          });
        }
      }
    };

    primeDecisionStateBeforeCompose();
    const buildCompletionSnapshot = (patch?: Partial<AgentRunSnapshot>): Partial<AgentRunSnapshot> => ({
      status: "completed",
      phase: executionSession.getHasWriteActions() ? executionSession.getCurrentPhase() : "answer",
      stopReason: "流程结束",
      businessStatus: executionSession.getBusinessStatus(),
      businessSummary: executionSession.getBusinessSummary(),
      lastVerificationSummary: executionSession.getLastVerificationSummary(),
      ...patch,
    });
    const emitRunSnapshot = (patch: Partial<AgentRunSnapshot>) => {
      if (!onRunSnapshot) return;
      const snapshot: AgentRunSnapshot = {
        runId,
        status: "running",
        phase: executionSession.getCurrentPhase(),
        completedSteps: completedToolCalls,
        totalSteps: Math.max(completedToolCalls, totalPlannedSteps),
        updatedAt: Date.now(),
        ...patch,
      };
      onRunSnapshot(snapshot);
    };
    const repairLoop = new RepairLoop();
    repairLoop.registerToolDefinitions(tools.map(t => t.definition));

    tools = preparedTools;

    const buildTargetChecklistGuard = (): string => {
      if (searchPlan.intent !== "edit") return "";
      const candidatePaths = searchPlan.candidateFiles.map(file => file.path).filter(Boolean);
      const noteEvidencePaths = evidenceBundle.items
        .filter((item: any) => (item.kind === "file" || item.kind === "rag") && item.path)
        .map((item: any) => String(item.path))
        .filter(Boolean);
      const targetPaths = Array.from(new Set([...candidatePaths, ...noteEvidencePaths])).slice(0, 8);
      if (targetPaths.length === 0) {
        return [
          "【目标清单保护】",
          "- 当前是编辑任务，但尚未稳定锁定任何目标笔记。",
          "- 在没有锁定目标之前，不要输出“已修改/已补充/已完成”。",
          "- 下一步必须先通过读取当前笔记、读取候选笔记结构或解析用户给出的 [[...]] 来形成目标清单。",
        ].join("\n");
      }
      return [
        "【目标清单保护】",
        `- 已锁定候选目标 (${targetPaths.length}): ${targetPaths.join(", ")}`,
        "- 后续编辑必须优先围绕这些目标执行；不要再退回大范围扫库。",
        "- 只有当这些目标都确认不匹配时，才允许扩展搜索范围。",
      ].join("\n");
    };

    const targetChecklistGuard = buildTargetChecklistGuard();
    const routingContextLines: string[] = [];
    routingContextLines.push("【任务路由】");
    routingContextLines.push(`- ${this.services.searchPlanner.getShortStatus(searchPlan)}`);
    if (searchPlan.shouldInspectBeforeWrite) {
      routingContextLines.push("- 写入前先读取目标结构或片段。");
    }
    if (searchPlan.candidateFiles.length > 0) {
      routingContextLines.push(`- 候选文件: ${searchPlan.candidateFiles.slice(0, 3).map(f => f.path).join(", ")}`);
    }
    if (firstActionPlan.firstRoundToolNames.length > 0) {
      routingContextLines.push(`- 首轮工具: ${firstActionPlan.firstRoundToolNames.slice(0, 4).join(" -> ")}`);
    }
    routingContextLines.push(`- 当前工具数: ${toolRouting.allowedToolNames.length}`);
    if (targetChecklistGuard) {
      routingContextLines.push(targetChecklistGuard);
    }
    if (toolRouting.prioritizedToolNames.length > 0) {
      routingContextLines.push(`- 优先工具: ${toolRouting.prioritizedToolNames.slice(0, 5).join(", ")}`);
    }
    routingContextLines.push("- 要求: 先证据，后操作；不足时再扩展工具范围。");
    const routingContext = routingContextLines.join("\n");

    const presetAllowedToolSet = filtered ? new Set(allowedToolNames) : null;
    const isToolAllowedByPreset = (name: string): boolean => {
      if (!presetAllowedToolSet) return true;
      return presetAllowedToolSet.has(String(name || "").trim());
    };

    const emitAgentUpdate = (content: string, options?: { verbose?: boolean }) => {
      if (!onUpdate) return;
      if (options?.verbose && !this.services.settings.showToolLogs) return;
      onUpdate(content);
    };

    // emitAgentUpdate(`我先处理一下。\n`);
    emitRunSnapshot({ phase: "inspect", lastToolSummary: this.services.searchPlanner.getShortStatus(searchPlan) });
    emitRunSnapshot({
      phase: executionSession.getCurrentPhase(),
      totalSteps: Math.max(totalPlannedSteps, firstActionPlan.firstRoundToolNames.length || 0),
      lastToolSummary: `${policy.name}｜${toolRouting.riskSummary}`,
      repairSummary: repairLoop.getSnapshotSummary(),
      lastVerificationSummary: executionSession.getLastVerificationSummary(),
      businessStatus: executionSession.getBusinessStatus(),
      businessSummary: executionSession.getBusinessSummary(),
    });

    const agentInputComposer = new AgentInputComposer();
    const toolBatchExecutor = new ToolBatchExecutor(this.services, {
      policyName: policy.name,
      isToolAllowedByPreset,
      tools,
      executionSession,
      repairLoop,
      signal,
      onRunSnapshot: emitRunSnapshot,
      onAgentUpdate: emitAgentUpdate,
      getCompletedToolCalls: () => completedToolCalls,
      setCompletedToolCalls: (value) => {
        completedToolCalls = value;
      },
      getTotalPlannedSteps: () => totalPlannedSteps,
    });

    const selectedAgentModel = agent.model || effectiveModel;
    const availableToolsPrompt = tools.length > 0 
      ? `【可用工具说明】\n当前你已被分配以下工具用于执行任务：\n${tools.map(t => `- **${t.definition.name}**: ${t.definition.description}`).join("\n")}\n如果任务需要，请务必主动调用这些工具，不要仅靠文字推测。`
      : "";

    const composedRuntimeInput = await agentInputComposer.compose({
      settings: this.services.settings,
      llmService: this.services.llmService,
      contextBudgetManager: this.services.contextBudgetManager,
      replacePromptPlaceholders: this.services.replacePromptPlaceholders,
      searchSubagent: this.services.searchSubagent,
      agentName: agent.name,
      agentSystemPrompt: agent.systemPrompt,
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
      reflectionContext,
      selectedAgentModel,
      signal,
      emitAgentUpdate,
      availableToolsPrompt,
      skillRegistry: this.services.skillRegistry,
    });

    if (searchPlan.shouldInspectBeforeWrite === false && searchPlan.reasoning.some(item => /明确批准执行|act-first/i.test(item))) {
      executionSession.applyDecisionEvent({ type: "proposal.approved", triggerType: "planner" });
      executionSession.applyDecisionEvent({ type: "execution.started", triggerType: "planner" });
      executionSession.forceAct("检测到用户明确批准执行，优先进入 Act 阶段");
    }

    let agentSystemPrompt = composedRuntimeInput.systemPrompt;
    const finalAgentUserInput = composedRuntimeInput.finalUserInput;
    const multiTargetEditMatchCount = (String(userInput || "").match(/\[\[[^\]]+\]\]/g) || []).length;
    const isMultiTargetEditTask = searchPlan.intent === "edit"
      && (multiTargetEditMatchCount >= 2 || /(批量|逐个|依次|多个|多篇|全部|所有|分别|补全|补充)/i.test(String(userInput || "")));
    if (isMultiTargetEditTask) {
      agentSystemPrompt += `\n\n【多目标编辑任务硬约束】\n- 当前任务属于多目标笔记编辑/补全任务，禁止连续多轮只做泛化分析、空泛总结、重复确认或只解释计划。\n- 若用户已通过 [[...]] 给出多个目标，请优先围绕这些目标直接执行；不要先做大范围 list/search 扫库。\n- 允许的最小流程：读取当前笔记/目标笔记 → 形成批量执行顺序 → 立即开始真实写入。\n- 如果一轮回复没有产生任何真实工具调用，下一轮必须立即使用标准的函数调用(Function Calling)机制调用工具，不要继续空谈。\n- 对批量补全任务，优先产出实际修改结果，而不是长篇解释。`;
    }
    const contextBudgetEnabled = composedRuntimeInput.contextBudgetEnabled;
    const contextBudgetTokens = composedRuntimeInput.contextBudgetTokens;
    let slicedHistory = composedRuntimeInput.history;

    // 去除重复的用户消息：如果聊天面板已经把最新的 userInput 追加到了 history，我们要在这里将其 pop 掉，
    // 否则 messages 数组会因为后面追加的 composedRuntimeInput.userMessage 而包含两条相同内容。
    if (slicedHistory.length > 0) {
      const lastMsg = slicedHistory[slicedHistory.length - 1];
      if (lastMsg.role === "user" && String(lastMsg.content).trim() === String(userInput).trim()) {
        slicedHistory = slicedHistory.slice(0, -1);
      }
    }

    if (composedRuntimeInput.diagnostics) {
      emitAgentUpdate(`📦 [ContextBudget] ${this.services.contextBudgetManager.getShortStatus(composedRuntimeInput.diagnostics)}\n`, { verbose: true });
    }

    if (reflectionMgr.isNegativeFeedback(userInput) && slicedHistory.length > 0) {
      this.services.triggerUserFeedbackReflection(userInput, slicedHistory).catch(e => {
        logger.warn("Reflection", "Failed to trigger user feedback reflection", e);
      });
    }

    const messages: ChatMessage[] = [
      { role: "system", content: agentSystemPrompt, cacheAnchor: true },
      ...slicedHistory,
      composedRuntimeInput.userMessage,
    ];

    const firstEstimate = estimateTokensFromMessages(messages);
    if (onMeta) onMeta({ contextTokensEstimate: firstEstimate, mode, model: selectedAgentModel });

    const newMessages: ChatMessage[] = [];

    const pushInternalDecisionLog = (summary: string, trace?: any) => {
      const payload: InternalStepLogPayload = { type: "decision-state", summary, trace };
      newMessages.push({
        role: "assistant",
        content: `<internal-log>${JSON.stringify(payload)}</internal-log>`,
        internalOnly: true,
      });
    };

    pushInternalDecisionLog("本轮执行开始前的决策状态", executionSession.getDecisionState());

    const runToolLoop = async (loopMessages: ChatMessage[], maxLoops: number, streamFinal: boolean) => {
      const stepNewMessages: ChatMessage[] = [];
      let loopCount = 0;
      let consecutiveNoToolResponses = 0;
      while (loopCount < maxLoops) {
        if (repairLoop.shouldAbort()) {
          const forced: ChatMessage = { role: "assistant", content: `⚠️ ${repairLoop.getAbortReason()}，已停止自动修复。请人工查看当前结果或调整策略后重试。` };
          emitRunSnapshot({ status: "failed", phase: executionSession.getCurrentPhase(), stopReason: repairLoop.getAbortReason() });
          loopMessages.push(forced);
          stepNewMessages.push(forced);
          return { final: forced, stepNewMessages, loopMessages, loopsUsed: loopCount };
        }

        if (signal?.aborted) {
          throw new Error("请求已被用户取消");
        }

        const noToolGuardPrompt = consecutiveNoToolResponses >= 1
          ? {
              role: "system" as const,
              content:
                "【执行保护】上一轮没有产生任何工具调用。对于当前任务，下一轮必须优先执行真实工具动作，而不是继续泛化分析、复述计划或空谈。若是编辑任务，请立即读取目标或直接执行最小必要写入。"
            }
          : null;

        const agentModel = agent.model || effectiveModel;
        const phasePrompt: ChatMessage = { role: "system", content: `${executionSession.formatForPrompt()}\n\n${repairLoop.formatForPrompt()}` };
        const openAiTools = toolBatchExecutor.buildOpenAiToolsForCurrentPhase(toolRouting.allowedToolNames, () => repairLoop.getSuggestedTools());

        const loopInputMessages = noToolGuardPrompt
          ? [noToolGuardPrompt, phasePrompt, ...loopMessages]
          : [phasePrompt, ...loopMessages];

        const loopWindow = contextBudgetEnabled
          ? this.services.contextBudgetManager.fitMessages(loopInputMessages, contextBudgetTokens, {
              pinnedHeadCount: 2,
              pinnedTailCount: 10,
              maxSingleMessageTokens: 1400,
              summaryLabel: "agent-loop",
              preserveTailPatterns: [/最近验证结果/i, /RepairLoop/i, /\[Verify\]/i, /修复/i],
            })
          : {
              messages: loopInputMessages,
              diagnostics: {
                budgetTokens: contextBudgetTokens,
                usedTokens: estimateTokensFromMessages(loopInputMessages),
                omittedLoopMessages: 0,
                trimmedBlocks: [],
              },
            };

        const finalMessagesForCompletion = [...loopWindow.messages];
        if (!openAiTools || openAiTools.length === 0) {
            finalMessagesForCompletion.push({
                role: "user",
                content: "【系统保护/System Override】你当前无需使用任何插件内置工具。\n1. 请直接以你原本的身份进行自然回复，**绝对不要**在对话中向用户声明“我当前没有工具可用”、“我只能用文字交流”或提及任何后台系统限制，以免打破角色的沉浸感。\n2. **绝对禁止**输出假装调用工具的 JSON 代码块（如 replace_in_note 等），系统不会解析。\n3. 严禁在文字中声称“我已为你创建笔记”、“我已经修改了文件”等虚假操作。如果用户要求写笔记，请直接提供普通的 Markdown 内容并提示用户自行复制粘贴。"
            });
        }

        if (onMeta) onMeta({ contextTokensEstimate: loopWindow.diagnostics.usedTokens, mode, model: agentModel });

        const response = await this.services.llmService.getCompletion(finalMessagesForCompletion, agentModel, openAiTools, (token) => {
          if (!streamFinal) return;
          if (onUpdate) onUpdate(token);
        }, signal);

        if (Array.isArray((response as any)?.tool_calls) && (response as any).tool_calls.length > 0) {
          (response as any).tool_calls.forEach((tc: any, idx: number) => {
            if (!tc) return;
            if (!tc.id || String(tc.id).trim().length === 0) {
              tc.id = `call_${loopCount}_${idx}_${Date.now()}`;
            }
          });
        }

        loopMessages.push(response);
        stepNewMessages.push(response);

        if (response.tool_calls && response.tool_calls.length > 0) {
          consecutiveNoToolResponses = 0;
          emitRunSnapshot({
            phase: executionSession.getCurrentPhase(),
            totalSteps: Math.max(totalPlannedSteps, completedToolCalls + response.tool_calls.length),
            lastToolSummary: `正在处理 ${response.tool_calls.length} 个动作`,
          });
          executionSession.applyDecisionEvent({ type: "execution.started", triggerType: "system" });
          await toolBatchExecutor.executeToolCalls(response.tool_calls, loopCount, loopMessages, stepNewMessages);
          loopCount++;
          continue;
        }

        consecutiveNoToolResponses++;

        const hasDoneTools = completedToolCalls > 0 || loopCount > 0;
        const isEditingTask = searchPlan.intent === "edit";

        if (consecutiveNoToolResponses === 1 && executionSession.getCurrentPhase() !== "answer") {
          // If we haven't done any tools yet and it's an editing task, force retry once
          const userAskedToEdit = /(修改|改写|润色|更新|追加|插入|重写|替换|删除|重命名|移动|覆盖|写回|创建|新建|新增|补全|补充|完善|扩写)/i.test(String(userInput || ""));
          if (!hasDoneTools && isEditingTask && userAskedToEdit) {
            loopCount++;
            continue;
          }
          // Otherwise, assume the agent is providing a legitimate final conversational response
          return { final: response, stepNewMessages, loopMessages, loopsUsed: loopCount + 1 };
        }

        if (consecutiveNoToolResponses >= 2 && executionSession.getCurrentPhase() !== "answer") {
          // Instead of failing entirely, just accept what the model said as the final response.
          // This avoids the confusing "⚠️ 智能体连续两轮未产生任何工具动作" when the model is just trying to chat.
          return { final: response, stepNewMessages, loopMessages, loopsUsed: loopCount + 1 };
        }

        return { final: response, stepNewMessages, loopMessages, loopsUsed: loopCount + 1 };
      }

      logger.warn("AI", "步骤执行达到循环上限，强制停止", { loopCount, maxLoops });
      const forced: ChatMessage = { role: "assistant", content: `⚠️ 任务执行步骤过多（已执行 ${loopCount} 次循环），已强制停止。可在设置中调整"智能体最大步数"。` };
      emitRunSnapshot({ status: "failed", phase: executionSession.getCurrentPhase(), stopReason: "超过最大执行步数" });
      loopMessages.push(forced);
      stepNewMessages.push(forced);
      return { final: forced, stepNewMessages, loopMessages, loopsUsed: maxLoops };
    };

    const runAutoSelfTestIfNeeded = async (): Promise<string> => {
      if (Platform.isMobile) return "";
      if (!this.services.settings.enableSkills) return "";
      if (!this.services.settings.enableAutoSelfTestAfterWrite) return "";
      if (!executionSession.getHasWriteActions()) return "";
      if (!this.services.executeSkill) return "";
      if ((this.services.settings.disabledBuiltinSkills || []).includes("builtin-self-test")) return "";

      emitAgentUpdate("\n🧪 检测到本轮有写入，开始追加自动自测...\n");
      const executionDoc = String(this.services.settings.autoSelfTestExecutionDoc || "").trim();
      const updateChunks: string[] = [];

      try {
        const result = await this.services.executeSkill(
          "builtin-self-test",
          executionDoc,
          (message) => {
            updateChunks.push(message);
            emitAgentUpdate(`${message}\n`, { verbose: true });
          },
          signal,
        );
        return formatAutoSelfTestSection(result, updateChunks);
      } catch (error: any) {
        const message = error?.message || String(error) || "未知错误";
        return [
          "## 自动自测",
          `- 结果: 失败 (${message})`,
          "- 说明: 主实现结果已保留，可稍后手动执行 /self-test。",
        ].join("\n");
      }
    };

    const formatAutoSelfTestSection = (result: SkillExecutionResult, updates: string[]): string => {
      const detail = updates.join("\n").trim();
      const body = result.success
        ? result.output
        : `自测失败：${result.error || "未知错误"}\n\n${result.output || ""}`.trim();
      return ["## 自动自测", detail, body].filter(Boolean).join("\n\n");
    };

    const appendAutoSelfTest = async (content: string): Promise<string> => {
      const section = await runAutoSelfTestIfNeeded();
      return section ? `${content}\n\n${section}` : content;
    };

    const applyBusinessResultGuard = (content: string): string => {
      const raw = String(content || "").trim();
      if (!raw) return raw;
      const businessStatus = executionSession.getBusinessStatus();
      if (businessStatus === "verified-write" || businessStatus === "no-write") {
        return raw;
      }
      if (businessStatus === "failed-write") {
        return [
          "本轮流程已经结束，但写入验证失败，不能视为已完成。",
          `当前结果：${executionSession.getBusinessSummary()}`,
          "请根据工具返回与验证结果继续修复后再重试。",
          "",
          raw,
        ].join("\n");
      }
      if (businessStatus === "unverified-write") {
        return [
          "本轮流程已经结束，但写入结果仍未确认，不能视为已创建、已修改或已完成。",
          `当前结果：${executionSession.getBusinessSummary()}`,
          "如果需要，我应继续先核实真实写入结果，再给出完成结论。",
          "",
          raw,
        ].join("\n");
      }
      return raw;
    };

    const summarizeUserFacingResult = (factSummary: string, fallback: string): string => {
      const text = String(factSummary || fallback || "").trim();
      if (!text) return fallback;
      const verifiedFiles = Array.from(new Set(
        Array.from(text.matchAll(/已确认目标内容写入：([^\n]+?\.md)/g)).map(m => String(m[1] || "").trim()).filter(Boolean)
      ));
      if (verifiedFiles.length > 0) {
        const cleanedNames = verifiedFiles.map(name => name.replace(/\.md$/i, ""));
        return [
          `已完成 ${cleanedNames.length} 个目标笔记的内容补全：${cleanedNames.join("、")}。`,
          "我已根据源笔记提供的上下文补充了这些笔记的主要内容。",
        ].join("\n");
      }
      
      // Clear out any step-summary blocks that might have leaked into fallback text
      let cleanedFallback = String(fallback || text || "");
      cleanedFallback = cleanedFallback.replace(/<step-summary>[\s\S]*?<\/step-summary>/g, "").trim();
      return cleanedFallback || text;
    };

    const maxLoops = this.services.settings.agentMaxSteps || 10;
    const { final, stepNewMessages } = await runToolLoop(messages, maxLoops, true);
    const directIntermediateMessages = stepNewMessages.slice(0, -1);
    newMessages.push(...directIntermediateMessages);

    if (String(final?.content || "").includes("已停止自动修复") || String(final?.content || "").includes("强制停止")) {
      executionSession.applyDecisionEvent({ type: "execution.failed", triggerType: "system" });
      emitRunSnapshot({ status: "failed", phase: executionSession.getCurrentPhase(), stopReason: "超过最大执行步数" });
      const finalContent = await appendAutoSelfTest(final?.content || "⚠️ 任务执行步骤过多，已强制停止。");
      return {
        content: finalContent,
        references: [],
        intermediateMessages: newMessages,
        decisionState: executionSession.getDecisionState(),
        meta: { contextTokensEstimate: estimateTokensFromMessages(messages) },
      };
    }

    const guardedFinalContent = applyBusinessResultGuard(final?.content || "（无内容）");
    const finalContent = await appendAutoSelfTest(guardedFinalContent);
    executionSession.applyDecisionEvent({ type: "execution.completed", triggerType: "system" });
    emitRunSnapshot(buildCompletionSnapshot({ phase: "answer" }));
    return {
      content: finalContent,
      references: [],
      intermediateMessages: newMessages,
      decisionState: executionSession.getDecisionState(),
      meta: { contextTokensEstimate: estimateTokensFromMessages(messages) },
    };
  }
}
