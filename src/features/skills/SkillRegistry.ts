/**
 * SkillRegistry - 技能注册中心
 * 
 * 负责：
 * 1. 管理本地和远程技能
 * 2. 从网络加载社区技能
 * 3. 技能匹配和调度
 * 4. 技能执行
 */

import { App, requestUrl, Notice, TFile } from "obsidian";
import { logger } from "../../core/logger";
import { executeToolWithGuards, validateAndNormalizeToolArgs } from "../agent/ToolBatchExecutor";
import {
  Skill,
  SkillSource,
  SkillStep,
  SkillContext,
  SkillStepResult,
  SkillExecutionResult,
  SkillMatch,
  SkillTrigger,
  SkillManifest,
  CommunitySkillSource,
  RemoteSkillService
} from "./types";
import { SkillFolderScanner, SkillPackage } from "./SkillFolderScanner";
import { SkillInstaller } from "./SkillInstaller";

export class SkillRegistry {
  private app: App;
  private plugin: any;
  
  /** 所有已注册的技能 */
  private skills: Map<string, Skill> = new Map();
  
  /** 技能包映射（用于追踪文件夹路径） */
  private skillPackages: Map<string, SkillPackage> = new Map();
  
  /** 社区技能源 */
  private communitySources: Map<string, CommunitySkillSource> = new Map();
  
  /** 远程技能服务 */
  private remoteServices: Map<string, RemoteSkillService> = new Map();
  
  /** 技能文件夹扫描器 */
  private scanner: SkillFolderScanner;
  
  /** 技能安装器 */
  private installer: SkillInstaller;
  
  /** 文件监听清理函数 */
  private unwatchFolder?: () => void;
  
  constructor(app: App, plugin: any) {
    this.app = app;
    this.plugin = plugin;
    this.scanner = new SkillFolderScanner(app);
    this.installer = new SkillInstaller(app);
  }
  
  // ========== 技能注册 ==========
  
  /**
   * 注册一个技能
   */
  public registerSkill(skill: Skill): void {
    // 验证技能
    if (!this.validateSkill(skill)) {
      logger.warn("Skills", `Invalid skill: ${skill.id}`, { skill });
      return;
    }
    
    this.skills.set(skill.id, {
      ...skill,
      enabled: skill.enabled !== false,
      updatedAt: skill.updatedAt || Date.now()
    });
    
    logger.debug("Skills", `Registered skill: ${skill.id}`, { 
      name: skill.name, 
      source: skill.source,
      steps: skill.steps.length 
    });
  }
  
  /**
   * 批量注册技能
   */
  public registerSkills(skills: Skill[]): void {
    for (const skill of skills) {
      this.registerSkill(skill);
    }
  }
  
  /**
   * 注销技能
   */
  public unregisterSkill(skillId: string): boolean {
    return this.skills.delete(skillId);
  }
  
  /**
   * 验证技能定义
   */
  private validateSkill(skill: Skill): boolean {
    if (!skill.id || !skill.name || !skill.steps || skill.steps.length === 0) {
      return false;
    }
    
    // 验证步骤
    for (const step of skill.steps) {
      if (!step.id || !step.type) {
        return false;
      }
    }
    
    return true;
  }
  
  // ========== 文件夹技能加载 ==========
  
  /**
   * 设置技能文件夹路径
   */
  public setSkillFolderPath(path: string): void {
    this.scanner.setSkillFolderPath(path);
    this.installer.setSkillFolderPath(path);
  }
  
  /**
   * 从文件夹加载所有技能
   */
  public async loadSkillsFromFolder(): Promise<void> {
    try {
      // 确保技能文件夹存在
      await this.scanner.ensureSkillFolder();
      
      // 扫描技能包
      const packages = await this.scanner.scanSkills();
      
      // 注册技能
      for (const pkg of packages) {
        this.skills.set(pkg.skill.id, pkg.skill);
        this.skillPackages.set(pkg.skill.id, pkg);
      }
      
      logger.info("Skills", `Loaded ${packages.length} skills from folder`);
      
    } catch (e: any) {
      logger.error("Skills", "Failed to load skills from folder", e);
    }
  }
  
  /**
   * 重新加载所有技能
   */
  public async reloadSkills(): Promise<void> {
    // 清空现有技能（保留内置技能）
    const builtinSkills = Array.from(this.skills.values()).filter(s => s.source === 'builtin');
    this.skills.clear();
    this.skillPackages.clear();
    
    // 重新注册内置技能
    for (const skill of builtinSkills) {
      this.skills.set(skill.id, skill);
    }
    
    // 从文件夹加载
    await this.loadSkillsFromFolder();
  }
  
  /**
   * 启用文件夹监听（热重载）
   */
  public enableHotReload(): void {
    if (this.unwatchFolder) {
      return; // 已启用
    }
    
    this.unwatchFolder = this.scanner.watchSkillFolder(() => {
      logger.info("Skills", "Skills folder changed, reloading...");
      this.reloadSkills();
    });
    
    logger.info("Skills", "Hot reload enabled for skills folder");
  }
  
  /**
   * 禁用文件夹监听
   */
  public disableHotReload(): void {
    if (this.unwatchFolder) {
      this.unwatchFolder();
      this.unwatchFolder = undefined;
      logger.info("Skills", "Hot reload disabled");
    }
  }
  
  /**
   * 从 URL 安装技能
   */
  public async installSkillFromUrl(url: string, githubMirror?: string): Promise<boolean> {
    const result = await this.installer.installFromUrl(url, githubMirror);
    
    if (result.success) {
      // 重新加载技能
      await this.reloadSkills();
      return true;
    } else {
      new Notice(`❌ 安装失败: ${result.error}`);
      return false;
    }
  }
  
  /**
   * 从本地文件安装技能
   */
  public async installSkillFromFile(file: File): Promise<boolean> {
    const result = await this.installer.installFromFile(file);
    
    if (result.success) {
      // 重新加载技能
      await this.reloadSkills();
      return true;
    } else {
      new Notice(`❌ 安装失败: ${result.error}`);
      return false;
    }
  }
  
  /**
   * 卸载技能
   */
  public async uninstallSkill(skillId: string): Promise<boolean> {
    const success = await this.installer.uninstallSkill(skillId);
    
    if (success) {
      // 从注册表中移除
      this.skills.delete(skillId);
      this.skillPackages.delete(skillId);
    }
    
    return success;
  }
  
  /**
   * 获取技能包信息
   */
  public getSkillPackage(skillId: string): SkillPackage | undefined {
    return this.skillPackages.get(skillId);
  }
  
  // ========== 技能查询 ==========
  
  /**
   * 获取所有技能
   */
  public getAllSkills(): Skill[] {
    return Array.from(this.skills.values());
  }
  
  /**
   * 获取启用的技能
   */
  public getEnabledSkills(): Skill[] {
    return this.getAllSkills().filter(s => s.enabled !== false);
  }
  
  /**
   * 按来源获取技能
   */
  public getSkillsBySource(source: SkillSource): Skill[] {
    return this.getAllSkills().filter(s => s.source === source);
  }
  
  /**
   * 获取单个技能
   */
  public getSkill(skillId: string): Skill | undefined {
    return this.skills.get(skillId);
  }
  
  /**
   * 搜索技能
   */
  public searchSkills(query: string): Skill[] {
    const lowerQuery = query.toLowerCase();
    return this.getEnabledSkills().filter(skill => 
      skill.name.toLowerCase().includes(lowerQuery) ||
      skill.description.toLowerCase().includes(lowerQuery) ||
      skill.tags?.some(tag => tag.toLowerCase().includes(lowerQuery))
    );
  }
  
  // ========== 技能匹配 ==========
  
  /**
   * 匹配用户输入到技能
   */
  public matchSkill(userInput: string): SkillMatch | null {
    const enabledSkills = this.getEnabledSkills();
    let bestMatch: SkillMatch | null = null;
    
    for (const skill of enabledSkills) {
      if (!skill.triggers || skill.triggers.length === 0) {
        continue;
      }
      
      for (const trigger of skill.triggers) {
        const confidence = this.evaluateTrigger(trigger, userInput);
        if (confidence > 0 && (!bestMatch || confidence > bestMatch.confidence)) {
          bestMatch = {
            skill,
            confidence,
            matchedTrigger: trigger
          };
        }
      }
    }
    
    // 只返回置信度超过阈值的匹配
    if (bestMatch && bestMatch.confidence >= 0.6) {
      return bestMatch;
    }
    
    return null;
  }
  
  /**
   * 评估触发器
   */
  private evaluateTrigger(trigger: SkillTrigger, userInput: string): number {
    const input = userInput.toLowerCase();
    
    switch (trigger.type) {
      case 'keyword': {
        const keywords = Array.isArray(trigger.value) ? trigger.value : [trigger.value];
        for (const keyword of keywords) {
          if (input.includes(keyword.toLowerCase())) {
            return 0.8;
          }
        }
        return 0;
      }
      
      case 'regex': {
        try {
          const regex = new RegExp(trigger.value as string, 'i');
          if (regex.test(userInput)) {
            return 0.9;
          }
        } catch {
          // Invalid regex
        }
        return 0;
      }
      
      case 'command': {
        // 精确匹配命令格式
        const commands = Array.isArray(trigger.value) ? trigger.value : [trigger.value];
        for (const cmd of commands) {
          if (input.startsWith(`/${cmd.toLowerCase()}`)) {
            return 1.0;
          }
        }
        return 0;
      }
      
      case 'intent': {
        // 意图匹配需要更复杂的逻辑，这里简化处理
        // 可以后续集成 IntentAnalyzer
        return 0;
      }
      
      default:
        return 0;
    }
  }
  
  // ========== 社区技能加载 ==========
  
  /**
   * 添加社区技能源
   */
  public addCommunitySource(source: CommunitySkillSource): void {
    this.communitySources.set(source.id, source);
  }
  
  /**
   * 从社区源同步技能清单
   */
  public async syncCommunitySource(sourceId: string): Promise<SkillManifest | null> {
    const source = this.communitySources.get(sourceId);
    if (!source || !source.enabled) {
      return null;
    }
    
    try {
      logger.info("Skills", `Syncing community source: ${source.name}`, { url: source.manifestUrl });
      
      const response = await requestUrl({
        url: source.manifestUrl,
        method: 'GET',
        headers: {
          'Accept': 'application/json'
        }
      });
      
      if (response.status !== 200) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const manifest: SkillManifest = response.json;
      
      // 验证清单
      if (!manifest.skills || !Array.isArray(manifest.skills)) {
        throw new Error('Invalid manifest: missing skills array');
      }
      
      // 更新源信息
      source.lastSyncAt = Date.now();
      
      logger.info("Skills", `Synced ${manifest.skills.length} skills from ${source.name}`);
      
      return manifest;
      
    } catch (e: any) {
      logger.error("Skills", `Failed to sync community source: ${source.name}`, e);
      return null;
    }
  }
  
  /**
   * 安装社区技能
   */
  public async installCommunitySkill(sourceId: string, skillId: string): Promise<boolean> {
    const source = this.communitySources.get(sourceId);
    if (!source) {
      return false;
    }
    
    // 先同步获取最新清单
    const manifest = await this.syncCommunitySource(sourceId);
    if (!manifest) {
      return false;
    }
    
    // 查找技能
    const skill = manifest.skills.find(s => s.id === skillId);
    if (!skill) {
      logger.warn("Skills", `Skill not found in manifest: ${skillId}`);
      return false;
    }
    
    // 标记来源
    skill.source = 'community';
    skill.sourceUrl = source.manifestUrl;
    
    // 注册技能
    this.registerSkill(skill);
    
    // 记录已安装
    if (!source.installedSkills) {
      source.installedSkills = [];
    }
    if (!source.installedSkills.includes(skillId)) {
      source.installedSkills.push(skillId);
    }
    
    return true;
  }
  
  /**
   * 从 URL 直接加载单个技能
   */
  public async loadSkillFromUrl(url: string): Promise<Skill | null> {
    try {
      logger.info("Skills", `Loading skill from URL: ${url}`);
      
      const response = await requestUrl({
        url,
        method: 'GET',
        headers: {
          'Accept': 'application/json'
        }
      });
      
      if (response.status !== 200) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const skill: Skill = response.json;
      
      // 标记来源
      skill.source = 'community';
      skill.sourceUrl = url;
      
      // 验证并注册
      if (this.validateSkill(skill)) {
        this.registerSkill(skill);
        return skill;
      }
      
      return null;
      
    } catch (e: any) {
      logger.error("Skills", `Failed to load skill from URL: ${url}`, e);
      return null;
    }
  }
  
  // ========== 远程技能服务 ==========
  
  /**
   * 添加远程技能服务
   */
  public addRemoteService(service: RemoteSkillService): void {
    this.remoteServices.set(service.id, service);
  }
  
  /**
   * 从远程服务获取技能列表
   */
  public async listRemoteSkills(serviceId: string): Promise<Skill[]> {
    const service = this.remoteServices.get(serviceId);
    if (!service || !service.enabled) {
      return [];
    }
    
    try {
      const response = await requestUrl({
        url: `${service.endpoint}/skills`,
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          ...(service.apiKey ? { 'Authorization': `Bearer ${service.apiKey}` } : {})
        }
      });
      
      if (response.status !== 200) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const skills: Skill[] = response.json.skills || response.json;
      
      // 标记来源
      return skills.map(s => ({
        ...s,
        source: 'remote' as SkillSource,
        sourceUrl: service.endpoint
      }));
      
    } catch (e: any) {
      logger.error("Skills", `Failed to list remote skills from: ${service.name}`, e);
      return [];
    }
  }
  
  /**
   * 通过远程服务执行技能
   */
  public async executeRemoteSkill(
    serviceId: string, 
    skillId: string, 
    input: string,
    context?: Record<string, any>
  ): Promise<SkillExecutionResult | null> {
    const service = this.remoteServices.get(serviceId);
    if (!service || !service.enabled) {
      return null;
    }
    
    try {
      const response = await requestUrl({
        url: `${service.endpoint}/skills/${skillId}/execute`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...(service.apiKey ? { 'Authorization': `Bearer ${service.apiKey}` } : {})
        },
        body: JSON.stringify({ input, context })
      });
      
      if (response.status !== 200) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      return response.json as SkillExecutionResult;
      
    } catch (e: any) {
      logger.error("Skills", `Failed to execute remote skill: ${skillId}`, e);
      return null;
    }
  }
  
  // ========== 技能执行 ==========
  
  /**
   * 执行技能
   */
  public async executeSkill(
    skillId: string,
    userInput: string,
    onUpdate?: (message: string) => void,
    signal?: AbortSignal
  ): Promise<SkillExecutionResult> {
    const skill = this.skills.get(skillId);
    if (!skill) {
      throw new Error(`Skill not found: ${skillId}`);
    }

    if (skillId === 'builtin-self-test') {
      return this.executeSelfTestSkill(skill, userInput, onUpdate, signal);
    }

    const startTime = Date.now();
    
    // 初始化执行上下文
    const context: SkillContext = {
      userInput,
      outputs: {},
      variables: {},
      history: [],
      abortSignal: signal
    };
    
    const stepResults: SkillStepResult[] = [];
    let finalOutput = "";
    let hasError = false;
    let errorMessage = "";
    
    onUpdate?.(`🎯 开始执行技能: ${skill.name}`);
    
    try {
      // 按顺序执行步骤
      for (const step of skill.steps) {
        // 检查中止信号
        if (signal?.aborted) {
          throw new Error("用户已中止执行");
        }
        
        // 检查依赖
        if (step.dependsOn && step.dependsOn.length > 0) {
          const allDependenciesMet = step.dependsOn.every(depId => 
            stepResults.some(r => r.stepId === depId && r.success)
          );
          if (!allDependenciesMet) {
            logger.warn("Skills", `Skipping step ${step.id}: dependencies not met`);
            continue;
          }
        }
        
        onUpdate?.(`\n📍 执行步骤: ${step.name}`);
        
        const stepResult = await this.executeStep(step, context, onUpdate);
        stepResults.push(stepResult);
        context.history.push(stepResult);
        
        if (stepResult.success && stepResult.output !== undefined) {
          if (step.outputKey) {
            context.outputs[step.outputKey] = stepResult.output;
          }
          finalOutput = String(stepResult.output);
        } else if (!stepResult.success && !step.optional) {
          hasError = true;
          errorMessage = stepResult.error || "Unknown error";
          
          // 尝试重试
          if (step.retries && step.retries > 0) {
            for (let retry = 0; retry < step.retries; retry++) {
              onUpdate?.(`\n🔄 重试步骤 ${step.name} (${retry + 1}/${step.retries})`);
              const retryResult = await this.executeStep(step, context, onUpdate);
              if (retryResult.success) {
                stepResults.push(retryResult);
                context.history.push(retryResult);
                if (step.outputKey) {
                  context.outputs[step.outputKey] = retryResult.output;
                }
                finalOutput = String(retryResult.output);
                hasError = false;
                break;
              }
            }
          }
          
          if (hasError) {
            break;
          }
        }
      }
      
    } catch (e: any) {
      hasError = true;
      errorMessage = e.message || String(e);
    }
    
    const totalDurationMs = Date.now() - startTime;
    
    onUpdate?.(`\n${hasError ? '❌' : '✅'} 技能执行${hasError ? '失败' : '完成'} (${totalDurationMs}ms)`);
    
    return {
      skillId,
      skillName: skill.name,
      success: !hasError,
      output: finalOutput,
      stepResults,
      totalDurationMs,
      error: hasError ? errorMessage : undefined
    };
  }
  
  private async executeSelfTestSkill(
    skill: Skill,
    userInput: string,
    onUpdate?: (message: string) => void,
    signal?: AbortSignal
  ): Promise<SkillExecutionResult> {
    const startTime = Date.now();
    const stepResults: SkillStepResult[] = [];
    const normalizedInput = String(userInput || '').trim();
    const context = await this.resolveSelfTestContext(normalizedInput);
    let success = true;
    let error: string | undefined;

    onUpdate?.(`🧪 进入自测模式`);
    if (context.docPath) {
      onUpdate?.(`📄 执行文档: ${context.docPath}`);
    }

    if (signal?.aborted) {
      throw new Error('用户已中止执行');
    }

    const verifyStep = await this.runSelfTestCommand('verify', '运行 verify', 'npm', ['run', 'verify'], onUpdate, signal);
    stepResults.push(verifyStep);
    if (!verifyStep.success) {
      success = false;
      error = verifyStep.error || 'npm run verify 失败';
    }

    const buildStep = await this.runSelfTestCommand('build', '运行 build', 'npm', ['run', 'build'], onUpdate, signal);
    stepResults.push(buildStep);
    if (!buildStep.success) {
      success = false;
      error = buildStep.error || error || 'npm run build 失败';
    }

    const output = this.formatSelfTestSummary({
      docPath: context.docPath,
      docContent: context.docContent,
      stepResults,
      success,
    });

    onUpdate?.(`\n${success ? '✅' : '❌'} 自测${success ? '完成' : '失败'} (${Date.now() - startTime}ms)`);

    return {
      skillId: skill.id,
      skillName: skill.name,
      success,
      output,
      stepResults,
      totalDurationMs: Date.now() - startTime,
      error,
    };
  }

  private async resolveSelfTestContext(userInput: string): Promise<{ docPath?: string; docContent?: string }> {
    const trimmed = String(userInput || '').trim();
    if (!trimmed) return {};

    const normalizedPath = trimmed.replace(/^['"]|['"]$/g, '');
    const file = this.app.vault.getAbstractFileByPath(normalizedPath)
      || this.app.metadataCache.getFirstLinkpathDest(normalizedPath, '');

    if (file instanceof TFile) {
      const content = await this.app.vault.cachedRead(file);
      return { docPath: file.path, docContent: content.trim() };
    }

    return { docContent: trimmed };
  }

  private async runSelfTestCommand(
    stepId: string,
    stepName: string,
    command: string,
    args: string[],
    onUpdate?: (message: string) => void,
    signal?: AbortSignal,
  ): Promise<SkillStepResult> {
    const startTime = Date.now();
    onUpdate?.(`📍 执行步骤: ${stepName}`);
    onUpdate?.(`🛠️ 运行命令: ${[command, ...args].join(' ')}`);

    try {
      // @ts-ignore: Obsidian desktop has node integration
      const cp = require('child_process');
      if (!cp || !cp.execFile) {
        throw new Error('当前环境不支持执行本地命令（仅限桌面端）');
      }
      
      const result = await new Promise<{stdout: string, stderr: string}>((resolve, reject) => {
        cp.execFile(command, args, {
          cwd: this.plugin.manifest?.dir,
          windowsHide: true,
          signal,
          shell: process.platform === 'win32',
        }, (error: any, stdout: string, stderr: string) => {
          if (error) {
            error.stdout = stdout;
            error.stderr = stderr;
            reject(error);
          } else {
            resolve({ stdout, stderr });
          }
        });
      });
      const stdout = String(result?.stdout || '').trim();
      const stderr = String(result?.stderr || '').trim();
      const preview = [stdout, stderr].filter(Boolean).join('\n').trim();
      if (preview) {
        onUpdate?.(preview.slice(0, 1200));
      }
      return {
        stepId,
        stepName,
        success: true,
        output: preview || `${command} ${args.join(' ')} EXIT=0`,
        durationMs: Date.now() - startTime,
        timestamp: Date.now(),
      };
    } catch (e: any) {
      const stdout = String(e?.stdout || '').trim();
      const stderr = String(e?.stderr || '').trim();
      const message = stderr || stdout || e?.message || `${command} 执行失败`;
      onUpdate?.(message.slice(0, 1200));
      return {
        stepId,
        stepName,
        success: false,
        error: message,
        output: [stdout, stderr].filter(Boolean).join('\n').trim(),
        durationMs: Date.now() - startTime,
        timestamp: Date.now(),
      };
    }
  }

  private formatSelfTestSummary(input: {
    docPath?: string;
    docContent?: string;
    stepResults: SkillStepResult[];
    success: boolean;
  }): string {
    const verify = input.stepResults.find(step => step.stepId === 'verify');
    const build = input.stepResults.find(step => step.stepId === 'build');
    const lines: string[] = [];
    lines.push('## Self-test 验证摘要');
    if (input.docPath) {
      lines.push(`- 执行文档: ${input.docPath}`);
    } else if (input.docContent) {
      lines.push(`- 执行文档输入: ${input.docContent.split(/\r?\n/)[0].slice(0, 120)}`);
    } else {
      lines.push('- 执行文档: 未提供，使用默认校验流程');
    }
    lines.push(`- 总体结果: ${input.success ? '通过' : '失败'}`);
    lines.push('');
    lines.push('### 验证结果');
    if (verify) lines.push(`- npm run verify: ${verify.success ? 'EXIT=0' : 'FAIL'}${verify.error ? ` (${verify.error.split(/\r?\n/)[0]})` : ''}`);
    if (build) lines.push(`- npm run build: ${build.success ? 'EXIT=0' : 'FAIL'}${build.error ? ` (${build.error.split(/\r?\n/)[0]})` : ''}`);
    lines.push('');
    lines.push('### 建议');
    lines.push(input.success ? '- 当前实现已通过基础自测，可继续人工回归。' : '- 先修复失败项，再重新运行 /self-test。');
    return lines.join('\n');
  }

  /**
   * 执行单个步骤
   */
  private async executeStep(
    step: SkillStep,
    context: SkillContext,
    onUpdate?: (message: string) => void
  ): Promise<SkillStepResult> {
    const startTime = Date.now();
    
    try {
      let output: any;
      
      switch (step.type) {
        case 'llm':
          output = await this.executeLLMStep(step, context, onUpdate);
          break;
          
        case 'tool':
          output = await this.executeToolStep(step, context, onUpdate);
          break;
          
        case 'transform':
          output = this.executeTransformStep(step, context);
          break;
          
        case 'condition':
          output = await this.executeConditionStep(step, context, onUpdate);
          break;
          
        case 'loop':
          output = await this.executeLoopStep(step, context, onUpdate);
          break;
          
        case 'parallel':
          output = await this.executeParallelStep(step, context, onUpdate);
          break;
          
        default:
          throw new Error(`Unknown step type: ${step.type}`);
      }
      
      return {
        stepId: step.id,
        stepName: step.name,
        success: true,
        output,
        durationMs: Date.now() - startTime,
        timestamp: Date.now()
      };
      
    } catch (e: any) {
      return {
        stepId: step.id,
        stepName: step.name,
        success: false,
        error: e.message || String(e),
        durationMs: Date.now() - startTime,
        timestamp: Date.now()
      };
    }
  }
  
  /**
   * 执行 LLM 步骤
   */
  private async executeLLMStep(
    step: SkillStep,
    context: SkillContext,
    onUpdate?: (message: string) => void
  ): Promise<string> {
    if (!step.prompt) {
      throw new Error("LLM step requires prompt");
    }
    
    // 模板插值
    const prompt = this.interpolateTemplate(step.prompt, context);
    
    const messages = [
      { role: 'user' as const, content: prompt }
    ];
    
    const model = step.model || this.plugin.settings.defaultChatModel;
    
    let result = "";
    const response = await this.plugin.llmService.getCompletion(
      messages,
      model,
      undefined,
      (token: string) => {
        result += token;
        onUpdate?.(token);
      }
    );
    
    return response.content || result;
  }
  
  /**
   * 执行工具步骤
   */
  private async executeToolStep(
    step: SkillStep,
    context: SkillContext,
    onUpdate?: (message: string) => void
  ): Promise<string> {
    if (!step.toolName) {
      throw new Error("Tool step requires toolName");
    }
    
    const tool = this.plugin.agentManager.getTool(step.toolName);
    if (!tool) {
      throw new Error(`Tool not found: ${step.toolName}`);
    }
    
    // 模板插值
    const rawArgs = step.toolArgs
      ? JSON.parse(this.interpolateTemplate(JSON.stringify(step.toolArgs), context))
      : {};
    const normalizedArgs = validateAndNormalizeToolArgs(step.toolName, rawArgs);
    if (!normalizedArgs.ok) {
      throw new Error(normalizedArgs.error || `工具参数不合法: ${step.toolName}`);
    }
    const args = normalizedArgs.args;

    onUpdate?.(`\n🛠️ 调用工具: ${step.toolName}`);

    const execution = await executeToolWithGuards({
      app: this.app,
      agentManager: this.plugin.agentManager,
      permissionManager: this.plugin.permissionManager,
      executionVerifier: this.plugin.executionVerifier,
      toolRouterAgent: this.plugin.toolRouterAgent,
    }, {
      toolName: step.toolName,
      tool,
      args,
      showNotice: false,
    });

    return execution.result;
  }
  
  /**
   * 安全的简单表达式求值器（替代 new Function）
   * 支持简单的变量访问（如 outputs.step1.result）、常量和基本比较
   */
  private safeEvaluate(expr: string, context: { input: string, outputs: any, variables: any }): any {
    const trimmed = expr.trim();
    
    // 解析路径或字面量
    const resolveValue = (valExpr: string): any => {
      valExpr = valExpr.trim();
      if (valExpr === 'input') return context.input;
      if (valExpr === 'true') return true;
      if (valExpr === 'false') return false;
      if (valExpr === 'null') return null;
      if (valExpr === 'undefined') return undefined;
      if (!isNaN(Number(valExpr))) return Number(valExpr);
      if ((valExpr.startsWith('"') && valExpr.endsWith('"')) || (valExpr.startsWith("'") && valExpr.endsWith("'"))) {
        return valExpr.slice(1, -1);
      }
      
      const parts = valExpr.split('.');
      let current: any = context;
      for (const part of parts) {
        if (current && typeof current === 'object' && part in current) {
          current = current[part];
        } else {
          return undefined;
        }
      }
      return current;
    };

    // 处理带非运算符的表达式
    if (trimmed.startsWith('!')) {
      return !resolveValue(trimmed.substring(1));
    }

    // 处理简单二元操作符
    const operatorMatch = trimmed.match(/^(.*?)\s*(===|==|!==|!=|>=|<=|>|<|&&|\|\|)\s*(.*)$/);
    if (operatorMatch) {
      const left = resolveValue(operatorMatch[1]);
      const op = operatorMatch[2];
      const right = resolveValue(operatorMatch[3]);
      
      switch (op) {
        case '===': return left === right;
        case '==': return left == right;
        case '!==': return left !== right;
        case '!=': return left != right;
        case '>': return left > right;
        case '<': return left < right;
        case '>=': return left >= right;
        case '<=': return left <= right;
        case '&&': return left && right;
        case '||': return left || right;
      }
    }

    // 默认作为单一变量解析
    return resolveValue(trimmed);
  }

  /**
   * 执行转换步骤
   */
  private executeTransformStep(step: SkillStep, context: SkillContext): any {
    if (!step.transform) {
      throw new Error("Transform step requires transform expression");
    }
    
    // 简单的表达式求值（安全性考虑，只支持基本操作）
    const expression = this.interpolateTemplate(step.transform, context);
    
    // 安全的表达式求值
    try {
      return this.safeEvaluate(expression, {
        input: context.userInput,
        outputs: context.outputs,
        variables: context.variables
      });
    } catch (e: any) {
      throw new Error(`Transform expression error: ${e.message}`);
    }
  }
  
  /**
   * 执行条件步骤
   */
  private async executeConditionStep(
    step: SkillStep,
    context: SkillContext,
    onUpdate?: (message: string) => void
  ): Promise<any> {
    if (!step.condition) {
      throw new Error("Condition step requires condition expression");
    }
    
    // 评估条件
    const conditionExpr = this.interpolateTemplate(step.condition, context);
    let conditionResult: boolean;
    
    try {
      conditionResult = !!this.safeEvaluate(conditionExpr, {
        input: context.userInput,
        outputs: context.outputs,
        variables: context.variables
      });
    } catch {
      conditionResult = false;
    }
    
    // 执行相应分支
    const stepsToRun = conditionResult ? step.thenSteps : step.elseSteps;
    if (stepsToRun && stepsToRun.length > 0) {
      // 这里简化处理，实际应该查找并执行对应的步骤
      return `Condition ${conditionResult ? 'true' : 'false'}, would execute: ${stepsToRun.join(', ')}`;
    }
    
    return conditionResult;
  }
  
  /**
   * 执行循环步骤
   */
  private async executeLoopStep(
    step: SkillStep,
    context: SkillContext,
    onUpdate?: (message: string) => void
  ): Promise<any[]> {
    if (!step.loopOver) {
      throw new Error("Loop step requires loopOver");
    }
    
    const items = context.outputs[step.loopOver];
    if (!Array.isArray(items)) {
      throw new Error(`Loop source ${step.loopOver} is not an array`);
    }
    
    const maxIterations = step.maxIterations || 10;
    const results: any[] = [];
    
    for (let i = 0; i < Math.min(items.length, maxIterations); i++) {
      context.variables['_loopIndex'] = i;
      context.variables['_loopItem'] = items[i];
      
      // 这里简化处理，实际应该执行 loopSteps
      results.push(items[i]);
    }
    
    return results;
  }
  
  /**
   * 执行并行步骤
   */
  private async executeParallelStep(
    step: SkillStep,
    context: SkillContext,
    onUpdate?: (message: string) => void
  ): Promise<any[]> {
    if (!step.parallelSteps || step.parallelSteps.length === 0) {
      return [];
    }
    
    // 这里简化处理，实际应该并行执行 parallelSteps
    return step.parallelSteps.map(id => `Would execute: ${id}`);
  }
  
  /**
   * 模板插值
   */
  private interpolateTemplate(template: string, context: SkillContext): string {
    return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (match, path) => {
      const parts = path.split('.');
      let value: any = { 
        input: context.userInput, 
        outputs: context.outputs, 
        variables: context.variables 
      };
      
      for (const part of parts) {
        if (value && typeof value === 'object' && part in value) {
          value = value[part];
        } else {
          return match; // 保留原始占位符
        }
      }
      
      return String(value);
    });
  }
  
  // ========== 持久化 ==========
  
  /**
   * 导出技能为 JSON
   */
  public exportSkill(skillId: string): string | null {
    const skill = this.skills.get(skillId);
    if (!skill) return null;
    
    // 移除运行时字段
    const exportable = { ...skill };
    delete (exportable as any).enabled;
    delete (exportable as any).updatedAt;
    
    return JSON.stringify(exportable, null, 2);
  }
  
  /**
   * 从 JSON 导入技能
   */
  public importSkill(json: string): Skill | null {
    try {
      const skill = JSON.parse(json) as Skill;
      skill.source = 'local';
      
      if (this.validateSkill(skill)) {
        this.registerSkill(skill);
        return skill;
      }
      
      return null;
    } catch {
      return null;
    }
  }
  
  /**
   * 获取社区源列表
   */
  public getCommunitySources(): CommunitySkillSource[] {
    return Array.from(this.communitySources.values());
  }
  
  /**
   * 获取远程服务列表
   */
  public getRemoteServices(): RemoteSkillService[] {
    return Array.from(this.remoteServices.values());
  }
}

// 单例导出
let skillRegistryInstance: SkillRegistry | null = null;

export function getSkillRegistry(): SkillRegistry | null {
  return skillRegistryInstance;
}

export function initSkillRegistry(app: App, plugin: any): SkillRegistry {
  skillRegistryInstance = new SkillRegistry(app, plugin);
  return skillRegistryInstance;
}
