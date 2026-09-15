/**
 * IntentAnalyzer - 增强的意图分析与场景感知模块
 * 
 * 解决问题：
 * 1. 社交建议过于抽象 - 通过场景感知识别"轻松社交"场景
 * 2. 情感场景过度分析 - 识别"情感宣泄"场景，切换回应模式
 * 3. 跨时间段事件检索 - 识别时间连续性事件并扩展检索范围
 */

export interface IntentContext {
  /** 用户原始输入 */
  userInput: string;
  /** 当前日期 */
  currentDate: Date;
  /** 对话历史（可选，用于上下文理解） */
  conversationHistory?: Array<{ role: string; content: string }>;
}

export interface AnalyzedIntent {
  /** 场景类型 */
  sceneType: SceneType;
  /** 推荐的回应模式 */
  responseMode: ResponseMode;
  /** 时间意图分析结果 */
  timeIntent: TimeIntent | null;
  /** 置信度 0-1 */
  confidence: number;
  /** 分析原因 */
  reasoning: string;
  /** 建议的提示词修饰语 */
  promptModifier: string;
}

export type SceneType = 
  | 'emotional_venting'     // 情感宣泄
  | 'casual_social'         // 轻松社交建议
  | 'deep_discussion'       // 深度讨论
  | 'knowledge_retrieval'   // 知识检索
  | 'task_execution'        // 任务执行
  | 'general';              // 通用

export type ResponseMode = 
  | 'empathy'               // 共情模式：简短认同 + 情绪确认
  | 'practical'             // 实用模式：接地气、低门槛建议
  | 'analytical'            // 分析模式：结构化分析、步骤、方案
  | 'informational'         // 信息模式：直接给出答案
  | 'balanced';             // 平衡模式：综合考虑

export interface TimeIntent {
  /** 时间事件类型 */
  eventType: 'holiday' | 'trip' | 'project' | 'period' | 'single_day' | 'unknown';
  /** 是否为跨时间段事件 */
  isContinuousEvent: boolean;
  /** 推断的时间范围起点 */
  inferredStartDate: string | null;
  /** 推断的时间范围终点 */
  inferredEndDate: string | null;
  /** 目标年份 */
  targetYear: number | null;
  /** 扩展检索的月份列表 */
  expandedMonths: string[];
  /** 关键词 */
  keywords: string[];
}

export class IntentAnalyzer {
  
  /**
   * 分析用户意图，返回场景类型和推荐回应模式
   */
  public analyze(ctx: IntentContext): AnalyzedIntent {
    const { userInput, currentDate } = ctx;
    
    // 1. 检测场景类型
    const sceneType = this.detectSceneType(userInput);
    
    // 2. 确定回应模式
    const responseMode = this.determineResponseMode(sceneType, userInput);
    
    // 3. 分析时间意图
    const timeIntent = this.analyzeTimeIntent(userInput, currentDate);
    
    // 4. 生成提示词修饰语
    const promptModifier = this.generatePromptModifier(sceneType, responseMode);
    
    // 5. 计算置信度
    const confidence = this.calculateConfidence(sceneType, userInput);
    
    return {
      sceneType,
      responseMode,
      timeIntent,
      confidence,
      reasoning: this.generateReasoning(sceneType, responseMode, timeIntent),
      promptModifier
    };
  }

  /**
   * 检测场景类型
   */
  private detectSceneType(input: string): SceneType {
    const lowerInput = input.toLowerCase();
    
    // 情感宣泄场景检测
    const emotionalPatterns = [
      /真他妈|他妈的|靠|操|艹|我?[很太]?(烦|累|难受|郁闷|崩溃|无语|生气|愤怒|后悔)/,
      /白花了|白费了|被骗了|亏了|浪费/,
      /怎么会这样|为什么会|太气了|气死|受不了/,
      /[!！]{2,}|[?？]{2,}/,  // 连续感叹/问号
      /唉|哎|呜|呵呵|…{3,}/,   // 叹气、无奈
    ];
    if (emotionalPatterns.some(p => p.test(input))) {
      return 'emotional_venting';
    }

    // 轻松社交场景检测
    const socialPatterns = [
      /和?(女生|妹子|女孩|小姐姐|她|他|朋友|同事).*(聊|说|交流|相处)/,
      /聊天.*话题|话题.*聊天|没(什么|啥)?(可)?聊|聊(什么|啥)|怎么聊/,
      /怎么(开口|搭讪|追|约|撩)|如何.*社交/,
      /语音房|群聊|微信|QQ/,
    ];
    if (socialPatterns.some(p => p.test(input))) {
      return 'casual_social';
    }

    // 知识检索场景检测
    const retrievalPatterns = [
      /多少天|什么时候|几号|哪天|几月|去年|今年|上个月|上周/,
      /(帮我|请)?[找查搜检]|检索|列出|汇总|统计|回忆/,
      /笔记|记录|文件|日记|内容|梦|想法/,
      /有没有.*记录|记得.*吗/,
    ];
    if (retrievalPatterns.some(p => p.test(input))) {
      return 'knowledge_retrieval';
    }

    // 深度讨论场景检测
    const deepPatterns = [
      /为什么|本质|原理|机制|逻辑|框架|理论|哲学|思考/,
      /分析一下|深入探讨|详细解释|系统性/,
      /权力|博弈|策略|算法|模型/,
    ];
    if (deepPatterns.some(p => p.test(input))) {
      return 'deep_discussion';
    }

    // 任务执行场景检测
    const taskPatterns = [
      /帮我(创建|修改|删除|整理|写|生成|翻译|总结)/,
      /把.*改成|将.*变成|转换/,
    ];
    if (taskPatterns.some(p => p.test(input))) {
      return 'task_execution';
    }

    return 'general';
  }

  /**
   * 根据场景类型确定回应模式
   */
  private determineResponseMode(sceneType: SceneType, input: string): ResponseMode {
    switch (sceneType) {
      case 'emotional_venting':
        return 'empathy';
      case 'casual_social':
        return 'practical';
      case 'knowledge_retrieval':
        return 'informational';
      case 'deep_discussion':
        return 'analytical';
      case 'task_execution':
        return 'balanced';
      default:
        return 'balanced';
    }
  }

  /**
   * 分析时间意图，识别跨时间段事件
   */
  private analyzeTimeIntent(input: string, currentDate: Date): TimeIntent | null {
    const currentYear = currentDate.getFullYear();
    
    // 时间关键词检测
    const yearPatterns = [
      { pattern: /去年|上一年|last\s*year/i, yearOffset: -1 },
      { pattern: /今年|this\s*year/i, yearOffset: 0 },
      { pattern: /前年|two\s*years?\s*ago/i, yearOffset: -2 },
      { pattern: /(\d{4})年/i, extractYear: true },
    ];

    let targetYear: number | null = null;
    
    for (const yp of yearPatterns) {
      if (yp.extractYear) {
        const match = input.match(yp.pattern);
        if (match) {
          targetYear = parseInt(match[1]);
          break;
        }
      } else if (yp.pattern.test(input)) {
        targetYear = currentYear + (yp.yearOffset ?? 0);
        break;
      }
    }

    // 跨时间段事件检测
    const continuousEventPatterns = [
      { pattern: /过年|春节|年假|放假|假期|休假/, eventType: 'holiday' as const, expandMonths: ['01', '02'] },
      { pattern: /出差|出行|旅[行游]|度假/, eventType: 'trip' as const, expandMonths: [] },
      { pattern: /项目|工程|任务|周期/, eventType: 'project' as const, expandMonths: [] },
      { pattern: /那段时间|那个时期|那几[天周月]/, eventType: 'period' as const, expandMonths: [] },
    ];

    for (const ep of continuousEventPatterns) {
      if (ep.pattern.test(input)) {
        // 计算扩展月份
        let expandedMonths: string[] = [];
        if (targetYear && ep.expandMonths.length > 0) {
          expandedMonths = ep.expandMonths.map(m => `${targetYear}-${m}`);
        } else if (targetYear && ep.eventType === 'holiday') {
          // 春节/过年默认跨1-2月
          expandedMonths = [`${targetYear}-01`, `${targetYear}-02`];
        }

        // 提取关键词用于检索
        const keywords = this.extractTimeKeywords(input);

        return {
          eventType: ep.eventType,
          isContinuousEvent: true,
          inferredStartDate: null,
          inferredEndDate: null,
          targetYear,
          expandedMonths,
          keywords
        };
      }
    }

    // 单日事件检测
    const singleDayPattern = /(\d{1,2})月(\d{1,2})[日号]|(\d{1,2})[\/\-](\d{1,2})/;
    if (singleDayPattern.test(input)) {
      return {
        eventType: 'single_day',
        isContinuousEvent: false,
        inferredStartDate: null,
        inferredEndDate: null,
        targetYear,
        expandedMonths: [],
        keywords: this.extractTimeKeywords(input)
      };
    }

    // 如果有年份但没有明确事件类型
    if (targetYear) {
      return {
        eventType: 'unknown',
        isContinuousEvent: false,
        inferredStartDate: null,
        inferredEndDate: null,
        targetYear,
        expandedMonths: [],
        keywords: this.extractTimeKeywords(input)
      };
    }

    return null;
  }

  /**
   * 提取时间相关关键词
   */
  private extractTimeKeywords(input: string): string[] {
    const keywords: string[] = [];
    
    // 提取时间事件词
    const eventWords = input.match(/放假|假期|休假|过年|春节|出差|旅行|开工|回厂|回家|离开/g);
    if (eventWords) keywords.push(...eventWords);
    
    // 提取月份
    const monthMatch = input.match(/(\d{1,2})月/g);
    if (monthMatch) keywords.push(...monthMatch);
    
    // 提取日期
    const dateMatch = input.match(/(\d{1,2})[日号]/g);
    if (dateMatch) keywords.push(...dateMatch);
    
    return [...new Set(keywords)];
  }

  /**
   * 生成提示词修饰语
   */
  private generatePromptModifier(sceneType: SceneType, responseMode: ResponseMode): string {
    const modifiers: Record<SceneType, string> = {
      emotional_venting: `
【回应模式：共情优先】
- 用户正在宣泄情绪，不要急于给出解决方案
- 先简短认同用户的感受，表达理解
- 不要过度分析或追问原因
- 可以简单询问是否需要进一步帮助，但不强求
- 示例回应风格："确实太亏了，花了钱问题还没解决，换谁都会气。"`,

      casual_social: `
【回应模式：实用接地气】
- 用户需要的是轻松、可直接使用的社交建议
- 禁止给出抽象的理论框架（如"权力的本质"、"叙事能力"等）
- 建议必须是具体的、低门槛的、日常化的
- 话题示例应该简单有趣，如观察到的有趣画面、流行梗、共同经历
- 避免任何"升华话题"的建议
- 回应风格要像朋友之间的闲聊建议，不是课堂讲授`,

      knowledge_retrieval: `
【回应模式：精准信息】
- 直接给出答案，不做过多延伸
- 注意时间连续性：假期、项目等可能跨越多个月份
- 如果发现检索结果不完整，主动扩展检索范围
- 明确区分不同年份的数据，避免跨年混淆
- 如果无法确定，诚实说明并询问用户澄清`,

      deep_discussion: `
【回应模式：深度分析】
- 可以展开理论框架和深层逻辑
- 结构化呈现分析过程
- 引用相关的认知框架和笔记内容`,

      task_execution: `
【回应模式：高效执行】
- 确认理解任务后直接执行
- 简洁汇报结果`,

      general: ``
    };

    return modifiers[sceneType] || '';
  }

  /**
   * 计算置信度
   */
  private calculateConfidence(sceneType: SceneType, input: string): number {
    // 基础置信度
    let confidence = 0.6;
    
    // 根据匹配强度调整
    if (sceneType !== 'general') {
      confidence += 0.2;
    }
    
    // 输入长度影响（过短可能不确定）
    if (input.length < 10) {
      confidence -= 0.1;
    } else if (input.length > 50) {
      confidence += 0.1;
    }
    
    return Math.min(1, Math.max(0, confidence));
  }

  /**
   * 生成分析原因说明
   */
  private generateReasoning(sceneType: SceneType, responseMode: ResponseMode, timeIntent: TimeIntent | null): string {
    const sceneNames: Record<SceneType, string> = {
      emotional_venting: '情感宣泄',
      casual_social: '轻松社交',
      knowledge_retrieval: '知识检索',
      deep_discussion: '深度讨论',
      task_execution: '任务执行',
      general: '通用对话'
    };

    const modeNames: Record<ResponseMode, string> = {
      empathy: '共情',
      practical: '实用',
      analytical: '分析',
      informational: '信息',
      balanced: '平衡'
    };

    let reasoning = `场景：${sceneNames[sceneType]}，回应模式：${modeNames[responseMode]}`;
    
    if (timeIntent) {
      reasoning += `，时间意图：${timeIntent.eventType}`;
      if (timeIntent.isContinuousEvent) {
        reasoning += '（跨时间段事件）';
      }
      if (timeIntent.expandedMonths.length > 0) {
        reasoning += `，扩展检索：${timeIntent.expandedMonths.join(', ')}`;
      }
    }
    
    return reasoning;
  }

  /**
   * 生成针对跨时间段事件的检索建议
   */
  public generateExpandedSearchQueries(timeIntent: TimeIntent, baseQuery: string): string[] {
    if (!timeIntent.isContinuousEvent || timeIntent.expandedMonths.length === 0) {
      return [baseQuery];
    }

    const queries: string[] = [baseQuery];
    
    // 为每个扩展月份生成查询
    for (const month of timeIntent.expandedMonths) {
      queries.push(`${month} ${timeIntent.keywords.join(' ')}`);
    }
    
    // 添加事件边界关键词查询
    const boundaryKeywords = ['开始', '结束', '回来', '离开', '开工', '放假'];
    for (const kw of boundaryKeywords) {
      if (timeIntent.keywords.some(k => k.includes(kw))) {
        continue; // 避免重复
      }
      queries.push(`${timeIntent.targetYear || ''} ${kw}`);
    }
    
    return [...new Set(queries)];
  }
}

// 导出单例
export const intentAnalyzer = new IntentAnalyzer();
