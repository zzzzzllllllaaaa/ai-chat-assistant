/**
 * SkillRouter — 技能检测和路由
 * 
 * 检测 @skill 提及，加载技能，分类技能类型
 */
import type { SkillRegistry } from "../skills/SkillRegistry";
import type { Skill } from "../skills/types";
import type { SkillRoute } from "./types";

export class SkillRouter {
  private skillRegistry: SkillRegistry;

  constructor(skillRegistry: SkillRegistry) {
    this.skillRegistry = skillRegistry;
  }

  /**
   * 检测消息中的技能提及并返回路由信息
   */
  detect(message: string): SkillRoute | null {
    const skill = this.detectSkill(message);
    if (!skill) return null;

    const userQuery = this.stripMentions(message);
    return { skill, userQuery, type: 'general' };
  }

  /** 从消息中检测技能 */
  private detectSkill(message: string): Skill | null {
    // 匹配 @skill:"name" 或 @skill:name 或 @name
    const patterns = [
      /@skill:\s*"([^"]+)"/i,
      /@skill:\s*([^\s@]+)/i,
      /@([^\s@]+)/,
    ];

    for (const pattern of patterns) {
      const match = message.match(pattern);
      if (match) {
        const skillName = (match[1] || match[0].slice(1)).trim();
        // 查找匹配的技能
        const allSkills = this.skillRegistry.getAllSkills();
        const skill = allSkills.find(s =>
          s.name === skillName ||
          s.id === skillName ||
          s.name.toLowerCase() === skillName.toLowerCase()
        );
        if (!skill) {
          // 模糊匹配
          const fuzzy = allSkills.find(s =>
            s.name.toLowerCase().includes(skillName.toLowerCase()) ||
            s.id.toLowerCase().includes(skillName.toLowerCase())
          );
          if (fuzzy) return fuzzy;
        }
        if (skill) return skill;
      }
    }
    return null;
  }

  /** 剥离 @mention，保留用户实际查询 */
  private stripMentions(message: string): string {
    return message
      .replace(/@skill:\s*"[^"]*"/g, '')
      .replace(/@skill:\s*\S+/g, '')
      .replace(/@\S+/g, '')
      .trim();
  }

  /** 分类技能类型 */
  private classifySkill(skill: Skill): SkillRoute['type'] {
    const text = `${skill.id} ${skill.name} ${skill.description || ''} ${skill.systemPrompt || ''}`.toLowerCase();

    if (/search|搜索|web_fetch|web_search|websearch/i.test(text)) return 'search';
    if (/code|编程|开发|fullstack|full-stack|前端|后端|api/i.test(text)) return 'code';
    if (/writing|写作|翻译|周报|报告|文档|translate/i.test(text)) return 'writing';
    return 'general';
  }
}
