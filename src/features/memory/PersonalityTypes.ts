/**
 * 性格演进相关类型定义
 */

/**
 * 性格补丁（记录角色性格的重大转变）
 */
export interface PersonalityPatch {
    id: string; // 补丁唯一标识
    characterId: string; // 角色ID
    
    // 转变描述
    changeType: 'attitude' | 'belief' | 'goal' | 'trauma' | 'growth'; // 转变类型
    fromState: string; // 转变前的状态描述
    toState: string; // 转变后的状态描述
    trigger: string; // 触发转变的关键事件
    
    // 补丁内容
    patchText: string; // 要注入到角色卡的文本（自然语言）
    priority: number; // 优先级 (1-10)，越高越重要
    
    // 元数据
    createdAt: number; // 创建时间
    appliedAt?: number; // 应用到角色卡的时间
    isActive: boolean; // 是否激活
    evidence: string[]; // 支持这个转变的证据（对话片段）
}

/**
 * 性格演进历史
 */
export interface PersonalityEvolution {
    personaId: string;
    characterId: string; // 角色ID（如 "林慧欣" 或 "protagonist"）
    
    patches: PersonalityPatch[]; // 所有补丁（按时间排序）
    
    // 元数据
    createdAt: number;
    lastUpdated: number;
    version: number;
}

/**
 * 性格变化检测结果
 */
export interface PersonalityChangeDetection {
    hasSignificantChange: boolean; // 是否检测到重大变化
    confidence: number; // 置信度 (0-1)
    
    changes: Array<{
        characterId: string;
        changeType: 'attitude' | 'belief' | 'goal' | 'trauma' | 'growth';
        fromState: string;
        toState: string;
        trigger: string;
        evidence: string[];
        priority: number;
    }>;
}

/**
 * 性格演进配置
 */
export interface PersonalityEvolutionConfig {
    /** 检测阈值：状态变化多少次后触发检测 */
    detectionThreshold?: number;
    
    /** 最小证据数量：至少需要多少条对话作为证据 */
    minEvidenceCount?: number;
    
    /** 是否自动应用补丁到角色卡 */
    autoApplyPatch?: boolean;
    
    /** 最大补丁数量：超过后自动合并旧补丁 */
    maxPatchCount?: number;
}
