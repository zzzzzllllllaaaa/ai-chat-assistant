import { Plugin, Notice, Editor, Modal, Platform, TFile } from 'obsidian';
import { AiChatAssistantSettings, DEFAULT_SETTINGS, AiChatAssistantSettingTab, DEFAULT_ROLEPLAY_ISOLATION_PROMPT } from './src/core/settings';
import { ChatMessage, ReferenceItem } from './src/core/types';
import { LLMService } from './src/services/llm/LLMService';
import { RAGService } from './src/services/rag/RAGService';
import { AiChatView, VIEW_TYPE_AI_CHAT } from './src/ui/views/view';
import { Conversation } from './src/core/types';
import { HistoryManager, HistoryModal } from './src/services/storage/history';
import { AgentManager } from './src/features/agent/manager';
import { VectorIndexManager } from './src/services/vector/VectorIndexManager';
import { SymbolIndex } from './src/services/code/SymbolIndex';
import { ContextBudgetManager, ContextBlock } from './src/services/context/ContextBudgetManager';
import { inlineAIViewPlugin, suggestionState, acceptSuggestionKeymap } from './src/ui/inline-ai';
import { SmartContextView, VIEW_TYPE_SMART_CONTEXT } from './src/ui/views/smart-context-view';
import { MemoryManager } from './src/features/memory/MemoryManager';
import { CollaborationManager } from './src/features/collaboration/CollaborationManager';
import {
  WorldStateManager,
  FateEngine,
  NpcPsycheEngine,
  Director,
  CausalWeb,
  SpatialGraph,
  EmergentHooks,
  EmotionalSpectrumEngine,
} from './src/features/world';
import { LogView, VIEW_TYPE_LOG } from './src/ui/views/LogView';
import { getMBTIPrompt } from "./src/services/llm/mbti";
import { BackgroundManager } from "./src/services/background/BackgroundManager";
import { InlineEditModal } from './src/ui/modals/InlineEditModal';
import { ToolRegistry } from "./src/mcp/ToolRegistry";
import { estimateTokensFromMessages } from "./src/core/tokenEstimate";
import { logger, LogLevel } from "./src/core/logger";
import { ConversationStoreV2, type ConversationIndex, type ConversationIndexEntry, buildConversationSummary } from "./src/services/storage/ConversationStoreV2";
import { safeNotice } from "./src/utils/notice";
import { normalizeEntryMode, normalizeMcpToolsList } from "./src/utils/plugin-helpers";
import { filterToolNamesByPolicy } from "./src/features/agent/ToolPolicy";
import { SearchPlanner } from "./src/features/agent/SearchPlanner";
import { SearchEvidenceBuilder } from "./src/features/agent/SearchEvidenceBuilder";
import { SearchSubagent } from "./src/features/agent/SearchSubagent";
import { ToolRouter } from "./src/features/agent/ToolRouter";
import { PermissionManager } from "./src/features/agent/PermissionManager";
import { ExecutionVerifier } from "./src/features/agent/ExecutionVerifier";
import { ExecutionSession, ExecutedToolRecord } from "./src/features/agent/ExecutionSession";
import { RepairLoop } from "./src/features/agent/RepairLoop";
import { applyStyleToSystemPrompt } from "./src/features/character/WritingStyleAnalyzer";
import { AgentExecutor } from "./src/features/agent/AgentExecutor";
import { getReflectionManager, ReflectionManager } from "./src/features/agent/reflection";
import { SkillRegistry, initSkillRegistry, getBuiltinSkills, type SkillExecutionResult } from "./src/features/skills";
import { APIServer } from "./src/services/api/APIServer";
import { RoleplayPromptService } from "./src/features/roleplay/RoleplayPromptService";
import { SettingsMigrator } from "./src/services/migration/SettingsMigrator";
import type { IPluginContext } from "./src/core/plugin-context";

export default class AiChatAssistantPlugin extends Plugin implements IPluginContext {
  settings!: AiChatAssistantSettings;
  llmService!: LLMService;
  ragService!: RAGService;
  historyManager!: HistoryManager;
  agentManager!: AgentManager;
  vectorIndexManager!: VectorIndexManager;
  symbolIndex!: SymbolIndex;
  memoryManager!: MemoryManager;
  collaborationManager!: CollaborationManager;
  worldStateManager!: WorldStateManager;
  fateEngine!: FateEngine;
  npcPsycheEngine!: NpcPsycheEngine;
  director!: Director;
  causalWeb!: CausalWeb;
  spatialGraph!: SpatialGraph;
  emergentHooks!: EmergentHooks;
  emotionalSpectrumEngine!: EmotionalSpectrumEngine;
  toolRegistry!: ToolRegistry;
  skillRegistry!: SkillRegistry;
  searchPlanner!: SearchPlanner;
  searchEvidenceBuilder!: SearchEvidenceBuilder;
  searchSubagent!: SearchSubagent;
  toolRouterAgent!: ToolRouter;
  permissionManager!: PermissionManager;
  executionVerifier!: ExecutionVerifier;
  contextBudgetManager!: ContextBudgetManager;
  agentExecutor!: AgentExecutor;
  apiServer: APIServer | null = null;
  private backgroundManager!: BackgroundManager;
  /** 角色扮演提示词服务 */
  roleplayService!: RoleplayPromptService;

  private conversations: Record<string, Conversation> = {};
  // Legacy single-file storage path (v1).
  private conversationFilePath = "";

  // v2 sharded storage (to avoid huge single files).
  private conversationV2BaseDir = "";
  private conversationV2IndexPath = "";
  private conversationStoreV2: ConversationStoreV2 | null = null;
  private conversationIndexV2: ConversationIndex = {};
  private conversationPersistState: Record<string, { historyLength: number; lastPart: number }> = {};
  private conversationForceRewrite: Set<string> = new Set();
  /** 保存操作序列化锁，防止并发写入导致数据损坏 */
  private _saveLock: Promise<void> = Promise.resolve();

  /** 对话数据就绪的 Promise，视图可 await 此 Promise 确保数据已加载 */
  private _conversationsReadyResolve: () => void = () => {};
  conversationsReady: Promise<void> = new Promise(resolve => { this._conversationsReadyResolve = resolve; });

  private lastActiveConversationId: string | null = null;

  // 自动索引定时器
  private autoIndexIntervalId: number | null = null;
  private autoIndexScheduledTimeoutId: number | null = null;
  private lastAutoIndexTime = 0;

  /**
   * Last MCP tool call arguments for quick retry from LogView.
   * Stored in-memory only (not persisted).
   */
  public lastMcpCall: null | {
    provider: "local" | "dashscope";
    toolName: string;
    args: any;
    at: number;
    ok?: boolean;
    error?: string;
  } = null;

  public setActiveConversationId(id: string | null) {
    this.lastActiveConversationId = id;
    // 持久化到 settings，以便重启后恢复
    if (id) {
      this.settings.lastActiveConversationId = id;
      void this.saveSettings();
    }
  }

  public getActiveConversationId(): string | null {
    return this.lastActiveConversationId || this.settings.lastActiveConversationId || null;
  }

  // IPluginContext implementation
  getConfigDir(): string {
    return (this.app.vault as any).configDir || ".obsidian";
  }
  getConversationStoreV2(): ConversationStoreV2 | null {
    return this.conversationStoreV2;
  }

  /**
   * 获取当前用户角色名称
   */
  public getUserPersonaName(): string {
    return this.roleplayService.getUserPersonaName();
  }

  /**
   * 替换系统提示中的占位符
   * {{user}} -> 用户角色名
   * {{char}} -> AI角色名
   */
  public replacePromptPlaceholders(text: string, charName?: string): string {
    return this.roleplayService.replacePromptPlaceholders(text, charName);
  }



  public async preprocessRoleplayMacros(text: string, persona?: any, conversation?: Conversation | null): Promise<string> {
    return this.roleplayService.preprocessRoleplayMacros(text, persona, conversation);
  }

  /**
   * 获取当前活跃的用户角色设定信息
   * 返回用户角色的 description 和 settings 字段（用于注入角色扮演上下文）
   */
  public getUserPersonaContext(): string {
    return this.roleplayService.getUserPersonaContext();
  }

  /**
   * 为角色扮演模式构建示例消息块
   * 将 exampleMessages 格式化为对话范例注入系统提示
   */
  public buildExampleMessagesBlock(persona: any): string {
    return this.roleplayService.buildExampleMessagesBlock(persona);
  }

  /**
   * 结构化构建角色扮演系统提示词
   * 按优先级分段组装，避免信息互相干扰
   * 
   * 注入顺序（高→低注意力区域）：
   * 1. 角色核心设定（persona.systemPrompt，含 roleplayIsolationPrompt 规则）
   * 2. 用户角色设定 + 对话范例
   * 3. 世界状态快照（当前场景、近期事件、NPC状态）
   * 4. 世界记录（从记忆系统检索的 Facts 数据）
   * 5. 叙事引导（节拍提示 + 回复检查清单）
   * 6. 辅助信息（日期、MBTI、文风）
   */
  public async buildRoleplaySystemPrompt(params: {
    persona: any;
    datePrompt: string;
    userPersonaContext: string;
    exampleMessagesBlock: string;
    memoryContext: string;
    worldStateBlock: string;
    privateMemoryContext: string;
    mbtiPrompt: string;
    triggeredConsequencesBlock: string;
    fateEventsBlock?: string;
    conversation?: Conversation | null;
    stateMachineContext?: string;
    graphRAGContext?: string;
    messages?: Array<{ role: string; content: string }>;
  }): Promise<string> {
    return this.roleplayService.buildRoleplaySystemPrompt(params);
  }

  async onload() {
    try {
      logger.info('System', 'Starting plugin initialization...');
      
      await this.loadSettings();
      logger.info('System', 'Settings loaded');
      
      this.toolRegistry = new ToolRegistry(this);
      this.addSettingTab(new AiChatAssistantSettingTab(this.app, this));

      // Initialize Services
      this.llmService = new LLMService(this.settings);
      this.vectorIndexManager = new VectorIndexManager(this);
      this.symbolIndex = new SymbolIndex(this.app);
      this.ragService = new RAGService(this.app, this, this.llmService);

      // 对话历史文件路径（放在 vault 的 .obsidian 下，避免更新插件时被覆盖）
      const configDir = (this.app.vault as any).configDir || ".obsidian";
      this.conversationFilePath = `${configDir}/ai-chat-assistant/conversations.json`;
      this.conversationV2BaseDir = `${configDir}/ai-chat-assistant/conversations-v2`;
      this.conversationV2IndexPath = `${this.conversationV2BaseDir}/index.json`;
      this.historyManager = new HistoryManager(this.app, this);

      this.agentManager = new AgentManager(this.app, this);
      this.agentManager.loadAgentsFromSettings(this.settings.customAgents, this.settings.hiddenPresetAgentIds || [], this.settings.personas);
      this.searchPlanner = new SearchPlanner(this.app);
      this.searchEvidenceBuilder = new SearchEvidenceBuilder(this.app, this);
      this.searchSubagent = new SearchSubagent(this.app, this);
      this.toolRouterAgent = new ToolRouter();
      this.permissionManager = new PermissionManager(this.app, this);
      this.executionVerifier = new ExecutionVerifier(this.app);
      this.contextBudgetManager = new ContextBudgetManager();
      this.agentExecutor = new AgentExecutor({
        app: this.app,
        settings: this.settings,
        llmService: this.llmService,
        ragService: this.ragService,
        agentManager: this.agentManager,
        searchPlanner: this.searchPlanner,
        searchSubagent: this.searchSubagent,
        toolRouterAgent: this.toolRouterAgent,
        permissionManager: this.permissionManager,
        executionVerifier: this.executionVerifier,
        contextBudgetManager: this.contextBudgetManager,
        skillRegistry: this.skillRegistry,
        executeSkill: (skillId, userInput, onUpdate, signal) => this.skillRegistry.executeSkill(skillId, userInput, onUpdate, signal),
        replacePromptPlaceholders: this.replacePromptPlaceholders.bind(this),
        formatStepSummary: this.formatStepSummary.bind(this),
        triggerToolReflection: this.triggerToolReflection.bind(this),
        triggerUserFeedbackReflection: this.triggerUserFeedbackReflection.bind(this),
      });
      logger.info('System', 'Agent manager initialized');

      // 加载持久化反思经验
      const reflectionMgr = getReflectionManager();
      reflectionMgr.loadEntries(this.settings.reflectionEntries || []);
      reflectionMgr.setOnPersist(() => {
        this.settings.reflectionEntries = reflectionMgr.exportEntries();
        this.saveSettings();
      });
      
      this.memoryManager = new MemoryManager(this.app, this);
      this.roleplayService = new RoleplayPromptService(
        this.settings,
        (this.app as any).vault,
        this.memoryManager.immersion
      );
      this.collaborationManager = new CollaborationManager(this.app, this);
      this.worldStateManager = new WorldStateManager(this.app, this);
      this.fateEngine = new FateEngine(this.app, this, this.worldStateManager);
      this.npcPsycheEngine = new NpcPsycheEngine(this.app, this);
      this.director = new Director();
      this.causalWeb = new CausalWeb();
      this.spatialGraph = new SpatialGraph();
      this.emergentHooks = new EmergentHooks();
      this.emotionalSpectrumEngine = new EmotionalSpectrumEngine();

      // 初始化 Skills 技能系统
      this.skillRegistry = initSkillRegistry(this.app, this);
      await this.initializeSkillsSystem();
      logger.info('System', 'Skills system initialized');
      
      this.app.workspace.onLayoutReady(async () => {
        // 对话数据和快照在 onLayoutReady 中加载，不阻塞插件启动
        try {
          await this.loadConversationsData();
          await this.historyManager.load();
          logger.info('System', 'Conversations & history loaded (deferred)');
        } catch (e) {
          logger.error('System', 'Failed to load conversations in onLayoutReady', e);
        } finally {
          this._conversationsReadyResolve();
        }

        this.vectorIndexManager.loadIndexData();
        this.memoryManager.initialize();
        // 初始化自动索引定时任务
        this.initAutoIndexScheduler();
      });
      
      logger.info('System', 'Plugin initialization complete');
    } catch (error) {
      console.error('[AI Chat] FATAL: Plugin initialization failed:', error);
      new Notice(`AI Chat Assistant 插件加载失败: ${error instanceof Error ? error.message : String(error)}`);
      throw error; // 重新抛出，让 Obsidian 知道插件加载失败
    }
    
    this.registerView(
      VIEW_TYPE_AI_CHAT,
      (leaf) => new AiChatView(leaf, this)
    );

    this.registerView(
      VIEW_TYPE_SMART_CONTEXT,
      (leaf) => new SmartContextView(leaf, this)
    );

    this.registerView(
      VIEW_TYPE_LOG,
      (leaf) => new LogView(leaf)
    );

    this.addRibbonIcon('message-circle', '打开 AI 聊天面板', () => {
      this.activateView();
    });

    this.addRibbonIcon('lightbulb', '打开 Smart Context', () => {
      this.activateSmartContextView();
    });

    this.addCommand({
      id: 'open-ai-chat-view',
      name: '打开 AI 聊天面板',
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: 'open-character-manager',
      name: '角色管理器（支持 SillyTavern 导入）',
      callback: async () => {
        const { CharacterManagerModal } = await import('./src/ui/modals/CharacterManagerModal');
        new CharacterManagerModal(this.app, this).open();
      },
    });

    this.addCommand({
      id: 'open-writing-style-manager',
      name: '文风库管理',
      callback: async () => {
        const { WritingStyleManagerModal } = await import('./src/ui/modals/WritingStyleManagerModal');
        new WritingStyleManagerModal(this.app, this).open();
      },
    });

    this.addCommand({
      id: 'open-group-chat',
      name: 'AI 群聊',
      callback: async () => {
        const { GroupChatRoomModal } = await import('./src/ui/modals/GroupChatRoomModal');
        new GroupChatRoomModal(this.app, this, (room) => {
          // 选择房间后进入群聊视图
          safeNotice(`进入群聊：${room.name}`);
          // TODO: 打开群聊视图
        }).open();
      },
    });

    this.addCommand({
      id: 'open-smart-context-view',
      name: '打开 Smart Context (被动感知)',
      callback: () => this.activateSmartContextView(),
    });

    this.addCommand({
      id: 'check-kb-status',
      name: '查看知识库索引状态',
      callback: async () => {
        const count = this.vectorIndexManager.vectorIndex.length;
        const files = new Set(this.vectorIndexManager.vectorIndex.map(i => i.path)).size;
        safeNotice(`知识库状态：\n- 总片段数: ${count}\n- 已索引文件: ${files}\n- 存储引擎: IndexedDB (高性能)`);
      },
    });

    this.addCommand({
      id: 'force-reindex-all',
      name: '强制重新构建所有索引 (清空数据库)',
      callback: async () => {
        if (confirm("确定要清空并重新构建所有索引吗？这可能需要一些时间。")) {
          await this.vectorIndexManager.clearDatabase();
          await this.vectorIndexManager.indexVault();
        }
      },
    });

    this.addCommand({
      id: 'reload-knowledge-base',
      name: '重新加载知识库索引',
      callback: async () => {
        new Notice("正在重新加载知识库索引...");
        await this.vectorIndexManager.loadIndexData();
      },
    });

    this.addCommand({
      id: 'update-knowledge-base-index',
      name: '更新知识库索引 (增量)',
      callback: async () => {
        await this.vectorIndexManager.indexVault();
      },
    });



    this.addCommand({
      id: 'view-plugin-logs',
      name: '查看调试日志',
      callback: () => {
        this.activateLogView();
      }
    });

    this.addCommand({
      id: 'api-test-connections',
      name: 'API：测试所有连接连通性',
      callback: async () => {
        const connections = Array.isArray(this.settings.connections)
          ? this.settings.connections.filter(c => c && c.enabled !== false)
          : [];

        if (connections.length === 0) {
          new Notice('未找到已启用的连接（Connections）。请先在设置 → Model → 连接 中添加。', 8000);
          return;
        }

        safeNotice(`正在测试 ${connections.length} 个连接...`, 4000);
        const results = [] as Array<{ id: string; name: string; ok: boolean; message: string; durationMs: number; status?: number }>;

        for (const c of connections) {
          try {
            const r = await this.llmService.testConnection({
              id: c.id,
              name: c.name,
              baseUrl: c.baseUrl,
              apiKey: c.apiKey,
            });
            results.push({ id: c.id, name: c.name, ...r });
          } catch (e: any) {
            results.push({ id: c.id, name: c.name, ok: false, message: e?.message || String(e), durationMs: 0 });
          }
        }

        const okCount = results.filter(r => r.ok).length;
        logger.log(
          LogLevel.INFO,
          'AI',
          'API connections test',
          { okCount, total: results.length },
          JSON.stringify(results, null, 2),
        );
        safeNotice(`连接测试完成：${okCount}/${results.length} 通过。详情见“AI 助手日志”。`, 8000);
        await this.activateLogView();
      },
    });

    this.addCommand({
      id: 'api-refresh-models',
      name: 'API：从服务商拉取模型列表（追加到模型绑定）',
      callback: async () => {
        const connections = Array.isArray(this.settings.connections)
          ? this.settings.connections.filter(c => c && c.enabled !== false)
          : [];

        if (connections.length === 0) {
          new Notice('未找到已启用的连接（Connections）。请先在设置 → Model → 连接 中添加。', 8000);
          return;
        }

        const prevRegistry = Array.isArray(this.settings.modelRegistry) ? this.settings.modelRegistry : [];
        const existing = new Map(prevRegistry.map(r => [String(r.model || '').trim(), String(r.connectionId || '').trim()] as const));

        safeNotice(`正在拉取模型列表（${connections.length} 个连接）...`, 4000);
        const report: Array<{ connectionId: string; name: string; added: number; fetched: number; skipped: number; error?: string }> = [];
        const nextRegistry = [...prevRegistry];

        for (const c of connections) {
          try {
            const models = await this.llmService.listModels({
              id: c.id,
              name: c.name,
              baseUrl: c.baseUrl,
              apiKey: c.apiKey,
            });

            let added = 0;
            let skipped = 0;
            for (const m of models) {
              const model = String(m || '').trim();
              if (!model) continue;

              const bound = existing.get(model);
              if (bound) {
                // already bound to some connection; keep existing mapping
                skipped++;
                continue;
              }

              nextRegistry.push({ model, connectionId: c.id });
              existing.set(model, c.id);
              added++;
            }

            report.push({ connectionId: c.id, name: c.name, fetched: models.length, added, skipped });
          } catch (e: any) {
            report.push({ connectionId: c.id, name: c.name, fetched: 0, added: 0, skipped: 0, error: e?.message || String(e) });
          }
        }

        this.settings.modelRegistry = nextRegistry;
        await this.saveSettings();

        const totalAdded = report.reduce((sum, r) => sum + (r.added || 0), 0);
        const okConn = report.filter(r => !r.error).length;
        logger.log(
          LogLevel.INFO,
          'AI',
          'API refresh models',
          { totalAdded, okConn, total: report.length },
          JSON.stringify(report, null, 2),
        );
        safeNotice(`模型拉取完成：成功 ${okConn}/${report.length}，新增模型 ${totalAdded} 个。详情见“AI 助手日志”。`, 9000);
        await this.activateLogView();
      },
    });

    this.addCommand({
      id: 'start-multi-agent-discussion',
      name: '开启多智能体协作讨论 (黑板模式)',
      callback: async () => {
        const userInput = prompt("请输入讨论主题或复杂任务：");
        if (!userInput) return;
        
        new Notice("🤖 正在召集专家进行讨论...");
        const plan = await this.collaborationManager.generatePlan(userInput);
        
        // Get current persona system prompt for consistency
        const activePersona = this.settings.personas.find(p => p.id === this.settings.activePersonaId) || this.settings.personas[0];
        const mbtiPrompt = activePersona.mbti ? getMBTIPrompt(activePersona.mbti) : "";
        const systemPrompt = activePersona.systemPrompt + mbtiPrompt;

        const result = await this.collaborationManager.executePlan(plan, systemPrompt, (msg: string) => {
          safeNotice(msg);
        });
        
        // Create a new note with the result
        const fileName = `AI_Discussion_${Date.now()}.md`;
        await this.app.vault.create(fileName, `# AI 协作讨论结果\n\n## 主题: ${userInput}\n\n${result}`);
        this.app.workspace.openLinkText(fileName, '', true);
      }
    });

    this.addCommand({
      id: 'view-file-history',
      name: '查看当前文件修改历史',
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (file) {
          if (!checking) {
            new HistoryModal(this.app, this.historyManager, file).open();
          }
          return true;
        }
        return false;
      }
    });

    // Memory consolidation commands
    this.addCommand({
      id: 'trigger-graph-extraction',
      name: '手动触发知识图谱提取',
      callback: async () => {
        const activePersona = this.settings.personas.find(p => p.id === this.settings.activePersonaId);
        if (!activePersona) {
          new Notice('请先选择一个角色');
          return;
        }

        const conversationId = this.getActiveConversationId();
        if (!conversationId) {
          new Notice('当前没有活动对话');
          return;
        }

        const meta = await this.conversationStoreV2?.loadMeta(conversationId);
        if (!meta) {
          new Notice('无法加载对话元数据');
          return;
        }

        const messages = await this.conversationStoreV2?.loadFullHistory(conversationId, meta.lastPart);
        if (!messages || messages.length < 2) {
          new Notice('对话消息不足，无法提取图谱');
          return;
        }

        new Notice('开始提取知识图谱...');
        await this.memoryManager.extractKnowledgeGraph(messages, this.settings.activePersonaId);
      }
    });

    this.addCommand({
      id: 'trigger-state-update',
      name: '手动触发状态机更新',
      callback: async () => {
        const activePersona = this.settings.personas.find(p => p.id === this.settings.activePersonaId);
        if (!activePersona) {
          new Notice('请先选择一个角色');
          return;
        }

        const conversationId = this.getActiveConversationId();
        if (!conversationId) {
          new Notice('当前没有活动对话');
          return;
        }

        const meta = await this.conversationStoreV2?.loadMeta(conversationId);
        if (!meta) {
          new Notice('无法加载对话元数据');
          return;
        }

        const messages = await this.conversationStoreV2?.loadFullHistory(conversationId, meta.lastPart);
        if (!messages || messages.length < 2) {
          new Notice('对话消息不足，无法更新状态');
          return;
        }

        new Notice('开始更新角色状态...');
        await this.memoryManager.updateCharacterState(messages, this.settings.activePersonaId);
        new Notice('状态更新完成');
      }
    });

    this.addCommand({
      id: 'trigger-personality-evolution',
      name: '手动触发性格演进检测',
      callback: async () => {
        const activePersona = this.settings.personas.find(p => p.id === this.settings.activePersonaId);
        if (!activePersona) {
          new Notice('请先选择一个角色');
          return;
        }

        const conversationId = this.getActiveConversationId();
        if (!conversationId) {
          new Notice('当前没有活动对话');
          return;
        }

        const meta = await this.conversationStoreV2?.loadMeta(conversationId);
        if (!meta) {
          new Notice('无法加载对话元数据');
          return;
        }

        const messages = await this.conversationStoreV2?.loadFullHistory(conversationId, meta.lastPart);
        if (!messages || messages.length < 10) {
          new Notice('对话消息不足（需要至少10轮），无法检测性格演进');
          return;
        }

        new Notice('开始检测性格演进...');
        await this.memoryManager.detectAndApplyPersonalityEvolution(messages, this.settings.activePersonaId);
        new Notice('性格演进检测完成');
      }
    });

    // Register Inline AI Editor Extension
    this.registerEditorExtension([
        suggestionState,
        inlineAIViewPlugin(this),
        acceptSuggestionKeymap(this)
    ]);

    // Initialize Background Manager
    this.backgroundManager = new BackgroundManager(this);
    this.backgroundManager.start();

    // Initialize API Server
    if (this.settings.enableAPIServer) {
      try {
        this.apiServer = new APIServer(this, {
          enabled: this.settings.enableAPIServer,
          port: this.settings.apiServerPort,
          host: this.settings.apiServerHost,
          allowedOrigins: this.settings.apiServerAllowedOrigins
        });
        await this.apiServer.start();
      } catch (error) {
        console.error('Failed to start API Server:', error);
        new Notice('API Server 启动失败，请检查端口是否被占用');
      }
    }
  }

  onunload() {
    // Stop API Server
    if (this.apiServer) {
      this.apiServer.stop();
    }

    if (this.backgroundManager) {
      this.backgroundManager.stop();
    }
  }

  async activateLogView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_LOG)[0];
    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        await rightLeaf.setViewState({
          type: VIEW_TYPE_LOG,
          active: true,
        });
        leaf = workspace.getLeavesOfType(VIEW_TYPE_LOG)[0];
      }
    }
    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  /**
   * 根据文件路径和 chunk 的起始偏移量，解析出最近的 Markdown 标题作为 subpath。
   * 返回 "#heading" 格式的字符串（Obsidian 链接子路径），如果找不到标题则返回 undefined。
   */
  private resolveChunkSubpath(filePath: string, startOffset?: number): string | undefined {
    if (startOffset === undefined || startOffset <= 0) return undefined;

    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return undefined;

    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache?.headings || cache.headings.length === 0) return undefined;

    // 找到 startOffset 之前（含）最近的标题
    let bestHeading: { heading: string; position: { start: { offset: number } } } | null = null;
    for (const h of cache.headings) {
      if (h.position.start.offset <= startOffset) {
        if (!bestHeading || h.position.start.offset > bestHeading.position.start.offset) {
          bestHeading = h;
        }
      }
    }

    if (!bestHeading) return undefined;

    return `#${bestHeading.heading}`;
  }

  async handleSendMessage(
    userInput: string,
    mode: 'normal' | 'kb' | 'search' | 'agent' | 'collaboration',
    history: ChatMessage[],
    context: string,
    model: string,
    images?: string[],
    onUpdate?: (content: string) => void,
    onMeta?: (meta: { contextTokensEstimate: number; mode: string; model: string }) => void,
    onRunSnapshot?: (snapshot: import('./src/core/types').AgentRunSnapshot) => void,
    signal?: AbortSignal,
    runtimeOptions?: {
      conversation?: Conversation | null;
      effectiveAgentId?: string;
      toolPolicyId?: string;
      modelSource?: import('./src/core/types').ConversationModelSource;
    },
  ): Promise<{ content: string; references?: ReferenceItem[]; intermediateMessages?: ChatMessage[]; reasoning_content?: string; meta?: { contextTokensEstimate: number }; decisionState?: import('./src/core/types').ConversationDecisionState }> {
    const explicitSkill = images?.length ? null : this.matchExplicitSkillCommand(userInput);
    if (explicitSkill) {
      const updateChunks: string[] = [];
      const skillResult = await this.skillRegistry.executeSkill(
        explicitSkill.skillId,
        explicitSkill.payload,
        (message) => {
          updateChunks.push(message);
          onUpdate?.(`${message}\n`);
        },
        signal,
      );
      const prelude = `🎯 已切换到技能：${explicitSkill.skillName}`;
      const detail = updateChunks.join("\n").trim();
      const body = skillResult.success
        ? skillResult.output
        : `技能执行失败：${skillResult.error || '未知错误'}`;
      const content = [prelude, detail, body].filter(Boolean).join("\n\n");
      const meta = {
        contextTokensEstimate: Math.max(1, estimateTokensFromMessages([
          { role: 'user', content: userInput },
          { role: 'assistant', content },
        ])),
      };
      onMeta?.({ contextTokensEstimate: meta.contextTokensEstimate, mode, model });
      return { content, references: [], meta };
    }

    const currentDateTime = new Date().toLocaleString('zh-CN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const datePrompt = `\n\n当前日期与时间: ${currentDateTime}`;

    // --- Parallel Pre-fetch: Memory + World State + Private Memory + State Machine + Graph RAG ---
    // 五个操作互不依赖，并行执行以减少等待时间
    let memoryContext = "";
    let worldStateContext = "";
    let triggeredConsequencesBlock = "";
    let privateMemoryContext = "";
    let stateMachineContext = "";
    let graphRAGContext = "";

    const effectiveAgentId = runtimeOptions?.effectiveAgentId || runtimeOptions?.conversation?.agentId || this.settings.activeAgentId || "note-assistant";
    const personaId = mode === 'agent' ? effectiveAgentId : (runtimeOptions?.conversation?.personaId || this.settings.activePersonaId);
    const personaForType = (this.settings.personas || []).find(p => p.id === personaId);
    const personaTypeEarly = String((personaForType as any)?.type || '').trim();
    const isCharacterEarly = mode !== 'agent' && personaTypeEarly === 'character';

    // Task 1: Memory Retrieval
    const memoryTask = (async () => {
      if (!this.settings.enableMemory) return;
      const projectKeyOverride = String(this.settings.memoryProjectKeyOverride || "").trim();
      const activeFile = this.app.workspace.getActiveFile();
      const activePath = String(activeFile?.path || "");
      const derivedProjectKey = activePath.includes('/') ? (activePath.split('/')[0] || 'root') : 'root';
      const projectKey = projectKeyOverride || derivedProjectKey;

      const raw = await this.memoryManager.retrieveRelevantMemory(userInput, personaId, projectKey);
      if (raw) {
        memoryContext = `\n\n[Memory Context]\n${raw}\n`;
      }
    })();

    // Task 2: World State — 只读缓存 + 检查待触发后果 + 消费天道事件（零 LLM 调用）
    // extractSceneDelta + FateEngine.generate（含 LLM）延迟到回复后异步执行
    let fateEventsBlock = "";
    const worldStateTask = (async () => {
      if (!this.settings.enableMemory) return;
      if (!isCharacterEarly) return;
      try {
        let worldState = await this.worldStateManager.loadState(personaId);
        // 前置规则层：仅做零 LLM 的轻量变换（情绪衰减、空间同步、因果迁移+tick）
        // director/emotionalSpectrum/emergentHooks 的 tick 由后置异步流水线负责，避免每轮重复调用
        worldState = this.npcPsycheEngine.tickEmotionDecay(worldState);
        worldState = this.spatialGraph.syncFromScene(worldState);
        worldState = this.causalWeb.migrateLegacyPending(worldState);
        const causalTick = this.causalWeb.tick(worldState);
        worldState = causalTick.state;

        const causalTriggeredBlock = this.causalWeb.buildTriggeredBlock(causalTick.triggered);
        if (causalTriggeredBlock) {
          triggeredConsequencesBlock += causalTriggeredBlock;
        }

        // 检查并触发到期的延迟后果
        const { triggered, remaining } = this.worldStateManager.checkPendingConsequences(worldState);
        worldState.pendingConsequences = remaining;
        if (triggered.length > 0) {
          // 后果已触发，异步保存更新后的状态（不阻塞）
          this.worldStateManager.saveState(personaId, worldState).catch(() => {});
          const consequences = triggered
            .map(c => `⚡ ${c.effect}（源自：${c.origin}）`)
            .join('\n');
          triggeredConsequencesBlock = `\n\n[本轮触发的延迟后果 — 必须自然融入叙事]\n${consequences}\n`;
        }
        // 消费上一轮天道事件（如有）
        fateEventsBlock = await this.fateEngine.consumeFateEvents(personaId);

        // 构建统一世界心智上下文（合并原 worldState/narrativeBeat/worldMind/npcSnapshot 多块注入）
        const psycheSnapshot = this.npcPsycheEngine.buildPsycheSnapshot(worldState);
        const fileBasedSnapshot = await this.worldStateManager.buildNpcSnapshot(personaId, worldState);
        const hooksContext = this.emergentHooks.buildHooksContext(worldState);
        const spatialContext = this.spatialGraph.buildSpatialContext(worldState);
        worldStateContext = this.worldStateManager.buildUnifiedWorldContext(worldState, {
          psycheSnapshot,
          fileBasedSnapshot,
          hooksContext,
          spatialContext,
          historyLength: history.length,
        });

        // 保存规则层推进后的状态（情绪衰减 + 空间同步 + 因果 tick，异步，不阻塞）
        this.worldStateManager.saveState(personaId, worldState).catch(() => {});
      } catch (e) {
        logger.warn("AI", "[WorldState] Failed to load cached state", e);
      }
    })();

    // Task 3: Private Memory (Diary & Interests)
    const privateMemoryTask = (async () => {
      if (!this.settings.enableBackgroundTasks) return;
      const memories = await this.vectorIndexManager.getPrivateMemory();
      if (memories.length > 0) {
        const userText = String(userInput || "").trim();
        const isRecallOrReflection = /(回忆|记得|之前|上次|以前|我们聊过|复盘|反思|总结|近况|最近怎么样|最近在想|日记|成长|学习到)/i.test(userText);
        const isNewsOrUpdate = /(最新|新闻|资讯|进展|更新|有没有新|最近.*(怎么样|如何))/i.test(userText);

        const sorted = memories.sort((a: any, b: any) => b.timestamp - a.timestamp);
        const selected: any[] = [];
        for (const mem of sorted) {
          if (selected.length >= 2) break;
          const type = String(mem?.type || "");
          if (type === 'diary') {
            if (!isRecallOrReflection) continue;
            selected.push(mem);
            continue;
          }
          if (type === 'interest') {
            const keyword = String(mem?.metadata?.keyword || "").trim();
            if (keyword && userText.includes(keyword)) {
              selected.push(mem);
              continue;
            }
            if (isNewsOrUpdate && keyword) {
              selected.push(mem);
              continue;
            }
            continue;
          }
        }

        if (selected.length > 0) {
          for (const mem of selected) {
            await this.vectorIndexManager.incrementMemoryAccess(mem.id);
          }

          privateMemoryContext = "\n\n[AI 自主记忆 (可选参考，可能不相关)]\n" +
            selected.map((m: any) => {
              const typeStr = m.type === 'diary' ? '反思日记' : (m.type === 'interest' ? '学习心得' : String(m.type));
              return `--- ${typeStr} (${new Date(m.timestamp).toLocaleString()}) ---\n${m.content}`;
            }).join("\n");

          privateMemoryContext += "\n\n规则：仅在与当前问题高度相关、确实能帮助回答时才引用这些记忆。不要牵强附会、不要把旧概念强行套到新问题上；如果不相关请完全忽略。";
        }
      }
    })();

    // Task 4: State Machine Context (角色扮演专用)
    const stateMachineTask = (async () => {
      if (!this.settings.enableMemory) return;
      if (!isCharacterEarly) return;
      try {
        const stateText = await this.memoryManager.getStateContext(personaId);
        if (stateText) {
          stateMachineContext = `\n\n[角色当前状态 — 最高优先级，必须严格遵守]\n${stateText}\n`;
        }
      } catch (e) {
        logger.warn("AI", "[StateMachine] Failed to load state context", e);
      }
    })();

    // Task 5: Graph RAG Context (角色扮演专用)
    const graphRAGTask = (async () => {
      if (!this.settings.enableMemory) return;
      if (!isCharacterEarly) return;
      try {
        const graphText = await this.memoryManager.getGraphContext(userInput, personaId);
        if (graphText) {
          graphRAGContext = `\n\n[知识图谱记忆 — 关系网络]\n${graphText}\n`;
        }
      } catch (e) {
        logger.warn("AI", "[GraphRAG] Failed to load graph context", e);
      }
    })();

    // 并行等待所有预取任务
    await Promise.all([memoryTask, worldStateTask, privateMemoryTask, stateMachineTask, graphRAGTask]);

    // --- Persona Selection ---
    const activePersona = this.settings.personas.find(p => p.id === this.settings.activePersonaId) || this.settings.personas[0];
    const mbtiPrompt = activePersona.mbti ? getMBTIPrompt(activePersona.mbti) : "";

    const memoryUsageRules = `\n\n[记忆使用规则]\n- 目标：优先保证回答的准确性与贴合当前问题。\n- 仅当记忆与当前问题高度相关、能直接提高准确性/减少遗漏时才引用；不相关就忽略。\n- 不要用旧概念去强行解释新问题；禁止牵强类比/套壳。\n- 若对记忆是否适用/是否仍然成立不确定，先用一句话向用户确认（例如：\"我记得你之前可能提过 X，对吗？\"），确认后再展开。\n- 当用户纠正/否认时，立即以用户当前表述为准，不争辩。\n`;

    // 角色扮演类型检测（在后续多处使用）
    const personaType = String((activePersona as any)?.type || '').trim();
    const isRoleplayCharacter = mode !== 'agent' && personaType === 'character';
    // --- Collaboration / Router Logic ---
    let effectiveModel = model || this.settings.defaultChatModel || this.settings.routerModel || this.settings.chatModels.split(',')[0] || "gpt-3.5-turbo";
    const effectiveToolPolicyId = this.resolveConversationToolPolicy(runtimeOptions?.conversation, effectiveAgentId, runtimeOptions?.toolPolicyId);
    const resolvedModelMeta = this.resolveConversationModel(runtimeOptions?.conversation, mode, effectiveAgentId);
    if (mode === 'agent') {
      effectiveModel = resolvedModelMeta.model;
      if (runtimeOptions?.conversation) {
        runtimeOptions.conversation.model = resolvedModelMeta.model;
        runtimeOptions.conversation.modelSource = runtimeOptions?.modelSource || resolvedModelMeta.source;
      }
    }

    if (mode === 'collaboration') {
      const intent = await this.collaborationManager.routeIntent(userInput);

        // 获取场景感知的提示词修饰语（回应模式自适应）
        const scenePromptModifier = intent.promptModifier || '';
        
        // 将场景感知的提示词修饰语整合到系统提示词中
        // 角色扮演时跳过 IntentAnalyzer 的 scenePromptModifier，避免破坏沉浸感
        const effectiveSceneModifier = isRoleplayCharacter ? '' : scenePromptModifier;
        // 用户角色设定和示例消息（角色扮演时注入）
        const collabUserPersonaCtx = isRoleplayCharacter ? this.getUserPersonaContext() : '';
        const collabExampleMsgs = isRoleplayCharacter ? this.buildExampleMessagesBlock(activePersona) : '';
        
        let baseSystemPrompt: string;
        if (isRoleplayCharacter) {
          // 协作模式 + 角色扮演：使用结构化 prompt builder（修复遗漏世界状态的 bug）
          baseSystemPrompt = await this.buildRoleplaySystemPrompt({
            persona: activePersona,
            datePrompt,
            userPersonaContext: collabUserPersonaCtx,
            exampleMessagesBlock: collabExampleMsgs,
            memoryContext,
            worldStateBlock: worldStateContext, // B2: 协作模式现在也注入世界状态
            privateMemoryContext,
            mbtiPrompt,
            triggeredConsequencesBlock,
            fateEventsBlock,
            conversation: runtimeOptions?.conversation || null,
            stateMachineContext,
            graphRAGContext,
            messages: history.map(m => ({ role: m.role, content: m.content || '' })), // 传递历史消息用于场景感知
          });
        } else {
          baseSystemPrompt = activePersona.systemPrompt + datePrompt + memoryContext + privateMemoryContext + mbtiPrompt + memoryUsageRules + effectiveSceneModifier;
        }
        // 应用文风设置（如果启用）
        let systemPromptWithScene = applyStyleToSystemPrompt(baseSystemPrompt, (activePersona as any).writingStyle);
        // 替换 {{user}} 和 {{char}} 占位符
        systemPromptWithScene = this.replacePromptPlaceholders(systemPromptWithScene, activePersona.name);

        const intermediateMessages: ChatMessage[] = [];
        
        // 获取协作策略
        const strategy = this.settings.collaborationStrategy || 'simple';
        
        // 移动端后台限制提示（复杂协作任务）
        if (strategy !== 'simple' && Platform.isMobile && onUpdate) {
          onUpdate("📱 *移动端提示：协作任务执行中，请保持 Obsidian 在前台运行。*\n\n");
        }

        const maybeWriteTodoList = async (items: Array<{ id: number; title: string; description: string; status: 'not-started' | 'in-progress' | 'completed' }>) => {
          // 只有慢思考和状态机模式才显示 TodoList
          if (strategy !== 'slow-thinking' && strategy !== 'state-graph') return;
          try {
            const tool = this.agentManager.getTool("manage_todo_list");
            if (!tool) return;
            const out = await tool.execute({ action: "set", todoList: items }, this.app);
            intermediateMessages.push({ role: 'tool', name: 'manage_todo_list', content: out });
          } catch {
            // best-effort; ignore
          }
        };

    // Guardrail: retrieval/listing requests must not fall through to plain chat.
    // This addresses cases where the router underestimates the intent and the model never calls tools.
    const mustRetrieve = /(帮我|请|麻烦)?\s*(找|查|搜索|检索|列出|整理|汇总|统计|回忆|看看).*?(笔记|记录|文件|内容|梦|日记|想法|对话)|\b(list|find|search|retrieve)\b/i.test(userInput);
    const mentionsVaultLike = /(在(我)?的(笔记|库|vault)|知识库|本地|Obsidian|文件夹|路径)/i.test(userInput);
    if ((mustRetrieve || mentionsVaultLike) && intent.level === 'assistant') {
      // Force a researcher specialist so we always try knowledge_base_query, etc.
      (intent as any).level = 'specialist';
      (intent as any).assignedSpecialist = 'researcher';
    }
    
        // ========== 根据策略执行协作 ==========
        
        // 状态机模式：最智能但最慢
        if (strategy === 'state-graph') {
            const levelName = intent.level === 'ceo' ? "战略级" : intent.level === 'pm' ? "流程级" : "专家级";
            safeNotice(`🤖 状态机模式：${levelName}任务启动...`);
            if (onUpdate) onUpdate(`🤖 [StateGraph] 启动状态机执行...`);
            
            const result = await this.collaborationManager.executeWithStateGraph(userInput, systemPromptWithScene, (msg) => {
              if (onUpdate) onUpdate(msg);
            }, signal);
            return { content: result, references: [], intermediateMessages };
        }
        
        // 三段式管线模式：固定流程
        if (strategy === 'pipeline') {
            safeNotice(`📊 三段式管线启动：检索→分析→输出`);
            if (onUpdate) onUpdate(`📊 [Pipeline] 启动三段式管线...`);
            
            await maybeWriteTodoList([
              { id: 1, title: "Research", description: "检索/收集证据（知识库/文件/必要时 Web）", status: 'not-started' },
              { id: 2, title: "Analyze", description: "结构化整理与推理，提炼要点与约束", status: 'not-started' },
              { id: 3, title: "Write", description: "输出最终结果（报告/方案/结论）", status: 'not-started' },
            ]);
            const result = await this.collaborationManager.executePipeline(userInput, systemPromptWithScene, (msg) => {
              if (onUpdate) onUpdate(msg);
            });
            return { content: result, references: [], intermediateMessages };
        }
        
        // 慢思考模式：先规划后执行
        if (strategy === 'slow-thinking') {
            if (intent.level === 'ceo' || intent.level === 'pm') {
                const levelName = intent.level === 'ceo' ? "战略级" : "流程级";
                const icon = intent.level === 'ceo' ? "🏢 [CEO]" : "📋 [PM]";
                
                safeNotice(`${icon} 识别为${levelName}任务，正在规划...`);
                if (onUpdate) onUpdate(`🐢 [慢思考] 正在生成执行计划...`);
                
                const plan = await this.collaborationManager.generatePlan(userInput);
                await maybeWriteTodoList(
                  (plan.steps ?? []).map((s: any) => ({
                    id: typeof s?.id === 'number' ? s.id : Number.parseInt(String(s?.id || ''), 10) || 0,
                    title: `${String(s?.workerType || 'worker')}`,
                    description: String(s?.description || ''),
                    status: 'not-started' as const,
                  })).filter((t: any) => t.id > 0 && t.title)
                );

                const result = await this.collaborationManager.executePlan(plan, systemPromptWithScene, (msg) => {
                  if (onUpdate) onUpdate(msg);
                });

                return { content: result, references: [], intermediateMessages };
            } else if (intent.level === 'specialist') {
                const specialist = intent.assignedSpecialist || 'researcher';
                safeNotice(`🧑‍🔬 [专家] 任务已分派至 ${specialist} 部门`);
                
                const step: any = {
                    id: 1,
                    description: userInput,
                    workerType: specialist,
                    status: 'not-started',
                    dependencies: []
                };

                await maybeWriteTodoList([
                  { id: 1, title: `${specialist}`, description: userInput, status: 'not-started' },
                ]);
                
                const result = await this.collaborationManager.invokeSpecialist(step, "", systemPromptWithScene, (msg) => {
                    if (onUpdate) onUpdate(msg);
                });
                
                return { content: result, references: [], intermediateMessages };
            }
            // assistant 级别 fallthrough 到普通聊天
        }
        
        // 简单模式（默认）：根据意图路由到合适的模式
        if (strategy === 'simple') {
            if (intent.level === 'specialist') {
                const specialist = intent.assignedSpecialist || 'researcher';
                safeNotice(`🧑‍🔬 [${specialist}] 执行中...`);
                
                const step: any = {
                    id: 1,
                    description: userInput,
                    workerType: specialist,
                    status: 'not-started',
                    dependencies: []
                };
                
                const result = await this.collaborationManager.invokeSpecialist(step, "", systemPromptWithScene, (msg) => {
                    if (onUpdate) onUpdate(msg);
                });
                
                return { content: result, references: [], intermediateMessages };
            } else if (intent.level === 'pm' || intent.level === 'ceo') {
                // 简单模式下，复杂任务也用单专家处理
                const specialist = intent.assignedSpecialist || 'analyst';
                safeNotice(`🧑‍🔬 [${specialist}] 处理任务...`);
                
                const step: any = {
                    id: 1,
                    description: userInput,
                    workerType: specialist,
                    status: 'not-started',
                    dependencies: []
                };
                
                const result = await this.collaborationManager.invokeSpecialist(step, "", systemPromptWithScene, (msg) => {
                    if (onUpdate) onUpdate(msg);
                });
                
                return { content: result, references: [], intermediateMessages };
            }
            // assistant 级别 fallthrough 到普通聊天
        }
        
        // Fallthrough: assistant 级别或未匹配的情况，使用普通聊天
        if (intent.reasoning.includes("Fast track")) {
            effectiveModel = this.settings.routerModel;
        } else {
            effectiveModel = this.settings.writerModel;
        }
    }

    // 为非协作模式创建基础 systemPrompt（如果协作模式跳过，也需要场景感知）
    // 用户角色设定注入（UserPersona.description + settings）— 仅角色扮演时
    const userPersonaContext = isRoleplayCharacter ? this.getUserPersonaContext() : '';
    
    // 示例消息注入（exampleMessages → 对话范例参考）— 仅角色扮演时
    const exampleMessagesBlock = isRoleplayCharacter ? this.buildExampleMessagesBlock(activePersona) : '';

    // 世界状态上下文 — 仅角色扮演时注入（实时场景追踪）
    const worldStateBlock = isRoleplayCharacter ? worldStateContext : '';

    let systemPrompt: string;
    // DeepSeek 缓存优化：分离稳定核心与动态上下文
    let stableCorePrompt: string = '';
    let dynamicContextPrompt: string = '';

    if (isRoleplayCharacter) {
      // 角色扮演模式：使用结构化 prompt builder
      systemPrompt = await this.buildRoleplaySystemPrompt({
        persona: activePersona,
        datePrompt,
        userPersonaContext,
        exampleMessagesBlock,
        memoryContext,
        worldStateBlock,
        privateMemoryContext,
        mbtiPrompt,
        triggeredConsequencesBlock,
        fateEventsBlock,
        conversation: runtimeOptions?.conversation || null,
        stateMachineContext,
        graphRAGContext,
        messages: history.map(m => ({ role: m.role, content: m.content || '' })),
      });

      // 兜底：确保"角色扮演规则(信息隔离提示词)"一定被注入
      const isolationRules = String(this.settings.roleplayIsolationPrompt || DEFAULT_ROLEPLAY_ISOLATION_PROMPT).trim();
      if (isolationRules) {
        const alreadyInjected = systemPrompt.includes('【沉浸式开放世界角色扮演 - 核心规则】')
          || systemPrompt.includes('## 五、爽点与欲望递进约束')
          || systemPrompt.includes('爽点与欲望递进约束');
        if (!alreadyInjected) {
          systemPrompt = `${isolationRules}\n\n${systemPrompt}`;
        }
      }
      // 角色扮演：prompt 整体作为动态（内容过长且构建复杂，不单独拆分）
      // 但仍应用文风和占位符
      systemPrompt = this.replacePromptPlaceholders(systemPrompt, activePersona.name);
    } else {
      // 普通模式：拆分稳定核心（persona systemPrompt）与动态上下文
      const personaCore = this.replacePromptPlaceholders(activePersona.systemPrompt, activePersona.name);
      stableCorePrompt = applyStyleToSystemPrompt(personaCore, (activePersona as any).writingStyle);
      
      // 动态上下文：日期 + 记忆 + MBTI + 记忆规则 + 意图修饰
      let dynamicParts = datePrompt + memoryContext + privateMemoryContext + mbtiPrompt + memoryUsageRules;
      systemPrompt = stableCorePrompt + dynamicParts;
    }
    
    // 如果不是协作模式，进行本地意图分析以支持回应模式自适应
    if (mode !== 'collaboration' && !isRoleplayCharacter) {
        const { intentAnalyzer } = await import('./src/services/IntentAnalyzer');
        const analyzedIntent = intentAnalyzer.analyze({
            userInput,
            currentDate: new Date()
        });
        if (analyzedIntent.promptModifier) {
            systemPrompt += analyzedIntent.promptModifier;
            dynamicContextPrompt += analyzedIntent.promptModifier;
        }
    }
    
    // 应用文风设置（角色扮演已在上面处理，这里补动态部分）
    if (isRoleplayCharacter) {
      const styled = applyStyleToSystemPrompt(systemPrompt, (activePersona as any).writingStyle);
      systemPrompt = styled;
    } else {
      // 普通模式：stableCorePrompt 已应用文风，dynamicContextPrompt 也需应用
      const rawDynamic = datePrompt + memoryContext + privateMemoryContext + mbtiPrompt + memoryUsageRules;
      dynamicContextPrompt = applyStyleToSystemPrompt(rawDynamic, (activePersona as any).writingStyle);
      systemPrompt = stableCorePrompt + dynamicContextPrompt;
    }
    // 非角色扮演：替换占位符（角色扮演已在上面处理）
    if (!isRoleplayCharacter) {
      systemPrompt = this.replacePromptPlaceholders(systemPrompt, activePersona.name);
      dynamicContextPrompt = this.replacePromptPlaceholders(dynamicContextPrompt, activePersona.name);
    }

    // --- 智能体模式处理 ---
    if (mode === 'agent') {
      const result = await this.agentExecutor.execute({
        userInput,
        mode,
        history,
        context,
        images,
        onUpdate,
        onMeta,
        onRunSnapshot,
        signal,
        effectiveAgentId,
        effectiveModel,
        toolPolicyId: effectiveToolPolicyId,
        datePrompt,
        memoryContext,
        privateMemoryContext,
        memoryUsageRules,
        decisionState: runtimeOptions?.conversation?.decisionState,
      });
      this.triggerMemoryConsolidation(history, isCharacterEarly, userInput, personaId);
      return result;
    }

    // --- 普通/KB 聊天模式处理 ---
    const maxHistory = this.settings.maxHistoryMessages;
    // 排除当前最后一条消息（因为后面会手动 push 带有 context 的版本）
    // 如果 history 为空，则 historyWithoutCurrent 为空
    const historyWithoutCurrent = history.length > 0 ? history.slice(0, -1) : [];
    
    let slicedHistory: ChatMessage[] = [];
    if (maxHistory > 0) {
        // 如果 maxHistory 为 1，则不包含任何历史
        if (maxHistory > 1) {
            slicedHistory = historyWithoutCurrent.slice(-(maxHistory - 1));
        }
    } else {
        slicedHistory = historyWithoutCurrent;
    }

    // DeepSeek 缓存优化：分离稳定核心与动态上下文
    const systemMessagesForChat: ChatMessage[] = [];
    if (stableCorePrompt) {
      // 普通模式：稳定 persona 核心作为缓存锚点
      systemMessagesForChat.push({ role: 'system', content: stableCorePrompt, cacheAnchor: true });
      if (dynamicContextPrompt.trim()) {
        systemMessagesForChat.push({ role: 'system', content: dynamicContextPrompt.trim() });
      }
    } else {
      // 角色扮演模式：整体 prompt 合并发送
      systemMessagesForChat.push({ role: 'system', content: systemPrompt });
    }

    const messages: ChatMessage[] = [
      ...systemMessagesForChat,
      ...slicedHistory
    ];

    // postHistoryInstructions (UJB / Jailbreak) — 角色扮演时注入到历史之后、用户消息之前
    const postHistoryInstr = String((activePersona as any)?.postHistoryInstructions || '').trim();
    if (isRoleplayCharacter && postHistoryInstr) {
      messages.push({ role: 'system', content: this.replacePromptPlaceholders(postHistoryInstr, activePersona.name) });
    }

    let finalUserInput = userInput;
    let contextHeader = "";
    let references: any[] = [];

    if (context && context.trim().length > 0) {
      contextHeader += `请优先参考以下由用户手动提供的上下文信息:\n${context}\n`;
    }

    if (mode === 'kb') {
      if (!this.ragService.isReady()) {
        // Fallback to normal chat if index is not ready, instead of throwing error
        new Notice("⚠️ 知识库索引未就绪，已自动降级为普通聊天模式。");
        mode = 'normal';
      } else {
        // 从上下文中提取文件路径，传递给 RAG 搜索以让图扩展从当前笔记出发
        const contextFilePaths: string[] = [];
        if (context) {
          // 匹配 "--- 文件: [[xxx]] ---" 格式（getContextContent 输出 basename）
          const filePatterns = context.matchAll(/---\s*(?:文件|子文件):\s*(?:\[\[)?([^\]\n]+?)(?:\]\])?\s*---/g);
          for (const m of filePatterns) {
            const name = m[1]?.trim();
            if (!name) continue;
            // 将 basename 解析为完整 vault 路径
            const resolved = this.app.metadataCache.getFirstLinkpathDest(name, '');
            if (resolved) {
              contextFilePaths.push(resolved.path);
            }
          }
          // 也匹配 buildImplicitContextForMessage 输出的完整路径格式
          const pathPatterns = context.matchAll(/---\s*(?:当前打开笔记|引用笔记):\s*(.+?)\s*---/g);
          for (const m of pathPatterns) {
            const p = m[1]?.trim();
            if (p && !contextFilePaths.includes(p)) contextFilePaths.push(p);
          }
        }
        // 也加入当前活动文件（如果有的话）
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile && !contextFilePaths.includes(activeFile.path)) {
          contextFilePaths.push(activeFile.path);
        }

        const kbResults = await this.ragService.search(userInput, this.settings.retrievalCount, contextFilePaths);
        
        // Format Context — include section heading when available for more precise citation
        const kbContext = kbResults.map((item, index) => {
            const heading = this.resolveChunkSubpath(item.path, item.startOffset);
            const location = heading ? `${item.path} → ${heading.replace(/^#/, '')}` : item.path;
            return `[${index + 1}] ${location} (Score: ${item.similarity.toFixed(2)})\n${item.content}`;
        }).join('\n\n');

        references = kbResults.map(r => {
          const fileName = r.path.split('/').pop() || r.path;
          const subpath = this.resolveChunkSubpath(r.path, r.startOffset);
          const title = subpath ? `${fileName} › ${subpath.replace(/^#/, '')}` : fileName;
          return {
            title,
            path: r.path,
            score: r.similarity,
            startOffset: r.startOffset,
            endOffset: r.endOffset,
            subpath,
          };
        });

        if (kbContext && kbContext.trim().length > 0) {
          contextHeader += `另外，再参考以下从知识库中自动检索到的相关信息:\n${kbContext}\n`;
          contextHeader += `\n请根据上述信息回答用户的问题。
你的任务是：
1. 仔细阅读检索到的片段。
2. 如果用户询问“最新”或“最近”的内容，请优先查看 Score 较高且时间戳较新的片段。
3. 综合这些信息，给出一个连贯、详细的回答。
4. 如果信息中包含答案，请详细解答；如果信息不相关，请说明无法从知识库中找到答案。
5. 请直接开始回答，不要说“基于以上信息”之类的话。\n`;
          if (this.settings.showCitations) {
            contextHeader += `请在回答中引用上述信息时，严格使用 [1], [2] 等格式进行标注，不要重复引用内容，只标注序号。\n`;
          }
        }
      }
    }

    if (contextHeader.trim().length > 0) {
      finalUserInput = `${contextHeader}\n---\n基于以上所有信息，请回答这个问题: "${userInput}"`;
    }

    messages.push({ role: 'user', content: finalUserInput, images: images });

    const systemMessage = messages.find(m => m.role === 'system');
    const systemContent = typeof systemMessage?.content === 'string' ? systemMessage.content : '';
    logger.debug('AI', '[Prompt] Outbound prompt summary', {
      personaId: this.settings.activePersonaId,
      isRoleplayCharacter,
      messageCount: messages.length,
      systemLength: systemContent.length,
      containsRoleplayCoreRules: systemContent.includes('【沉浸式开放世界角色扮演 - 核心规则】'),
      containsPleasureProgressionRules: systemContent.includes('爽点与欲望递进约束'),
      containsUserPersonaContext: systemContent.includes('[用户角色设定]'),
      containsExampleMessages: systemContent.includes('[对话范例 - 角色语气和风格参考]'),
      containsWorldState: systemContent.includes('[场景]') || systemContent.includes('[近事]') || systemContent.includes('[线索]'),
      containsMemoryContext: systemContent.includes('[Memory Context]'),
      containsTriggeredConsequences: systemContent.includes('[本轮触发的延迟后果'),
      containsFateEvents: systemContent.includes('[天道 — 世界自行演化的事件，请自然融入叙事]'),
      hasPostHistoryInstructions: isRoleplayCharacter && !!String((activePersona as any)?.postHistoryInstructions || '').trim(),
      userInputLength: String(finalUserInput || '').length,
    });

    const promptEstimate = estimateTokensFromMessages(messages);
    if (onMeta) onMeta({ contextTokensEstimate: promptEstimate, mode, model: effectiveModel });

    const response = await this.llmService.getCompletion(messages, effectiveModel, undefined, onUpdate, signal);

    if (!response.content || response.content.trim().length === 0) {
        response.content = "抱歉，AI 未能生成有效回答。这可能是因为检索到的上下文过多导致超出模型限制，或者模型响应异常。建议您尝试缩小提问范围。";
    }

    // --- Immersion Check (Async) ---
    // 角色扮演模式：检测 OOC、叙事视角、情绪连贯性
    if (isRoleplayCharacter && response.content) {
      this.checkImmersion(response.content, personaId, activePersona.systemPrompt).catch((e: any) => {
        logger.warn("Immersion", "[Immersion Check] Failed to check immersion", e);
      });
    }
    
    // --- Memory Consolidation (Async) ---
    this.triggerMemoryConsolidation(history, isCharacterEarly, userInput, personaId);

    return { content: response.content || "", references, reasoning_content: response.reasoning_content, meta: { contextTokensEstimate: promptEstimate } };
  }


  private triggerMemoryConsolidation(history: ChatMessage[], isCharacterEarly: boolean, userInput: string, personaId: string) {
  // --- Memory Consolidation (Async) ---
  if (this.settings.enableMemory) {
    const extractionInterval = this.settings.roleplayExtractionInterval || 5;
    const worldUpdateInterval = Math.max(2, Math.floor(extractionInterval / 2));

    // 非角色扮演模式才做用户画像提取；角色扮演场景下这类提取收益低、误判成本高
    if (!isCharacterEarly) {
    this.memoryManager.extractFacts(userInput, personaId, history);
    }
    
    // 扮演类角色：世界状态更新 — 异步执行（含 LLM 调用 extractSceneDelta）
    // 不阻塞回复，为下一轮对话准备最新世界状态；按较短间隔节流，避免每轮都重复分析
    if (isCharacterEarly && history.length >= 2 && history.length % worldUpdateInterval === 0) {
    this.worldStateManager.updateWorldState(history, personaId).then(async (result) => {
      // 世界心智框架：后置异步演化（允许 LLM 调用，不阻塞当前回复）
      let state = result.state;
      state = this.director.tick(state);
      state = this.spatialGraph.syncFromScene(state);
      state = this.emotionalSpectrumEngine.tick(state);
      state = await this.npcPsycheEngine.updatePsychesFromDialogue(state, history, personaId);
      state = this.emergentHooks.derive(state);
      state = this.emergentHooks.markEngagedByTimeline(state);
      // 仅迁移本轮 applyDelta 新增的 pendingConsequences，不再二次 tick（pre-request 已处理）
      state = this.causalWeb.migrateLegacyPending(state);

      await this.worldStateManager.saveState(personaId, state);

      // 导演系统 + 天道：由导演决策是否触发天道事件
      const decision = this.director.decideFateTrigger(state, this.settings.fateFrequency || 3);
      if (this.settings.enableFateSystem && decision.shouldTriggerFate && this.fateEngine.shouldTrigger(state.currentTurn)) {
        await this.fateEngine.generateFateEvents(personaId, history);

        // 记录天道触发对导演预算的消耗
        const latest = await this.worldStateManager.loadState(personaId);
        const consumed = this.director.recordFateTriggered(latest, decision.recommendedIntensity);
        await this.worldStateManager.saveState(personaId, consumed);
      }
    }).catch(e => {
      logger.warn("AI", "[WorldState] Post-response update failed", e);
    });
    }
    
    // --- Graph RAG & State Machine Updates (Async) ---
    // 角色扮演模式：每 5 轮更新状态机
    if (isCharacterEarly && history.length % 5 === 0) {
      this.memoryManager.updateCharacterState(history, personaId).catch((e: any) => {
        logger.warn("StateMachine", "[State Update] Failed to update character state", e);
      });
    }

    // 角色扮演模式：每 10 轮提取知识图谱
    if (isCharacterEarly && history.length % 10 === 0) {
      this.memoryManager.extractKnowledgeGraph(history, personaId).catch((e: any) => {
        logger.warn("GraphRAG", "[Graph Extraction] Failed to extract knowledge graph", e);
      });
    }

    // 角色扮演模式：每 20 轮检测性格演进
    if (isCharacterEarly && history.length % 20 === 0) {
      this.memoryManager.detectAndApplyPersonalityEvolution(history, personaId).catch((e: any) => {
        logger.warn("PersonalityEvolution", "[Evolution Check] Failed to detect personality evolution", e);
      });
    }
    
    // Check if we need to summarize (e.g. every 10 turns)
    if (history.length % 10 === 0) {
      const projectKeyOverride = String(this.settings.memoryProjectKeyOverride || "").trim();
      const activeFile = this.app.workspace.getActiveFile();
      const activePath = String(activeFile?.path || "");
      const derivedProjectKey = activePath.includes('/') ? (activePath.split('/')[0] || 'root') : 'root';
      const projectKey = projectKeyOverride || derivedProjectKey;

      this.memoryManager.summarizeConversation(history, personaId, projectKey);
    }
  }

  }

  /**
   * 检测 AI 回复的沉浸感问题
   */
  private async checkImmersion(response: string, personaId: string, systemPrompt: string): Promise<void> {
    try {
      // 推断 OOC 配置
      const oocConfig = this.memoryManager.immersion.inferOOCConfig(systemPrompt);
      
      // 获取叙事风格
      const narrativeStyle = this.memoryManager.immersion.getNarrativeStyle(personaId, systemPrompt);
      
      // 获取上一次情绪
      const previousEmotion = this.memoryManager.immersion.getCurrentEmotion(personaId);
      
      // 执行沉浸感检测
      const result = await this.memoryManager.immersion.checkImmersion(response, personaId, {
        oocConfig,
        narrativeStyle,
        previousEmotion: previousEmotion || undefined,
        checkEmotion: true,
      });
      
      // 如果检测未通过，记录警告
      if (!result.passed) {
        logger.warn('Immersion', `沉浸感检测未通过 (评分: ${result.score}/100)`, {
          oocIssues: result.oocIssues.length,
          perspectiveIssues: result.perspectiveIssues.length,
          emotionIssues: result.emotionIssues.length,
          suggestions: result.suggestions,
        });
        
        // 可选：显示通知给用户
        if (result.score < 40) {
          // 严重问题才通知
          new Notice(`⚠️ AI 回复可能存在出戏问题 (${result.suggestions[0] || '请检查'})`);
        }
      }
    } catch (error) {
      logger.error('Immersion', '沉浸感检测失败', error);
    }
  }

  async loadConversationsData() {
    try {
      const adapter = this.app.vault.adapter;

      // Prefer v2 sharded storage.
      this.conversationStoreV2 = new ConversationStoreV2({
        adapter,
        baseDir: this.conversationV2BaseDir,
        indexPath: this.conversationV2IndexPath,
      });

      await this.conversationStoreV2.ensureBaseDir();

      const v2IndexExists = await adapter.exists(this.conversationV2IndexPath);

      // If v2 index doesn't exist yet, migrate from legacy (v1) if present.
      if (!v2IndexExists) {
        // Ensure legacy folder exists (for reading old file, if any).
        const legacyFolder = this.conversationFilePath.split('/').slice(0, -1).join('/');
        if (legacyFolder && !(await adapter.exists(legacyFolder))) {
          await adapter.mkdir(legacyFolder).catch(() => {});
        }

        // One-time migration from legacy location inside plugin dir.
        const legacyPluginDirPath = `${this.manifest.dir}/conversations.json`;
        if (!(await adapter.exists(this.conversationFilePath)) && (await adapter.exists(legacyPluginDirPath))) {
          try {
            const legacyRaw = await adapter.read(legacyPluginDirPath);
            const legacyParsed = JSON.parse(legacyRaw);
            await adapter.write(this.conversationFilePath, JSON.stringify(legacyParsed ?? {}, null, 2));
          } catch (e) {
            logger.warn("Database", "迁移旧对话历史失败", e);
          }
        }

        if (await adapter.exists(this.conversationFilePath)) {
          try {
            const raw = await adapter.read(this.conversationFilePath);
            const parsed = JSON.parse(raw) as Record<string, Conversation>;
            const index: ConversationIndex = {};

            for (const conv of Object.values(parsed ?? {})) {
              if (!conv?.id) continue;
              const conversation: Conversation = {
                ...conv,
                history: Array.isArray(conv.history) ? conv.history : [],
                historyLoaded: true,
                ...buildConversationSummary(Array.isArray(conv.history) ? conv.history : []),
                messageCount: Array.isArray(conv.history) ? conv.history.length : 0,
              };

              const rewriteRes = await this.conversationStoreV2.rewriteHistory(conversation.id, conversation.history);
              await this.conversationStoreV2.writeMeta(conversation, rewriteRes.lastPart, rewriteRes.messageCount);

              index[conversation.id] = {
                id: conversation.id,
                title: conversation.title,
                model: conversation.model,
                todoList: conversation.todoList,
                lastContextTokensEstimate: conversation.lastContextTokensEstimate,
                pinned: conversation.pinned,
                starred: conversation.starred,
                archived: conversation.archived,
                tags: conversation.tags,
                templateId: conversation.templateId,
                createdAt: conversation.createdAt,
                updatedAt: conversation.updatedAt,
                personaId: conversation.personaId,
                agentId: conversation.agentId,
                toolPolicyId: conversation.toolPolicyId,
                modelSource: conversation.modelSource,
                uiEntryMode: conversation.uiEntryMode,
                roleplayState: conversation.roleplayState,
                previewText: conversation.previewText,
                firstUserText: conversation.firstUserText,
                lastPart: rewriteRes.lastPart,
                messageCount: rewriteRes.messageCount,
              };

              this.conversationPersistState[conversation.id] = {
                historyLength: conversation.history.length,
                lastPart: rewriteRes.lastPart,
              };
            }

            await this.conversationStoreV2.writeIndex(index);
          } catch (e) {
            logger.error("Database", "v1->v2 迁移失败", e);
          }
        }
      }

      // Load v2 index into memory (history is lazy-loaded).
      this.conversationIndexV2 = await this.conversationStoreV2.loadIndex();
      this.conversations = {};
      for (const entry of Object.values(this.conversationIndexV2)) {
        const conv: Conversation = {
          id: entry.id,
          title: entry.title,
          history: [],
          historyLoaded: false,
          model: entry.model,
          todoList: entry.todoList,
          lastContextTokensEstimate: entry.lastContextTokensEstimate,
          pinned: entry.pinned,
          starred: entry.starred,
          archived: entry.archived,
          tags: entry.tags,
          templateId: entry.templateId,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
          personaId: entry.personaId,
          agentId: entry.agentId,
          toolPolicyId: entry.toolPolicyId,
          modelSource: entry.modelSource,
          uiEntryMode: normalizeEntryMode(entry.uiEntryMode),
            decisionState: entry.decisionState,
            roleplayState: entry.roleplayState,
            messageCount: entry.messageCount,

          previewText: entry.previewText,
          firstUserText: entry.firstUserText,
        };
        this.conversations[conv.id] = conv;
        this.conversationPersistState[conv.id] = {
          historyLength: 0,
          lastPart: entry.lastPart || 1,
        };
      }

      return;
    } catch (e) {
      logger.error("Database", "加载对话历史失败", e);
      this.conversations = {};
    }
  }

  async saveConversations(conversations: Record<string, Conversation>, opts?: { force?: boolean }) {
    // 序列化所有保存操作，防止并发写入导致 index 损坏
    this._saveLock = this._saveLock.then(() => this._doSaveConversations(conversations, opts)).catch(() => {});
    return this._saveLock;
  }

  private async _doSaveConversations(conversations: Record<string, Conversation>, opts?: { force?: boolean }) {
    this.conversations = conversations;
    try {
      if (!this.conversationStoreV2) {
        const adapter = this.app.vault.adapter;
        this.conversationStoreV2 = new ConversationStoreV2({
          adapter,
          baseDir: this.conversationV2BaseDir,
          indexPath: this.conversationV2IndexPath,
        });
      }

      const store = this.conversationStoreV2;
      const nextIndex: ConversationIndex = {};

      for (const conv of Object.values(this.conversations ?? {})) {
        if (!conv?.id) continue;

        const prev = this.conversationIndexV2?.[conv.id];
        const state = this.conversationPersistState[conv.id] ?? { historyLength: 0, lastPart: prev?.lastPart || 1 };

        let lastPart = state.lastPart || prev?.lastPart || 1;
        let messageCount = prev?.messageCount ?? 0;

        // Persist meta even if history not loaded.
        const historyLoaded = conv.historyLoaded === true;

        if (historyLoaded) {
          const summary = buildConversationSummary(conv.history ?? []);
          conv.previewText = summary.previewText;
          conv.firstUserText = summary.firstUserText;
          conv.messageCount = Array.isArray(conv.history) ? conv.history.length : 0;
        } else {
          conv.previewText = conv.previewText ?? prev?.previewText ?? "";
          conv.firstUserText = conv.firstUserText ?? prev?.firstUserText ?? "";
          conv.messageCount = conv.messageCount ?? prev?.messageCount ?? messageCount;
        }

        if (!historyLoaded) {
          await store.writeMeta(conv, lastPart, messageCount);
          nextIndex[conv.id] = {
            id: conv.id,
            title: conv.title,
            model: conv.model,
            todoList: conv.todoList,
            lastContextTokensEstimate: conv.lastContextTokensEstimate,
            pinned: conv.pinned,
            starred: conv.starred,
            archived: conv.archived,
            tags: conv.tags,
            templateId: conv.templateId,
            createdAt: conv.createdAt,
            updatedAt: conv.updatedAt,
            personaId: conv.personaId,
            agentId: conv.agentId,
            toolPolicyId: conv.toolPolicyId,
            modelSource: conv.modelSource,
            uiEntryMode: normalizeEntryMode(conv.uiEntryMode),
             decisionState: conv.decisionState,
             roleplayState: conv.roleplayState,
             previewText: conv.previewText,

            firstUserText: conv.firstUserText,
            lastPart,
            messageCount,
          };
          this.conversationPersistState[conv.id] = state;
          continue;
        }

        const currentLen = Array.isArray(conv.history) ? conv.history.length : 0;
        const forceRewrite = this.conversationForceRewrite.has(conv.id) || currentLen < state.historyLength;

        if (forceRewrite || !prev) {
          const rewriteRes = await store.rewriteHistory(conv.id, conv.history ?? []);
          lastPart = rewriteRes.lastPart;
          messageCount = rewriteRes.messageCount;
          this.conversationPersistState[conv.id] = { historyLength: currentLen, lastPart };
          this.conversationForceRewrite.delete(conv.id);
        } else if (currentLen > state.historyLength) {
          const delta = (conv.history ?? []).slice(state.historyLength);
          const appendRes = await store.appendMessages(conv.id, lastPart, delta);
          lastPart = appendRes.lastPart;
          messageCount = Math.max(messageCount, state.historyLength) + appendRes.messageCountAppended;
          this.conversationPersistState[conv.id] = { historyLength: currentLen, lastPart };
        } else {
          // No history changes.
          messageCount = prev?.messageCount ?? currentLen;
          this.conversationPersistState[conv.id] = { historyLength: state.historyLength, lastPart };
        }

        await store.writeMeta(conv, lastPart, messageCount);
        nextIndex[conv.id] = {
          id: conv.id,
          title: conv.title,
          model: conv.model,
          todoList: conv.todoList,
          lastContextTokensEstimate: conv.lastContextTokensEstimate,
          pinned: conv.pinned,
          starred: conv.starred,
          archived: conv.archived,
          tags: conv.tags,
          templateId: conv.templateId,
          createdAt: conv.createdAt,
          updatedAt: conv.updatedAt,
          personaId: conv.personaId,
          agentId: conv.agentId,
          toolPolicyId: conv.toolPolicyId,
          modelSource: conv.modelSource,
          uiEntryMode: normalizeEntryMode(conv.uiEntryMode),
           decisionState: conv.decisionState,
           roleplayState: conv.roleplayState,
           previewText: conv.previewText,

          firstUserText: conv.firstUserText,
          lastPart,
          messageCount,
        };
      }

      await store.writeIndex(nextIndex, { force: opts?.force });
      this.conversationIndexV2 = nextIndex;
    } catch (e) {
      logger.error("Database", "保存对话历史失败", e);
    }
  }

  async loadConversations(): Promise<Record<string, Conversation>> {
    return this.conversations || {};
  }

  public markConversationHistoryForRewrite(conversationId: string) {
    if (!conversationId) return;
    this.conversationForceRewrite.add(conversationId);
  }

  public async ensureConversationHistoryLoaded(conversationId: string): Promise<void> {
    const conv = this.conversations?.[conversationId];
    if (!conv) return;
    if (conv.historyLoaded) return;

    const store = this.conversationStoreV2;
    if (!store) return;

    const entry = this.conversationIndexV2?.[conversationId];
    const lastPart = entry?.lastPart || this.conversationPersistState?.[conversationId]?.lastPart || 1;

    const history = await store.loadFullHistory(conversationId, lastPart);
    conv.history = history;
    conv.historyLoaded = true;
    const summary = buildConversationSummary(history);
    conv.previewText = summary.previewText;
    conv.firstUserText = summary.firstUserText;
    conv.messageCount = history.length;

    this.conversationPersistState[conversationId] = {
      historyLength: history.length,
      lastPart,
    };
  }

  public async getLatestConversationTail(limit: number): Promise<{ conversation: Conversation; history: import('./src/core/types').ChatMessage[] } | null> {
    const entries = Object.values(this.conversationIndexV2 ?? {});
    if (!entries.length || !this.conversationStoreV2) return null;

    const latest = entries.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    const conv = this.conversations?.[latest.id];
    if (!conv) return null;
    const history = await this.conversationStoreV2.loadHistoryTail(latest.id, latest.lastPart || 1, limit);
    return { conversation: conv, history };
  }

  public getConversations(): Record<string, Conversation> {
    return this.conversations;
  }


  public isCollaborationModeAvailable(): boolean {
    return Boolean(this.settings.enableExperimentalCollaborationMode && this.settings.enableCollaboration);
  }

  public resolveConversationModel(conversation: Conversation | null | undefined, mode: 'normal' | 'kb' | 'search' | 'agent' | 'collaboration' | 'groupchat', agentId?: string | null): { model: string; source: import('./src/core/types').ConversationModelSource } {
    const normalizedMode = mode === 'search' ? 'kb' : mode === 'groupchat' ? 'normal' : mode;
    const normalizedAgentId = String(agentId || conversation?.agentId || this.settings.activeAgentId || '').trim();
    const agent = normalizedMode === 'agent' && normalizedAgentId ? this.agentManager.getAgent(normalizedAgentId) : undefined;
    const agentModel = String(agent?.model || '').trim();
    if (agentModel) return { model: agentModel, source: 'agent' };

    const conversationModel = String(conversation?.model || '').trim();
    if (conversationModel) return { model: conversationModel, source: 'conversation' };

    const modeModels = this.settings.modeModels || { normal: '', kb: '', agent: '', collaboration: '' };
    const modeDefault = String((modeModels as any)[normalizedMode] || '').trim();
    if (modeDefault) return { model: modeDefault, source: 'mode-default' };

    const fallback = String(this.settings.defaultChatModel || this.settings.routerModel || this.settings.chatModels.split(',')[0] || 'gpt-3.5-turbo').trim();
    return { model: fallback, source: 'default-chat' };
  }

  public resolveConversationToolPolicy(conversation: Conversation | null | undefined, agentId?: string | null, fallbackPolicyId?: string | null): string {
    const normalizedAgentId = String(agentId || conversation?.agentId || this.settings.activeAgentId || '').trim();
    const agent = normalizedAgentId ? this.agentManager.getAgent(normalizedAgentId) as any : null;
    
    // 如果是自定义智能体，默认返回 default 策略（不限制工具），除非它显式配置了别的策略
    if (agent && !agent.isPreset) {
      const agentPolicy = String(agent?.toolPolicyId || agent?.defaultToolPolicyId || '').trim();
      return agentPolicy || 'default';
    }

    const fallback = String(fallbackPolicyId || '').trim();
    if (fallback) return fallback;

    const agentPolicy = String(agent?.toolPolicyId || agent?.defaultToolPolicyId || '').trim();
    if (agentPolicy) return agentPolicy;

    // Legacy compatibility only: older conversations may still carry a persisted toolPolicyId.
    // Do not let it override the current runtime preset/agent selection by default.
    const convPolicy = String(conversation?.toolPolicyId || '').trim();
    if (convPolicy) return convPolicy;

    return String(this.settings.activePresetId || 'default').trim() || 'default';
  }

  private matchExplicitSkillCommand(userInput: string): { skillId: string; skillName: string; payload: string } | null {
    const normalized = String(userInput || '').trim();
    if (!normalized.startsWith('/') || !this.skillRegistry) return null;

    const match = this.skillRegistry.matchSkill(normalized);
    if (!match || match.matchedTrigger?.type !== 'command') return null;

    const commands = Array.isArray(match.matchedTrigger.value)
      ? match.matchedTrigger.value
      : [match.matchedTrigger.value];
    const lowered = normalized.toLowerCase();

    for (const rawCommand of commands) {
      const command = String(rawCommand || '').trim().toLowerCase();
      if (!command) continue;
      const prefix = `/${command}`;
      if (lowered === prefix) {
        return { skillId: match.skill.id, skillName: match.skill.name, payload: '' };
      }
      if (lowered.startsWith(`${prefix} `)) {
        return {
          skillId: match.skill.id,
          skillName: match.skill.name,
          payload: normalized.slice(prefix.length).trim(),
        };
      }
    }

    return {
      skillId: match.skill.id,
      skillName: match.skill.name,
      payload: normalized,
    };
  }

  private async activateView() {
    const { workspace } = this.app;

    let leaf = workspace.getLeavesOfType(VIEW_TYPE_AI_CHAT)[0];

    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        await rightLeaf.setViewState({
          type: VIEW_TYPE_AI_CHAT,
          active: true,
        });
        leaf = workspace.getLeavesOfType(VIEW_TYPE_AI_CHAT)[0];
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  async activateSmartContextView() {
    const { workspace } = this.app;

    let leaf = workspace.getLeavesOfType(VIEW_TYPE_SMART_CONTEXT)[0];

    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        await rightLeaf.setViewState({
          type: VIEW_TYPE_SMART_CONTEXT,
          active: true,
        });
        leaf = workspace.getLeavesOfType(VIEW_TYPE_SMART_CONTEXT)[0];
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  async loadSettings() {
    const raw = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);

    let changed = false;
    changed = SettingsMigrator.migrateApiConfig(this.settings) || changed;
    changed = SettingsMigrator.migrateMcpTools(this.settings, raw) || changed;
    changed = SettingsMigrator.migrateCollaborationSettings(this.settings, raw) || changed;
    if (changed) {
      // Persist migrated settings, but keep any unknown keys from raw.
      await this.saveData(Object.assign({}, raw, this.settings));
    }
  }

  /**
   * 初始化技能系统
   */
  private async initializeSkillsSystem(): Promise<void> {
    if (!this.skillRegistry) return;

    logger.info("Skills", "Initializing skills system...");

    // 1. 设置技能文件夹路径
    const skillFolderPath = this.settings.skillFolderPath || "Skills";
    this.skillRegistry.setSkillFolderPath(skillFolderPath);

    // 2. 注册内置技能
    const builtinSkills = getBuiltinSkills();
    for (const skill of builtinSkills) {
      // 检查是否被禁用
      if (this.settings.disabledBuiltinSkills?.includes(skill.id)) {
        skill.enabled = false;
      }
      this.skillRegistry.registerSkill(skill);
    }

    logger.info("Skills", `Registered ${builtinSkills.length} builtin skills`);

    // 3. 从文件夹加载技能
    await this.skillRegistry.loadSkillsFromFolder();

    // 4. 启用热重载（如果配置了）
    if (this.settings.skillHotReload) {
      this.skillRegistry.enableHotReload();
    }

    // 5. 兼容旧版本：加载本地自定义技能（JSON 格式）
    // 这些技能应该迁移到文件夹格式
    for (const skillJson of this.settings.localSkills || []) {
      try {
        const skill = JSON.parse(skillJson);
        skill.source = 'local';
        this.skillRegistry.registerSkill(skill);
      } catch (e) {
        logger.warn("Skills", "Failed to parse local skill", { error: e });
      }
    }

    logger.info("Skills", "Skills system initialized", {
      total: this.skillRegistry.getAllSkills().length,
      enabled: this.skillRegistry.getEnabledSkills().length,
      folderPath: skillFolderPath,
      hotReload: this.settings.skillHotReload
    });
  }

  public refreshAgentRuntimeState(): void {
    this.agentManager?.loadAgentsFromSettings(
      this.settings.customAgents,
      this.settings.hiddenPresetAgentIds || [],
      this.settings.personas,
    );
  }

  async saveSettings() {
    this.settings.mcpTools = normalizeMcpToolsList(this.settings.mcpTools);
    
    // 确保 savedWritingStyles 是数组
    if (!Array.isArray(this.settings.savedWritingStyles)) {
      this.settings.savedWritingStyles = [];
    }
    
    // 确保 connections 是数组
    if (!Array.isArray(this.settings.connections)) {
      this.settings.connections = [];
    }
    
    // 直接保存 settings，不要从磁盘读取旧数据再合并
    // 因为 loadData 可能读到旧的缓存
    try {
      await this.saveData(this.settings);
      this.refreshAgentRuntimeState();

      // 验证保存
      const verify = await this.loadData();
    } catch (e) {
      console.error('[Settings] Save error:', e);
    }
    
    // Notify views to refresh
    this.app.workspace.getLeavesOfType(VIEW_TYPE_AI_CHAT).forEach(leaf => {
      if (leaf.view instanceof AiChatView) {
        leaf.view.refreshPersonaSelector();
        leaf.view.refreshModelSelector();
      }
    });
  }


  /**
   * 格式化步骤执行摘要，将详细执行过程折叠
   */
  private formatStepSummary(
    stepHeader: string,
    instruction: string,
    result: string,
    stepMessages: ChatMessage[],
    hasToolCalls: boolean
  ): string {
    const trace = this.buildStepExecutionTrace(stepHeader, instruction, result, stepMessages);
    const toolCalls = trace.toolCalls.map(item => item.name);
    const showVerboseLogs = this.settings.showToolLogs;

    // 构建折叠的执行详情
    let content = `<step-summary>\n`;
    content += `<execution-trace>${JSON.stringify(trace)}</execution-trace>\n`;
    content += `### ${stepHeader}\n\n`;
    
    if (toolCalls.length > 0) {
      content += `**使用工具**: ${[...new Set(toolCalls)].map(n => this.agentManager.getToolLabel(n)).join(', ')}\n\n`;
    }

    const primaryToolResult = trace.toolResults.find(item => item.status === 'verified')
      || trace.toolResults.find(item => item.status === 'error')
      || trace.toolResults[0];
    const verifiedToolResults = trace.toolResults.filter(item => item.status === 'verified');
    const shouldPreferStructuredResult = !!primaryToolResult && toolCalls.length > 0;
    const normalizedResult = String(result || '').trim();

    // 主要结果
    if (shouldPreferStructuredResult) {
      if (verifiedToolResults.length > 1) {
        const verifiedSummaries = verifiedToolResults
          .map(item => item.summary)
          .filter(Boolean);
        const touchedFiles = Array.from(new Set(
          verifiedSummaries
            .map(summary => {
              const match = summary.match(/([\w\u4e00-\u9fa5 _-]+\.md)/);
              return match ? match[1] : '';
            })
            .filter(Boolean)
        ));
        const fileSummary = touchedFiles.length > 0
          ? `已验证写入 ${touchedFiles.length} 个目标：${touchedFiles.join('、')}`
          : `已验证完成 ${verifiedToolResults.length} 次写入`;
        content += `**执行结果**: 已验证 · ${fileSummary}\n`;
      } else {
        const statusLabel = primaryToolResult.status === 'verified'
          ? '已验证'
          : primaryToolResult.status === 'error'
            ? '未完成'
            : primaryToolResult.status === 'denied'
              ? '未授权'
              : '已执行';
        content += `**执行结果**: ${statusLabel} · ${primaryToolResult.summary}\n`;
      }
      if (normalizedResult && primaryToolResult.status !== 'verified' && !/连续两轮未产生任何工具动作/.test(normalizedResult)) {
        content += `\n${normalizedResult}\n`;
      }
    } else if (normalizedResult) {
      content += `${normalizedResult}\n`;
    }
    
    // 执行详情折叠（只在有工具调用时显示）
    if (showVerboseLogs && hasToolCalls && stepMessages.length > 1) {
      content += `\n<details>\n<summary>📋 执行详情 (${stepMessages.length} 条消息)</summary>\n\n`;
      
      for (const msg of stepMessages) {
        if (msg.role === 'tool') {
          const toolContent = String(msg.content || '').slice(0, 500);
          content += `**🔧 ${this.agentManager.getToolLabel(msg.name || '') || '工具'}**: ${toolContent}${msg.content && msg.content.length > 500 ? '...' : ''}\n\n`;
        }
      }
      
      content += `</details>\n`;
    }
    
    content += `</step-summary>`;
    
    return content;
  }

  private buildStepExecutionTrace(
    stepHeader: string,
    instruction: string,
    result: string,
    stepMessages: ChatMessage[]
  ): {
    stepHeader: string;
    instruction: string;
    resultPreview: string;
    toolCalls: Array<{ name: string; label: string }>;
    evidence: Array<{ label: string; value: string; kind: string }>;
    toolResults: Array<{ toolName: string; label: string; status: string; summary: string }>;
  } {
    const toolCalls: Array<{ name: string; label: string }> = [];
    const evidence: Array<{ label: string; value: string; kind: string }> = [];
    const toolResults: Array<{ toolName: string; label: string; status: string; summary: string }> = [];
    const seenEvidence = new Set<string>();

    const pushEvidence = (label: string, value: unknown, kind: string) => {
      const normalized = String(value || '').trim();
      if (!normalized) return;
      const key = `${kind}::${label}::${normalized}`;
      if (seenEvidence.has(key)) return;
      seenEvidence.add(key);
      evidence.push({ label, value: normalized, kind });
    };

    const parseArgs = (raw: any): any => {
      if (raw === null || raw === undefined) return {};
      if (typeof raw === 'object') return raw;
      try {
        return JSON.parse(String(raw));
      } catch {
        return {};
      }
    };

    for (const msg of stepMessages) {
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const name = String(tc?.function?.name || '未知工具');
          toolCalls.push({ name, label: this.agentManager.getToolLabel(name) || name });

          const args = parseArgs(tc?.function?.arguments);
          pushEvidence('path', args.path, 'path');
          pushEvidence('sourcePath', args.sourcePath, 'path');
          pushEvidence('destinationPath', args.destinationPath, 'path');
          pushEvidence('folderPath', args.folderPath, 'path');
          pushEvidence('url', args.url, 'url');
          pushEvidence('query', args.query, 'query');
          pushEvidence('commandId', args.commandId, 'command');
          pushEvidence('symbol', args.symbol || args.symbolName, 'symbol');
        }
      }

      if (msg.role === 'tool') {
        const toolName = String(msg.name || 'tool');
        const toolLabel = this.agentManager.getToolLabel(toolName) || toolName;
        const content = String(msg.content || '');
        let status = 'ok';
        if (/权限拒绝|denied/i.test(content)) status = 'denied';
        else if (/\[Verify\]\s*失败|工具执行出错|错误:/i.test(content)) status = 'error';
        else if (/\[Verify\]\s*通过/i.test(content)) status = 'verified';

        const summary = content
          .replace(/```[\s\S]*?```/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 160);
        toolResults.push({ toolName, label: toolLabel, status, summary });
      }
    }

    return {
      stepHeader,
      instruction,
      resultPreview: String(result || '').replace(/\s+/g, ' ').trim().slice(0, 220),
      toolCalls: Array.from(new Map(toolCalls.map(item => [item.name, item])).values()),
      evidence: evidence.slice(0, 12),
      toolResults,
    };
  }

  /**
   * 触发工具执行失败后的反思
   * 异步执行，不阻塞主流程
   */
  private async triggerToolReflection(
    toolName: string,
    toolArgs: any,
    errorMessage: string,
    contextMessages: ChatMessage[]
  ): Promise<void> {
    const reflectionMgr = getReflectionManager();
    
    try {
      // 生成反思 Prompt
      const reflectionPrompt = reflectionMgr.generateReflectionPrompt({
        toolName,
        toolArgs,
        errorMessage,
      });

      // 使用快速模型进行反思（避免浪费 token）
      const reflectionModel = this.settings.writerModel || this.settings.defaultChatModel || 'gpt-3.5-turbo';
      
      const response = await this.llmService.getCompletion(reflectionPrompt, reflectionModel);
      const parsed = reflectionMgr.parseReflectionResponse(response?.content || '');
      
      if (parsed) {
        reflectionMgr.addReflection({
          trigger: 'tool_error',
          context: {
            toolName,
            toolArgs,
            errorMessage,
          },
          reflection: parsed.rootCause,
          lesson: parsed.lesson,
          preventionStrategy: parsed.preventionStrategy,
        });
        
        logger.info("Reflection", `Tool error reflected: ${parsed.lesson}`);
      }
    } catch (e) {
      // 反思失败不影响主流程
      logger.warn("Reflection", "Reflection failed", e);
    }
  }

  /**
   * 用户反馈触发的反思
   * 当检测到用户表达不满时调用
   */
  public async triggerUserFeedbackReflection(
    userFeedback: string,
    recentHistory: ChatMessage[]
  ): Promise<void> {
    const reflectionMgr = getReflectionManager();
    
    // 只有当用户真的表达不满时才触发
    if (!reflectionMgr.isNegativeFeedback(userFeedback)) {
      return;
    }
    
    try {
      // 提取之前的操作
      const previousActions = recentHistory
        .filter(m => m.role === 'assistant' || m.role === 'tool')
        .slice(-5)
        .map(m => {
          if (m.role === 'tool') {
            return `[工具: ${m.name}] ${String(m.content || '').slice(0, 100)}`;
          }
          return String(m.content || '').slice(0, 200);
        })
        .join('\n');

      const reflectionPrompt = reflectionMgr.generateReflectionPrompt({
        userFeedback,
        previousActions,
      });

      const reflectionModel = this.settings.writerModel || this.settings.defaultChatModel || 'gpt-3.5-turbo';
      const response = await this.llmService.getCompletion(reflectionPrompt, reflectionModel);
      const parsed = reflectionMgr.parseReflectionResponse(response?.content || '');
      
      if (parsed) {
        reflectionMgr.addReflection({
          trigger: 'user_feedback',
          context: {
            userFeedback,
          },
          reflection: parsed.rootCause,
          lesson: parsed.lesson,
          preventionStrategy: parsed.preventionStrategy,
        });
        
        logger.info("Reflection", `User feedback reflected: ${parsed.lesson}`);
      }
    } catch (e) {
      logger.warn("Reflection", "User feedback reflection failed", e);
    }
  }

  public refreshAutoIndexScheduler(): void {
    this.initAutoIndexScheduler();
  }

  /**
   * 初始化自动索引调度器
   */
  private initAutoIndexScheduler() {
    // 清理旧的定时器
    this.clearAutoIndexTimers();
    
    if (!this.settings.autoIndexEnabled) {
      return;
    }
    
    // 设置间隔更新
    const intervalMinutes = this.settings.autoIndexIntervalMinutes;
    if (intervalMinutes > 0) {
      const intervalMs = intervalMinutes * 60 * 1000;
      this.autoIndexIntervalId = window.setInterval(() => {
        this.runAutoIndex('interval');
      }, intervalMs);
      // 注册清理
      this.registerInterval(this.autoIndexIntervalId);
    }
    
    // 设置每日定时更新
    const scheduledTime = this.settings.autoIndexScheduledTime;
    if (scheduledTime && /^\d{1,2}:\d{2}$/.test(scheduledTime)) {
      this.scheduleNextDailyIndex(scheduledTime);
    }
    
  }

  /**
   * 清理自动索引定时器
   */
  private clearAutoIndexTimers() {
    if (this.autoIndexIntervalId !== null) {
      window.clearInterval(this.autoIndexIntervalId);
      this.autoIndexIntervalId = null;
    }
    if (this.autoIndexScheduledTimeoutId !== null) {
      window.clearTimeout(this.autoIndexScheduledTimeoutId);
      this.autoIndexScheduledTimeoutId = null;
    }
  }

  /**
   * 计划下次每日定时索引
   */
  private scheduleNextDailyIndex(time: string) {
    const [hours, minutes] = time.split(':').map(Number);
    const now = new Date();
    const target = new Date(now);
    target.setHours(hours, minutes, 0, 0);
    
    // 如果目标时间已过，设置为明天
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }
    
    const delay = target.getTime() - now.getTime();
    
    this.autoIndexScheduledTimeoutId = window.setTimeout(() => {
      this.runAutoIndex('scheduled');
      // 继续安排下一次
      this.scheduleNextDailyIndex(time);
    }, delay);
  }

  /**
   * 执行自动索引
   */
  private async runAutoIndex(trigger: 'interval' | 'scheduled') {
    // 防止频繁触发（最少间隔5分钟）
    const now = Date.now();
    if (now - this.lastAutoIndexTime < 5 * 60 * 1000) {
      this.settings.lastAutoIndexRunAt = now;
      this.settings.lastAutoIndexStatus = 'skipped';
      this.settings.lastAutoIndexTrigger = trigger;
      this.settings.lastAutoIndexError = '距离上次自动索引不足 5 分钟';
      await this.saveSettings();
      return;
    }

    if (!this.settings.autoIndexEnabled) {
      this.settings.lastAutoIndexRunAt = now;
      this.settings.lastAutoIndexStatus = 'skipped';
      this.settings.lastAutoIndexTrigger = trigger;
      this.settings.lastAutoIndexError = '自动索引已关闭';
      await this.saveSettings();
      return;
    }

    this.lastAutoIndexTime = now;

    try {
      await this.vectorIndexManager.indexVault();
      this.settings.lastAutoIndexRunAt = now;
      this.settings.lastAutoIndexStatus = 'success';
      this.settings.lastAutoIndexTrigger = trigger;
      this.settings.lastAutoIndexError = '';
      await this.saveSettings();
    } catch (e) {
      console.error('[AutoIndex] Auto index failed:', e);
      this.settings.lastAutoIndexRunAt = now;
      this.settings.lastAutoIndexStatus = 'error';
      this.settings.lastAutoIndexTrigger = trigger;
      this.settings.lastAutoIndexError = e instanceof Error ? e.message : String(e);
      await this.saveSettings();
    }
  }
}
