/**
 * 空间拓扑引擎 (Spatial Graph)
 *
 * 将世界位置从单一字符串升级为图结构：
 * - 地点层级（region/city/district/building/room）
 * - 连通关系（travel time + path description）
 * - NPC 空间分布
 */

import { WorldLocation, WorldState } from "./types";

export class SpatialGraph {
  /**
   * 确保 locations 已初始化
   */
  public ensure(state: WorldState): WorldState {
    if (state.locations && Object.keys(state.locations).length > 0) return state;
    return { ...state, locations: {} };
  }

  /**
   * 根据当前 scene 同步/创建地点节点
   */
  public syncFromScene(state: WorldState): WorldState {
    const withGraph = this.ensure(state);
    const locations = { ...(withGraph.locations || {}) };

    const mainLoc = String(state.scene.location || '').trim();
    if (!mainLoc) return withGraph;

    const mainId = this.toId(mainLoc);
    if (!locations[mainId]) {
      locations[mainId] = this.createDefaultLocation(mainId, mainLoc, 'city');
    }

    // 同步在场 NPC
    locations[mainId] = {
      ...locations[mainId],
      npcsPresent: [...(state.scene.presentEntities || [])],
      discovered: true,
    };

    const subLoc = String(state.scene.subLocation || '').trim();
    if (subLoc) {
      const subId = this.toId(`${mainLoc}/${subLoc}`);
      if (!locations[subId]) {
        locations[subId] = this.createDefaultLocation(subId, subLoc, 'room', mainId);
      }
      // 建立双向连接
      locations[mainId] = this.addConnection(locations[mainId], subId, '片刻可达', '同一区域内移动');
      locations[subId] = this.addConnection(locations[subId], mainId, '片刻可达', '返回主区域');
      locations[subId].npcsPresent = [...(state.scene.presentEntities || [])];
      locations[subId].discovered = true;
    }

    return {
      ...withGraph,
      locations,
    };
  }

  /**
   * 构建空间信息注入块（仅当前地点邻接信息）
   */
  public buildSpatialContext(state: WorldState): string {
    const locations = state.locations || {};
    const mainLoc = String(state.scene.location || '').trim();
    if (!mainLoc) return '';

    const mainId = this.toId(mainLoc);
    const node = locations[mainId];
    if (!node) return '';

    const parts: string[] = [];
    parts.push(`\n[空间拓扑提示]`);
    parts.push(`当前位置节点：${node.name}（安全度 ${node.properties.safety}/100，${node.properties.population}）`);

    if (node.connections.length > 0) {
      const conns = node.connections
        .slice(0, 5)
        .map(c => {
          const target = locations[c.to];
          return `${target?.name || c.to}（${c.travelTime}）`;
        })
        .join('、');
      parts.push(`邻接地点：${conns}`);
    }

    return parts.join('\n') + '\n';
  }

  /**
   * NPC 按日程移动（规则层，可由 NpcPsycheEngine 驱动）
   */
  public moveNpc(state: WorldState, npcName: string, toLocationId: string): WorldState {
    const locations = { ...(state.locations || {}) };

    // 从所有节点移除 NPC
    for (const locId of Object.keys(locations)) {
      const node = locations[locId];
      if (node.npcsPresent.includes(npcName)) {
        locations[locId] = {
          ...node,
          npcsPresent: node.npcsPresent.filter(n => n !== npcName),
        };
      }
    }

    // 加入目标节点
    const target = locations[toLocationId];
    if (target) {
      const set = new Set(target.npcsPresent);
      set.add(npcName);
      locations[toLocationId] = {
        ...target,
        npcsPresent: Array.from(set),
      };
    }

    return { ...state, locations };
  }

  // ─────────────────────────────────────────────────────────────────
  // 内部工具
  // ─────────────────────────────────────────────────────────────────

  private toId(input: string): string {
    return String(input || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[\/]/g, '__')
      .replace(/[^a-z0-9\u4e00-\u9fa5_-]/g, '');
  }

  private createDefaultLocation(id: string, name: string, type: WorldLocation['type'], parent?: string): WorldLocation {
    return {
      id,
      name,
      type,
      parent,
      connections: [],
      properties: {
        safety: 60,
        population: '适中',
        atmosphere: '普通',
        description: '',
      },
      npcsPresent: [],
      discovered: false,
    };
  }

  private addConnection(node: WorldLocation, to: string, travelTime: string, description: string): WorldLocation {
    if (node.connections.some(c => c.to === to)) return node;
    return {
      ...node,
      connections: [...node.connections, { to, travelTime, description }],
    };
  }
}
