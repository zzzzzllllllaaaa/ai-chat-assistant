/**
 * Claw/OpenClaw Skills 格式解析器
 * 
 * 支持解析 SKILL.md 格式的技能文件:
 * - YAML frontmatter (name, description, metadata)
 * - Markdown 内容作为技能指令
 * - 可选的 _meta.json 和 config.json
 * - references/, scripts/, hooks/, assets/ 文件夹
 */

import { logger } from "../../core/logger";

/** Claw Skill 元数据 */
export interface ClawSkillMetadata {
  name: string;
  description: string;
  version?: string;
  author?: string;
  tags?: string[];
  [key: string]: any;
}

/** Claw Skill 配置 */
export interface ClawSkillConfig {
  enabled?: boolean;
  parameters?: Record<string, any>;
  [key: string]: any;
}

/** Claw Skill 完整定义 */
export interface ClawSkill {
  /** 从 YAML frontmatter 解析的元数据 */
  metadata: ClawSkillMetadata;
  /** Markdown 内容 (技能指令) */
  instructions: string;
  /** 可选的 _meta.json 内容 */
  meta?: {
    ownerId?: string;
    slug?: string;
    version?: string;
    publishedAt?: number;
  };
  /** 可选的 config.json 内容 */
  config?: ClawSkillConfig;
  /** 技能文件夹路径 */
  folderPath: string;
  /** 是否有 references 文件夹 */
  hasReferences: boolean;
  /** 是否有 scripts 文件夹 */
  hasScripts: boolean;
  /** 是否有 hooks 文件夹 */
  hasHooks: boolean;
  /** 是否有 assets 文件夹 */
  hasAssets: boolean;
}

export class ClawSkillParser {
  /**
   * 解析 SKILL.md 文件内容
   */
  static parseSkillMd(content: string): { metadata: ClawSkillMetadata; instructions: string } {
    // 检测 YAML frontmatter
    const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
    const match = content.match(frontmatterRegex);

    if (!match) {
      logger.warn("Skills", "SKILL.md 缺少 YAML frontmatter");
      return {
        metadata: {
          name: 'unknown',
          description: 'No description'
        },
        instructions: content
      };
    }

    const [, yamlContent, markdownContent] = match;

    // 解析 YAML frontmatter (简单实现)
    const metadata = this.parseYamlFrontmatter(yamlContent);
    
    return {
      metadata,
      instructions: markdownContent.trim()
    };
  }

  /**
   * 简单的 YAML frontmatter 解析器
   * 支持基本的 key: value 格式
   */
  private static parseYamlFrontmatter(yaml: string): ClawSkillMetadata {
    const metadata: ClawSkillMetadata = {
      name: 'unknown',
      description: 'No description'
    };

    const lines = yaml.split('\n');
    let currentKey: string | null = null;
    let currentValue: string = '';

    for (const line of lines) {
      const trimmed = line.trim();
      
      // 跳过空行和注释
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      // 检测 key: value 格式
      const keyValueMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
      
      if (keyValueMatch) {
        // 保存上一个键值对
        if (currentKey) {
          metadata[currentKey] = this.parseYamlValue(currentValue.trim());
        }

        currentKey = keyValueMatch[1];
        currentValue = keyValueMatch[2];
      } else if (currentKey) {
        // 多行值的延续
        currentValue += '\n' + trimmed;
      }
    }

    // 保存最后一个键值对
    if (currentKey) {
      metadata[currentKey] = this.parseYamlValue(currentValue.trim());
    }

    return metadata;
  }

  /**
   * 解析 YAML 值
   */
  private static parseYamlValue(value: string): any {
    // 移除引号
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1);
    }

    // 布尔值
    if (value === 'true') return true;
    if (value === 'false') return false;

    // 数字
    if (/^-?\d+(\.\d+)?$/.test(value)) {
      return parseFloat(value);
    }

    // 数组 (简单格式: [item1, item2])
    if (value.startsWith('[') && value.endsWith(']')) {
      const items = value.slice(1, -1).split(',').map(s => s.trim());
      return items.map(item => this.parseYamlValue(item));
    }

    // 默认返回字符串
    return value;
  }

  /**
   * 解析 _meta.json 文件
   */
  static parseMetaJson(content: string): ClawSkill['meta'] | null {
    try {
      return JSON.parse(content);
    } catch (e) {
      logger.error("Skills", "解析 _meta.json 失败", { error: e });
      return null;
    }
  }

  /**
   * 解析 config.json 文件
   */
  static parseConfigJson(content: string): ClawSkillConfig | null {
    try {
      return JSON.parse(content);
    } catch (e) {
      logger.error("Skills", "解析 config.json 失败", { error: e });
      return null;
    }
  }

  /**
   * 从 Markdown 内容中提取章节
   */
  static extractSections(markdown: string): Record<string, string> {
    const sections: Record<string, string> = {};
    const lines = markdown.split('\n');
    
    let currentSection: string | null = null;
    let currentContent: string[] = [];

    for (const line of lines) {
      // 检测标题 (# 或 ##)
      const headerMatch = line.match(/^(#{1,2})\s+(.+)$/);
      
      if (headerMatch) {
        // 保存上一个章节
        if (currentSection) {
          sections[currentSection] = currentContent.join('\n').trim();
        }

        currentSection = headerMatch[2].trim();
        currentContent = [];
      } else if (currentSection) {
        currentContent.push(line);
      }
    }

    // 保存最后一个章节
    if (currentSection) {
      sections[currentSection] = currentContent.join('\n').trim();
    }

    return sections;
  }

  /**
   * 从 Markdown 内容中提取代码块
   */
  static extractCodeBlocks(markdown: string): Array<{ language: string; code: string }> {
    const codeBlocks: Array<{ language: string; code: string }> = [];
    const regex = /```(\w+)?\n([\s\S]*?)```/g;
    
    let match;
    while ((match = regex.exec(markdown)) !== null) {
      codeBlocks.push({
        language: match[1] || 'text',
        code: match[2].trim()
      });
    }

    return codeBlocks;
  }

  /**
   * 验证 Claw Skill 的完整性
   */
  static validate(skill: ClawSkill): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!skill.metadata.name || skill.metadata.name === 'unknown') {
      errors.push("缺少技能名称 (name)");
    }

    if (!skill.metadata.description || skill.metadata.description === 'No description') {
      errors.push("缺少技能描述 (description)");
    }

    if (!skill.instructions || skill.instructions.length === 0) {
      errors.push("缺少技能指令 (Markdown 内容)");
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
}
