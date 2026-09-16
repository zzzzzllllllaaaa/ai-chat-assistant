/**
 * 沉浸感增强系统 - 类型定义
 * 包括 OOC 检测、叙事视角控制、情绪连贯性、场景感知等
 */

/**
 * OOC（Out of Character）问题类型
 */
export enum OOCIssueType {
    FORBIDDEN_WORD = 'forbidden_word',           // 禁忌词（现代词汇、元叙事等）
    PERSPECTIVE_SHIFT = 'perspective_shift',     // 人称切换
    MORAL_PREACHING = 'moral_preaching',         // 道德说教
    META_NARRATIVE = 'meta_narrative',           // 元叙事（打破第四面墙）
    ANACHRONISM = 'anachronism',                 // 时代错误
    TONE_MISMATCH = 'tone_mismatch',             // 语气不符
    KNOWLEDGE_LEAK = 'knowledge_leak',           // 知识泄露（角色不该知道的信息）
}

/**
 * OOC 检测结果
 */
export interface OOCIssue {
    type: OOCIssueType;
    severity: 'low' | 'medium' | 'high';         // 严重程度
    matchedText: string;                         // 匹配到的文本
    position: { start: number; end: number };    // 位置
    reason: string;                              // 原因说明
    suggestion?: string;                         // 修改建议
}

/**
 * OOC 检测配置
 */
export interface OOCDetectionConfig {
    /** 角色专属禁忌词 */
    forbiddenWords?: string[];
    /** 禁忌正则表达式 */
    forbiddenPatterns?: RegExp[];
    /** 允许的叙事视角 */
    allowedPerspectives?: ('first' | 'second' | 'third')[];
    /** 时代背景（用于检测时代错误） */
    timePeriod?: 'ancient' | 'medieval' | 'modern' | 'future' | 'fantasy';
    /** 是否检测道德说教 */
    detectMoralPreaching?: boolean;
    /** 是否检测元叙事 */
    detectMetaNarrative?: boolean;
    /** 严重程度阈值（低于此阈值不报告） */
    severityThreshold?: 'low' | 'medium' | 'high';
}

/**
 * 叙事视角类型
 */
export enum NarrativePerspective {
    FIRST_PERSON = 'first',      // 第一人称（我）
    SECOND_PERSON = 'second',    // 第二人称（你）
    THIRD_PERSON = 'third',      // 第三人称（他/她）
    MIXED = 'mixed',             // 混合视角
}

/**
 * 叙事风格配置
 */
export interface NarrativeStyle {
    /** 主要视角 */
    primaryPerspective: NarrativePerspective;
    /** 是否允许动作描写（*动作*） */
    allowActionMarkers?: boolean;
    /** 是否允许内心独白 */
    allowInnerMonologue?: boolean;
    /** 是否允许环境描写 */
    allowEnvironmentDescription?: boolean;
    /** 叙事语气（正式/随意/诗意等） */
    tone?: string;
}

/**
 * 情绪状态（扩展 CharacterState）
 */
export interface EmotionalState {
    emotion: string;                             // 当前情绪
    intensity: number;                           // 强度 (0-100)
    valence: number;                             // 情感效价 (-100 到 100，负面到正面)
    arousal: number;                             // 唤醒度 (0-100，平静到激动)
    timestamp: number;                           // 时间戳
}

/**
 * 情绪连贯性检测结果
 */
export interface EmotionCoherenceIssue {
    previousEmotion: EmotionalState;
    currentEmotion: EmotionalState;
    changeRate: number;                          // 变化速率（0-100）
    isAbrupt: boolean;                           // 是否突变
    reason: string;                              // 原因说明
    suggestion?: string;                         // 建议
}

/**
 * 场景上下文
 */
export interface SceneContext {
    /** 位置 */
    location: string;
    /** 时间（一天中的时间） */
    timeOfDay?: 'dawn' | 'morning' | 'noon' | 'afternoon' | 'evening' | 'night' | 'midnight';
    /** 天气 */
    weather?: string;
    /** 氛围 */
    ambience?: string;
    /** 五感细节 */
    sensoryDetails?: {
        sight?: string[];    // 视觉
        sound?: string[];    // 听觉
        smell?: string[];    // 嗅觉
        touch?: string[];    // 触觉
        taste?: string[];    // 味觉
    };
    /** 在场人物 */
    presentCharacters?: string[];
    /** 场景标记 */
    flags?: Record<string, any>;
    /** 最后更新时间 */
    lastUpdated: number;
}

/**
 * 非语言表达（微表情、肢体语言）
 */
export interface NonVerbalCues {
    /** 面部表情 */
    facialExpression?: string;
    /** 身体姿态 */
    bodyPosture?: string;
    /** 手势 */
    gestures?: string[];
    /** 眼神接触 */
    eyeContact?: boolean;
    /** 声音特征（音调、音量、语速） */
    voiceQuality?: {
        pitch?: 'high' | 'normal' | 'low';
        volume?: 'whisper' | 'soft' | 'normal' | 'loud' | 'shout';
        pace?: 'slow' | 'normal' | 'fast' | 'rushed';
    };
    /** 呼吸状态 */
    breathing?: 'calm' | 'heavy' | 'rapid' | 'held';
}

/**
 * 沉浸感检测完整结果
 */
export interface ImmersionCheckResult {
    /** OOC 问题列表 */
    oocIssues: OOCIssue[];
    /** 叙事视角问题 */
    perspectiveIssues: OOCIssue[];
    /** 情绪连贯性问题 */
    emotionIssues: EmotionCoherenceIssue[];
    /** 是否通过检测 */
    passed: boolean;
    /** 总体评分 (0-100) */
    score: number;
    /** 建议 */
    suggestions: string[];
}
