import type { Agent } from "../features/agent/types";

export type McpProvider = "local" | "dashscope" | "generic";
export type AgentPermissionScope = "read" | "write" | "exec" | "network" | "mcp";
export type AgentPermissionMode = "ask" | "allow";

export interface AgentPermissionDefaults {
  read: AgentPermissionMode;
  write: AgentPermissionMode;
  exec: AgentPermissionMode;
  network: AgentPermissionMode;
  mcp: AgentPermissionMode;
}

export interface AgentPermissionRule {
  key: string;
  scope: AgentPermissionScope;
  targetType: 'path' | 'domain' | 'mcp-server' | 'mcp-tool';
  targetValue: string;
  mode: 'allow';
}

/**
 * 通用 MCP 服务器配置
 * 用于连接第三方 MCP Server（如 Agenda、自建服务等）
 */
export interface McpServerConfig {
  id: string;
  name: string;
  /** MCP Server 端点 URL（如 http://localhost:3000/sse） */
  endpoint: string;
  /** 认证头（如 Bearer token），留空不发 Authorization */
  authHeader?: string;
  /** 是否启用 */
  enabled: boolean;
  /** 缓存的工具列表（刷新时更新） */
  tools?: McpToolDefinition[];
  /** 服务器描述 */
  description?: string;
  /** 上次发现时间 */
  lastSeenAt?: number;
  /** 最后连接状态 */
  lastStatus?: 'ok' | 'error' | 'unknown';
  lastError?: string;
}

/** 角色扮演信息隔离提示词默认值 */

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: any;
}

/** MCP 服务（对应百炼的一个 MCP Server） */
export interface McpService {
  id: string;
  name: string;
  description?: string;
  endpoint: string;
  enabled: boolean;
  provider: McpProvider;
  tools?: McpToolDefinition[];
  lastSeenAt?: number;
}

/** @deprecated 旧工具项结构，保留兼容 */
export interface McpToolItem {
  provider: McpProvider;
  name: string;
  description: string;
  enabled: boolean;
  endpoint?: string;
  /** 最近一次从 MCP listTools 看到该工具的时间（ms）。手动添加的工具此值为 0。 */
  lastSeenAt: number;
  /** 是否手动添加（而非从服务端刷新获取）。手动工具在刷新时不会被删除。 */
  isManual?: boolean;
}

export interface AIProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
}

// 方案1：连接（Connection）+ 模型注册表（Model Registry）
export interface AIConnection {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
}

export interface AIModelRegistryItem {
  model: string;
  connectionId: string;
}

export interface Persona {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  avatar?: string;
  mbti?: string;
}

/**
 * 用户角色（User Persona）
 * 用于设定用户在对话中扮演的角色，{{user}} 会替换为此角色名
 */
export interface UserPersona {
  id: string;
  name: string;           // 角色名，用于替换 {{user}}
  description: string;    // 角色描述/背景设定
  avatar?: string;        // 头像（Base64 或 URL）
  settings?: string;      // 角色设定/详细背景（用于增强角色扮演）
}

/**
 * 保存的文风
 * 用于文风库，可被多个角色卡复用
 */
export interface SavedWritingStyle {
  id: string;
  name: string;           // 文风名称
  description?: string;   // 文风简介
  styleDescription: string; // 文风描述（注入到 prompt）
  dimensions?: {
    informationDensity?: number;
    emotionalIntensity?: number;
    narrativePace?: number;
    rhetoricalLevel?: number;
    colloquialLevel?: number;
    detailLevel?: number;
  };
  customInstructions?: string; // 额外指令
  sampleText?: string;    // 分析用的样本文本
  analyzedBy?: string;    // 分析模型
  createdAt: number;      // 创建时间
  updatedAt: number;      // 更新时间
}

export interface AiChatAssistantSettings {
  /** API 配置版本（用于迁移与兼容） */
  apiConfigVersion?: number;

  aiProvider: 'openai' | 'custom';
  openaiApiKey: string;
  customApiUrl: string;
  customApiKey: string;
  
  providers: AIProvider[]; // Additional providers

  /** 方案1：连接列表（新） */
  connections: AIConnection[];
  /** 方案1：模型注册表（新） */
  modelRegistry: AIModelRegistryItem[];
  /** 方案1：新对话默认模型（新） */
  defaultChatModel: string;


  webSearchProvider: 'bing' | 'duckduckgo' | 'google' | 'baidu' | 'bing_free';
  bingApiKey: string; // Bing Search API Key
  googleApiKey: string; // Google Custom Search API Key
  googleCx: string; // Google Custom Search Engine ID

  // 多模型设置：逗号分隔字符串
  chatModels: string;
  systemPrompt: string;

  embeddingModel: string;
  retrievalCount: number;
  similarityThreshold: number;
  enableQueryRewriting: boolean; // 是否开启查询重写

  // Graph RAG Settings
  enableGraphRAG: boolean;
  graphDepth: number;
  enableForwardLinks: boolean;
  enableBacklinks: boolean;

  // Phase 4: World Class UX
  enableInlineAI: boolean; // 幽灵写作
  inlineAIModel: string; // 幽灵写作使用的模型
  enableSmartContext: boolean; // 被动智能
  enableLocalLLM: boolean; // 本地 LLM
  localLLMUrl: string; // Ollama URL
  localLLMModel: string; // Ollama Model

  // Rerank Settings
  enableRerank: boolean;
  rerankProvider: 'jina' | 'cohere' | 'siliconflow' | 'custom';
  rerankApiKey: string;
  rerankModel: string;
  rerankApiUrl: string; // For custom provider

  showCitations: boolean; // 是否在回答中显示引用来源标注 [1]

  streamOutput: boolean; // 是否开启流式输出

  agentMaxSteps: number; // 智能体最大执行步骤
  activeAgentId: string; // 当前激活的智能体 ID
  /** 兼容保留：当前智能体预设 ID，仅供聊天界面/运行时使用，不在设置页展示。 */
  activePresetId: string;
  /** 兼容保留：进入智能体模式时是否自动切换预设，仅供聊天界面使用，不在设置页展示。 */
  agentAutoPresetOnEnter: boolean;
  /** 兼容保留：自动切换目标预设 ID，仅供聊天界面使用，不在设置页展示。 */
  agentAutoPresetId: string;
  showToolLogs: boolean; // 是否显示工具调用日志
  customAgents: Agent[]; // 自定义智能体列表
  hiddenPresetAgentIds: string[]; // 被隐藏/删除的预设智能体 ID

  enableContextCompression: boolean; // 是否开启上下文压缩
  compressionThreshold: number; // 触发压缩的消息数量阈值

  maxHistoryMessages: number; // New setting
  enableContextBudgetManager: boolean; // 智能体上下文预算裁剪
  agentContextBudgetTokens: number; // 智能体模式上下文预算
  enableAgentPermissions: boolean; // 智能体结构化权限系统
  agentPermissionDefaults: AgentPermissionDefaults; // 各权限范围默认审批策略
  agentPermissionRules: AgentPermissionRule[]; // 细粒度权限规则

  excludedFolders: string[]; // Folders to exclude from indexing

  // 自动索引设置
  autoIndexEnabled: boolean; // 是否开启自动索引
  autoIndexIntervalMinutes: number; // 自动索引间隔（分钟，0表示禁用间隔更新）
  autoIndexScheduledTime: string; // 每天定时更新时间（HH:MM格式，空表示禁用）
  lastAutoIndexRunAt: number; // 最近一次自动索引执行时间
  lastAutoIndexStatus: 'idle' | 'success' | 'error' | 'skipped'; // 最近一次自动索引结果
  lastAutoIndexTrigger: '' | 'interval' | 'scheduled'; // 最近一次自动索引触发来源
  lastAutoIndexError: string; // 最近一次自动索引错误摘要

  conversationTemplates: ConversationTemplate[];

  // Memory System
  enableMemory: boolean;
  memoryPath: string;
  /** 将情景记忆按 topic 自动落到子文件夹（可选硬分区） */
  memoryEpisodicTopicFolders: boolean;
  /** 情景记忆默认写入的作用域 */
  memoryEpisodicWriteScope: 'persona' | 'project' | 'global';
  /** 检索时是否包含全局情景记忆（跨 persona 共享） */
  memoryEpisodicIncludeGlobal: boolean;
  /** 检索时是否包含项目情景记忆（同一项目共享） */
  memoryEpisodicIncludeProject: boolean;
  /** 项目 scope key（留空则使用当前激活文件的一级目录；无激活文件则使用 root） */
  memoryProjectKeyOverride: string;
  /** 角色扮演记忆提取间隔（每N轮对话提取一次） */
  roleplayExtractionInterval: number;
  /** 角色扮演记忆提取时读取的最近消息数 */
  roleplayExtractionMessageCount: number;
  /** 强制启用角色扮演记忆提取（即使角色类型不是 character） */
  forceRoleplayMemoryExtraction: boolean;

  // 天道系统 (Fate Engine)
  /** 是否启用天道系统（独立 AI 为世界注入随机事件） */
  enableFateSystem: boolean;
  /** 天道系统使用的模型（留空则使用记忆模型） */
  fateModel: string;
  /** 天道触发频率（每N轮触发一次） */
  fateFrequency: number;
  /** 天道强度：gentle=自然日常 / moderate=适度变化 / dramatic=重大事件 */
  fateIntensity: 'gentle' | 'moderate' | 'dramatic';

  // Persona System
  personas: Persona[];
  activePersonaId: string;

  // User Persona System (用户角色)
  userPersonas: UserPersona[];
  activeUserPersonaId: string;

  // Writing Style Library (文风库)
  savedWritingStyles: SavedWritingStyle[];

  // Collaboration System
  enableCollaboration: boolean;
  enableExperimentalCollaborationMode: boolean;
  enableExperimentalGroupChatMode: boolean;
  /**
   * 协作模式执行策略（单选）
   * - 'simple': 简单模式 - 意图识别后路由到普通聊天/知识库/智能体
   * - 'slow-thinking': 慢思考模式 - 先生成计划再执行
   * - 'pipeline': 三段式管线 - 固定 Research → Analyze → Write 流程
   * - 'state-graph': 状态机模式 - LangGraph 风格，支持动态重规划和反思
   */
  collaborationStrategy: 'simple' | 'slow-thinking' | 'pipeline' | 'state-graph';
  /** @deprecated 迁移到 collaborationStrategy */
  collaborationComplexity?: 'simple' | 'smart' | 'full';
  /** @deprecated 迁移到 collaborationStrategy */
  enableCollaborationSlowThinking?: boolean;
  /** @deprecated 迁移到 collaborationStrategy */
  enableCollaborationPipelineMode?: boolean;
  /** @deprecated 迁移到 collaborationStrategy */
  enableCollaborationStateGraph?: boolean;
  routerModel: string;
  plannerModel: string;
  writerModel: string;
  memoryModel: string; // 记忆整理专用模型

  // Background Tasks
  enableBackgroundTasks: boolean;
  backgroundTaskInterval: number; // minutes
  lastReflectionTime: number;
  lastLearningTime: number;
  lastBackgroundReflectionAt: number;
  lastBackgroundLearningAt: number;
  lastBackgroundTaskError: string;

  // MCP (Model Context Protocol)
  enableMcp: boolean;
  mcpEndpoint: string; // http://127.0.0.1:xxxx (localhost only by policy)
  /**
   * DEPRECATED: 旧版“手填白名单”。已迁移到 mcpTools（工具清单 + 开关）。
   * 保留仅用于兼容老数据。
   */
  mcpAllowedTools?: string[];
  /** @deprecated 旧工具清单。迁移到 mcpServices。 */
  mcpTools: McpToolItem[];
  /** @deprecated 保留用于迁移 */
  mcpConfirmBeforeCall: boolean; // ask user before each MCP tool call
  /** @deprecated 保留用于迁移 */
  mcpAutoRefreshEnabled: boolean;

  // DashScope/Bailian MCP (remote) - 简化版
  enableDashScopeMcp: boolean;
  /** @deprecated 全局 endpoint 已废弃，改用每个服务自己的 endpoint */
  dashScopeMcpEndpoint: string;
  dashScopeApiKey: string; // DASHSCOPE_API_KEY (Bearer)
  /** @deprecated 白名单已移除 */
  dashScopeAllowedHosts: string[];
  /** WebParser 类工具的最大返回字符数。 */
  dashScopeWebParserMaxOutputChars: number;
  /** WebParser 同站点最小调用间隔（ms）。 */
  dashScopeWebParserHostMinIntervalMs: number;

  /** MCP 服务列表（新结构：按服务组织，每服务有自己的 endpoint） */
  mcpServices: McpService[];

  /** 通用 MCP 服务器列表（用户手动添加的第三方 MCP Server） */
  mcpServers: McpServerConfig[];

  /** 角色扮演信息隔离提示词（用于扮演类角色卡） */
  roleplayIsolationPrompt: string;

  /** 置顶角色 ID 列表（用于选择弹窗） */
  pinnedPersonaIds: string[];
  /** 置顶智能体 ID 列表（用于选择弹窗） */
  pinnedAgentIds: string[];

  /** 每种模式对应的默认模型（模式切换时自动切换模型） */
  modeModels: {
    normal: string;
    kb: string;
    agent: string;
    collaboration: string;
  };

  // Skills 技能系统
  /** 是否启用技能系统 */
  enableSkills: boolean;
  /** 技能文件夹路径（相对于笔记库根目录） */
  skillFolderPath: string;
  /** 是否启用热重载（自动监听技能文件夹变化） */
  skillHotReload: boolean;
  /** GitHub 镜像站（用于加速下载） */
  githubMirror: string;
  /** 是否自动匹配技能（根据用户输入自动识别并执行技能） */
  skillAutoMatch: boolean;
  /** 自动匹配的最低置信度阈值 */
  skillAutoMatchThreshold: number;
  /** 禁用的内置技能 ID 列表 */
  disabledBuiltinSkills: string[];
  /** 是否启用技能动态注入（根据用户输入自动注入相关技能的 systemPrompt） */
  enableSkillInjection: boolean;
  /** 技能动态注入：最多注入几个技能的 systemPrompt */
  maxSkillsToInject: number;
  /** 技能动态注入：最多注入几个技能的 systemPrompt（已废弃，使用 maxSkillsToInject） */
  skillMaxInject: number;
  /** 用户自定义的本地技能（JSON 格式）- 已废弃，保留用于兼容 */
  localSkills: string[];
  /** 社区技能源 - 已废弃，保留用于兼容 */
  skillCommunitySources: Array<{
    id: string;
    name: string;
    manifestUrl: string;
    enabled: boolean;
    installedSkills?: string[];
  }>;
  /** 远程技能服务 - 已废弃，保留用于兼容 */
  skillRemoteServices: Array<{
    id: string;
    name: string;
    endpoint: string;
    apiKey?: string;
    enabled: boolean;
  }>;
  /** 代码实现后自动触发 self-test */
  enableAutoSelfTestAfterWrite: boolean;
  /** 自动 self-test 使用的执行文档路径或文本；留空则走默认 verify/build */
  autoSelfTestExecutionDoc: string;

  /** 上次活跃的对话 ID（用于重启后恢复） */
  lastActiveConversationId: string;

  /** 智能体反思经验条目（持久化） */
  reflectionEntries: any[];

  // API Server (HTTP API for external access)
  /** 是否启用 HTTP API Server */
  enableAPIServer: boolean;
  /** API Server 监听端口 */
  apiServerPort: number;
  /** API Server 监听地址 */
  apiServerHost: string;
  /** 允许的跨域来源（CORS） */
  apiServerAllowedOrigins: string[];
}

export interface ConversationTemplate {
  id: string;
  name: string;
  /** 斜杠指令触发词，如 "translate" → 输入 /translate 即可引用 */
  slashCommand?: string;
  presetPrompt: string;
}
