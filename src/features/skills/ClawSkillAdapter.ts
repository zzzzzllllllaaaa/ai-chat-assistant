/**
 * Claw Skill 适配器
 * 将 Claw 格式的技能转换为内部 Skill 对象
 */

import type { Skill, SkillStep, SkillTrigger } from "./types";
import type { ClawSkill } from "./ClawSkillParser";
import { logger } from "../../core/logger";

export class ClawSkillAdapter {
  /**
   * 将 Claw Skill 转换为内部 Skill 格式
   */
  static convertToInternalFormat(clawSkill: ClawSkill): Skill {
    const metadata = clawSkill.metadata;
    
    // 生成技能 ID
    const id = this.generateSkillId(metadata.name, clawSkill.meta?.slug);
    
    // 提取版本信息
    const version = clawSkill.meta?.version || metadata.version || '1.0.0';
    
    // 提取作者信息
    const author = metadata.author || clawSkill.meta?.ownerId || 'Unknown';
    
    // 提取标签
    const tags = metadata.tags || [];
    
    // 转换为内部格式
    const skill: Skill = {
      id,
      name: metadata.name,
      description: metadata.description,
      version,
      author,
      source: 'community', // Claw 技能来自社区
      sourceUrl: clawSkill.folderPath,
      icon: metadata.icon || '🔧',
      tags: Array.isArray(tags) ? tags : [],
      
      // Claw 技能使用 Markdown 指令,转换为单个 LLM 步骤
      steps: this.convertInstructionsToSteps(clawSkill.instructions, clawSkill),
      
      // 从描述中提取触发器
      triggers: this.extractTriggersFromDescription(metadata.description),
      
      // 检测所需工具
      requiredTools: this.detectRequiredTools(clawSkill.instructions),
      
      // 使用 Markdown 内容作为系统提示词
      systemPrompt: this.buildSystemPrompt(clawSkill),
      
      enabled: clawSkill.config?.enabled !== false, // 默认启用
      
      updatedAt: clawSkill.meta?.publishedAt || Date.now()
    };
    
    logger.info("Skills", `Claw Skill 转换完成: ${skill.name}`, { 
      id: skill.id, 
      version: skill.version,
      stepsCount: skill.steps.length 
    });
    
    return skill;
  }

  /**
   * 生成技能 ID
   */
  private static generateSkillId(name: string, slug?: string): string {
    if (slug) {
      return `claw:${slug}`;
    }
    
    // 从名称生成 slug
    const generatedSlug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    
    return `claw:${generatedSlug}`;
  }

  /**
   * 将 Markdown 指令转换为执行步骤
   * Claw 技能主要通过 Markdown 内容注入到 LLM 上下文中
   */
  private static convertInstructionsToSteps(instructions: string, clawSkill: ClawSkill): SkillStep[] {
    const steps: SkillStep[] = [];
    
    // 如果有 scripts 文件夹,添加脚本执行步骤
    if (clawSkill.hasScripts) {
      steps.push({
        id: 'scripts',
        name: '执行技能脚本',
        type: 'script',
        description: '执行技能提供的脚本文件',
        outputKey: 'scriptResult'
      });
    }
    
    // 主步骤: 将 Markdown 指令作为系统提示词注入
    steps.push({
      id: 'main',
      name: '执行技能指令',
      type: 'llm',
      description: '根据技能指令处理用户请求',
      prompt: this.buildPromptTemplate(instructions, clawSkill),
      outputKey: 'result'
    });
    
    // 如果有 scripts 文件夹,添加脚本执行步骤
    if (clawSkill.hasScripts) {
      steps.push({
        id: 'execute_scripts',
        name: '执行技能脚本',
        type: 'tool',
        description: '执行技能附带的脚本',
        toolName: 'execute_skill_script',
        toolArgs: {
          skillPath: clawSkill.folderPath
        },
        optional: true, // 脚本执行是可选的
        dependsOn: ['main']
      });
    }
    
    return steps;
  }

  /**
   * 构建提示词模板
   */
  private static buildPromptTemplate(instructions: string, clawSkill: ClawSkill): string {
    let prompt = instructions;
    
    // 如果有 references 文件夹,添加引用说明
    if (clawSkill.hasReferences) {
      prompt += `\n\n## 参考资料\n\n技能包含参考资料,位于: ${clawSkill.folderPath}/references/\n`;
    }
    
    // 添加用户输入占位符
    prompt += `\n\n## 用户请求\n\n{{userInput}}`;
    
    return prompt;
  }

  /**
   * 构建系统提示词
   */
  private static buildSystemPrompt(clawSkill: ClawSkill): string {
    let systemPrompt = `# ${clawSkill.metadata.name}\n\n`;
    systemPrompt += `${clawSkill.metadata.description}\n\n`;
    systemPrompt += `---\n\n`;
    systemPrompt += clawSkill.instructions;
    
    return systemPrompt;
  }

  /**
   * 从描述中提取触发器
   * Claw 技能通常在描述中说明使用场景
   */
  private static extractTriggersFromDescription(description: string): SkillTrigger[] {
    const triggers: SkillTrigger[] = [];
    
    // 提取 "Use when:" 后面的关键词
    const useWhenMatch = description.match(/Use when[:\s]+(.+?)(?:\.|$)/i);
    if (useWhenMatch) {
      const scenarios = useWhenMatch[1].split(/[,;]/).map(s => s.trim());
      
      for (const scenario of scenarios) {
        // 提取括号中的数字标记 (1), (2) 等
        const cleanScenario = scenario.replace(/^\(\d+\)\s*/, '').trim();
        
        if (cleanScenario) {
          triggers.push({
            type: 'keyword',
            value: this.extractKeywords(cleanScenario)
          });
        }
      }
    }
    
    return triggers;
  }

  /**
   * 从场景描述中提取关键词
   */
  private static extractKeywords(scenario: string): string[] {
    const keywords: string[] = [];
    
    // 提取引号中的关键词
    const quotedMatches = scenario.match(/'([^']+)'|"([^"]+)"/g);
    if (quotedMatches) {
      keywords.push(...quotedMatches.map(m => m.replace(/['"]/g, '')));
    }
    
    // 提取重要动词和名词
    const words = scenario.toLowerCase().split(/\s+/);
    const importantWords = words.filter(w => 
      w.length > 4 && 
      !['when', 'that', 'this', 'with', 'from', 'about'].includes(w)
    );
    
    keywords.push(...importantWords);
    
    return [...new Set(keywords)]; // 去重
  }

  /**
   * 检测指令中提到的工具
   */
  private static detectRequiredTools(instructions: string): string[] {
    const tools: Set<string> = new Set();
    
    // 常见工具关键词映射
    const toolKeywords: Record<string, string[]> = {
      'read_file': ['read file', 'read files', 'file content'],
      'write_file': ['write file', 'create file', 'save file'],
      'list_files': ['list files', 'list directory', 'scan folder'],
      'web_search': ['search', 'web search', 'google', 'bing'],
      'execute_command': ['run command', 'execute', 'shell', 'terminal'],
      'git': ['git', 'commit', 'push', 'pull', 'branch']
    };
    
    const lowerInstructions = instructions.toLowerCase();
    
    for (const [tool, keywords] of Object.entries(toolKeywords)) {
      if (keywords.some(keyword => lowerInstructions.includes(keyword))) {
        tools.add(tool);
      }
    }
    
    return Array.from(tools);
  }

  /**
   * 从内部格式转换回 Claw 格式 (用于导出)
   */
  static convertToClawFormat(skill: Skill): ClawSkill {
    // 提取 Markdown 指令
    const instructions = skill.systemPrompt || skill.steps[0]?.prompt || '';
    
    // 构建元数据
    const metadata: any = {
      name: skill.name,
      description: skill.description,
      version: skill.version,
      author: skill.author,
      tags: skill.tags
    };
    
    if (skill.icon) {
      metadata.icon = skill.icon;
    }
    
    return {
      metadata,
      instructions,
      folderPath: skill.sourceUrl || '',
      hasReferences: false,
      hasScripts: false,
      hasHooks: false,
      hasAssets: false
    };
  }
}
