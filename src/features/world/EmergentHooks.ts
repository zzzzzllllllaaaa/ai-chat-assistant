/**
 * 涌现式钩子引擎 (Emergent Hooks)
 *
 * 从当前世界状态自动发现"可参与的张力点"，而不是手工预置任务：
 * - 关系冲突
 * - 机会窗口
 * - 危机苗头
 * - 线索揭示
 */

import { EmergentHook, HookType, WorldState } from "./types";

export class EmergentHooks {
  /**
   * 扫描世界状态并生成/更新钩子列表
   */
  public derive(state: WorldState): WorldState {
    const hooks: EmergentHook[] = [...(state.emergentHooks || [])];
    const discoveredAtTurn = state.currentTurn;

    // 1) 基于态度冲突生成 relationship / conflict 钩子
    const conflictHooks = this.findAttitudeConflicts(state, discoveredAtTurn);

    // 2) 基于因果节点生成 crisis / opportunity 钩子
    const causalHooks = this.findCausalHooks(state, discoveredAtTurn);

    // 3) 基于幕外动态生成 revelation 钩子
    const offstageHooks = this.findOffstageHooks(state, discoveredAtTurn);

    const merged = this.mergeHooks(hooks, [...conflictHooks, ...causalHooks, ...offstageHooks]);

    return {
      ...state,
      emergentHooks: merged.slice(-20), // 控制数量
    };
  }

  /**
   * 构建给主模型的钩子提示块
   */
  public buildHooksContext(state: WorldState): string {
    const hooks = (state.emergentHooks || []).filter(h => !h.engaged);
    if (hooks.length === 0) return '';

    const top = [...hooks].sort((a, b) => b.urgency - a.urgency).slice(0, 3);

    const parts: string[] = [];
    parts.push(`\n[世界涌现钩子 — 可选叙事方向]`);

    for (const h of top) {
      const typeLabel = this.typeLabel(h.type);
      parts.push(`• ${typeLabel} ${h.summary}（紧迫度:${h.urgency}）`);
    }

    parts.push('提示：仅在自然契合时选择其一进行轻度推进，不要强行切线。\n');
    return parts.join('\n');
  }

  /**
   * 标记钩子已被触及（例如当其关键词出现在时间线）
   */
  public markEngagedByTimeline(state: WorldState): WorldState {
    const hooks = [...(state.emergentHooks || [])];
    if (hooks.length === 0) return state;

    const timelineText = state.timeline.slice(-3).map(e => `${e.summary} ${e.consequences}`).join(' ');

    const updated = hooks.map(h => {
      if (h.engaged) return h;
      const matched = h.entities.some(ent => ent && timelineText.includes(ent)) || timelineText.includes(h.summary.slice(0, 6));
      return matched ? { ...h, engaged: true } : h;
    });

    return { ...state, emergentHooks: updated };
  }

  // ─────────────────────────────────────────────────────────────────
  // 内部规则
  // ─────────────────────────────────────────────────────────────────

  private findAttitudeConflicts(state: WorldState, turn: number): EmergentHook[] {
    const out: EmergentHook[] = [];
    const psyches = state.npcPsyches || {};

    for (const [name, psyche] of Object.entries(psyches)) {
      for (const [target, value] of Object.entries(psyche.attitudes || {})) {
        if (target === name) continue;

        if (value <= -60) {
          out.push({
            type: 'conflict',
            summary: `${name} 对 ${target} 的敌意接近爆发边缘`,
            entities: [name, target],
            urgency: Math.min(100, Math.abs(value)),
            discoveredAtTurn: turn,
            engaged: false,
          });
        } else if (value >= 70) {
          out.push({
            type: 'relationship',
            summary: `${name} 与 ${target} 的关系显著升温，可能触发关键互动`,
            entities: [name, target],
            urgency: Math.min(100, value),
            discoveredAtTurn: turn,
            engaged: false,
          });
        }
      }
    }

    return out;
  }

  private findCausalHooks(state: WorldState, turn: number): EmergentHook[] {
    const out: EmergentHook[] = [];

    for (const node of state.causalWeb || []) {
      if (node.firedAtTurn !== undefined) continue;

      // 若存在 turns 条件且接近触发，则产生危机钩子
      const turnsCond = node.conditions.find(c => c.type === 'turns') as any;
      if (turnsCond && turnsCond.remaining <= 1) {
        out.push({
          type: node.priority === 'high' ? 'crisis' : 'opportunity',
          summary: `因果节点即将触发：${node.effect}`,
          entities: [],
          urgency: node.priority === 'high' ? 90 : node.priority === 'medium' ? 70 : 55,
          discoveredAtTurn: turn,
          engaged: false,
        });
      }
    }

    return out;
  }

  private findOffstageHooks(state: WorldState, turn: number): EmergentHook[] {
    const out: EmergentHook[] = [];

    for (const hint of state.offstageHints || []) {
      // relevance 中含高风险词视为危机，否则为揭示型钩子
      const text = `${hint.action} ${hint.relevance}`;
      const risky = /(追查|围捕|暗杀|争斗|叛变|危机|袭击|失控)/.test(text);

      out.push({
        type: risky ? 'crisis' : 'revelation',
        summary: `${hint.entity} 在 ${hint.location} 的动态可能影响当前局势`,
        entities: [hint.entity, hint.location],
        urgency: risky ? 78 : 52,
        discoveredAtTurn: turn,
        engaged: false,
      });
    }

    return out;
  }

  private mergeHooks(existing: EmergentHook[], incoming: EmergentHook[]): EmergentHook[] {
    const merged = [...existing];

    for (const h of incoming) {
      // 按 summary+type 粗粒度去重
      const idx = merged.findIndex(x => x.type === h.type && x.summary === h.summary);
      if (idx >= 0) {
        // 更新紧迫度（取更高）
        merged[idx] = {
          ...merged[idx],
          urgency: Math.max(merged[idx].urgency, h.urgency),
        };
      } else {
        merged.push(h);
      }
    }

    return merged;
  }

  private typeLabel(type: HookType): string {
    const map: Record<HookType, string> = {
      conflict: '⚔ 冲突',
      opportunity: '✨ 机遇',
      crisis: '⚡ 危机',
      revelation: '🕯 揭示',
      relationship: '❤ 关系',
    };
    return map[type];
  }
}
