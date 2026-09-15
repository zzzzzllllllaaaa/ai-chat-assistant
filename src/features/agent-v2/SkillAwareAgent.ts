/**
 * SkillAwareAgent — Skill 优先的 Agent 主类
 * 
 * 处理流程:
 * 1. 检测 @skill 提及 → SkillRouter
 * 2. 搜索类技能 → 直接调用 web_search 工具
 * 3. 其他技能 → 加载 SKILL.md 系统指令 + 带工具 LLM 调用
 * 4. 无技能 → 带工具 LLM 调用
 */
import type { App } from "obsidian";
import type { ChatMessage } from "../../core/types";
import type { IPluginContext } from "../../core/plugin-context";
import type { Tool } from "../agent/types";
import { ToolEquippedLLM } from "./ToolEquippedLLM";
import { SkillRouter } from "./SkillRouter";
import type { AgentV2Options, AgentV2Result, SkillRoute } from "./types";
import { logger } from "../../core/logger";

export class SkillAwareAgent {
  private ctx: IPluginContext;
  private app: App;
  private llm: ToolEquippedLLM;
  private router: SkillRouter;
  private tools: Tool[];

  constructor(ctx: IPluginContext, tools?: Tool[]) {
    this.ctx = ctx;
    this.app = ctx.app;
    this.router = new SkillRouter(ctx.skillRegistry);
    this.tools = tools || this.getAllTools();
    this.llm = new ToolEquippedLLM(ctx.llmService, ctx.app, this.tools);
    
    // 调试: 输出可用工具
    const toolNames = this.tools.map(t => t.definition.name);
    logger.info("AI", `AgentV2 初始化: ${toolNames.length} 个工具`, { tools: toolNames });
    console.log('[AgentV2] 可用工具:', toolNames);
  }

  /** 获取所有可用工具 */
  private getAllTools(): Tool[] {
    const names = this.ctx.agentManager.getAllToolNames();
    return names
      .map(name => this.ctx.agentManager.getTool(name))
      .filter((t): t is Tool => !!t);
  }

  /**
   * 处理用户消息
   */
  async process(
    messages: ChatMessage[],
    model: string,
    opts: AgentV2Options = {}
  ): Promise<AgentV2Result> {
    const startTime = Date.now();
    const toolCalls: AgentV2Result['toolCalls'] = [];
    
    // 获取最后一条用户消息
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    if (!lastUserMsg) {
      return { content: '', success: true, toolCalls: [] };
    }

    const userMessage = lastUserMsg.content || '';

    // 1. 检测技能
    const route = this.router.detect(userMessage);

    if (route) {
      logger.info("AI", `检测到技能: ${route.skill.name}`);

      // 技能有搜索 URL 模板 → 用 web_search（有反爬处理）替代裸 fetch
      const searchUrls = this.extractSearchUrls(route.skill);
      if (searchUrls.length > 0 && route.userQuery) {
        return await this.executeSkillSearch(route, model);
      }

      // 其他技能：注入 system prompt
      return await this.handleSkillWithTools(route, messages, model, opts);
    }

    // 无技能：带工具 LLM 正常对话
    return await this.handleNormalChat(messages, model, opts);
  }

  /** 从技能 systemPrompt 中提取搜索 URL 模板 */
  private extractSearchUrls(skill: import("../skills/types").Skill): Array<{ engine: string; url: string }> {
    const text = skill.systemPrompt || '';
    const urls: Array<{ engine: string; url: string }> = [];
    
    // 匹配 Markdown 中的搜索 URL 模式: **引擎名**: `https://...?q={keyword}` 或 `...?wd={keyword}`
    const patterns = [
      // Bold engine name + code URL
      /\*\*([^*]+)\*\*:\s*`(https?:\/\/[^`]*\{keyword\}[^`]*)`/g,
      // Also match URL in regular text: engine: URL
      /[-*]\s*\*\*([^*]+)\*\*:\s*`(https?:\/\/[^`]+)`/g,
      // Simple URL with keyword placeholder
      /`(https?:\/\/[^`]*\{keyword\}[^`]*)`/g,
    ];
    
    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        const engine = (match[1] || 'search').trim();
        // If match[1] looks like a URL, use it as URL
        const url = match[1]?.startsWith('http') ? match[1] : (match[2] || match[1]);
        if (url?.startsWith('http') && !urls.some(u => u.url === url)) {
          urls.push({ engine, url });
        }
      }
    }
    
    logger.info("AI", `提取到 ${urls.length} 个搜索 URL 模板`, { urls: urls.map(u => u.engine) });
    return urls;
  }
  
  /** 搜索技能：用 web_search (有反爬/UA轮换/重试) + LLM 提炼 */
  private async executeSkillSearch(
    route: SkillRoute,
    model: string
  ): Promise<AgentV2Result> {
    const webSearch = this.tools.find(t => t.definition.name === 'web_search');
    if (!webSearch) {
      return { content: '错误: web_search 工具不可用', success: false, error: 'no web_search', toolCalls: [] };
    }

    const userQuery = route.userQuery;
    
    // 清理搜索词：去除 meta 指令词，保留核心关键词
    const cleanQuery = userQuery
      .replace(/搜索|查找|帮我|请|附上原文链接|附上链接|原文链接/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const searchQuery = cleanQuery || userQuery;
    
    const timeRange = /近一周|近7天|本周/i.test(userQuery) ? 'week'
      : /今天|今日/i.test(userQuery) ? 'day'
      : /近一月/i.test(userQuery) ? 'month' : 'all';

    try {
      // 用插件自带的 web_search（带反爬/重试/UA轮换）
      const rawResults = await webSearch.execute({ query: searchQuery, count: 10, time_range: timeRange }, this.app);
      
      // 让 LLM 按技能风格提炼结果
      const summaryPrompt: ChatMessage = {
        role: 'user',
        content: `你是一个搜索结果整理助手。以下是搜索"${userQuery}"的原始结果，请按技能要求整理。

技能: ${route.skill.name}
要求: ${route.skill.description || '提取新闻标题和原文链接'}

原始搜索结果:
${rawResults.slice(0, 4000)}

请整理为干净的列表格式:
**标题** - 来源
链接: URL
摘要: 简要描述(1-2句)`
      };
      
      const summary = await this.ctx.llmService.getCompletion([summaryPrompt], model);
      
      return {
        content: `🔍 **${route.skill.name}** · ${timeRange === 'all' ? '综合' : timeRange}:\n\n${summary.content || rawResults.slice(0, 2000)}`,
        success: true,
        toolCalls: [{ name: 'web_search', args: { query: userQuery, time_range: timeRange }, result: rawResults.slice(0, 500), success: true }],
      };
    } catch (e: any) {
      return { content: `搜索失败: ${e.message}`, success: false, error: e.message, toolCalls: [] };
    }
  }

  /** 注入 system prompt → 带工具 LLM */
  private async handleSkillWithTools(
    route: SkillRoute,
    messages: ChatMessage[],
    model: string,
    opts: AgentV2Options
  ): Promise<AgentV2Result> {
    const skill = route.skill;
    
    // 构建技能系统指令 — 告诉 LLM 严格按技能指令使用工具
    const toolHint = this.tools.some(t => t.definition.name === 'read_webpage')
      ? '\n提示: 你可以使用 read_webpage 工具来获取网页内容（对应技能指令中的 web_fetch）。'
      : '';
    
    const skillSystemMsg: ChatMessage = {
      role: 'system',
      content: `[⚡ 正在执行技能: ${skill.name}]

严格遵循以下技能指令完成任务。技能指令中的工具名可能与你实际可用的工具名不同（如 web_fetch → read_webpage），请根据功能匹配使用。${toolHint}

---
${skill.systemPrompt || skill.description || ''}
---

[用户输入]
${route.userQuery || '执行上述技能'}

请直接开始执行，不要描述你要做什么。`,
    };

    // 清理用户消息，直接作为用户输入
    const cleanMessages = messages.map(m => {
      if (m.role === 'user') {
        return {
          ...m,
          content: route.userQuery || m.content,
        };
      }
      return m;
    });

    // 将系统指令插入到消息列表开头
    const fullMessages: ChatMessage[] = [skillSystemMsg, ...cleanMessages];

    try {
      const content = await this.llm.chat(fullMessages, model, opts);
      return {
        content,
        success: true,
        toolCalls: [],
      };
    } catch (e: any) {
      return {
        content: `技能执行失败: ${e.message}`,
        success: false,
        error: e.message,
        toolCalls: [],
      };
    }
  }

  /** 无技能：带工具正常对话 */
  private async handleNormalChat(
    messages: ChatMessage[],
    model: string,
    opts: AgentV2Options
  ): Promise<AgentV2Result> {
    try {
      const content = await this.llm.chat(messages, model, opts);
      return {
        content,
        success: true,
        toolCalls: [],
      };
    } catch (e: any) {
      return {
        content: `对话出错: ${e.message}`,
        success: false,
        error: e.message,
        toolCalls: [],
      };
    }
  }
}
