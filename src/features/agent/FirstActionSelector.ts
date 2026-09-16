import type { EvidenceBundle, LearnedToolSignal } from "./SearchEvidenceBuilder";
import type { SearchPlannerResult } from "./SearchPlanner";

export interface RankedToolChoice {
  toolName: string;
  score: number;
  confidence: "low" | "medium" | "high";
  reasons: string[];
}

export interface FirstActionSelection {
  firstRoundToolNames: string[];
  deferredToolNames: string[];
  reasoning: string[];
  rankedToolChoices: RankedToolChoice[];
}

export interface FirstActionInput {
  planner: SearchPlannerResult;
  evidence: EvidenceBundle;
  availableToolNames: string[];
}

export class FirstActionSelector {
  public select(input: FirstActionInput): FirstActionSelection {
    const available = new Set(input.availableToolNames || []);
    const reasoning: string[] = [];
    const firstRound: string[] = [];
    const learnedSignals = (input.evidence.learnedToolSignals || []).filter(signal => available.has(signal.toolName));

    const push = (name: string) => {
      if (!available.has(name)) return;
      if (!firstRound.includes(name)) firstRound.push(name);
    };

    const pushFromSignal = (signal: LearnedToolSignal) => {
      push(signal.toolName);
    };

    for (const signal of learnedSignals.slice(0, 5)) {
      pushFromSignal(signal);
    }

    if (learnedSignals.length > 0) {
      const summary = learnedSignals.slice(0, 3).map(signal => `${signal.toolName}(${signal.score})`).join(" -> ");
      reasoning.push(`搜索子代理已学到本轮工具先验：${summary}`);
    }

    for (const toolName of input.evidence.suggestedActions || []) {
      push(toolName);
    }

    const hasFileEvidence = input.evidence.items.some(item => item.kind === "file" || item.kind === "rag");
    const hasCodeEvidence = input.evidence.items.some(item => item.kind === "code");

    if (hasFileEvidence) {
      reasoning.push("已有笔记/RAG 证据，首轮应优先读取目标笔记而非重新盲搜。");
      push("read_note");
      push("get_note_structure");
    }

    if (hasCodeEvidence) {
      reasoning.push("已有代码符号证据，首轮应优先读局部实现和查引用。");
      push("read_code_region");
      push("find_references");
      push("find_symbol");
    }

    if (input.evidence.items.length === 0) {
      reasoning.push("证据不足，首轮应保留核心检索工具继续搜证。");
      push("knowledge_base_query");
      push("search_notes");
      push("list_files");
    }

    if (input.planner.intent === "edit") {
      reasoning.push("编辑任务默认先读结构，再精准修改。");
      push("get_note_structure");
      push("read_note");
      push("replace_in_note");
    }

    if (input.planner.intent === "code") {
      push("find_symbol");
      push("read_code_region");
      push("find_references");
    }

    if (input.planner.intent === "web") {
      push("mcp_list_tools");
      push("mcp_call_tool");
    }

    if (input.planner.intent === "command") {
      push("list_commands");
    }

    for (const toolName of input.planner.recommendedTools) {
      push(toolName);
    }

    const deferredToolNames = input.availableToolNames.filter(name => !firstRound.includes(name));
    const rankedToolChoices: RankedToolChoice[] = learnedSignals.slice(0, 8).map(signal => ({
      toolName: signal.toolName,
      score: signal.score,
      confidence: signal.confidence,
      reasons: signal.reasons,
    }));

    return {
      firstRoundToolNames: firstRound.slice(0, 6),
      deferredToolNames,
      reasoning,
      rankedToolChoices,
    };
  }

  public formatForPrompt(result: FirstActionSelection): string {
    const lines: string[] = [];
    lines.push("【FirstActionSelector 首轮执行建议】");
    lines.push(`- 首轮优先工具: ${result.firstRoundToolNames.join(" -> ") || "无"}`);
    if (result.reasoning.length > 0) {
      lines.push(`- 判断依据: ${result.reasoning.join("；")}`);
    }
    if (result.rankedToolChoices.length > 0) {
      lines.push("- 学习到的排序线索:");
      for (const choice of result.rankedToolChoices.slice(0, 4)) {
        lines.push(`  - ${choice.toolName}（score=${choice.score} / ${choice.confidence}）: ${choice.reasons.slice(0, 2).join("；")}`);
      }
    }
    if (result.deferredToolNames.length > 0) {
      lines.push(`- 可延后工具: ${result.deferredToolNames.slice(0, 8).join(", ")}`);
    }
    lines.push("- 要求: 第一轮尽量先用首轮优先工具确认现场；只有这些工具不足时，再扩展到延后工具。");
    return lines.join("\n");
  }

  public getShortStatus(result: FirstActionSelection): string {
    const learned = result.rankedToolChoices[0]?.toolName;
    return `首轮=${result.firstRoundToolNames.slice(0, 4).join(", ") || "无"}${learned ? `；学习=${learned}` : ""}`;
  }
}