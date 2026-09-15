import { App, PluginSettingTab, Setting, ButtonComponent, Notice, Platform, Modal } from "obsidian";
import AiChatAssistantPlugin from "../../main";;
import type { Agent } from "../features/agent/types";
import { ConnectionEditModal } from "./modals/ConnectionEditModal";
import { PersonaManagerModal } from "./modals/PersonaManagerModal";
import { CharacterManagerModal } from "./modals/CharacterManagerModal";
import { McpClient } from "../mcp/McpClient";
import { DashScopeMcpClient } from "../mcp/DashScopeMcpClient";
import type { ToolRegistry } from "../mcp/ToolRegistry";
import { safeNotice } from "../utils/notice";
import { SearchableModelSelect, type ModelOption } from "./components/SearchableModelSelect";
import { APIServer } from "../services/api/APIServer";

import { DEFAULT_ROLEPLAY_ISOLATION_PROMPT, DEFAULT_SETTINGS, type AiChatAssistantSettings, type Persona, type UserPersona, type AIProvider, type AIConnection, type AgentPermissionDefaults, type McpServerConfig, type McpProvider, type AgentPermissionScope, type AgentPermissionMode, type McpService, type McpToolItem, type McpToolDefinition } from "../core/settings";
export class AiChatAssistantSettingTab extends PluginSettingTab {
  plugin: AiChatAssistantPlugin;
  private activeTab: 'general' | 'model' | 'persona' | 'rag' | 'agent' = 'general';
  // UI state for MCP filters
  private mcpFilterShowDisabled = false;
  private mcpFilterWebOnly = false;
  // 保存折叠区域的展开状态
  private collapsibleStates: Map<string, boolean> = new Map();

  private createCollapsibleSection(
    containerEl: HTMLElement,
    title: string,
    options?: { open?: boolean; description?: string }
  ): HTMLElement {
    const detailsEl = containerEl.createEl("details", {
      cls: "ai-settings-collapsible",
    }) as HTMLDetailsElement;
    
    // 优先使用保存的状态，否则使用默认值
    const savedState = this.collapsibleStates.get(title);
    detailsEl.open = savedState !== undefined ? savedState : (options?.open ?? false);

    detailsEl.createEl("summary", { text: title });

    // 监听展开/收起事件，保存状态
    detailsEl.addEventListener("toggle", () => {
      this.collapsibleStates.set(title, detailsEl.open);
    });

    const contentEl = detailsEl.createDiv({ cls: "ai-settings-collapsible-content" });
    if (options?.description) {
      contentEl.createEl("p", { text: options.description, cls: "text-muted" });
    }
    return contentEl;
  }

  constructor(app: App, plugin: AiChatAssistantPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("ai-settings-root");
    
    // Header
    containerEl.createEl("h2", { text: "AI 聊天助手设置" });

    // Tab Navigation
    const navContainer = containerEl.createDiv({ cls: "settings-nav-container" });

    const tabs: { id: 'general' | 'model' | 'persona' | 'rag' | 'agent', label: string }[] = [
      { id: 'general', label: '通用' },
      { id: 'model', label: '模型' },
      { id: 'persona', label: '角色' },
      { id: 'rag', label: '知识库' },
      { id: 'agent', label: '智能体' },
    ];

    tabs.forEach(tab => {
      const tabEl = navContainer.createDiv({ cls: "settings-nav-tab" });
      tabEl.setText(tab.label);
      tabEl.toggleClass("is-active", this.activeTab === tab.id);

      tabEl.addEventListener("click", () => {
        this.activeTab = tab.id;
        this.display();
      });
    });

    // Content Area
    const contentContainer = containerEl.createDiv({ cls: "settings-content" });

    if (this.activeTab === 'general') {
      this.renderGeneralSettings(contentContainer);
    } else if (this.activeTab === 'model') {
      this.renderModelSettings(contentContainer);
    } else if (this.activeTab === 'persona') {
      this.renderPersonaSettings(contentContainer);
    } else if (this.activeTab === 'rag') {
      this.renderRagSettings(contentContainer);
    } else if (this.activeTab === 'agent') {
      this.renderAgentSettings(contentContainer);
    }
  }

  private getAvailableModels(): Record<string, string> {
    const models: Record<string, string> = {};

    // Prefer new config (connections + modelRegistry)
    const connections = Array.isArray(this.plugin.settings.connections) ? this.plugin.settings.connections : [];
    const registry = Array.isArray(this.plugin.settings.modelRegistry) ? this.plugin.settings.modelRegistry : [];
    if (connections.length > 0 && registry.length > 0) {
      const connNameById = new Map(connections.map(c => [c.id, c.name] as const));
      registry.forEach(item => {
        const model = String(item?.model || '').trim();
        const connId = String(item?.connectionId || '').trim();
        if (!model || !connId) return;
        const connName = connNameById.get(connId) || connId;
        models[model] = `${model} (${connName})`;
      });
      return models;
    }
    
    // 1. Default Chat Models
    const defaultModels = this.plugin.settings.chatModels.split(',').map(m => m.trim()).filter(Boolean);
    defaultModels.forEach(m => models[m] = m);

    // 3. Local LLM (if enabled)
    if (this.plugin.settings.enableLocalLLM && this.plugin.settings.localLLMModel) {
         models[this.plugin.settings.localLLMModel] = `${this.plugin.settings.localLLMModel} (Local)`;
    }

    return models;
  }

  private renderGeneralSettings(containerEl: HTMLElement) {
    const chatUxSectionEl = this.createCollapsibleSection(containerEl, "聊天体验");

    new Setting(chatUxSectionEl)
      .setName("流式输出 (Streaming)")
      .setDesc("开启后，AI 的回复将逐字显示（打字机效果）。")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.streamOutput)
        .onChange(async (value) => {
          this.plugin.settings.streamOutput = value;
          await this.plugin.saveSettings();
        }));

    new Setting(chatUxSectionEl)
      .setName("显示引用标注")
      .setDesc("在回答中显示 [1] 这样的引用来源标注，点击可跳转到对应笔记。")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showCitations)
        .onChange(async (value) => {
          this.plugin.settings.showCitations = value;
          await this.plugin.saveSettings();
        }));

    new Setting(chatUxSectionEl)
      .setName("最大历史消息数")
      .setDesc("发送给 AI 的最大历史消息数量。")
      .addText(text => text
        .setPlaceholder("20")
        .setValue(String(this.plugin.settings.maxHistoryMessages))
        .onChange(async (value) => {
          const num = parseInt(value);
          if (!isNaN(num) && num >= 0) {
            this.plugin.settings.maxHistoryMessages = num;
            await this.plugin.saveSettings();
          }
        }));

    new Setting(chatUxSectionEl)
      .setName("上下文压缩")
      .setDesc("当对话历史过长时，自动总结前文以节省 Token。")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableContextCompression)
        .onChange(async (value) => {
          this.plugin.settings.enableContextCompression = value;
          await this.plugin.saveSettings();
        }));

    new Setting(chatUxSectionEl)
      .setName("智能体上下文预算")
      .setDesc("在智能体模式下按优先级裁剪 system / 历史 / 用户参考上下文，降低上下文爆炸风险。")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableContextBudgetManager)
        .onChange(async (value) => {
          this.plugin.settings.enableContextBudgetManager = value;
          await this.plugin.saveSettings();
        }));

    new Setting(chatUxSectionEl)
      .setName("智能体上下文预算 Token")
      .setDesc("智能体模式下发送给模型的目标上下文预算。默认 12000。")
      .addText(text => text
        .setPlaceholder("12000")
        .setValue(String(this.plugin.settings.agentContextBudgetTokens))
        .onChange(async (value) => {
          const num = parseInt(value);
          if (!isNaN(num) && num >= 2000) {
            this.plugin.settings.agentContextBudgetTokens = num;
            await this.plugin.saveSettings();
          }
        }));

    // API Server 配置
    const apiServerSectionEl = this.createCollapsibleSection(containerEl, "API Server（外部访问）");

    new Setting(apiServerSectionEl)
      .setName("启用 API Server")
      .setDesc("允许外部程序通过 HTTP API 访问向量搜索功能（仅限本地访问）")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableAPIServer)
        .onChange(async (value) => {
          this.plugin.settings.enableAPIServer = value;
          await this.plugin.saveSettings();
          
          if (value) {
            // 启动服务器
            try {
              if (!this.plugin.apiServer) {
                this.plugin.apiServer = new APIServer(this.plugin, {
                  enabled: this.plugin.settings.enableAPIServer,
                  port: this.plugin.settings.apiServerPort,
                  host: this.plugin.settings.apiServerHost,
                  allowedOrigins: this.plugin.settings.apiServerAllowedOrigins
                });
              }
              await this.plugin.apiServer.start();
              new Notice('API Server 已启动');
            } catch (error: any) {
              new Notice(`API Server 启动失败: ${error.message}`);
            }
          } else {
            // 停止服务器
            if (this.plugin.apiServer) {
              this.plugin.apiServer.stop();
              new Notice('API Server 已停止');
            }
          }
        }));

    new Setting(apiServerSectionEl)
      .setName("API Server 端口")
      .setDesc("默认: 37842")
      .addText(text => text
        .setValue(String(this.plugin.settings.apiServerPort))
        .onChange(async (value) => {
          const port = parseInt(value);
          if (port > 0 && port < 65536) {
            this.plugin.settings.apiServerPort = port;
            await this.plugin.saveSettings();
            
            // 如果服务器正在运行，需要重启
            if (this.plugin.settings.enableAPIServer && this.plugin.apiServer) {
              new Notice('端口已更改，请重启 Obsidian 使更改生效');
            }
          }
        }));

    const statusText = this.plugin.settings.enableAPIServer 
      ? `运行中: http://${this.plugin.settings.apiServerHost}:${this.plugin.settings.apiServerPort}`
      : '未启动';

    new Setting(apiServerSectionEl)
      .setName("API Server 状态")
      .setDesc(statusText)
      .addButton(button => button
        .setButtonText('测试连接')
        .onClick(async () => {
          if (!this.plugin.settings.enableAPIServer) {
            new Notice('请先启用 API Server');
            return;
          }
          
          try {
            const response = await fetch(`http://${this.plugin.settings.apiServerHost}:${this.plugin.settings.apiServerPort}/api/health`);
            if (response.ok) {
              const data = await response.json();
              new Notice(`✅ API Server 正常运行\n版本: ${data.version}`);
            } else {
              new Notice('❌ API Server 响应异常');
            }
          } catch (error: any) {
            new Notice(`❌ 无法连接到 API Server: ${error.message}`);
          }
        }));
  }

  private renderPersonaSettings(containerEl: HTMLElement) {
    // === 角色管理 ===
    const characterSectionEl = this.createCollapsibleSection(containerEl, "角色管理", { open: true });

    new Setting(characterSectionEl)
      .setName("角色卡管理")
      .setDesc("添加、编辑或删除 AI 角色，支持导入 SillyTavern 角色卡。")
      .addButton(btn =>
        btn
          .setButtonText("管理角色")
          .setCta()
          .onClick(() => {
            new CharacterManagerModal(this.app, this.plugin).open();
          })
      );

    // === 记忆系统 ===
    const memorySectionEl = this.createCollapsibleSection(containerEl, "无限记忆 (Infinite Memory)");

    new Setting(memorySectionEl)
      .setName("启用无限记忆")
      .setDesc("自动记录对话摘要和用户画像，实现长期记忆。")
      .addToggle(toggle =>
        toggle.setValue(this.plugin.settings.enableMemory).onChange(async (value) => {
          this.plugin.settings.enableMemory = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(memorySectionEl)
      .setName("记忆存储路径")
      .setDesc("记忆文件存储的文件夹路径。")
      .addText(text =>
        text.setValue(this.plugin.settings.memoryPath).onChange(async (value) => {
          this.plugin.settings.memoryPath = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(memorySectionEl)
      .setName("情景记忆按主题分区")
      .setDesc("开启后，情景记忆会写入 YAML 元数据并按 topic 自动存入子文件夹（例如 Episodic/项目A/）。")
      .addToggle(toggle =>
        toggle.setValue(this.plugin.settings.memoryEpisodicTopicFolders).onChange(async (value) => {
          this.plugin.settings.memoryEpisodicTopicFolders = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(memorySectionEl)
      .setName("情景记忆写入作用域")
      .setDesc("决定新生成的对话摘要写到哪里：persona（仅当前角色）、project（项目共享）、global（全局共享）。")
      .addDropdown(dropdown =>
        dropdown
          .addOption('persona', 'persona（仅当前角色）')
          .addOption('project', 'project（项目共享）')
          .addOption('global', 'global（全局共享）')
          .setValue(this.plugin.settings.memoryEpisodicWriteScope)
          .onChange(async (value: string) => {
            this.plugin.settings.memoryEpisodicWriteScope = value as 'persona' | 'project' | 'global';
            await this.plugin.saveSettings();
          })
      );

    new Setting(memorySectionEl)
      .setName("检索时包含全局情景记忆")
      .setDesc("开启后，检索会额外包含 global 作用域下的情景记忆（跨角色共享）。")
      .addToggle(toggle =>
        toggle.setValue(this.plugin.settings.memoryEpisodicIncludeGlobal).onChange(async (value) => {
          this.plugin.settings.memoryEpisodicIncludeGlobal = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(memorySectionEl)
      .setName("检索时包含项目情景记忆")
      .setDesc("开启后，检索会额外包含 project 作用域下的情景记忆（同一项目共享）。")
      .addToggle(toggle =>
        toggle.setValue(this.plugin.settings.memoryEpisodicIncludeProject).onChange(async (value) => {
          this.plugin.settings.memoryEpisodicIncludeProject = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(memorySectionEl)
      .setName("项目 scope key（可选）")
      .setDesc("留空则使用当前激活文件的一级目录作为项目名；无激活文件则使用 root。")
      .addText(text =>
        text.setValue(this.plugin.settings.memoryProjectKeyOverride).onChange(async (value) => {
          this.plugin.settings.memoryProjectKeyOverride = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(memorySectionEl)
      .setName("角色扮演记忆提取间隔")
      .setDesc("每隔多少轮对话触发一次记忆提取（提取世界观、人物、事件等）。建议 3-10 轮。")
      .addText(text =>
        text
          .setPlaceholder("5")
          .setValue(String(this.plugin.settings.roleplayExtractionInterval || 5))
          .onChange(async (value) => {
            const num = parseInt(value);
            if (!isNaN(num) && num >= 1) {
              this.plugin.settings.roleplayExtractionInterval = num;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(memorySectionEl)
      .setName("角色扮演记忆提取消息数")
      .setDesc("每次提取时读取最近多少条消息进行分析。建议 30-50 条以获得更好的人物追踪效果。")
      .addText(text =>
        text
          .setPlaceholder("40")
          .setValue(String(this.plugin.settings.roleplayExtractionMessageCount || 40))
          .onChange(async (value) => {
            const num = parseInt(value);
            if (!isNaN(num) && num >= 5) {
              this.plugin.settings.roleplayExtractionMessageCount = num;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(memorySectionEl)
      .setName("强制启用角色扮演记忆提取")
      .setDesc("⚠️ 即使角色类型不是「扮演类」(character)，也启用人物/事件/关系的自动提取。适合长对话场景。")
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.forceRoleplayMemoryExtraction || false)
          .onChange(async (value) => {
            this.plugin.settings.forceRoleplayMemoryExtraction = value;
            await this.plugin.saveSettings();
          })
      );

    // === 天道系统 (Fate Engine) ===
    const fateSectionEl = this.createCollapsibleSection(containerEl, "天道系统 (Fate Engine)");

    new Setting(fateSectionEl)
      .setName("启用天道系统")
      .setDesc("独立 AI 作为世界的「天道」，会为角色扮演世界注入随机事件、环境变化和 NPC 自主行动，让世界更具活力和新奇感。仅对扮演类角色卡生效。")
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.enableFateSystem || false)
          .onChange(async (value) => {
            this.plugin.settings.enableFateSystem = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(fateSectionEl)
      .setName("天道模型")
      .setDesc("天道系统使用的模型。留空则使用记忆模型。可选用便宜/快速的模型以降低成本。")
      .then(setting => this.addModelInput(setting, this.plugin.settings.fateModel || "", async (value) => {
        this.plugin.settings.fateModel = value;
        await this.plugin.saveSettings();
      }));

    new Setting(fateSectionEl)
      .setName("触发频率")
      .setDesc("每隔多少轮对话触发一次天道事件。建议 2-5 轮。频率越高世界变化越频繁，但 API 成本更高。")
      .addText(text =>
        text
          .setPlaceholder("3")
          .setValue(String(this.plugin.settings.fateFrequency || 3))
          .onChange(async (value) => {
            const num = parseInt(value);
            if (!isNaN(num) && num >= 1) {
              this.plugin.settings.fateFrequency = num;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(fateSectionEl)
      .setName("事件强度")
      .setDesc("gentle = 日常小事、天气变化；moderate = 适度意外、NPC 自主行动；dramatic = 重大变故、命运转折")
      .addDropdown(dropdown =>
        dropdown
          .addOption('gentle', '平和 — 自然日常')
          .addOption('moderate', '适度 — 有惊有喜')
          .addOption('dramatic', '剧烈 — 命运弄人')
          .setValue(this.plugin.settings.fateIntensity || 'moderate')
          .onChange(async (value) => {
            this.plugin.settings.fateIntensity = value as 'gentle' | 'moderate' | 'dramatic';
            await this.plugin.saveSettings();
          })
      );

    // === 角色扮演规则 ===
    const roleplaySectionEl = this.createCollapsibleSection(containerEl, "角色扮演规则 (Roleplay Rules)");

    // 信息隔离提示词设置
    const isolationPromptSetting = new Setting(roleplaySectionEl)
      .setName("信息隔离提示词")
      .setDesc("用于扮演类角色卡的信息隔离和状态追踪规则。此提示词会注入到角色扮演对话中，确保 NPC 行为符合逻辑。")
      .setClass("ai-setting-textarea-full");

    const textAreaContainer = roleplaySectionEl.createDiv({ cls: "ai-roleplay-prompt-container" });
    
    const textArea = textAreaContainer.createEl("textarea", {
      cls: "ai-roleplay-prompt-textarea",
      attr: {
        rows: "15",
        placeholder: "输入角色扮演信息隔离规则...",
      }
    });
    textArea.value = this.plugin.settings.roleplayIsolationPrompt || DEFAULT_ROLEPLAY_ISOLATION_PROMPT;
    
    // 保存和重置按钮
    const buttonContainer = textAreaContainer.createDiv({ cls: "ai-roleplay-prompt-buttons" });
    
    const saveBtn = buttonContainer.createEl("button", { text: "保存修改", cls: "mod-cta" });
    saveBtn.addEventListener("click", async () => {
      this.plugin.settings.roleplayIsolationPrompt = textArea.value;
      await this.plugin.saveSettings();
      new Notice("角色扮演规则已保存");
    });
    
    const resetBtn = buttonContainer.createEl("button", { text: "重置为默认" });
    resetBtn.addEventListener("click", async () => {
      textArea.value = DEFAULT_ROLEPLAY_ISOLATION_PROMPT;
      this.plugin.settings.roleplayIsolationPrompt = DEFAULT_ROLEPLAY_ISOLATION_PROMPT;
      await this.plugin.saveSettings();
      new Notice("已重置为默认规则");
    });

    // 添加提示
    const tipEl = roleplaySectionEl.createEl("p", { 
      cls: "setting-item-description",
      text: "💡 提示：此规则仅对「扮演类」角色卡生效（type = character）。修改后对新对话生效。" 
    });
  }

  /** 用途绑定区域的 SearchableModelSelect 实例，连接变更后批量刷新选项 */
  private roleModelSelects: SearchableModelSelect[] = [];

  /** 刷新所有用途绑定下拉框的选项 */
  private refreshRoleModelOptions() {
    const options = this.getModelOptions();
    for (const sel of this.roleModelSelects) {
      sel.setOptions(options);
    }
  }

  private renderModelSettings(containerEl: HTMLElement) {
    this.roleModelSelects = [];
    const connectionsSectionEl = this.createCollapsibleSection(containerEl, "连接 (Connections)", {
      open: true,
      description: "先配置连接（Base URL / Key），再把模型绑定到连接。",
    });

    const connectionsContainer = connectionsSectionEl.createDiv();

    const getModelsForConnection = (connectionId: string): string[] => {
      const registry = Array.isArray(this.plugin.settings.modelRegistry) ? this.plugin.settings.modelRegistry : [];
      return registry
        .filter(r => r.connectionId === connectionId)
        .map(r => String(r.model || '').trim())
        .filter(Boolean);
    };

    const setModelsForConnection = async (connectionId: string, models: string[]) => {
      const normalized = Array.from(new Set((models || []).map(m => String(m || '').trim()).filter(Boolean)));

      const prev = Array.isArray(this.plugin.settings.modelRegistry) ? this.plugin.settings.modelRegistry : [];
      // 只移除当前连接的旧绑定，保留其他连接的模型（即使同名）
      const kept = prev.filter(r => {
        const cid = String(r?.connectionId || '').trim();
        // 只过滤掉当前连接的旧绑定
        return cid !== String(connectionId);
      });

      const next = [...kept, ...normalized.map(model => ({ model, connectionId }))];
      this.plugin.settings.modelRegistry = next;
      await this.plugin.saveSettings();
    };

    const renderConnections = () => {
      connectionsContainer.empty();
      const connections = Array.isArray(this.plugin.settings.connections) ? this.plugin.settings.connections : [];

      const listEl = connectionsContainer.createDiv({ cls: 'ai-conn-list' });

      connections.forEach((conn, index) => {
        const item = listEl.createDiv({ cls: 'ai-conn-list-item' });
        item.setAttr('role', 'button');
        item.setAttr('tabindex', '0');

        const avatar = item.createDiv({ cls: 'ai-conn-avatar' });
        const initial = String(conn.name || '?').trim().slice(0, 1).toUpperCase();
        avatar.setText(initial || '?');

        const text = item.createDiv({ cls: 'ai-conn-text' });
        text.createDiv({ text: conn.name || '未命名', cls: 'ai-conn-title' });
        text.createDiv({ text: String(conn.baseUrl || '').trim() || '未设置 Base URL', cls: 'ai-conn-subtitle' });

        const modelsCount = getModelsForConnection(conn.id).length;
        text.createDiv({ text: `模型：${modelsCount} 个`, cls: 'ai-conn-subtitle' });

        const right = item.createDiv({ cls: 'ai-conn-right' });
        const dot = right.createDiv({ cls: `ai-conn-dot ${conn.enabled ? 'is-enabled' : ''}` });
        dot.setAttr('aria-label', conn.enabled ? '已启用' : '未启用');
        right.createDiv({ text: '›', cls: 'ai-conn-chevron' });

        const openEditor = () => {
          new ConnectionEditModal(
            this.app,
            {
              testConnection: (c) => this.plugin.llmService.testConnection(c),
              listModels: (c) => this.plugin.llmService.listModels(c),
              getBoundModels: (connectionId) => getModelsForConnection(connectionId),
              setBoundModels: (connectionId, models) => setModelsForConnection(connectionId, models),
            },
            conn,
            async (updated) => {
              this.plugin.settings.connections[index] = updated;
              await this.plugin.saveSettings();
              renderConnections();
              this.refreshRoleModelOptions();
            },
            async () => {
              const connId = conn.id;
              this.plugin.settings.connections.splice(index, 1);
              this.plugin.settings.modelRegistry = (this.plugin.settings.modelRegistry || []).filter(r => r.connectionId !== connId);
              await this.plugin.saveSettings();
              renderConnections();
              this.refreshRoleModelOptions();
            }
          ).open();
        };

        item.addEventListener('click', openEditor);
        item.addEventListener('keydown', (ev: KeyboardEvent) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            openEditor();
          }
        });
      });

      new Setting(connectionsContainer)
        .addButton(btn => btn
          .setButtonText("添加连接")
          .setCta()
          .onClick(() => {
            new ConnectionEditModal(
              this.app,
              {
                testConnection: (c) => this.plugin.llmService.testConnection(c),
                listModels: (c) => this.plugin.llmService.listModels(c),
                getBoundModels: (connectionId) => getModelsForConnection(connectionId),
                setBoundModels: (connectionId, models) => setModelsForConnection(connectionId, models),
              },
              undefined,
              async (newConn) => {
                this.plugin.settings.connections.push(newConn);
                await this.plugin.saveSettings();
                renderConnections();
                this.refreshRoleModelOptions();
              },
              undefined
            ).open();
          }));
    };

    renderConnections();

    const rolesSectionEl = this.createCollapsibleSection(containerEl, "用途绑定 (Roles)", {
      open: true,
      description: "为不同用途选择默认模型（会从已绑定的模型列表中提供快速选择）。",
    });

    new Setting(rolesSectionEl)
      .setName("默认聊天模型")
      .setDesc("新建对话时默认使用该模型。")
      .then(setting => this.addModelInput(setting, this.plugin.settings.defaultChatModel, async (value) => {
        this.plugin.settings.defaultChatModel = value;
        await this.plugin.saveSettings();
      }));

    // 兼容：这些字段已在其它 tab 中存在，这里提供一个集中入口
    new Setting(rolesSectionEl)
      .setName("Embedding 模型")
      .setDesc("用于向量化（知识库/RAG）。")
      .then(setting => this.addModelInput(setting, this.plugin.settings.embeddingModel, async (value) => {
        this.plugin.settings.embeddingModel = value;
        await this.plugin.saveSettings();
      }));

    new Setting(rolesSectionEl)
      .setName("Inline AI 模型")
      .setDesc("用于幽灵写作/行内补全。")
      .then(setting => this.addModelInput(setting, this.plugin.settings.inlineAIModel, async (value) => {
        this.plugin.settings.inlineAIModel = value;
        await this.plugin.saveSettings();
      }));

    if (this.plugin.isCollaborationModeAvailable()) {
      new Setting(rolesSectionEl)
        .setName("Router 模型")
        .setDesc("用于协作路由。")
        .then(setting => this.addModelInput(setting, this.plugin.settings.routerModel, async (value) => {
          this.plugin.settings.routerModel = value;
          await this.plugin.saveSettings();
        }));

      new Setting(rolesSectionEl)
        .setName("Planner 模型")
        .setDesc("用于协作规划。")
        .then(setting => this.addModelInput(setting, this.plugin.settings.plannerModel, async (value) => {
          this.plugin.settings.plannerModel = value;
          await this.plugin.saveSettings();
        }));

      new Setting(rolesSectionEl)
        .setName("Writer 模型")
        .setDesc("用于协作写作。")
        .then(setting => this.addModelInput(setting, this.plugin.settings.writerModel, async (value) => {
          this.plugin.settings.writerModel = value;
          await this.plugin.saveSettings();
        }));
    }

    new Setting(rolesSectionEl)
      .setName("记忆整理模型")
      .setDesc("用于角色记忆归档、事实提取、世界观整理等后台任务。留空则使用 Router 模型。")
      .then(setting => this.addModelInput(setting, this.plugin.settings.memoryModel, async (value) => {
        this.plugin.settings.memoryModel = value;
        await this.plugin.saveSettings();
      }));

    new Setting(rolesSectionEl)
      .setName("Rerank 模型")
      .setDesc("用于知识库检索结果的重排序。自动使用模型所属连接的 API Key 和地址，无需单独配置。")
      .then(setting => this.addModelInput(setting, this.plugin.settings.rerankModel, async (value) => {
        this.plugin.settings.rerankModel = value;
        await this.plugin.saveSettings();
      }));

    // 旧版配置入口已移除：保留 main.ts 内的迁移逻辑以兼容老数据。
  }

  private renderAgentSettings(containerEl: HTMLElement) {
    const agentConfigSectionEl = this.createCollapsibleSection(containerEl, "智能体配置");

    const agents = this.plugin.agentManager.getAllAgents();
    const agentOptions: Record<string, string> = {};
    agents.forEach(a => agentOptions[a.id] = a.name);

    new Setting(agentConfigSectionEl)
      .setName("当前智能体")
      .setDesc("选择在智能体模式下使用的 Agent。")
      .addDropdown(dropdown => dropdown
        .addOptions(agentOptions)
        .setValue(this.plugin.settings.activeAgentId)
        .onChange(async (value) => {
          this.plugin.settings.activeAgentId = value;
          await this.plugin.saveSettings();
        }));

    new Setting(agentConfigSectionEl)
      .setName("最大执行步骤")
      .setDesc("防止智能体陷入死循环的最大迭代次数 (5-100)。复杂任务可适当调大。")
      .addSlider(slider => slider
        .setLimits(5, 100, 5)
        .setValue(this.plugin.settings.agentMaxSteps)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.agentMaxSteps = value;
          await this.plugin.saveSettings();
        }));

    new Setting(agentConfigSectionEl)
      .setName("显示工具调用日志")
      .setDesc("在聊天界面显示智能体调用工具的详细过程。")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showToolLogs)
        .onChange(async (value) => {
          this.plugin.settings.showToolLogs = value;
          await this.plugin.saveSettings();
        }));

    const permissionSectionEl = this.createCollapsibleSection(containerEl, "智能体权限", {
      description: "按读写/命令/联网/MCP 范围管理工具审批，接近 Copilot 风格的权限层。",
    });

    new Setting(permissionSectionEl)
      .setName("启用结构化权限系统")
      .setDesc("开启后，高风险或默认需审批的工具会在执行前弹出审批窗口，支持本次允许或永久放行某一权限范围。")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableAgentPermissions)
        .onChange(async (value) => {
          this.plugin.settings.enableAgentPermissions = value;
          await this.plugin.saveSettings();
          this.display();
        }));

    if (this.plugin.settings.enableAgentPermissions) {
      const modes: Record<AgentPermissionMode, string> = {
        ask: '每次询问',
        allow: '直接允许',
      };

      const addPermissionDropdown = (scope: AgentPermissionScope, label: string, desc: string) => {
        new Setting(permissionSectionEl)
          .setName(label)
          .setDesc(desc)
          .addDropdown(dropdown => dropdown
            .addOptions(modes)
            .setValue(this.plugin.settings.agentPermissionDefaults?.[scope] || 'ask')
            .onChange(async (value: string) => {
              const next = {
                ...(this.plugin.settings.agentPermissionDefaults || DEFAULT_SETTINGS.agentPermissionDefaults),
                [scope]: value,
              } as AgentPermissionDefaults;
              this.plugin.settings.agentPermissionDefaults = next;
              await this.plugin.saveSettings();
            }));
      };

      addPermissionDropdown('read', '读文件 / 元数据', '例如读取笔记、结构、属性、符号与引用。默认建议直接允许。');
      addPermissionDropdown('write', '写文件 / 白板', '例如新建、修改、移动、删除笔记或白板。默认建议每次询问。');
      addPermissionDropdown('exec', '命令执行', '例如命令面板调用。默认建议每次询问。');
      addPermissionDropdown('network', '联网访问', '例如网页读取、搜索、远程调用。默认建议每次询问。');
      addPermissionDropdown('mcp', 'MCP 外部工具', '例如 `mcp_call_tool`。默认建议每次询问。');
    }

    // === 内置搜索 ===
    this.renderBuiltinSearchSection(containerEl);

    // === Skills 技能系统 ===
    this.renderSkillsSection(containerEl);

    // === MCP 工具 ===
    this.renderMcpSection(containerEl);
  }

  private renderSkillsSection(containerEl: HTMLElement) {
    const skillsSectionEl = this.createCollapsibleSection(containerEl, "🎯 技能系统 (Skills)", {
      description: "可复用的高级能力模块，支持本地、社区和远程技能。",
    });

    new Setting(skillsSectionEl)
      .setName("启用技能系统")
      .setDesc("技能是比工具更高层的能力抽象，如「总结文章」「生成周报」「代码审查」等。")
      .addToggle(toggle =>
        toggle.setValue(this.plugin.settings.enableSkills).onChange(async (value) => {
          this.plugin.settings.enableSkills = value;
          await this.plugin.saveSettings();
          this.display();
        })
      );

    if (!this.plugin.settings.enableSkills) {
      return;
    }

    // 技能文件夹路径
    new Setting(skillsSectionEl)
      .setName("技能文件夹路径")
      .setDesc("技能包存储的文件夹路径（相对于笔记库根目录）")
      .addText(text =>
        text
          .setPlaceholder("Skills")
          .setValue(this.plugin.settings.skillFolderPath || "Skills")
          .onChange(async (value) => {
            this.plugin.settings.skillFolderPath = value.trim() || "Skills";
            await this.plugin.saveSettings();
            // 更新 SkillRegistry 的路径
            this.plugin.skillRegistry?.setSkillFolderPath(this.plugin.settings.skillFolderPath);
          })
      );

    // 技能管理按钮
    new Setting(skillsSectionEl)
      .setName("技能管理")
      .setDesc("打开技能管理界面，查看、安装、卸载技能")
      .addButton(btn =>
        btn
          .setButtonText("打开技能管理器")
          .setCta()
          .onClick(() => {
            const { SkillManagerModal } = require("../features/skills/SkillManagerModal");
            const modal = new SkillManagerModal(this.app, this.plugin);
            modal.open();
          })
      );

    // 热重载
    new Setting(skillsSectionEl)
      .setName("启用热重载")
      .setDesc("自动监听技能文件夹变化，实时重新加载技能")
      .addToggle(toggle =>
        toggle.setValue(this.plugin.settings.skillHotReload).onChange(async (value) => {
          this.plugin.settings.skillHotReload = value;
          await this.plugin.saveSettings();
          
          if (value) {
            this.plugin.skillRegistry?.enableHotReload();
          } else {
            this.plugin.skillRegistry?.disableHotReload();
          }
        })
      );

    // GitHub 镜像站
    new Setting(skillsSectionEl)
      .setName("GitHub 镜像站")
      .setDesc("用于加速 GitHub 资源下载（如：ghproxy.com）")
      .addText(text =>
        text
          .setPlaceholder("ghproxy.com")
          .setValue(this.plugin.settings.githubMirror || "")
          .onChange(async (value) => {
            this.plugin.settings.githubMirror = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(skillsSectionEl)
      .setName("自动匹配技能")
      .setDesc("根据用户输入自动识别并执行匹配的技能。关闭后需要手动选择技能。")
      .addToggle(toggle =>
        toggle.setValue(this.plugin.settings.skillAutoMatch).onChange(async (value) => {
          this.plugin.settings.skillAutoMatch = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(skillsSectionEl)
      .setName("实现后自动自测")
      .setDesc("仅当智能体本轮实际执行过写入工具时，在主结果后追加一次 self-test。失败不会覆盖主结果。")
      .addToggle(toggle =>
        toggle.setValue(this.plugin.settings.enableAutoSelfTestAfterWrite).onChange(async (value) => {
          this.plugin.settings.enableAutoSelfTestAfterWrite = value;
          await this.plugin.saveSettings();
          this.display();
        })
      );

    if (this.plugin.settings.enableAutoSelfTestAfterWrite) {
      new Setting(skillsSectionEl)
        .setName("自动自测执行文档")
        .setDesc("可填写执行文档路径或简短说明。留空则使用默认 verify/build。")
        .addText(text =>
          text
            .setPlaceholder("如：STATUS.md / dev/执行文档.md")
            .setValue(this.plugin.settings.autoSelfTestExecutionDoc || "")
            .onChange(async (value) => {
              this.plugin.settings.autoSelfTestExecutionDoc = value.trim();
              await this.plugin.saveSettings();
            })
        );
    }

    if (this.plugin.settings.skillAutoMatch) {
      new Setting(skillsSectionEl)
        .setName("匹配置信度阈值")
        .setDesc("只有置信度高于此阈值的技能才会自动执行（0.5-1.0）")
        .addSlider(slider =>
          slider
            .setLimits(0.5, 1.0, 0.05)
            .setValue(this.plugin.settings.skillAutoMatchThreshold)
            .setDynamicTooltip()
            .onChange(async (value) => {
              this.plugin.settings.skillAutoMatchThreshold = value;
              await this.plugin.saveSettings();
            })
        );
    }

    // 内置技能管理
    skillsSectionEl.createEl("h4", { text: "内置技能" });
    
    const builtinSkills = [
      { id: "builtin-summarize", name: "📝 智能总结", desc: "总结文章、笔记或文本" },
      { id: "builtin-weekly-report", name: "📊 周报助手", desc: "自动生成周报" },
      { id: "builtin-organize-notes", name: "🗂️ 笔记整理", desc: "整理和优化笔记结构" },
      { id: "builtin-research", name: "🔍 深度研究", desc: "基于知识库深度问答" },
      { id: "builtin-code-review", name: "👨‍💻 代码审查", desc: "审查代码质量" },
      { id: "builtin-translate", name: "🌐 智能翻译", desc: "高质量多语言翻译" },
      { id: "builtin-self-test", name: "🧪 执行文档自测", desc: "按执行文档或默认流程运行 verify/build" },
    ];

    for (const skill of builtinSkills) {
      const isDisabled = this.plugin.settings.disabledBuiltinSkills.includes(skill.id);
      new Setting(skillsSectionEl)
        .setName(skill.name)
        .setDesc(skill.desc)
        .addToggle(toggle =>
          toggle.setValue(!isDisabled).onChange(async (value) => {
            if (value) {
              this.plugin.settings.disabledBuiltinSkills = 
                this.plugin.settings.disabledBuiltinSkills.filter(id => id !== skill.id);
            } else {
              this.plugin.settings.disabledBuiltinSkills.push(skill.id);
            }
            await this.plugin.saveSettings();
          })
        );
    }

    // 社区技能源
    skillsSectionEl.createEl("h4", { text: "社区技能源" });
    skillsSectionEl.createEl("p", { 
      text: "从网络加载社区分享的技能。",
      cls: "setting-item-description"
    });

    const communitySources = this.plugin.settings.skillCommunitySources || [];
    
    for (const source of communitySources) {
      const sourceEl = skillsSectionEl.createDiv({ cls: "skill-source-item" });
      new Setting(sourceEl)
        .setName(source.name)
        .setDesc(source.manifestUrl)
        .addToggle(toggle =>
          toggle.setValue(source.enabled).onChange(async (value) => {
            source.enabled = value;
            await this.plugin.saveSettings();
          })
        )
        .addButton(btn =>
          btn.setIcon("trash").setTooltip("删除").onClick(async () => {
            this.plugin.settings.skillCommunitySources = 
              communitySources.filter(s => s.id !== source.id);
            await this.plugin.saveSettings();
            this.display();
          })
        );
    }

    new Setting(skillsSectionEl)
      .setName("添加社区技能源")
      .setDesc("输入技能清单 URL（JSON 格式）")
      .addText(text => text.setPlaceholder("https://example.com/skills.json"))
      .addButton(btn =>
        btn.setButtonText("添加").onClick(async () => {
          const input = skillsSectionEl.querySelector('input[type="text"]') as HTMLInputElement;
          const url = input?.value?.trim();
          if (!url) return;
          
          const newSource = {
            id: `community-${Date.now()}`,
            name: new URL(url).hostname,
            manifestUrl: url,
            enabled: true,
            installedSkills: []
          };
          
          if (!this.plugin.settings.skillCommunitySources) {
            this.plugin.settings.skillCommunitySources = [];
          }
          this.plugin.settings.skillCommunitySources.push(newSource);
          await this.plugin.saveSettings();
          this.display();
        })
      );

    // 远程技能服务
    skillsSectionEl.createEl("h4", { text: "远程技能服务" });
    skillsSectionEl.createEl("p", { 
      text: "连接远程技能 API 服务（类似 MCP）。",
      cls: "setting-item-description"
    });

    const remoteServices = this.plugin.settings.skillRemoteServices || [];
    
    for (const service of remoteServices) {
      const serviceEl = skillsSectionEl.createDiv({ cls: "skill-service-item" });
      new Setting(serviceEl)
        .setName(service.name)
        .setDesc(service.endpoint)
        .addToggle(toggle =>
          toggle.setValue(service.enabled).onChange(async (value) => {
            service.enabled = value;
            await this.plugin.saveSettings();
          })
        )
        .addButton(btn =>
          btn.setIcon("trash").setTooltip("删除").onClick(async () => {
            this.plugin.settings.skillRemoteServices = 
              remoteServices.filter(s => s.id !== service.id);
            await this.plugin.saveSettings();
            this.display();
          })
        );
    }

    new Setting(skillsSectionEl)
      .setName("添加远程服务")
      .addText(text => text.setPlaceholder("服务名称"))
      .addText(text => text.setPlaceholder("http://localhost:8080"))
      .addButton(btn =>
        btn.setButtonText("添加").onClick(async () => {
          const inputs = skillsSectionEl.querySelectorAll('input[type="text"]');
          const nameInput = inputs[inputs.length - 2] as HTMLInputElement;
          const urlInput = inputs[inputs.length - 1] as HTMLInputElement;
          
          const name = nameInput?.value?.trim();
          const endpoint = urlInput?.value?.trim();
          if (!name || !endpoint) return;
          
          const newService = {
            id: `remote-${Date.now()}`,
            name,
            endpoint,
            enabled: true
          };
          
          if (!this.plugin.settings.skillRemoteServices) {
            this.plugin.settings.skillRemoteServices = [];
          }
          this.plugin.settings.skillRemoteServices.push(newService);
          await this.plugin.saveSettings();
          this.display();
        })
      );
  }

  private renderBuiltinSearchSection(containerEl: HTMLElement) {
    const searchSectionEl = this.createCollapsibleSection(containerEl, "内置联网搜索 (后备)", {
      description: "当 MCP 搜索不可用时，使用内置搜索引擎。支持 DuckDuckGo、Bing、百度等。",
    });

    new Setting(searchSectionEl)
      .setName("默认搜索引擎")
      .setDesc("选择内置搜索使用的引擎。免费引擎无需 API Key。")
      .addDropdown(dropdown =>
        dropdown
          .addOption("duckduckgo", "DuckDuckGo (免费)")
          .addOption("bing_free", "Bing CN (免费)")
          .addOption("baidu", "百度 (免费)")
          .addOption("bing", "Bing API (需 API Key)")
          .addOption("google", "Google (需 API Key)")
          .setValue(this.plugin.settings.webSearchProvider)
          .onChange(async (value) => {
            this.plugin.settings.webSearchProvider = value as any;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    // 如果选择需要 API Key 的引擎，显示对应配置
    if (this.plugin.settings.webSearchProvider === "bing") {
      new Setting(searchSectionEl)
        .setName("Bing Search API Key")
        .setDesc("从 Azure 获取 Bing Search API Key")
        .addText(text =>
          text
            .setPlaceholder("输入 Bing API Key")
            .setValue(this.plugin.settings.bingApiKey)
            .onChange(async (value) => {
              this.plugin.settings.bingApiKey = value;
              await this.plugin.saveSettings();
            })
        );
    }

    if (this.plugin.settings.webSearchProvider === "google") {
      new Setting(searchSectionEl)
        .setName("Google API Key")
        .setDesc("从 Google Cloud Console 获取 API Key")
        .addText(text =>
          text
            .setPlaceholder("输入 Google API Key")
            .setValue(this.plugin.settings.googleApiKey)
            .onChange(async (value) => {
              this.plugin.settings.googleApiKey = value;
              await this.plugin.saveSettings();
            })
        );

      new Setting(searchSectionEl)
        .setName("Google Search Engine ID (CX)")
        .setDesc("自定义搜索引擎的 ID")
        .addText(text =>
          text
            .setPlaceholder("输入 CX ID")
            .setValue(this.plugin.settings.googleCx)
            .onChange(async (value) => {
              this.plugin.settings.googleCx = value;
              await this.plugin.saveSettings();
            })
        );
    }

    // 说明信息
    searchSectionEl.createEl("p", {
      text: "💡 提示：免费引擎通过网页解析实现，可能偶尔受网络限制。如需更稳定的搜索，建议配置 MCP 搜索工具。",
      cls: "setting-item-description",
    });
  }

  private renderMcpSection(containerEl: HTMLElement) {
    const mcpSectionEl = this.createCollapsibleSection(containerEl, "MCP 工具 (Model Context Protocol)", {
      description: "连接阿里云百炼 MCP 服务，获取联网搜索、网页解析等能力。",
    });

    const ensureServices = () => {
      if (!Array.isArray(this.plugin.settings.mcpServices)) {
        this.plugin.settings.mcpServices = [];
      }
    };

    const getRegistry = () => {
      return (this.plugin as any).toolRegistry as ToolRegistry;
    };

    const refreshServices = async () => {
      try {
        if (!this.plugin.settings.enableDashScopeMcp) {
          new Notice("⚠️ 请先开启 DashScope MCP", 4000);
          return;
        }
        const apiKey = String(this.plugin.settings.dashScopeApiKey || "").trim();
        if (!apiKey) {
          new Notice("⚠️ 请先填写 API Key", 4000);
          return;
        }

        new Notice("正在刷新服务列表...", 3000);
        const registry = getRegistry();
        await registry.refresh("dashscope");
        await this.plugin.saveSettings();
        safeNotice(`✅ 已刷新服务列表`, 4000);
        this.display();
      } catch (e: any) {
        safeNotice(`❌ 刷新失败：${e?.message || String(e)}`, 6000);
      }
    };

    new Setting(mcpSectionEl)
      .setName("启用 DashScope MCP")
      .setDesc("开启后可使用阿里云百炼 MCP 服务")
      .addToggle(toggle =>
        toggle.setValue(this.plugin.settings.enableDashScopeMcp).onChange(async (value) => {
          this.plugin.settings.enableDashScopeMcp = value;
          await this.plugin.saveSettings();
          this.display();
        })
      );

    if (this.plugin.settings.enableDashScopeMcp) {
      new Setting(mcpSectionEl)
        .setName("API Key")
        .setDesc("阿里云百炼 API 密钥")
        .addText(text => {
          text.inputEl.type = "password";
          text
            .setPlaceholder("sk-xxxxxxxx")
            .setValue(this.plugin.settings.dashScopeApiKey)
            .onChange(async (value) => {
              this.plugin.settings.dashScopeApiKey = value.trim();
              await this.plugin.saveSettings();
            });
        });

      new Setting(mcpSectionEl)
        .setName("服务列表")
        .setDesc("点击刷新获取已启用的 MCP 服务")
        .addButton((btn: ButtonComponent) => {
          btn.setButtonText("🔄 刷新")
            .setCta()
            .onClick(async () => {
              await refreshServices();
            });
        });

      ensureServices();
      const services = this.plugin.settings.mcpServices || [];
      
      if (services.length > 0) {
        const serviceListContainer = mcpSectionEl.createDiv({ cls: "mcp-service-list-compact" });
        serviceListContainer.style.marginTop = "8px";
        
        for (const svc of services) {
          const svcEl = serviceListContainer.createDiv({ cls: "mcp-service-item-compact" });
          svcEl.style.padding = "8px 12px";
          svcEl.style.marginBottom = "4px";
          svcEl.style.background = "var(--background-secondary)";
          svcEl.style.borderRadius = "4px";
          svcEl.style.display = "flex";
          svcEl.style.justifyContent = "space-between";
          svcEl.style.alignItems = "center";
          
          const nameEl = svcEl.createSpan({ text: svc.name });
          nameEl.style.fontWeight = "500";
          
          const toolCount = svc.tools?.length || 0;
          const countEl = svcEl.createSpan({ text: `${toolCount} 工具` });
          countEl.style.color = "var(--text-muted)";
          countEl.style.fontSize = "12px";
        }
      } else {
        mcpSectionEl.createEl("p", { 
          text: "暂无服务，请点击刷新获取", 
          cls: "text-muted" 
        });
      }
    }

    // ─── 通用 MCP 服务器管理 ───────────────────────────
    this.renderGenericMcpSection(mcpSectionEl);
  }

  /**
   * 渲染通用 MCP 服务器管理 UI
   */
  private renderGenericMcpSection(parentEl: HTMLElement) {
    const sectionEl = parentEl.createDiv({ cls: "generic-mcp-section" });
    sectionEl.style.marginTop = "16px";
    sectionEl.style.borderTop = "1px solid var(--background-modifier-border)";
    sectionEl.style.paddingTop = "12px";

    const headerEl = sectionEl.createDiv();
    headerEl.style.display = "flex";
    headerEl.style.justifyContent = "space-between";
    headerEl.style.alignItems = "center";
    headerEl.style.marginBottom = "8px";
    
    const titleEl = headerEl.createEl("h4", { text: "通用 MCP 服务器" });
    titleEl.style.margin = "0";
    titleEl.style.fontSize = "14px";

    const descEl = sectionEl.createEl("p", { 
      text: "连接第三方 MCP Server（如 Agenda、自建服务等）。支持 SSE 和 Streamable HTTP 传输。", 
    });
    descEl.style.color = "var(--text-muted)";
    descEl.style.fontSize = "12px";
    descEl.style.marginTop = "0";
    descEl.style.marginBottom = "12px";

    // 添加按钮
    new Setting(sectionEl)
      .setName("添加服务器")
      .setDesc("添加一个新的通用 MCP 服务器连接")
      .addButton((btn: ButtonComponent) => {
        btn.setButtonText("➕ 添加")
          .setCta()
          .onClick(() => {
            this.openGenericMcpServerEditor(null, () => this.display());
          });
      });

    // 服务器列表
    if (!Array.isArray(this.plugin.settings.mcpServers)) {
      this.plugin.settings.mcpServers = [];
    }
    const servers = this.plugin.settings.mcpServers;
    
    if (servers.length > 0) {
      const listEl = sectionEl.createDiv({ cls: "generic-mcp-server-list" });
      
      for (const server of servers) {
        const itemEl = listEl.createDiv({ cls: "generic-mcp-server-item" });
        itemEl.style.padding = "10px 12px";
        itemEl.style.marginBottom = "6px";
        itemEl.style.background = "var(--background-secondary)";
        itemEl.style.borderRadius = "6px";
        itemEl.style.border = "1px solid var(--background-modifier-border)";

        // 顶部：名称 + 状态
        const topRow = itemEl.createDiv();
        topRow.style.display = "flex";
        topRow.style.justifyContent = "space-between";
        topRow.style.alignItems = "center";
        topRow.style.marginBottom = "4px";

        const nameEl = topRow.createSpan({ text: server.name });
        nameEl.style.fontWeight = "600";
        nameEl.style.fontSize = "14px";

        const statusEl = topRow.createSpan();
        if (server.lastStatus === 'ok') {
          statusEl.textContent = "✅ 已连接";
          statusEl.style.color = "var(--text-success)";
        } else if (server.lastStatus === 'error') {
          statusEl.textContent = "❌ 错误";
          statusEl.style.color = "var(--text-error)";
        } else {
          statusEl.textContent = "❓ 未测试";
          statusEl.style.color = "var(--text-muted)";
        }
        statusEl.style.fontSize = "12px";

        // 中间：endpoint + 工具数
        const infoEl = itemEl.createDiv();
        infoEl.style.fontSize = "12px";
        infoEl.style.color = "var(--text-muted)";
        infoEl.style.marginBottom = "6px";
        const endpointText = server.endpoint.length > 60 ? server.endpoint.substring(0, 57) + "..." : server.endpoint;
        const toolCount = server.tools?.length || 0;
        infoEl.textContent = `${endpointText} · ${toolCount} 工具`;
        if (server.lastError) {
          const errEl = itemEl.createDiv();
          errEl.style.fontSize = "11px";
          errEl.style.color = "var(--text-error)";
          errEl.style.marginBottom = "6px";
          errEl.textContent = `错误: ${server.lastError.substring(0, 100)}`;
        }

        // 底部：操作按钮
        const actionsEl = itemEl.createDiv();
        actionsEl.style.display = "flex";
        actionsEl.style.gap = "6px";
        actionsEl.style.flexWrap = "wrap";

        // 启用/禁用
        const toggleBtn = actionsEl.createEl("button", { 
          text: server.enabled ? "🔵 已启用" : "⚪ 已禁用",
          cls: "clickable-icon"
        });
        toggleBtn.style.fontSize = "12px";
        toggleBtn.style.padding = "2px 8px";
        toggleBtn.addEventListener("click", async () => {
          server.enabled = !server.enabled;
          await this.plugin.saveSettings();
          this.display();
        });

        // 刷新工具
        const refreshBtn = actionsEl.createEl("button", { 
          text: "🔄 刷新工具",
          cls: "clickable-icon"
        });
        refreshBtn.style.fontSize = "12px";
        refreshBtn.style.padding = "2px 8px";
        refreshBtn.addEventListener("click", async () => {
          new Notice(`正在连接 ${server.name}...`, 3000);
          try {
            const registry = (this.plugin as any).toolRegistry as ToolRegistry;
            const result = await registry.refreshGenericServer(server.id);
            if (result.error) {
              safeNotice(`❌ ${server.name}: ${result.error}`, 6000);
            } else {
              safeNotice(`✅ ${server.name}: 获取到 ${result.tools.length} 个工具`, 4000);
            }
            await this.plugin.saveSettings();
            this.display();
          } catch (e: any) {
            safeNotice(`❌ 连接失败: ${e?.message || String(e)}`, 6000);
          }
        });

        // 编辑
        const editBtn = actionsEl.createEl("button", { 
          text: "✏️ 编辑",
          cls: "clickable-icon"
        });
        editBtn.style.fontSize = "12px";
        editBtn.style.padding = "2px 8px";
        editBtn.addEventListener("click", () => {
          this.openGenericMcpServerEditor(server, () => this.display());
        });

        // 删除
        const deleteBtn = actionsEl.createEl("button", { 
          text: "🗑️ 删除",
          cls: "clickable-icon"
        });
        deleteBtn.style.fontSize = "12px";
        deleteBtn.style.padding = "2px 8px";
        deleteBtn.style.color = "var(--text-error)";
        deleteBtn.addEventListener("click", async () => {
          if (confirm(`确定要删除服务器 "${server.name}" 吗？`)) {
            this.plugin.settings.mcpServers = this.plugin.settings.mcpServers.filter(
              (s: any) => s.id !== server.id
            );
            await this.plugin.saveSettings();
            safeNotice(`已删除 ${server.name}`, 3000);
            this.display();
          }
        });
      }
    } else {
      const emptyEl = sectionEl.createEl("p", { text: "暂未添加通用 MCP 服务器" });
      emptyEl.style.color = "var(--text-muted)";
      emptyEl.style.fontSize = "12px";
      emptyEl.style.fontStyle = "italic";
    }
  }

  /**
   * 打开通用 MCP 服务器编辑弹窗
   */
  private openGenericMcpServerEditor(
    server: import("../core/settings").McpServerConfig | null,
    onSaved: () => void
  ) {
    const isNew = !server;
    const draft = server ? { ...server } : {
      id: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: "",
      endpoint: "",
      authHeader: "",
      enabled: true,
      description: "",
    };

    const modal = new Modal(this.app);
    modal.titleEl.setText(isNew ? "添加通用 MCP 服务器" : "编辑通用 MCP 服务器");
    modal.contentEl.style.minWidth = "400px";

    // 名称
    new Setting(modal.contentEl)
      .setName("名称")
      .setDesc("给这个 MCP 服务器起个名字")
      .addText(text => text
        .setPlaceholder("例如: Agenda MCP")
        .setValue(draft.name || "")
        .onChange(v => { draft.name = v.trim(); })
      );

    // Endpoint
    new Setting(modal.contentEl)
      .setName("Endpoint URL")
      .setDesc("MCP Server 的端点地址。支持 SSE（如 /sse）和 Streamable HTTP（如 /mcp）")
      .addText(text => text
        .setPlaceholder("http://localhost:3000/sse")
        .setValue(draft.endpoint || "")
        .onChange(v => { draft.endpoint = v.trim(); })
      );

    // 认证头
    new Setting(modal.contentEl)
      .setName("Authorization Header")
      .setDesc("可选。如需认证，填写完整的 Authorization 头值（如 Bearer xxx）")
      .addText(text => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Bearer your-token-here")
          .setValue(draft.authHeader || "")
          .onChange(v => { draft.authHeader = v.trim(); });
      });

    // 描述
    new Setting(modal.contentEl)
      .setName("描述")
      .setDesc("可选的描述信息")
      .addText(text => text
        .setPlaceholder("用于访问 Agenda 笔记...")
        .setValue(draft.description || "")
        .onChange(v => { draft.description = v.trim(); })
      );

    // 操作按钮
    const btnContainer = modal.contentEl.createDiv();
    btnContainer.style.display = "flex";
    btnContainer.style.justifyContent = "flex-end";
    btnContainer.style.gap = "8px";
    btnContainer.style.marginTop = "16px";

    const cancelBtn = btnContainer.createEl("button", { text: "取消" });
    cancelBtn.addEventListener("click", () => modal.close());

    const saveBtn = btnContainer.createEl("button", { text: isNew ? "添加" : "保存", cls: "mod-cta" });
    saveBtn.addEventListener("click", async () => {
      if (!draft.name) {
        new Notice("⚠️ 请填写服务器名称", 3000);
        return;
      }
      if (!draft.endpoint) {
        new Notice("⚠️ 请填写 Endpoint URL", 3000);
        return;
      }

      if (!Array.isArray(this.plugin.settings.mcpServers)) {
        this.plugin.settings.mcpServers = [];
      }

      if (isNew) {
        this.plugin.settings.mcpServers.push(draft as any);
      } else {
        const idx = this.plugin.settings.mcpServers.findIndex((s: any) => s.id === draft.id);
        if (idx >= 0) {
          this.plugin.settings.mcpServers[idx] = { ...this.plugin.settings.mcpServers[idx], ...draft } as any;
        }
      }

      await this.plugin.saveSettings();
      safeNotice(`✅ 已${isNew ? "添加" : "保存"} ${draft.name}`, 3000);
      modal.close();
      onSaved();
    });

    modal.open();
  }

  private renderRagSettings(containerEl: HTMLElement) {
    const ragCoreSectionEl = this.createCollapsibleSection(containerEl, "知识库问答配置", { open: true });

    new Setting(ragCoreSectionEl)
      .setName("检索笔记数量")
      .setDesc("每次检索最终提供给 AI 的笔记片段数。建议 5～20，开启 Rerank 时可适当调高。数值过大会增加 Token 消耗。")
      .addSlider(slider => slider
        .setLimits(1, 100, 1)
        .setValue(this.plugin.settings.retrievalCount)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.retrievalCount = value;
          await this.plugin.saveSettings();
        }));

    new Setting(ragCoreSectionEl)
      .setName("开启查询重写 (Query Rewriting)")
      .setDesc("使用 AI 自动扩展搜索关键词，提高检索召回率。会增加少量等待时间。")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableQueryRewriting)
        .onChange(async (value) => {
          this.plugin.settings.enableQueryRewriting = value;
          await this.plugin.saveSettings();
        }));

    new Setting(ragCoreSectionEl)
      .setName("启用重排序 (Rerank)")
      .setDesc("使用专业的 Rerank 模型对检索结果进行二次排序，显著提升精准度。详细配置请在[模型设置 - 用途绑定]中设置。")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableRerank)
        .onChange(async (value) => {
          this.plugin.settings.enableRerank = value;
          await this.plugin.saveSettings();
        }));

    new Setting(ragCoreSectionEl)
      .setName("开启图谱检索 (Graph RAG)")
      .setDesc("利用 Obsidian 双向链接特性，自动检索并融合相关联的笔记内容，提升上下文感知能力。")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableGraphRAG)
        .onChange(async (value) => {
          this.plugin.settings.enableGraphRAG = value;
          await this.plugin.saveSettings();
        }));

    new Setting(ragCoreSectionEl)
      .setName("图谱扩散深度")
      .setDesc("Graph RAG 查找关联笔记的深度 (1-3)。深度越大，上下文越丰富，但消耗 Token 越多。")
      .addSlider(slider => slider
        .setLimits(1, 3, 1)
        .setValue(this.plugin.settings.graphDepth)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.graphDepth = value;
          await this.plugin.saveSettings();
        }));

    new Setting(ragCoreSectionEl)
      .setName("包含正向链接 (Forward Links)")
      .setDesc("是否将检索到的笔记中引用的其他笔记也纳入上下文。")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableForwardLinks)
        .onChange(async (value) => {
          this.plugin.settings.enableForwardLinks = value;
          await this.plugin.saveSettings();
        }));

    new Setting(ragCoreSectionEl)
      .setName("包含反向链接 (Backlinks)")
      .setDesc("是否将引用了检索到的笔记的其他笔记也纳入上下文。")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableBacklinks)
        .onChange(async (value) => {
          this.plugin.settings.enableBacklinks = value;
          await this.plugin.saveSettings();
        }));

    const uxExperimentalSectionEl = this.createCollapsibleSection(containerEl, "顶级体验 (Experimental)");

    new Setting(uxExperimentalSectionEl)
      .setName("开启 Inline AI (幽灵写作)")
      .setDesc("在编辑器中实时预测下一句内容，按 Tab 键采纳。注意：会频繁调用 API，请留意 Token 消耗。模型可在[模型设置 - 用途绑定]中配置。")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableInlineAI)
        .onChange(async (value) => {
          this.plugin.settings.enableInlineAI = value;
          await this.plugin.saveSettings();
          // 需要重启插件或重新加载编辑器扩展
          new Notice("请重启 Obsidian 以生效 Inline AI。");
        }));

    new Setting(uxExperimentalSectionEl)
      .setName("开启 Smart Context (被动智能)")
      .setDesc("写作时自动在侧边栏推荐相关旧笔记。")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableSmartContext)
        .onChange(async (value) => {
          this.plugin.settings.enableSmartContext = value;
          await this.plugin.saveSettings();
        }));

    new Setting(uxExperimentalSectionEl)
      .setName("显示“协作”入口（实验）")
      .setDesc("开启后，聊天界面的工作模式中会显示“协作”入口。")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableExperimentalCollaborationMode)
        .onChange(async (value) => {
          this.plugin.settings.enableExperimentalCollaborationMode = value;
          await this.plugin.saveSettings();
          this.display();
        }));

    if (this.plugin.settings.enableExperimentalCollaborationMode) {
      new Setting(uxExperimentalSectionEl)
        .setName("启用协作能力")
        .setDesc("开启后，系统会在“协作”模式下自动识别意图并拆解复杂任务。")
        .addToggle(toggle =>
          toggle.setValue(this.plugin.settings.enableCollaboration).onChange(async (value) => {
            this.plugin.settings.enableCollaboration = value;
            await this.plugin.saveSettings();
            this.display();
          })
        );

      if (this.plugin.settings.enableCollaboration) {
        new Setting(uxExperimentalSectionEl)
          .setName("协作策略")
          .setDesc("选择“协作”模式处理任务的方式。默认简单模式会识别意图并路由到合适流程。")
          .addDropdown(dropdown =>
            dropdown
              .addOption('simple', '🚀 简单模式 - 意图识别 + 路由')
              .addOption('slow-thinking', '🐢 慢思考模式 - 先规划再执行')
              .addOption('pipeline', '📊 三段式管线 - 检索→分析→输出')
              .addOption('state-graph', '🤖 状态机模式 - 动态重规划+反思')
              .setValue(this.plugin.settings.collaborationStrategy || 'simple')
              .onChange(async (value: string) => {
                this.plugin.settings.collaborationStrategy = value as 'simple' | 'slow-thinking' | 'pipeline' | 'state-graph';
                await this.plugin.saveSettings();
                this.display();
              })
          );

        const strategyDesc = {
          'simple': '识别用户意图后，自动路由到普通聊天、知识库检索或智能体模式。适合大多数场景。',
          'slow-thinking': '先让 AI 生成执行计划（Todo List），然后按计划逐步执行。适合需要思考过程可见的场景。',
          'pipeline': '固定三步流程：① 研究员检索信息 → ② 分析师整理结构 → ③ 作家输出报告。适合信息汇总任务。',
          'state-graph': 'LangGraph 风格状态机：支持动态重规划、执行失败后自动反思、条件分支。适合复杂任务。'
        };
        const currentStrategy = this.plugin.settings.collaborationStrategy || 'simple';
        uxExperimentalSectionEl.createEl('p', {
          text: `💡 ${strategyDesc[currentStrategy]}`,
          cls: 'setting-item-description collaboration-strategy-hint'
        });
      }
    }

    new Setting(uxExperimentalSectionEl)
      .setName("群聊模式（实验）")
      .setDesc("开启后，聊天界面的工作模式中会显示“群聊”入口。")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableExperimentalGroupChatMode)
        .onChange(async (value) => {
          this.plugin.settings.enableExperimentalGroupChatMode = value;
          await this.plugin.saveSettings();
          this.display();
        }));

    new Setting(ragCoreSectionEl)
      .setName("排除文件夹")
      .setDesc("输入要排除的文件夹路径，每行一个。")
      .addTextArea(text => text
        .setPlaceholder("Example:\nPrivate/\nArchive/")
        .setValue(this.plugin.settings.excludedFolders.join("\n"))
        .onChange(async (value) => {
          this.plugin.settings.excludedFolders = value.split("\n").map(s => s.trim()).filter(s => s.length > 0);
          await this.plugin.saveSettings();
        }));

    // 迁移：角色与记忆、后台自主任务放到“知识库”页
        this.renderBackgroundTasksSettings(containerEl);
    // --BEGIN AUTO INDEX SETTINGS--
    const autoIndexSectionEl = this.createCollapsibleSection(containerEl, "自动索引更新", {
      description: "配置知识库的自动增量更新策略。",
    });

    new Setting(autoIndexSectionEl)
      .setName("启用自动索引")
      .setDesc("开启后将根据下方配置自动执行增量更新。")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoIndexEnabled)
        .onChange(async (value) => {
          this.plugin.settings.autoIndexEnabled = value;
          await this.plugin.saveSettings();
          this.plugin.refreshAutoIndexScheduler();
          this.display();
        }));

    new Setting(autoIndexSectionEl)
      .setName("间隔更新（分钟）")
      .setDesc("每隔多少分钟自动执行一次增量更新。设为 0 则禁用间隔更新。")
      .addSlider(slider => slider
        .setLimits(0, 360, 15)
        .setValue(this.plugin.settings.autoIndexIntervalMinutes)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.autoIndexIntervalMinutes = value;
          await this.plugin.saveSettings();
          this.plugin.refreshAutoIndexScheduler();
          this.display();
        }))
      .addExtraButton(btn => btn
        .setIcon("reset")
        .setTooltip("重置为默认值 (0)")
        .onClick(async () => {
          this.plugin.settings.autoIndexIntervalMinutes = 0;
          await this.plugin.saveSettings();
          this.plugin.refreshAutoIndexScheduler();
          this.display();
        }));

    new Setting(autoIndexSectionEl)
      .setName("每日定时更新")
      .setDesc("设置每天固定时间更新，格式 HH:MM（如 03:00）。留空则禁用定时更新。")
      .addText(text => text
        .setPlaceholder("03:00")
        .setValue(this.plugin.settings.autoIndexScheduledTime)
        .onChange(async (value) => {
          // 验证时间格式
          const trimmed = value.trim();
          if (trimmed && !/^\d{1,2}:\d{2}$/.test(trimmed)) {
            return; // 格式不对不保存
          }
          this.plugin.settings.autoIndexScheduledTime = trimmed;
          await this.plugin.saveSettings();
          this.plugin.refreshAutoIndexScheduler();
          this.display();
        }));
    const autoIndexStatusLabel = {
      idle: '尚未运行',
      success: '最近一次成功',
      error: '最近一次失败',
      skipped: '最近一次已跳过',
    } as const;
    const autoIndexTriggerLabel = {
      '': '',
      interval: '间隔触发',
      scheduled: '定时触发',
    } as const;
    const lastAutoIndexText = this.plugin.settings.lastAutoIndexRunAt
      ? new Date(this.plugin.settings.lastAutoIndexRunAt).toLocaleString()
      : '尚未运行';
    const autoIndexParts = [
      this.plugin.settings.autoIndexEnabled ? '已启用' : '未启用',
      `${autoIndexStatusLabel[this.plugin.settings.lastAutoIndexStatus || 'idle']}：${lastAutoIndexText}`,
    ];
    const triggerText = autoIndexTriggerLabel[this.plugin.settings.lastAutoIndexTrigger || ''];
    if (triggerText) {
      autoIndexParts.push(triggerText);
    }
    if (this.plugin.settings.lastAutoIndexStatus === 'error' && this.plugin.settings.lastAutoIndexError) {
      autoIndexParts.push(`错误：${this.plugin.settings.lastAutoIndexError}`);
    }
    autoIndexSectionEl.createEl('p', {
      text: `状态：${autoIndexParts.join('｜')}`,
      cls: 'setting-item-description'
    });
    // --END AUTO INDEX SETTINGS--
  }

  // Background Tasks Settings
  private renderBackgroundTasksSettings(containerEl: HTMLElement) {
    const backgroundTasksSectionEl = this.createCollapsibleSection(containerEl, "后台自主任务 (数字生命基础)");

    new Setting(backgroundTasksSectionEl)
      .setName("启用后台自主任务")
      .setDesc("开启后，AI 将在后台进行静默学习和自我反思（写日记）。")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableBackgroundTasks)
        .onChange(async (value) => {
          this.plugin.settings.enableBackgroundTasks = value;
          await this.plugin.saveSettings();
          this.display();
        }));

    new Setting(backgroundTasksSectionEl)
      .setName("任务触发间隔 (分钟)")
      .setDesc("AI 两次自主任务之间的最小间隔。")
      .addText(text => text
        .setValue(this.plugin.settings.backgroundTaskInterval.toString())
        .onChange(async (value) => {
          const num = parseInt(value);
          if (!isNaN(num)) {
            this.plugin.settings.backgroundTaskInterval = num;
            await this.plugin.saveSettings();
            this.display();
          }
        }));

    const lastReflectionText = this.plugin.settings.lastBackgroundReflectionAt
      ? new Date(this.plugin.settings.lastBackgroundReflectionAt).toLocaleString()
      : '尚未运行';
    const lastLearningText = this.plugin.settings.lastBackgroundLearningAt
      ? new Date(this.plugin.settings.lastBackgroundLearningAt).toLocaleString()
      : '尚未运行';
    const backgroundStatusParts = [
      this.plugin.settings.enableBackgroundTasks ? '已启用' : '未启用',
      `最近反思：${lastReflectionText}`,
      `最近学习：${lastLearningText}`,
    ];
    if (this.plugin.settings.lastBackgroundTaskError) {
      backgroundStatusParts.push(`最近错误：${this.plugin.settings.lastBackgroundTaskError}`);
    }
    backgroundTasksSectionEl.createEl('p', {
      text: `状态：${backgroundStatusParts.join('｜')}`,
      cls: 'setting-item-description'
    });
  }
  
  /**
   * 获取模型选项列表（用于可搜索选择器）
   */
  private getModelOptions(): ModelOption[] {
    const options: ModelOption[] = [];
    const connections = Array.isArray(this.plugin.settings.connections) ? this.plugin.settings.connections : [];
    const registry = Array.isArray(this.plugin.settings.modelRegistry) ? this.plugin.settings.modelRegistry : [];
    
    if (connections.length > 0 && registry.length > 0) {
      const connNameById = new Map(connections.map(c => [c.id, c.name] as const));
      
      // 统计每个模型名出现的次数，用于判断是否需要添加 connectionId 后缀
      const modelCounts: Record<string, number> = {};
      for (const item of registry) {
        const model = String(item?.model || '').trim();
        if (model) {
          modelCounts[model] = (modelCounts[model] || 0) + 1;
        }
      }
      
      const seenValues = new Set<string>();
      registry.forEach(item => {
        const model = String(item?.model || '').trim();
        const connId = String(item?.connectionId || '').trim();
        if (!model || !connId) return;
        
        // 如果模型名出现在多个连接中，使用 model@connectionId 作为唯一标识
        const isDuplicate = modelCounts[model] > 1;
        const value = isDuplicate ? `${model}@${connId}` : model;
        
        if (seenValues.has(value)) return;
        seenValues.add(value);
        
        const connName = connNameById.get(connId) || connId;
        options.push({
          value,
          displayText: `${model} (${connName})`,
          model,
          connectionName: connName
        });
      });
      return options;
    }
    
    // Fallback to legacy chatModels
    const defaultModels = this.plugin.settings.chatModels.split(',').map(m => m.trim()).filter(Boolean);
    defaultModels.forEach(m => {
      options.push({ value: m, displayText: m, model: m });
    });
    
    return options;
  }
  
  private addModelInput(setting: Setting, value: string, onChange: (value: string) => Promise<void>) {
    const modelOptions = this.getModelOptions();
    
    setting.controlEl?.addClass("ai-model-input-control");

    // 创建容器
    const wrapEl = setting.controlEl.createDiv({ cls: 'ai-model-searchable-wrap' });
    
    // 使用可搜索模型选择器
    const searchableSelect = new SearchableModelSelect(wrapEl, {
      placeholder: '搜索模型...',
      initialValue: value,
      onSelect: async (newValue) => {
        await onChange(newValue);
      }
    });
    
    searchableSelect.setOptions(modelOptions);
    searchableSelect.setValue(value);
    this.roleModelSelects.push(searchableSelect);
  }
}

/**
 * MCP 服务详情弹窗
 */
class McpServiceDetailModal extends Modal {
  private service: McpService;

  constructor(app: App, service: McpService) {
    super(app);
    this.service = service;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("mcp-service-detail-modal");

    contentEl.createEl("h2", { text: this.service.name });
    
    if (this.service.description) {
      contentEl.createEl("p", { text: this.service.description, cls: "mcp-service-desc" });
    }

    // Endpoint
    const endpointSection = contentEl.createDiv({ cls: "mcp-detail-section" });
    endpointSection.createEl("h4", { text: "🔗 Endpoint" });
    const endpointCode = endpointSection.createEl("code", { 
      text: this.service.endpoint,
      cls: "mcp-endpoint-code"
    });
    endpointCode.style.display = "block";
    endpointCode.style.padding = "8px";
    endpointCode.style.background = "var(--background-secondary)";
    endpointCode.style.borderRadius = "4px";
    endpointCode.style.wordBreak = "break-all";

    // 工具列表
    if (this.service.tools && this.service.tools.length > 0) {
      const toolsSection = contentEl.createDiv({ cls: "mcp-detail-section" });
      toolsSection.createEl("h4", { text: `🛠️ 工具列表（${this.service.tools.length} 个）` });
      toolsSection.createEl("p", { 
        text: "⚠️ AI 调用时使用下面的工具名（如 bailian_web_search），而不是服务名",
        cls: "text-muted"
      }).style.fontSize = "12px";
      
      for (const tool of this.service.tools) {
        const toolEl = toolsSection.createDiv({ cls: "mcp-tool-item" });
        toolEl.style.padding = "8px";
        toolEl.style.marginBottom = "8px";
        toolEl.style.background = "var(--background-secondary)";
        toolEl.style.borderRadius = "4px";
        
        const nameEl = toolEl.createEl("strong", { text: tool.name });
        nameEl.style.fontFamily = "var(--font-monospace)";
        nameEl.style.color = "var(--text-accent)";
        if (tool.description) {
          toolEl.createEl("p", { text: tool.description, cls: "mcp-tool-desc" });
        }
        
        if (tool.inputSchema) {
          const schemaEl = toolEl.createEl("details");
          schemaEl.createEl("summary", { text: "📋 输入参数 (JSON Schema)" });
          const pre = schemaEl.createEl("pre");
          pre.style.fontSize = "12px";
          pre.style.overflow = "auto";
          pre.style.maxHeight = "200px";
          pre.createEl("code", { 
            text: JSON.stringify(tool.inputSchema, null, 2) 
          });
        }
      }
    } else {
      contentEl.createEl("p", { text: "暂无工具信息。刷新服务列表后可能会更新。", cls: "text-muted" });
    }

    // 关闭按钮
    const btnContainer = contentEl.createDiv({ cls: "modal-button-container" });
    btnContainer.style.marginTop = "16px";
    const closeBtn = btnContainer.createEl("button", { text: "关闭" });
    closeBtn.onclick = () => this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}