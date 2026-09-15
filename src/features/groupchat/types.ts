/**
 * AI 群聊功能类型定义
 */

import { Character } from '../character/types';

/**
 * 发言顺序策略
 */
export type SpeakingOrderStrategy = 
  | 'round-robin'    // 轮流发言
  | 'random'         // 随机发言
  | 'ai-decide'      // AI 决定下一个发言者
  | 'mentioned-only' // 只有被 @ 的角色发言
  | 'manual';        // 用户手动选择

/**
 * 群聊消息（扩展 ChatMessage）
 */
export interface GroupChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** 发言角色 ID（assistant 消息必填） */
  speakerId?: string;
  /** 发言角色名称（用于显示） */
  speakerName?: string;
  /** 发言角色头像 */
  speakerAvatar?: string;
  /** 被 @ 的角色 ID 列表 */
  mentions?: string[];
  /** 时间戳 */
  timestamp?: number;
}

/**
 * 群聊房间定义
 */
export interface GroupChatRoom {
  id: string;
  name: string;
  description?: string;
  
  /** 参与角色 ID 列表 */
  memberIds: string[];
  
  /** 发言顺序策略 */
  speakingOrder: SpeakingOrderStrategy;
  
  /** 每轮发言人数（round-robin 和 random 模式使用） */
  speakersPerRound: number;
  
  /** 用户是否可以发言（false = 旁观模式） */
  userCanSpeak: boolean;
  
  /** 群聊系统提示词（附加在每个角色的系统提示词后） */
  groupSystemPrompt?: string;
  
  /** 使用的模型（为空则使用各角色设定或默认模型） */
  model?: string;
  
  /** 最大上下文消息数 */
  maxContextMessages: number;
  
  /** 创建时间 */
  createdAt: number;
  
  /** 更新时间 */
  updatedAt: number;
}

/**
 * 群聊会话（扩展 Conversation）
 */
export interface GroupConversation {
  id: string;
  title: string;
  
  /** 关联的群聊房间 ID */
  roomId: string;
  
  /** 群聊消息历史 */
  history: GroupChatMessage[];
  
  /** 当前发言者索引（round-robin 模式使用） */
  currentSpeakerIndex: number;
  
  /** 是否正在进行 AI 对话（自动模式） */
  isAutoRunning: boolean;
  
  /** 创建时间 */
  createdAt: number;
  
  /** 更新时间 */
  updatedAt: number;
}

/**
 * 群聊设置
 */
export interface GroupChatSettings {
  /** 群聊房间列表 */
  rooms: GroupChatRoom[];
  
  /** 自动对话时的间隔（毫秒） */
  autoReplyDelay: number;
  
  /** 自动对话时每轮最大回复数 */
  autoReplyMaxRounds: number;
  
  /** 是否显示发言者头像 */
  showAvatars: boolean;
  
  /** 是否显示发言时间 */
  showTimestamp: boolean;
}

/**
 * 下一个发言者的结果
 */
export interface NextSpeakerResult {
  speakerId: string;
  reason?: string;
}

/**
 * 群聊管理器事件
 */
export interface GroupChatEvents {
  onMessageSent: (message: GroupChatMessage) => void;
  onSpeakerChange: (speakerId: string) => void;
  onAutoModeChange: (isRunning: boolean) => void;
  onError: (error: Error) => void;
}

/**
 * 群聊上下文（用于构建提示词）
 */
export interface GroupChatContext {
  room: GroupChatRoom;
  members: Character[];
  recentMessages: GroupChatMessage[];
  currentSpeaker: Character;
  mentions?: Character[];
}

/**
 * 默认群聊设置
 */
export const DEFAULT_GROUP_CHAT_SETTINGS: GroupChatSettings = {
  rooms: [],
  autoReplyDelay: 1500,
  autoReplyMaxRounds: 10,
  showAvatars: true,
  showTimestamp: false,
};

/**
 * 创建默认群聊房间
 */
export function createDefaultRoom(name: string, memberIds: string[]): GroupChatRoom {
  const now = Date.now();
  return {
    id: `room-${now}`,
    name,
    memberIds,
    speakingOrder: 'round-robin',
    speakersPerRound: 1,
    userCanSpeak: true,
    maxContextMessages: 20,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 创建群聊系统消息
 */
export function createGroupSystemMessage(content: string): GroupChatMessage {
  return {
    role: 'system',
    content,
    timestamp: Date.now(),
  };
}

/**
 * 创建群聊用户消息
 */
export function createGroupUserMessage(content: string, mentions?: string[]): GroupChatMessage {
  return {
    role: 'user',
    content,
    mentions,
    timestamp: Date.now(),
  };
}

/**
 * 创建群聊 AI 消息
 */
export function createGroupAssistantMessage(
  content: string, 
  speaker: Character
): GroupChatMessage {
  return {
    role: 'assistant',
    content,
    speakerId: speaker.id,
    speakerName: speaker.name,
    speakerAvatar: speaker.avatar,
    timestamp: Date.now(),
  };
}
