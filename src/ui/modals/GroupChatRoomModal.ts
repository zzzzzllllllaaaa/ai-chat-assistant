/**
 * 群聊房间管理弹窗
 * 创建、编辑群聊房间，添加角色成员
 */

import { App, Modal, Notice, Setting, ButtonComponent, TextComponent, DropdownComponent } from "obsidian";
import type { IPluginContext } from "../../core/plugin-context";;
import { GroupChatRoom, SpeakingOrderStrategy, createDefaultRoom } from "../../features/groupchat/types";
import { GroupChatManager } from "../../features/groupchat/GroupChatManager";
import { Persona } from "../../core/settings";

/**
 * 群聊房间管理弹窗
 */
export class GroupChatRoomModal extends Modal {
  plugin: IPluginContext;
  manager: GroupChatManager;
  rooms: GroupChatRoom[];
  listContainer: HTMLElement | null = null;
  onRoomSelect?: (room: GroupChatRoom) => void;

  constructor(
    app: App, 
    plugin: IPluginContext,
    onRoomSelect?: (room: GroupChatRoom) => void
  ) {
    super(app);
    this.plugin = plugin;
    this.manager = new GroupChatManager(app, plugin);
    this.rooms = this.manager.getRooms();
    this.onRoomSelect = onRoomSelect;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('groupchat-room-modal');

    // 标题
    const header = contentEl.createDiv({ cls: 'groupchat-header' });
    header.createEl('h2', { text: '群聊房间' });

    // 工具栏
    const toolbar = contentEl.createDiv({ cls: 'groupchat-toolbar' });
    
    new ButtonComponent(toolbar)
      .setButtonText('新建房间')
      .setIcon('plus')
      .setCta()
      .onClick(() => this.openEditModal(null));

    // 房间列表
    this.listContainer = contentEl.createDiv({ cls: 'groupchat-room-list' });
    this.renderRoomList();
  }

  renderRoomList() {
    if (!this.listContainer) return;
    this.listContainer.empty();

    if (this.rooms.length === 0) {
      const empty = this.listContainer.createDiv({ cls: 'groupchat-empty' });
      empty.createEl('div', { text: '💬', cls: 'empty-icon' });
      empty.createEl('div', { text: '暂无群聊房间', cls: 'empty-text' });
      empty.createEl('div', { text: '点击"新建房间"创建一个群聊', cls: 'empty-hint' });
      return;
    }

    this.rooms.forEach(room => {
      this.renderRoomCard(this.listContainer!, room);
    });
  }

  renderRoomCard(container: HTMLElement, room: GroupChatRoom) {
    const card = container.createDiv({ cls: 'groupchat-room-card' });

    // 房间信息
    const info = card.createDiv({ cls: 'room-info' });
    info.createEl('div', { text: room.name, cls: 'room-name' });
    info.createEl('div', { 
      text: `${room.memberIds.length} 位成员 · ${this.getSpeakingOrderLabel(room.speakingOrder)}`,
      cls: 'room-meta'
    });
    if (room.description) {
      info.createEl('div', { text: room.description, cls: 'room-desc' });
    }

    // 成员头像
    const avatars = card.createDiv({ cls: 'room-avatars' });
    const members = room.memberIds.slice(0, 5);
    members.forEach(memberId => {
      const persona = this.plugin.settings.personas.find(p => p.id === memberId);
      if (persona) {
        if (persona.avatar) {
          const img = avatars.createEl('img', { 
            cls: 'room-avatar-img',
            attr: { src: this.resolveAvatarUrl(persona.avatar) }
          });
        } else {
          const placeholder = avatars.createDiv({ cls: 'room-avatar-placeholder' });
          placeholder.textContent = persona.name.charAt(0).toUpperCase();
        }
      }
    });
    if (room.memberIds.length > 5) {
      const more = avatars.createDiv({ cls: 'room-avatar-more' });
      more.textContent = `+${room.memberIds.length - 5}`;
    }

    // 操作按钮
    const actions = card.createDiv({ cls: 'room-actions' });
    
    new ButtonComponent(actions)
      .setIcon('message-circle')
      .setTooltip('进入群聊')
      .onClick(() => {
        if (this.onRoomSelect) {
          this.onRoomSelect(room);
          this.close();
        }
      });

    new ButtonComponent(actions)
      .setIcon('settings')
      .setTooltip('编辑房间')
      .onClick(() => this.openEditModal(room));

    new ButtonComponent(actions)
      .setIcon('trash-2')
      .setTooltip('删除房间')
      .onClick(async () => {
        if (confirm(`确定删除房间"${room.name}"吗？`)) {
          await this.manager.deleteRoom(room.id);
          this.rooms = this.manager.getRooms();
          this.renderRoomList();
          new Notice(`房间"${room.name}"已删除`);
        }
      });
  }

  getSpeakingOrderLabel(order: SpeakingOrderStrategy): string {
    const labels: Record<SpeakingOrderStrategy, string> = {
      'round-robin': '轮流发言',
      'random': '随机发言',
      'ai-decide': 'AI 决定',
      'mentioned-only': '仅 @ 回复',
      'manual': '手动选择',
    };
    return labels[order] || order;
  }

  resolveAvatarUrl(avatar: string): string {
    if (!avatar) return '';
    if (avatar.startsWith('data:') || avatar.startsWith('http')) return avatar;
    const file = this.app.vault.getAbstractFileByPath(avatar);
    if (file) {
      return this.app.vault.getResourcePath(file as any);
    }
    return avatar;
  }

  openEditModal(room: GroupChatRoom | null) {
    const editModal = new GroupChatEditModal(
      this.app, 
      this.plugin, 
      room,
      async (updatedRoom) => {
        if (room) {
          await this.manager.updateRoom(updatedRoom);
        } else {
          await this.manager.createRoom(updatedRoom.name, updatedRoom.memberIds);
          // 更新刚创建的房间的其他属性
          const newRoom = this.manager.getRooms().find(r => r.name === updatedRoom.name);
          if (newRoom) {
            Object.assign(newRoom, updatedRoom);
            await this.manager.updateRoom(newRoom);
          }
        }
        this.rooms = this.manager.getRooms();
        this.renderRoomList();
      }
    );
    editModal.open();
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

/**
 * 群聊房间编辑弹窗
 */
class GroupChatEditModal extends Modal {
  plugin: IPluginContext;
  room: GroupChatRoom;
  isNew: boolean;
  selectedMembers: Set<string>;
  onSave: (room: GroupChatRoom) => Promise<void>;

  constructor(
    app: App,
    plugin: IPluginContext,
    room: GroupChatRoom | null,
    onSave: (room: GroupChatRoom) => Promise<void>
  ) {
    super(app);
    this.plugin = plugin;
    this.isNew = !room;
    this.room = room ? { ...room } : createDefaultRoom('新群聊', []);
    this.selectedMembers = new Set(this.room.memberIds);
    this.onSave = onSave;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('groupchat-edit-modal');

    contentEl.createEl('h2', { text: this.isNew ? '新建群聊' : '编辑群聊' });

    // 基本信息
    new Setting(contentEl)
      .setName('房间名称')
      .addText(text => text
        .setValue(this.room.name)
        .setPlaceholder('输入房间名称')
        .onChange(v => this.room.name = v));

    new Setting(contentEl)
      .setName('房间描述')
      .addTextArea(text => {
        text.setValue(this.room.description || '')
          .setPlaceholder('可选，描述这个群聊的主题')
          .onChange(v => this.room.description = v);
        text.inputEl.rows = 2;
      });

    // 发言顺序
    new Setting(contentEl)
      .setName('发言顺序')
      .setDesc('决定 AI 角色的发言规则')
      .addDropdown(dropdown => dropdown
        .addOption('round-robin', '轮流发言')
        .addOption('random', '随机发言')
        .addOption('ai-decide', 'AI 决定下一个发言者')
        .addOption('mentioned-only', '仅回复 @ 提及')
        .addOption('manual', '用户手动选择')
        .setValue(this.room.speakingOrder)
        .onChange(v => this.room.speakingOrder = v as SpeakingOrderStrategy));

    // 每轮发言人数
    new Setting(contentEl)
      .setName('每轮发言人数')
      .setDesc('每次用户发言后，有几个角色会回复')
      .addSlider(slider => slider
        .setLimits(1, 5, 1)
        .setValue(this.room.speakersPerRound)
        .setDynamicTooltip()
        .onChange(v => this.room.speakersPerRound = v));

    // 用户发言开关
    new Setting(contentEl)
      .setName('用户可发言')
      .setDesc('关闭则为旁观模式，只看 AI 互相对话')
      .addToggle(toggle => toggle
        .setValue(this.room.userCanSpeak)
        .onChange(v => this.room.userCanSpeak = v));

    // 最大上下文
    new Setting(contentEl)
      .setName('上下文消息数')
      .setDesc('发送给每个 AI 的历史消息数量')
      .addSlider(slider => slider
        .setLimits(5, 50, 5)
        .setValue(this.room.maxContextMessages)
        .setDynamicTooltip()
        .onChange(v => this.room.maxContextMessages = v));

    // 成员选择
    const memberSection = contentEl.createDiv({ cls: 'member-section' });
    memberSection.createEl('h3', { text: '选择成员' });
    memberSection.createEl('p', { 
      text: '勾选要加入群聊的角色',
      cls: 'setting-item-description'
    });

    const memberGrid = memberSection.createDiv({ cls: 'member-select-grid' });
    this.plugin.settings.personas.forEach(persona => {
      this.renderMemberOption(memberGrid, persona);
    });

    // 群聊系统提示词
    new Setting(contentEl)
      .setName('群聊系统提示词')
      .setDesc('附加在每个角色系统提示词后面')
      .addTextArea(text => {
        text.setValue(this.room.groupSystemPrompt || '')
          .setPlaceholder('可选，例如：保持友好轻松的氛围')
          .onChange(v => this.room.groupSystemPrompt = v);
        text.inputEl.rows = 3;
      });

    // 按钮
    const buttons = contentEl.createDiv({ cls: 'modal-buttons' });
    
    new ButtonComponent(buttons)
      .setButtonText('取消')
      .onClick(() => this.close());

    new ButtonComponent(buttons)
      .setButtonText('保存')
      .setCta()
      .onClick(async () => {
        if (!this.room.name.trim()) {
          new Notice('请输入房间名称');
          return;
        }
        if (this.selectedMembers.size < 2) {
          new Notice('请至少选择 2 个成员');
          return;
        }
        this.room.memberIds = Array.from(this.selectedMembers);
        await this.onSave(this.room);
        new Notice(this.isNew ? '群聊已创建' : '群聊已更新');
        this.close();
      });
  }

  renderMemberOption(container: HTMLElement, persona: Persona) {
    const item = container.createDiv({ 
      cls: `member-option ${this.selectedMembers.has(persona.id) ? 'selected' : ''}`
    });

    // 头像
    const avatar = item.createDiv({ cls: 'member-avatar' });
    if (persona.avatar) {
      const img = avatar.createEl('img', { 
        attr: { src: this.resolveAvatarUrl(persona.avatar) }
      });
      img.onerror = () => {
        img.remove();
        avatar.textContent = persona.name.charAt(0).toUpperCase();
      };
    } else {
      avatar.textContent = persona.name.charAt(0).toUpperCase();
    }

    // 信息
    const info = item.createDiv({ cls: 'member-info' });
    info.createEl('div', { text: persona.name, cls: 'member-name' });
    info.createEl('div', { 
      text: persona.description || '无描述',
      cls: 'member-desc'
    });

    // 勾选状态
    const checkbox = item.createEl('input', { 
      type: 'checkbox',
      cls: 'member-checkbox'
    });
    (checkbox as HTMLInputElement).checked = this.selectedMembers.has(persona.id);

    item.onclick = () => {
      if (this.selectedMembers.has(persona.id)) {
        this.selectedMembers.delete(persona.id);
        item.removeClass('selected');
      } else {
        this.selectedMembers.add(persona.id);
        item.addClass('selected');
      }
      (checkbox as HTMLInputElement).checked = this.selectedMembers.has(persona.id);
    };
  }

  resolveAvatarUrl(avatar: string): string {
    if (!avatar) return '';
    if (avatar.startsWith('data:') || avatar.startsWith('http')) return avatar;
    const file = this.app.vault.getAbstractFileByPath(avatar);
    if (file) {
      return this.app.vault.getResourcePath(file as any);
    }
    return avatar;
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
