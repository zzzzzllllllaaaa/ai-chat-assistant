import { App, Platform, TFile } from "obsidian";
import type { SearchPlannerResult } from "./SearchPlanner";
import { SearchEvidenceBuilder } from "./SearchEvidenceBuilder";
import type { EvidenceBundle, EvidenceItem, EvidenceKind, LearnedToolSignal } from "./SearchEvidenceBuilder";

export interface SearchSubagentInput {
  userInput: string;
  context?: string;
  planner: SearchPlannerResult;
}

export class SearchSubagent {
  private builder: SearchEvidenceBuilder;

  constructor(private app: App, private plugin: any) {
    this.builder = new SearchEvidenceBuilder(app, plugin);
  }

  public async run(input: SearchSubagentInput): Promise<EvidenceBundle> {
    const bundle = await this.builder.build(input);
    const rounds: string[] = ["round1: 初始证据包"];

    if (this.shouldRefine(input.planner, bundle)) {
      if (input.planner.intent === "retrieve" || input.planner.intent === "edit" || input.planner.intent === "general") {
        await this.refineNotes(input, bundle, rounds);
      }

      if (input.planner.intent === "code") {
        await this.refineCode(input, bundle, rounds);
      }
    }

    bundle.summary.unshift(`搜索子代理已执行 ${rounds.length} 轮收敛：${rounds.join(" → ")}`);
    bundle.items = this.dedupAndRank(bundle.items);
    bundle.learnedToolSignals = this.buildLearnedToolSignals(input.planner, bundle);

    const topSignals = (bundle.learnedToolSignals || []).slice(0, 3).map(signal => `${signal.toolName}(${signal.score})`).join(" -> ");
    if (topSignals) {
      bundle.summary.push(`已将收敛证据反哺为工具先验：${topSignals}`);
    }

    return bundle;
  }

  public formatForPrompt(bundle: EvidenceBundle): string {
    return this.builder.formatForPrompt(bundle);
  }

  public getShortStatus(bundle: EvidenceBundle): string {
    return this.builder.getShortStatus(bundle);
  }

  private shouldRefine(planner: SearchPlannerResult, bundle: EvidenceBundle): boolean {
    if (planner.executionMode === "focused" && planner.confidence !== "low" && bundle.items.length >= 2) return false;
    if (planner.executionMode === "deep") return true;
    if (planner.intent === "code" && planner.needsPlan) return true;
    if (!planner.needsPlan && planner.confidence !== "low" && bundle.items.length >= 2) return false;
    if (Platform.isMobile && planner.confidence !== "low" && bundle.items.length >= 2) return false;
    if (planner.confidence === "high" && bundle.items.length >= 4) return false;
    if (bundle.items.length < 3) return true;
    return planner.confidence === "low";
  }

  private async refineNotes(input: SearchSubagentInput, bundle: EvidenceBundle, rounds: string[]) {
    const noteCandidates = bundle.items.filter(item => item.path && (item.kind === "file" || item.kind === "rag")).slice(0, 2);
    let added = 0;

    for (const item of noteCandidates) {
      const file = this.app.vault.getAbstractFileByPath(String(item.path));
      if (!(file instanceof TFile)) continue;
      try {
        const content = await this.app.vault.cachedRead(file);
        const lines = content.split(/\r?\n/);
        const headings = lines
          .map((line, idx) => ({ line, idx }))
          .filter(row => /^(#{1,6})\s+/.test(row.line))
          .slice(0, 5)
          .map(row => `${row.idx + 1}: ${row.line.trim()}`)
          .join(" | ");

        bundle.items.push({
          kind: "file",
          title: `${file.basename} 结构预读`,
          path: file.path,
          snippet: headings || this.compact(content.slice(0, 220)),
          score: item.score + 2,
          reason: "搜索子代理二次预读：补充目标笔记结构，帮助决定先读哪个标题/片段",
        });
        added++;
      } catch {
        // ignore
      }
    }

    const query = String(input.userInput || "").trim();
    if (added < 2 && query && this.plugin?.ragService?.isReady?.()) {
      try {
        const broader = this.extractTerms(`${input.userInput}\n${input.context || ""}`).slice(0, 3).join(" ");
        if (broader) {
          const more = await this.plugin.ragService.search(broader, 2);
          for (const item of more) {
            bundle.items.push({
              kind: "rag",
              title: item.file?.basename || item.path,
              path: item.path,
              snippet: this.compact(item.content),
              score: Math.round(Number(item.similarity || 0) * 100),
              reason: `搜索子代理扩展检索：使用更宽泛关键词“${broader}”补充语义证据`,
            });
          }
          if (more.length > 0) {
            rounds.push(`round2: note-rag(${more.length})`);
            return;
          }
        }
      } catch {
        // ignore
      }
    }

    if (added > 0) {
      rounds.push(`round2: note-read(${added})`);
    }
  }

  private async refineCode(input: SearchSubagentInput, bundle: EvidenceBundle, rounds: string[]) {
    if (!this.plugin?.symbolIndex) return;
    const terms = this.extractTerms(`${input.userInput}\n${input.context || ""}`).slice(0, 4);
    let added = 0;

    for (const term of terms) {
      const symbols = await this.plugin.symbolIndex.findSymbols(term, false, 2);
      for (const symbol of symbols) {
        const region = await this.plugin.symbolIndex.readCodeRegion(symbol.path, { symbol: symbol.name });
        bundle.items.push({
          kind: "code",
          title: `${symbol.kind} ${symbol.name}`,
          path: symbol.path,
          snippet: this.compact(region || symbol.preview),
          score: 96,
          reason: `搜索子代理局部展开：读取 ${symbol.name} 的局部实现`,
        });
        added++;

        const refs = await this.plugin.symbolIndex.findReferences(symbol.name, 3);
        if (refs.length > 0) {
          bundle.items.push({
            kind: "code",
            title: `${symbol.name} references`,
            path: refs[0].path,
            snippet: refs.map((ref: any) => `${ref.path}:${ref.line} ${ref.preview}`).join(" | "),
            score: 88,
            reason: `搜索子代理扩展：补充 ${symbol.name} 的引用位置`,
          });
          added++;
        }

        if (added >= 4) break;
      }
      if (added >= 4) break;
    }

    if (added > 0) {
      rounds.push(`round2: code-expand(${added})`);
    }
  }

  private dedupAndRank(items: EvidenceItem[]): EvidenceItem[] {
    const map = new Map<string, EvidenceItem>();
    for (const item of items) {
      const key = `${item.kind}::${item.path || item.title}::${item.title}`;
      if (!map.has(key) || map.get(key)!.score < item.score) {
        map.set(key, item);
      }
    }
    return Array.from(map.values())
      .sort((a, b) => b.score - a.score || String(a.path || a.title).localeCompare(String(b.path || b.title)))
      .slice(0, 10);
  }

  private buildLearnedToolSignals(planner: SearchPlannerResult, bundle: EvidenceBundle): LearnedToolSignal[] {
    if (planner.isChitchat) return [];
    
    const ragReady = Boolean(this.plugin?.ragService?.isReady?.());
    const signals = new Map<string, { score: number; evidenceKinds: Set<EvidenceKind>; reasons: string[] }>();
    const add = (toolName: string, score: number, reason: string, kind?: EvidenceKind) => {
      if (!toolName || score <= 0) return;
      const current = signals.get(toolName) || { score: 0, evidenceKinds: new Set<EvidenceKind>(), reasons: [] };
      current.score += score;
      if (kind) current.evidenceKinds.add(kind);
      if (reason && !current.reasons.includes(reason)) current.reasons.push(reason);
      signals.set(toolName, current);
    };

    this.seedIntentToolSignals(planner, ragReady, add);

    const evidenceByPath = new Map<string, number>();
    bundle.items.forEach((item, index) => {
      const normalizedScore = Math.max(4, Math.min(30, Math.round(Number(item.score || 0) / 4)));
      const rankBonus = Math.max(0, 8 - index);
      const pathKey = String(item.path || item.title || "").trim();
      if (pathKey) {
        evidenceByPath.set(pathKey, (evidenceByPath.get(pathKey) || 0) + 1);
      }

      if (item.kind === "file" || item.kind === "rag") {
        add("read_note", normalizedScore + rankBonus, `已收敛到${item.kind === "rag" ? "语义" : "笔记"}证据，应先读目标笔记片段`, item.kind);
        add("search_notes", Math.max(4, Math.round(normalizedScore / 2)), `已出现${item.kind === "rag" ? "语义" : "路径"}命中，可用关键词检索补洞`, item.kind);

        if (/结构预读|^\s*\d+\s*:\s*#|#{1,6}\s+/.test(item.snippet) || /结构/.test(item.reason)) {
          add("get_note_structure", normalizedScore + 10, "已拿到结构线索，优先读取标题结构再细读正文", item.kind);
        }

        if (item.kind === "rag" && ragReady) {
          add("vector_search", normalizedScore + 6, "已有语义检索命中，可继续沿相似片段扩展", item.kind);
          add("knowledge_base_query", normalizedScore + 4, "语义证据已出现，可让知识库问答继续补充摘要", item.kind);
        }

        if (planner.intent === "edit") {
          add("replace_in_note", Math.max(6, Math.round(normalizedScore / 2)), "编辑意图且已定位候选笔记，可在读取后进入精准替换", item.kind);
        }
      }

      if (item.kind === "code") {
        const lowerTitle = String(item.title || "").toLowerCase();
        const lowerReason = String(item.reason || "").toLowerCase();
        const refHeavy = /references|引用/.test(lowerTitle) || /引用/.test(lowerReason);
        const regionHeavy = /局部实现|实现|symbol|定义|类|函数|方法/.test(item.title) || /局部实现|定义位置|代码符号/.test(item.reason);

        add("find_symbol", normalizedScore + 8, "已有代码证据，应先锁定定义符号", item.kind);
        add("read_code_region", normalizedScore + (regionHeavy ? 12 : 6), regionHeavy ? "已出现局部实现证据，优先读代码片段" : "已有代码命中，可读取局部区域确认现场", item.kind);
        add("find_references", normalizedScore + (refHeavy ? 14 : 5), refHeavy ? "已出现引用证据，优先看调用/依赖扩散" : "已有代码定义后，下一步通常要查引用", item.kind);
        add("list_code_dependencies", Math.max(4, Math.round(normalizedScore / 2)), "代码任务已锁定候选符号，可补充依赖影响范围", item.kind);
      }
    });

    const dominantPaths = Array.from(evidenceByPath.values()).filter(count => count >= 2).length;
    if (dominantPaths > 0) {
      add("read_note", dominantPaths * 8, "多个证据已收敛到同一路径，优先直接读取该目标", "file");
      add("read_code_region", dominantPaths * 8, "多个证据已收敛到同一路径，优先直接读取局部实现", "code");
    }

    if (bundle.items.length === 0) {
      add("search_notes", 18, "暂无证据，需先继续全文检索", "file");
      if (ragReady) {
        add("vector_search", 16, "暂无证据，需先继续语义检索", "rag");
        add("knowledge_base_query", 14, "暂无证据，可让知识库先做一次保守搜索", "rag");
      }
    }

    bundle.suggestedActions.forEach((toolName, index) => {
      add(toolName, Math.max(6, 14 - index * 2), "基础建议动作仍保留为弱先验", this.kindForTool(toolName));
    });

    return Array.from(signals.entries())
      .map<LearnedToolSignal>(([toolName, value]) => ({
        toolName,
        score: Math.min(100, Math.max(1, Math.round(value.score))),
        confidence: value.score >= 55 ? "high" : value.score >= 28 ? "medium" : "low",
        evidenceKinds: Array.from(value.evidenceKinds),
        reasons: value.reasons.slice(0, 3),
      }))
      .sort((a, b) => b.score - a.score || a.toolName.localeCompare(b.toolName))
      .slice(0, 10);
  }

  private seedIntentToolSignals(
    planner: SearchPlannerResult,
    ragReady: boolean,
    add: (toolName: string, score: number, reason: string, kind?: EvidenceKind) => void,
  ) {
    if (planner.isChitchat) return;

    switch (planner.intent) {
      case "edit":
        add("get_note_structure", 18, "编辑任务默认先看结构，再进入正文和修改", "file");
        add("read_note", 16, "编辑任务需要先读取目标片段", "file");
        add("replace_in_note", 10, "编辑任务最终可能进入精准替换", "file");
        break;
      case "retrieve":
        add("read_note", 16, "检索任务优先读取已命中的目标笔记", "file");
        add("search_notes", 14, "检索任务需要保留全文搜索兜底", "file");
        if (ragReady) add("vector_search", 12, "检索任务需要保留语义搜索兜底", "rag");
        break;
      case "code":
        add("find_symbol", 18, "代码任务默认先锁定符号定义", "code");
        add("read_code_region", 16, "代码任务默认先读局部实现", "code");
        add("find_references", 14, "代码任务默认要看引用扩散", "code");
        break;
      case "web":
        add("mcp_list_tools", 16, "联网任务先确认可用工具", "rag");
        add("mcp_call_tool", 12, "联网任务通常要进入 MCP 调用", "rag");
        break;
      case "command":
        add("list_commands", 18, "命令任务先列出可执行命令", "file");
        break;
      case "canvas":
        add("read_canvas", 18, "白板任务先读取当前画布状态", "file");
        add("modify_canvas", 10, "白板任务可能进入修改", "file");
        break;
      default:
        add("read_note", 10, "通用任务优先读取已命中内容", "file");
        add("search_notes", 10, "通用任务保留检索兜底", "file");
        break;
    }

    planner.recommendedTools.forEach((toolName, index) => {
      add(toolName, Math.max(6, 12 - index), "SearchPlanner 推荐工具作为弱先验保留", this.kindForTool(toolName));
    });
  }

  private kindForTool(toolName: string): EvidenceKind | undefined {
    if (["read_note", "get_note_structure", "search_notes", "replace_in_note"].includes(toolName)) return "file";
    if (["vector_search", "knowledge_base_query", "mcp_list_tools", "mcp_call_tool"].includes(toolName)) return "rag";
    if (["find_symbol", "find_references", "list_code_dependencies", "read_code_region"].includes(toolName)) return "code";
    return undefined;
  }

  private extractTerms(text: string): string[] {
    return Array.from(new Set(
      String(text || "")
        .split(/[\s,，。！？、:：;；()（）【】\[\]\-\/\\]+/)
        .map(s => s.trim())
        .filter(Boolean)
        .filter(s => /[\u4e00-\u9fa5A-Za-z]/.test(s))
        .filter(s => s.length >= 2 && s.length <= 32)
    ));
  }

  private compact(text: string): string {
    return String(text || "").replace(/\s+/g, " ").trim().slice(0, 240);
  }
}
