/**
 * 因果网引擎 (Causal Web)
 *
 * 从"回合倒计时"升级为"条件触发网络"：
 * - 支持 turns/location/encounter/attitude/threadStatus 等条件
 * - 所有条件满足才触发（AND）
 * - 触发后从因果网中标记 firedAtTurn
 */

import { CausalCondition, CausalNode, PendingConsequence, WorldState } from "./types";

export interface CausalTickResult {
  state: WorldState;
  triggered: CausalNode[];
}

export class CausalWeb {
  /**
   * 兼容迁移：将旧版 pendingConsequences(仅回合倒计时) 转为 causalWeb 节点
   */
  public migrateLegacyPending(state: WorldState): WorldState {
    const existing = state.causalWeb || [];
    if (!state.pendingConsequences || state.pendingConsequences.length === 0) {
      return { ...state, causalWeb: existing };
    }

    const migrated: CausalNode[] = [];

    for (const legacy of state.pendingConsequences) {
      // 防重：如果已有同 origin+effect 节点就不迁移
      const duplicate = existing.some(n => n.origin === legacy.origin && n.effect === legacy.effect && !n.firedAtTurn);
      if (duplicate) continue;

      const conditions: CausalCondition[] = [];
      if (legacy.turnsRemaining !== undefined) {
        conditions.push({ type: 'turns', remaining: legacy.turnsRemaining });
      }

      // 若无可结构化条件，保留 legacy，不迁移
      if (conditions.length === 0) continue;

      migrated.push({
        id: legacy.id,
        conditions,
        effect: legacy.effect,
        origin: legacy.origin,
        priority: legacy.priority,
        createdAtTurn: legacy.createdAtTurn,
      });
    }

    // 迁移后清空可迁移的 legacy（仅倒计时条件）
    const remainingLegacy: PendingConsequence[] = state.pendingConsequences.filter(c => c.turnsRemaining === undefined);

    return {
      ...state,
      pendingConsequences: remainingLegacy,
      causalWeb: [...existing, ...migrated],
    };
  }

  /**
   * 每轮推进因果网，并返回触发的节点
   */
  public tick(state: WorldState): CausalTickResult {
    const causalWeb = [...(state.causalWeb || [])];
    const triggered: CausalNode[] = [];

    for (let i = 0; i < causalWeb.length; i++) {
      const node = causalWeb[i];
      if (node.firedAtTurn !== undefined) continue;

      const evalResult = this.evaluateNode(node, state);
      if (evalResult.satisfied) {
        causalWeb[i] = { ...node, firedAtTurn: state.currentTurn };
        triggered.push(causalWeb[i]);
      } else if (evalResult.updatedConditions) {
        causalWeb[i] = { ...node, conditions: evalResult.updatedConditions };
      }
    }

    return {
      state: {
        ...state,
        causalWeb,
      },
      triggered,
    };
  }

  /**
   * 添加新因果节点
   */
  public addNode(state: WorldState, node: Omit<CausalNode, 'id' | 'createdAtTurn'>): WorldState {
    const causalWeb = [...(state.causalWeb || [])];

    const newNode: CausalNode = {
      ...node,
      id: `${state.currentTurn}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      createdAtTurn: state.currentTurn,
    };

    causalWeb.push(newNode);
    return { ...state, causalWeb };
  }

  /**
   * 将触发的因果节点转为 prompt 注入文本
   */
  public buildTriggeredBlock(triggered: CausalNode[]): string {
    if (triggered.length === 0) return '';

    const parts: string[] = [];
    parts.push(`\n\n[本轮触发的因果节点 — 请自然融入叙事]`);

    for (const node of triggered) {
      parts.push(`⚡ ${node.effect}（源自：${node.origin}）`);
    }

    parts.push('提示：不要机械列出，用环境变化、人物对话、突发事件自然呈现。\n');
    return parts.join('\n');
  }

  // ─────────────────────────────────────────────────────────────────
  // 条件求值
  // ─────────────────────────────────────────────────────────────────

  private evaluateNode(
    node: CausalNode,
    state: WorldState
  ): { satisfied: boolean; updatedConditions?: CausalCondition[] } {
    const updatedConditions: CausalCondition[] = [];

    for (const cond of node.conditions) {
      if (cond.type === 'turns') {
        // turns 条件每轮递减，<=0 即满足
        if (cond.remaining <= 0) {
          continue;
        }
        updatedConditions.push({ ...cond, remaining: cond.remaining - 1 });
        return { satisfied: false, updatedConditions: this.mergeConditions(node.conditions, updatedConditions) };
      }

      if (cond.type === 'location') {
        const present = state.scene.presentEntities || [];
        const inLocation = state.scene.location === cond.at || state.scene.subLocation === cond.at;
        if (!(present.includes(cond.entity) && inLocation)) {
          return { satisfied: false };
        }
        continue;
      }

      if (cond.type === 'encounter') {
        const [a, b] = cond.entities;
        const present = state.scene.presentEntities || [];
        if (!(present.includes(a) && present.includes(b))) {
          return { satisfied: false };
        }
        continue;
      }

      if (cond.type === 'attitude') {
        const psyche = state.npcPsyches?.[cond.entity];
        const val = psyche?.attitudes?.[cond.toward] ?? 0;
        const ok = cond.op === '>=' ? val >= cond.threshold : val <= cond.threshold;
        if (!ok) return { satisfied: false };
        continue;
      }

      if (cond.type === 'threadStatus') {
        const thread = state.activeThreads.find(t => t.name === cond.name);
        if (!thread || thread.status !== cond.status) {
          return { satisfied: false };
        }
        continue;
      }
    }

    // 所有条件都满足
    return { satisfied: true };
  }

  private mergeConditions(original: CausalCondition[], partialUpdates: CausalCondition[]): CausalCondition[] {
    // 仅替换 turns 条件
    return original.map(cond => {
      if (cond.type !== 'turns') return cond;
      const updated = partialUpdates.find(c => c.type === 'turns');
      return updated || cond;
    });
  }
}
