/**
 * 世界模型类型定义
 * 
 * 世界心智框架 (World Mind Framework)
 * 六大引擎：NPC心智 · 导演系统 · 因果网 · 空间拓扑 · 涌现钩子 · 情感光谱
 * 核心理念：场景即时追踪 + 因果链传播 + 幕外演化 + NPC自主 + 叙事智能
 */

// ═══════════════════════════════════════════════════════════════════
// 基础类型
// ═══════════════════════════════════════════════════════════════════

/** 当前场景状态 — 描述"此时此刻"发生了什么 */
export interface SceneState {
  location: string;
  subLocation: string;
  timeOfDay: string;
  weather: string;
  atmosphere: string;
  lighting: string;
  sensoryDetails: string[];
  presentEntities: string[];
  ongoingActivity: string;
}

/** 时间线条目 — 记录关键事件的因果链 */
export interface TimelineEntry {
  turn: number;
  summary: string;
  causedBy: string;
  consequences: string;
  affectedEntities: string[];
}

/** 故事线索 — 活跃的叙事线 */
export interface StoryThread {
  name: string;
  status: 'active' | 'dormant' | 'resolved';
  description: string;
  lastUpdated: number;
  nextBeat: string;
}

/** 幕外动态 — 场景外NPC正在做的事 */
export interface OffstageAction {
  entity: string;
  action: string;
  location: string;
  relevance: string;
}

// ═══════════════════════════════════════════════════════════════════
// 引擎 1: NPC 心智 (NPC Psyche)
// ═══════════════════════════════════════════════════════════════════

/** NPC 情绪状态 */
export interface NpcEmotion {
  /** 主要情绪（如"焦虑"、"喜悦"、"戒备"） */
  primary: string;
  /** 强度 0-100 */
  intensity: number;
  /** 导致该情绪的原因 */
  cause: string;
}

/** NPC 目标 */
export interface NpcGoals {
  /** 短期目标（这一幕） */
  short: string;
  /** 长期目标（故事级） */
  long: string;
  /** 隐秘目标（不会主动透露） */
  secret?: string;
}

/** NPC 日程条目 */
export interface NpcScheduleEntry {
  timeOfDay: string;
  activity: string;
  location: string;
}

/** NPC 心智模型 */
export interface NpcPsyche {
  name: string;
  /** 当前情绪 */
  emotion: NpcEmotion;
  /** 目标 */
  goals: NpcGoals;
  /** 对其他角色的态度 -100(敌对) ~ +100(亲密) */
  attitudes: Record<string, number>;
  /** 日程表 */
  schedule: NpcScheduleEntry[];
  /** 知道但不会主动说的秘密 */
  secrets: string[];
  /** 行为癖好（紧张时捏袖子、思考时敲桌子） */
  quirks: string[];
  /** 上次更新的回合数 */
  lastUpdated: number;
}

// ═══════════════════════════════════════════════════════════════════
// 引擎 2: 导演系统 (Director)
// ═══════════════════════════════════════════════════════════════════

/** 叙事阶段 */
export type NarrativePhase = 'setup' | 'rising' | 'climax' | 'falling' | 'resolution';

/** 导演状态 */
export interface DirectorState {
  /** 当前叙事阶段 */
  narrativePhase: NarrativePhase;
  /** 叙事张力 0-100 */
  tensionLevel: number;
  /** 最近场景的情感基调 */
  recentTones: string[];
  /** 剧烈事件的能量预算（0-100，每次剧烈事件消耗，自然回复） */
  energyBudget: number;
  /** 已铺垫但未回收的伏笔 */
  pendingSetups: string[];
  /** 各故事线完成度 0-100 */
  arcProgress: Record<string, number>;
  /** 上次天道触发的回合数 */
  lastFateTurn: number;
}

/** 天道事件类型 */
export type FateEventKind =
  | 'celestial'
  | 'npc_autonomy'
  | 'encounter'
  | 'complication'
  | 'undercurrent';

/** 一条天道事件 */
export interface FateEvent {
  kind: FateEventKind;
  summary: string;
  impact: string;
  entities: string[];
  delivery: 'direct' | 'rumor' | 'environmental';
}

/** 天道系统强度等级 */
export type FateIntensity = 'gentle' | 'moderate' | 'dramatic';

// ═══════════════════════════════════════════════════════════════════
// 引擎 3: 因果网 (Causal Web)
// ═══════════════════════════════════════════════════════════════════

/** 因果条件类型 */
export type CausalCondition =
  | { type: 'turns'; remaining: number }
  | { type: 'location'; entity: string; at: string }
  | { type: 'encounter'; entities: [string, string] }
  | { type: 'attitude'; entity: string; toward: string; op: '>=' | '<='; threshold: number }
  | { type: 'threadStatus'; name: string; status: 'active' | 'dormant' | 'resolved' };

/** 因果节点 — 一组条件满足后触发效果 */
export interface CausalNode {
  id: string;
  /** AND：全部满足才触发 */
  conditions: CausalCondition[];
  /** 触发效果描述 */
  effect: string;
  /** 来源/缘由 */
  origin: string;
  /** 优先级 */
  priority: 'high' | 'medium' | 'low';
  /** 创建回合 */
  createdAtTurn: number;
  /** 已触发时间（undefined = 未触发） */
  firedAtTurn?: number;
}

/** 旧版待触发后果（兼容） */
export interface PendingConsequence {
  id: string;
  trigger: string;
  effect: string;
  origin: string;
  priority: 'high' | 'medium' | 'low';
  turnsRemaining?: number;
  createdAtTurn: number;
}

// ═══════════════════════════════════════════════════════════════════
// 引擎 4: 空间拓扑 (Spatial Graph)
// ═══════════════════════════════════════════════════════════════════

/** 地点类型 */
export type LocationType = 'region' | 'city' | 'district' | 'building' | 'room' | 'wilderness';

/** 世界地点 */
export interface WorldLocation {
  id: string;
  name: string;
  type: LocationType;
  /** 父级地点（层级：room→building→district→city→region） */
  parent?: string;
  /** 连通的地点 */
  connections: { to: string; travelTime: string; description: string }[];
  /** 地点属性 */
  properties: {
    safety: number;        // 0-100
    population: string;    // "荒无人烟" | "稀少" | "适中" | "繁忙" | "拥挤"
    atmosphere: string;
    description: string;
  };
  /** 当前在此的 NPC */
  npcsPresent: string[];
  /** 玩家是否已发现 */
  discovered: boolean;
}

// ═══════════════════════════════════════════════════════════════════
// 引擎 5: 涌现式钩子 (Emergent Hooks)
// ═══════════════════════════════════════════════════════════════════

/** 涌现钩子类型 */
export type HookType = 'conflict' | 'opportunity' | 'crisis' | 'revelation' | 'relationship';

/** 一个涌现钩子 — 世界中自然存在的张力点 */
export interface EmergentHook {
  /** 类型 */
  type: HookType;
  /** 描述 */
  summary: string;
  /** 涉及实体 */
  entities: string[];
  /** 紧迫度 0-100（越高越可能自行演化） */
  urgency: number;
  /** 发现回合 */
  discoveredAtTurn: number;
  /** 是否已被玩家触及 */
  engaged: boolean;
}

// ═══════════════════════════════════════════════════════════════════
// 引擎 6: 情感光谱 (Emotional Spectrum)
// ═══════════════════════════════════════════════════════════════════

/** 情感光谱条目 */
export interface EmotionalEntry {
  turn: number;
  tone: string;       // "紧张" | "温馨" | "悲伤" | "欢乐" | "恐惧" | "神秘" | "日常"
  intensity: number;  // 0-100
}

/** 情感光谱状态 */
export interface EmotionalSpectrum {
  recent: EmotionalEntry[];
  /** 情感多样性 0-1 */
  diversity: number;
  /** 基于分析的建议 */
  suggestion: string;
}

// ═══════════════════════════════════════════════════════════════════
// 完整世界状态
// ═══════════════════════════════════════════════════════════════════

/** 完整世界状态 */
export interface WorldState {
  version: number;
  currentTurn: number;
  scene: SceneState;
  timeline: TimelineEntry[];
  /** 旧版待触发后果（兼容，推荐使用 causalWeb） */
  pendingConsequences: PendingConsequence[];
  activeThreads: StoryThread[];
  offstageHints: OffstageAction[];
  /** 天道事件（待注入主模型） */
  fateEvents?: FateEvent[];
  /** NPC 心智状态 */
  npcPsyches?: Record<string, NpcPsyche>;
  /** 导演状态 */
  director?: DirectorState;
  /** 因果网 */
  causalWeb?: CausalNode[];
  /** 空间拓扑 */
  locations?: Record<string, WorldLocation>;
  /** 涌现钩子 */
  emergentHooks?: EmergentHook[];
  /** 情感光谱 */
  emotionalSpectrum?: EmotionalSpectrum;
}

/** 场景增量变化 — 每轮提取的"什么变了" */
export interface SceneDelta {
  sceneChanges?: Partial<SceneState>;
  entered?: string[];
  exited?: string[];
  eventSummary?: string;
  eventConsequences?: string;
  newConsequences?: Array<{
    trigger: string;
    effect: string;
    priority: 'high' | 'medium' | 'low';
  }>;
  threadUpdates?: Array<{
    name: string;
    status?: 'active' | 'dormant' | 'resolved';
    description?: string;
    nextBeat?: string;
  }>;
  offstageActions?: OffstageAction[];
  timeAdvance?: string;
  /** 导演系统可附加叙事阶段/情绪色调提示 */
  emotionalTone?: string;
  /** 新增因果条件节点 */
  newCausalNodes?: Array<{
    conditions: CausalCondition[];
    effect: string;
    priority: 'high' | 'medium' | 'low';
  }>;
}

/** 创建空世界状态 */
export function createEmptyWorldState(): WorldState {
  return {
    version: 2,
    currentTurn: 0,
    scene: {
      location: '',
      subLocation: '',
      timeOfDay: '',
      weather: '',
      atmosphere: '',
      lighting: '',
      sensoryDetails: [],
      presentEntities: [],
      ongoingActivity: '',
    },
    timeline: [],
    pendingConsequences: [],
    activeThreads: [],
    offstageHints: [],
    npcPsyches: {},
    director: {
      narrativePhase: 'setup',
      tensionLevel: 20,
      recentTones: [],
      energyBudget: 100,
      pendingSetups: [],
      arcProgress: {},
      lastFateTurn: 0,
    },
    causalWeb: [],
    locations: {},
    emergentHooks: [],
    emotionalSpectrum: {
      recent: [],
      diversity: 0.5,
      suggestion: '',
    },
  };
}

