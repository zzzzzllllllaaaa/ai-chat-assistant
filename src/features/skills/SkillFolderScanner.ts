/**
 * SkillFolderScanner - 技能文件夹扫描器
 * 
 * 负责：
 * 1. 扫描用户笔记库中的技能文件夹
 * 2. 解析技能包（支持多文件结构）
 * 3. 加载技能配置和资源文件
 * 4. 监听文件变化，支持热重载
 */

import { App, TFolder, TFile, normalizePath, Platform } from "obsidian";
import { logger } from "../../core/logger";
import { Skill, SkillTrigger } from "./types";
import { ClawSkillParser, ClawSkill } from "./ClawSkillParser";
import { ClawSkillAdapter } from "./ClawSkillAdapter";

// 类型导入（编译时，不会在运行时加载）
import type { ClawSkillExecutor as ClawSkillExecutorType } from "./ClawSkillExecutor";

// 值导入（运行时，条件加载）
let ClawSkillExecutor: typeof ClawSkillExecutorType | undefined;
if (!Platform.isMobile) {
  ClawSkillExecutor = require("./ClawSkillExecutor").ClawSkillExecutor;
}

export interface SkillPackage {
  /** 技能配置 */
  skill: Skill;
  /** 技能文件夹路径 */
  folderPath: string;
  /** 配置文件路径 */
  configPath: string;
  /** 资源文件映射 */
  resources: Map<string, string>;
  /** Claw Skills 执行器 (如果是 Claw 格式) */
  executor?: ClawSkillExecutorType;
}

export class SkillFolderScanner {
  private app: App;
  private skillFolderPath: string;
  
  constructor(app: App, skillFolderPath: string = "Skills") {
    this.app = app;
    this.skillFolderPath = normalizePath(skillFolderPath);
  }
  
  /**
   * 设置技能文件夹路径
   */
  public setSkillFolderPath(path: string): void {
    this.skillFolderPath = normalizePath(path);
  }
  
  /**
   * 扫描技能文件夹，加载所有技能
   */
  public async scanSkills(): Promise<SkillPackage[]> {
    const packages: SkillPackage[] = [];
    
    // 检查技能文件夹是否存在
    const folder = this.app.vault.getAbstractFileByPath(this.skillFolderPath);
    if (!(folder instanceof TFolder)) {
      logger.warn("Skills", `Skills folder not found: ${this.skillFolderPath}`);
      return packages;
    }
    
    // 遍历子文件夹
    for (const child of folder.children) {
      if (child instanceof TFolder) {
        const pkg = await this.loadSkillPackage(child);
        if (pkg) {
          packages.push(pkg);
        }
      }
    }
    
    logger.info("Skills", `Scanned ${packages.length} skill packages from ${this.skillFolderPath}`);
    return packages;
  }
  
  /**
   * 加载单个技能包
   */
  public async loadSkillPackage(folder: TFolder): Promise<SkillPackage | null> {
    try {
      // 查找 SKILL.md 文件
      const skillFile = folder.children.find(
        (f) => f instanceof TFile && (f.name === 'SKILL.md' || f.name === 'skill.md')
      ) as TFile | undefined;
      
      if (!skillFile) {
        logger.debug("Skills", `No SKILL.md found in ${folder.path}`);
        return null;
      }
      
      // 读取 SKILL.md 文件
      const content = await this.app.vault.read(skillFile);
      
      // 使用 ClawSkillParser 解析
      const { metadata, instructions } = ClawSkillParser.parseSkillMd(content);
      
      if (!metadata.name) {
        logger.warn("Skills", `Invalid SKILL.md in ${folder.path}: missing name in frontmatter`);
        return null;
      }
      
      // 检测 Claw 格式的附加文件和文件夹
      const hasMetaJson = folder.children.some(f => f instanceof TFile && f.name === '_meta.json');
      const hasConfigJson = folder.children.some(f => f instanceof TFile && f.name === 'config.json');
      const hasReferences = folder.children.some(f => f instanceof TFolder && f.name === 'references');
      const hasScripts = folder.children.some(f => f instanceof TFolder && f.name === 'scripts');
      const hasHooks = folder.children.some(f => f instanceof TFolder && f.name === 'hooks');
      const hasAssets = folder.children.some(f => f instanceof TFolder && f.name === 'assets');
      
      // 读取 _meta.json (如果存在)
      let meta: ClawSkill['meta'] | undefined;
      if (hasMetaJson) {
        const metaFile = folder.children.find(f => f instanceof TFile && f.name === '_meta.json') as TFile;
        const metaContent = await this.app.vault.read(metaFile);
        meta = ClawSkillParser.parseMetaJson(metaContent) || undefined;
      }
      
      // 读取 config.json (如果存在)
      let config: ClawSkill['config'] | undefined;
      if (hasConfigJson) {
        const configFile = folder.children.find(f => f instanceof TFile && f.name === 'config.json') as TFile;
        const configContent = await this.app.vault.read(configFile);
        config = ClawSkillParser.parseConfigJson(configContent) || undefined;
      }
      
      // 构建 ClawSkill 对象
      const clawSkill: ClawSkill = {
        metadata,
        instructions,
        meta,
        config,
        folderPath: folder.path,
        hasReferences,
        hasScripts,
        hasHooks,
        hasAssets
      };
      
      // 验证技能完整性
      const validation = ClawSkillParser.validate(clawSkill);
      if (!validation.valid) {
        logger.warn("Skills", `Invalid Claw Skill in ${folder.path}`, { errors: validation.errors });
        return null;
      }
      
      // 转换为内部 Skill 格式
      const skill = ClawSkillAdapter.convertToInternalFormat(clawSkill);
      
      // 加载资源文件
      const resources = await this.loadResources(folder);
      
      // 创建 Claw Skills 执行器（仅桌面端，移动端跳过）
      let executor: ClawSkillExecutorType | undefined;
      if (!Platform.isMobile && ClawSkillExecutor) {
        executor = new ClawSkillExecutor(this.app, folder.path);
        
        // 加载 hooks (如果存在)
        if (hasHooks) {
          await executor.loadHooks();
        }
      } else if (Platform.isMobile) {
        logger.info("Skills", `Skipping Claw executor on mobile: ${skill.name}`);
      }
      
      logger.info("Skills", `Loaded Claw Skill: ${skill.name}`, {
        id: skill.id,
        version: skill.version,
        hasReferences,
        hasScripts,
        hasHooks,
        hasAssets,
        hooksRegistered: executor?.getRegisteredHooks().length ?? 0
      });
      
      return {
        skill,
        folderPath: folder.path,
        configPath: skillFile.path,
        resources,
        executor
      };
      
    } catch (e: any) {
      logger.error("Skills", `Failed to load skill package from ${folder.path}`, e);
      return null;
    }
  }
  
  /**
   * 根据技能内容生成触发器
   */
  private generateTriggersFromSkill(
    skillId: string,
    frontmatter: Record<string, any>,
    content: string
  ): SkillTrigger[] {
    const triggers: SkillTrigger[] = [];
    
    // 1. 添加命令触发器（使用技能 ID）
    triggers.push({
      type: 'command' as const,
      value: [skillId.toLowerCase().replace(/\s+/g, '-')]
    });
    
    // 2. 如果 frontmatter 中有 keywords，添加关键词触发器
    if (frontmatter.keywords && Array.isArray(frontmatter.keywords)) {
      triggers.push({
        type: 'keyword' as const,
        value: frontmatter.keywords
      });
    }
    
    // 3. 如果 frontmatter 中有 triggers，直接使用
    if (frontmatter.triggers && Array.isArray(frontmatter.triggers)) {
      triggers.push(...frontmatter.triggers);
    }
    
    // 4. 根据技能名称推断关键词
    const nameKeywords = this.extractKeywordsFromName(frontmatter.name || skillId);
    if (nameKeywords.length > 0) {
      triggers.push({
        type: 'keyword' as const,
        value: nameKeywords
      });
    }
    
    return triggers;
  }
  
  /**
   * 从技能名称中提取关键词
   */
  private extractKeywordsFromName(name: string): string[] {
    const keywords: string[] = [];
    const lowerName = name.toLowerCase();
    
    // 常见的技能类型关键词映射
    const keywordMap: Record<string, string[]> = {
      'search': ['搜索', 'search', '查找', '找'],
      'web': ['网页', 'web', '网络', '联网'],
      'translate': ['翻译', 'translate', '转换'],
      'code': ['代码', 'code', '编程'],
      'write': ['写', 'write', '创作'],
      'analyze': ['分析', 'analyze', '解析'],
      'summarize': ['总结', 'summarize', '摘要'],
      'image': ['图片', 'image', '图像'],
      'file': ['文件', 'file'],
      'note': ['笔记', 'note'],
    };
    
    // 匹配关键词
    for (const [key, values] of Object.entries(keywordMap)) {
      if (lowerName.includes(key)) {
        keywords.push(...values);
      }
    }
    
    return [...new Set(keywords)]; // 去重
  }
  
  /**
   * 解析 YAML frontmatter
   */
  private parseFrontmatter(content: string): any {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;
    
    const yaml = match[1];
    const result: any = {};
    
    // 简单的 YAML 解析（支持基本的 key: value 格式）
    const lines = yaml.split('\n');
    for (const line of lines) {
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) continue;
      
      const key = line.substring(0, colonIndex).trim();
      let value = line.substring(colonIndex + 1).trim();
      
      // 移除引号
      if ((value.startsWith('"') && value.endsWith('"')) || 
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.substring(1, value.length - 1);
      }
      
      result[key] = value;
    }
    
    return result;
  }
  
  /**
   * 提取 Markdown 内容（去掉 frontmatter）
   */
  private extractMarkdownContent(content: string): string {
    const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
    return match ? match[1].trim() : content;
  }
  
  /**
   * 加载技能资源文件
   */
  private async loadResources(folder: TFolder): Promise<Map<string, string>> {
    const resources = new Map<string, string>();
    
    // 遍历所有文件
    await this.loadResourcesRecursive(folder, folder.path, resources);
    
    return resources;
  }
  
  /**
   * 递归加载资源文件
   */
  private async loadResourcesRecursive(
    folder: TFolder, 
    basePath: string, 
    resources: Map<string, string>
  ): Promise<void> {
    for (const child of folder.children) {
      if (child instanceof TFile) {
        // 跳过配置文件
        if (child.name.toLowerCase() === 'skill.json') {
          continue;
        }
        
        // 读取文件内容
        try {
          const content = await this.app.vault.read(child);
          resources.set(child.path, content);
        } catch (e) {
          logger.warn("Skills", `Failed to read resource file: ${child.path}`, e);
        }
      } else if (child instanceof TFolder) {
        // 递归处理子文件夹
        await this.loadResourcesRecursive(child, basePath, resources);
      }
    }
  }
  
  /**
   * 监听技能文件夹变化
   */
  public watchSkillFolder(onChange: () => void): () => void {
    const eventRef = this.app.vault.on('modify', (file) => {
      if (file.path.startsWith(this.skillFolderPath)) {
        logger.debug("Skills", `Skill file modified: ${file.path}`);
        onChange();
      }
    });
    
    const createRef = this.app.vault.on('create', (file) => {
      if (file.path.startsWith(this.skillFolderPath)) {
        logger.debug("Skills", `Skill file created: ${file.path}`);
        onChange();
      }
    });
    
    const deleteRef = this.app.vault.on('delete', (file) => {
      if (file.path.startsWith(this.skillFolderPath)) {
        logger.debug("Skills", `Skill file deleted: ${file.path}`);
        onChange();
      }
    });
    
    // 返回清理函数
    return () => {
      this.app.vault.offref(eventRef);
      this.app.vault.offref(createRef);
      this.app.vault.offref(deleteRef);
    };
  }
  
  /**
   * 确保技能文件夹存在
   */
  public async ensureSkillFolder(): Promise<void> {
    const folder = this.app.vault.getAbstractFileByPath(this.skillFolderPath);
    if (!folder) {
      await this.app.vault.createFolder(this.skillFolderPath);
      logger.info("Skills", `Created skills folder: ${this.skillFolderPath}`);
    }
  }
}
