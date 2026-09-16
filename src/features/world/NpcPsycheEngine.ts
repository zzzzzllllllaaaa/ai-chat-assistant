/**
 * NPC 心智引擎 (NPC Psyche Engine)
 *
 * 让每个重要 NPC 成为有内心世界的独立个体：
 * - 情绪状态（会衰减/变化）
 * - 目标（短期/长期/隐秘）
 * - 态度图（对每个角色的亲疏关系）
 * - 日程（每个时段在哪里做什么）
 * - 秘密（知道但不会主动说）
 * - 癖好（行为细节增加真实感）
 *
 * 设计原则：
 * 1. 回复前只做规则计算（情绪衰减、态度调整），零 LLM 调用
 * 2. 回复后异步用 LLM 更新心智状态
 * 3. NPC 心智注入 prompt 让角色有内在一致性
 */

import { App, TFile } from "obsidian";
import type { IPluginContext } from "../../core/plugin-context";;
import { ChatMessage } from "../../core/types";
import { logger } from "../../core/logger";
import { NpcPsyche, NpcEmotion, WorldState } from "./types";

export class NpcPsycheEngine {
  private app: App;
  private plugin: IPluginContext;
  private memoryBasePath: string;

  constructor(app: App, plugin: IPluginContext) {
    this.app = app;
    this.plugin = plugin;
    this.memoryBasePath = this.plugin.settings.memoryPath || "AI_Memory";
  }

  // ─────────────────────────────────────────────────────────────────
  // 公共 API（前置·零 LLM）
  // ─────────────────────────────────────────────────────────────────

  /**
   * 处理情绪自然衰减（每轮调用，纯计算）
   */
  public tickEmotionDecay(state: WorldState): WorldState {
    if (!state.npcPsyches) return state;

    const updated = { ...state.npcPsyches };
    for (const name of Object.keys(updated)) {
      const psyche = updated[name];
      if (psyche.emotion.intensity > 10) {
        // 情绪强度每轮自然衰减 5-10 点
        const decay = Math.min(10, Math.max(5, psyche.emotion.intensity * 0.1));
        updated[name] = {
          ...psyche,
          emotion: {
            ...psyche.emotion,
            intensity: Math.max(0, psyche.emotion.intensity - decay),
          },
        };
      }
    }

    return { ...state, npcPsyches: updated };
  }

  /**
   * 根据当前时段返回 NPC 按日程应该在哪里
   */
  public getNpcLocationBySchedule(psyche: NpcPsyche, timeOfDay: string): { location: string; activity: string } | null {
    if (!psyche.schedule || psyche.schedule.length === 0) return null;

    // 简单匹配：找到时段包含关键词的条目
    const timeNormalized = String(timeOfDay || '').toLowerCase();
    for (const entry of psyche.schedule) {
      const scheduleTime = String(entry.timeOfDay || '').toLowerCase();
      if (timeNormalized.includes(scheduleTime) || scheduleTime.includes(timeNormalized)) {
        return { location: entry.location, activity: entry.activity };
      }
    }

    // 无匹配则返回默认（第一条或无）
    return psyche.schedule.length > 0
      ? { location: psyche.schedule[0].location, activity: psyche.schedule[0].activity }
      : null;
  }

  /**
   * 构建在场 NPC 的心智快照注入 prompt
   */
  public buildPsycheSnapshot(state: WorldState): string {
    const presentEntities = state.scene.presentEntities || [];
    if (presentEntities.length === 0 || !state.npcPsyches) return '';

    const parts: string[] = [];
    parts.push(`\n[在场角色心智状态]`);

    for (const name of presentEntities) {
      const psyche = state.npcPsyches[name];
      if (!psyche) continue;

      const emotionText = psyche.emotion.intensity > 20
        ? `情绪：${psyche.emotion.primary}(${psyche.emotion.intensity}%) 因为${psyche.emotion.cause}`
        : '';
      const goalText = psyche.goals.short ? `当前关注：${psyche.goals.short}` : '';
      const quirkText = psyche.quirks?.length > 0 ? `习惯：${psyche.quirks.slice(0, 2).join('、')}` : '';

      // 态度：对主角和在场其他人
      const attitudeParts: string[] = [];
      for (const otherName of presentEntities) {
        if (otherName === name) continue;
        const att = psyche.attitudes[otherName];
        if (att !== undefined) {
          const label = att >= 50 ? '亲近' : att >= 0 ? '中立' : att >= -50 ? '疏远' : '敌对';
          attitudeParts.push(`对${otherName}:${label}`);
        }
      }
      // 对玩家态度
      const playerAtt = psyche.attitudes['{{user}}'] ?? psyche.attitudes['主角'];
      if (playerAtt !== undefined) {
        const label = playerAtt >= 50 ? '亲近' : playerAtt >= 0 ? '中立' : playerAtt >= -50 ? '疏远' : '敌对';
        attitudeParts.push(`对玩家:${label}(${playerAtt})`);
      }

      const snippets = [emotionText, goalText, quirkText, attitudeParts.join(' ')].filter(Boolean);
      if (snippets.length > 0) {
        parts.push(`• ${name} — ${snippets.join('；')}`);
      }
    }

    if (parts.length <= 1) return '';
    return parts.join('\n') + '\n';
  }

  // ─────────────────────────────────────────────────────────────────
  // 公共 API（后置·异步 LLM）
  // ─────────────────────────────────────────────────────────────────

  /**
   * 从对话中提取 NPC 心智变化并更新状态
   * 异步调用，不阻塞回复
   */
  public async updatePsychesFromDialogue(
    state: WorldState,
    recentHistory: ChatMessage[],
    personaId: string
  ): Promise<WorldState> {
    const presentEntities = state.scene.presentEntities || [];
    if (presentEntities.length === 0) return state;

    // 只取最近几轮
    const recent = recentHistory
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(-4);
    if (recent.length < 2) return state;

    const conversationText = recent
      .map(m => `${m.role === 'user' ? '【玩家】' : '【角色】'}: ${String(m.content || '').slice(0, 200)}`)
      .join('\n');

    const existingPsyches = state.npcPsyches || {};
    const npcsToAnalyze = presentEntities.filter(name => {
      // 只分析在场且有心智数据或出现在对话中的 NPC
      return existingPsyches[name] || conversationText.includes(name);
    });

    if (npcsToAnalyze.length === 0) return state;

    const prompt: ChatMessage[] = [
      {
        role: 'system',
        content: `你是 NPC 心理分析师。分析最新对话，判断在场 NPC 的心智状态变化。

【在场 NPC】${npcsToAnalyze.join('、')}

【任务】
对每个 NPC，分析：
1. 情绪变化（primary: 当前主要情绪, intensity: 0-100, cause: 原因）
2. 对其他角色态度变化（attitudes: { "角色名": 变化量 -30~+30 }）
3. 短期目标变化（shortGoal: 变化后的短期目标，无变化则省略）

【输出格式】
只输出 JSON，格式：
\`\`\`json
{
  "NPC名": {
    "emotion": { "primary": "...", "intensity": 50, "cause": "..." },
    "attitudeChanges": { "角色名": +10 },
    "shortGoal": "..."
  }
}
\`\`\`
如果某 NPC 无明显变化，可以不输出该 NPC。`,
      },
      {
        role: 'user',
        content: `【最近对话】\n${conversationText}\n\n请分析 NPC 心智变化。`,
      },
    ];

    try {
      const response = await this.plugin.llmService.getCompletion(
        prompt,
        this.getMemoryModel()
      );

      const changes = this.parseJson<Record<string, any>>(response.content || '');
      if (!changes) return state;

      const updatedPsyches = { ...existingPsyches };

      for (const [name, delta] of Object.entries(changes)) {
        const existing = updatedPsyches[name] || this.createDefaultPsyche(name);

        // 更新情绪
        if (delta.emotion) {
          existing.emotion = {
            primary: delta.emotion.primary || existing.emotion.primary,
            intensity: Math.max(0, Math.min(100, delta.emotion.intensity ?? existing.emotion.intensity)),
            cause: delta.emotion.cause || existing.emotion.cause,
          };
        }

        // 更新态度
        if (delta.attitudeChanges) {
          for (const [target, change] of Object.entries(delta.attitudeChanges)) {
            const current = existing.attitudes[target] ?? 0;
            existing.attitudes[target] = Math.max(-100, Math.min(100, current + Number(change)));
          }
        }

        // 更新短期目标
        if (delta.shortGoal) {
          existing.goals.short = delta.shortGoal;
        }

        existing.lastUpdated = state.currentTurn;
        updatedPsyches[name] = existing;
      }

      logger.debug("AI", "[NpcPsyche] Updated psyches", Object.keys(changes));
      return { ...state, npcPsyches: updatedPsyches };
    } catch (e) {
      logger.warn("AI", "[NpcPsyche] Failed to update psyches", e);
      return state;
    }
  }

  /**
   * 从出场人物.md 初始化 NPC 心智（首次检测到新 NPC 时调用）
   */
  public async initializePsycheFromMemory(name: string, personaId: string): Promise<NpcPsyche> {
    const basePath = this.getPersonaPath(personaId);
    const charactersPath = `${basePath}/Facts/出场人物.md`;

    let characterInfo = '';
    const file = this.app.vault.getAbstractFileByPath(charactersPath);
    if (file instanceof TFile) {
      try {
        const content = await this.app.vault.cachedRead(file);
        // 提取该角色的章节
        const sections = content.split(/^### /gm);
        for (const section of sections) {
          if (section.includes(name)) {
            characterInfo = section.slice(0, 500);
            break;
          }
        }
      } catch {}
    }

    if (!characterInfo) {
      return this.createDefaultPsyche(name);
    }

    // 用 LLM 从角色描述提取初始心智
    const prompt: ChatMessage[] = [
      {
        role: 'system',
        content: `你是角色心理分析师。根据角色描述，推断其初始心智状态。

【输出格式】JSON：
\`\`\`json
{
  "emotion": { "primary": "平静", "intensity": 30, "cause": "日常状态" },
  "goals": { "short": "...", "long": "...", "secret": "..." },
  "quirks": ["行为癖好1", "行为癖好2"],
  "schedule": [{ "timeOfDay": "早晨", "location": "...", "activity": "..." }]
}
\`\`\`
根据角色身份合理推断，没有明确信息的字段可省略。`,
      },
      {
        role: 'user',
        content: `【角色信息】\n${characterInfo}\n\n请推断「${name}」的初始心智状态。`,
      },
    ];

    try {
      const response = await this.plugin.llmService.getCompletion(prompt, this.getMemoryModel());
      const data = this.parseJson<any>(response.content || '');
      if (data) {
        return {
          name,
          emotion: data.emotion || { primary: '平静', intensity: 30, cause: '日常状态' },
          goals: data.goals || { short: '', long: '' },
          attitudes: {},
          schedule: data.schedule || [],
          secrets: data.secrets || [],
          quirks: data.quirks || [],
          lastUpdated: 0,
        };
      }
    } catch (e) {
      logger.warn("AI", `[NpcPsyche] Failed to initialize psyche for ${name}`, e);
    }

    return this.createDefaultPsyche(name);
  }

  // ─────────────────────────────────────────────────────────────────
  // 内部工具
  // ─────────────────────────────────────────────────────────────────

  private getMemoryModel(): string {
    const settings = this.plugin.settings;
    return settings.memoryModel?.trim()
      || settings.routerModel?.trim()
      || settings.chatModels.split(',')[0]?.trim()
      || 'gpt-3.5-turbo';
  }

  private getPersonaPath(personaId: string): string {
    const persona = (this.plugin.settings.personas || []).find(p => p.id === personaId);
    const rawName = String(persona?.name || "").trim();
    const safeName = rawName.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().slice(0, 48);
    const folderName = safeName || personaId || "default";
    return `${this.memoryBasePath}/${folderName}`;
  }

  private createDefaultPsyche(name: string): NpcPsyche {
    return {
      name,
      emotion: { primary: '平静', intensity: 30, cause: '日常状态' },
      goals: { short: '', long: '' },
      attitudes: {},
      schedule: [],
      secrets: [],
      quirks: [],
      lastUpdated: 0,
    };
  }

  private parseJson<T>(raw: string): T | null {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return null;

    const withoutFences = trimmed
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();

    try {
      return JSON.parse(withoutFences) as T;
    } catch {
      return null;
    }
  }
}
