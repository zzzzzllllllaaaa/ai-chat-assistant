/**
 * 导演系统 (Director)
 *
 * 负责全局叙事节奏控制：
 * - 维护叙事阶段（setup/rising/climax/falling/resolution）
 * - 控制张力曲线和能量预算
 * - 决策何时触发天道事件、触发何种强度
 * - 给主模型提供节奏建议
 */

import { WorldState, DirectorState, NarrativePhase, FateIntensity, EmotionalEntry } from "./types";

export interface DirectorDecision {
  shouldTriggerFate: boolean;
  recommendedIntensity: FateIntensity;
  reason: string;
}

export class Director {
  // ─────────────────────────────────────────────────────────────────
  // 生命周期
  // ─────────────────────────────────────────────────────────────────

  public ensureState(state: WorldState): WorldState {
    if (state.director) return state;

    return {
      ...state,
      director: {
        narrativePhase: 'setup',
        tensionLevel: 20,
        recentTones: [],
        energyBudget: 100,
        pendingSetups: [],
        arcProgress: {},
        lastFateTurn: 0,
      },
    };
  }

  /**
   * 每轮更新导演状态
   */
  public tick(state: WorldState): WorldState {
    const withDirector = this.ensureState(state);
    const director = withDirector.director!;

    const next = { ...director };

    // 1) 根据近期事件更新张力
    next.tensionLevel = this.estimateTension(withDirector);

    // 2) 根据 turn 和线索状态推断叙事阶段
    next.narrativePhase = this.inferPhase(withDirector, next.tensionLevel);

    // 3) 能量预算：每轮自然回复
    next.energyBudget = Math.min(100, next.energyBudget + 8);

    // 4) 维护 recentTones（最多 8 条）
    const tone = this.inferTone(withDirector);
    next.recentTones = [...(next.recentTones || []), tone].slice(-8);

    return {
      ...withDirector,
      director: next,
    };
  }

  /**
   * 根据当前状态决策是否触发天道
   */
  public decideFateTrigger(state: WorldState, frequency: number): DirectorDecision {
    const withDirector = this.ensureState(state);
    const director = withDirector.director!;

    const turn = withDirector.currentTurn;
    const turnsSinceLastFate = turn - (director.lastFateTurn || 0);

    // 基础条件：达到频率窗口
    const frequencyGate = turnsSinceLastFate >= Math.max(1, frequency);

    // 叙事状态因素
    const tension = director.tensionLevel;
    const phase = director.narrativePhase;
    const hasPendingHigh = withDirector.pendingConsequences.some(c => c.priority === 'high');

    // 触发概率逻辑（确定性规则 + 阈值）
    // - 平淡太久（低张力）→ 触发变化
    // - 高张力且能量足够 → 可触发强事件
    // - resolution 阶段降低触发频率
    let shouldTrigger = false;

    if (!frequencyGate) {
      shouldTrigger = false;
    } else if (phase === 'resolution') {
      shouldTrigger = tension < 35; // 收束期仅在过于平淡时小触发
    } else if (tension < 35) {
      shouldTrigger = true; // 缺乏变化，补充事件
    } else if (tension > 75) {
      shouldTrigger = director.energyBudget >= 30; // 高张力阶段允许触发，但受预算限制
    } else {
      shouldTrigger = hasPendingHigh ? false : true; // 中间区间默认触发，但避免叠加过多高危后果
    }

    // 推荐强度
    let recommendedIntensity: FateIntensity = 'moderate';
    if (phase === 'setup' || tension < 30) recommendedIntensity = 'gentle';
    if (phase === 'rising' && tension >= 45) recommendedIntensity = 'moderate';
    if (phase === 'climax' && director.energyBudget >= 45) recommendedIntensity = 'dramatic';
    if (phase === 'falling') recommendedIntensity = tension > 65 ? 'moderate' : 'gentle';
    if (phase === 'resolution') recommendedIntensity = 'gentle';

    const reason = `phase=${phase}, tension=${tension}, energy=${director.energyBudget}, sinceLastFate=${turnsSinceLastFate}`;

    return { shouldTriggerFate: shouldTrigger, recommendedIntensity, reason };
  }

  /**
   * 记录一次天道触发，扣除能量预算
   */
  public recordFateTriggered(state: WorldState, intensity: FateIntensity): WorldState {
    const withDirector = this.ensureState(state);
    const director = withDirector.director!;

    const cost = intensity === 'dramatic' ? 40 : intensity === 'moderate' ? 24 : 12;

    return {
      ...withDirector,
      director: {
        ...director,
        lastFateTurn: withDirector.currentTurn,
        energyBudget: Math.max(0, director.energyBudget - cost),
      },
    };
  }

  /**
   * 为 prompt 提供导演建议
   */
  public buildDirectorGuidance(state: WorldState): string {
    const director = this.ensureState(state).director!;
    const parts: string[] = [];

    parts.push(`\n[导演节奏指令]`);
    parts.push(`阶段：${director.narrativePhase}`);
    parts.push(`张力：${director.tensionLevel}/100`);

    if (director.narrativePhase === 'setup') {
      parts.push(`建议：多铺设细节与关系，不急于爆发冲突。`);
    } else if (director.narrativePhase === 'rising') {
      parts.push(`建议：让冲突持续升温，抬高 stakes。`);
    } else if (director.narrativePhase === 'climax') {
      parts.push(`建议：推进关键抉择与对抗，避免岔开主线。`);
    } else if (director.narrativePhase === 'falling') {
      parts.push(`建议：处理余波与代价，给角色消化空间。`);
    } else {
      parts.push(`建议：收束已铺垫线索，给阶段性结论。`);
    }

    const toneTail = (director.recentTones || []).slice(-3);
    if (toneTail.length > 0) {
      parts.push(`近期情绪：${toneTail.join(' → ')}`);
    }

    return parts.join('\n') + '\n';
  }

  // ─────────────────────────────────────────────────────────────────
  // 内部算法
  // ─────────────────────────────────────────────────────────────────

  private estimateTension(state: WorldState): number {
    const recent = state.timeline.slice(-5);

    let score = 20;

    // 事件密度
    score += Math.min(30, recent.length * 6);

    // 高优先级后果
    const highPending = state.pendingConsequences.filter(c => c.priority === 'high').length;
    score += Math.min(20, highPending * 8);

    // 活跃故事线数量
    const activeThreads = state.activeThreads.filter(t => t.status === 'active').length;
    score += Math.min(20, activeThreads * 4);

    // 幕外动态越多，潜在张力越高
    score += Math.min(10, (state.offstageHints?.length || 0) * 2);

    // 事件关键词加权（粗糙但有效）
    const text = recent.map(e => e.summary).join(' ');
    if (/(危机|追杀|死亡|爆炸|失控|战争|背叛|重伤|崩塌|追捕|谋杀|政变)/.test(text)) score += 20;
    if (/(日常|闲聊|休息|吃饭|散步|平静|安宁|温暖)/.test(text)) score -= 10;

    return Math.max(0, Math.min(100, score));
  }

  private inferPhase(state: WorldState, tension: number): NarrativePhase {
    const turn = state.currentTurn;
    const resolvedCount = state.activeThreads.filter(t => t.status === 'resolved').length;
    const activeCount = state.activeThreads.filter(t => t.status === 'active').length;

    if (turn <= 4) return 'setup';
    if (tension >= 78) return 'climax';
    if (tension >= 45) return 'rising';

    // 若已有较多线索解决，倾向 resolution
    if (resolvedCount >= 2 && activeCount <= 1) return 'resolution';

    return tension <= 25 ? 'falling' : 'rising';
  }

  private inferTone(state: WorldState): string {
    const latest = state.timeline[state.timeline.length - 1];
    if (!latest) return '日常';

    const s = latest.summary + ' ' + latest.consequences;
    if (/(恐惧|危险|危机|惊慌|杀|追捕|爆炸|威胁)/.test(s)) return '紧张';
    if (/(悲伤|失去|离别|哭|绝望)/.test(s)) return '悲伤';
    if (/(欢笑|开心|庆祝|温暖|轻松)/.test(s)) return '温馨';
    if (/(诡异|神秘|未知|预兆|异象)/.test(s)) return '神秘';
    if (/(争吵|冲突|对抗|对峙)/.test(s)) return '对抗';
    return '日常';
  }
}
