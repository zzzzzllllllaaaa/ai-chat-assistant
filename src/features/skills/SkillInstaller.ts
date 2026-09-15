/**
 * SkillInstaller - 技能安装器
 * 
 * 负责：
 * 1. 从 URL 下载技能 ZIP 包
 * 2. 从本地文件安装技能 ZIP 包
 * 3. 解压 ZIP 包到技能文件夹
 * 4. 验证技能包完整性
 */

import { App, Notice, requestUrl, normalizePath } from "obsidian";
import { logger } from "../../core/logger";
import JSZip from "jszip";

export interface InstallResult {
  success: boolean;
  skillId?: string;
  skillName?: string;
  folderPath?: string;
  error?: string;
}

export class SkillInstaller {
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
   * 从 URL 安装技能包
   */
  public async installFromUrl(url: string, githubMirror?: string): Promise<InstallResult> {
    try {
      logger.info("Skills", `Installing skill from URL: ${url}`);
      
      // 如果是 GitHub URL 且配置了镜像，替换域名
      let downloadUrl = url;
      if (githubMirror && url.includes('github.com')) {
        downloadUrl = url.replace('github.com', githubMirror.replace(/^https?:\/\//, ''));
        logger.info("Skills", `Using GitHub mirror: ${downloadUrl}`);
      }
      
      // 下载 ZIP 文件
      const notice = new Notice("正在下载技能包...", 0);
      logger.info("Skills", `Downloading from: ${downloadUrl}`);
      
      const response = await requestUrl({
        url: downloadUrl,
        method: 'GET',
        headers: {
          'Accept': 'application/zip, application/octet-stream'
        }
      });
      
      logger.info("Skills", `Response status: ${response.status}, Content-Type: ${response.headers['content-type']}`);
      
      if (response.status !== 200) {
        throw new Error(`HTTP ${response.status}: ${response.text}`);
      }
      
      notice.hide();
      
      // 获取二进制数据
      const zipData = response.arrayBuffer;
      logger.info("Skills", `Downloaded data size: ${zipData.byteLength} bytes`);
      
      // 安装 ZIP 包
      return await this.installFromArrayBuffer(zipData);
      
    } catch (e: any) {
      const errorMsg = e.message || String(e);
      logger.error("Skills", `Failed to install from URL: ${url} - ${errorMsg}`, e);
      new Notice(`❌ 下载失败: ${errorMsg}`);
      return {
        success: false,
        error: errorMsg
      };
    }
  }
  
  /**
   * 从 ArrayBuffer 安装技能包
   */
  public async installFromArrayBuffer(zipData: ArrayBuffer): Promise<InstallResult> {
    try {
      const notice = new Notice("正在解压技能包...", 0);
      
      logger.info("Skills", `ZIP data size: ${zipData.byteLength} bytes`);
      
      const zip = await new JSZip().loadAsync(zipData);
      
      // 查找 SKILL.md 确定根目录
      let rootFolder = "";
      let skillFilePath = "";
      
      // 列出所有文件用于调试
      const allFiles = Object.keys(zip.files);
      logger.info("Skills", `ZIP contains ${allFiles.length} files: ${allFiles.slice(0, 10).join(', ')}${allFiles.length > 10 ? '...' : ''}`);
      
      for (const [path, file] of Object.entries(zip.files) as [string, any][]) {
        if (file.name.endsWith('SKILL.md') || file.name.endsWith('skill.md')) {
          skillFilePath = file.name;
          // 提取根文件夹路径
          const parts = file.name.split('/');
          if (parts.length > 1) {
            rootFolder = parts[0];
          }
          break;
        }
      }
      
      if (!skillFilePath) {
        throw new Error("Invalid skill package: SKILL.md not found");
      }
      
      // 读取 SKILL.md 文件
      const skillFile = zip.files[skillFilePath];
      const skillContent = await skillFile.async('text');
      
      // 解析 YAML frontmatter 获取技能信息
      const frontmatter = this.parseFrontmatter(skillContent);
      if (!frontmatter || !frontmatter.name) {
        throw new Error("Invalid SKILL.md: missing name in frontmatter");
      }
      
      // 使用 name 作为 ID（或者使用根文件夹名）
      const skillId = frontmatter.name || rootFolder;
      const skillName = frontmatter.name;
      
      // 确定目标文件夹
      const targetFolder = normalizePath(`${this.skillFolderPath}/${skillId}`);
      
      // 检查是否已存在
      const existing = this.app.vault.getAbstractFileByPath(targetFolder);
      if (existing) {
        const confirm = await this.confirmOverwrite(skillName);
        if (!confirm) {
          notice.hide();
          return {
            success: false,
            error: "Installation cancelled by user"
          };
        }
        
        // 删除旧版本
        await this.app.vault.delete(existing, true);
      }
      
      // 创建目标文件夹
      await this.app.vault.createFolder(targetFolder);
      
      // 解压所有文件
      let fileCount = 0;
      for (const [path, file] of Object.entries(zip.files) as [string, any][]) {
        if (file.dir) continue;
        
        // 计算相对路径（去掉根文件夹前缀）
        let relativePath = path;
        if (rootFolder && path.startsWith(rootFolder + '/')) {
          relativePath = path.substring(rootFolder.length + 1);
        }
        
        if (!relativePath) continue;
        
        const targetPath = normalizePath(`${targetFolder}/${relativePath}`);
        
        // 确保父文件夹存在
        const parentPath = targetPath.substring(0, targetPath.lastIndexOf('/'));
        if (parentPath && parentPath !== targetFolder) {
          try {
            await this.app.vault.createFolder(parentPath);
          } catch (e) {
            // 文件夹可能已存在
          }
        }
        
        // 写入文件
        const content = await file.async('arraybuffer');
        const uint8Array = new Uint8Array(content);
        await this.app.vault.createBinary(targetPath, uint8Array);
        fileCount++;
      }
      
      notice.hide();
      new Notice(`✅ 技能 "${skillName}" 安装成功！(${fileCount} 个文件)`);
      
      logger.info("Skills", `Installed skill: ${skillName}`, {
        id: skillId,
        version: frontmatter.version || 'unknown',
        files: fileCount,
        path: targetFolder
      });
      
      return {
        success: true,
        skillId: skillId,
        skillName: skillName,
        folderPath: targetFolder
      };
      
    } catch (e: any) {
      const errorMsg = e.message || String(e);
      logger.error("Skills", `Failed to install from ArrayBuffer: ${errorMsg}`, e);
      new Notice(`❌ 技能安装失败: ${errorMsg}`);
      return {
        success: false,
        error: errorMsg
      };
    }
  }
  
  /**
   * 从本地文件安装技能包
   */
  public async installFromFile(file: File): Promise<InstallResult> {
    try {
      logger.info("Skills", `Installing skill from file: ${file.name}`);
      
      // 读取文件为 ArrayBuffer
      const arrayBuffer = await file.arrayBuffer();
      
      // 安装
      return await this.installFromArrayBuffer(arrayBuffer);
      
    } catch (e: any) {
      const errorMsg = e.message || String(e);
      logger.error("Skills", `Failed to install from file: ${file.name} - ${errorMsg}`, e);
      new Notice(`❌ 技能安装失败: ${errorMsg}`);
      return {
        success: false,
        error: errorMsg
      };
    }
  }
  
  /**
   * 卸载技能
   */
  public async uninstallSkill(skillId: string): Promise<boolean> {
    try {
      const skillPath = normalizePath(`${this.skillFolderPath}/${skillId}`);
      const folder = this.app.vault.getAbstractFileByPath(skillPath);
      
      if (!folder) {
        logger.warn("Skills", `Skill folder not found: ${skillPath}`);
        return false;
      }
      
      // 确认删除
      const confirm = await this.confirmUninstall(skillId);
      if (!confirm) {
        return false;
      }
      
      // 删除文件夹
      await this.app.vault.delete(folder, true);
      
      new Notice(`✅ 技能 "${skillId}" 已卸载`);
      logger.info("Skills", `Uninstalled skill: ${skillId}`);
      
      return true;
      
    } catch (e: any) {
      logger.error("Skills", `Failed to uninstall skill: ${skillId}`, e);
      new Notice(`❌ 卸载失败: ${e.message}`);
      return false;
    }
  }
  
  /**
   * 确认覆盖安装
   */
  private async confirmOverwrite(skillName: string): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new ConfirmModal(
        this.app,
        "覆盖安装",
        `技能 "${skillName}" 已存在，是否覆盖安装？`,
        () => resolve(true),
        () => resolve(false)
      );
      modal.open();
    });
  }
  
  /**
   * 确认卸载
   */
  private async confirmUninstall(skillId: string): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new ConfirmModal(
        this.app,
        "确认卸载",
        `确定要卸载技能 "${skillId}" 吗？此操作不可恢复。`,
        () => resolve(true),
        () => resolve(false)
      );
      modal.open();
    });
  }
  
  /**
   * 验证技能包
   */
  public async validateSkillPackage(zipData: ArrayBuffer): Promise<{ valid: boolean; error?: string; config?: any }> {
    try {
      const zip = await new JSZip().loadAsync(zipData);
      
      // 查找 skill.json
      let configPath = "";
      for (const [path, file] of Object.entries(zip.files) as [string, any][]) {
        if (file.name.endsWith('skill.json') || file.name.endsWith('SKILL.json')) {
          configPath = file.name;
          break;
        }
      }
      
      if (!configPath) {
        return { valid: false, error: "skill.json not found" };
      }
      
      // 读取并验证配置
      const configFile = zip.files[configPath];
      const configContent = await configFile.async('text');
      const config = JSON.parse(configContent);
      
      if (!config.id) {
        return { valid: false, error: "Missing required field: id" };
      }
      
      if (!config.name) {
        return { valid: false, error: "Missing required field: name" };
      }
      
      if (!config.steps || !Array.isArray(config.steps)) {
        return { valid: false, error: "Missing or invalid field: steps" };
      }
      
      return { valid: true, config };
      
    } catch (e: any) {
      return { valid: false, error: e.message || String(e) };
    }
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
}

/**
 * 确认对话框
 */
import { Modal } from "obsidian";

class ConfirmModal extends Modal {
  private title: string;
  private message: string;
  private onConfirm: () => void;
  private onCancel: () => void;
  
  constructor(
    app: App,
    title: string,
    message: string,
    onConfirm: () => void,
    onCancel: () => void
  ) {
    super(app);
    this.title = title;
    this.message = message;
    this.onConfirm = onConfirm;
    this.onCancel = onCancel;
  }
  
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    
    contentEl.createEl("h2", { text: this.title });
    contentEl.createEl("p", { text: this.message });
    
    const buttonContainer = contentEl.createDiv({ cls: "modal-button-container" });
    
    const confirmBtn = buttonContainer.createEl("button", { text: "确认", cls: "mod-cta" });
    confirmBtn.addEventListener("click", () => {
      this.close();
      this.onConfirm();
    });
    
    const cancelBtn = buttonContainer.createEl("button", { text: "取消" });
    cancelBtn.addEventListener("click", () => {
      this.close();
      this.onCancel();
    });
  }
  
  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
