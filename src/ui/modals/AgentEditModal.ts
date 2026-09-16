import { App, Modal, Setting, Notice } from "obsidian";
import { Agent } from "../../features/agent/types";
import type { IPluginContext } from "../../core/plugin-context";;
import { MBTI_TYPES, MBTI_DESCRIPTIONS } from "../../services/llm/mbti";

export class AgentEditModal extends Modal {
  private agent: Agent;
  private availableTools: string[];
  private onSubmit: (agent: Agent) => void;
  private plugin: IPluginContext;

  constructor(app: App, plugin: IPluginContext, agent: Agent | null, availableTools: string[], onSubmit: (agent: Agent) => void) {
    super(app);
    this.plugin = plugin;
    this.agent = agent || {
      id: `agent-${Date.now()}`,
      name: "",
      description: "",
      systemPrompt: "",
      tools: []
    };
    this.availableTools = availableTools;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: this.agent.name ? "编辑智能体" : "新建智能体" });

    new Setting(contentEl)
      .setName("名称")
      .setDesc("智能体的显示名称")
      .addText(text => text
        .setValue(this.agent.name)
        .onChange(value => this.agent.name = value));

    new Setting(contentEl)
      .setName("描述")
      .setDesc("简短描述智能体的功能")
      .addText(text => text
        .setValue(this.agent.description)
        .onChange(value => this.agent.description = value));

    new Setting(contentEl)
      .setName("系统提示词 (System Prompt)")
      .setDesc("定义智能体的角色和行为准则")
      .addTextArea(text => text
        .setValue(this.agent.systemPrompt)
        .setPlaceholder("你是一个...")
        .onChange(value => this.agent.systemPrompt = value));

    new Setting(contentEl)
      .setName("开场白")
      .setDesc("切换到此智能体时，新对话显示的开场白（可选）")
      .addTextArea(text => text
        .setValue(this.agent.greeting || "")
        .setPlaceholder("你好！我是xxx智能体，有什么可以帮助你的吗？")
        .onChange(value => this.agent.greeting = value || undefined));

    new Setting(contentEl)
      .setName("MBTI 性格注入")
      .setDesc("为智能体指定 MBTI 性格，将显著影响其对话风格和逻辑偏好。")
      .addDropdown(dropdown => {
        dropdown.addOption("", "无 (默认)");
        MBTI_TYPES.forEach(type => {
          dropdown.addOption(type, `${type} - ${MBTI_DESCRIPTIONS[type].split('：')[0]}`);
        });
        dropdown.setValue(this.agent.mbti || "");
        dropdown.onChange(value => this.agent.mbti = value);
      });
    
    contentEl.createEl("h3", { text: "可用工具" });
    const toolsContainer = contentEl.createDiv({ cls: "agent-tools-container" });
    toolsContainer.setCssStyles({ display: "grid" });
    toolsContainer.setCssStyles({ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" });
    toolsContainer.setCssStyles({ gap: "10px" });
    toolsContainer.setCssStyles({ marginBottom: "20px" });

    this.availableTools.forEach(toolName => {
      const toolDiv = toolsContainer.createDiv();
      toolDiv.setCssStyles({ display: "flex" });
      toolDiv.setCssStyles({ alignItems: "center" });
      
      const checkbox = toolDiv.createEl("input", { type: "checkbox" });
      checkbox.checked = this.agent.tools.includes(toolName);
      checkbox.id = `tool-${toolName}`;
      
      const labelText = this.plugin.agentManager.getToolLabel(toolName);
      const label = toolDiv.createEl("label", { text: labelText });
      label.htmlFor = `tool-${toolName}`;
      label.setCssStyles({ marginLeft: "5px" });
      label.title = toolName; // Show ID on hover

      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          if (!this.agent.tools.includes(toolName)) {
            this.agent.tools.push(toolName);
          }
        } else {
          this.agent.tools = this.agent.tools.filter(t => t !== toolName);
        }
      });
    });

    new Setting(contentEl)
      .addButton(btn => btn
        .setButtonText("保存")
        .setCta()
        .onClick(() => {
          if (!this.agent.name || !this.agent.systemPrompt) {
            new Notice("名称和系统提示词不能为空");
            return;
          }
          this.onSubmit(this.agent);
          this.close();
        }));
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
