import { App, TFile } from "obsidian";
import type { EvidenceBundle, LearnedToolSignal } from "./SearchEvidenceBuilder";

export type SearchPlannerIntent = "retrieve" | "edit" | "web" | "command" | "canvas" | "code" | "general";
export type SearchPlannerConfidence = "low" | "medium" | "high";
export type SearchPlannerExecutionMode = "focused" | "structured" | "deep";
export type SearchPlannerTaskScope = "small" | "medium" | "large";

export interface SearchPlannerCandidateFile {
  path: string;
  reason: string;
  score: number;
}

export interface SearchPlannerInput {
  userInput: string;
  context?: string;
  mode: "normal" | "kb" | "search" | "agent" | "collaboration";
  agentName?: string;
  isCustomAgent?: boolean;
  availableTools: string[];
  maxCandidates?: number;
}

export interface SearchPlannerResult {
  intent: SearchPlannerIntent;
  confidence: SearchPlannerConfidence;
  executionMode: SearchPlannerExecutionMode;
  taskScope: SearchPlannerTaskScope;
  shouldUseSynth: boolean;
  recommendedTools: string[];
  candidateFiles: SearchPlannerCandidateFile[];
  reasoning: string[];
  shouldInspectBeforeWrite: boolean;
  needsPlan: boolean;
  complexityReasons: string[];
  isChitchat: boolean;
}

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

export class SearchPlanner {
  constructor(private app: App) {}

  public async plan(input: SearchPlannerInput): Promise<SearchPlannerResult> {
    const normalizedInput = String(input.userInput || "").trim();
    const normalizedContext = String(input.context || "").trim();
    const availableSet = new Set(input.availableTools || []);
    const reasoning: string[] = [];

    const intent = this.inferIntent(normalizedInput, normalizedContext);
    const confidence = this.inferConfidence(intent, normalizedInput, normalizedContext);
    const hasExplicitExecutionApproval = this.hasExplicitExecutionApproval(normalizedInput);
    const shouldInspectBeforeWrite = this.shouldInspectBeforeWrite(intent, normalizedInput, normalizedContext);

    if (intent === "retrieve") reasoning.push("识别为检索/汇总类问题，应先找证据，再回答。");
    if (intent === "edit") reasoning.push("识别为编辑/改写类问题，应先读取结构和目标片段，再执行写入。");
    if (hasExplicitExecutionApproval) reasoning.push("检测到用户明确批准执行，当前轮次应优先推进到 act-first，而不是重复检查。");
    if (intent === "web") reasoning.push("识别为联网/MCP 类问题，应先确认工具名与可用性。");
    if (intent === "command") reasoning.push("识别为命令/执行类问题，应先列出命令，再执行目标命令。");
    if (intent === "canvas") reasoning.push("识别为白板/思维导图类问题，应先读取当前白板，再修改或创建。");
    if (intent === "code") reasoning.push("识别为代码理解/定位类问题，应先找符号、查引用、读局部实现，再分析影响范围。");
    if (reasoning.length === 0) reasoning.push("未识别到强检索或强编辑信号，保持通用执行策略。");

    const recommendedTools = this.pickRecommendedTools(intent, availableSet);
    const candidateFiles = await this.findCandidateFiles({
      input: normalizedInput,
      context: normalizedContext,
      limit: input.maxCandidates ?? 5,
    });
    const complexityReasons = this.inferComplexity({
      userInput: normalizedInput,
      context: normalizedContext,
      intent,
      confidence,
      recommendedTools,
      candidateFiles,
    });
    const taskScope = this.inferTaskScope({
      userInput: normalizedInput,
      context: normalizedContext,
      intent,
      candidateFiles,
      complexityReasons,
    });
    const executionMode = this.inferExecutionMode({
      userInput: normalizedInput,
      context: normalizedContext,
      intent,
      confidence,
      candidateFiles,
      complexityReasons,
      hasExplicitExecutionApproval,
    });
    const shouldUseSynth = executionMode === "deep";

    if (candidateFiles.length > 0) {
      reasoning.push(`已从库中预估出 ${candidateFiles.length} 个候选文件，可优先检查。`);
    }
    reasoning.push(`执行模式判定为 ${this.executionModeLabel(executionMode)}，任务范围为 ${this.taskScopeLabel(taskScope)}。`);
    if (complexityReasons.length > 0) {
      reasoning.push(`任务偏复杂，建议先规划后执行：${complexityReasons.join("；")}`);
    } else {
      reasoning.push("任务边界较集中，默认直接进入执行。");
    }

    const isChitchat = !input.isCustomAgent && intent === "general" && normalizedInput.length < 50 && !/(找|查|帮我|请问|怎么|如何|什么|问题|解释|分析|总结|为什么|翻译|看下|知道|了解|是谁|多少|哪|修改|记录|保存|记下来|新建|对对对|我觉得)/.test(normalizedInput);
    if (isChitchat) {
      reasoning.push("识别为简短日常问候/闲聊，默认收起大部分工具，防止大模型无目的漫游。");
    }

    return {
      intent,
      confidence,
      executionMode,
      taskScope,
      shouldUseSynth,
      recommendedTools,
      candidateFiles,
      reasoning,
      shouldInspectBeforeWrite,
      needsPlan: complexityReasons.length > 0,
      complexityReasons,
      isChitchat,
    };
  }

  public formatForPrompt(plan: SearchPlannerResult): string {
    const parts: string[] = [];
    parts.push("【SearchPlanner 预分析】");
    parts.push(`- 意图: ${this.intentLabel(plan.intent)}（置信度: ${plan.confidence}，执行模式: ${this.executionModeLabel(plan.executionMode)}，任务范围: ${this.taskScopeLabel(plan.taskScope)}，规划方式: ${plan.needsPlan ? "plan" : "direct"}）`);
    if (plan.reasoning.length > 0) {
      parts.push(`- 预判: ${plan.reasoning.join("；")}`);
    }
    if (!plan.isChitchat && plan.recommendedTools.length > 0) {
      parts.push(`- 建议优先工具: ${plan.recommendedTools.join(" -> ")}`);
    }
    if (plan.shouldInspectBeforeWrite) {
      parts.push("- 规则: 任何写入前，必须先读取结构或目标片段，确认后再写。");
    }
    if (plan.candidateFiles.length > 0) {
      parts.push("- 候选文件:");
      for (const candidate of plan.candidateFiles) {
        parts.push(`  - ${candidate.path}（${candidate.reason}）`);
      }
    }
    parts.push(`- 能力开关: synth=${plan.shouldUseSynth ? "on" : "off"}`);
    parts.push("- 执行要求: 先收集证据，再回答或写入；若首个工具无结果，应立即切换到下一个建议工具，而不是空想。");
    return parts.join("\n");
  }

  public getShortStatus(plan: SearchPlannerResult): string {
    const tools = plan.recommendedTools.slice(0, 3).join(", ") || "无明确优先工具";
    const mode = `${this.executionModeLabel(plan.executionMode)}/${plan.needsPlan ? "plan" : "direct"}`;
    return `意图=${this.intentLabel(plan.intent)}；模式=${mode}；范围=${this.taskScopeLabel(plan.taskScope)}；优先工具=${tools}`;
  }

  /**
   * 基于搜索证据重排首轮工具（合并 FirstActionSelector 逻辑）
   */
  public selectFirstActions(plan: SearchPlannerResult, evidence: EvidenceBundle, availableToolNames: string[]): FirstActionSelection {
    const available = new Set(availableToolNames);
    const reasoning: string[] = [];
    const firstRound: string[] = [];
    const learnedSignals = (evidence.learnedToolSignals || []).filter((s: LearnedToolSignal) => available.has(s.toolName));
    const noteEvidenceCount = evidence.items.filter(item => item.kind === "file" || item.kind === "rag").length;
    const isMultiTargetEdit = plan.intent === "edit"
      && (plan.candidateFiles.length >= 2 || noteEvidenceCount >= 2);

    const push = (name: string) => {
      if (!available.has(name) || firstRound.includes(name)) return;
      firstRound.push(name);
    };

    if (isMultiTargetEdit) {
      reasoning.push("识别为多目标编辑任务：首轮优先锁定当前/目标笔记，再进入批量写入。");
      push("read_note");
      push("get_note_structure");
      push("replace_in_note");
      push("modify_note");
      push("append_to_note");
    }

    // 1. 搜索证据学习到的工具排序优先
    for (const signal of learnedSignals.slice(0, 5)) push(signal.toolName);
    if (learnedSignals.length > 0) {
      reasoning.push(`搜索子代理已学到先验：${learnedSignals.slice(0, 3).map(s => `${s.toolName}(${s.score})`).join(" -> ")}`);
    }

    // 2. 搜索子代理建议的动作
    for (const toolName of evidence.suggestedActions || []) push(toolName);

    // 3. 根据证据类型调整
    const hasFileEvidence = evidence.items.some(item => item.kind === "file" || item.kind === "rag");
    const hasCodeEvidence = evidence.items.some(item => item.kind === "code");

    if (hasFileEvidence) {
      reasoning.push("已有笔记/RAG证据，首轮应优先读取目标笔记。");
      push("read_note");
      push("get_note_structure");
    }
    if (hasCodeEvidence) {
      reasoning.push("已有代码符号证据，首轮应优先读局部实现和查引用。");
      push("read_code_region");
      push("find_references");
      push("find_symbol");
    }
    if (evidence.items.length === 0) {
      reasoning.push("证据不足，首轮保留检索工具继续搜证。");
      push("knowledge_base_query");
      push("search_notes");
      push("vector_search");
    }

    // 4. 补充意图相关工具
    if (plan.intent === "edit") { push("get_note_structure"); push("read_note"); push("replace_in_note"); }
    if (plan.intent === "code") { push("find_symbol"); push("read_code_region"); push("find_references"); }
    if (plan.intent === "web") { push("mcp_list_tools"); push("mcp_call_tool"); }
    if (plan.intent === "command") { push("list_commands"); }

    for (const toolName of plan.recommendedTools) push(toolName);

    const rankedToolChoices: RankedToolChoice[] = learnedSignals.slice(0, 8).map(s => ({
      toolName: s.toolName, score: s.score, confidence: s.confidence, reasons: s.reasons,
    }));

    return {
      firstRoundToolNames: firstRound.slice(0, 6),
      deferredToolNames: availableToolNames.filter(n => !firstRound.includes(n)),
      reasoning,
      rankedToolChoices,
    };
  }

  private inferIntent(userInput: string, context: string): SearchPlannerIntent {
    const text = `${userInput}\n${context}`.toLowerCase();
    const userWikiLinks = (String(userInput || "").match(/\[\[[^\]]+\]\]/g) || []).length;
    const contextWikiLinks = (String(context || "").match(/\[\[[^\]]+\]\]/g) || []).length;
    const totalWikiLinks = userWikiLinks + contextWikiLinks;
    const rawText = `${userInput}\n${context}`;
    const hasSourceToTargetsPattern = /(当前笔记|源笔记|参考.*笔记|以.*为参照|根据.*笔记|围绕.*笔记)/i.test(userInput)
      && totalWikiLinks >= 2;
    const hasMultiTargetEnrichment = /(补全|补充|完善|扩写|丰富|补齐|写完整|写得更完整)/i.test(userInput)
      && (/(内链|关联笔记|链接笔记|目标笔记)/i.test(userInput) || totalWikiLinks >= 2);
    const hasStrongEditSignal = /(修改|改写|润色|更新|追加|插入|重写|替换|删除|重命名|移动|覆盖|覆盖原文|覆盖正文|替换内容|替换正文|写回|写回原文|直接写入|整理并替换)/i.test(userInput);
    const hasExplicitNetworkTarget = /(https?:\/\/|www\.|网页|网址|url|浏览器|搜索引擎|抓取网页|打开网页|联网搜索|mcp|调用mcp)/i.test(userInput);

    if (/(白板|canvas|思维导图|脑图)/i.test(userInput)) return "canvas";
    if (/(执行命令|运行命令|命令面板|command\b|cmd\b)/i.test(userInput)) return "command";
    // code MUST be checked BEFORE edit — "整理代码" should be code, not edit
    if (/(函数|方法|类\b|接口|类型\b|变量|引用|调用|实现|定义|import|export|symbol|reference|code|代码|源码|\bts\b|\bjs\b|python|\bpy\b)/i.test(userInput)) return "code";
    if (hasSourceToTargetsPattern || hasMultiTargetEnrichment || hasStrongEditSignal) return "edit";
    if (hasExplicitNetworkTarget) return "web";
    if (/(创建|新建|新增).*(笔记|文件|文件夹)/i.test(userInput)) return "edit";
    if (/(找|查|搜索|检索|列出|汇总|统计|回忆|看看|有哪些|在哪|总结).*?(笔记|记录|文件|内容|对话|日记|想法|资料)|\b(list|find|search|retrieve|lookup)\b/i.test(userInput)) return "retrieve";
    return "general";
  }

  private inferConfidence(intent: SearchPlannerIntent, userInput: string, context: string): SearchPlannerConfidence {
    const text = `${userInput}\n${context}`;
    if (intent === "general") return "low";
    const strongSignals = [
      /(具体|精确|准确|逐个|列出|所有|完整)/i,
      /\[\[[^\]]+\]\]/,
      /["“”《》]/,
      /\.md\b/i,
    ];
    const hitCount = strongSignals.filter(re => re.test(text)).length;
    if (hitCount >= 2) return "high";
    return "medium";
  }

  private shouldInspectBeforeWrite(intent: SearchPlannerIntent, userInput: string, context: string): boolean {
    if (intent === "canvas") return true;
    if (intent !== "edit") return false;

    const text = `${userInput}\n${context}`;
    if (this.hasExplicitExecutionApproval(userInput)) {
      return false;
    }
    const isPureCreate = /(创建|新建|新增).*(笔记|文件|文件夹)/i.test(text)
      && !/(修改|改写|润色|更新|追加|插入|重写|替换|删除|重命名|移动)/i.test(text);
    const isMultiTargetWrite = /(批量|逐个|依次|多个|多篇|全部|所有|分别|补全|补充)/i.test(text)
      && /(创建|新建|新增|修改|改写|更新|追加|插入|重写|替换|完善|写入|写回)/i.test(text);
    const referencesMultipleTargets = (String(userInput || "").match(/\[\[[^\]]+\]\]/g) || []).length >= 2;

    if (isPureCreate) return false;
    if (isMultiTargetWrite || referencesMultipleTargets) return false;

    return true;
  }

  private hasExplicitExecutionApproval(userInput: string): boolean {
    const text = String(userInput || "").trim();
    if (!text) return false;
    return /^(开始吧|开始执行|执行吧|继续|继续执行|就这么做|按这个做|执行选项\s*\d+|同意|确认执行|直接做|开始|完善并写入|完善后写入|直接写入|写回去|按这个方案|按这个方案写入|方案\s*[A-D]|选项\s*[A-D]|[A-D]\s*方案|选择\s*[A-D]|选\s*[A-D]|按\s*[A-D]\s*方案)$/i.test(text)
      || /(请开始执行|现在执行|可以执行了|请直接写入|请完善并写入|按[bcdab]\s*方案执行)/i.test(text);
  }

  private pickRecommendedTools(intent: SearchPlannerIntent, availableTools: Set<string>): string[] {
    const pick = (names: string[]) => names.filter(name => availableTools.has(name));

    switch (intent) {
      case "retrieve":
        return pick(["search_notes", "read_note", "list_files", "get_note_structure", "explore_note_links", "find_note_relationships", "knowledge_base_query", "vector_search"]);
      case "edit":
        return pick(["get_note_structure", "read_note", "replace_in_note", "modify_note", "append_to_note", "create_note", "move_item", "create_folder", "update_properties"]);
      case "web":
        return pick(["mcp_list_tools", "mcp_call_tool", "read_note", "create_note"]);
      case "command":
        return pick(["list_commands", "execute_command"]);
      case "canvas":
        return pick(["read_canvas", "modify_canvas", "create_canvas", "create_canvas_mindmap"]);
      case "code":
        return pick(["find_symbol", "find_references", "list_code_dependencies", "read_code_region", "search_notes", "list_files"]);
      default:
        return pick(["read_note", "search_notes", "get_note_structure", "knowledge_base_query", "vector_search"]);
    }
  }

  private async findCandidateFiles(opts: { input: string; context: string; limit: number }): Promise<SearchPlannerCandidateFile[]> {
    const files = this.app.vault.getMarkdownFiles();
    if (files.length === 0) return [];

    const queryTerms = this.extractQueryTerms(opts.input, opts.context);
    const activeFile = this.app.workspace.getActiveFile();
    const candidates: SearchPlannerCandidateFile[] = [];

    if (activeFile instanceof TFile) {
      candidates.push({
        path: activeFile.path,
        reason: "当前活动笔记，通常与问题最相关",
        score: 100,
      });
    }

    if (queryTerms.length === 0) {
      return candidates.slice(0, opts.limit);
    }

    for (const file of files) {
      let score = 0;
      const reasons: string[] = [];
      const lowerPath = file.path.toLowerCase();
      const lowerBase = file.basename.toLowerCase();

      for (const term of queryTerms) {
        const lowerTerm = term.toLowerCase();
        if (lowerBase === lowerTerm) {
          score += 50;
          reasons.push(`文件名精确匹配“${term}”`);
          continue;
        }
        if (lowerBase.includes(lowerTerm)) {
          score += 30;
          reasons.push(`文件名包含“${term}”`);
          continue;
        }
        if (lowerPath.includes(lowerTerm)) {
          score += 18;
          reasons.push(`路径包含“${term}”`);
        }
      }

      if (score > 0) {
        candidates.push({
          path: file.path,
          reason: Array.from(new Set(reasons)).slice(0, 2).join("；"),
          score,
        });
      }
    }

    return candidates
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, opts.limit);
  }

  private inferComplexity(input: {
    userInput: string;
    context: string;
    intent: SearchPlannerIntent;
    confidence: SearchPlannerConfidence;
    recommendedTools: string[];
    candidateFiles: SearchPlannerCandidateFile[];
  }): string[] {
    const text = `${input.userInput}\n${input.context}`;
    const reasons: string[] = [];
    const totalWikiLinks = (text.match(/\[\[[^\]]+\]\]/g) || []).length;

    const explicitSteps = (text.match(/(?:^|\n)\s*(?:\d+[.)、]|[-*]\s+)/g) || []).length;
    if (explicitSteps >= 2) reasons.push("用户请求本身包含明显分步骤结构");

    const multiGoalSignals = [
      /并且|同时|然后|再|之后|顺便|以及|分别|先.+再/i,
      /不仅.+还/i,
    ];
    if (multiGoalSignals.some(re => re.test(text))) reasons.push("存在多目标或串行子任务");

    if (input.intent === "web" || input.intent === "command" || input.intent === "canvas") {
      reasons.push("任务需要外部执行或专门交互动作");
    }

    if (input.intent === "edit" && input.candidateFiles.length > 1) {
      reasons.push("编辑任务涉及多个候选文件，需要先确认目标");
    }

    if (input.intent === "edit" && totalWikiLinks >= 2) {
      reasons.push("编辑任务涉及多个 wikilink 目标，适合先规划批量写入顺序");
    }

    if (input.intent === "code" && (input.candidateFiles.length > 2 || input.recommendedTools.length > 4)) {
      reasons.push("代码任务可能涉及多文件定位或多工具配合");
    }

    if (/(验证|校验|自测|测试|修复|排查|debug|debugging|回归|检查并修改)/i.test(text)) {
      reasons.push("任务包含验证或修复闭环");
    }

    if (input.confidence === "low" && input.recommendedTools.length >= 4) {
      reasons.push("任务表述较模糊，且需要较多工具协同");
    }

    return Array.from(new Set(reasons)).slice(0, 4);
  }

  private inferTaskScope(input: {
    userInput: string;
    context: string;
    intent: SearchPlannerIntent;
    candidateFiles: SearchPlannerCandidateFile[];
    complexityReasons: string[];
  }): SearchPlannerTaskScope {
    const text = `${input.userInput}\n${input.context}`;
    const wikiLinks = (text.match(/\[\[[^\]]+\]\]/g) || []).length;
    if (input.intent === "web" || input.intent === "command" || input.intent === "canvas") return "large";
    if (input.complexityReasons.length >= 3) return "large";
    if (input.candidateFiles.length >= 3 || wikiLinks >= 3) return "large";
    if (input.complexityReasons.length >= 1 || input.candidateFiles.length >= 2 || wikiLinks >= 2) return "medium";
    return "small";
  }

  private inferExecutionMode(input: {
    userInput: string;
    context: string;
    intent: SearchPlannerIntent;
    confidence: SearchPlannerConfidence;
    candidateFiles: SearchPlannerCandidateFile[];
    complexityReasons: string[];
    hasExplicitExecutionApproval: boolean;
  }): SearchPlannerExecutionMode {
    const text = `${input.userInput}\n${input.context}`;
    const wikiLinks = (text.match(/\[\[[^\]]+\]\]/g) || []).length;
    const isResearchLike = /(系统比较|深入分析|调研|研究|方案对比|折中建议|多角度|利弊|优缺点|全面分析|给出结论)/i.test(text);
    const isDeepNetworkTask = input.intent === "web" && /(深度|详细|系统|完整|调研|研究|汇总多个来源)/i.test(text);
    const isMultiTargetEdit = input.intent === "edit"
      && (input.candidateFiles.length >= 2 || wikiLinks >= 2 || /(批量|逐个|依次|多个|多篇|全部|所有|分别|补全|补充)/i.test(text));
    const isSimpleCodeLookup = input.intent === "code"
      && input.candidateFiles.length <= 2
      && input.complexityReasons.length === 0
      && !/(修复|重构|排查|调试|debug|回归|影响范围)/i.test(text);
    const isSimpleNoteTask = (input.intent === "retrieve" || input.intent === "edit" || input.intent === "general")
      && input.candidateFiles.length <= 2
      && input.complexityReasons.length === 0
      && !/(系统|全面|批量|逐个|研究|调研|多方案|比较|修复|排查|debug|回归)/i.test(text);

    if (isResearchLike || isDeepNetworkTask) return "deep";
    if (input.intent === "web" || input.intent === "command" || input.intent === "canvas") return "deep";
    if (isMultiTargetEdit) return "structured";
    if (input.complexityReasons.length >= 2) return "structured";
    if (input.intent === "code" && !isSimpleCodeLookup) return input.confidence === "high" ? "structured" : "deep";
    if (input.hasExplicitExecutionApproval && (input.intent === "edit" || input.intent === "retrieve" || input.intent === "code")) return "focused";
    if (isSimpleCodeLookup || isSimpleNoteTask) return "focused";
    return input.confidence === "low" ? "structured" : "focused";
  }

  private extractQueryTerms(userInput: string, context: string): string[] {
    const text = `${userInput}\n${context}`;
    const terms: string[] = [];

    const push = (value: string) => {
      const cleaned = String(value || "").trim().replace(/^#/, "");
      if (!cleaned) return;
      if (cleaned.length < 2) return;
      if (/^(帮我|请|麻烦|一下|一个|这个|那个|笔记|文件|内容|问题|总结|整理)$/i.test(cleaned)) return;
      terms.push(cleaned);
    };

    for (const match of text.matchAll(/\[\[([^\]|#]+)(?:#[^\]]+)?(?:\|[^\]]+)?\]\]/g)) push(match[1]);
    for (const match of text.matchAll(/["“”《》]([^"“”《》\n]{2,40})["“”《》]/g)) push(match[1]);
    for (const match of text.matchAll(/([\w\u4e00-\u9fa5 _-]+\.md)\b/g)) push(match[1].replace(/\.md$/i, ""));

    const roughWords = text
      .split(/[\s,，。！？、:：;；()（）【】\[\]\-\/\\]+/)
      .map(s => s.trim())
      .filter(Boolean)
      .filter(s => /[\u4e00-\u9fa5A-Za-z]/.test(s))
      .filter(s => s.length >= 2 && s.length <= 24)
      .slice(0, 20);
    roughWords.forEach(push);

    return Array.from(new Set(terms)).slice(0, 8);
  }

  private intentLabel(intent: SearchPlannerIntent): string {
    switch (intent) {
      case "retrieve": return "检索";
      case "edit": return "编辑";
      case "web": return "联网";
      case "command": return "命令";
      case "canvas": return "白板";
      case "code": return "代码";
      default: return "通用";
    }
  }

  private executionModeLabel(mode: SearchPlannerExecutionMode): string {
    switch (mode) {
      case "focused": return "focused";
      case "structured": return "structured";
      case "deep": return "deep";
      default: return "focused";
    }
  }

  private taskScopeLabel(scope: SearchPlannerTaskScope): string {
    switch (scope) {
      case "small": return "small";
      case "medium": return "medium";
      case "large": return "large";
      default: return "small";
    }
  }
}
