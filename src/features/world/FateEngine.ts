/**
 * 天道系统 (Fate Engine)
 *
 * 独立 AI 模型充当世界的「天道」，定期为角色扮演世界注入随机事件，
 * 让世界具备自主演化能力，不再只围绕玩家转动。
 *
 * 设计原则：
 * 1. 异步执行，绝不阻塞用户回复
 * 2. 只写入 WorldState，不直接修改对话
 * 3. 主模型在下一轮自然融入天道事件
 * 4. 可选不同模型（便宜/快速的模型即可）
 */

import { App } from "obsidian";
import type { IPluginContext } from "../../core/plugin-context";;
import { ChatMessage } from "../../core/types";
import { logger } from "../../core/logger";
import {
  WorldState,
  FateEvent,
  FateIntensity,
} from "./types";
import { WorldStateManager } from "./WorldStateManager";

export class FateEngine {
  private app: App;
  private plugin: IPluginContext;
  private worldStateManager: WorldStateManager;

  constructor(app: App, plugin: IPluginContext, worldStateManager: WorldStateManager) {
    this.app = app;
    this.plugin = plugin;
    this.worldStateManager = worldStateManager;
  }

  // ─────────────────────────────────────────────────────────────────
  // 公共 API
  // ─────────────────────────────────────────────────────────────────

  /**
   * 判断本轮是否应该触发天道
   */
  public shouldTrigger(turn: number): boolean {
    if (!this.plugin.settings.enableFateSystem) return false;
    const freq = this.plugin.settings.fateFrequency || 3;
    // 至少第 2 轮后才触发，且按频率间隔
    return turn >= 2 && turn % freq === 0;
  }

  /**
   * 生成天道事件并写入世界状态
   * 异步调用，不阻塞主流程
   */
  public async generateFateEvents(
    personaId: string,
    recentHistory: ChatMessage[]
  ): Promise<FateEvent[]> {
    try {
      const state = await this.worldStateManager.loadState(personaId);
      const intensity = this.plugin.settings.fateIntensity || 'moderate';

      const events = await this.callFateModel(state, intensity, recentHistory);
      if (!events || events.length === 0) return [];

      // 写入世界状态
      state.fateEvents = [...(state.fateEvents || []), ...events];
      await this.worldStateManager.saveState(personaId, state);

      logger.info("AI", `[Fate] Generated ${events.length} fate event(s)`, events.map(e => e.summary));
      return events;
    } catch (e) {
      logger.warn("AI", "[Fate] Failed to generate fate events", e);
      return [];
    }
  }

  /**
   * 将待注入的天道事件格式化为 prompt 文本，并清空已消费的事件
   */
  public async consumeFateEvents(personaId: string): Promise<string> {
    const state = await this.worldStateManager.loadState(personaId);
    const events = state.fateEvents;
    if (!events || events.length === 0) return '';

    // 格式化
    const parts: string[] = [];
    parts.push(`\n[天道 — 世界自行演化的事件，请自然融入叙事]`);

    for (const evt of events) {
      const kindLabel = this.kindLabel(evt.kind);
      const deliveryHint = evt.delivery === 'rumor' ? '（建议由 NPC 转述/暗示）'
        : evt.delivery === 'environmental' ? '（建议通过环境细节呈现）'
        : '';
      parts.push(`• ${kindLabel} ${evt.summary}${deliveryHint}`);
      if (evt.impact) {
        parts.push(`  影响：${evt.impact}`);
      }
    }

    parts.push(`注意：以上事件由天道系统生成，请在回复中以自然方式呈现（如环境描写、NPC 对话、感官细节等），不要机械列举。如果某事件与当前场景不契合，可以作为背景传闻处理。\n`);

    // 清空已消费的事件
    state.fateEvents = [];
    await this.worldStateManager.saveState(personaId, state);

    return parts.join('\n');
  }

  // ─────────────────────────────────────────────────────────────────
  // 内部实现
  // ─────────────────────────────────────────────────────────────────

  private getFateModel(): string {
    const settings = this.plugin.settings;
    return settings.fateModel?.trim()
      || settings.memoryModel?.trim()
      || settings.routerModel?.trim()
      || settings.chatModels.split(',')[0]?.trim()
      || 'gpt-3.5-turbo';
  }

  private kindLabel(kind: string): string {
    const labels: Record<string, string> = {
      celestial: '🌤 天象',
      npc_autonomy: '🎭 人事',
      encounter: '✨ 机缘',
      complication: '⚡ 变故',
      undercurrent: '🌊 暗流',
    };
    return labels[kind] || '📌 事件';
  }

  private async callFateModel(
    state: WorldState,
    intensity: FateIntensity,
    recentHistory: ChatMessage[]
  ): Promise<FateEvent[]> {
    // 构建上下文摘要（给天道 AI 的信息，不含玩家私人意图）
    const sceneSummary = this.buildSceneSummary(state);
    const historySummary = this.buildHistorySummary(recentHistory);
    const intensityGuide = this.getIntensityGuide(intensity);

    const prompt: ChatMessage[] = [
      {
        role: 'system',
        content: `你是这个世界的「天道」——超越所有角色之上的命运之力。你不偏向任何人，只负责让世界自然运转、充满变化。

你的职责：
1. 根据当前世界状态，生成 1-2 个自然发生的事件
2. 这些事件不是为了配合主角，而是世界本身的运转
3. 事件可以是好运、坏运、中性的——一切取决于世界的逻辑

${intensityGuide}

【当前世界状态摘要】
${sceneSummary}

【最近发生的事】
${historySummary}

【输出要求】
输出 JSON 数组，每个事件包含：
- kind: 事件类型，取值 "celestial"(天象) / "npc_autonomy"(人事) / "encounter"(机缘) / "complication"(变故) / "undercurrent"(暗流)
- summary: 一句话描述（50字以内）
- impact: 这对当前情况的潜在影响（30字以内）
- entities: 涉及的人名/地名/组织名数组
- delivery: 建议呈现方式 "direct"(直接发生) / "rumor"(NPC转述) / "environmental"(环境暗示)

规则：
- 生成 1-2 个事件，不要超过 2 个
- 不要重复最近已发生的事件
- 不要替玩家做决定
- 事件要具体、有画面感，避免空泛
- 只输出 JSON 数组，不要解释

\`\`\`json
[{ "kind": "...", "summary": "...", "impact": "...", "entities": [...], "delivery": "..." }]
\`\`\``,
      },
      {
        role: 'user',
        content: '请根据当前世界状态，以天道视角生成世界事件。',
      },
    ];

    const response = await this.plugin.llmService.getCompletion(
      prompt,
      this.getFateModel()
    );

    return this.parseFateEvents(response.content || "");
  }

  private buildSceneSummary(state: WorldState): string {
    const parts: string[] = [];

    if (state.scene.location) {
      parts.push(`位置: ${state.scene.location}${state.scene.subLocation ? `·${state.scene.subLocation}` : ''}`);
      if (state.scene.timeOfDay) parts.push(`时间: ${state.scene.timeOfDay}`);
      if (state.scene.weather) parts.push(`天气: ${state.scene.weather}`);
      if (state.scene.atmosphere) parts.push(`氛围: ${state.scene.atmosphere}`);
      if (state.scene.presentEntities?.length) {
        parts.push(`在场: ${state.scene.presentEntities.join('、')}`);
      }
    }

    // 最近时间线事件
    if (state.timeline.length > 0) {
      const recent = state.timeline.slice(-3);
      parts.push(`近期事件: ${recent.map(e => e.summary).join('；')}`);
    }

    // 活跃故事线
    const active = state.activeThreads.filter(t => t.status === 'active');
    if (active.length > 0) {
      parts.push(`活跃线索: ${active.map(t => `${t.name}(${t.description})`).join('；')}`);
    }

    // 幕外动态
    if (state.offstageHints?.length > 0) {
      parts.push(`幕外: ${state.offstageHints.map(h => `${h.entity}在${h.location}${h.action}`).join('；')}`);
    }

    return parts.join('\n') || '（世界状态为空，这是故事的开端）';
  }

  private buildHistorySummary(history: ChatMessage[]): string {
    const recent = history
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(-4);

    if (recent.length === 0) return '（无最近对话）';

    return recent.map(m => {
      const role = m.role === 'user' ? '玩家' : '角色';
      // 截取前 100 字符
      const content = String(m.content || '').slice(0, 100);
      return `${role}: ${content}${(m.content?.length || 0) > 100 ? '...' : ''}`;
    }).join('\n');
  }

  private getIntensityGuide(intensity: FateIntensity): string {
    switch (intensity) {
      case 'gentle':
        return `【强度：平和】
生成日常小事：天气微变、路人的闲言碎语、小动物出没、集市上的新鲜事。
避免：重大危机、突发灾难、角色死亡。
风格：如微风拂面，让世界有呼吸感。`;

      case 'moderate':
        return `【强度：适度】
生成有趣的变化：NPC 自发行动、意外访客、市场价格波动、远方传来的消息、小摩擦。
可以有小麻烦，但不至于天翻地覆。
风格：恰到好处的新鲜感，像翻开书的下一页。`;

      case 'dramatic':
        return `【强度：剧烈】
允许重大变故：政变风声、自然灾害、势力冲突、重要人物突然行动、意料之外的危机或机遇。
可以有强烈的命运感和戏剧性转折。
风格：命运弄人，世界不会等待任何人。`;
    }
  }

  private parseFateEvents(raw: string): FateEvent[] {
    const trimmed = String(raw || "").trim();
    if (!trimmed) return [];

    const withoutFences = trimmed
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    try {
      const parsed = JSON.parse(withoutFences);
      if (!Array.isArray(parsed)) return [];

      // 校验并规范化
      return parsed
        .filter(e => e && e.kind && e.summary)
        .slice(0, 2) // 最多 2 个
        .map(e => ({
          kind: String(e.kind) as FateEvent['kind'],
          summary: String(e.summary).slice(0, 100),
          impact: String(e.impact || '').slice(0, 80),
          entities: Array.isArray(e.entities) ? e.entities.map(String).slice(0, 5) : [],
          delivery: (['direct', 'rumor', 'environmental'].includes(e.delivery) ? e.delivery : 'direct') as FateEvent['delivery'],
        }));
    } catch {
      logger.warn("AI", "[Fate] Failed to parse fate events", raw.slice(0, 200));
      return [];
    }
  }
}
