/**
 * Agent 反思机制 (Reflexion)
 * 
 * 核心思想：
 * 1. 工具执行失败后自动反思，找出原因
 * 2. 用户反馈不满意时触发反思
 * 3. 将反思结果存入会话上下文，避免重复犯错
 */

import type { ChatMessage } from "../../core/types";
import { logger } from "../../core/logger";

export interface ReflectionEntry {
  id: string;
  timestamp: number;
  trigger: 'tool_error' | 'user_feedback' | 'task_failed';
  context: {
    toolName?: string;
    toolArgs?: any;
    errorMessage?: string;
    userFeedback?: string;
    taskDescription?: string;
  };
  reflection: string;
  lesson: string;
  preventionStrategy?: string;
}

export interface ReflectionStore {
  entries: ReflectionEntry[];
  maxEntries: number;
}

/**
 * 反思管理器
 */
export class ReflectionManager {
  private store: ReflectionStore = {
    entries: [],
    maxEntries: 20, // 只保留最近20条反思
  };

  private onPersist: (() => void) | null = null;

  /** 从持久化数据加载反思条目 */
  public loadEntries(entries: any[]): void {
    if (!Array.isArray(entries)) return;
    this.store.entries = entries.filter(e => e && e.id && e.lesson).slice(-this.store.maxEntries);
  }

  /** 导出反思条目用于持久化 */
  public exportEntries(): ReflectionEntry[] {
    return [...this.store.entries];
  }

  /** 注册持久化回调（addReflection 后自动触发） */
  public setOnPersist(callback: () => void): void {
    this.onPersist = callback;
  }

  /**
   * 检测是否是工具执行错误
   */
  public isToolError(result: string): boolean {
    const errorPatterns = [
      /^错误:/,
      /工具执行出错/,
      /未找到工具/,
      /参数不合法/,
      /找不到文件/,
      /找不到笔记/,
      /未找到要替换的内容/,
      /超时/,
      /\[Verify\]\s*失败/,
      /验证失败/,
      /结果未确认/,
    ];
    return errorPatterns.some(pattern => pattern.test(result));
  }

  /**
   * 检测用户是否表达不满
   */
  public isNegativeFeedback(userMessage: string): boolean {
    const negativePhrases = [
      '不对', '错了', '不是这样', '重来', '重新', '再试',
      '这不对', '搞错了', '弄错了', '不是我要的',
      '怎么会', '出问题了', '有问题',
    ];
    const lowerMsg = userMessage.toLowerCase();
    return negativePhrases.some(phrase => lowerMsg.includes(phrase));
  }

  /**
   * 生成反思 Prompt
   */
  public generateReflectionPrompt(context: {
    toolName?: string;
    toolArgs?: any;
    errorMessage?: string;
    userFeedback?: string;
    previousActions?: string;
  }): ChatMessage[] {
    let situationDescription = '';
    
    if (context.errorMessage) {
      situationDescription = `工具执行失败：
- 工具名称：${context.toolName || '未知'}
- 调用参数：${JSON.stringify(context.toolArgs || {}, null, 2)}
- 错误信息：${context.errorMessage}`;
    } else if (context.userFeedback) {
      situationDescription = `用户表示不满意：
- 用户反馈：${context.userFeedback}
- 之前的操作：${context.previousActions || '无记录'}`;
    }

    return [
      {
        role: 'system',
        content: `你是一个反思专家。当任务执行出错或用户不满意时，你需要：
1. 分析失败的根本原因
2. 总结教训（简洁的一句话）
3. 提出预防策略（下次如何避免）

请用以下 JSON 格式回复（只输出 JSON）：
{
  "rootCause": "失败的根本原因",
  "lesson": "简洁的教训总结（一句话）",
  "preventionStrategy": "下次如何避免这个问题"
}`
      },
      {
        role: 'user',
        content: `请分析以下情况并进行反思：

${situationDescription}

请输出 JSON 格式的反思结果。`
      }
    ];
  }

  /**
   * 解析反思结果
   */
  public parseReflectionResponse(response: string): { rootCause: string; lesson: string; preventionStrategy: string } | null {
    try {
      // 尝试提取 JSON
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          rootCause: parsed.rootCause || parsed.root_cause || '未知原因',
          lesson: parsed.lesson || '无',
          preventionStrategy: parsed.preventionStrategy || parsed.prevention_strategy || '无',
        };
      }
    } catch (e) {
      logger.warn("Reflection", "Failed to parse reflection response", { response });
    }
    return null;
  }

  /**
   * 添加反思条目
   */
  public addReflection(entry: Omit<ReflectionEntry, 'id' | 'timestamp'>): ReflectionEntry {
    const newEntry: ReflectionEntry = {
      ...entry,
      id: `ref_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
    };

    this.store.entries.push(newEntry);

    // 保持最大条目数
    while (this.store.entries.length > this.store.maxEntries) {
      this.store.entries.shift();
    }

    logger.info("Reflection", "Added reflection entry", { 
      trigger: entry.trigger, 
      lesson: entry.lesson 
    });

    // 触发持久化回调
    if (this.onPersist) {
      try { this.onPersist(); } catch (_) { /* ignore */ }
    }

    return newEntry;
  }

  /**
   * 获取相关的反思经验（用于注入到 Agent 上下文）
   */
  public getRelevantReflections(context: {
    toolNames?: string[];
    taskDescription?: string;
    limit?: number;
  }): ReflectionEntry[] {
    const limit = context.limit || 5;
    let relevant = [...this.store.entries];

    // 按相关性排序
    if (context.toolNames && context.toolNames.length > 0) {
      relevant = relevant.filter(entry => 
        context.toolNames!.some(tool => entry.context.toolName === tool) ||
        entry.trigger === 'user_feedback' // 用户反馈的教训总是相关
      );
    }

    // 按时间倒序，取最近的
    relevant.sort((a, b) => b.timestamp - a.timestamp);
    return relevant.slice(0, limit);
  }

  /**
   * 格式化反思经验为上下文字符串
   */
  public formatReflectionsForContext(reflections: ReflectionEntry[]): string {
    if (reflections.length === 0) return '';

    const lines = reflections.map((r, i) => {
      const time = new Date(r.timestamp).toLocaleString();
      let desc = '';
      if (r.trigger === 'tool_error' && r.context.toolName) {
        desc = `工具 ${r.context.toolName} 执行失败`;
      } else if (r.trigger === 'user_feedback') {
        desc = `用户反馈不满意`;
      } else {
        desc = `任务执行失败`;
      }
      return `${i + 1}. [${desc}] ${r.lesson}${r.preventionStrategy ? ` → 预防：${r.preventionStrategy}` : ''}`;
    });

    return `【历史教训（请避免重复犯错）】\n${lines.join('\n')}`;
  }

  /**
   * 清空反思记录
   */
  public clear(): void {
    this.store.entries = [];
  }

  /**
   * 获取所有反思条目（用于调试或导出）
   */
  public getAllReflections(): ReflectionEntry[] {
    return [...this.store.entries];
  }

  /**
   * 导出为可读格式
   */
  public exportAsMarkdown(): string {
    if (this.store.entries.length === 0) {
      return '# Agent 反思记录\n\n（暂无记录）';
    }

    const lines = ['# Agent 反思记录\n'];
    
    for (const entry of this.store.entries) {
      const time = new Date(entry.timestamp).toLocaleString();
      lines.push(`## ${time}`);
      lines.push(`**触发**: ${entry.trigger}`);
      
      if (entry.context.toolName) {
        lines.push(`**工具**: ${entry.context.toolName}`);
      }
      if (entry.context.errorMessage) {
        lines.push(`**错误**: ${entry.context.errorMessage}`);
      }
      if (entry.context.userFeedback) {
        lines.push(`**用户反馈**: ${entry.context.userFeedback}`);
      }
      
      lines.push(`**反思**: ${entry.reflection}`);
      lines.push(`**教训**: ${entry.lesson}`);
      
      if (entry.preventionStrategy) {
        lines.push(`**预防策略**: ${entry.preventionStrategy}`);
      }
      
      lines.push('');
    }

    return lines.join('\n');
  }
}

// 单例实例（每个插件实例共享）
let reflectionManagerInstance: ReflectionManager | null = null;

export function getReflectionManager(): ReflectionManager {
  if (!reflectionManagerInstance) {
    reflectionManagerInstance = new ReflectionManager();
  }
  return reflectionManagerInstance;
}

export function resetReflectionManager(): void {
  if (reflectionManagerInstance) {
    reflectionManagerInstance.clear();
  }
  reflectionManagerInstance = null;
}
