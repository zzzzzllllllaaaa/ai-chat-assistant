import { logger } from "../../core/logger";
import type { Skill, SkillTrigger } from "./types";

/**
 * 技能匹配器 - 根据用户输入动态匹配相关技能
 */
export class SkillMatcher {

  /**
   * 根据用户输入匹配相关技能
   * @param userInput 用户输入
   * @param skills 所有可用技能
   * @param maxMatches 最大匹配数量（默认 2）
   * @returns 匹配的技能列表，按相关度排序
   */
  public matchSkills(userInput: string, skills: Skill[], maxMatches: number = 2): Skill[] {
    if (!userInput || skills.length === 0) {
      return [];
    }

    const normalizedInput = userInput.toLowerCase().trim();
    const matches: Array<{ skill: Skill; score: number }> = [];

    for (const skill of skills) {
      const score = this.calculateMatchScore(normalizedInput, skill);
      if (score > 0) {
        matches.push({ skill, score });
      }
    }

    // 按分数降序排序，取前 N 个
    matches.sort((a, b) => b.score - a.score);
    const topMatches = matches.slice(0, maxMatches);

    if (topMatches.length > 0) {
      logger.info(
        "Skills",
        `Matched ${topMatches.length} skills for input: "${userInput.substring(0, 50)}..."`,
        topMatches.map(m => `${m.skill.name} (score: ${m.score})`)
      );
    }

    return topMatches.map(m => m.skill);
  }

  /**
   * 计算技能与用户输入的匹配分数
   * @param normalizedInput 标准化的用户输入（小写）
   * @param skill 技能
   * @returns 匹配分数（0-100）
   */
  private calculateMatchScore(normalizedInput: string, skill: Skill): number {
    let score = 0;

    // 1. 检查触发器匹配（权重最高）
    if (skill.triggers && skill.triggers.length > 0) {
      for (const trigger of skill.triggers) {
        const triggerScore = this.matchTrigger(normalizedInput, trigger);
        score = Math.max(score, triggerScore);
      }
    }

    // 2. 检查技能名称匹配
    const nameScore = this.matchText(normalizedInput, skill.name);
    score = Math.max(score, nameScore * 0.6); // 名称匹配权重 60%

    // 3. 检查描述匹配
    if (skill.description) {
      const descScore = this.matchText(normalizedInput, skill.description);
      score = Math.max(score, descScore * 0.3); // 描述匹配权重 30%
    }

    // 4. 检查标签匹配
    if (skill.tags && skill.tags.length > 0) {
      for (const tag of skill.tags) {
        const tagScore = this.matchText(normalizedInput, tag);
        score = Math.max(score, tagScore * 0.4); // 标签匹配权重 40%
      }
    }

    return Math.round(score);
  }

  /**
   * 匹配触发器
   */
  private matchTrigger(normalizedInput: string, trigger: SkillTrigger): number {
    if (trigger.type === "command") {
      // 命令触发器：精确匹配
      for (const cmd of trigger.value) {
        if (normalizedInput.startsWith(cmd.toLowerCase())) {
          return 100; // 命令匹配得分最高
        }
      }
    } else if (trigger.type === "keyword") {
      // 关键词触发器：包含匹配
      let maxScore = 0;
      for (const keyword of trigger.value) {
        const keywordLower = keyword.toLowerCase();
        if (normalizedInput.includes(keywordLower)) {
          // 根据关键词长度和位置计算分数
          const lengthBonus = Math.min(keyword.length / 10, 1) * 20; // 长关键词加分
          const positionBonus = normalizedInput.indexOf(keywordLower) === 0 ? 20 : 0; // 开头位置加分
          const score = 60 + lengthBonus + positionBonus;
          maxScore = Math.max(maxScore, score);
        }
      }
      return maxScore;
    }

    return 0;
  }

  /**
   * 文本匹配（模糊匹配）
   */
  private matchText(input: string, text: string): number {
    const textLower = text.toLowerCase();
    
    // 完全包含
    if (input.includes(textLower) || textLower.includes(input)) {
      return 50;
    }

    // 分词匹配
    const inputWords = input.split(/\s+/);
    const textWords = textLower.split(/\s+/);
    let matchCount = 0;

    for (const inputWord of inputWords) {
      if (inputWord.length < 2) continue; // 忽略太短的词
      for (const textWord of textWords) {
        if (textWord.includes(inputWord) || inputWord.includes(textWord)) {
          matchCount++;
          break;
        }
      }
    }

    if (matchCount > 0) {
      return Math.min((matchCount / Math.max(inputWords.length, textWords.length)) * 40, 40);
    }

    return 0;
  }

  /**
   * 检查技能是否应该被注入到 Agent 的 system prompt
   * @param skill 技能
   * @returns 是否应该注入
   */
  public shouldInjectSkill(skill: Skill): boolean {
    // 只注入有 systemPrompt 的技能
    if (!skill.systemPrompt || skill.systemPrompt.trim().length === 0) {
      return false;
    }

    // 可以在这里添加更多过滤条件，比如：
    // - 技能是否启用
    // - 技能大小是否超过限制
    // - 技能是否标记为"仅命令触发"

    return true;
  }

  /**
   * 格式化技能的 systemPrompt 用于注入
   * @param skill 技能
   * @returns 格式化后的 prompt
   */
  public formatSkillPrompt(skill: Skill): string {
    if (!skill.systemPrompt) {
      return "";
    }

    // 添加技能标识，方便调试
    return `\n\n# Skill: ${skill.name}\n${skill.systemPrompt.trim()}\n`;
  }
}
