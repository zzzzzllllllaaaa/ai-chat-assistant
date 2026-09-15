import type { VerificationResult } from "./ExecutionVerifier";
import type { ExecutedToolRecord } from "./ExecutionSession";
import type { ToolDefinition } from "./types";

export interface RepairIssue {
  toolName: string;
  summary: string;
  details: string[];
  attempts: number;
  nextSuggestedTools?: string[];
}

/** 硬编码的默认修复工具映射（工具未声明 repairHint 时回退使用） */
const DEFAULT_REPAIR_HINTS: Record<string, string[]> = {
  replace_in_note: ["get_note_structure", "read_note"],
  modify_note: ["get_note_structure", "read_note"],
  append_to_note: ["get_note_structure", "read_note"],
  prepend_to_note: ["get_note_structure", "read_note"],
  update_properties: ["get_properties", "read_note"],
  modify_canvas: ["read_canvas"],
  create_canvas: ["read_canvas"],
  create_canvas_mindmap: ["read_canvas"],
  move_item: ["list_files", "read_note"],
  delete_file: ["list_files", "read_note"],
  create_folder: ["list_files", "read_note"],
  create_note: ["list_files", "read_note"],
};

export class RepairLoop {
  private issues: RepairIssue[] = [];
  private totalRepairs = 0;
  private lastTransition = "尚未进入修复循环";
  private toolDefs = new Map<string, ToolDefinition>();

  constructor(private maxAttemptsPerIssue = 2, private maxTotalRepairs = 4) {}

  /** 注册工具定义，用于读取 repairHint */
  public registerToolDefinitions(defs: ToolDefinition[]): void {
    this.toolDefs.clear();
    for (const d of defs) this.toolDefs.set(d.name, d);
  }

  public registerBatch(records: ExecutedToolRecord[]) {
    if (!records || records.length === 0) return;

    for (const record of records) {
      const verification = record.verification;
      if (!record.isWrite || !verification) continue;

      if (verification.ok) {
        this.resolveIssue(record.toolName, verification);
        continue;
      }

      const existing = this.issues.find(issue => issue.toolName === record.toolName);
      if (existing) {
        existing.attempts += 1;
        existing.summary = verification.summary;
        existing.details = verification.details || [];
        existing.nextSuggestedTools = this.getRepairHints(record.toolName);
      } else {
        this.issues.push({
          toolName: record.toolName,
          summary: verification.summary,
          details: verification.details || [],
          attempts: 1,
          nextSuggestedTools: this.getRepairHints(record.toolName),
        });
      }
      this.totalRepairs += 1;
      this.lastTransition = `记录到 ${record.toolName} 的验证失败，进入修复跟踪`;
    }
  }

  public hasPendingIssues(): boolean {
    return this.issues.length > 0;
  }

  public shouldAbort(): boolean {
    return this.totalRepairs >= this.maxTotalRepairs || this.issues.some(issue => issue.attempts > this.maxAttemptsPerIssue);
  }

  public getAbortReason(): string {
    if (this.totalRepairs >= this.maxTotalRepairs) {
      return `修复循环总次数已达上限（${this.maxTotalRepairs}）`;
    }
    const issue = this.issues.find(i => i.attempts > this.maxAttemptsPerIssue);
    if (issue) {
      return `工具 ${issue.toolName} 的修复尝试已超过上限（${this.maxAttemptsPerIssue}）`;
    }
    return "修复循环已停止";
  }

  public formatForPrompt(): string {
    const lines: string[] = [];
    lines.push("【RepairLoop】");
    lines.push(`- 状态: ${this.hasPendingIssues() ? "存在待修复问题" : "无待修复问题"}`);
    lines.push(`- 最近变化: ${this.lastTransition}`);
    lines.push(`- 累计修复次数: ${this.totalRepairs}/${this.maxTotalRepairs}`);
    if (this.issues.length === 0) {
      lines.push("- 当前没有待修复项，可按正常流程推进。");
      return lines.join("\n");
    }

    lines.push("- 待修复项:");
    for (const issue of this.issues.slice(0, 3)) {
      lines.push(`  - ${issue.toolName}: ${issue.summary}（尝试 ${issue.attempts}/${this.maxAttemptsPerIssue}）`);
      for (const detail of issue.details.slice(0, 2)) {
        lines.push(`    - ${detail}`);
      }
      if (issue.nextSuggestedTools && issue.nextSuggestedTools.length > 0) {
        lines.push(`    - 建议下一步: 先用 ${issue.nextSuggestedTools.join(", ")} 复核现场，再做最小修复`);
      }
    }
    lines.push("- 修复要求: 先读取现场确认问题，再执行最小修复；同一种失败不要盲目重复同一写操作。");
    return lines.join("\n");
  }

  public getSuggestedTools(): string[] {
    if (this.issues.length === 0) return [];
    const names = new Set<string>();
    for (const issue of this.issues) {
      // 优先从工具定义的 repairHint 读取
      const def = this.toolDefs.get(issue.toolName);
      if (def?.repairHint && def.repairHint.length > 0) {
        for (const hint of def.repairHint) names.add(hint);
        continue;
      }
      // 回退到硬编码映射
      const fallback = DEFAULT_REPAIR_HINTS[issue.toolName];
      if (fallback) {
        for (const h of fallback) names.add(h);
      }
    }
    return Array.from(names);
  }

  public getShortStatus(): string {
    if (this.issues.length === 0) return `待修复=0；累计=${this.totalRepairs}`;
    const issue = this.issues[0];
    return `待修复=${this.issues.length}；首项=${issue.toolName}(${issue.attempts})｜${issue.summary}`;
  }

  public getBudgetSummary(): string {
    if (this.issues.length === 0) {
      return `repair=idle；最近变化=${this.lastTransition}；累计=${this.totalRepairs}/${this.maxTotalRepairs}`;
    }
    const issue = this.issues[0];
    const detail = issue.details[0] || issue.summary;
    const suggested = issue.nextSuggestedTools && issue.nextSuggestedTools.length > 0
      ? `；建议=${issue.nextSuggestedTools.join(",")}`
      : "";
    return `repair=active；工具=${issue.toolName}；失败=${issue.summary}；细节=${detail}；尝试=${issue.attempts}/${this.maxAttemptsPerIssue}${suggested}`;
  }

  public getSnapshotSummary(): string {
    if (this.issues.length === 0) return "无待修复项";
    const issue = this.issues[0];
    const detail = issue.details[0] || issue.summary;
    const next = issue.nextSuggestedTools && issue.nextSuggestedTools.length > 0
      ? `；建议下一步=${issue.nextSuggestedTools.join(", ")}`
      : "";
    return `${issue.toolName}｜${issue.summary}｜${detail}${next}`;
  }

  private getRepairHints(toolName: string): string[] {
    const def = this.toolDefs.get(toolName);
    if (def?.repairHint && def.repairHint.length > 0) {
      return [...def.repairHint];
    }
    return [...(DEFAULT_REPAIR_HINTS[toolName] || [])];
  }

  private resolveIssue(toolName: string, verification: VerificationResult) {
    const before = this.issues.length;
    this.issues = this.issues.filter(issue => issue.toolName !== toolName);
    if (this.issues.length < before) {
      this.lastTransition = `${toolName} 修复后已通过验证：${verification.summary}`;
    }
  }
}
