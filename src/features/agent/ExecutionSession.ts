import type {
  ConversationDecisionState,
  DecisionApprovalStatus,
  DecisionProposal,
  DecisionSelection,
  PendingDecisionTarget,
  DecisionTriggerType,
} from "../../core/types";
import type { VerificationResult } from "./ExecutionVerifier";

export type ExecutionPhase = "inspect" | "act" | "repair" | "answer";

export interface ExecutedToolRecord {
  toolName: string;
  isWrite: boolean;
  verification?: VerificationResult | null;
}

export interface ExecutionSessionOptions {
  shouldInspectBeforeWrite: boolean;
  userGoal: string;
}

export type DecisionEvent =
  | { type: "proposal.created"; proposal: DecisionProposal; triggerType?: DecisionTriggerType }
  | { type: "proposal.selected"; selection: DecisionSelection; triggerType?: DecisionTriggerType }
  | { type: "proposal.approved"; approvalStatus?: DecisionApprovalStatus; triggerType?: DecisionTriggerType }
  | { type: "target.defined"; target: PendingDecisionTarget; triggerType?: DecisionTriggerType }
  | { type: "execution.started"; triggerType?: DecisionTriggerType }
  | { type: "execution.completed"; triggerType?: DecisionTriggerType }
  | { type: "execution.failed"; triggerType?: DecisionTriggerType }
  | { type: "decision.cancelled"; triggerType?: DecisionTriggerType };

export class ExecutionSession {
  private phase: ExecutionPhase;
  private lastTransition = "初始化";
  private lastVerificationSummary = "";
  private lastToolName = "";
  private lastToolSummary = "";
  private lastStopReason = "";
  private inspectRounds = 0;
  private hasWriteActions = false;
  private hasVerifiedWriteSuccess = false;
  private hasFailedWriteVerification = false;
  private decisionState: ConversationDecisionState = {};
  private static readonly MIN_INSPECT_ROUNDS = 1;

  constructor(private options: ExecutionSessionOptions) {
    this.phase = options.shouldInspectBeforeWrite ? "inspect" : "act";
    this.lastTransition = options.shouldInspectBeforeWrite
      ? "因任务包含写入风险，先进入 Inspect 阶段"
      : "无需预读，直接进入 Act 阶段";
  }

  public forceAct(reason = "检测到用户已明确批准执行，直接进入 Act 阶段") {
    this.phase = "act";
    this.lastTransition = reason;
    this.lastStopReason = "";
    if (this.decisionState.approvalStatus === "approved" || this.decisionState.approvalStatus === "selected") {
      this.decisionState.approvalStatus = "executing";
      this.touchDecisionState("system");
    }
  }

  public hydrateDecisionState(state?: ConversationDecisionState | null) {
    this.decisionState = state ? JSON.parse(JSON.stringify(state)) : {};
  }

  public applyDecisionEvent(event: DecisionEvent) {
    if (!event) return;
    switch (event.type) {
      case "proposal.created":
        this.decisionState.currentProposal = event.proposal;
        this.decisionState.selection = undefined;
        this.decisionState.approvalStatus = "proposed";
        this.decisionState.pendingTarget = undefined;
        break;
      case "proposal.selected":
        this.decisionState.selection = event.selection;
        this.decisionState.approvalStatus = "selected";
        break;
      case "proposal.approved":
        this.decisionState.approvalStatus = event.approvalStatus || "approved";
        break;
      case "target.defined":
        this.decisionState.pendingTarget = event.target;
        break;
      case "execution.started":
        this.decisionState.approvalStatus = "executing";
        break;
      case "execution.completed":
        this.decisionState.approvalStatus = "completed";
        break;
      case "execution.failed":
        this.decisionState.approvalStatus = "failed";
        break;
      case "decision.cancelled":
        this.decisionState.approvalStatus = "cancelled";
        this.decisionState.pendingTarget = undefined;
        break;
    }
    this.touchDecisionState(event.triggerType);
  }

  public getDecisionState(): ConversationDecisionState {
    return JSON.parse(JSON.stringify(this.decisionState || {}));
  }

  public formatDecisionStateForPrompt(): string {
    const state = this.decisionState || {};
    const lines: string[] = ["【当前会话决策状态】"];
    if (state.currentProposal) {
      lines.push(`- 当前提案: ${state.currentProposal.title || state.currentProposal.summary}`);
      const optionLines = (state.currentProposal.options || []).map(option => {
        const selected = state.selection?.optionId === option.id ? "（已选）" : "";
        return `  - ${option.id}: ${option.label || option.summary}${selected}｜${option.summary}`;
      });
      lines.push(...optionLines);
    } else {
      lines.push("- 当前提案: 无");
    }
    if (state.selection) {
      lines.push(`- 用户已选: ${state.selection.optionId}`);
    }
    if (state.approvalStatus) {
      lines.push(`- 审批状态: ${state.approvalStatus}`);
    }
    if (state.pendingTarget) {
      lines.push(`- 当前待执行目标: ${state.pendingTarget.summary}`);
      if (state.pendingTarget.notePath) lines.push(`- 目标笔记: ${state.pendingTarget.notePath}`);
      if (state.pendingTarget.sectionLabel) lines.push(`- 目标区域: ${state.pendingTarget.sectionLabel}`);
      if (state.pendingTarget.instructions) lines.push(`- 执行要求: ${state.pendingTarget.instructions}`);
    }
    if (state.triggerType) {
      lines.push(`- 最近触发来源: ${state.triggerType}`);
    }
    return lines.join("\n");
  }

  public getDecisionSummary(): string {
    const state = this.decisionState || {};
    const parts: string[] = [];
    if (state.currentProposal) parts.push(`提案=${state.currentProposal.title || state.currentProposal.summary}`);
    if (state.selection?.optionId) parts.push(`已选=${state.selection.optionId}`);
    if (state.approvalStatus) parts.push(`状态=${state.approvalStatus}`);
    if (state.pendingTarget?.summary) parts.push(`目标=${state.pendingTarget.summary}`);
    return parts.join("；") || "无稳定决策态";
  }

  public hasActiveDecisionState(): boolean {
    const state = this.decisionState || {};
    return Boolean(state.currentProposal || state.selection || state.pendingTarget || state.approvalStatus);
  }

  public getCurrentPhase(): ExecutionPhase {
    return this.phase;
  }

  public advanceAfterBatch(records: ExecutedToolRecord[]) {
    if (!records || records.length === 0) return;

    const lastRecord = records[records.length - 1];
    this.lastToolName = lastRecord?.toolName || this.lastToolName;
    this.lastToolSummary = lastRecord?.verification?.summary || (lastRecord?.isWrite ? "写入已执行，等待结果判断" : "工具批次已执行");

    const hasWrite = records.some(r => r.isWrite);
    if (hasWrite) {
      this.hasWriteActions = true;
    }
    const failedVerification = records.find(r => r.verification && r.verification.ok === false);
    const passedVerification = records.find(r => r.verification && r.verification.ok === true);

    if (failedVerification) {
      this.hasFailedWriteVerification = true;
    }
    if (passedVerification) {
      this.hasVerifiedWriteSuccess = true;
      this.hasFailedWriteVerification = false;
    }

    if (failedVerification) {
      this.phase = "repair";
      this.lastVerificationSummary = failedVerification.verification?.summary || "验证失败";
      this.lastToolName = failedVerification.toolName;
      this.lastToolSummary = failedVerification.verification?.summary || "验证失败";
      this.lastTransition = `检测到 ${failedVerification.toolName} 写后验证失败，切换到 Repair 阶段`;
      this.lastStopReason = this.lastVerificationSummary;
      return;
    }

    if (this.phase === "inspect" && !hasWrite) {
      this.inspectRounds++;
      if (this.inspectRounds >= ExecutionSession.MIN_INSPECT_ROUNDS) {
        this.phase = "act";
        this.lastTransition = `已完成 ${this.inspectRounds} 轮现场检查，切换到 Act 阶段`;
      } else {
        this.lastTransition = `Inspect 第 ${this.inspectRounds} 轮完成，继续检查`;
      }
      return;
    }

    if (this.phase === "repair" && passedVerification) {
      this.phase = "act";
      this.lastVerificationSummary = passedVerification.verification?.summary || "验证通过";
      this.lastToolName = passedVerification.toolName;
      this.lastToolSummary = passedVerification.verification?.summary || "验证通过";
      this.lastTransition = `修复后的 ${passedVerification.toolName} 已通过验证，回到 Act 阶段`;
      this.lastStopReason = "";
      return;
    }

    if (hasWrite && passedVerification) {
      this.lastVerificationSummary = passedVerification.verification?.summary || "验证通过";
      this.lastToolName = passedVerification.toolName;
      this.lastToolSummary = passedVerification.verification?.summary || "验证通过";
      this.lastTransition = `写入工具 ${passedVerification.toolName} 已通过验证`;
      this.lastStopReason = "";
    }
  }

  public formatForPrompt(): string {
    const lines: string[] = [];
    lines.push("【执行阶段与闭环规则】");
    lines.push(`- 当前阶段: ${this.phaseLabel(this.phase)}`);
    lines.push(`- 最近状态变化: ${this.lastTransition}`);
    if (this.lastVerificationSummary) {
      lines.push(`- 最近验证结果: ${this.lastVerificationSummary}`);
    }
    if (this.hasActiveDecisionState()) {
      lines.push("");
      lines.push(this.formatDecisionStateForPrompt());
    }

    switch (this.phase) {
      case "inspect":
        lines.push(`- 规则: 当前仅允许现场检查/结构读取/证据收集，不要直接写入。完成充分检查后再进入执行。`);
        break;
      case "act":
        lines.push(`- 规则: 可以执行主要动作。写入后阅读工具输出中的 [Verify] 段，失败则修复，通过则报告结果。`);
        break;
      case "repair":
        lines.push(`- 规则: 上一轮写入验证失败。优先读取现场、定位问题、执行最小修复，再次触发写入与验证。`);
        break;
      case "answer":
        lines.push(`- 规则: 停止工具调用，直接向用户总结结果。`);
        break;
    }
    lines.push("- 闭环: 写入类工具默认 Plan→Act→Verify→Repair。[Verify] 失败时不要直接结束。");

    return lines.join("\n");
  }

  public getShortStatus(): string {
    return `${this.phaseLabel(this.phase)}｜${this.lastTransition}`;
  }

  public getBudgetSummary(): string {
    const parts = [
      `阶段=${this.phaseLabel(this.phase)}`,
      `变化=${this.lastTransition}`,
    ];
    if (this.lastVerificationSummary) parts.push(`验证=${this.lastVerificationSummary}`);
    if (this.lastToolName) parts.push(`工具=${this.lastToolName}`);
    if (this.lastToolSummary) parts.push(`摘要=${this.lastToolSummary}`);
    return parts.join("；");
  }

  public getLastVerificationSummary(): string {
    return this.lastVerificationSummary;
  }

  public getLastToolName(): string {
    return this.lastToolName;
  }

  public getLastToolSummary(): string {
    return this.lastToolSummary;
  }

  public getLastStopReason(): string {
    return this.lastStopReason;
  }

  public getHasWriteActions(): boolean {
    return this.hasWriteActions;
  }

  public getHasVerifiedWriteSuccess(): boolean {
    return this.hasVerifiedWriteSuccess;
  }

  public getHasFailedWriteVerification(): boolean {
    return this.hasFailedWriteVerification;
  }

  public getBusinessStatus(): "unknown" | "no-write" | "verified-write" | "unverified-write" | "failed-write" {
    if (!this.hasWriteActions) return "no-write";
    if (this.hasFailedWriteVerification) return "failed-write";
    if (this.hasVerifiedWriteSuccess) return "verified-write";
    return "unverified-write";
  }

  public getBusinessSummary(): string {
    switch (this.getBusinessStatus()) {
      case "no-write":
        return "本轮未发生写入操作";
      case "verified-write":
        return this.lastVerificationSummary || "写入已验证通过";
      case "failed-write":
        return this.lastVerificationSummary || "写入验证失败";
      case "unverified-write":
        return "发生了写入尝试，但没有可确认的成功验证";
      default:
        return "业务结果待确认";
    }
  }

  private touchDecisionState(triggerType?: DecisionTriggerType) {
    this.decisionState.lastUpdatedAt = Date.now();
    if (triggerType) {
      this.decisionState.triggerType = triggerType;
    }
  }

  private phaseLabel(phase: ExecutionPhase): string {
    switch (phase) {
      case "inspect": return "Inspect";
      case "act": return "Act";
      case "repair": return "Repair";
      case "answer": return "Answer";
      default: return phase;
    }
  }
}
