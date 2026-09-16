/**
 * 角色动态状态机
 * 用于存储易变的瞬时状态（位置、情绪、好感度等）
 */

/**
 * 角色状态（NPC 或主角）
 */
export interface CharacterState {
    characterId: string; // 角色ID（对于主角可以是 "protagonist"）
    characterName: string; // 角色名称
    
    // === 核心瞬时状态 ===
    currentLocation?: string; // 当前位置
    currentEmotion?: string; // 当前情绪（如"警惕"、"放松"、"愤怒"）
    currentActivity?: string; // 当前正在做什么
    
    // === 关系状态 ===
    attitudeToPlayer?: string; // 对主角的态度（如"信任"、"敌对"、"中立"）
    affectionLevel?: number; // 好感度 (0-100)
    trustLevel?: number; // 信任度 (0-100)
    
    // === 物品与资源 ===
    inventory?: string[]; // 当前持有的重要物品
    resources?: Record<string, number>; // 资源（如金币、体力等）
    
    // === 状态标记 ===
    flags?: Record<string, boolean | string | number>; // 自定义状态标记（如 "已知玩家身份": true）
    
    // === 元数据 ===
    lastUpdated: number; // 最后更新时间戳
    updateReason?: string; // 更新原因（用于调试）
}

/**
 * 完整的状态机快照
 */
export interface StateSnapshot {
    personaId: string; // 所属角色卡ID
    conversationId?: string; // 所属对话ID（可选）
    
    // 所有角色的状态
    characters: Record<string, CharacterState>; // key 为 characterId
    
    // 全局状态
    globalFlags?: Record<string, any>; // 全局标记（如"当前章节"、"时间"）
    
    // 元数据
    createdAt: number;
    lastUpdated: number;
    version: number; // 状态版本号，每次更新递增
}

/**
 * 状态更新结果
 */
export interface StateUpdateResult {
    success: boolean;
    updatedFields: string[]; // 更新了哪些字段
    changes: Array<{
        field: string;
        oldValue: any;
        newValue: any;
    }>;
    snapshot: StateSnapshot; // 更新后的完整快照
}

/**
 * 状态提取配置
 */
export interface StateExtractionConfig {
    /** 是否提取位置信息 */
    extractLocation?: boolean;
    /** 是否提取情绪 */
    extractEmotion?: boolean;
    /** 是否提取好感度 */
    extractAffection?: boolean;
    /** 是否提取物品变化 */
    extractInventory?: boolean;
    /** 是否提取自定义标记 */
    extractFlags?: boolean;
}
