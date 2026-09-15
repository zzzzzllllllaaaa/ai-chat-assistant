/**
 * 群聊管理器
 * 管理群聊房间、会话和多角色对话逻辑
 */

import { App } from 'obsidian';
import { Character } from '../character/types';
import { 
  GroupChatRoom, 
  GroupConversation, 
  GroupChatMessage,
  GroupChatSettings,
  GroupChatContext,
  NextSpeakerResult,
  SpeakingOrderStrategy,
  DEFAULT_GROUP_CHAT_SETTINGS,
  createDefaultRoom,
  createGroupAssistantMessage,
  createGroupUserMessage,
} from './types';
import type { IPluginContext } from "../../core/plugin-context";;
import { ChatMessage } from '../../core/types';

/**
 * 群聊管理器
 */
export class GroupChatManager {
  private app: App;
  private plugin: IPluginContext;
  private settings: GroupChatSettings;
  private conversations: Map<string, GroupConversation> = new Map();
  private abortController: AbortController | null = null;

  constructor(app: App, plugin: IPluginContext) {
    this.app = app;
    this.plugin = plugin;
    this.settings = this.loadSettings();
  }

  // ============ 设置管理 ============

  private loadSettings(): GroupChatSettings {
    const saved = (this.plugin.settings as any).groupChat;
    return { ...DEFAULT_GROUP_CHAT_SETTINGS, ...saved };
  }

  public async saveSettings(): Promise<void> {
    (this.plugin.settings as any).groupChat = this.settings;
    await this.plugin.saveSettings();
  }

  public getSettings(): GroupChatSettings {
    return this.settings;
  }

  // ============ 房间管理 ============

  public getRooms(): GroupChatRoom[] {
    return this.settings.rooms;
  }

  public getRoom(roomId: string): GroupChatRoom | undefined {
    return this.settings.rooms.find(r => r.id === roomId);
  }

  public async createRoom(name: string, memberIds: string[]): Promise<GroupChatRoom> {
    const room = createDefaultRoom(name, memberIds);
    this.settings.rooms.push(room);
    await this.saveSettings();
    return room;
  }

  public async updateRoom(room: GroupChatRoom): Promise<void> {
    const index = this.settings.rooms.findIndex(r => r.id === room.id);
    if (index >= 0) {
      room.updatedAt = Date.now();
      this.settings.rooms[index] = room;
      await this.saveSettings();
    }
  }

  public async deleteRoom(roomId: string): Promise<void> {
    this.settings.rooms = this.settings.rooms.filter(r => r.id !== roomId);
    await this.saveSettings();
  }

  // ============ 会话管理 ============

  public createConversation(room: GroupChatRoom): GroupConversation {
    const now = Date.now();
    const conv: GroupConversation = {
      id: `gconv-${now}`,
      title: `${room.name} - ${new Date(now).toLocaleString()}`,
      roomId: room.id,
      history: [],
      currentSpeakerIndex: 0,
      isAutoRunning: false,
      createdAt: now,
      updatedAt: now,
    };
    this.conversations.set(conv.id, conv);
    return conv;
  }

  public getConversation(convId: string): GroupConversation | undefined {
    return this.conversations.get(convId);
  }

  // ============ 角色获取 ============

  private getCharacters(): Character[] {
    // 从 personas 列表获取角色
    return (this.plugin.settings.personas || []) as Character[];
  }

  private getCharacter(id: string): Character | undefined {
    return this.getCharacters().find(c => c.id === id);
  }

  private getRoomMembers(room: GroupChatRoom): Character[] {
    return room.memberIds
      .map(id => this.getCharacter(id))
      .filter((c): c is Character => c !== undefined);
  }

  // ============ 发言顺序策略 ============

  /**
   * 获取下一个发言者
   */
  public async getNextSpeaker(
    room: GroupChatRoom,
    conversation: GroupConversation,
    userMessage?: string
  ): Promise<NextSpeakerResult | null> {
    const members = this.getRoomMembers(room);
    if (members.length === 0) return null;

    switch (room.speakingOrder) {
      case 'round-robin':
        return this.getNextSpeakerRoundRobin(room, conversation);
      
      case 'random':
        return this.getNextSpeakerRandom(room, conversation);
      
      case 'ai-decide':
        return await this.getNextSpeakerAIDecide(room, conversation, userMessage);
      
      case 'mentioned-only':
        return this.getNextSpeakerMentioned(room, conversation, userMessage);
      
      case 'manual':
        return null; // 需要用户手动选择
      
      default:
        return this.getNextSpeakerRoundRobin(room, conversation);
    }
  }

  private getNextSpeakerRoundRobin(
    room: GroupChatRoom,
    conversation: GroupConversation
  ): NextSpeakerResult | null {
    const members = this.getRoomMembers(room);
    if (members.length === 0) return null;

    const index = conversation.currentSpeakerIndex % members.length;
    conversation.currentSpeakerIndex = (index + 1) % members.length;

    return {
      speakerId: members[index].id,
      reason: `轮流发言: ${members[index].name}`,
    };
  }

  private getNextSpeakerRandom(
    room: GroupChatRoom,
    conversation: GroupConversation
  ): NextSpeakerResult | null {
    const members = this.getRoomMembers(room);
    if (members.length === 0) return null;

    // 避免连续两次同一个人发言
    const lastMessage = conversation.history.filter(m => m.role === 'assistant').slice(-1)[0];
    const lastSpeakerId = lastMessage?.speakerId;
    
    let candidates = members.filter(m => m.id !== lastSpeakerId);
    if (candidates.length === 0) candidates = members;

    const randomIndex = Math.floor(Math.random() * candidates.length);
    return {
      speakerId: candidates[randomIndex].id,
      reason: `随机选择: ${candidates[randomIndex].name}`,
    };
  }

  private async getNextSpeakerAIDecide(
    room: GroupChatRoom,
    conversation: GroupConversation,
    userMessage?: string
  ): Promise<NextSpeakerResult | null> {
    const members = this.getRoomMembers(room);
    if (members.length === 0) return null;

    // 构建决策提示词
    const memberList = members.map(m => `- ${m.name} (${m.id}): ${m.description || '无描述'}`).join('\n');
    const recentMessages = conversation.history.slice(-10).map(m => {
      if (m.role === 'user') return `[用户]: ${m.content}`;
      if (m.role === 'assistant') return `[${m.speakerName || 'AI'}]: ${m.content}`;
      return '';
    }).filter(Boolean).join('\n');

    const prompt = `你是一个群聊协调者。根据对话内容，决定下一个最适合发言的角色。

参与角色：
${memberList}

最近对话：
${recentMessages}
${userMessage ? `\n用户刚说: ${userMessage}` : ''}

请只回复一个角色 ID（不要其他内容）。选择最适合回应当前话题的角色。`;

    try {
      const model = room.model || this.plugin.settings.defaultChatModel || 'gpt-3.5-turbo';
      const llmMessages: ChatMessage[] = [{ role: 'user', content: prompt }];
      const response = await this.plugin.llmService.getCompletion(llmMessages, model);

      const speakerId = (response.content || '').trim();
      const speaker = members.find(m => m.id === speakerId || m.name === speakerId);
      
      if (speaker) {
        return {
          speakerId: speaker.id,
          reason: `AI 选择: ${speaker.name}`,
        };
      }
    } catch (error) {
      console.error('AI 决定发言者失败:', error);
    }

    // 回退到随机
    return this.getNextSpeakerRandom(room, conversation);
  }

  private getNextSpeakerMentioned(
    room: GroupChatRoom,
    conversation: GroupConversation,
    userMessage?: string
  ): NextSpeakerResult | null {
    if (!userMessage) return null;

    const members = this.getRoomMembers(room);
    
    // 解析 @提及
    const mentionPattern = /@(\S+)/g;
    const mentions: string[] = [];
    let match;
    while ((match = mentionPattern.exec(userMessage)) !== null) {
      mentions.push(match[1]);
    }

    if (mentions.length === 0) return null;

    // 查找被提及的角色
    for (const mention of mentions) {
      const speaker = members.find(m => 
        m.name.toLowerCase() === mention.toLowerCase() ||
        m.id === mention
      );
      if (speaker) {
        return {
          speakerId: speaker.id,
          reason: `被 @ 提及: ${speaker.name}`,
        };
      }
    }

    return null;
  }

  // ============ 消息处理 ============

  /**
   * 发送用户消息并获取 AI 回复
   */
  public async sendUserMessage(
    conversation: GroupConversation,
    content: string,
    onUpdate?: (message: GroupChatMessage) => void
  ): Promise<GroupChatMessage[]> {
    const room = this.getRoom(conversation.roomId);
    if (!room) throw new Error('房间不存在');

    // 解析 @提及
    const mentions = this.parseMentions(content, room);
    
    // 添加用户消息
    const userMessage = createGroupUserMessage(content, mentions);
    conversation.history.push(userMessage);
    conversation.updatedAt = Date.now();

    // 获取需要回复的角色
    const responses: GroupChatMessage[] = [];
    
    if (room.speakingOrder === 'mentioned-only' && mentions.length === 0) {
      // 没有 @ 任何人，不回复
      return responses;
    }

    // 获取发言者
    const speakersToRespond: string[] = [];
    
    if (mentions.length > 0 && room.speakingOrder !== 'round-robin') {
      // 优先回复被 @ 的角色
      speakersToRespond.push(...mentions);
    } else {
      // 按策略获取发言者
      for (let i = 0; i < room.speakersPerRound; i++) {
        const next = await this.getNextSpeaker(room, conversation, content);
        if (next && !speakersToRespond.includes(next.speakerId)) {
          speakersToRespond.push(next.speakerId);
        }
      }
    }

    // 依次让每个角色回复
    for (const speakerId of speakersToRespond) {
      const response = await this.generateResponse(room, conversation, speakerId, onUpdate);
      if (response) {
        responses.push(response);
      }
    }

    return responses;
  }

  /**
   * 解析消息中的 @提及
   */
  private parseMentions(content: string, room: GroupChatRoom): string[] {
    const members = this.getRoomMembers(room);
    const mentionPattern = /@(\S+)/g;
    const mentions: string[] = [];
    
    let match;
    while ((match = mentionPattern.exec(content)) !== null) {
      const mentionText = match[1];
      const member = members.find(m => 
        m.name.toLowerCase() === mentionText.toLowerCase() ||
        m.id === mentionText
      );
      if (member && !mentions.includes(member.id)) {
        mentions.push(member.id);
      }
    }
    
    return mentions;
  }

  /**
   * 生成角色回复
   */
  private async generateResponse(
    room: GroupChatRoom,
    conversation: GroupConversation,
    speakerId: string,
    onUpdate?: (message: GroupChatMessage) => void
  ): Promise<GroupChatMessage | null> {
    const speaker = this.getCharacter(speakerId);
    if (!speaker) return null;

    // 构建上下文
    const context = this.buildContext(room, conversation, speaker);
    
    // 构建消息历史
    const messages = this.buildMessages(context);
    
    // 调用 LLM
    const model = speaker.model || room.model || this.plugin.settings.defaultChatModel || 'gpt-3.5-turbo';
    
    try {
      // 转换为 LLM 消息格式
      const llmMessages: ChatMessage[] = messages.map(m => ({
        role: m.role as 'system' | 'user' | 'assistant',
        content: m.content || '',
      }));
      
      const response = await this.plugin.llmService.getCompletion(llmMessages, model);
      const responseContent = response.content || '';

      const aiMessage = createGroupAssistantMessage(responseContent, speaker);
      conversation.history.push(aiMessage);
      conversation.updatedAt = Date.now();
      
      if (onUpdate) {
        onUpdate(aiMessage);
      }

      return aiMessage;
    } catch (error) {
      console.error(`角色 ${speaker.name} 回复失败:`, error);
      return null;
    }
  }

  /**
   * 构建群聊上下文
   */
  private buildContext(
    room: GroupChatRoom,
    conversation: GroupConversation,
    currentSpeaker: Character
  ): GroupChatContext {
    const members = this.getRoomMembers(room);
    const recentMessages = conversation.history.slice(-room.maxContextMessages);
    
    return {
      room,
      members,
      recentMessages,
      currentSpeaker,
    };
  }

  /**
   * 构建发送给 LLM 的消息
   */
  private buildMessages(context: GroupChatContext): ChatMessage[] {
    const { room, members, recentMessages, currentSpeaker } = context;
    
    // 构建系统提示词
    const otherMembers = members.filter(m => m.id !== currentSpeaker.id);
    const memberIntro = otherMembers.map(m => `- ${m.name}: ${m.description || '无描述'}`).join('\n');
    
    let systemPrompt = currentSpeaker.systemPrompt || '';
    
    // 添加群聊上下文
    systemPrompt += `\n\n你正在一个群聊中。群聊名称: ${room.name}
${room.description ? `群聊描述: ${room.description}` : ''}

其他参与者:
${memberIntro}

请以 ${currentSpeaker.name} 的身份回复。保持角色设定，自然地参与对话。
如果有人 @ 你，优先回应他们。`;

    if (room.groupSystemPrompt) {
      systemPrompt += `\n\n${room.groupSystemPrompt}`;
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt }
    ];

    // 添加历史消息
    for (const msg of recentMessages) {
      if (msg.role === 'user') {
        messages.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        // 标注发言者
        const prefix = msg.speakerId === currentSpeaker.id 
          ? '' 
          : `[${msg.speakerName || 'AI'}]: `;
        messages.push({ 
          role: msg.speakerId === currentSpeaker.id ? 'assistant' : 'user',
          content: prefix + msg.content 
        });
      }
    }

    return messages;
  }

  // ============ 自动对话模式 ============

  /**
   * 开始自动对话
   */
  public async startAutoConversation(
    conversation: GroupConversation,
    onMessage?: (message: GroupChatMessage) => void,
    onStop?: () => void
  ): Promise<void> {
    const room = this.getRoom(conversation.roomId);
    if (!room) return;

    conversation.isAutoRunning = true;
    this.abortController = new AbortController();

    let rounds = 0;
    const maxRounds = this.settings.autoReplyMaxRounds;

    while (conversation.isAutoRunning && rounds < maxRounds) {
      if (this.abortController?.signal.aborted) break;

      const next = await this.getNextSpeaker(room, conversation);
      if (!next) break;

      const response = await this.generateResponse(room, conversation, next.speakerId, onMessage);
      if (!response) break;

      rounds++;

      // 等待间隔
      await new Promise(resolve => setTimeout(resolve, this.settings.autoReplyDelay));
    }

    conversation.isAutoRunning = false;
    if (onStop) onStop();
  }

  /**
   * 停止自动对话
   */
  public stopAutoConversation(conversation: GroupConversation): void {
    conversation.isAutoRunning = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  // ============ 旁观模式 ============

  /**
   * 开始旁观模式（纯 AI 对话）
   */
  public async startObserverMode(
    conversation: GroupConversation,
    initialTopic?: string,
    onMessage?: (message: GroupChatMessage) => void,
    onStop?: () => void
  ): Promise<void> {
    const room = this.getRoom(conversation.roomId);
    if (!room) return;

    // 添加初始话题（如果有）
    if (initialTopic) {
      const systemMessage: GroupChatMessage = {
        role: 'system',
        content: `话题: ${initialTopic}`,
        timestamp: Date.now(),
      };
      conversation.history.push(systemMessage);
      if (onMessage) onMessage(systemMessage);
    }

    // 开始自动对话
    await this.startAutoConversation(conversation, onMessage, onStop);
  }
}
