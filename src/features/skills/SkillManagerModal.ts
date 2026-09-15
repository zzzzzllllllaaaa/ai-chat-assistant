/**
 * SkillManagerModal - 技能管理界面
 * 
 * 提供图形化界面来管理技能：
 * 1. 查看已安装的技能
 * 2. 启用/禁用技能
 * 3. 安装新技能（从 URL 或本地文件）
 * 4. 卸载技能
 * 5. 查看技能详情
 */

import { App, Modal, Setting, Notice } from "obsidian";
import { SkillRegistry } from "./SkillRegistry";
import { Skill } from "./types";
import { logger } from "../../core/logger";

export class SkillManagerModal extends Modal {
  private plugin: any;
  private skillRegistry: SkillRegistry;
  
  constructor(app: App, plugin: any) {
    super(app);
    this.plugin = plugin;
    this.skillRegistry = plugin.skillRegistry;
  }
  
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("skill-manager-modal");
    
    // 标题
    contentEl.createEl("h2", { text: "🎯 技能管理" });
    
    // 渲染界面
    this.render();
  }
  
  private render() {
    const { contentEl } = this;
    
    // 清空内容（保留标题）
    const children = Array.from(contentEl.children);
    for (let i = 1; i < children.length; i++) {
      children[i].remove();
    }
    
    // 顶部操作栏
    this.renderToolbar(contentEl);
    
    // 技能列表
    this.renderSkillList(contentEl);
  }
  
  private renderToolbar(container: HTMLElement) {
    const toolbar = container.createDiv({ cls: "skill-manager-toolbar" });
    
    // 安装按钮
    const installBtn = toolbar.createEl("button", { 
      text: "📦 安装技能",
      cls: "mod-cta"
    });
    installBtn.addEventListener("click", () => {
      this.showInstallDialog();
    });
    
    // 刷新按钮
    const refreshBtn = toolbar.createEl("button", { 
      text: "🔄 刷新"
    });
    refreshBtn.addEventListener("click", async () => {
      await this.skillRegistry.reloadSkills();
      this.render();
      new Notice("✅ 技能列表已刷新");
    });
    
    // 打开文件夹按钮
    const openFolderBtn = toolbar.createEl("button", { 
      text: "📁 打开技能文件夹"
    });
    openFolderBtn.addEventListener("click", () => {
      const folderPath = this.plugin.settings.skillFolderPath || "Skills";
      // 在 Obsidian 中打开文件夹
      const folder = this.app.vault.getAbstractFileByPath(folderPath);
      if (folder) {
        // @ts-ignore
        this.app.workspace.getLeaf().openFile(folder);
      } else {
        new Notice(`技能文件夹不存在: ${folderPath}`);
      }
    });
  }
  
  private renderSkillList(container: HTMLElement) {
    const listContainer = container.createDiv({ cls: "skill-list-container" });
    
    const skills = this.skillRegistry.getAllSkills();
    
    if (skills.length === 0) {
      listContainer.createEl("p", { 
        text: "暂无已安装的技能。点击\"安装技能\"按钮开始添加。",
        cls: "skill-empty-message"
      });
      return;
    }
    
    // 按来源分组
    const grouped = this.groupSkillsBySource(skills);
    
    for (const [source, sourceSkills] of Object.entries(grouped)) {
      if (sourceSkills.length === 0) continue;
      
      const section = listContainer.createDiv({ cls: "skill-section" });
      section.createEl("h3", { text: this.getSourceLabel(source) });
      
      for (const skill of sourceSkills) {
        this.renderSkillItem(section, skill);
      }
    }
  }
  
  private renderSkillItem(container: HTMLElement, skill: Skill) {
    const item = container.createDiv({ cls: "skill-item" });
    
    // 左侧：图标和信息
    const info = item.createDiv({ cls: "skill-info" });
    
    const header = info.createDiv({ cls: "skill-header" });
    if (skill.icon) {
      header.createSpan({ text: skill.icon, cls: "skill-icon" });
    }
    header.createSpan({ text: skill.name, cls: "skill-name" });
    
    if (skill.version) {
      header.createSpan({ text: `v${skill.version}`, cls: "skill-version" });
    }
    
    info.createDiv({ text: skill.description, cls: "skill-description" });
    
    // 标签
    if (skill.tags && skill.tags.length > 0) {
      const tagsContainer = info.createDiv({ cls: "skill-tags" });
      for (const tag of skill.tags) {
        tagsContainer.createSpan({ text: tag, cls: "skill-tag" });
      }
    }
    
    // 右侧：操作按钮
    const actions = item.createDiv({ cls: "skill-actions" });
    
    // 启用/禁用开关
    const toggleContainer = actions.createDiv({ cls: "skill-toggle" });
    const toggle = toggleContainer.createEl("input", { 
      type: "checkbox",
      cls: "skill-toggle-input"
    });
    toggle.checked = skill.enabled !== false;
    toggle.addEventListener("change", async () => {
      skill.enabled = toggle.checked;
      await this.plugin.saveSettings();
      new Notice(`${skill.name} 已${toggle.checked ? '启用' : '禁用'}`);
    });
    toggleContainer.createSpan({ text: toggle.checked ? "已启用" : "已禁用" });
    
    // 详情按钮
    const detailBtn = actions.createEl("button", { 
      text: "详情",
      cls: "skill-action-btn"
    });
    detailBtn.addEventListener("click", () => {
      this.showSkillDetail(skill);
    });
    
    // 卸载按钮（仅本地技能）
    if (skill.source === 'local' || skill.source === 'community') {
      const uninstallBtn = actions.createEl("button", { 
        text: "卸载",
        cls: "skill-action-btn mod-warning"
      });
      uninstallBtn.addEventListener("click", async () => {
        const success = await this.skillRegistry.uninstallSkill(skill.id);
        if (success) {
          this.render();
        }
      });
    }
  }
  
  private showInstallDialog() {
    const dialog = new InstallSkillModal(this.app, this.plugin, async () => {
      // 安装完成后刷新列表
      await this.skillRegistry.reloadSkills();
      this.render();
    });
    dialog.open();
  }
  
  private showSkillDetail(skill: Skill) {
    const modal = new SkillDetailModal(this.app, skill);
    modal.open();
  }
  
  private groupSkillsBySource(skills: Skill[]): Record<string, Skill[]> {
    const grouped: Record<string, Skill[]> = {
      builtin: [],
      local: [],
      community: [],
      remote: []
    };
    
    for (const skill of skills) {
      grouped[skill.source].push(skill);
    }
    
    return grouped;
  }
  
  private getSourceLabel(source: string): string {
    const labels: Record<string, string> = {
      builtin: "📚 内置技能",
      local: "💾 本地技能",
      community: "🌐 社区技能",
      remote: "☁️ 远程技能"
    };
    return labels[source] || source;
  }
  
  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

/**
 * 安装技能对话框
 */
class InstallSkillModal extends Modal {
  private plugin: any;
  private onInstalled: () => void;
  
  constructor(app: App, plugin: any, onInstalled: () => void) {
    super(app);
    this.plugin = plugin;
    this.onInstalled = onInstalled;
  }
  
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    
    contentEl.createEl("h2", { text: "安装技能" });
    
    // 从 URL 安装
    contentEl.createEl("h3", { text: "从 URL 安装" });
    
    new Setting(contentEl)
      .setName("技能包 URL")
      .setDesc("输入技能包的 ZIP 文件 URL")
      .addText(text => {
        text.setPlaceholder("https://example.com/skill.zip");
        text.inputEl.id = "skill-url-input";
      })
      .addButton(btn => {
        btn.setButtonText("安装")
          .setCta()
          .onClick(async () => {
            const input = contentEl.querySelector("#skill-url-input") as HTMLInputElement;
            const url = input?.value?.trim();
            
            if (!url) {
              new Notice("请输入 URL");
              return;
            }
            
            const githubMirror = this.plugin.settings.githubMirror;
            const success = await this.plugin.skillRegistry.installSkillFromUrl(url, githubMirror);
            
            if (success) {
              this.close();
              this.onInstalled();
            }
          });
      });
    
    // 从本地文件安装
    contentEl.createEl("h3", { text: "从本地文件安装" });
    
    const fileInput = contentEl.createEl("input", {
      type: "file",
      attr: { accept: ".zip" }
    });
    
    const uploadBtn = contentEl.createEl("button", {
      text: "选择文件并安装",
      cls: "mod-cta"
    });
    
    uploadBtn.addEventListener("click", () => {
      fileInput.click();
    });
    
    fileInput.addEventListener("change", async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      
      const success = await this.plugin.skillRegistry.installSkillFromFile(file);
      
      if (success) {
        this.close();
        this.onInstalled();
      }
    });
    
    // 取消按钮
    const cancelBtn = contentEl.createEl("button", { text: "取消" });
    cancelBtn.addEventListener("click", () => {
      this.close();
    });
  }
  
  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

/**
 * 技能详情对话框
 */
class SkillDetailModal extends Modal {
  private skill: Skill;
  
  constructor(app: App, skill: Skill) {
    super(app);
    this.skill = skill;
  }
  
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("skill-detail-modal");
    
    // 标题
    const header = contentEl.createDiv({ cls: "skill-detail-header" });
    if (this.skill.icon) {
      header.createSpan({ text: this.skill.icon, cls: "skill-detail-icon" });
    }
    header.createEl("h2", { text: this.skill.name });
    
    // 基本信息
    const info = contentEl.createDiv({ cls: "skill-detail-info" });
    
    this.addInfoRow(info, "ID", this.skill.id);
    this.addInfoRow(info, "版本", this.skill.version);
    if (this.skill.author) {
      this.addInfoRow(info, "作者", this.skill.author);
    }
    this.addInfoRow(info, "来源", this.getSourceLabel(this.skill.source));
    this.addInfoRow(info, "状态", this.skill.enabled !== false ? "✅ 已启用" : "❌ 已禁用");
    
    // 描述
    if (this.skill.description) {
      contentEl.createEl("h3", { text: "描述" });
      contentEl.createEl("p", { text: this.skill.description });
    }
    
    // 标签
    if (this.skill.tags && this.skill.tags.length > 0) {
      contentEl.createEl("h3", { text: "标签" });
      const tagsContainer = contentEl.createDiv({ cls: "skill-detail-tags" });
      for (const tag of this.skill.tags) {
        tagsContainer.createSpan({ text: tag, cls: "skill-tag" });
      }
    }
    
    // 触发器
    if (this.skill.triggers && this.skill.triggers.length > 0) {
      contentEl.createEl("h3", { text: "触发器" });
      const triggersList = contentEl.createEl("ul");
      for (const trigger of this.skill.triggers) {
        const value = Array.isArray(trigger.value) ? trigger.value.join(", ") : trigger.value;
        triggersList.createEl("li", { text: `${trigger.type}: ${value}` });
      }
    }
    
    // 步骤
    contentEl.createEl("h3", { text: `执行步骤 (${this.skill.steps.length})` });
    const stepsList = contentEl.createEl("ol");
    for (const step of this.skill.steps) {
      stepsList.createEl("li", { text: `${step.name} (${step.type})` });
    }
    
    // 所需工具
    if (this.skill.requiredTools && this.skill.requiredTools.length > 0) {
      contentEl.createEl("h3", { text: "所需工具" });
      const toolsList = contentEl.createEl("ul");
      for (const tool of this.skill.requiredTools) {
        toolsList.createEl("li", { text: tool });
      }
    }
    
    // 关闭按钮
    const closeBtn = contentEl.createEl("button", { text: "关闭", cls: "mod-cta" });
    closeBtn.addEventListener("click", () => {
      this.close();
    });
  }
  
  private addInfoRow(container: HTMLElement, label: string, value: string) {
    const row = container.createDiv({ cls: "skill-detail-row" });
    row.createSpan({ text: label + ":", cls: "skill-detail-label" });
    row.createSpan({ text: value, cls: "skill-detail-value" });
  }
  
  private getSourceLabel(source: string): string {
    const labels: Record<string, string> = {
      builtin: "内置",
      local: "本地",
      community: "社区",
      remote: "远程"
    };
    return labels[source] || source;
  }
  
  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
