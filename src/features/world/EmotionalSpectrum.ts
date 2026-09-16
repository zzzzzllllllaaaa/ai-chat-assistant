/**
 * 情感光谱引擎 (Emotional Spectrum)
 *
 * 跟踪最近叙事情绪分布，避免单一情感长期重复：
 * - 自动识别每轮主要情绪
 * - 计算多样性指数
 * - 输出节奏建议（例如"最近太紧张，建议缓冲"）
 */

import { EmotionalEntry, EmotionalSpectrum, WorldState } from "./types";

export class EmotionalSpectrumEngine {
  /**
   * 每轮根据最新事件更新情感光谱
   */
  public tick(state: WorldState): WorldState {
    const latest = state.timeline[state.timeline.length - 1];
    if (!latest) return this.ensure(state);

    const withSpectrum = this.ensure(state);
    const spectrum = withSpectrum.emotionalSpectrum!;

    const tone = this.classifyTone(`${latest.summary} ${latest.consequences}`);
    const intensity = this.classifyIntensity(`${latest.summary} ${latest.consequences}`);

    const recent = [...(spectrum.recent || []), {
      turn: state.currentTurn,
      tone,
      intensity,
    }].slice(-12);

    const diversity = this.computeDiversity(recent);
    const suggestion = this.buildSuggestion(recent, diversity);

    return {
      ...withSpectrum,
      emotionalSpectrum: {
        recent,
        diversity,
        suggestion,
      },
    };
  }

  /**
   * 构建 prompt 注入块
   */
  public buildContext(state: WorldState): string {
    const spectrum = state.emotionalSpectrum;
    if (!spectrum || !spectrum.suggestion) return '';

    const tail = spectrum.recent.slice(-4);
    const trail = tail.map(e => `${e.tone}(${e.intensity})`).join(' → ');

    return `\n[情感光谱]\n近期情绪轨迹：${trail || '暂无'}\n多样性：${(spectrum.diversity * 100).toFixed(0)}%\n建议：${spectrum.suggestion}\n`;
  }

  // ─────────────────────────────────────────────────────────────────
  // 内部工具
  // ─────────────────────────────────────────────────────────────────

  private ensure(state: WorldState): WorldState {
    if (state.emotionalSpectrum) return state;

    return {
      ...state,
      emotionalSpectrum: {
        recent: [],
        diversity: 0.5,
        suggestion: '',
      },
    };
  }

  private classifyTone(text: string): string {
    const s = String(text || '');

    if (/(危机|恐惧|追捕|爆炸|威胁|战斗|对峙|杀)/.test(s)) return '紧张';
    if (/(悲伤|离别|失去|绝望|哭泣|沉痛)/.test(s)) return '悲伤';
    if (/(开心|轻松|温暖|放松|庆祝|笑)/.test(s)) return '温馨';
    if (/(神秘|诡异|未知|预兆|异象|谜)/.test(s)) return '神秘';
    if (/(争吵|冲突|敌意|对抗)/.test(s)) return '对抗';
    if (/(机遇|偶遇|惊喜|发现)/.test(s)) return '惊奇';

    return '日常';
  }

  private classifyIntensity(text: string): number {
    const s = String(text || '');
    let score = 30;

    if (/(危机|爆炸|死亡|追杀|崩塌|失控|战争|政变)/.test(s)) score += 45;
    if (/(冲突|对峙|争吵|威胁|调查|追踪)/.test(s)) score += 25;
    if (/(平静|日常|闲聊|休息|散步|吃饭)/.test(s)) score -= 15;

    return Math.max(5, Math.min(100, score));
  }

  private computeDiversity(recent: EmotionalEntry[]): number {
    if (recent.length === 0) return 0.5;

    const counter = new Map<string, number>();
    for (const r of recent) {
      counter.set(r.tone, (counter.get(r.tone) || 0) + 1);
    }

    // 简化 Shannon entropy 归一化
    const total = recent.length;
    let entropy = 0;
    for (const count of counter.values()) {
      const p = count / total;
      entropy += -p * Math.log2(p);
    }

    const maxEntropy = Math.log2(Math.max(2, counter.size));
    if (maxEntropy <= 0) return 0.5;

    return Math.max(0, Math.min(1, entropy / maxEntropy));
  }

  private buildSuggestion(recent: EmotionalEntry[], diversity: number): string {
    if (recent.length < 3) return '叙事仍在铺设阶段，保持自然推进。';

    const last4 = recent.slice(-4);
    const avgIntensity = last4.reduce((sum, e) => sum + e.intensity, 0) / last4.length;
    const sameTone = last4.every(e => e.tone === last4[0].tone);

    if (avgIntensity >= 75) {
      return '最近连续高压，建议加入缓冲段落（呼吸感、日常互动、心理消化）。';
    }

    if (avgIntensity <= 30 && recent.length >= 6) {
      return '近期偏平稳，可引入小变化（传闻、偶遇、环境异常）提升新鲜感。';
    }

    if (sameTone || diversity < 0.35) {
      return '情绪类型有些单一，建议切换叙事色调（紧张↔温馨、神秘↔日常）增强层次。';
    }

    return '情绪谱系较均衡，按当前节奏自然推进。';
  }
}
