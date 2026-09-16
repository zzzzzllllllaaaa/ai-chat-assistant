import { App, Modal, Setting, Notice, ButtonComponent } from "obsidian";
import type { IPluginContext } from "../../core/plugin-context";;
import { Persona } from "../../core/settings";
import { MBTI_TYPES, MBTI_DESCRIPTIONS } from "../../services/llm/mbti";

export class PersonaManagerModal extends Modal {
    plugin: IPluginContext;
    personas: Persona[];

    constructor(app: App, plugin: IPluginContext) {
        super(app);
        this.plugin = plugin;
        this.personas = this.plugin.settings.personas;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: "角色管理 (Persona Management)" });

        new Setting(contentEl)
            .setName("添加新角色")
            .setDesc("创建一个新的 AI 角色")
            .addButton(btn => btn
                .setButtonText("添加角色")
                .setCta()
                .onClick(() => {
                    this.openEditModal(null);
                }));

        const listContainer = contentEl.createDiv();
        
        this.renderList(listContainer);
    }

    renderList(container: HTMLElement) {
        container.empty();
        this.personas.forEach((persona, index) => {
            const setting = new Setting(container)
                .setName(persona.name)
                .setDesc(persona.description || "无描述");

            setting.addButton(btn => btn
                .setIcon("pencil")
                .setTooltip("编辑")
                .onClick(() => {
                    this.openEditModal(persona);
                }));

            setting.addButton(btn => btn
                .setIcon("trash")
                .setTooltip("删除")
                .setWarning()
                .onClick(async () => {
                    if (confirm(`确定要删除角色 "${persona.name}" 吗？`)) {
                        this.personas.splice(index, 1);
                        await this.plugin.saveSettings();
                        this.renderList(container);
                    }
                }));
        });
    }

    openEditModal(persona: Persona | null) {
        new PersonaEditModal(this.app, this.plugin, persona, async (newPersona) => {
            if (persona) {
                // Edit
                const index = this.personas.findIndex(p => p.id === persona.id);
                if (index !== -1) {
                    this.personas[index] = newPersona;
                }
            } else {
                // Add
                this.personas.push(newPersona);
            }
            await this.plugin.saveSettings();
            this.onOpen(); // Refresh
        }).open();
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class PersonaEditModal extends Modal {
    plugin: IPluginContext;
    persona: Persona;
    onSubmit: (persona: Persona) => void;

    constructor(app: App, plugin: IPluginContext, persona: Persona | null, onSubmit: (persona: Persona) => void) {
        super(app);
        this.plugin = plugin;
        this.onSubmit = onSubmit;
        this.persona = persona ? { ...persona } : {
            id: Date.now().toString(),
            name: "新角色",
            description: "",
            systemPrompt: "你是一个有用的助手。",
            avatar: ""
        };
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: this.persona.id ? "编辑角色" : "新建角色" });

        new Setting(contentEl)
            .setName("角色名称")
            .addText(text => text
                .setValue(this.persona.name)
                .onChange(value => this.persona.name = value));

        new Setting(contentEl)
            .setName("描述")
            .addText(text => text
                .setValue(this.persona.description)
                .onChange(value => this.persona.description = value));

        new Setting(contentEl)
            .setName("系统提示词 (System Prompt)")
            .setDesc("定义角色的性格、行为和能力。")
            .addTextArea(text => text
                .setValue(this.persona.systemPrompt)
                .setPlaceholder("你是一个...")
                .onChange(value => this.persona.systemPrompt = value)
                .inputEl.rows = 10);

        new Setting(contentEl)
            .setName("MBTI 性格注入")
            .setDesc("为角色指定 MBTI 性格，将显著影响其对话风格和逻辑偏好。")
            .addDropdown(dropdown => {
                dropdown.addOption("", "无 (默认)");
                MBTI_TYPES.forEach(type => {
                    dropdown.addOption(type, `${type} - ${MBTI_DESCRIPTIONS[type].split('：')[0]}`);
                });
                dropdown.setValue(this.persona.mbti || "");
                dropdown.onChange(value => this.persona.mbti = value);
            });
        
        // Avatar URL (Optional)
        new Setting(contentEl)
            .setName("头像 URL (可选)")
            .addText(text => text
                .setValue(this.persona.avatar || "")
                .onChange(value => this.persona.avatar = value));

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText("保存")
                .setCta()
                .onClick(() => {
                    this.onSubmit(this.persona);
                    this.close();
                }))
            .addButton(btn => btn
                .setButtonText("取消")
                .onClick(() => this.close()));
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
