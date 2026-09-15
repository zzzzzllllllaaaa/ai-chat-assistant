import { App, TFile } from "obsidian";
import type { SearchPlannerResult } from "./SearchPlanner";

export type EvidenceKind = "file" | "rag" | "code";

export interface LearnedToolSignal {
  toolName: string;
  score: number;
  confidence: "low" | "medium" | "high";
  evidenceKinds: EvidenceKind[];
  reasons: string[];
}

export interface EvidenceItem {
  kind: EvidenceKind;
  title: string;
  path?: string;
  snippet: string;
  score: number;
  reason: string;
}

export interface EvidenceBundle {
  summary: string[];
  items: EvidenceItem[];
  suggestedActions: string[];
  learnedToolSignals?: LearnedToolSignal[];
}

export interface SearchEvidenceInput {
  userInput: string;
  context?: string;
  planner: SearchPlannerResult;
}

export class SearchEvidenceBuilder {
  constructor(private app: App, private plugin: any) {}

  public async build(input: SearchEvidenceInput): Promise<EvidenceBundle> {
    const bundle: EvidenceBundle = {
      summary: [],
      items: [],
      suggestedActions: [],
    };

    const queryText = `${String(input.userInput || "").trim()}\n${String(input.context || "").trim()}`.trim();

    await this.collectCandidateFileEvidence(queryText, input.planner, bundle);

    if ((input.planner.intent === "retrieve" || input.planner.intent === "edit") && this.plugin?.ragService?.isReady?.()) {
      await this.collectRagEvidence(String(input.userInput || "").trim(), bundle);
    }

    if (input.planner.intent === "code") {
      await this.collectCodeEvidence(queryText, bundle);
    }

    if (bundle.items.length === 0) {
      bundle.summary.push("暂未收敛到高置信证据，应先使用读/搜工具进一步确认现场。");
    }

    this.finalizeActions(bundle, input.planner);
    return bundle;
  }

  public formatForPrompt(bundle: EvidenceBundle): string {
    const lines: string[] = [];
    lines.push("【EvidenceBundle 证据包】");
    if (bundle.summary.length > 0) {
      lines.push(`- 摘要: ${bundle.summary.join("；")}`);
    }
    if (bundle.items.length > 0) {
      lines.push("- 候选证据:");
      for (const item of bundle.items.slice(0, 6)) {
        const prefix = item.path ? `${item.title} @ ${item.path}` : item.title;
        lines.push(`  - [${item.kind}] ${prefix}`);
        lines.push(`    原因: ${item.reason}`);
        lines.push(`    片段: ${item.snippet}`);
      }
    }
    // 只有在非纯聊天模式且有允许工具时，才显示建议的下一步
    if (bundle.suggestedActions.length > 0) {
      lines.push(`- 建议下一步工具: ${bundle.suggestedActions.join(" -> ")}`);
    }
    if ((bundle.learnedToolSignals || []).length > 0) {
      lines.push("- 学到的工具先验:");
      for (const signal of (bundle.learnedToolSignals || []).slice(0, 5)) {
        lines.push(`  - ${signal.toolName}（score=${signal.score} / ${signal.confidence}）`);
        lines.push(`    证据类型: ${signal.evidenceKinds.join(", ") || "unknown"}`);
        lines.push(`    原因: ${signal.reasons.slice(0, 2).join("；")}`);
      }
    }
    lines.push("- 要求: 优先利用以上证据决定首轮工具，不要忽略已找到的高置信文件/片段。若证据仍不足，再扩展搜索。");
    return lines.join("\n");
  }

  public getShortStatus(bundle: EvidenceBundle): string {
    const topKinds = bundle.items.slice(0, 3).map(item => `${item.kind}:${item.title}`).join(", ");
    const topSignal = (bundle.learnedToolSignals || [])[0];
    const signalText = topSignal ? `；首推=${topSignal.toolName}` : "";
    return `证据=${bundle.items.length}；候选=${topKinds || "暂无"}${signalText}`;
  }

  private async collectCandidateFileEvidence(queryText: string, planner: SearchPlannerResult, bundle: EvidenceBundle) {
    // 【修复漫游问题】：如果只是普通闲聊，不要强制预读并注入候选笔记片段（比如强行把当前笔记内容塞进去）。
    // 否则 LLM 会看到上下文中存在笔记片段，从而觉得自己必须针对该片段进行“总结”或“对话记录”。
    if (planner.intent === "general" && queryText.length < 15 && !/(这个|当前|这篇|笔记|文件)/.test(queryText)) {
      return;
    }

    const terms = this.extractTerms(queryText);
    for (const candidate of planner.candidateFiles.slice(0, 3)) {
      const file = this.app.vault.getAbstractFileByPath(candidate.path);
      if (!(file instanceof TFile)) continue;
      try {
        const content = await this.app.vault.cachedRead(file);
        const snippet = this.pickSnippet(content, terms);
        bundle.items.push({
          kind: "file",
          title: file.basename,
          path: file.path,
          snippet,
          score: candidate.score,
          reason: candidate.reason,
        });
      } catch {
        // ignore
      }
    }

    if (planner.candidateFiles.length > 0) {
      bundle.summary.push(`已从 SearchPlanner 候选文件中预读 ${Math.min(planner.candidateFiles.length, 3)} 个文件片段。`);
    }
  }

  private async collectRagEvidence(query: string, bundle: EvidenceBundle) {
    if (!query || !this.plugin?.ragService?.isReady?.()) return;
    try {
      const results = await this.plugin.ragService.search(query, 3);
      for (const item of results.slice(0, 3)) {
        bundle.items.push({
          kind: "rag",
          title: item.file?.basename || item.path,
          path: item.path,
          snippet: this.compactSnippet(item.content),
          score: Math.round((Number(item.similarity || 0) * 1000)) / 10,
          reason: `语义检索命中，相似度 ${(Number(item.similarity || 0) * 100).toFixed(1)}%`,
        });
      }
      if (results.length > 0) {
        bundle.summary.push(`已补充 ${Math.min(results.length, 3)} 条语义检索证据。`);
      }
    } catch {
      // ignore
    }
  }

  private async collectCodeEvidence(queryText: string, bundle: EvidenceBundle) {
    if (!this.plugin?.symbolIndex) return;
    try {
      const terms = this.extractTerms(queryText).slice(0, 4);
      for (const term of terms) {
        const symbols = await this.plugin.symbolIndex.findSymbols(term, false, 3);
        for (const symbol of symbols) {
          bundle.items.push({
            kind: "code",
            title: `${symbol.kind} ${symbol.name}`,
            path: symbol.path,
            snippet: symbol.preview,
            score: 90,
            reason: `代码符号命中：${symbol.name}（第 ${symbol.line} 行）`,
          });
        }
        if (bundle.items.filter(item => item.kind === "code").length >= 4) break;
      }
      if (bundle.items.some(item => item.kind === "code")) {
        bundle.summary.push("已根据代码符号索引收敛出定义位置，可优先读局部代码。");
      }
    } catch {
      // ignore
    }
  }

  private finalizeActions(bundle: EvidenceBundle, planner: SearchPlannerResult) {
    if (planner.isChitchat) {
      bundle.suggestedActions = [];
    } else if (planner.intent === "edit") {
      bundle.suggestedActions.push("get_note_structure", "read_note", "replace_in_note");
    } else if (planner.intent === "retrieve") {
      bundle.suggestedActions.push("read_note", "search_notes");
      if (this.plugin?.ragService?.isReady?.()) {
        bundle.suggestedActions.push("knowledge_base_query");
      }
    } else if (planner.intent === "code") {
      bundle.suggestedActions.push("find_symbol", "read_code_region", "find_references");
    } else if (planner.intent === "web") {
      bundle.suggestedActions.push("mcp_list_tools", "mcp_call_tool");
    }

    const uniqueItems = new Map<string, EvidenceItem>();
    for (const item of bundle.items) {
      const key = `${item.kind}::${item.path || item.title}`;
      if (!uniqueItems.has(key) || uniqueItems.get(key)!.score < item.score) {
        uniqueItems.set(key, item);
      }
    }
    bundle.items = Array.from(uniqueItems.values())
      .sort((a, b) => b.score - a.score || String(a.path || a.title).localeCompare(String(b.path || b.title)))
      .slice(0, 8);

    bundle.suggestedActions = Array.from(new Set(bundle.suggestedActions));
  }

  private extractTerms(text: string): string[] {
    return Array.from(new Set(
      String(text || "")
        .split(/[\s,，。！？、:：;；()（）【】\[\]\-\/\\]+/)
        .map(s => s.trim())
        .filter(Boolean)
        .filter(s => /[\u4e00-\u9fa5A-Za-z]/.test(s))
        .filter(s => s.length >= 2 && s.length <= 32)
    )).slice(0, 8);
  }

  private pickSnippet(content: string, terms: string[]): string {
    const normalized = String(content || "").replace(/\r/g, "");
    for (const term of terms) {
      const idx = normalized.toLowerCase().indexOf(term.toLowerCase());
      if (idx >= 0) {
        const start = Math.max(0, idx - 60);
        const end = Math.min(normalized.length, idx + term.length + 120);
        return this.compactSnippet(normalized.slice(start, end));
      }
    }
    return this.compactSnippet(normalized.slice(0, 180));
  }

  private compactSnippet(text: string): string {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 220);
  }
}