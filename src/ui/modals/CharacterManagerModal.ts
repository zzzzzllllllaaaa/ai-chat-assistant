/**
 * 卡片式角色管理界面
 * 美观的网格布局，支持 SillyTavern 角色卡导入
 */

import { App, Modal, Notice, Setting, ButtonComponent, TextComponent, TFile, TFolder } from "obsidian";
import type { IPluginContext } from "../../core/plugin-context";;
import { Persona, UserPersona } from "../../core/settings";
import { Character, CharacterBook, CharacterBookEntry, LegacyPersona, WritingStyle } from "../../features/character/types";
import { CharacterCardParser, readFileAsArrayBuffer, readFileAsText } from "../../features/character/CharacterCard";
import { CandidateFileSuggestModal } from "./SuggestionModals";
import { parseWritingStyleNote, saveWritingStyleAsNote, WRITING_STYLE_NOTE_FOLDER } from "../../utils/writingStyleNotes";
import { 
  WRITING_STYLE_PRESETS, 
  DIMENSION_LABELS, 
  buildStyleAnalysisPrompt, 
  parseStyleAnalysisResponse 
} from "../../features/character/WritingStyleAnalyzer";

// 头像存储目录
const AVATAR_FOLDER = ".obsidian/plugins/ai-chat-assistant/avatars";

// 角色类型标签
const CHARACTER_TYPE_LABELS: Record<string, string> = {
  'all': '全部',
  'assistant': '助手',
  'character': '角色',
  'tool-agent': '智能体',
};

// 主 Tab 类型
type MainTab = 'ai-character' | 'user-character';

export class CharacterManagerModal extends Modal {
  plugin: IPluginContext;
  personas: Persona[];
  searchQuery: string = '';
  selectedTag: string = '';
  selectedType: string = 'all';
  gridContainer: HTMLElement | null = null;
  tagBarContainer: HTMLElement | null = null;
  mainContentEl: HTMLElement | null = null;
  currentTab: MainTab = 'ai-character';

  constructor(app: App, plugin: IPluginContext) {
    super(app);
    this.plugin = plugin;
    this.personas = this.plugin.settings.personas;
    // 在构造函数中就禁用动画
    this.modalEl.addClass('no-animation');
    this.containerEl.addClass('no-animation');
  }

  open() {
    super.open();
    // 立即禁用模态框动画，避免屏闪
    const modalBg = this.containerEl.querySelector('.modal-bg') as HTMLElement;
    if (modalBg) {
      modalBg.setCssStyles({ animation: 'none' });
      modalBg.setCssStyles({ opacity: '1' });
    }
    this.modalEl.setCssStyles({ animation: 'none' });
    this.modalEl.setCssStyles({ opacity: '1' });
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('character-manager-modal');
    
    // 标题栏
    const header = contentEl.createDiv({ cls: 'character-manager-header' });
    header.createEl('h2', { text: '角色管理' });
    
    // 主 Tab 切换栏
    const mainTabBar = contentEl.createDiv({ cls: 'character-main-tab-bar' });
    this.renderMainTabBar(mainTabBar);
    
    // 主内容区域
    this.mainContentEl = contentEl.createDiv({ cls: 'character-main-content' });
    this.renderCurrentTab();
  }

  renderMainTabBar(container: HTMLElement) {
    container.empty();
    
    const tabs: { id: MainTab; label: string; icon: string }[] = [
      { id: 'ai-character', label: 'AI 角色', icon: '🤖' },
      { id: 'user-character', label: '用户角色', icon: '👤' },
    ];
    
    for (const tab of tabs) {
      const btn = container.createEl('button', {
        cls: `character-main-tab ${this.currentTab === tab.id ? 'active' : ''}`,
        text: `${tab.icon} ${tab.label}`,
      });
      btn.addEventListener('click', () => {
        this.currentTab = tab.id;
        this.renderMainTabBar(container);
        this.renderCurrentTab();
      });
    }
  }

  renderCurrentTab() {
    if (!this.mainContentEl) return;
    this.mainContentEl.empty();
    
    if (this.currentTab === 'ai-character') {
      this.renderAICharacterTab(this.mainContentEl);
    } else {
      this.renderUserCharacterTab(this.mainContentEl);
    }
  }

  renderAICharacterTab(container: HTMLElement) {
    // 工具栏
    const toolbar = container.createDiv({ cls: 'character-manager-toolbar' });
    
    // 搜索框
    const searchContainer = toolbar.createDiv({ cls: 'character-search-container' });
    const searchInput = new TextComponent(searchContainer);
    searchInput.setPlaceholder('搜索角色...');
    searchInput.setValue(this.searchQuery);
    searchInput.onChange(value => {
      this.searchQuery = value.toLowerCase();
      this.renderGrid();
    });
    searchInput.inputEl.addClass('character-search-input');
    
    // 按钮组
    const buttonGroup = toolbar.createDiv({ cls: 'character-toolbar-buttons' });
    
    // 导入按钮
    new ButtonComponent(buttonGroup)
      .setButtonText('导入角色卡')
      .setIcon('download')
      .setTooltip('导入 SillyTavern 角色卡 (PNG/JSON)')
      .onClick(() => this.showImportDialog());
    
    // 新建按钮
    new ButtonComponent(buttonGroup)
      .setButtonText('新建角色')
      .setIcon('plus')
      .setCta()
      .onClick(() => this.openEditModal(null));
    
    // 类型过滤栏
    const typeBar = container.createDiv({ cls: 'character-type-bar' });
    this.renderTypeBar(typeBar);
    
    // 角色列表
    this.gridContainer = container.createDiv({ cls: 'character-list' });
    this.renderGrid();
  }

  renderUserCharacterTab(container: HTMLElement) {
    const userPersonas = this.plugin.settings.userPersonas || [];
    const activeId = this.plugin.settings.activeUserPersonaId;
    
    // 工具栏
    const toolbar = container.createDiv({ cls: 'character-manager-toolbar' });
    
    // 说明文字
    const hint = toolbar.createDiv({ cls: 'user-persona-hint' });
    hint.setText('用户角色用于设定你在对话中的身份，{{user}} 会替换为当前选中角色的名字。');
    
    // 新建按钮
    const buttonGroup = toolbar.createDiv({ cls: 'character-toolbar-buttons' });
    new ButtonComponent(buttonGroup)
      .setButtonText('新建用户角色')
      .setIcon('plus')
      .setCta()
      .onClick(() => this.openUserPersonaEditModal(null));
    
    // 用户角色列表
    const list = container.createDiv({ cls: 'character-list user-persona-list' });
    
    if (userPersonas.length === 0) {
      const empty = list.createDiv({ cls: 'character-list-empty' });
      empty.createDiv({ cls: 'empty-icon', text: '👤' });
      empty.createDiv({ cls: 'empty-text', text: '暂无用户角色' });
      empty.createDiv({ cls: 'empty-hint', text: '点击"新建用户角色"创建你的第一个角色' });
      return;
    }
    
    for (const userPersona of userPersonas) {
      this.renderUserPersonaItem(list, userPersona, userPersona.id === activeId);
    }
  }

  renderUserPersonaItem(container: HTMLElement, userPersona: UserPersona, isActive: boolean) {
    const item = container.createDiv({ cls: `character-list-item user-persona-item ${isActive ? 'active' : ''}` });
    
    // 头像区域
    const avatarArea = item.createDiv({ cls: 'character-item-avatar' });
    if (userPersona.avatar) {
      const img = avatarArea.createEl('img');
      img.src = userPersona.avatar;
    } else {
      avatarArea.createDiv({ cls: 'avatar-placeholder', text: '👤' });
    }
    
    // 信息区域
    const info = item.createDiv({ cls: 'character-item-info' });
    const nameRow = info.createDiv({ cls: 'character-item-name' });
    nameRow.setText(userPersona.name);
    if (isActive) {
      nameRow.createSpan({ text: ' (当前)', cls: 'character-item-badge' });
    }
    
    if (userPersona.description) {
      info.createDiv({ cls: 'character-item-desc', text: userPersona.description });
    }
    
    // 操作按钮
    const actions = item.createDiv({ cls: 'character-item-actions' });
    
    // 选择按钮（如果不是当前激活的）
    if (!isActive) {
      const selectBtn = actions.createEl('button', { cls: 'character-item-btn select' });
      selectBtn.setText('✓');
      selectBtn.title = '设为当前';
      selectBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        this.plugin.settings.activeUserPersonaId = userPersona.id;
        await this.plugin.saveSettings();
        new Notice(`已切换用户角色: ${userPersona.name}`);
        this.renderCurrentTab();
      });
    }
    
    // 编辑按钮
    const editBtn = actions.createEl('button', { cls: 'character-item-btn edit' });
    editBtn.setText('✏️');
    editBtn.title = '编辑';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openUserPersonaEditModal(userPersona);
    });
    
    // 删除按钮（不能删除最后一个）
    if (this.plugin.settings.userPersonas.length > 1) {
      const deleteBtn = actions.createEl('button', { cls: 'character-item-btn delete' });
      deleteBtn.setText('🗑️');
      deleteBtn.title = '删除';
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm(`确定要删除用户角色 "${userPersona.name}" 吗？`)) {
          await this.deleteUserPersona(userPersona.id);
        }
      });
    }
    
    // 点击列表项也可以选择
    item.addEventListener('click', async () => {
      if (!isActive) {
        this.plugin.settings.activeUserPersonaId = userPersona.id;
        await this.plugin.saveSettings();
        new Notice(`已切换用户角色: ${userPersona.name}`);
        this.renderCurrentTab();
      }
    });
  }

  async deleteUserPersona(id: string) {
    const index = this.plugin.settings.userPersonas.findIndex(p => p.id === id);
    if (index === -1) return;
    
    const deleted = this.plugin.settings.userPersonas[index];
    this.plugin.settings.userPersonas.splice(index, 1);
    
    // 如果删除的是当前激活的，切换到第一个
    if (this.plugin.settings.activeUserPersonaId === id) {
      this.plugin.settings.activeUserPersonaId = this.plugin.settings.userPersonas[0]?.id || '';
    }
    
    await this.plugin.saveSettings();
    new Notice(`已删除用户角色: ${deleted.name}`);
    this.renderCurrentTab();
  }

  openUserPersonaEditModal(userPersona: UserPersona | null) {
    // 先隐藏当前模态框，避免屏闪（使用visibility保持布局）
    this.modalEl.setCssStyles({ visibility: 'hidden' });
    this.modalEl.setCssStyles({ opacity: '0' });
    new UserPersonaEditModal(this.app, this.plugin, userPersona, async () => {
      this.renderCurrentTab();
    }, () => {
      // 编辑模态框关闭后，重新显示管理器
      this.modalEl.setCssStyles({ visibility: '' });
      this.modalEl.setCssStyles({ opacity: '' });
    }).open();
  }

  renderTypeBar(container: HTMLElement) {
    container.empty();
    
    // 类型筛选按钮
    for (const [type, label] of Object.entries(CHARACTER_TYPE_LABELS)) {
      const btn = container.createEl('button', {
        text: label,
        cls: `character-type-btn ${this.selectedType === type ? 'active' : ''}`
      });
      btn.onclick = () => {
        this.selectedType = type;
        this.renderTypeBar(container);
        this.renderGrid();
      };
    }
  }

  // 标签过滤已移除，避免导入角色卡的大量标签影响界面美观

  renderGrid() {
    if (!this.gridContainer) return;
    this.gridContainer.empty();
    
    // 更新角色列表
    
    // 过滤角色
    let filtered = this.personas;
    
    // 类型过滤
    if (this.selectedType !== 'all') {
      filtered = filtered.filter(p => {
        const pType = (p as any).type || 'assistant';
        return pType === this.selectedType;
      });
    }
    
    // 搜索过滤
    if (this.searchQuery) {
      filtered = filtered.filter(p => 
        p.name.toLowerCase().includes(this.searchQuery) ||
        p.description.toLowerCase().includes(this.searchQuery)
      );
    }
    
    if (filtered.length === 0) {
      const empty = this.gridContainer.createDiv({ cls: 'character-list-empty' });
      empty.createEl('div', { text: '📭', cls: 'empty-icon' });
      empty.createEl('div', { text: '暂无角色', cls: 'empty-text' });
      empty.createEl('div', { 
        text: '点击"新建角色"或"导入角色卡"添加', 
        cls: 'empty-hint' 
      });
      return;
    }
    
    // 渲染列表项
    filtered.forEach((persona, index) => {
      this.renderItem(this.gridContainer!, persona, index);
    });
  }

  renderItem(container: HTMLElement, persona: Persona, index: number) {
    const isActive = this.plugin.settings.activePersonaId === persona.id;
    
    const item = container.createDiv({ 
      cls: `character-list-item ${isActive ? 'active' : ''}` 
    });
    
    // 头像区域
    const avatarArea = item.createDiv({ cls: 'character-item-avatar' });
    if (persona.avatar) {
      const avatarSrc = this.getAvatarSrc(persona.avatar);
      const img = avatarArea.createEl('img', { attr: { src: avatarSrc } });
      img.onerror = () => {
        img.remove();
        avatarArea.createDiv({ cls: 'avatar-placeholder', text: persona.name.charAt(0).toUpperCase() });
      };
    } else {
      avatarArea.createDiv({ 
        cls: 'avatar-placeholder', 
        text: persona.name.charAt(0).toUpperCase() 
      });
    }
    
    // 信息区域
    const info = item.createDiv({ cls: 'character-item-info' });
    const nameRow = info.createDiv({ cls: 'character-item-name' });
    nameRow.setText(persona.name);
    if (isActive) {
      nameRow.createSpan({ text: ' (当前)', cls: 'character-item-badge' });
    }
    
    // 标签行
    const tags = (persona as any).tags as string[] | undefined;
    if (tags && tags.length > 0) {
      const tagRow = info.createDiv({ cls: 'character-item-tags' });
      tags.slice(0, 2).forEach(tag => {
        tagRow.createSpan({ text: tag, cls: 'character-item-tag' });
      });
      if (tags.length > 2) {
        tagRow.createSpan({ text: `+${tags.length - 2}`, cls: 'character-item-tag more' });
      }
    }
    
    // 操作按钮
    const actions = item.createDiv({ cls: 'character-item-actions' });
    
    // 激活按钮
    if (!isActive) {
      const activateBtn = actions.createEl('button', { cls: 'character-item-btn activate' });
      activateBtn.setText('✓');
      activateBtn.title = '设为当前角色';
      activateBtn.onclick = async (e) => {
        e.stopPropagation();
        this.plugin.settings.activePersonaId = persona.id;
        await this.plugin.saveSettings();
        new Notice(`已切换到角色: ${persona.name}`);
        this.renderGrid();
      };
    }
    
    // 编辑按钮
    const editBtn = actions.createEl('button', { cls: 'character-item-btn edit' });
    editBtn.setText('✏️');
    editBtn.title = '编辑';
    editBtn.onclick = (e) => {
      e.stopPropagation();
      this.openEditModal(persona);
    };
    
    // 导出按钮
    const exportBtn = actions.createEl('button', { cls: 'character-item-btn export' });
    exportBtn.setText('📤');
    exportBtn.title = '导出';
    exportBtn.onclick = (e) => {
      e.stopPropagation();
      this.showExportOptions(persona);
    };
    
    // 清除记忆按钮
    const clearMemoryBtn = actions.createEl('button', { cls: 'character-item-btn clear-memory' });
    clearMemoryBtn.setText('🧹');
    clearMemoryBtn.title = '清除记忆';
    clearMemoryBtn.onclick = async (e) => {
      e.stopPropagation();
      new ClearMemoryModal(this.app, this.plugin, persona).open();
    };
    
    // 删除按钮
    const deleteBtn = actions.createEl('button', { cls: 'character-item-btn delete' });
    deleteBtn.setText('🗑️');
    deleteBtn.title = '删除';
    deleteBtn.onclick = async (e) => {
      e.stopPropagation();
      new DeletePersonaModal(this.app, this.plugin, persona, async (mode) => {
        await this.handleDeletePersona(persona, mode);
      }).open();
    };
    
    // 点击列表项激活
    item.onclick = async () => {
      if (!isActive) {
        this.plugin.settings.activePersonaId = persona.id;
        await this.plugin.saveSettings();
        new Notice(`已切换到角色: ${persona.name}`);
        this.renderGrid();
      }
    };
  }

  private async handleDeletePersona(persona: Persona, mode: 'keep' | 'delete' | 'archive') {
    const confirmed = confirm(`确定要删除角色 "${persona.name}" 吗？`);
    if (!confirmed) return;

    const idx = this.personas.findIndex(p => p.id === persona.id);
    if (idx === -1) return;

    if (mode === 'delete') {
      await this.plugin.memoryManager?.deletePersonaMemory(persona.id);
    }

    if (mode === 'archive') {
      await this.plugin.memoryManager?.archivePersonaMemory(persona.id);
    }

    this.personas.splice(idx, 1);
    await this.plugin.saveSettings();
    this.renderGrid();
    new Notice(`已删除角色: ${persona.name}`);
  }

  async showImportDialog() {
    // 创建隐藏的文件输入
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.png,.json';
    input.multiple = true;
    
    input.onchange = async (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (!files || files.length === 0) return;
      
      let imported = 0;
      let failed = 0;
      
      for (const file of Array.from(files)) {
        try {
          let result;
          let pngBuffer: ArrayBuffer | null = null;
          
          if (file.name.endsWith('.png')) {
            pngBuffer = await readFileAsArrayBuffer(file);
            result = await CharacterCardParser.parseFromPNG(pngBuffer);
          } else if (file.name.endsWith('.json')) {
            const text = await readFileAsText(file);
            result = CharacterCardParser.parseFromJSON(text);
          } else {
            failed++;
            continue;
          }
          
          if (result.success && result.data) {
            // 转换为 Persona 格式存储（兼容现有系统）
            const character = result.data;
            const persona: Persona = {
              id: character.id,
              name: character.name,
              description: '',
              systemPrompt: character.systemPrompt,
              avatar: character.avatar,
              mbti: character.mbti,
            };

            if (pngBuffer) {
              const avatarPath = await this.saveImportedAvatarFromPng(pngBuffer, file.name, character.id);
              if (avatarPath) {
                persona.avatar = avatarPath;
              }
            }
            
            // 保存额外字段
            (persona as any).tags = character.tags;
            (persona as any).greeting = character.greeting;
            (persona as any).alternateGreetings = character.alternateGreetings || [];
            (persona as any).personality = character.personality;
            (persona as any).scenario = character.scenario;
            (persona as any).exampleMessages = character.exampleMessages;
            (persona as any).creatorNotes = character.creatorNotes;
            (persona as any).postHistoryInstructions = character.postHistoryInstructions;
            (persona as any).type = character.type;
            
            // 处理角色书/知识库：转存为记忆文件
            if (character.characterBook && character.characterBook.entries && character.characterBook.entries.length > 0) {
              await this.saveCharacterBookAsMemory(character.characterBook, persona.id, character.name);
              (persona as any).hasCharacterBook = true;
              new Notice(`📚 已导入角色知识库 (${character.characterBook.entries.length} 条)`);
            } else {
            }
            
            this.personas.push(persona);
            imported++;
            
            if (result.warnings && result.warnings.length > 0) {
            }
          } else {
            console.error(`[CharacterImport] ${file.name} 失败:`, result.error);
            failed++;
          }
        } catch (e) {
          console.error(`[CharacterImport] ${file.name} 异常:`, e);
          failed++;
        }
      }
      
      await this.plugin.saveSettings();
      this.renderGrid();
      
      if (imported > 0) {
        new Notice(`成功导入 ${imported} 个角色${failed > 0 ? `，${failed} 个失败` : ''}`);
      } else {
        new Notice(`导入失败：${failed} 个文件无法解析`);
      }
    };
    
    input.click();
  }

  private async saveImportedAvatarFromPng(buffer: ArrayBuffer, originalName: string, personaId: string): Promise<string | null> {
    try {
      const adapter = this.app.vault.adapter;
      if (!await adapter.exists(AVATAR_FOLDER)) {
        await adapter.mkdir(AVATAR_FOLDER);
      }

      const safeBase = originalName.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_');
      const fileName = `st_${safeBase || 'avatar'}_${personaId}_${Date.now()}.png`;
      const filePath = `${AVATAR_FOLDER}/${fileName}`;
      await adapter.writeBinary(filePath, buffer);
      return filePath;
    } catch (e) {
      console.error('[CharacterImport] 保存 PNG 头像失败:', e);
      return null;
    }
  }

  /**
   * 将角色书/知识库保存为记忆文件
   * 角色书条目会被转换为 Markdown 格式存入角色的 Facts 目录
   */
  private async saveCharacterBookAsMemory(
    characterBook: import('../../features/character/types').CharacterBook,
    personaId: string,
    characterName: string
  ): Promise<void> {
    try {
      const memoryPath = this.plugin.settings.memoryPath || 'AI_Memory';
      const safeName = characterName.replace(/[\\/:*?"<>|]/g, '_').trim() || personaId;
      const basePath = `${memoryPath}/${safeName}`;
      const factsPath = `${basePath}/Facts`;
      const lorebookPath = `${factsPath}/角色知识库.md`;
      
      const adapter = this.app.vault.adapter;
      
      // 确保目录存在
      if (!await adapter.exists(memoryPath)) {
        await adapter.mkdir(memoryPath);
      }
      if (!await adapter.exists(basePath)) {
        await adapter.mkdir(basePath);
      }
      if (!await adapter.exists(factsPath)) {
        await adapter.mkdir(factsPath);
      }
      
      // 统计启用和禁用的条目
      const entries = characterBook.entries || [];
      const enabledCount = entries.filter(e => e.enabled !== false).length;
      const disabledCount = entries.filter(e => e.enabled === false).length;
      
      // 构建 Markdown 内容
      const lines: string[] = [];
      lines.push(`# ${characterBook.name || characterName} - 角色知识库`);
      lines.push('');
      if (characterBook.description) {
        lines.push(`> ${characterBook.description}`);
        lines.push('');
      }
      lines.push(`导入时间：${new Date().toLocaleString('zh-CN')}`);
      lines.push(`条目数量：${entries.length}（启用 ${enabledCount}，禁用 ${disabledCount}）`);
      lines.push('');
      lines.push('> 💡 **提示**：标题带 `(禁用)` 的条目不会被读取。直接编辑标题即可切换启用状态。');
      lines.push('');
      lines.push('---');
      lines.push('');
      
      // 遍历条目
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const entryName = entry.name || `条目 ${i + 1}`;
        const keys = entry.keys?.join(', ') || '';
        const secondaryKeys = entry.secondary_keys?.join(', ') || '';
        const isDisabled = entry.enabled === false;
        
        // 标题：禁用的条目添加 (禁用) 标记
        if (isDisabled) {
          lines.push(`## ${entryName} (禁用)`);
        } else {
          lines.push(`## ${entryName}`);
        }
        lines.push('');
        
        // 元数据
        if (keys) {
          lines.push(`**触发词**：${keys}`);
        }
        if (secondaryKeys) {
          lines.push(`**次要触发词**：${secondaryKeys}`);
        }
        if (entry.comment) {
          lines.push(`**备注**：${entry.comment}`);
        }
        if (entry.constant) {
          lines.push(`**常驻**：是`);
        }
        if (entry.position) {
          const posText = entry.position === 'before_char' ? '角色定义之前' : '角色定义之后';
          lines.push(`**插入位置**：${posText}`);
        }
        lines.push('');
        
        // 内容
        lines.push(entry.content || '（无内容）');
        lines.push('');
        lines.push('---');
        lines.push('');
      }
      
      // 写入文件
      await adapter.write(lorebookPath, lines.join('\n'));
      
    } catch (e) {
      console.error('[CharacterImport] 保存角色知识库失败:', e);
    }
  }

  private getCharacterExportFolder(): string {
    return 'AI_Exports/角色卡';
  }

  private getPersonaMemoryPaths(persona: Persona): { basePath: string; factsPath: string; lorebookPath: string } {
    const memoryPath = this.plugin.settings.memoryPath || 'AI_Memory';
    const rawName = String(persona.name || "").trim();
    // Keep consistent with ClearMemoryModal's folder derivation
    const safeName = rawName.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().slice(0, 48);
    const folderName = safeName || String(persona.id || "").replace(/[^a-zA-Z0-9\u4e00-\u9fa5-_]/g, "_") || "default";
    const basePath = `${memoryPath}/${folderName}`;
    const factsPath = `${basePath}/Facts`;
    const lorebookPath = `${factsPath}/角色知识库.md`;
    return { basePath, factsPath, lorebookPath };
  }

  private parseCharacterBookFromMarkdown(markdown: string, fallbackName: string): CharacterBook | null {
    const text = String(markdown || '').trim();
    if (!text) return null;

    // Top-level title
    let bookName = fallbackName;
    const titleMatch = text.match(/^#\s+(.+?)\s*$/m);
    if (titleMatch?.[1]) {
      bookName = titleMatch[1].replace(/\s*-\s*角色知识库\s*$/i, '').trim() || fallbackName;
    }

    // Optional description: first blockquote line
    const descMatch = text.match(/^>\s+(.+?)\s*$/m);
    const description = descMatch?.[1]?.trim() || '';

    const entries: CharacterBookEntry[] = [];

    // Split by "## " sections
    const sectionRegex = /^##\s+(.+?)\s*$/gm;
    const indices: Array<{ nameLine: string; start: number; end: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = sectionRegex.exec(text))) {
      indices.push({ nameLine: String(m[1] || '').trim(), start: m.index, end: 0 });
    }
    if (indices.length === 0) {
      return {
        name: bookName,
        description,
        extensions: {},
        entries: [],
      };
    }
    for (let i = 0; i < indices.length; i++) {
      indices[i].end = i + 1 < indices.length ? indices[i + 1].start : text.length;
    }

    const disabledMarkRe = /\((?:已)?禁用\)|（(?:已)?禁用）/;

    const splitList = (raw: string): string[] => {
      return String(raw || '')
        .split(/[，,]/g)
        .map(s => s.trim())
        .filter(Boolean)
        .slice(0, 24);
    };

    for (let i = 0; i < indices.length; i++) {
      const rawHeading = indices[i].nameLine;
      const enabled = !disabledMarkRe.test(rawHeading);
      const entryName = rawHeading.replace(disabledMarkRe, '').trim();

      // body text is from end of heading line to section end
      const sectionText = text.slice(indices[i].start, indices[i].end);
      const body = sectionText.replace(/^##\s+.+?\s*$/m, '').trim();

      const keysLine = body.match(/^\*\*触发词\*\*：\s*(.+?)\s*$/m);
      const secondaryLine = body.match(/^\*\*次要触发词\*\*：\s*(.+?)\s*$/m);
      const commentLine = body.match(/^\*\*备注\*\*：\s*(.+?)\s*$/m);
      const constantLine = body.match(/^\*\*常驻\*\*：\s*(.+?)\s*$/m);
      const positionLine = body.match(/^\*\*插入位置\*\*：\s*(.+?)\s*$/m);

      const keys = keysLine?.[1] ? splitList(keysLine[1]) : [];
      const secondaryKeys = secondaryLine?.[1] ? splitList(secondaryLine[1]) : [];
      const comment = commentLine?.[1] ? String(commentLine[1]).trim() : undefined;
      const constantRaw = constantLine?.[1] ? String(constantLine[1]).trim() : '';
      const constant = /^(是|true|yes|1)$/i.test(constantRaw);
      const positionRaw = positionLine?.[1] ? String(positionLine[1]).trim() : '';
      const position = /之前/.test(positionRaw) ? 'before_char' : /之后/.test(positionRaw) ? 'after_char' : undefined;

      // Remove metadata + separators from content
      const content = body
        .split('\n')
        .filter(line => {
          const t = line.trim();
          if (!t) return true;
          if (t === '---') return false;
          if (/^\*\*(触发词|次要触发词|备注|常驻|插入位置)\*\*：/.test(t)) return false;
          return true;
        })
        .join('\n')
        .trim();

      const entry: CharacterBookEntry = {
        keys,
        secondary_keys: secondaryKeys.length > 0 ? secondaryKeys : undefined,
        content: content || '',
        extensions: {},
        enabled,
        insertion_order: i,
        name: entryName || `条目 ${i + 1}`,
        comment,
        constant: constant || undefined,
        position,
        id: i + 1,
      };

      entries.push(entry);
    }

    return {
      name: bookName,
      description,
      extensions: {},
      entries,
    };
  }

  private async loadCharacterBookFromMemory(persona: Persona): Promise<CharacterBook | null> {
    try {
      const { lorebookPath } = this.getPersonaMemoryPaths(persona);
      const file = this.app.vault.getAbstractFileByPath(lorebookPath);
      if (!(file instanceof TFile)) return null;
      const md = await this.app.vault.read(file);
      return this.parseCharacterBookFromMarkdown(md, persona.name || persona.id);
    } catch (e) {
      console.warn('[Export] Failed to load lorebook from memory', e);
      return null;
    }
  }

  private sanitizeExportFileName(name: string): string {
    return String(name || 'character').replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_');
  }

  private async ensureCharacterExportFolder(): Promise<string> {
    const folderPath = this.getCharacterExportFolder();
    const abstract = this.app.vault.getAbstractFileByPath(folderPath);
    if (!abstract) {
      await this.app.vault.createFolder(folderPath);
    }
    return folderPath;
  }

  async exportCharacter(persona: Persona) {
    const fallbackCharacterBook = (persona as any).characterBook || await this.loadCharacterBookFromMemory(persona);

    // 转换为 Character 格式
    const character: Character = {
      id: persona.id,
      spec: 'obsidian_ai_v1',
      name: persona.name,
      description: persona.description,
      systemPrompt: persona.systemPrompt,
      avatar: persona.avatar,
      mbti: persona.mbti,
      tags: (persona as any).tags || [],
      type: (persona as any).type || 'assistant',
      greeting: (persona as any).greeting,
      personality: (persona as any).personality,
      scenario: (persona as any).scenario,
      exampleMessages: (persona as any).exampleMessages,
      creatorNotes: (persona as any).creatorNotes,
      postHistoryInstructions: (persona as any).postHistoryInstructions,
      characterBook: fallbackCharacterBook || undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    
    // 导出为 SillyTavern V2 JSON
    const json = CharacterCardParser.exportToJSON(character, 'tavern');
    
    // 导出到库内文件夹
    const folderPath = await this.ensureCharacterExportFolder();
    const fileName = `${this.sanitizeExportFileName(persona.name)}.json`;
    const targetPath = `${folderPath}/${fileName}`;
    const existing = this.app.vault.getAbstractFileByPath(targetPath);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, json);
    } else {
      await this.app.vault.create(targetPath, json);
    }

    new Notice(`角色卡已导出到库内: ${targetPath}`);
  }

  /**
   * 显示导出格式选项
   */
  showExportOptions(persona: Persona) {
    const menu = this.contentEl.createDiv({ cls: 'export-options-menu' });
    
    // 背景遮罩
    const overlay = this.contentEl.createDiv({ cls: 'export-options-overlay' });
    overlay.onclick = () => {
      menu.remove();
      overlay.remove();
    };
    
    menu.createEl('div', { text: '选择导出格式', cls: 'export-options-title' });
    
    // JSON 选项
    const jsonOption = menu.createDiv({ cls: 'export-option' });
    jsonOption.createEl('span', { text: '📄 JSON 格式' });
    jsonOption.createEl('small', { text: '导出到库内 AI_Exports/角色卡/' });
    jsonOption.onclick = async () => {
      menu.remove();
      overlay.remove();
      await this.exportCharacter(persona);
    };
    
    // PNG 选项
    const pngOption = menu.createDiv({ cls: 'export-option' });
    pngOption.createEl('span', { text: '🖼️ PNG 角色卡' });
    pngOption.createEl('small', { text: '导出到库内 AI_Exports/角色卡/（可拖入 SillyTavern）' });
    pngOption.onclick = async () => {
      menu.remove();
      overlay.remove();
      await this.exportCharacterAsPNG(persona);
    };
    
    // 取消选项
    const cancelOption = menu.createDiv({ cls: 'export-option cancel' });
    cancelOption.createEl('span', { text: '取消' });
    cancelOption.onclick = () => {
      menu.remove();
      overlay.remove();
    };
  }

  /**
   * 导出为 PNG 角色卡
   */
  async exportCharacterAsPNG(persona: Persona) {
    const fallbackCharacterBook = (persona as any).characterBook || await this.loadCharacterBookFromMemory(persona);

    // 转换为 Character 格式
    const character: Character = {
      id: persona.id,
      spec: 'obsidian_ai_v1',
      name: persona.name,
      description: persona.description,
      systemPrompt: persona.systemPrompt,
      avatar: persona.avatar,
      mbti: persona.mbti,
      tags: (persona as any).tags || [],
      type: (persona as any).type || 'assistant',
      greeting: (persona as any).greeting,
      personality: (persona as any).personality,
      scenario: (persona as any).scenario,
      exampleMessages: (persona as any).exampleMessages,
      creatorNotes: (persona as any).creatorNotes,
      postHistoryInstructions: (persona as any).postHistoryInstructions,
      characterBook: fallbackCharacterBook || undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    
    // 获取头像 data URL（如果有）
    let avatarDataUrl: string | undefined;
    if (persona.avatar) {
      if (persona.avatar.startsWith('data:image/png')) {
        avatarDataUrl = persona.avatar;
      } else if (!persona.avatar.startsWith('http')) {
        // 尝试从 vault 读取
        try {
          const avatarPath = persona.avatar;
          const adapter = this.app.vault.adapter;
          if (await adapter.exists(avatarPath)) {
            const buffer = await adapter.readBinary(avatarPath);
            const base64 = this.arrayBufferToBase64(buffer);
            const ext = avatarPath.split('.').pop()?.toLowerCase();
            if (ext === 'png') {
              avatarDataUrl = `data:image/png;base64,${base64}`;
            }
          }
        } catch (e) {
        }
      }
    }
    
    try {
      const blob = await CharacterCardParser.exportToPNG(character, avatarDataUrl);
      const folderPath = await this.ensureCharacterExportFolder();
      const fileName = `${this.sanitizeExportFileName(persona.name)}.png`;
      const targetPath = `${folderPath}/${fileName}`;
      const arrayBuffer = await blob.arrayBuffer();
      const existing = this.app.vault.getAbstractFileByPath(targetPath);
      if (existing instanceof TFile) {
        await this.app.vault.adapter.writeBinary(targetPath, arrayBuffer);
      } else {
        await this.app.vault.adapter.writeBinary(targetPath, arrayBuffer);
      }

      new Notice(`PNG 角色卡已导出到库内: ${targetPath}`);
    } catch (e) {
      console.error('[ExportPNG] 导出失败:', e);
      new Notice('PNG 导出失败，请重试');
    }
  }

  /**
   * ArrayBuffer 转 Base64
   */
  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  openEditModal(persona: Persona | null) {
    // 先隐藏当前模态框，避免屏闪（使用visibility保持布局）
    this.modalEl.setCssStyles({ visibility: 'hidden' });
    this.modalEl.setCssStyles({ opacity: '0' });
    new CharacterEditModal(this.app, this.plugin, persona, async (newPersona) => {
      if (persona) {
        const index = this.personas.findIndex(p => p.id === persona.id);
        if (index !== -1) {
          this.personas[index] = newPersona;
        }
      } else {
        this.personas.push(newPersona);
      }
      await this.plugin.saveSettings();
      
      // 刷新 Agent 列表（如果角色绑定了工具）
      if (this.plugin.agentManager) {
        this.plugin.agentManager.loadAgentsFromSettings(
          this.plugin.settings.customAgents, 
          this.plugin.settings.hiddenPresetAgentIds || [],
          this.plugin.settings.personas
        );
      }
      
      this.renderGrid();
    }, () => {
      // 编辑模态框关闭后，重新显示管理器
      this.modalEl.setCssStyles({ visibility: '' });
      this.modalEl.setCssStyles({ opacity: '' });
    }).open();
  }

  /**
   * 获取头像的显示 src
   * 支持 vault 路径、URL、Base64
   */
  getAvatarSrc(avatar: string): string {
    if (!avatar) return '';
    
    // 已经是 URL 或 Base64
    if (avatar.startsWith('http') || avatar.startsWith('data:')) {
      return avatar;
    }
    
    // vault 路径 - 转换为资源路径
    return this.app.vault.adapter.getResourcePath(avatar);
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.removeClass('character-manager-modal');
  }
}

class DeletePersonaModal extends Modal {
  private plugin: IPluginContext;
  private persona: Persona;
  private onConfirm: (mode: 'keep' | 'delete' | 'archive') => void;

  constructor(app: App, plugin: IPluginContext, persona: Persona, onConfirm: (mode: 'keep' | 'delete' | 'archive') => void) {
    super(app);
    this.plugin = plugin;
    this.persona = persona;
    this.onConfirm = onConfirm;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('delete-persona-modal');

    contentEl.createEl('h2', { text: `删除角色：${this.persona.name}` });
    contentEl.createEl('p', { text: '请选择是否处理该角色的记忆：' });

    const actions = contentEl.createDiv({ cls: 'delete-persona-actions' });

    const keepBtn = actions.createEl('button', { text: '仅删除角色', cls: 'mod-cta' });
    keepBtn.onclick = () => {
      this.onConfirm('keep');
      this.close();
    };

    const archiveBtn = actions.createEl('button', { text: '删除角色并归档记忆' });
    archiveBtn.onclick = () => {
      this.onConfirm('archive');
      this.close();
    };

    const deleteBtn = actions.createEl('button', { text: '删除角色并删除记忆', cls: 'mod-warning' });
    deleteBtn.onclick = () => {
      this.onConfirm('delete');
      this.close();
    };
  }
}

/**
 * 清除记忆确认弹窗
 */
class ClearMemoryModal extends Modal {
  private plugin: IPluginContext;
  private persona: Persona;

  constructor(app: App, plugin: IPluginContext, persona: Persona) {
    super(app);
    this.plugin = plugin;
    this.persona = persona;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('clear-memory-modal');

    contentEl.createEl('h2', { text: `清除记忆：${this.persona.name}` });
    contentEl.createEl('p', { text: '这将清除该角色卡的所有记忆数据，包括：' });
    
    const list = contentEl.createEl('ul');
    list.createEl('li', { text: '用户画像' });
    list.createEl('li', { text: '角色关系图' });
    list.createEl('li', { text: '出场人物' });
    list.createEl('li', { text: '世界观设定' });
    list.createEl('li', { text: '势力组织' });
    list.createEl('li', { text: '重要物品' });
    list.createEl('li', { text: '事件计划' });
    list.createEl('li', { text: '情景记忆' });
    
    contentEl.createEl('p', { 
      text: '⚠️ 此操作不可撤销！角色卡本身会保留。',
      cls: 'clear-memory-warning'
    });

    const actions = contentEl.createDiv({ cls: 'clear-memory-actions' });

    const cancelBtn = actions.createEl('button', { text: '取消' });
    cancelBtn.onclick = () => this.close();

    const clearFactsBtn = actions.createEl('button', { text: '仅清除 Facts（保留情景记忆）' });
    clearFactsBtn.onclick = async () => {
      await this.clearMemory(false);
      this.close();
    };

    const clearAllBtn = actions.createEl('button', { text: '清除全部记忆', cls: 'mod-warning' });
    clearAllBtn.onclick = async () => {
      await this.clearMemory(true);
      this.close();
    };
  }

  private async clearMemory(includeEpisodic: boolean) {
    const memoryPath = this.plugin.settings.memoryPath || 'AI_Memory';
    
    // 与 MemoryManager 一致的路径解析：AI_Memory/{角色名}/
    const rawName = String(this.persona.name || "").trim();
    const safeName = rawName.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().slice(0, 48);
    const folderName = safeName || String(this.persona.id || "").replace(/[^a-zA-Z0-9\u4e00-\u9fa5-_]/g, "_") || "default";
    const basePath = `${memoryPath}/${folderName}`;
    
    try {
      // 清除 Facts 目录，但保留角色知识库.md（它来源于角色卡，不应被“清除记忆”误删）
      const factsPath = `${basePath}/Facts`;
      const factsFolder = this.app.vault.getAbstractFileByPath(factsPath);
      if (factsFolder instanceof TFolder) {
        for (const child of [...factsFolder.children]) {
          if (child instanceof TFile && child.name === '角色知识库.md') {
            continue;
          }
          await this.app.vault.delete(child, true);
        }
      } else if (factsFolder) {
        // Fallback: unexpected non-folder node, preserve nothing but avoid recreating over existing file
        await this.app.vault.delete(factsFolder, true);
        await this.app.vault.createFolder(factsPath);
      }

      // 如果需要，清除 Episodic 目录
      if (includeEpisodic) {
        const episodicPath = `${basePath}/Episodic`;
        const episodicFolder = this.app.vault.getAbstractFileByPath(episodicPath);
        if (episodicFolder) {
          await this.app.vault.delete(episodicFolder, true);
          // 重新创建空的 Episodic 目录
          await this.app.vault.createFolder(episodicPath);
        }
      }

      // 清除内存中的世界状态缓存
      if (this.plugin.worldStateManager) {
        (this.plugin.worldStateManager as any).stateCache?.delete(this.persona.id);
      }

      new Notice(`已清除角色「${this.persona.name}」的${includeEpisodic ? '全部' : 'Facts'}记忆`);
    } catch (e) {
      console.error('Clear memory error:', e);
      new Notice(`清除记忆失败：${e}`);
    }
  }
}

/**
 * 角色编辑弹窗
 */
class CharacterEditModal extends Modal {
  plugin: IPluginContext;
  persona: Persona;
  onSubmit: (persona: Persona) => void;
  onCloseCallback: () => void;
  tagsInput: string = '';
  selectedTools: Set<string> = new Set();

  constructor(
    app: App, 
    plugin: IPluginContext, 
    persona: Persona | null, 
    onSubmit: (persona: Persona) => void,
    onCloseCallback?: () => void
  ) {
    super(app);
    this.plugin = plugin;
    this.onSubmit = onSubmit;
    this.onCloseCallback = onCloseCallback || (() => {});
    
    if (persona) {
      this.persona = { ...persona };
      this.tagsInput = ((persona as any).tags || []).join(', ');
      this.selectedTools = new Set((persona as any).tools || []);
    } else {
      this.persona = {
        id: Date.now().toString(),
        name: "新角色",
        description: "",
        systemPrompt: "你是一个有用的助手。",
        avatar: ""
      };
      this.tagsInput = '';
      this.selectedTools = new Set();
    }
  }

  onOpen() {
    const { contentEl, modalEl, containerEl } = this;
    contentEl.empty();
    contentEl.addClass('character-edit-modal');
    
    // 立即禁用模态框动画，避免屏闪
    const modalBg = containerEl.querySelector('.modal-bg') as HTMLElement;
    if (modalBg) {
      modalBg.setCssStyles({ animation: 'none' });
      modalBg.setCssStyles({ opacity: '1' });
    }
    modalEl.setCssStyles({ animation: 'none' });
    
    contentEl.createEl("h2", { text: this.persona.id ? "编辑角色" : "新建角色" });

    // 基本信息区
    const basicSection = contentEl.createDiv({ cls: 'edit-section' });
    basicSection.createEl('h3', { text: '基本信息' });

    new Setting(basicSection)
      .setName("角色名称")
      .addText(text => text
        .setValue(this.persona.name)
        .setPlaceholder('给角色起个名字')
        .onChange(value => this.persona.name = value));

    new Setting(basicSection)
      .setName("描述")
      .setDesc("简短描述角色的特点")
      .addText(text => text
        .setValue(this.persona.description)
        .setPlaceholder('例如：一个友好的编程助手')
        .onChange(value => this.persona.description = value));

    new Setting(basicSection)
      .setName("头像 URL")
      .setDesc("图片链接或 Base64")
      .addText(text => text
        .setValue(this.persona.avatar || "")
        .setPlaceholder('https://... 或留空')
        .onChange(value => this.persona.avatar = value));

    // 头像上传按钮
    const avatarUploadSetting = new Setting(basicSection)
      .setName("上传头像")
      .setDesc("从本地选择图片上传到 vault");
    
    // 头像预览
    const avatarPreviewContainer = avatarUploadSetting.settingEl.createDiv({ cls: 'avatar-upload-preview' });
    const updateAvatarPreview = () => {
      avatarPreviewContainer.empty();
      if (this.persona.avatar) {
        const img = avatarPreviewContainer.createEl('img', { 
          attr: { src: this.getAvatarSrc(this.persona.avatar) },
          cls: 'avatar-preview-img'
        });
        img.onerror = () => {
          img.remove();
          avatarPreviewContainer.createDiv({ cls: 'avatar-preview-placeholder', text: '预览失败' });
        };
      }
    };
    updateAvatarPreview();
    
    avatarUploadSetting.addButton(btn => btn
      .setButtonText("选择图片")
      .onClick(async () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        
        input.onchange = async () => {
          const file = input.files?.[0];
          if (!file) return;
          
          try {
            // 读取文件为 ArrayBuffer
            const buffer = await file.arrayBuffer();
            
            // 生成唯一文件名
            const ext = file.name.split('.').pop() || 'png';
            const fileName = `avatar_${this.persona.id}_${Date.now()}.${ext}`;
            const filePath = `${AVATAR_FOLDER}/${fileName}`;
            
            // 确保目录存在
            const adapter = this.app.vault.adapter;
            if (!await adapter.exists(AVATAR_FOLDER)) {
              await adapter.mkdir(AVATAR_FOLDER);
            }
            
            // 保存文件
            await adapter.writeBinary(filePath, buffer);
            
            // 更新 persona 头像路径
            this.persona.avatar = filePath;
            updateAvatarPreview();
            
            new Notice(`头像已上传: ${fileName}`);
          } catch (e) {
            console.error('[AvatarUpload] 失败:', e);
            new Notice('头像上传失败，请重试');
          }
        };
        
        input.click();
      }))
    .addButton(btn => btn
      .setButtonText("清除")
      .setWarning()
      .onClick(() => {
        this.persona.avatar = '';
        updateAvatarPreview();
      }));

    new Setting(basicSection)
      .setName("标签")
      .setDesc("用逗号分隔，如：助手, 编程, 中文")
      .addText(text => text
        .setValue(this.tagsInput)
        .setPlaceholder('标签1, 标签2, ...')
        .onChange(value => this.tagsInput = value));

    // 提示词区
    const promptSection = contentEl.createDiv({ cls: 'edit-section' });
    promptSection.createEl('h3', { text: '提示词设置' });

    new Setting(promptSection)
      .setName("系统提示词")
      .setDesc("定义角色的核心行为和人设")
      .addTextArea(text => {
        text.setValue(this.persona.systemPrompt)
          .setPlaceholder('你是一个...')
          .onChange(value => this.persona.systemPrompt = value);
        text.inputEl.rows = 8;
        text.inputEl.addClass('full-width-textarea');
      });

    // 开场白（SillyTavern 兼容）
    const greetingSetting = new Setting(promptSection)
      .setName("开场白")
      .setDesc("角色的第一条消息（可选）");
    
    // 如果有备选开场白，显示切换按钮
    const alternateGreetings: string[] = (this.persona as any).alternateGreetings || [];
    if (alternateGreetings.length > 0) {
      greetingSetting.addButton(btn => btn
        .setButtonText(`切换 (${alternateGreetings.length} 个备选)`)
        .setTooltip('选择其他开场白')
        .onClick(() => {
          this.showAlternateGreetingsModal(promptSection);
        }));
    }
    
    greetingSetting.addTextArea(text => {
      text.setValue((this.persona as any).greeting || '')
        .setPlaceholder('*角色微微一笑* 你好呀...')
        .onChange(value => (this.persona as any).greeting = value);
      text.inputEl.rows = 3;
      text.inputEl.addClass('full-width-textarea');
    });

    // ========== 文风控制区块 ==========
    const styleSection = contentEl.createDiv({ cls: 'edit-section collapsible' });
    const styleHeader = styleSection.createDiv({ cls: 'section-header' });
    styleHeader.createEl('h3', { text: '✍️ 文风控制' });
    styleHeader.createEl('span', { text: '▼', cls: 'collapse-icon' });
    
    const styleContent = styleSection.createDiv({ cls: 'section-content collapsed' });
    
    styleHeader.onclick = () => {
      styleContent.classList.toggle('collapsed');
      styleHeader.querySelector('.collapse-icon')!.textContent = 
        styleContent.classList.contains('collapsed') ? '▼' : '▲';
    };

    // 初始化文风设置
    if (!(this.persona as any).writingStyle) {
      (this.persona as any).writingStyle = { enabled: false };
    }
    const writingStyle: WritingStyle = (this.persona as any).writingStyle;

    // 启用开关
    new Setting(styleContent)
      .setName("启用文风控制")
      .setDesc("让角色的回复风格更贴近你喜欢的文风")
      .addToggle(toggle => toggle
        .setValue(writingStyle.enabled)
        .onChange(value => {
          writingStyle.enabled = value;
          this.updateStyleSectionVisibility(styleContent, value);
        }));

    // 文风控制详细设置容器
    const styleDetailsContainer = styleContent.createDiv({ cls: 'style-details-container' });
    this.renderStyleDetails(styleDetailsContainer, writingStyle);
    this.updateStyleSectionVisibility(styleContent, writingStyle.enabled);

    // 高级设置（可折叠）
    const advancedSection = contentEl.createDiv({ cls: 'edit-section collapsible' });
    const advancedHeader = advancedSection.createDiv({ cls: 'section-header' });
    advancedHeader.createEl('h3', { text: '高级设置（SillyTavern 兼容）' });
    advancedHeader.createEl('span', { text: '▼', cls: 'collapse-icon' });
    
    const advancedContent = advancedSection.createDiv({ cls: 'section-content collapsed' });
    
    advancedHeader.onclick = () => {
      advancedContent.classList.toggle('collapsed');
      advancedHeader.querySelector('.collapse-icon')!.textContent = 
        advancedContent.classList.contains('collapsed') ? '▼' : '▲';
    };

    new Setting(advancedContent)
      .setName("性格描述")
      .setDesc("SillyTavern 兼容：personality 字段")
      .addTextArea(text => {
        text.setValue((this.persona as any).personality || '')
          .onChange(value => (this.persona as any).personality = value);
        text.inputEl.rows = 2;
      });

    new Setting(advancedContent)
      .setName("场景设定")
      .setDesc("SillyTavern 兼容：scenario 字段")
      .addTextArea(text => {
        text.setValue((this.persona as any).scenario || '')
          .onChange(value => (this.persona as any).scenario = value);
        text.inputEl.rows = 2;
      });

    new Setting(advancedContent)
      .setName("历史后指令")
      .setDesc("SillyTavern 兼容：post_history_instructions / UJB")
      .addTextArea(text => {
        text.setValue((this.persona as any).postHistoryInstructions || '')
          .onChange(value => (this.persona as any).postHistoryInstructions = value);
        text.inputEl.rows = 2;
      });

    new Setting(advancedContent)
      .setName("创作者备注")
      .setDesc("不会进入提示词，仅供参考")
      .addTextArea(text => {
        text.setValue((this.persona as any).creatorNotes || '')
          .onChange(value => (this.persona as any).creatorNotes = value);
        text.inputEl.rows = 2;
      });

    // 工具/智能体设置区
    const toolSection = contentEl.createDiv({ cls: 'edit-section collapsible' });
    const toolHeader = toolSection.createDiv({ cls: 'section-header' });
    toolHeader.createEl('h3', { text: '工具与智能体' });
    toolHeader.createEl('span', { text: '▼', cls: 'collapse-icon' });
    
    const toolContent = toolSection.createDiv({ cls: 'section-content collapsed' });
    
    toolHeader.onclick = () => {
      toolContent.classList.toggle('collapsed');
      toolHeader.querySelector('.collapse-icon')!.textContent = 
        toolContent.classList.contains('collapsed') ? '▼' : '▲';
    };

    // 角色类型
    new Setting(toolContent)
      .setName("角色类型")
      .setDesc("决定角色的行为模式")
      .addDropdown(dropdown => {
        dropdown
          .addOption('assistant', '🤖 助手 - 通用对话')
          .addOption('character', '🎭 角色 - 扮演人设')
          .addOption('tool-agent', '🔧 智能体 - 使用工具')
          .setValue((this.persona as any).type || 'assistant')
          .onChange(value => (this.persona as any).type = value);
      });

    // 指定模型
    new Setting(toolContent)
      .setName("指定模型")
      .setDesc("为此角色指定专用模型（留空使用默认）")
      .addText(text => text
        .setValue((this.persona as any).model || '')
        .setPlaceholder('例如：gpt-4o')
        .onChange(value => (this.persona as any).model = value || undefined));

    // 独立记忆
    new Setting(toolContent)
      .setName("独立记忆")
      .setDesc("启用后，此角色拥有独立的长期记忆")
      .addToggle(toggle => toggle
        .setValue((this.persona as any).independentMemory !== false) // 默认为 true
        .onChange(value => (this.persona as any).independentMemory = value));

    // 工具绑定
    const toolBindingSetting = new Setting(toolContent)
      .setName("绑定工具")
      .setDesc("选择此角色可使用的工具（智能体模式下生效）");
    
    const toolListContainer = toolContent.createDiv({ cls: 'tool-binding-list' });
    this.renderToolBindings(toolListContainer);

    // 按钮区
    const buttonSection = contentEl.createDiv({ cls: 'edit-buttons' });
    
    new ButtonComponent(buttonSection)
      .setButtonText("取消")
      .onClick(() => this.close());
    
    new ButtonComponent(buttonSection)
      .setButtonText("保存")
      .setCta()
      .onClick(() => {
        // 解析标签
        (this.persona as any).tags = this.tagsInput
          .split(',')
          .map(t => t.trim())
          .filter(Boolean);
        
        // 保存工具绑定
        (this.persona as any).tools = Array.from(this.selectedTools);
        
        this.onSubmit(this.persona);
        this.close();
      });
  }

  /**
   * 工具名称到中文显示名的映射
   */
  private getToolDisplayName(toolName: string): string {
    const toolDisplayNames: Record<string, string> = {
      // 笔记操作
      'read_note': '📖 读取笔记',
      'create_note': '📝 创建笔记',
      'modify_note': '✏️ 修改笔记',
      'replace_in_note': '🔄 笔记替换',
      'append_to_note': '➕ 追加内容',
      'move_item': '📦 移动文件',
      'delete_file': '🗑️ 删除文件',
      'create_folder': '📁 创建文件夹',
      'list_files': '📂 列出文件',
      // 搜索与链接
      'search_notes': '🔍 搜索笔记',
      'vector_search': '🔮 向量搜索',
      'knowledge_base_query': '🧠 知识库查询',
      'get_backlinks': '🔗 获取反向链接',
      'get_recent_notes': '🕐 最近笔记',
      'get_note_structure': '📑 笔记结构',
      // 元数据
      'get_properties': '📋 获取属性',
      'update_properties': '📝 更新属性',
      // Canvas
      'read_canvas': '🖼️ 读取画布',
      'create_canvas': '🎨 创建画布',
      'modify_canvas': '✏️ 修改画布',
      'create_canvas_mindmap': '🗺️ 创建思维导图',
      // 系统
      'list_commands': '⌨️ 列出命令',
      'execute_command': '▶️ 执行命令',
      'discover_tools': '🔧 发现工具',
      'use_tool_from_library': '📚 使用工具库',
      // 待办
      'manage_todo_list': '☑️ 管理待办',
      // 网络
      'web_search': '🌐 网络搜索',
      'read_webpage': '📄 读取网页',
      // MCP
      'mcp_call_tool': '🔌 调用MCP工具',
      'mcp_list_tools': '📋 列出MCP工具',
    };
    return toolDisplayNames[toolName] || toolName;
  }

  /**
   * 渲染工具绑定列表
   */
  renderToolBindings(container: HTMLElement) {
    container.empty();
    
    // 获取所有可用工具
    const allTools = this.plugin.agentManager?.getAllToolNames() || [];
    
    if (allTools.length === 0) {
      container.createDiv({ 
        cls: 'tool-binding-empty',
        text: '暂无可用工具。请先在 MCP 设置中添加工具。'
      });
      return;
    }

    // 全选/取消全选按钮
    const selectAllContainer = container.createDiv({ cls: 'tool-binding-select-all' });
    const selectAllCheckbox = selectAllContainer.createEl('input', {
      type: 'checkbox',
      cls: 'tool-binding-checkbox'
    }) as HTMLInputElement;
    selectAllCheckbox.id = 'tool-select-all';
    selectAllCheckbox.checked = this.selectedTools.size === allTools.length;
    selectAllCheckbox.indeterminate = this.selectedTools.size > 0 && this.selectedTools.size < allTools.length;
    
    const selectAllLabel = selectAllContainer.createEl('label', {
      text: '全选工具',
      attr: { for: 'tool-select-all' },
      cls: 'tool-binding-select-all-label'
    });

    selectAllCheckbox.onchange = () => {
      if (selectAllCheckbox.checked) {
        allTools.forEach(t => this.selectedTools.add(t));
      } else {
        this.selectedTools.clear();
      }
      this.renderToolBindings(container);
    };

    // 分隔线
    container.createEl('hr', { cls: 'tool-binding-divider' });
    
    allTools.forEach(toolName => {
      const toolItem = container.createDiv({ cls: 'tool-binding-item' });
      
      const checkbox = toolItem.createEl('input', {
        type: 'checkbox',
        cls: 'tool-binding-checkbox'
      }) as HTMLInputElement;
      checkbox.checked = this.selectedTools.has(toolName);
      checkbox.id = `tool-${toolName}`;
      
      const label = toolItem.createEl('label', { 
        text: this.getToolDisplayName(toolName),
        attr: { for: `tool-${toolName}` }
      });
      
      checkbox.onchange = () => {
        if (checkbox.checked) {
          this.selectedTools.add(toolName);
        } else {
          this.selectedTools.delete(toolName);
        }
        // 更新全选状态
        selectAllCheckbox.checked = this.selectedTools.size === allTools.length;
        selectAllCheckbox.indeterminate = this.selectedTools.size > 0 && this.selectedTools.size < allTools.length;
      };
    });
  }



  /**
   * 获取头像的显示 src
   * 支持 vault 路径、URL、Base64
   */
  getAvatarSrc(avatar: string): string {
    if (!avatar) return '';
    
    // 已经是 URL 或 Base64
    if (avatar.startsWith('http') || avatar.startsWith('data:')) {
      return avatar;
    }
    
    // vault 路径 - 转换为 vault URI
    return this.app.vault.adapter.getResourcePath(avatar);
  }

  /**
   * 更新文风设置区块的可见性
   */
  updateStyleSectionVisibility(container: HTMLElement, enabled: boolean) {
    const detailsContainer = container.querySelector('.style-details-container') as HTMLElement;
    if (detailsContainer) {
      detailsContainer.setCssStyles({ display: String(enabled ? 'block' : 'none') });
    }
  }

  /**
   * 渲染文风详细设置
   */
  renderStyleDetails(container: HTMLElement, writingStyle: WritingStyle) {
    container.empty();

    // 从笔记选择按钮
    const librarySection = container.createDiv({ cls: 'style-library-section' });
    const libraryBtn = librarySection.createEl('button', {
      text: '📚 从笔记选择',
      cls: 'mod-cta'
    });
    libraryBtn.onclick = () => {
      const folderPrefix = `${WRITING_STYLE_NOTE_FOLDER}/`;
      const files = this.app.vault
        .getMarkdownFiles()
        .filter(f => f.path.startsWith(folderPrefix));

      if (files.length === 0) {
        new Notice('文风库暂无笔记，请先保存为笔记');
        return;
      }

      new CandidateFileSuggestModal(
        this.app,
        files,
        async (file) => {
          if (!file) return;
          try {
            const content = await this.app.vault.read(file);
            const parsed = parseWritingStyleNote(content, file.basename);
            if (!parsed) {
              new Notice('该笔记无法解析为文风');
              return;
            }
            writingStyle.name = parsed.name;
            writingStyle.styleDescription = parsed.styleDescription;
            writingStyle.dimensions = parsed.dimensions ? { ...parsed.dimensions } : undefined;
            writingStyle.customInstructions = parsed.customInstructions;
            writingStyle.sampleText = parsed.sampleText;
            writingStyle.analyzedBy = parsed.analyzedBy;
            this.renderStyleDetails(container, writingStyle);
            new Notice(`已应用文风：${parsed.name || file.basename}`);
          } catch (e) {
            console.error('[WritingStyle] Failed to read note:', e);
            new Notice('读取文风笔记失败');
          }
        },
        '选择文风笔记...'
      ).open();
    };

    const saveToLibraryBtn = librarySection.createEl('button', {
      text: '💾 保存为笔记',
      cls: 'style-save-btn'
    });
    saveToLibraryBtn.onclick = async () => {
      if (!writingStyle.styleDescription) {
        new Notice('请先分析或填写文风描述');
        return;
      }
      try {
        const file = await saveWritingStyleAsNote(this.app, writingStyle);
        new Notice(`文风已保存为笔记：${file.basename}`);
      } catch (e) {
        console.error('[WritingStyle] Failed to save note:', e);
        new Notice('保存文风笔记失败');
      }
    };

    // 文风名称
    new Setting(container)
      .setName("文风名称")
      .setDesc("给这个文风起个名字，方便识别")
      .addText(text => text
        .setValue(writingStyle.name || '')
        .setPlaceholder('例如：金庸风、东野圭吾风')
        .onChange(value => writingStyle.name = value));

    // 样本文本分析
    const sampleSection = container.createDiv({ cls: 'style-sample-section' });
    sampleSection.createEl('h4', { text: '📖 从样本学习文风' });
    sampleSection.createEl('p', { 
      text: '粘贴你喜欢的小说章节或文字片段，AI 会分析并提取其文风特征。不是简单复制，而是捕捉文风精髓。',
      cls: 'style-sample-desc'
    });

    const sampleTextArea = sampleSection.createEl('textarea', {
      cls: 'full-width-textarea style-sample-textarea',
      attr: { rows: '6', placeholder: '粘贴你喜欢的小说片段、文章段落...\n\n建议提供 500-2000 字的样本，包含对话和描写会更好。' }
    });
    sampleTextArea.value = writingStyle.sampleText || '';
    sampleTextArea.onchange = () => {
      writingStyle.sampleText = sampleTextArea.value;
    };

    // 分析按钮
    const analyzeButtonContainer = sampleSection.createDiv({ cls: 'style-analyze-buttons' });
    
    const analyzeBtn = analyzeButtonContainer.createEl('button', { 
      text: '🔍 分析文风',
      cls: 'mod-cta'
    });
    analyzeBtn.onclick = async () => {
      const sampleText = sampleTextArea.value.trim();
      if (!sampleText) {
        new Notice('请先粘贴样本文本');
        return;
      }
      if (sampleText.length < 100) {
        new Notice('样本文本太短，建议至少 100 字');
        return;
      }
      
      analyzeBtn.disabled = true;
      analyzeBtn.textContent = '分析中...';
      
      try {
        await this.analyzeWritingStyle(sampleText, writingStyle, container);
      } finally {
        analyzeBtn.disabled = false;
        analyzeBtn.textContent = '🔍 分析文风';
      }
    };

    // 文风描述（可手动编辑）
    const descSection = container.createDiv({ cls: 'style-description-section' });
    descSection.createEl('h4', { text: '📝 文风描述' });
    descSection.createEl('p', { 
      text: 'AI 分析结果会填入此处，你也可以手动编辑调整。这段描述会被注入到系统提示词中。',
      cls: 'style-desc-hint'
    });

    const descTextArea = descSection.createEl('textarea', {
      cls: 'full-width-textarea style-desc-textarea',
      attr: { rows: '5', placeholder: '描述这个文风的特点...\n例如：语言简洁有力，信息密度高，善用短句，情感表达克制但有力...' }
    });
    descTextArea.value = writingStyle.styleDescription || '';
    descTextArea.onchange = () => {
      writingStyle.styleDescription = descTextArea.value;
    };

    // 维度滑块
    const dimensionsSection = container.createDiv({ cls: 'style-dimensions-section' });
    dimensionsSection.createEl('h4', { text: '🎚️ 风格微调' });
    dimensionsSection.createEl('p', { 
      text: '拖动滑块微调各个风格维度（可选）',
      cls: 'style-dimensions-hint'
    });

    // 初始化维度
    if (!writingStyle.dimensions) {
      writingStyle.dimensions = {};
    }

    const dimensionsList = dimensionsSection.createDiv({ cls: 'style-dimensions-list' });
    
    for (const [key, labels] of Object.entries(DIMENSION_LABELS)) {
      const dimKey = key as keyof NonNullable<WritingStyle['dimensions']>;
      const currentValue = writingStyle.dimensions[dimKey] ?? 5;
      
      const dimItem = dimensionsList.createDiv({ cls: 'style-dimension-item' });
      
      const dimHeader = dimItem.createDiv({ cls: 'style-dimension-header' });
      dimHeader.createSpan({ text: labels.name, cls: 'style-dimension-name' });
      const valueDisplay = dimHeader.createSpan({ text: `${currentValue}`, cls: 'style-dimension-value' });
      
      const sliderRow = dimItem.createDiv({ cls: 'style-dimension-slider-row' });
      sliderRow.createSpan({ text: labels.lowLabel, cls: 'style-dimension-label-low' });
      
      const slider = sliderRow.createEl('input', {
        type: 'range',
        cls: 'style-dimension-slider',
        attr: { min: '1', max: '10', value: String(currentValue) }
      }) as HTMLInputElement;
      
      sliderRow.createSpan({ text: labels.highLabel, cls: 'style-dimension-label-high' });
      
      slider.oninput = () => {
        const val = parseInt(slider.value);
        valueDisplay.textContent = String(val);
        writingStyle.dimensions![dimKey] = val;
      };
    }

    // 额外指令
    new Setting(container)
      .setName("额外指令")
      .setDesc("补充任何关于文风的额外要求")
      .addTextArea(text => {
        text.setValue(writingStyle.customInstructions || '')
          .setPlaceholder('例如：多用比喻、避免感叹号、保持神秘感...')
          .onChange(value => writingStyle.customInstructions = value);
        text.inputEl.rows = 2;
        text.inputEl.addClass('full-width-textarea');
      });
  }

  /**
   * 调用 AI 分析文风
   */
  async analyzeWritingStyle(sampleText: string, writingStyle: WritingStyle, container: HTMLElement) {
    try {
      const prompt = buildStyleAnalysisPrompt(sampleText);
      
      // 使用插件的 LLM 服务
      const llmService = this.plugin.llmService;
      if (!llmService) {
        new Notice('LLM 服务未初始化');
        return;
      }

      new Notice('正在分析文风，请稍候...');
      
      // 使用默认模型进行分析
      const model = this.plugin.settings.defaultChatModel || this.plugin.settings.chatModels.split(',')[0] || 'gpt-4o-mini';
      
      const response = await llmService.getCompletion(
        [{ role: 'user', content: prompt }],
        model
      );

      if (!response || !response.content) {
        new Notice('分析失败：未收到响应');
        return;
      }

      const result = parseStyleAnalysisResponse(response.content);
      
      if (!result.success) {
        new Notice(`分析失败：${result.error}`);
        return;
      }

      // 更新文风设置
      writingStyle.styleDescription = result.styleDescription;
      if (result.dimensions) {
        writingStyle.dimensions = result.dimensions;
      }
      writingStyle.sampleText = sampleText;
      writingStyle.analyzedAt = Date.now();
      
      // 重新渲染
      this.renderStyleDetails(container, writingStyle);
      
      new Notice('✅ 文风分析完成！');
    } catch (e) {
      console.error('[StyleAnalysis] 分析失败:', e);
      new Notice(`分析失败: ${e}`);
    }
  }

  /**
   * 显示备选开场白选择模态框
   */
  showAlternateGreetingsModal(promptSection: HTMLElement) {
    const currentGreeting = (this.persona as any).greeting || '';
    const alternates: string[] = (this.persona as any).alternateGreetings || [];
    
    // 构建所有开场白列表（当前 + 备选）
    const allGreetings: { index: number; text: string; isCurrent: boolean }[] = [];
    
    // 当前开场白标记为 index -1
    if (currentGreeting) {
      allGreetings.push({ index: -1, text: currentGreeting, isCurrent: true });
    }
    
    // 备选开场白
    alternates.forEach((text, idx) => {
      if (text && text.trim()) {
        allGreetings.push({ index: idx, text: text, isCurrent: false });
      }
    });
    
    if (allGreetings.length === 0) {
      new Notice('没有可用的开场白');
      return;
    }
    
    // 创建选择模态框
    const modal = new Modal(this.app);
    modal.titleEl.setText('选择开场白');
    
    const { contentEl } = modal;
    contentEl.addClass('alternate-greetings-modal');
    
    contentEl.createEl('p', { 
      text: '选择要使用的开场白。当前开场白会与选中的互换位置。',
      cls: 'alternate-greetings-hint'
    });
    
    const listContainer = contentEl.createDiv({ cls: 'alternate-greetings-list' });
    
    allGreetings.forEach((item, displayIdx) => {
      const itemEl = listContainer.createDiv({ 
        cls: `alternate-greeting-item ${item.isCurrent ? 'current' : ''}`
      });
      
      const labelEl = itemEl.createDiv({ cls: 'greeting-label' });
      if (item.isCurrent) {
        labelEl.createSpan({ text: '当前', cls: 'greeting-badge current' });
      } else {
        labelEl.createSpan({ text: `备选 ${item.index + 1}`, cls: 'greeting-badge' });
      }
      
      const previewEl = itemEl.createDiv({ cls: 'greeting-preview' });
      // 截取前 200 字符作为预览
      const preview = item.text.length > 200 ? item.text.slice(0, 200) + '...' : item.text;
      previewEl.setText(preview);
      
      if (!item.isCurrent) {
        const useBtn = itemEl.createEl('button', { text: '使用此开场', cls: 'mod-cta' });
        useBtn.onclick = async () => {
          // 交换：当前开场白放回备选列表，选中的变成当前
          const newAlternates = [...alternates];
          
          // 将当前开场白放到被选中的位置
          if (currentGreeting) {
            newAlternates[item.index] = currentGreeting;
          } else {
            // 如果当前没有开场白，就删除选中的
            newAlternates.splice(item.index, 1);
          }
          
          // 设置新的当前开场白（更新本地副本）
          (this.persona as any).greeting = item.text;
          (this.persona as any).alternateGreetings = newAlternates;
          
          // 同步更新 settings 中的原始对象
          const originalPersona = this.plugin.settings.personas.find(p => p.id === this.persona.id);
          if (originalPersona) {
            (originalPersona as any).greeting = item.text;
            (originalPersona as any).alternateGreetings = newAlternates;
          }
          
          // 保存设置到插件
          await this.plugin.saveSettings();
          
          modal.close();
          
          // 刷新 UI - 重新渲染整个编辑界面
          this.contentEl.empty();
          this.onOpen();
          
          new Notice('开场白已切换并保存');
        };
      }
    });
    
    // 关闭按钮
    const footer = contentEl.createDiv({ cls: 'alternate-greetings-footer' });
    const closeBtn = footer.createEl('button', { text: '取消' });
    closeBtn.onclick = () => modal.close();
    
    modal.open();
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.removeClass('character-edit-modal');
    this.onCloseCallback();
  }
}

/**
 * 用户角色编辑模态框
 */
class UserPersonaEditModal extends Modal {
  plugin: IPluginContext;
  userPersona: UserPersona | null;
  onSave: () => void;
  onCloseCallback: () => void;
  
  // 编辑状态
  editName: string = '';
  editDescription: string = '';
  editAvatar: string = '';
  editSettings: string = '';

  constructor(app: App, plugin: IPluginContext, userPersona: UserPersona | null, onSave: () => void, onCloseCallback?: () => void) {
    super(app);
    this.plugin = plugin;
    this.userPersona = userPersona;
    this.onSave = onSave;
    this.onCloseCallback = onCloseCallback || (() => {});
    
    // 初始化编辑状态
    if (userPersona) {
      this.editName = userPersona.name;
      this.editDescription = userPersona.description;
      this.editAvatar = userPersona.avatar || '';
      this.editSettings = userPersona.settings || '';
    } else {
      this.editName = '';
      this.editDescription = '';
      this.editAvatar = '';
      this.editSettings = '';
    }
  }

  onOpen() {
    const { contentEl, modalEl, containerEl } = this;
    contentEl.empty();
    contentEl.addClass('user-persona-edit-modal');
    
    // 立即禁用模态框动画，避免屏闪
    const modalBg = containerEl.querySelector('.modal-bg') as HTMLElement;
    if (modalBg) {
      modalBg.setCssStyles({ animation: 'none' });
      modalBg.setCssStyles({ opacity: '1' });
    }
    modalEl.setCssStyles({ animation: 'none' });
    
    const isNew = !this.userPersona;
    
    // 标题
    contentEl.createEl('h2', { text: isNew ? '新建用户角色' : '编辑用户角色' });
    
    // 说明
    contentEl.createEl('p', { 
      cls: 'user-persona-edit-hint',
      text: '用户角色的名字会替换对话中的 {{user}} 占位符。'
    });
    
    // 头像区域
    const avatarSection = contentEl.createDiv({ cls: 'user-persona-avatar-section' });
    const avatarPreview = avatarSection.createDiv({ cls: 'user-persona-avatar-preview' });
    this.updateAvatarPreview(avatarPreview);
    
    const avatarButtons = avatarSection.createDiv({ cls: 'user-persona-avatar-buttons' });
    
    // 上传头像按钮
    const uploadBtn = avatarButtons.createEl('button', { text: '上传头像' });
    uploadBtn.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.addEventListener('change', async () => {
        if (input.files && input.files[0]) {
          const file = input.files[0];
          const reader = new FileReader();
          reader.onload = (e) => {
            this.editAvatar = e.target?.result as string || '';
            this.updateAvatarPreview(avatarPreview);
          };
          reader.readAsDataURL(file);
        }
      });
      input.click();
    });
    
    // 清除头像按钮
    if (this.editAvatar) {
      const clearBtn = avatarButtons.createEl('button', { text: '清除头像' });
      clearBtn.addEventListener('click', () => {
        this.editAvatar = '';
        this.updateAvatarPreview(avatarPreview);
        // 重新渲染按钮区
        avatarButtons.empty();
        const newUploadBtn = avatarButtons.createEl('button', { text: '上传头像' });
        newUploadBtn.addEventListener('click', uploadBtn.onclick as any);
      });
    }
    
    // 名称输入
    new Setting(contentEl)
      .setName('角色名称')
      .setDesc('将替换 {{user}} 占位符')
      .addText(text => {
        text.setPlaceholder('例如：小明');
        text.setValue(this.editName);
        text.onChange(value => this.editName = value);
        text.inputEl.addClass('user-persona-name-input');
      });
    
    // 描述输入
    new Setting(contentEl)
      .setName('角色描述')
      .setDesc('简要描述这个用户角色（可选，用于你自己识别）');
    
    const descArea = contentEl.createEl('textarea', {
      cls: 'user-persona-desc-input',
      placeholder: '例如：现代都市设定中的普通上班族...',
    });
    descArea.value = this.editDescription;
    descArea.addEventListener('input', () => {
      this.editDescription = descArea.value;
    });
    
    // 角色设定输入（新增）
    new Setting(contentEl)
      .setName('角色设定')
      .setDesc('详细的角色背景和特征设定，会作为上下文传递给AI（可选，增强角色扮演效果）');
    
    const settingsArea = contentEl.createEl('textarea', {
      cls: 'user-persona-settings-input',
      placeholder: '例如：\n性别：男\n年龄：25岁\n性格：内向温和，喜欢阅读\n技能：编程、绘画\n背景故事：出生于小镇，大学毕业后来到大城市工作...',
    });
    settingsArea.value = this.editSettings;
    settingsArea.addEventListener('input', () => {
      this.editSettings = settingsArea.value;
    });
    
    // 按钮区
    const buttonRow = contentEl.createDiv({ cls: 'user-persona-edit-buttons' });
    
    // 取消按钮
    const cancelBtn = buttonRow.createEl('button', { text: '取消' });
    cancelBtn.addEventListener('click', () => this.close());
    
    // 保存按钮
    const saveBtn = buttonRow.createEl('button', { text: '保存', cls: 'mod-cta' });
    saveBtn.addEventListener('click', () => this.save());
  }

  updateAvatarPreview(container: HTMLElement) {
    container.empty();
    if (this.editAvatar) {
      const img = container.createEl('img', { cls: 'user-persona-avatar-img' });
      img.src = this.editAvatar;
    } else {
      container.createDiv({ cls: 'user-persona-avatar-placeholder', text: '👤' });
    }
  }

  async save() {
    if (!this.editName.trim()) {
      new Notice('请输入角色名称');
      return;
    }
    
    if (this.userPersona) {
      // 编辑现有
      this.userPersona.name = this.editName.trim();
      this.userPersona.description = this.editDescription.trim();
      this.userPersona.avatar = this.editAvatar || undefined;
      this.userPersona.settings = this.editSettings.trim() || undefined;
    } else {
      // 新建
      const newId = `user-${Date.now()}`;
      const newPersona: UserPersona = {
        id: newId,
        name: this.editName.trim(),
        description: this.editDescription.trim(),
        avatar: this.editAvatar || undefined,
        settings: this.editSettings.trim() || undefined,
      };
      
      if (!this.plugin.settings.userPersonas) {
        this.plugin.settings.userPersonas = [];
      }
      this.plugin.settings.userPersonas.push(newPersona);
      
      // 如果是第一个，设为激活
      if (this.plugin.settings.userPersonas.length === 1) {
        this.plugin.settings.activeUserPersonaId = newId;
      }
    }
    
    await this.plugin.saveSettings();
    new Notice(`用户角色已保存: ${this.editName}`);
    this.onSave();
    this.close();
  }

  onClose() {
    this.contentEl.empty();
    this.contentEl.removeClass('user-persona-edit-modal');
    this.onCloseCallback();
  }
}
