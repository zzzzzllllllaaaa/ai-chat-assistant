/**
 * 统一的角色/智能体类型定义
 * 兼容 SillyTavern Character Card V2 规范
 */

// ============ SillyTavern 兼容类型 ============

/**
 * 角色书/世界书条目
 */
export interface CharacterBookEntry {
  keys: string[];
  content: string;
  extensions: Record<string, any>;
  enabled: boolean;
  insertion_order: number;
  case_sensitive?: boolean;
  name?: string;
  priority?: number;
  id?: number;
  comment?: string;
  selective?: boolean;
  secondary_keys?: string[];
  constant?: boolean;
  position?: 'before_char' | 'after_char';
}

/**
 * 角色书/世界书
 */
export interface CharacterBook {
  name?: string;
  description?: string;
  scan_depth?: number;
  token_budget?: number;
  recursive_scanning?: boolean;
  extensions: Record<string, any>;
  entries: CharacterBookEntry[];
}

/**
 * SillyTavern Character Card V1 格式
 */
export interface TavernCardV1 {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
}

/**
 * SillyTavern Character Card V2 格式
 */
export interface TavernCardV2 {
  spec: 'chara_card_v2';
  spec_version: '2.0';
  data: {
    name: string;
    description: string;
    personality: string;
    scenario: string;
    first_mes: string;
    mes_example: string;
    // V2 新增字段
    creator_notes: string;
    system_prompt: string;
    post_history_instructions: string;
    alternate_greetings: string[];
    character_book?: CharacterBook;
    tags: string[];
    creator: string;
    character_version: string;
    extensions: Record<string, any>;
  };
}

/**
 * 通用 SillyTavern 卡片类型
 */
export type TavernCard = TavernCardV1 | TavernCardV2;

// ============ 文风控制类型 ============

/**
 * 文风特征
 * 不是刻板模仿，而是捕捉文风的关键维度
 */
export interface WritingStyle {
  /** 是否启用文风控制 */
  enabled: boolean;
  
  /** 文风名称（用户自定义，便于识别） */
  name?: string;
  
  /** 样本文本（用户提供的参考文本） */
  sampleText?: string;
  
  /** 
   * 文风描述（AI 分析或用户手写的文风总结）
   * 这是实际注入到 prompt 中的内容
   */
  styleDescription?: string;
  
  /** 
   * 文风维度参数
   * 允许用户微调特定维度
   */
  dimensions?: {
    /** 信息密度：1-10，越高信息越密集，少废话 */
    informationDensity?: number;
    /** 情感强度：1-10，越高情感表达越丰富 */
    emotionalIntensity?: number;
    /** 叙事节奏：1-10，越高节奏越快 */
    narrativePace?: number;
    /** 修辞程度：1-10，越高修辞手法越丰富 */
    rhetoricalLevel?: number;
    /** 口语化程度：1-10，越高越口语化 */
    colloquialLevel?: number;
    /** 细节描写：1-10，越高细节越多 */
    detailLevel?: number;
  };
  
  /** 特定指令（用户补充的额外要求） */
  customInstructions?: string;
  
  /** 分析时使用的模型 */
  analyzedBy?: string;
  
  /** 最后分析时间 */
  analyzedAt?: number;
}

/**
 * 预设文风模板
 */
export interface WritingStylePreset {
  id: string;
  name: string;
  description: string;
  style: Omit<WritingStyle, 'enabled' | 'sampleText'>;
}

// ============ 本插件统一类型 ============

/**
 * 角色类型
 */
export type CharacterType = 'assistant' | 'character' | 'tool-agent';

/**
 * 统一的角色/智能体定义
 * 融合 Persona + Agent，兼容 SillyTavern
 */
export interface Character {
  id: string;
  spec: 'obsidian_ai_v1';
  
  // === 基础信息 ===
  name: string;
  description: string;
  avatar?: string;           // 头像：Base64 或 vault 内路径
  tags: string[];
  creator?: string;
  version?: string;
  createdAt?: number;
  updatedAt?: number;
  
  // === 角色类型 ===
  type: CharacterType;
  
  // === 提示词系统 ===
  systemPrompt: string;
  personality?: string;      // 性格描述（SillyTavern 兼容）
  scenario?: string;         // 场景设定（SillyTavern 兼容）
  postHistoryInstructions?: string;  // 历史后指令/UJB
  creatorNotes?: string;     // 创作者备注（不进入提示词）
  
  // === 预设绑定 ===
  presetIds?: string[];      // 绑定的预设 ID 列表
  
  // === 对话相关 ===
  greeting?: string;         // 开场白（first_mes）
  alternateGreetings?: string[];
  exampleMessages?: string;  // 对话示例（mes_example）
  
  // === 功能扩展 ===
  mbti?: string;             // MBTI 性格注入
  tools?: string[];          // 绑定的工具列表
  model?: string;            // 指定使用的模型
  independentMemory?: boolean;  // 是否使用独立记忆
  
  // === 文风控制 ===
  writingStyle?: WritingStyle;  // 文风设置
  
  // === 知识库 ===
  characterBook?: CharacterBook;
  
  // === 扩展字段 ===
  extensions?: Record<string, any>;
  
  // === 兼容旧版 ===
  isPreset?: boolean;        // 是否为预设（来自 Agent）
}

/**
 * 从旧版 Persona 转换
 */
export interface LegacyPersona {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  avatar?: string;
  mbti?: string;
}

/**
 * 从旧版 Agent 转换
 */
export interface LegacyAgent {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  model?: string;
  mbti?: string;
  isPreset?: boolean;
}

// ============ 转换函数类型 ============

/**
 * 转换结果
 */
export interface ConversionResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  warnings?: string[];
}

/**
 * 导入选项
 */
export interface ImportOptions {
  /** 如果 ID 冲突，是否覆盖 */
  overwrite?: boolean;
  /** 导入后自动激活 */
  activate?: boolean;
  /** 自定义 ID 前缀 */
  idPrefix?: string;
}

/**
 * 导出选项
 */
export interface ExportOptions {
  /** 导出格式 */
  format: 'json' | 'png';
  /** 是否包含头像 */
  includeAvatar?: boolean;
  /** 是否包含知识库 */
  includeCharacterBook?: boolean;
}
