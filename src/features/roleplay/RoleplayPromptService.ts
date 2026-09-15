/**
 * 角色扮演系统提示词构建服务
 * 
 * 从 main.ts 提取，负责：
 * - 占位符替换 ({{user}}, {{char}})
 * - 角色知识库 (Lorebook) 条目解析
 * - 角色扮演宏预处理 (getwi, rpState 变量)
 * - 系统提示词结构化组装
 */
import { TFile, type Vault } from "obsidian";
import type { AiChatAssistantSettings } from "../../core/settings-types";
import type { Conversation } from "../../core/types";
import type { ImmersionManager } from "../memory/ImmersionManager";
import { logger } from "../../core/logger";

export class RoleplayPromptService {
  private settings: AiChatAssistantSettings;
  private vault: Vault;
  private immersion: ImmersionManager | null;

  constructor(settings: AiChatAssistantSettings, vault: Vault, immersion: ImmersionManager | null = null) {
    this.settings = settings;
    this.vault = vault;
    this.immersion = immersion;
  }

  /** 获取当前用户角色名称 */
  getUserPersonaName(): string {
    const activeId = this.settings.activeUserPersonaId;
    const userPersona = (this.settings.userPersonas || []).find(p => p.id === activeId);
    return userPersona?.name || '用户';
  }

  /**
   * 替换系统提示中的占位符
   * {{user}} -> 用户角色名
   * {{char}} -> AI角色名
   */
  replacePromptPlaceholders(text: string, charName?: string): string {
    if (!text) return text;
    
    const userName = this.getUserPersonaName();
    const activePersonaId = this.settings.activePersonaId;
    const activePersona = (this.settings.personas || []).find(p => p.id === activePersonaId);
    const characterName = charName || activePersona?.name || 'AI';
    
    return text
      .replace(/\{\{user\}\}/gi, userName)
      .replace(/\{\{char\}\}/gi, characterName);
  }

  /** 解析角色知识库条目内容 */
  private parseCharacterBookEntryContentByName(rawText: string, entryName: string): string {
    const text = String(rawText || '');
    const target = String(entryName || '').trim();
    if (!text || !target) return '';

    const sectionRegex = /^##\s+(.+?)\s*$/gm;
    const sections: Array<{ heading: string; start: number; end: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = sectionRegex.exec(text))) {
      sections.push({ heading: String(m[1] || '').trim(), start: m.index, end: text.length });
    }
    for (let i = 0; i < sections.length; i++) {
      sections[i].end = i + 1 < sections.length ? sections[i + 1].start : text.length;
    }

    const normalizeHeading = (value: string) => value.replace(/\((?:已)?禁用\)|（(?:已)?禁用）/g, '').trim();
    const found = sections.find(section => normalizeHeading(section.heading) === target);
    if (!found) return '';

    const sectionText = text.slice(found.start, found.end);
    const body = sectionText.replace(/^##\s+.+?\s*$/m, '').trim();
    return body
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
  }

  /** 从 Lorebook 文件解析条目 */
  private async resolveLorebookEntryByName(persona: any, entryName: string): Promise<string> {
    const target = String(entryName || '').trim();
    if (!target) return '';

    const characterBook = (persona as any)?.characterBook;
    if (characterBook?.entries && Array.isArray(characterBook.entries)) {
      const match = characterBook.entries.find((entry: any) => String(entry?.name || '').trim() === target && entry?.enabled !== false);
      if (match?.content) return String(match.content || '').trim();
    }

    try {
      const folderName = String(persona?.name || '').trim()
        .replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 48)
        || String(persona?.id || 'default').replace(/[^a-zA-Z0-9\u4e00-\u9fa5-_]/g, '_');
      const memoryPath = this.settings.memoryPath || 'AI_Memory';
      const lorebookPath = `${memoryPath}/${folderName}/Facts/角色知识库.md`;
      const file = this.vault.getAbstractFileByPath(lorebookPath);
      if (file instanceof TFile) {
        const raw = await this.vault.read(file);
        return this.parseCharacterBookEntryContentByName(raw, target);
      }
    } catch (e) {
      logger.warn('AI', '[Macro] Failed to resolve lorebook entry', e);
    }

    return '';
  }

  /** 角色扮演宏预处理：占位符 + getwi 调用 + rpState 变量替换 */
  async preprocessRoleplayMacros(text: string, persona?: any, conversation?: Conversation | null): Promise<string> {
    let output = this.replacePromptPlaceholders(String(text || ''), persona?.name);
    if (!output) return output;

    const getwiRegex = /<%-\s*await\s+getwi\(\s*null\s*,\s*['\"]([^'\"]+)['\"]\s*\)\s*-%>/g;
    const matches = Array.from(output.matchAll(getwiRegex));
    if (matches.length > 0) {
      for (const match of matches) {
        const full = match[0];
        const entryName = match[1];
        const resolved = await this.resolveLorebookEntryByName(persona, entryName);
        output = output.replace(full, resolved || '');
      }
    }

    const rpState = conversation?.roleplayState;
    if (rpState?.player) {
      output = output.replace(/\{\{char\.([\w_]+)\}\}/gi, (_m, key) => String((rpState.player as any)?.[key] ?? ''));
    }
    if (rpState?.variables) {
      output = output.replace(/\{\{var\.([\w_]+)\}\}/gi, (_m, key) => String((rpState.variables as any)?.[key] ?? ''));
    }

    return output;
  }

  /** 获取当前活跃的用户角色设定信息 */
  getUserPersonaContext(): string {
    const activeId = this.settings.activeUserPersonaId;
    const userPersona = (this.settings.userPersonas || []).find(p => p.id === activeId);
    if (!userPersona) return '';
    
    const parts: string[] = [];
    if (userPersona.description && userPersona.description.trim()) {
      parts.push(userPersona.description.trim());
    }
    if (userPersona.settings && userPersona.settings.trim()) {
      parts.push(userPersona.settings.trim());
    }
    if (parts.length === 0) return '';
    
    return `\n\n[用户角色设定]\n{{user}} 的角色信息：\n${parts.join('\n')}\n`;
  }

  /** 构建示例消息块（角色语气和风格参考） */
  buildExampleMessagesBlock(persona: any): string {
    const examples = (persona as any)?.exampleMessages;
    if (!examples || typeof examples !== 'string' || !examples.trim()) return '';
    
    const processed = this.replacePromptPlaceholders(examples, persona?.name);
    return `\n\n[对话范例 - 角色语气和风格参考]\n${processed}\n[对话范例结束]\n`;
  }

  /**
   * 结构化构建角色扮演系统提示词
   * 注入顺序（高→低注意力区域）：
   * 1. 沉浸感增强（叙事视角）
   * 2. 瞬时状态（stateMachine）
   * 3. 角色核心设定
   * 4. 用户角色 + 对话范例
   * 5. 世界实时状态
   * 6. 世界记录（知识图谱 + 记忆）
   * 7. 叙事引导（触发事件 + 天道 + 自检）
   * 8. 辅助信息（日期、MBTI）
   */
  async buildRoleplaySystemPrompt(params: {
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
    const sections: string[] = [];
    
    // 第 -1 层：沉浸感增强
    const personaId = params.persona.id;
    const conversationId = params.conversation?.id;
    if (personaId && conversationId && params.messages && this.immersion) {
      try {
        const basePrompt = params.persona.systemPrompt || '';
        const enhanced = await this.immersion.enhanceSystemPrompt(
          basePrompt, personaId, conversationId, params.messages
        );
        const enhancementPart = enhanced.replace(basePrompt, '').trim();
        if (enhancementPart) sections.push(enhancementPart);
      } catch (error) {
        logger.warn('Immersion', '沉浸感增强失败', error);
      }
    }
    
    // 第 0 层：瞬时状态
    if (params.stateMachineContext) {
      sections.push(await this.preprocessRoleplayMacros(params.stateMachineContext, params.persona, params.conversation));
    }
    
    // 第 1 层：角色核心设定
    if (params.persona.systemPrompt) {
      sections.push(await this.preprocessRoleplayMacros(params.persona.systemPrompt, params.persona, params.conversation));
    }
    
    // 第 2 层：用户角色 + 对话范例
    if (params.userPersonaContext) {
      sections.push(await this.preprocessRoleplayMacros(params.userPersonaContext, params.persona, params.conversation));
    }
    if (params.exampleMessagesBlock) {
      sections.push(await this.preprocessRoleplayMacros(params.exampleMessagesBlock, params.persona, params.conversation));
    }
    
    // 第 3 层：世界实时状态
    if (params.worldStateBlock) {
      sections.push(await this.preprocessRoleplayMacros(params.worldStateBlock, params.persona, params.conversation));
    }
    
    // 第 4 层：世界记录
    if (params.graphRAGContext) {
      sections.push(await this.preprocessRoleplayMacros(params.graphRAGContext, params.persona, params.conversation));
    }
    if (params.memoryContext) {
      sections.push(await this.preprocessRoleplayMacros(params.memoryContext, params.persona, params.conversation));
    }
    if (params.privateMemoryContext) {
      sections.push(await this.preprocessRoleplayMacros(params.privateMemoryContext, params.persona, params.conversation));
    }
    
    // 第 5 层：叙事引导
    if (params.triggeredConsequencesBlock) {
      sections.push(await this.preprocessRoleplayMacros(params.triggeredConsequencesBlock, params.persona, params.conversation));
    }
    if (params.fateEventsBlock) {
      sections.push(await this.preprocessRoleplayMacros(params.fateEventsBlock, params.persona, params.conversation));
    }
    sections.push(`\n[回复前自检]\n- 场景感官细节是否到位？（选择1-2种最有氛围的感官）\n- 当前角色的情绪和关注点是什么？\n- 信息边界：这个角色不该知道什么？\n- 叙事节奏：这一段该紧凑还是舒缓？`);
    
    // 第 6 层：辅助信息
    if (params.datePrompt) sections.push(params.datePrompt);
    if (params.mbtiPrompt) sections.push(params.mbtiPrompt);
    
    return sections.join('\n');
  }
}
