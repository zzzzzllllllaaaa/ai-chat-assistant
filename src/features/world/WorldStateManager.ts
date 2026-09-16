/**
 * 世界状态管理器
 * 
 * 实现"活的世界"追踪，让沉浸式角色扮演的世界不再是静态背景板。
 * 
 * 核心功能：
 * 1. 每轮自动提取场景变化（extractSceneDelta）
 * 2. 将变化应用到世界状态（applyDelta）
 * 3. 构建世界上下文注入 prompt（buildWorldContext）
 * 4. 自动推进因果链和待生效后果
 */

import { App, TFile } from "obsidian";
import type { IPluginContext } from "../../core/plugin-context";;
import { ChatMessage } from "../../core/types";
import { logger } from "../../core/logger";
import {
  WorldState,
  SceneDelta,
  SceneState,
  TimelineEntry,
  PendingConsequence,
  StoryThread,
  OffstageAction,
  createEmptyWorldState,
} from "./types";

export class WorldStateManager {
  private app: App;
  private plugin: IPluginContext;
  private memoryBasePath: string;

  /** 内存中的世界状态缓存（按 personaId） */
  private stateCache = new Map<string, WorldState>();

  constructor(app: App, plugin: IPluginContext) {
    this.app = app;
    this.plugin = plugin;
    this.memoryBasePath = this.plugin.settings.memoryPath || "AI_Memory";
  }

  // ─────────────────────────────────────────────────────────────────
  // 工具方法
  // ─────────────────────────────────────────────────────────────────

  private getMemoryModel(): string {
    const settings = this.plugin.settings;
    return settings.memoryModel?.trim()
      || settings.routerModel?.trim()
      || settings.chatModels.split(',')[0]?.trim()
      || 'gpt-3.5-turbo';
  }

  private getPersonaFolderName(personaId: string): string {
    const persona = (this.plugin.settings.personas || []).find(p => p.id === personaId);
    const rawName = String(persona?.name || "").trim();
    const safeName = rawName.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().slice(0, 48);
    return safeName || personaId || "default";
  }

  private getWorldStatePath(personaId: string): string {
    const folderName = this.getPersonaFolderName(personaId);
    return `${this.memoryBasePath}/${folderName}/Facts/世界状态.json`;
  }

  private async ensureFolder(path: string) {
    const folder = this.app.vault.getAbstractFileByPath(path);
    if (!folder) {
      await this.app.vault.createFolder(path);
    }
  }

  private tryParseJson<T>(text: string): T | null {
    const trimmed = String(text || "").trim();
    if (!trimmed) return null;

    const withoutFences = trimmed
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    try {
      return JSON.parse(withoutFences) as T;
    } catch {
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // 状态持久化
  // ─────────────────────────────────────────────────────────────────

  /** 加载世界状态（优先用缓存） */
  public async loadState(personaId: string): Promise<WorldState> {
    // 返回缓存
    const cached = this.stateCache.get(personaId);
    if (cached) return cached;

    const filePath = this.getWorldStatePath(personaId);
    const file = this.app.vault.getAbstractFileByPath(filePath);

    if (file instanceof TFile) {
      try {
        const content = await this.app.vault.read(file);
        const parsed = this.tryParseJson<WorldState>(content);
        if (parsed && parsed.version) {
          this.stateCache.set(personaId, parsed);
          return parsed;
        }
      } catch (e) {
        logger.warn("AI", "[WorldState] Failed to load world state", e);
      }
    }

    // 不存在则创建空状态
    const empty = createEmptyWorldState();
    this.stateCache.set(personaId, empty);
    return empty;
  }

  /** 保存世界状态 */
  public async saveState(personaId: string, state: WorldState): Promise<void> {
    const filePath = this.getWorldStatePath(personaId);

    // 确保目录存在
    const folderName = this.getPersonaFolderName(personaId);
    await this.ensureFolder(`${this.memoryBasePath}/${folderName}`);
    await this.ensureFolder(`${this.memoryBasePath}/${folderName}/Facts`);

    const content = JSON.stringify(state, null, 2);

    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (file instanceof TFile) {
      await this.app.vault.modify(file, content);
    } else {
      await this.app.vault.create(filePath, content);
    }

    this.stateCache.set(personaId, state);
  }

  // ─────────────────────────────────────────────────────────────────
  // 场景变化提取
  // ─────────────────────────────────────────────────────────────────

  /**
   * 从最新对话中提取场景变化
   * @param history 对话历史
   * @param personaId 角色ID
   * @returns 场景增量变化
   */
  public async extractSceneDelta(
    history: ChatMessage[],
    personaId: string
  ): Promise<SceneDelta | null> {
    if (!this.plugin.settings.enableMemory) return null;

    // 只取最近几轮对话
    const recentHistory = history
      .filter(msg => msg.role === 'user' || msg.role === 'assistant')
      .slice(-6);

    if (recentHistory.length < 2) return null;

    const conversationText = recentHistory
      .map(msg => `${msg.role === 'user' ? '【玩家】' : '【角色】'}: ${msg.content}`)
      .join("\n\n");

    // 获取当前世界状态作为参考
    const currentState = await this.loadState(personaId);
    const currentSceneJson = JSON.stringify(currentState.scene, null, 2);

    const prompt: ChatMessage[] = [
      {
        role: 'system',
        content: `你是一个世界状态追踪助手。请分析最新对话，提取场景的变化。

【当前世界状态】
\`\`\`json
${currentSceneJson}
\`\`\`

【核心风格约束 - 必须遵守】
- 使用“白描/冰山”记录法：只记录**可观察到的事实、动作、对话结果、环境变化**
- 不要直接替角色下心理结论，不要写“其实/内心/心里/动摇/爱慕/暧昧/羞愤/失衡”等解释性判断，除非角色明确说出口
- atmosphere 只写场面的外在气质与可感知氛围，如“空气发紧、洞内寂静、说话声压低、门关得很重”，避免抽象情绪总结
- sensoryDetails 只写可见/可听/可触/可闻的细节，不写心理推断
- eventSummary / eventConsequences / threadUpdates / offstageActions 只写已经发生或可以直接推出的事实后果，不要替读者总结隐含情感
- 如果某种情绪只能通过动作看出来，就写动作本身，不要解释成心理标签

【任务】
分析对话内容，提取以下变化（只输出有变化的字段）：

1. **场景变化**（sceneChanges）：
   - location: 主位置变化
   - subLocation: 子位置变化（如从客厅移动到卧室）
   - timeOfDay: 时间变化（黄昏→入夜等）
   - weather: 天气变化
   - atmosphere: 场面外在气质/紧张度/安静度等可感知变化
   - lighting: 光线变化
   - sensoryDetails: 新的感官细节（覆盖旧列表）
   - ongoingActivity: 正在进行的活动

2. **角色进出**：
   - entered: 新进入场景的角色名数组
   - exited: 离开场景的角色名数组

3. **事件记录**：
   - eventSummary: 本轮发生了什么事（一句话概括，只写事实）
   - eventConsequences: 这件事的直接后果（只写已落地结果）

4. **延迟后果**（newConsequences）：
   - 如果本轮事件会在未来产生后果，记录下来
   - 每项包含 trigger（触发条件）、effect（效果）、priority

5. **故事线更新**（threadUpdates）：
   - 如果有故事线状态变化，记录下来
   - 每项包含 name、status（active/dormant/resolved）、description、nextBeat
   - description / nextBeat 只写局势推进，不写心理分析

6. **幕外动态**（offstageActions）：
   - 不在场景中的重要NPC可能在做什么（合理推测，但必须贴近已知事实）
   - 每项包含 entity、action、location、relevance

7. **时间推进**（timeAdvance）：
   - 如果剧情时间有推进，记录（如"过了半小时"、"到了第二天"）

【输出格式】
只输出 JSON，不要解释。只包含有变化的字段，没变化的不要输出。
\`\`\`json
{
  "sceneChanges": { ... },
  "entered": [...],
  "exited": [...],
  "eventSummary": "...",
  "eventConsequences": "...",
  "newConsequences": [...],
  "threadUpdates": [...],
  "offstageActions": [...],
  "timeAdvance": "..."
}
\`\`\``,
      },
      {
        role: 'user',
        content: `【最新对话】\n${conversationText}\n\n请提取场景变化。`,
      },
    ];

    try {
      const response = await this.plugin.llmService.getCompletion(
        prompt,
        this.getMemoryModel()
      );

      const delta = this.tryParseJson<SceneDelta>(response.content || "");
      if (delta) {
        logger.debug("AI", "[WorldState] Extracted scene delta", delta);
        return delta;
      }
    } catch (e) {
      logger.error("AI", "[WorldState] Failed to extract scene delta", e);
    }

    return null;
  }

  // ─────────────────────────────────────────────────────────────────
  // 应用变化
  // ─────────────────────────────────────────────────────────────────

  /**
   * 将场景变化应用到世界状态
   */
  public applyDelta(state: WorldState, delta: SceneDelta): WorldState {
    const newState = { ...state };
    newState.currentTurn += 1;

    // 1. 应用场景变化
    if (delta.sceneChanges) {
      newState.scene = { ...newState.scene, ...delta.sceneChanges };
    }

    // 2. 处理角色进出
    if (delta.entered?.length) {
      const present = new Set(newState.scene.presentEntities);
      delta.entered.forEach(e => present.add(e));
      newState.scene.presentEntities = Array.from(present);
    }
    if (delta.exited?.length) {
      newState.scene.presentEntities = newState.scene.presentEntities.filter(
        e => !delta.exited!.includes(e)
      );
    }

    // 3. 记录事件到时间线
    if (delta.eventSummary) {
      const entry: TimelineEntry = {
        turn: newState.currentTurn,
        summary: delta.eventSummary,
        causedBy: delta.eventConsequences || '',
        consequences: delta.eventConsequences || '',
        affectedEntities: [
          ...(delta.entered || []),
          ...(delta.exited || []),
        ],
      };
      newState.timeline = [...newState.timeline, entry].slice(-50); // 保留最近50条
    }

    // 4. 添加新的延迟后果
    if (delta.newConsequences?.length) {
      for (const c of delta.newConsequences) {
        const pending: PendingConsequence = {
          id: `${newState.currentTurn}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          trigger: c.trigger,
          effect: c.effect,
          origin: delta.eventSummary || '',
          priority: c.priority,
          createdAtTurn: newState.currentTurn,
        };
        newState.pendingConsequences = [...newState.pendingConsequences, pending];
      }
    }

    // 5. 更新故事线
    if (delta.threadUpdates?.length) {
      const updatedThreads = [...newState.activeThreads];
      for (const update of delta.threadUpdates) {
        const existingIdx = updatedThreads.findIndex(t => t.name === update.name);
        if (existingIdx >= 0) {
          // 不可变更新，避免原地 Object.assign 引用 mutation
          updatedThreads[existingIdx] = {
            ...updatedThreads[existingIdx],
            ...update,
            lastUpdated: newState.currentTurn,
          };
        } else {
          updatedThreads.push({
            name: update.name,
            status: update.status || 'active',
            description: update.description || '',
            lastUpdated: newState.currentTurn,
            nextBeat: update.nextBeat || '',
          });
        }
      }
      newState.activeThreads = updatedThreads;
    }

    // 6. 更新幕外动态（增量合并：保留上一轮的未提及 NPC）
    if (delta.offstageActions?.length) {
      // B3: 以 entity 为 key 合并，新的覆盖旧的，旧的未提及的保留
      const merged = new Map<string, OffstageAction>();
      for (const hint of (newState.offstageHints || [])) {
        merged.set(hint.entity, hint);
      }
      for (const action of delta.offstageActions) {
        merged.set(action.entity, action);
      }
      // 移除已进入场景的角色
      if (delta.entered?.length) {
        for (const name of delta.entered) {
          merged.delete(name);
        }
      }
      newState.offstageHints = Array.from(merged.values());
    }

    // 7. A4: 处理时间推进
    if (delta.timeAdvance) {
      // 将时间推进信息记录到 timeline 作为时间节点
      const timeEntry: TimelineEntry = {
        turn: newState.currentTurn,
        summary: `⏰ 时间推进：${delta.timeAdvance}`,
        causedBy: '',
        consequences: '',
        affectedEntities: [],
      };
      newState.timeline = [...newState.timeline, timeEntry].slice(-50);
      
      // 如果 sceneChanges 没有更新 timeOfDay，尝试从 timeAdvance 推断
      if (!delta.sceneChanges?.timeOfDay && newState.scene.timeOfDay) {
        // 简单推断：如果 timeAdvance 包含时段关键词就更新
        const timeHints: Record<string, string> = {
          '清晨': '清晨', '早上': '清晨', '上午': '上午',
          '中午': '中午', '下午': '下午', '傍晚': '傍晚',
          '黄昏': '黄昏', '入夜': '入夜', '夜晚': '夜晚',
          '深夜': '深夜', '凌晨': '凌晨', '第二天': '清晨',
          '次日': '清晨', '翌日': '清晨',
        };
        for (const [keyword, timeOfDay] of Object.entries(timeHints)) {
          if (delta.timeAdvance.includes(keyword)) {
            newState.scene = { ...newState.scene, timeOfDay };
            break;
          }
        }
      }
    }

    // 8. 将 LLM 提取的新因果节点写入 causalWeb（之前类型已定义但从未处理）
    if (delta.newCausalNodes?.length) {
      const existing = newState.causalWeb || [];
      const appended: import('./types').CausalNode[] = delta.newCausalNodes.map((n, i) => ({
        id: `${newState.currentTurn}-delta-${i}-${Date.now()}`,
        conditions: n.conditions,
        effect: n.effect,
        origin: delta.eventSummary || '',
        priority: n.priority,
        createdAtTurn: newState.currentTurn,
      }));
      newState.causalWeb = [...existing, ...appended];
    }

    return newState;
  }

  /**
   * 检查并触发到期的待生效后果
   * 返回本轮应该提示给AI的后果列表
   */
  public checkPendingConsequences(state: WorldState): {
    triggered: PendingConsequence[];
    remaining: PendingConsequence[];
  } {
    const triggered: PendingConsequence[] = [];
    const remaining: PendingConsequence[] = [];

    for (const c of state.pendingConsequences) {
      // 检查回合数触发
      if (c.turnsRemaining !== undefined) {
        if (c.turnsRemaining <= 0) {
          triggered.push(c);
        } else {
          remaining.push({ ...c, turnsRemaining: c.turnsRemaining - 1 });
        }
      } else {
        // 文本触发条件需要外部判断，暂时保留
        remaining.push(c);
      }
    }

    return { triggered, remaining };
  }

  // ─────────────────────────────────────────────────────────────────
  // 构建世界上下文
  // ─────────────────────────────────────────────────────────────────

  /**
   * 将世界状态格式化为注入 prompt 的文本
   */
  public buildWorldContext(state: WorldState): string {
    if (!state.scene.location && state.timeline.length === 0) {
      return ''; // 空状态不注入
    }

    const parts: string[] = [];

    // 场景状态
    if (state.scene.location) {
      parts.push(`【当前场景】`);
      parts.push(`- 位置：${state.scene.location}${state.scene.subLocation ? ` · ${state.scene.subLocation}` : ''}`);
      if (state.scene.timeOfDay) parts.push(`- 时间：${state.scene.timeOfDay}`);
      if (state.scene.weather) parts.push(`- 天气：${state.scene.weather}`);
      if (state.scene.atmosphere) parts.push(`- 氛围：${state.scene.atmosphere}`);
      if (state.scene.lighting) parts.push(`- 光线：${state.scene.lighting}`);
      if (state.scene.sensoryDetails?.length) {
        parts.push(`- 感官细节：${state.scene.sensoryDetails.join('；')}`);
      }
      if (state.scene.presentEntities?.length) {
        parts.push(`- 在场角色：${state.scene.presentEntities.join('、')}`);
      }
      if (state.scene.ongoingActivity) {
        parts.push(`- 正在进行：${state.scene.ongoingActivity}`);
      }
      parts.push('');
    }

    // 最近事件（最近5条）
    if (state.timeline.length > 0) {
      parts.push(`【近期事件】`);
      const recent = state.timeline.slice(-5);
      for (const e of recent) {
        parts.push(`- [回合${e.turn}] ${e.summary}`);
        if (e.consequences) parts.push(`  → 后果：${e.consequences}`);
      }
      parts.push('');
    }

    // 待生效后果
    const highPriorityConsequences = state.pendingConsequences.filter(c => c.priority === 'high');
    if (highPriorityConsequences.length > 0) {
      parts.push(`【待生效事件】⚠️ 一旦触发条件满足就会发生`);
      for (const c of highPriorityConsequences) {
        parts.push(`- 触发条件：${c.trigger}`);
        parts.push(`  效果：${c.effect}`);
      }
      parts.push('');
    }

    // 活跃故事线
    const activeThreads = state.activeThreads.filter(t => t.status === 'active');
    if (activeThreads.length > 0) {
      parts.push(`【活跃故事线】`);
      for (const t of activeThreads) {
        parts.push(`- ${t.name}：${t.description}`);
        if (t.nextBeat) parts.push(`  下一步：${t.nextBeat}`);
      }
      parts.push('');
    }

    // 幕外动态
    if (state.offstageHints?.length) {
      parts.push(`【幕外动态】不在场景中的角色正在做什么（可引用以增加世界真实感）`);
      for (const h of state.offstageHints) {
        parts.push(`- ${h.entity} 正在 ${h.location} ${h.action}（${h.relevance}）`);
      }
      parts.push('');
    }

    if (parts.length === 0) return '';

    return `\n\n========== 世界状态（实时追踪）==========\n${parts.join('\n')}========== 状态结束 ==========\n`;
  }

  /**
   * 完整的世界状态更新流程
   * 返回更新后的状态和触发的后果
   */
  public async updateWorldState(
    history: ChatMessage[],
    personaId: string
  ): Promise<{
    state: WorldState;
    triggeredConsequences: PendingConsequence[];
  }> {
    // 1. 加载当前状态
    let state = await this.loadState(personaId);

    // 2. 提取场景变化
    const delta = await this.extractSceneDelta(history, personaId);

    // 3. 应用变化
    if (delta) {
      state = this.applyDelta(state, delta);
    }

    // 4. 检查待生效后果
    const { triggered, remaining } = this.checkPendingConsequences(state);
    state.pendingConsequences = remaining;

    // 5. 保存状态
    await this.saveState(personaId, state);

    return { state, triggeredConsequences: triggered };
  }

  // ─────────────────────────────────────────────────────────────────
  // NPC 状态快照
  // ─────────────────────────────────────────────────────────────────

  /**
   * 为在场 NPC 构建即时状态快照
   * 从「出场人物.md」和「角色关系.md」提取与在场角色相关的最新信息
   * 无需额外 LLM 调用，零延迟
   */
  public async buildNpcSnapshot(personaId: string, state: WorldState): Promise<string> {
    const presentEntities = state.scene.presentEntities;
    if (!presentEntities || presentEntities.length === 0) return '';

    const basePath = this.memoryBasePath;
    const folderName = this.getPersonaFolderName(personaId);
    
    // 读取出场人物和角色关系文件
    const charactersPath = `${basePath}/${folderName}/Facts/出场人物.md`;
    const relationsPath = `${basePath}/${folderName}/Facts/角色关系.md`;
    
    let charactersContent = '';
    let relationsContent = '';
    
    const charsFile = this.app.vault.getAbstractFileByPath(charactersPath);
    if (charsFile instanceof TFile) {
      try { charactersContent = await this.app.vault.cachedRead(charsFile); } catch {}
    }
    
    const relsFile = this.app.vault.getAbstractFileByPath(relationsPath);
    if (relsFile instanceof TFile) {
      try { relationsContent = await this.app.vault.cachedRead(relsFile); } catch {}
    }
    
    if (!charactersContent && !relationsContent) return '';
    
    const parts: string[] = [];
    // 移除旧版分割线，统一由 unified context 管理
    // parts.push(`\n========== 在场角色状态快照 ==========`);
    
    for (const npcName of presentEntities) {
      // 从「出场人物.md」提取该 NPC 的最新章节
      const npcSection = this.extractLatestSection(charactersContent, npcName);
      // 从「角色关系.md」提取与该 NPC 相关的关系
      const npcRelations = this.extractRelationsFor(relationsContent, npcName);
      // 从近期 timeline 提取该 NPC 参与的事件（Timeline重复，已由 unified context 处理，此处跳过）
      // const recentEvents = state.timeline ...
      
      if (!npcSection && !npcRelations) continue;
      
      parts.push(`[设定] ${npcName}：${npcSection ? npcSection.slice(0, 100) + '...' : ''} ${npcRelations ? `(关系:${npcRelations})` : ''}`);
    }
    
    if (parts.length === 0) return '';
    
    // parts.push(`========== 快照结束 ==========`);
    return parts.join('\n');
  }
  
  /**
   * 从 Markdown 文件中提取某个角色的最新章节（### 标题匹配）
   */
  private extractLatestSection(content: string, name: string): string {
    if (!content || !name) return '';
    
    // 按 ### 标题分割，找到包含角色名的最后一个章节
    const sections = content.split(/^### /gm);
    let lastMatch = '';
    
    for (const section of sections) {
      if (section.includes(name)) {
        // 取前 500 字符避免过长
        lastMatch = section.trim().slice(0, 500);
      }
    }
    
    return lastMatch;
  }
  
  /**
   * 从角色关系文件中提取与某角色相关的关系描述
   */
  private extractRelationsFor(content: string, name: string): string {
    if (!content || !name) return '';
    
    const lines = content.split('\n');
    const relevant: string[] = [];
    
    for (const line of lines) {
      if (line.includes(name) && (line.includes('→') || line.includes('关系') || line.includes('态度'))) {
        relevant.push(line.trim());
      }
    }
    
    return relevant.slice(0, 3).join('；');
  }

  // ─────────────────────────────────────────────────────────────────
  // 叙事节拍引导
  // ─────────────────────────────────────────────────────────────────

  /**
   * 统一世界心智上下文（替代原 buildWorldContext + buildNarrativeBeat + 5 个引擎块的碎片化拼接）
   *
   * 合并：场景·时间线·线索·幕外·因果·NPC心智·导演·情感·钩子·空间
   * 去重：不再各自带标题，共用一个 section header，约节省 30-50% token
   */
  public buildUnifiedWorldContext(
    state: WorldState,
    opts: {
      psycheSnapshot?: string;
      fileBasedSnapshot?: string;
      hooksContext?: string;
      spatialContext?: string;
      historyLength?: number;
    } = {}
  ): string {
    if (!state.scene.location && state.timeline.length === 0) return '';

    const lines: string[] = [];

    // ── 场景（去掉感官细节/照明，它们已在角色系统提示里）──────────────
    if (state.scene.location) {
      const loc = [state.scene.location, state.scene.subLocation].filter(Boolean).join(' · ');
      const meta = [state.scene.timeOfDay, state.scene.weather, state.scene.atmosphere]
        .filter(Boolean).join(' / ');
      lines.push(`[场景] ${loc}${meta ? ' ｜ ' + meta : ''}`);
      if (state.scene.presentEntities?.length) {
        lines.push(`[在场] ${state.scene.presentEntities.join('、')}`);
      }
      if (state.scene.ongoingActivity) {
        lines.push(`[活动] ${state.scene.ongoingActivity}`);
      }
    }

    // ── 近期事件（最近3条，单行紧凑格式，去掉冗余箭头描述）────────────
    const realEvents = state.timeline.filter(e => !e.summary.startsWith('⏰')).slice(-3);
    if (realEvents.length > 0) {
      lines.push(`[近事] ${realEvents.map(e => `R${e.turn}:${e.summary}`).join(' ▶ ')}`);
    }

    // ── 活跃/沉睡故事线（精简）─────────────────────────────────────────
    const activeThreads = state.activeThreads.filter(t => t.status === 'active');
    const dormantThreads = state.activeThreads.filter(t => t.status === 'dormant');
    if (activeThreads.length > 0) {
      const str = activeThreads.slice(0, 3)
        .map(t => t.nextBeat ? `${t.name}→${t.nextBeat}` : t.name).join(' | ');
      lines.push(`[线索] ${str}`);
    }
    if (dormantThreads.length > 0) {
      lines.push(`[沉睡] ${dormantThreads.slice(0, 2).map(t => t.name).join('、')}（可适时提及）`);
    }

    // ── 幕外动态（精简）─────────────────────────────────────────────────
    if (state.offstageHints?.length) {
      const hints = state.offstageHints.slice(0, 2)
        .map(h => `${h.entity}:${h.action}@${h.location}`).join('；');
      lines.push(`[幕外] ${hints}`);
    }

    // ── 即将触发的高优先级因果节点（暗线提示）──────────────────────────
    const urgentNodes = (state.causalWeb || []).filter(n => !n.firedAtTurn && n.priority === 'high');
    if (urgentNodes.length > 0) {
      lines.push(`[暗线] ⚠ ${urgentNodes.slice(0, 2).map(n => n.effect).join('；')}`);
    }

    // ── NPC 静态设定（来自 Markdown 文件：外貌/背景/固定关系）──────────
    if (opts.fileBasedSnapshot) {
      lines.push(opts.fileBasedSnapshot.trim());
    }

    // ── NPC 心智（来自引擎：实时情绪/态度，去掉 buildNpcSnapshot 的 timeline 重复）──
    if (opts.psycheSnapshot) {
      lines.push(opts.psycheSnapshot.trim());
    }

    // ── 导演 + 情感光谱（合并为一行，去掉冗长标题）─────────────────────
    const d = state.director;
    if (d) {
      const phaseMap: Record<string, string> = {
        setup: '铺垫期', rising: '上升期', climax: '高潮期', falling: '下行期', resolution: '收束期',
      };
      const dirBrief = `叙事:${phaseMap[d.narrativePhase] || d.narrativePhase} 张力:${d.tensionLevel}/100`;
      const suggestion = state.emotionalSpectrum?.suggestion || '';
      lines.push(`[导演] ${dirBrief}${suggestion ? ' ｜ ' + suggestion : ''}`);
    }

    // ── 涌现钩子 ─────────────────────────────────────────────────────────
    if (opts.hooksContext) {
      lines.push(opts.hooksContext.trim());
    }

    // ── 空间（只有当存在邻接信息时才有实际价值）────────────────────────
    if (opts.spatialContext && opts.spatialContext.includes('邻接')) {
      lines.push(opts.spatialContext.trim());
    }

    // ── 叙事节拍（仅在明确异常时提示，去掉每轮都输出的"正常推进"废话）──
    const recentAll = state.timeline.filter(e => !e.summary.startsWith('⏰')).slice(-5);
    const density = recentAll.length;
    const histLen = opts.historyLength || 0;
    if (density >= 4) {
      lines.push(`[节拍] 连续高密度，这一轮适合放缓节奏。`);
    } else if (density <= 1 && histLen > 10) {
      lines.push(`[节拍] 已较长时间平静，可引入小变化。`);
    }

    if (lines.length === 0) return '';
    return `\n========== 世界心智 ==========\n${lines.join('\n')}\n==============================\n`;
  }

  /**
   * B1: 根据世界状态和对话阶段生成叙事节拍建议
   * 分析近期事件密度，自动调节叙事节奏
   * 无 LLM 调用，纯规则推理
   * @deprecated 请使用 buildUnifiedWorldContext() 代替
   */
  public buildNarrativeBeat(state: WorldState, historyLength: number): string {
    const parts: string[] = [];
    
    // 分析近期事件密度（最近 5 轮有多少重大事件）
    const recentEvents = state.timeline.slice(-5);
    const eventDensity = recentEvents.filter(e => !e.summary.startsWith('⏰')).length;
    
    // 检查是否有活跃的高优先级待生效后果
    const pendingHigh = state.pendingConsequences.filter(c => c.priority === 'high');
    const hasPendingDanger = pendingHigh.length > 0;
    
    // 检查活跃故事线状态
    const activeThreadCount = state.activeThreads.filter(t => t.status === 'active').length;
    const dormantThreads = state.activeThreads.filter(t => t.status === 'dormant');
    
    parts.push(`\n[叙事节拍建议]`);
    
    // 判断节奏建议
    if (eventDensity >= 4) {
      // 连续高密度事件 → 建议喘息
      parts.push(`节奏：连续 ${eventDensity} 轮密集事件后，这一轮适合放缓节奏。`);
      parts.push(`建议：用日常互动、环境描写、角色间闲聊来让读者喘息。展示角色在紧张事件后的反应和消化。`);
    } else if (eventDensity <= 1 && historyLength > 10) {
      // 长时间平静 → 建议引入变化
      parts.push(`节奏：已经平静了较长时间，可以考虑引入变化。`);
      parts.push(`建议：一个小意外、NPC突然提起的事、环境的异常细节——不必是大事件，但让世界感觉在动。`);
    } else {
      parts.push(`节奏：正常推进，根据主角行动自然回应。`);
    }
    
    // 高优先级后果即将触发的紧张感暗示
    if (hasPendingDanger) {
      parts.push(`暗流：有 ${pendingHigh.length} 个高优先级事件即将触发，可通过环境细节或NPC的不安暗示给读者。`);
    }
    
    // 沉睡故事线提醒
    if (dormantThreads.length > 0) {
      const dormantNames = dormantThreads.slice(0, 2).map(t => t.name).join('、');
      parts.push(`沉睡线索：「${dormantNames}」已沉寂一段时间，如有合适时机可适度提及。`);
    }
    
    // 幕外动态提醒
    if (state.offstageHints?.length > 0) {
      parts.push(`幕外：有 ${state.offstageHints.length} 个角色在幕外活动，可通过只言片语暗示他们的存在。`);
    }
    
    return parts.join('\n');
  }

  /**
   * 清除缓存（用于角色切换时）
   */
  public clearCache(personaId?: string) {
    if (personaId) {
      this.stateCache.delete(personaId);
    } else {
      this.stateCache.clear();
    }
  }
}
