/**
 * Skills 技能系统类型定义
 * 
 * Skills 是比 Tools 更高层的能力抽象：
 * - Tools: 原子操作（读文件、搜索、API调用）
 * - Skills: 可复用的能力组合（总结文章、写周报、代码审查）
 * 
 * Skills 可以来自：
 * 1. 内置技能 - 插件自带
 * 2. 本地技能 - 用户自定义的 JSON 文件
 * 3. 社区技能 - 从 GitHub 等网络来源加载
 * 4. 远程技能服务 - 类似 MCP 的远程技能 API
 */

/** 技能来源类型 */
export type SkillSource = 'builtin' | 'local' | 'community' | 'remote';

/** 技能步骤类型 */
export type SkillStepType = 
  | 'llm'           // LLM 生成
  | 'tool'          // 调用工具
  | 'script'        // 执行脚本 (Claw Skills)
  | 'condition'     // 条件分支
  | 'loop'          // 循环
  | 'parallel'      // 并行执行
  | 'transform';    // 数据转换

/** 技能执行上下文 */
export interface SkillContext {
  /** 用户原始输入 */
  userInput: string;
  /** 步骤输出累积 */
  outputs: Record<string, any>;
  /** 变量存储 */
  variables: Record<string, any>;
  /** 执行历史 */
  history: SkillStepResult[];
  /** 中止信号 */
  abortSignal?: AbortSignal;
}

/** 技能步骤定义 */
export interface SkillStep {
  /** 步骤 ID（用于引用） */
  id: string;
  /** 步骤名称（显示用） */
  name: string;
  /** 步骤类型 */
  type: SkillStepType;
  /** 步骤描述 */
  description?: string;
  
  // LLM 类型的配置
  /** LLM 提示词模板（支持 {{variable}} 插值） */
  prompt?: string;
  /** 使用的模型（可选，默认使用用户设置） */
  model?: string;
  
  // Tool 类型的配置
  /** 工具名称 */
  toolName?: string;
  /** 工具参数模板（支持插值） */
  toolArgs?: Record<string, any>;
  
  // Script 类型的配置 (Claw Skills)
  /** 脚本文件名 */
  scriptName?: string;
  /** 脚本参数 */
  scriptArgs?: string[];
  
  // Condition 类型的配置
  /** 条件表达式 */
  condition?: string;
  /** 条件为真时执行的步骤 */
  thenSteps?: string[];
  /** 条件为假时执行的步骤 */
  elseSteps?: string[];
  
  // Loop 类型的配置
  /** 循环数据源（从 context.outputs 获取） */
  loopOver?: string;
  /** 循环体步骤 */
  loopSteps?: string[];
  /** 最大循环次数 */
  maxIterations?: number;
  
  // Parallel 类型的配置
  /** 并行执行的步骤 ID 列表 */
  parallelSteps?: string[];
  
  // Transform 类型的配置
  /** 转换表达式（简单的 JS 表达式） */
  transform?: string;
  
  /** 输出键名（将结果存入 context.outputs[outputKey]） */
  outputKey?: string;
  
  /** 依赖的步骤（这些步骤必须先完成） */
  dependsOn?: string[];
  
  /** 是否可选（失败不影响整体执行） */
  optional?: boolean;
  
  /** 重试次数 */
  retries?: number;
}

/** 技能步骤执行结果 */
export interface SkillStepResult {
  stepId: string;
  stepName: string;
  success: boolean;
  output?: any;
  error?: string;
  durationMs: number;
  timestamp: number;
}

/** 技能触发器 */
export interface SkillTrigger {
  /** 触发类型 */
  type: 'keyword' | 'regex' | 'intent' | 'command';
  /** 触发值（关键词列表、正则表达式、意图类型等） */
  value: string | string[];
  /** 置信度阈值（用于意图匹配） */
  confidence?: number;
}

/** 技能参数定义 */
export interface SkillParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  required?: boolean;
  default?: any;
  enum?: any[];
}

/** 技能定义 */
export interface Skill {
  /** 技能唯一 ID */
  id: string;
  /** 技能名称 */
  name: string;
  /** 技能描述 */
  description: string;
  /** 技能版本 */
  version: string;
  /** 技能作者 */
  author?: string;
  /** 技能来源 */
  source: SkillSource;
  /** 来源 URL（社区/远程技能） */
  sourceUrl?: string;
  
  /** 技能图标（emoji 或图标名） */
  icon?: string;
  /** 技能标签 */
  tags?: string[];
  
  /** 触发器（用于自动激活） */
  triggers?: SkillTrigger[];
  
  /** 技能参数定义 */
  parameters?: SkillParameter[];
  
  /** 执行步骤 */
  steps: SkillStep[];
  
  /** 所需工具 */
  requiredTools?: string[];
  
  /** 所需模型能力 */
  requiredCapabilities?: ('vision' | 'long-context' | 'reasoning' | 'code')[];
  
  /** 系统提示词（可选，用于覆盖默认） */
  systemPrompt?: string;
  
  /** 输出格式提示 */
  outputFormat?: string;
  
  /** 是否启用 */
  enabled?: boolean;
  
  /** 最后更新时间 */
  updatedAt?: number;
}

/** 远程技能服务定义 */
export interface RemoteSkillService {
  /** 服务 ID */
  id: string;
  /** 服务名称 */
  name: string;
  /** 服务描述 */
  description?: string;
  /** 服务端点 URL */
  endpoint: string;
  /** API Key（如需要） */
  apiKey?: string;
  /** 是否启用 */
  enabled: boolean;
  /** 最后同步时间 */
  lastSyncAt?: number;
  /** 该服务提供的技能列表（缓存） */
  skills?: string[];
}

/** 社区技能源定义 */
export interface CommunitySkillSource {
  /** 源 ID */
  id: string;
  /** 源名称 */
  name: string;
  /** 源描述 */
  description?: string;
  /** 技能清单 URL（JSON 格式） */
  manifestUrl: string;
  /** 是否启用 */
  enabled: boolean;
  /** 最后同步时间 */
  lastSyncAt?: number;
  /** 已安装的技能 ID 列表 */
  installedSkills?: string[];
}

/** 技能清单格式（用于社区分享） */
export interface SkillManifest {
  /** 清单版本 */
  version: string;
  /** 清单名称 */
  name: string;
  /** 清单描述 */
  description?: string;
  /** 作者 */
  author?: string;
  /** 主页 */
  homepage?: string;
  /** 技能列表 */
  skills: Skill[];
  /** 更新时间 */
  updatedAt: number;
}

/** 技能执行结果 */
export interface SkillExecutionResult {
  skillId: string;
  skillName: string;
  success: boolean;
  output: string;
  stepResults: SkillStepResult[];
  totalDurationMs: number;
  error?: string;
}

/** 技能匹配结果 */
export interface SkillMatch {
  skill: Skill;
  confidence: number;
  matchedTrigger?: SkillTrigger;
  extractedParams?: Record<string, any>;
}
