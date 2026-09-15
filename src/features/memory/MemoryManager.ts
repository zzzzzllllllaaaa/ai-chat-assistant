import { App, TFile, TFolder, Notice } from "obsidian";
import type { IPluginContext } from "../../core/plugin-context";;
import type { ChatMessage } from "../../core/types";
import { logger } from "../../core/logger";
import { DEFAULT_ROLEPLAY_ISOLATION_PROMPT } from "../../core/settings";
import { GraphRAGManager } from "./GraphRAGManager";
import { StateMachineManager } from "./StateMachineManager";
import { PersonalityEvolutionManager } from "./PersonalityEvolutionManager";
import { ImmersionManager } from "./ImmersionManager";
import type { StateSnapshot } from "./StateTypes";

export class MemoryManager {
  private app: App;
  private plugin: IPluginContext;
  private memoryBasePath: string;
  private personaFolderCache = new Map<string, string>();
  public graphRAG: GraphRAGManager; // Graph RAG 管理器
  public stateMachine: StateMachineManager; // 状态机管理器
  public personalityEvolution: PersonalityEvolutionManager; // 性格演进管理器
  public immersion: ImmersionManager; // 沉浸感管理器
  private stateHistoryCache = new Map<string, StateSnapshot[]>(); // 状态历史缓存

  private readonly GLOBAL_SCOPE_DIR = "_global";
  private readonly PROJECTS_SCOPE_DIR = "_projects";

  private sanitizeTopicFolderName(topic: string): string {
    const raw = String(topic ?? "").trim();
    const normalized = raw.length ? raw : "general";
    const safe = normalized
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 48);
    return safe.length ? safe : "general";
  }

  private resolveProjectKey(explicitProjectKey?: string): string {
    const fromArg = String(explicitProjectKey || "").trim();
    if (fromArg) return this.sanitizeTopicFolderName(fromArg);

    const fromSettings = String(this.plugin.settings.memoryProjectKeyOverride || "").trim();
    if (fromSettings) return this.sanitizeTopicFolderName(fromSettings);

    const active = this.app.workspace.getActiveFile();
    const path = String(active?.path || "").trim();
    if (!path) return "root";
    if (!path.includes('/')) return "root";
    const top = path.split('/')[0] || "root";
    return this.sanitizeTopicFolderName(top);
  }

  private getGlobalBasePath(): string {
    return `${this.memoryBasePath}/${this.GLOBAL_SCOPE_DIR}`;
  }

  private getProjectBasePath(projectKey: string): string {
    const key = this.sanitizeTopicFolderName(projectKey);
    return `${this.memoryBasePath}/${this.PROJECTS_SCOPE_DIR}/${key}`;
  }

  private getEpisodicRootsForRetrieval(personaId: string, projectKey?: string): string[] {
    const roots: string[] = [];
    roots.push(`${this.getPersonaPath(personaId)}/Episodic`);
    for (const legacyPath of this.getLegacyPersonaFolderPaths(personaId)) {
      roots.push(`${legacyPath}/Episodic`);
    }

    if (this.plugin.settings.memoryEpisodicIncludeGlobal) {
      roots.push(`${this.getGlobalBasePath()}/Episodic`);
    }

    if (this.plugin.settings.memoryEpisodicIncludeProject) {
      const key = this.resolveProjectKey(projectKey);
      roots.push(`${this.getProjectBasePath(key)}/Episodic`);
    }

    // Dedup, preserve order
    return Array.from(new Set(roots));
  }

  private async ensureEpisodicWriteBaseFolders(opts: { personaId: string; projectKey?: string }): Promise<{ scope: 'persona' | 'project' | 'global'; episodicBase: string; projectKey?: string }> {
    const scope = this.plugin.settings.memoryEpisodicWriteScope;

    if (scope === 'global') {
      const base = this.getGlobalBasePath();
      await this.ensureFolder(base);
      await this.ensureFolder(`${base}/Episodic`);
      return { scope, episodicBase: `${base}/Episodic` };
    }

    if (scope === 'project') {
      const key = this.resolveProjectKey(opts.projectKey);
      const projectsRoot = `${this.memoryBasePath}/${this.PROJECTS_SCOPE_DIR}`;
      await this.ensureFolder(projectsRoot);
      const base = this.getProjectBasePath(key);
      await this.ensureFolder(base);
      await this.ensureFolder(`${base}/Episodic`);
      return { scope, episodicBase: `${base}/Episodic`, projectKey: key };
    }

    // persona (default)
    const personaBase = await this.ensurePersonaFolders(opts.personaId);
    return { scope: 'persona', episodicBase: `${personaBase}/Episodic` };
  }

  private tryParseJsonObject(text: string): any | null {
    const trimmed = String(text || "").trim();
    if (!trimmed) return null;

    const withoutFences = trimmed
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    try {
      const parsed = JSON.parse(withoutFences);
      if (parsed && typeof parsed === "object") return parsed;
      return null;
    } catch {
      return null;
    }
  }

  /**
   * 获取记忆整理使用的模型
   * 优先使用 memoryModel，其次 routerModel，最后回退到 chatModels 第一个
   */
  private getMemoryModel(): string {
    const settings = this.plugin.settings;
    return settings.memoryModel?.trim() 
      || settings.routerModel?.trim() 
      || settings.chatModels.split(',')[0]?.trim() 
      || 'gpt-3.5-turbo';
  }

  private listMarkdownFilesRecursive(root: TFolder): TFile[] {
    const files: TFile[] = [];
    const stack: TFolder[] = [root];

    while (stack.length) {
      const folder = stack.pop();
      if (!folder) break;
      for (const child of folder.children) {
        if (child instanceof TFolder) {
          stack.push(child);
        } else if (child instanceof TFile && child.extension === 'md') {
          files.push(child);
        }
      }
    }

    return files;
  }

  private extractQueryKeywords(query: string): string[] {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return [];

    const keywords = new Set<string>();

    // English-like tokens (IDs, model names, numbers, codes)
    const en = q.match(/[a-z0-9][a-z0-9._-]{1,}/g) || [];
    for (const t of en) {
      const token = t.trim();
      if (token.length >= 2) keywords.add(token);
    }

    // Chinese phrases (2+ chars)
    const zh = q.match(/[\u4e00-\u9fa5]{2,}/g) || [];
    for (const t of zh) {
      const token = t.trim();
      if (token.length >= 2) keywords.add(token);
    }

    // Also keep the full query if it's short (helps exact substring match)
    if (q.length >= 2 && q.length <= 24) keywords.add(q);

    return Array.from(keywords).slice(0, 12);
  }

  private countOccurrences(text: string, needle: string): number {
    if (!text || !needle) return 0;
    let count = 0;
    let idx = 0;
    while (true) {
      idx = text.indexOf(needle, idx);
      if (idx === -1) break;
      count++;
      idx += needle.length;
      if (count >= 20) break; // hard cap
    }
    return count;
  }

  private scoreByKeywords(text: string, keywords: string[]): number {
    if (!text || !keywords || keywords.length === 0) return 0;
    const hay = text.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      const c = this.countOccurrences(hay, kw);
      if (c <= 0) continue;
      const capped = Math.min(3, c);
      const weight = kw.length >= 4 ? 2 : 1;
      score += capped * weight;
    }
    return score;
  }

  private stripFrontmatter(markdown: string): string {
    return String(markdown || "").replace(/---[\s\S]*?---/, "").trim();
  }

  private async keywordSearchEpisodic(opts: {
    episodicRoots: string[];
    query: string;
    maxFiles?: number;
    maxResults?: number;
  }): Promise<Array<{ file: TFile; content: string; score: number }>> {
    const roots = (opts.episodicRoots || []).map(s => String(s || "").trim()).filter(Boolean);
    if (roots.length === 0) return [];

    const episodicFolders: TFolder[] = [];
    for (const rootPath of roots) {
      const f = this.app.vault.getAbstractFileByPath(rootPath);
      if (f instanceof TFolder) episodicFolders.push(f);
    }
    if (episodicFolders.length === 0) return [];

    const keywords = this.extractQueryKeywords(opts.query);
    if (keywords.length === 0) return [];

    const maxFiles = Math.max(1, Math.min(80, opts.maxFiles ?? 30));
    const maxResults = Math.max(1, Math.min(5, opts.maxResults ?? 2));

    const allFiles: TFile[] = [];
    for (const folder of episodicFolders) {
      allFiles.push(...this.listMarkdownFilesRecursive(folder));
    }

    const files = allFiles
      .sort((a, b) => b.stat.ctime - a.stat.ctime)
      .slice(0, maxFiles);

    const scored: Array<{ file: TFile; content: string; score: number }> = [];
    for (const file of files) {
      try {
        const raw = await this.app.vault.read(file);
        const content = this.stripFrontmatter(raw);
        // Score only on a limited window for performance.
        const windowText = content.length > 20000 ? content.slice(0, 20000) : content;
        const score = this.scoreByKeywords(windowText, keywords);
        if (score > 0) {
          scored.push({ file, content, score });
        }
      } catch {
        // Ignore read errors
      }
    }

    scored.sort((a, b) => b.score - a.score || b.file.stat.ctime - a.file.stat.ctime);
    return scored.slice(0, maxResults);
  }

  private normalizeFactKey(key: string): string {
    return String(key || "")
      .trim()
      .replace(/\s+/g, " ")
      .replace(/[：:]\s*$/g, "")
      .toLowerCase();
  }

  private normalizeFactValue(value: string): string {
    return String(value || "").trim().replace(/\s+/g, " ");
  }

  private parseFactLines(text: string): Array<{ key: string; displayKey: string; value: string; raw: string }> {
    const lines = String(text || "")
      .split(/\r?\n/)
      .map(l => l.trim());

    const out: Array<{ key: string; displayKey: string; value: string; raw: string }> = [];
    for (const line of lines) {
      if (!line.startsWith("-")) continue;
      const m = line.match(/^-[\s]*([^:：]+?)\s*[:：]\s*(.+)$/);
      if (!m) continue;
      const displayKey = String(m[1] || "").trim();
      const key = this.normalizeFactKey(displayKey);
      const value = this.normalizeFactValue(m[2]);
      if (!key || !value) continue;
      out.push({ key, displayKey, value, raw: `- ${displayKey}: ${m[2].trim()}` });
    }
    return out;
  }

  /**
   * 过滤掉 Markdown 中带 (禁用) 标记的章节
   * 用于角色知识库等文件，实现条目级别的启用/禁用控制
   */
  private filterDisabledSections(content: string): string {
    const lines = content.split('\n');
    const resultLines: string[] = [];
    
    let isDisabled = false;
    let inHeader = false;
    
    for (const line of lines) {
      // 检测二级标题
      if (line.startsWith('## ')) {
        const title = line.substring(3).trim();
        // 检查是否包含禁用标记（支持多种格式）
        isDisabled = /\(禁用\)|\（禁用\）|\(已禁用\)|\（已禁用\）/i.test(title);
        inHeader = true;
        
        if (!isDisabled) {
          resultLines.push(line);
        }
        continue;
      }
      
      // 跳过一级标题（文件标题）
      if (line.startsWith('# ')) {
        resultLines.push(line);
        continue;
      }
      
      // 跳过分隔线，它们只是视觉分隔
      if (line === '---') {
        if (!isDisabled) {
          resultLines.push(line);
        }
        continue;
      }
      
      // 如果当前章节未禁用，添加内容
      if (!isDisabled) {
        resultLines.push(line);
      }
    }
    
    // 清理多余空行
    return resultLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /**
   * 角色知识库（Lorebook / Character Book）动态关键词激活
   * 
   * 知识库中的条目可以通过标题中的关键词标记来控制动态激活：
   * - `## 龙族历史 [keys: 龙族, 龙, 火焰, 古龙]` — 只有当对话中提及这些关键词时才注入
   * - `## 魔法体系` — 没有 keys 标记的条目始终注入（常驻条目）
   * 
   * 这样可以减少不相关的世界设定对 token 和注意力的浪费
   */
  private activateLorebookByKeywords(content: string, query: string): string {
    if (!content || !query) return content;
    
    const queryLower = String(query || '').toLowerCase();
    const lines = content.split('\n');
    const resultLines: string[] = [];
    
    let currentSectionActive = true;
    let currentSectionHasKeys = false;
    
    for (const line of lines) {
      // 检测二级标题 — 可能包含 [keys: ...] 标记
      if (line.startsWith('## ')) {
        const title = line.substring(3).trim();
        
        // 提取 [keys: ...] 标记
        const keysMatch = title.match(/\[keys?:\s*([^\]]+)\]/i);
        if (keysMatch) {
          currentSectionHasKeys = true;
          const keys = keysMatch[1].split(/[,，、]/).map(k => k.trim().toLowerCase()).filter(Boolean);
          // 检查任一关键词是否出现在查询中
          currentSectionActive = keys.some(key => queryLower.includes(key));
          
          if (currentSectionActive) {
            // 移除 [keys: ...] 标记后输出标题
            resultLines.push('## ' + title.replace(/\s*\[keys?:\s*[^\]]+\]/i, '').trim());
          }
        } else {
          // 没有 keys 标记 → 常驻条目，始终激活
          currentSectionHasKeys = false;
          currentSectionActive = true;
          resultLines.push(line);
        }
        continue;
      }
      
      // 一级标题始终保留
      if (line.startsWith('# ')) {
        resultLines.push(line);
        continue;
      }
      
      // 根据当前章节是否激活决定是否保留
      if (currentSectionActive) {
        resultLines.push(line);
      }
    }
    
    return resultLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  private getExistingFactMap(profileMarkdown: string): Map<string, { value: string; displayKey: string }> {
    const facts = this.parseFactLines(profileMarkdown);
    const map = new Map<string, { value: string; displayKey: string }>();
    for (const f of facts) {
      // Keep the newest occurrence (append-style history). This helps us detect conflicts against latest.
      map.set(f.key, { value: f.value, displayKey: f.displayKey });
    }
    return map;
  }

  private async resolveProfileConflicts(opts: {
    existingProfile: string;
    newFacts: Array<{ key: string; value: string }>;
    evidence: string;
  }): Promise<string> {
    const newFactsText = opts.newFacts.map(f => `- ${f.key}: ${f.value}`).join("\n");
    const prompt = [
      {
        role: 'system' as const,
        content:
          `你是用户画像管理员。请将新信息合并到现有画像中。

规则：
1. 不要凭空编造信息
2. 当新旧信息冲突时，结合上下文证据判断哪个更准确：
   - 如果证据支持新信息，替换旧信息
   - 如果信息是补充/细化关系，合并为更完整的描述
   - 如果无法判断，保留两者并标注"待确认"
3. 去除重复项
4. 清除可能来自角色扮演/虚构故事的错误信息（如虚构角色的属性、剧情事件等）
5. 保持清晰的 Markdown 格式（使用 "- 属性: 值" 的形式）
6. 保留有用的章节标题
7. 如有括号中的置信理由可以去掉，只保留核心信息

输出完整的更新后画像。`,
      },
      {
        role: 'user' as const,
        content:
          `现有画像：\n\n${opts.existingProfile}\n\n新信息（需要合并）：\n\n${newFactsText}\n\n上下文证据（用户最近消息）：\n\n${opts.evidence}`,
      },
    ];

    const response = await this.plugin.llmService.getCompletion(
      prompt,
      this.getMemoryModel()
    );
    return String(response?.content || "").trim();
  }

  constructor(app: App, plugin: IPluginContext) {
    this.app = app;
    this.plugin = plugin;
    this.memoryBasePath = this.plugin.settings.memoryPath || "AI_Memory";
    this.graphRAG = new GraphRAGManager(app, plugin);
    this.stateMachine = new StateMachineManager(app, plugin, this.memoryBasePath);
    this.personalityEvolution = new PersonalityEvolutionManager(app, plugin, this.memoryBasePath);
    this.immersion = new ImmersionManager(app, logger);
  }

  public async initialize() {
    if (!this.plugin.settings.enableMemory) return;
    
    // Ensure root memory folder exists
    await this.ensureFolder(this.memoryBasePath);
  }

  private getPersonaPath(personaId: string): string {
    const cached = this.personaFolderCache.get(personaId);
    if (cached) return `${this.memoryBasePath}/${cached}`;

    const folderName = this.resolveDesiredPersonaFolderName(personaId);
    this.personaFolderCache.set(personaId, folderName);
    return `${this.memoryBasePath}/${folderName}`;
  }

  private resolveDesiredPersonaFolderName(personaId: string): string {
    const safeId = this.getSafePersonaId(personaId);
    const persona = (this.plugin.settings.personas || []).find(p => p.id === personaId);
    const rawName = String(persona?.name || "").trim();
    const safeName = this.sanitizeTopicFolderName(rawName);
    return safeName || safeId || "default";
  }

  private getSafePersonaId(personaId: string): string {
    return String(personaId || "").replace(/[^a-zA-Z0-9\u4e00-\u9fa5-_]/g, "_");
  }

  private getLegacyPersonaFolderPaths(personaId: string): string[] {
    const safeId = this.getSafePersonaId(personaId);
    const safeName = this.sanitizeTopicFolderName(
      (this.plugin.settings.personas || []).find(p => p.id === personaId)?.name || ""
    );
    const desired = this.resolveDesiredPersonaFolderName(personaId);
    const candidates = [safeId, safeName ? `${safeName}__${safeId}` : ""].filter(Boolean);
    const out: string[] = [];
    for (const name of candidates) {
      const path = `${this.memoryBasePath}/${name}`;
      if (path === `${this.memoryBasePath}/${desired}`) continue;
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFolder) out.push(path);
    }
    return out;
  }

  private async ensurePersonaFolderName(personaId: string): Promise<string> {
    const desired = this.resolveDesiredPersonaFolderName(personaId);
    const desiredPath = `${this.memoryBasePath}/${desired}`;
    const desiredFolder = this.app.vault.getAbstractFileByPath(desiredPath);
    if (desiredFolder instanceof TFolder) {
      this.personaFolderCache.set(personaId, desired);
      return desired;
    }

    const legacyPaths = this.getLegacyPersonaFolderPaths(personaId);
    for (const legacyPath of legacyPaths) {
      const legacyFolder = this.app.vault.getAbstractFileByPath(legacyPath);
      if (legacyFolder instanceof TFolder) {
        try {
          await this.app.vault.rename(legacyFolder, desiredPath);
          this.personaFolderCache.set(personaId, desired);
          return desired;
        } catch (e) {
          logger.warn("AI", "Rename persona memory folder failed", e);
        }
      }
    }

    this.personaFolderCache.set(personaId, desired);
    return desired;
  }

  private async ensurePersonaFolders(personaId: string) {
    const folderName = await this.ensurePersonaFolderName(personaId);
    const basePath = `${this.memoryBasePath}/${folderName}`;
    await this.ensureFolder(basePath);
    await this.ensureFolder(`${basePath}/Episodic`);
    await this.ensureFolder(`${basePath}/Facts`);
    return basePath;
  }

  private async ensureFolder(path: string) {
    const folder = this.app.vault.getAbstractFileByPath(path);
    if (!folder) {
      await this.app.vault.createFolder(path);
    }
  }

  private getAllPersonaMemoryFolderPaths(personaId: string): string[] {
    const desired = this.resolveDesiredPersonaFolderName(personaId);
    const paths = [
      `${this.memoryBasePath}/${desired}`,
      ...this.getLegacyPersonaFolderPaths(personaId),
    ];
    return Array.from(new Set(paths));
  }

  public async deletePersonaMemory(personaId: string): Promise<void> {
    const paths = this.getAllPersonaMemoryFolderPaths(personaId);
    for (const path of paths) {
      const folder = this.app.vault.getAbstractFileByPath(path);
      if (folder instanceof TFolder) {
        await this.app.vault.delete(folder, true);
      }
    }
  }

  public async archivePersonaMemory(personaId: string): Promise<string[]> {
    const archiveRoot = `${this.memoryBasePath}/_archived`;
    await this.ensureFolder(archiveRoot);
    const archived: string[] = [];

    const paths = this.getAllPersonaMemoryFolderPaths(personaId);
    for (const path of paths) {
      const folder = this.app.vault.getAbstractFileByPath(path);
      if (!(folder instanceof TFolder)) continue;

      const baseName = folder.name || this.resolveDesiredPersonaFolderName(personaId);
      const suffix = Date.now();
      const targetPath = `${archiveRoot}/${baseName}_${suffix}`;
      await this.app.vault.rename(folder, targetPath);
      archived.push(targetPath);
    }

    return archived;
  }

  public async summarizeConversation(history: ChatMessage[], personaId: string, projectKey?: string) {
    if (!this.plugin.settings.enableMemory || history.length < 5) return;

    // Only summarize user and assistant messages
    const conversationText = history
      .filter(msg => msg.role === 'user' || msg.role === 'assistant')
      .map(msg => `${msg.role}: ${msg.content}`)
      .join("\n");

    const prompt = [
      {
        role: 'system' as const,
        content:
          "你是记忆归档助手。请用中文输出，格式为JSON，包含以下字段：topic（简短主题，2-4个字）、tags（标签数组，最多8个）、summary（Markdown格式的对话摘要）。" +
          "规则：topic要简短稳定，不确定时用'日常'。summary要包含关键信息和结论。只输出JSON，不要其他内容。",
      },
      { role: 'user' as const, content: conversationText },
    ];

    try {
      const response = await this.plugin.llmService.getCompletion(prompt, this.getMemoryModel());
      const raw = response.content || "";
      if (raw) {
        const parsed = this.tryParseJsonObject(raw);
        const topic = this.sanitizeTopicFolderName(parsed?.topic);
        const tags = Array.isArray(parsed?.tags)
          ? parsed.tags.map((t: any) => String(t).trim()).filter(Boolean).slice(0, 8)
          : [];
        const summary = typeof parsed?.summary === 'string' && parsed.summary.trim().length ? parsed.summary.trim() : raw.trim();

        const date = new Date().toISOString().split('T')[0];
        const time = new Date().getTime();

        const writeBase = await this.ensureEpisodicWriteBaseFolders({ personaId, projectKey });
        const useTopicFolders = Boolean(this.plugin.settings.memoryEpisodicTopicFolders);
        const episodicFolderPath = useTopicFolders ? `${writeBase.episodicBase}/${topic}` : writeBase.episodicBase;
        if (useTopicFolders) {
          await this.ensureFolder(episodicFolderPath);
        }

        const filename = `${episodicFolderPath}/${date}_${time}.md`;

        const file = await this.app.vault.create(
          filename,
          `---\n日期: ${date}\n类型: 情景记忆\n角色: ${personaId}\n范围: ${writeBase.scope === 'persona' ? '角色' : writeBase.scope === 'project' ? '项目' : '全局'}\n项目: ${writeBase.projectKey ?? ''}\n主题: ${topic}\n标签: ${tags.join(', ')}\n来源: 对话总结\n---\n\n${summary}`
        );
        
        // Index the new memory immediately
        if (this.plugin.vectorIndexManager) {
            await this.plugin.vectorIndexManager.indexFile(file);
            await this.plugin.vectorIndexManager.saveFullState();
        }

        new Notice("对话记忆已归档。");
      }
    } catch (e) {
      logger.error("AI", "Memory summarization failed", e);
    }
  }

  /**
   * 直接写入情景记忆（无需 LLM）
   * 供外部 API（WorkBuddy 等）调用
   */
  public async writeEpisodicMemory(
    personaId: string,
    topic: string,
    tags: string[],
    summary: string,
    projectKey?: string,
    source: string = 'WorkBuddy写入'
  ): Promise<{ path: string; file: TFile }> {
    const date = new Date().toISOString().split('T')[0];
    const time = new Date().getTime();

    const topicSafe = this.sanitizeTopicFolderName(topic);
    const writeBase = await this.ensureEpisodicWriteBaseFolders({ personaId, projectKey });
    const useTopicFolders = Boolean(this.plugin.settings.memoryEpisodicTopicFolders);
    const episodicFolderPath = useTopicFolders ? `${writeBase.episodicBase}/${topicSafe}` : writeBase.episodicBase;
    if (useTopicFolders) {
      await this.ensureFolder(episodicFolderPath);
    }

    const filename = `${episodicFolderPath}/${date}_${time}.md`;

    const scopeLabel = writeBase.scope === 'persona' ? '角色' : writeBase.scope === 'project' ? '项目' : '全局';

    const file = await this.app.vault.create(
      filename,
      `---
日期: ${date}
类型: 情景记忆
角色: ${personaId}
范围: ${scopeLabel}
项目: ${writeBase.projectKey ?? ''}
主题: ${topicSafe}
标签: ${tags.join(', ')}
来源: ${source}
---

${summary}`
    );

    // Index the new memory immediately
    if (this.plugin.vectorIndexManager) {
      await this.plugin.vectorIndexManager.indexFile(file);
      await this.plugin.vectorIndexManager.saveFullState();
    }

    return { path: file.path, file };
  }

  public async extractFacts(lastMessage: string, personaId: string, recentHistory?: ChatMessage[]) {
    if (!this.plugin.settings.enableMemory) return;

    // 判断是否处于角色扮演模式
    const persona = (this.plugin.settings.personas || []).find(p => p.id === personaId);
    const isRoleplay = String((persona as any)?.type || '').trim() === 'character';

    // 如果处于角色扮演模式且消息很短/看起来像剧情内容，跳过提取
    if (isRoleplay) {
      const msg = String(lastMessage || '').trim();
      // 检测是否为纯粹的角色扮演对话（包含*动作描写*或全是对话内容而无OOC标记）
      const isLikelyPureRP = /^[*＊「」（）()\"'"'"'\s]/.test(msg) && !/^(ooc|OOC|\(\(|（（)/.test(msg);
      if (isLikelyPureRP && msg.length < 200) {
        logger.debug('AI', '[Memory/extractFacts] 角色扮演消息，跳过用户画像提取');
        return;
      }
    }

    // 构建上下文：传入最近几条消息帮助模型判断场景
    let contextBlock = '';
    if (recentHistory && recentHistory.length > 0) {
      const recentMsgs = recentHistory
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .slice(-6)
        .map(m => `${m.role === 'user' ? '用户' : 'AI'}: ${String(m.content || '').slice(0, 300)}`)
        .join('\n');
      contextBlock = `\n\n## 最近对话上下文（帮助你判断是否在角色扮演）\n${recentMsgs}\n\n## 需要提取的用户消息`;
    }

    const extractionPrompt = `从以下消息中提取关于【真实用户本人】的稳定个人信息。

## 核心判断规则

### 场景识别（第一步）
先判断当前对话处于什么场景：
- **正常对话**：用户在和AI正常聊天、询问、讨论
- **角色扮演**：用户在和AI进行虚构的角色扮演故事
- **混合模式**：角色扮演中穿插OOC（真人交流）

### 提取规则
1. **正常对话场景**：提取用户直接表达的个人信息
2. **角色扮演场景**：【极其谨慎】
   - 角色的行为、偏好、属性 → 绝对不记录
   - "我的角色要去……" → 不记录（这是角色行为）
   - OOC中的真实表达 → 可以记录
3. **关于消息的表达方式**：
   - 用户说"我是XX" / "我叫XX" / "我在XX工作" → 可能是真实信息
   - 用户在故事中扮演国王/勇者/女仆 → 这是角色，不是用户

### 什么才值得记录？
- 用户明确声明的个人信息（姓名、职业、年龄、所在地）
- 用户反复（多次/强调）表达的真实偏好和习惯
- 用户的学习/工作相关信息
- 用户对AI交互的偏好（称呼方式、回复风格、语言偏好）
- 用户提到的真实生活中的重要关系（家人、宠物等）

### 什么不记录？
- 角色扮演中角色的一切属性和行为
- 一次性的随口一提（等多次确认后再记录）
- 临时的情绪表达（今天很开心/很累 → 不是持久特征）
- 模棱两可、无法确认真假的信息

如果没有符合条件的真实用户信息，返回"无新信息"。
格式为"- 属性: 值"，使用中文。每条信息附上简短的置信理由。
例如："- 职业: 程序员 (用户在正常对话中直接说明)"${contextBlock}`;

    const prompt = [
      { role: 'system' as const, content: extractionPrompt },
      { role: 'user' as const, content: lastMessage }
    ];

    try {
      const memModel = this.getMemoryModel();
      logger.debug('AI', `[Memory/extractFacts] 记忆提取使用模型: ${memModel}（设置路径: memoryModel → routerModel → chatModels[0]）`);
      const response = await this.plugin.llmService.getCompletion(prompt, memModel);
      const facts = response.content || "";
      if (facts && !facts.includes('无新信息') && facts !== 'NO_FACTS' && facts.includes('- ')) {
        const basePath = await this.ensurePersonaFolders(personaId);
        // 优先使用中文文件名，兼容旧的英文文件名
        let profilePath = `${basePath}/Facts/用户画像.md`;
        let file = this.app.vault.getAbstractFileByPath(profilePath);
        
        // 如果中文文件不存在，检查英文文件
        if (!file) {
          const legacyPath = `${basePath}/Facts/User_Profile.md`;
          const legacyFile = this.app.vault.getAbstractFileByPath(legacyPath);
          if (legacyFile instanceof TFile) {
            // 迁移旧文件到新名称
            await this.app.vault.rename(legacyFile, profilePath);
            file = this.app.vault.getAbstractFileByPath(profilePath);
          }
        }
        
        if (!file) {
          file = await this.app.vault.create(profilePath, "# 用户画像\n\n");
        }

        if (file instanceof TFile) {
          const existingContent = await this.app.vault.read(file);
          const existingMap = this.getExistingFactMap(existingContent);
          const newFacts = this.parseFactLines(facts);

          // 1) Local dedupe + conflict detection (avoid LLM call when possible)
          const toAppend: string[] = [];
          const conflicts: Array<{ key: string; oldValue: string; newValue: string }> = [];

          for (const f of newFacts) {
            const existing = existingMap.get(f.key);
            if (!existing) {
              toAppend.push(`- ${f.displayKey}: ${f.value}`);
              existingMap.set(f.key, { value: f.value, displayKey: f.displayKey });
              continue;
            }

            if (this.normalizeFactValue(existing.value) === this.normalizeFactValue(f.value)) {
              continue; // exact duplicate
            }

            // Use displayKey (more readable) when asking the model to merge
            conflicts.push({ key: f.displayKey, oldValue: existing.value, newValue: f.value });
          }

          // 2) If conflicts exist, ask LLM to merge into a clean profile (full rewrite)
          if (conflicts.length > 0) {
            try {
              const merged = await this.resolveProfileConflicts({
                existingProfile: existingContent,
                newFacts: conflicts.map(c => ({ key: c.key, value: c.newValue })),
                evidence: lastMessage,
              });

              if (merged) {
                await this.app.vault.modify(file, merged);
                new Notice("用户画像已更新（去重/冲突合并）。");
                return;
              }
            } catch (e) {
              logger.warn("AI", "Conflict resolution failed", e);
              // Fallback to append-only path below
            }
          }

          // 3) No conflicts (or conflict merge failed): append only truly new facts
          if (toAppend.length > 0) {
            await this.app.vault.append(file, `\n${toAppend.join("\n")}`);
          }

          // 4) Low-frequency consolidation (keep as a safety net)
          const contentAfter = toAppend.length > 0 ? await this.app.vault.read(file) : existingContent;
          if (contentAfter.length > 2000) {
            this.consolidateFacts(file);
          }
        }
      }
    } catch (e) {
      logger.error("AI", "Fact extraction failed", e);
    }
  }

  /**
   * 全量提取角色扮演信息（用于长对话的批量回顾）
   * 将对话分段处理，确保早期内容也能被提取

  /**
   * 内部方法：提取单批消息的角色扮演元素
   */
  public async extractKnowledgeGraph(messages: ChatMessage[], personaId: string): Promise<void> {
    if (!this.plugin.settings.enableMemory) return;
    if (messages.length < 2) return;

    const conversationText = messages
      .filter(msg => msg.role === 'user' || msg.role === 'assistant')
      .map(msg => `${msg.role === 'user' ? '用户' : '角色'}: ${msg.content}`)
      .join("\n");

    try {
      logger.info("GraphRAG", `开始提取知识图谱，消息数: ${messages.length}`);
      
      // 调用 GraphRAGManager 提取三元组
      const triplets = await this.graphRAG.extractTriplets(conversationText, personaId);
      
      if (!triplets || (triplets.entities.length === 0 && triplets.relationships.length === 0)) {
        logger.debug("GraphRAG", "未提取到有效的三元组");
        return;
      }

      // 保存到图数据库
      await this.graphRAG.saveTriplets(triplets, personaId);
      
      logger.info("GraphRAG", `成功提取并保存: ${triplets.entities.length} 个实体, ${triplets.relationships.length} 条关系`);
      new Notice(`记忆图谱已更新：${triplets.entities.length} 个实体，${triplets.relationships.length} 条关系`);
    } catch (e) {
      logger.error("GraphRAG", "知识图谱提取失败", e);
    }
  }

  /**
   * 【新增】从记忆图谱中检索相关上下文
   */
  public async getGraphContext(query: string, personaId: string): Promise<string> {
    try {
      const context = await this.graphRAG.hybridSearch(query, personaId, 1);
      return context;
    } catch (e) {
      logger.error("GraphRAG", "图谱检索失败", e);
      return "";
    }
  }

  /**
   * 【新增】更新角色状态机
   */
  public async updateCharacterState(messages: ChatMessage[], personaId: string): Promise<void> {
    if (!this.plugin.settings.enableMemory) return;
    if (messages.length < 2) return;

    try {
      const personaFolderName = this.resolveDesiredPersonaFolderName(personaId);
      const result = await this.stateMachine.updateState(messages, personaId, personaFolderName);
      
      if (result && result.changes.length > 0) {
        logger.info("StateMachine", `状态已更新: ${result.changes.length} 个变化`);
        
        // 缓存状态历史（用于性格演进检测）
        const cacheKey = personaId;
        if (!this.stateHistoryCache.has(cacheKey)) {
          this.stateHistoryCache.set(cacheKey, []);
        }
        const history = this.stateHistoryCache.get(cacheKey)!;
        history.push(result.snapshot);
        
        // 只保留最近 20 个快照
        if (history.length > 20) {
          history.shift();
        }
      }
    } catch (e) {
      logger.error("StateMachine", "状态更新失败", e);
    }
  }

  /**
   * 【新增】获取角色当前状态的文本描述（用于注入 Prompt）
   */
  public async getStateContext(personaId: string): Promise<string> {
    try {
      const personaFolderName = this.resolveDesiredPersonaFolderName(personaId);
      const snapshot = await this.stateMachine.loadState(personaId, personaFolderName);
      return this.stateMachine.stateToPromptText(snapshot);
    } catch (e) {
      logger.error("StateMachine", "获取状态上下文失败", e);
      return "";
    }
  }

  /**
   * 【新增】检测并应用性格演进
   */
  public async detectAndApplyPersonalityEvolution(
    messages: ChatMessage[],
    personaId: string
  ): Promise<void> {
    if (!this.plugin.settings.enableMemory) return;

    try {
      const cacheKey = personaId;
      const stateHistory = this.stateHistoryCache.get(cacheKey) || [];
      
      // 至少需要 5 个状态快照才能检测趋势
      if (stateHistory.length < 5) {
        logger.debug("PersonalityEvolution", "状态历史不足，跳过性格演进检测");
        return;
      }

      // 检测性格变化
      const detection = await this.personalityEvolution.detectPersonalityChange(
        messages,
        stateHistory,
        personaId
      );

      if (!detection || !detection.hasSignificantChange) {
        logger.debug("PersonalityEvolution", "未检测到重大性格变化");
        return;
      }

      logger.info("PersonalityEvolution", `检测到 ${detection.changes.length} 个性格变化`);

      // 为每个变化创建补丁
      const personaFolderName = this.resolveDesiredPersonaFolderName(personaId);
      for (const change of detection.changes) {
        const patch = await this.personalityEvolution.createPatch(
          change,
          personaId,
          personaFolderName
        );

        if (patch) {
          // 自动应用补丁到角色卡
          await this.personalityEvolution.applyPatchToCharacter(patch, personaId);
          new Notice(`角色性格演进：${change.characterId} - ${change.toState}`);
        }
      }
    } catch (e) {
      logger.error("PersonalityEvolution", "性格演进检测失败", e);
    }
  }

  /**
   * 【新增】获取性格演进补丁文本（用于注入 Prompt）
   */
  public async getPersonalityPatchContext(personaId: string, characterId: string = "protagonist"): Promise<string> {
    try {
      const personaFolderName = this.resolveDesiredPersonaFolderName(personaId);
      return await this.personalityEvolution.getActivePatchesText(personaId, personaFolderName, characterId);
    } catch (e) {
      logger.error("PersonalityEvolution", "获取性格补丁失败", e);
      return "";
    }
  }

  /**
   * 获取角色扮演提取的系统提示词（简化版，更容易让模型遵循）
          const separator = updated.endsWith("\n") ? "\n" : "\n\n";
          updated += `${separator}${entity.fullContent}`;
          addedCount++;
        }
      }

      // 只有内容有变化时才写入
      if (updated !== existing) {
        await this.app.vault.modify(file, updated);
        const parts = [];
        if (addedCount > 0) parts.push(`新增${addedCount}项`);
        if (updatedCount > 0) parts.push(`更新${updatedCount}项`);
        new Notice(`${noticeText}：${parts.join('，')}`);
      }
    }
  }

  /**
   * 实时状态字段列表 — 这些字段总是用新值覆盖旧值
   * 因为它们反映的是"当前此刻"的状态，不是持久特征
   */
  private static readonly REALTIME_STATE_KEYS = new Set([
    '当前外观', '当前位置', '当前情绪', '当前状态',
    '对主角态度', '态度原因', '近期互动',
    '当前使用者', '唯一持有者', '状态',
    '当前烦恼', '待解决', '本次行动', '本次重要行动',
    '程度',
  ]);

  /**
   * 智能合并两个实体内容
   * 
   * 合并策略（按字段类型区分）：
   * 1. 实时状态字段 → 总是用新值覆盖旧值（位置、外观、情绪、态度等）
   * 2. 稳定特征字段 → 新值有实质内容时，取更长更详细的那个；如果新值语义不同则用新值
   * 3. 新增字段 → 直接添加
   */
  private mergeEntityContent(existingContent: string, newContent: string): string {
    const existingLines = existingContent.split('\n');
    const newLines = newContent.split('\n');
    
    const titleLine = existingLines.find(l => l.startsWith('### ')) || newLines.find(l => l.startsWith('### ')) || '';
    
    // 解析属性 → Map<归一化key, {line, value, isSubProp}>
    const parseProps = (lines: string[]) => {
      const props = new Map<string, { line: string; value: string; subLines: string[] }>();
      let lastKey = '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('- ')) {
          const colonIdx = trimmed.indexOf('：');
          if (colonIdx > 0) {
            const rawKey = trimmed.substring(2, colonIdx).replace(/[【】\*]/g, '').trim();
            const value = trimmed.substring(colonIdx + 1).trim();
            if (value && value !== '（待补充）') {
              props.set(rawKey, { line: trimmed, value, subLines: [] });
              lastKey = rawKey;
            }
          } else {
            props.set(trimmed, { line: trimmed, value: trimmed, subLines: [] });
            lastKey = trimmed;
          }
        } else if (trimmed.startsWith('- ') === false && !trimmed.startsWith('###') && trimmed.length > 0 && lastKey) {
          // 子属性行（如 "态度原因：xxx"）
          const existing = props.get(lastKey);
          if (existing) existing.subLines.push(trimmed);
        }
      }
      return props;
    };

    const existingProps = parseProps(existingLines);
    const newProps = parseProps(newLines);

    // 合并逻辑
    for (const [key, newEntry] of newProps) {
      const existingEntry = existingProps.get(key);
      
      if (!existingEntry) {
        // 全新属性 → 直接添加
        existingProps.set(key, newEntry);
        continue;
      }

      const isRealtimeField = MemoryManager.REALTIME_STATE_KEYS.has(key);

      if (isRealtimeField) {
        // 实时状态 → 总是用新值覆盖
        existingProps.set(key, newEntry);
      } else {
        // 稳定特征 → 智能比较
        const oldVal = existingEntry.value;
        const newVal = newEntry.value;
        
        // 如果新值和旧值语义明显不同（不是子集关系），用新值（角色可能发展了）
        const isSubset = oldVal.includes(newVal) || newVal.includes(oldVal);
        
        if (!isSubset) {
          // 完全不同的描述 → 用新值替换（反映角色发展/状态变化）
          existingProps.set(key, newEntry);
        } else if (newVal.length > oldVal.length) {
          // 新值更详细（且是旧值的超集） → 用新值
          existingProps.set(key, newEntry);
        }
        // 否则保留旧值（旧值更详细且包含新值）
      }
    }
    
    // 重建内容，保持有序
    const result = [titleLine];
    for (const [, entry] of existingProps) {
      if (entry.line && !entry.line.startsWith('###')) {
        result.push(entry.line);
        for (const sub of entry.subLines) {
          result.push(sub);
        }
      }
    }
    
    return result.join('\n') + '\n';
  }

  /**
   * 检查新内容是否包含旧内容没有的信息
   */
  private hasNewInfo(existingContent: string, newContent: string): boolean {
    const newLines = newContent.split('\n').filter(l => l.trim().startsWith('- '));
    for (const line of newLines) {
      const trimmed = line.trim();
      const colonIdx = trimmed.indexOf('：');
      if (colonIdx > 0) {
        const value = trimmed.substring(colonIdx + 1).trim();
        // 检查这个值是否在旧内容中出现
        if (value && value.length > 5 && !existingContent.includes(value)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * 从内容中解析实体列表
   */
  private parseEntitiesFromContent(content: string): Array<{name: string, fullContent: string}> {
    const entities: Array<{name: string, fullContent: string}> = [];
    // 匹配 ### 标题及其下方内容
    const regex = /^###\s+(.+?)(?:\n|$)([\s\S]*?)(?=^###\s|\n*$)/gm;
    let match;
    
    while ((match = regex.exec(content)) !== null) {
      const name = match[1].trim();
      const body = match[2];
      entities.push({
        name,
        fullContent: `### ${name}\n${body}`.trimEnd() + "\n"
      });
    }
    
    // 如果没匹配到，可能是单个实体
    if (entities.length === 0) {
      const singleMatch = content.match(/^###\s+(.+?)(?:\n|$)([\s\S]*)$/m);
      if (singleMatch) {
        entities.push({
          name: singleMatch[1].trim(),
          fullContent: content.trimEnd() + "\n"
        });
      }
    }
    
    return entities;
  }

  /**
   * 在现有内容中查找同名实体的位置
   */
  private findExistingEntity(content: string, entityName: string): {start: number, end: number} | null {
    // 转义特殊正则字符
    const escapedName = entityName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 匹配 ### 实体名 及其后续内容，直到下一个 ### 或文件结尾
    const regex = new RegExp(`(^###\\s+${escapedName}\\s*\\n)([\\s\\S]*?)(?=^###\\s|$)`, 'gm');
    const match = regex.exec(content);
    
    if (match) {
      return {
        start: match.index,
        end: match.index + match[0].length
      };
    }
    return null;
  }

  private async consolidateFacts(file: TFile) {
      const content = await this.app.vault.read(file);
      const consolidatePrompt = `你是用户画像管理员。请整理以下用户信息：

## 整理规则
1. **合并重复项**：相同含义的信息合并为一条（取更详细/更新的版本）
2. **解决冲突**：优先保留新信息，但要判断合理性
3. **严格清理可疑内容**：
   - 🔴 删除明显来自角色扮演/虚构故事的内容（如"我是国王"、"我有超能力"等虚构角色属性）
   - 🔴 删除一次性剧情事件（不是用户的持久特征）
   - 🔴 删除不合常理的"偏好"（可能是误提取的剧情行为，如特定性癖好、暴力倾向等）
   - 🟡 如果某条信息后面有"(待确认)"标记但无其他佐证，删除它
4. **按类别组织**：
   ## 个人信息
   ## 喜好偏好  
   ## 工作学习
   ## 交互偏好
   ## 社会关系

## 判断标准
- 如果某条信息像是"游戏/故事中角色的行为"而非"用户本人的特征" → 删除
- 如果某条信息过于具体且奇怪（如特定的性癖好、超能力） → 可能是误提取，删除
- 如果有括号中的置信理由如"(用户在正常对话中说明)"可以去掉括号保留核心信息
- 保留的应该是：稳定的、合理的、关于真实用户的信息

## 质量检查
整理完成后，对每一条信息自问：
- 这真的是用户本人的信息吗？（不是角色扮演中角色的）
- 这是持久的特征吗？（不是一时兴起的）
- 这条信息合情合理吗？（真实世界中说得通的）

输出整理后的Markdown格式。如果整理后没有有效信息，输出"# 用户画像\\n\\n暂无记录。"`;

      const prompt = [
          { role: 'system' as const, content: consolidatePrompt },
          { role: 'user' as const, content: content }
      ];
      
      try {
          const response = await this.plugin.llmService.getCompletion(prompt, this.getMemoryModel());
          const consolidated = response.content;
          if (consolidated) {
              await this.app.vault.modify(file, consolidated);
              new Notice("用户画像已自动整理优化。");
          }
      } catch (e) {
          logger.error("AI", "Fact consolidation failed", e);
      }
  }

  public async retrieveRelevantMemory(query: string, personaId: string, projectKey?: string): Promise<string> {
    if (!this.plugin.settings.enableMemory) return "";

    const basePath = this.getPersonaPath(personaId);
    const episodicRoots = this.getEpisodicRootsForRetrieval(personaId, projectKey);

    let context = "";
    
    // 1. 读取用户画像（支持中英文文件名）
    const profilePaths = [
      `${basePath}/Facts/用户画像.md`,
      `${basePath}/Facts/User_Profile.md`,
      ...this.getLegacyPersonaFolderPaths(personaId).map(p => `${p}/Facts/用户画像.md`),
      ...this.getLegacyPersonaFolderPaths(personaId).map(p => `${p}/Facts/User_Profile.md`),
    ];
    for (const profilePath of profilePaths) {
      const profileFile = this.app.vault.getAbstractFileByPath(profilePath);
      if (profileFile instanceof TFile) {
        const content = await this.app.vault.read(profileFile);
        context += `用户画像:\n${content}\n\n`;
        break;
      }
    }

    // 1.5 读取扮演类角色的世界观、势力、人物、物品、事件、关系（如果存在）
    // 从设置中获取信息隔离提示词，如果为空则使用默认值
    const isolationWarning = (this.plugin.settings.roleplayIsolationPrompt || DEFAULT_ROLEPLAY_ISOLATION_PROMPT);

    const roleplayBasePaths = [
      basePath,
      ...this.getLegacyPersonaFolderPaths(personaId),
    ].filter(Boolean);

    const roleplayFiles = roleplayBasePaths.flatMap(base => [
      { path: `${base}/Facts/角色知识库.md`, label: "【角色知识库】", priority: 1 },
      { path: `${base}/Facts/角色关系.md`, label: "【角色关系】 ⚠️ 这是最重要的！决定了角色间的行为模式", priority: 2 },
      { path: `${base}/Facts/出场人物.md`, label: "【出场人物】 每个角色的态度和状态", priority: 3 },
      { path: `${base}/Facts/主角画像.md`, label: "【主角画像】 ⚠️ 上帝视角记录，NPC不可直接知晓", priority: 4 },
      { path: `${base}/Facts/事件计划.md`, label: "【事件记录】 注意参与者限制", priority: 5 },
      { path: `${base}/Facts/重要物品.md`, label: "【重要物品】 注意持有者和使用者", priority: 6 },
      { path: `${base}/Facts/世界观.md`, label: "【世界观设定】", priority: 7 },
      { path: `${base}/Facts/势力组织.md`, label: "【势力组织】", priority: 8 },
    ]);
    
    let hasRoleplayContent = false;
    let roleplayContext = "";
    
    // 按优先级排序并按 path 去重
    roleplayFiles.sort((a, b) => a.priority - b.priority);
    const seenRoleplayPaths = new Set<string>();

    for (const rf of roleplayFiles) {
      if (seenRoleplayPaths.has(rf.path)) continue;
      seenRoleplayPaths.add(rf.path);
      const file = this.app.vault.getAbstractFileByPath(rf.path);
      if (file instanceof TFile) {
        let content = await this.app.vault.read(file);
        // 对于角色知识库，先过滤禁用章节，然后进行关键词动态激活
        if (rf.path.includes('角色知识库')) {
          content = this.filterDisabledSections(content);
          content = this.activateLorebookByKeywords(content, query);
        }
        const stripped = this.stripFrontmatter(content);
        if (stripped.length > 50) { // 只有内容足够多才加入上下文
          hasRoleplayContent = true;
          roleplayContext += `\n---\n${rf.label}\n${stripped}\n`;
        }
      }
    }
    
    // 只有存在角色扮演内容时才添加
    if (hasRoleplayContent) {
      // 世界记录数据块 — 不再重复注入规则（规则已在 systemPrompt 层统一注入）
      context += `\n\n========== 世界记录（上帝视角）==========`;
      context += roleplayContext;
      context += `\n---------- 记录结束 ----------\n`;
    }

    // 2. 向量搜索情景记忆
    let foundRelevantByVector = false;
    if (this.plugin.vectorIndexManager && query) {
        try {
            const queryVector = await this.plugin.llmService.getEmbedding(query);
            const results = await this.plugin.vectorIndexManager.search(queryVector, 10);
            
            // 筛选允许的情景记忆路径，过滤低相似度结果
            const MIN_SIMILARITY = 0.32;
            const relevantMemories = results
              .filter(r => episodicRoots.some(prefix => r.path.startsWith(prefix)))
              .filter(r => (typeof r.similarity === 'number' ? r.similarity : 0) >= MIN_SIMILARITY)
              .slice(0, 3);

            if (relevantMemories.length > 0) {
              foundRelevantByVector = true;
                context += "相关历史记忆:\n";
                for (const result of relevantMemories) {
                    const file = this.app.vault.getAbstractFileByPath(result.path);
                    if (file instanceof TFile) {
                        const content = await this.app.vault.read(file);
                        context += `- ${this.stripFrontmatter(content)}\n`;
                    }
                }
                context += "\n";
            }
        } catch (e) {
          logger.warn("Database", "Vector search for memory failed", e);
        }
    }

    // 2.5 关键词回退（向量搜索无结果时）
    if (!foundRelevantByVector && query) {
      const keywordHits = await this.keywordSearchEpisodic({
        episodicRoots,
        query,
        maxFiles: 30,
        maxResults: 2,
      });

      if (keywordHits.length > 0) {
        context += "关键词匹配记忆:\n";
        for (const hit of keywordHits) {
          context += `- ${hit.content}\n`;
        }
        context += "\n";
      }
    }

    // 3. 读取最近的情景记忆（回退）
    if (!foundRelevantByVector) {
      const recentCandidates: TFile[] = [];
      for (const root of episodicRoots) {
        const folder = this.app.vault.getAbstractFileByPath(root);
        if (folder instanceof TFolder) {
          recentCandidates.push(...this.listMarkdownFilesRecursive(folder));
        }
      }

      const files = recentCandidates
        .sort((a, b) => b.stat.ctime - a.stat.ctime)
        .slice(0, 1);

      if (files.length > 0) {
        const file = files[0];
        context += "最近记忆:\n";
        const content = await this.app.vault.read(file);
        context += `- ${this.stripFrontmatter(content)}\n`;
      }
    }

    return context;
  }
}
