import { App, Modal, Setting, Notice } from "obsidian";
import { AIProvider } from "../../core/settings";

export class ProviderEditModal extends Modal {
  private provider: AIProvider;
  private onSubmit: (provider: AIProvider) => void;

  constructor(app: App, provider: AIProvider | undefined, onSubmit: (provider: AIProvider) => void) {
    super(app);
    this.provider = provider || {
      id: Date.now().toString(),
      name: "",
      baseUrl: "",
      apiKey: "",
      models: []
    };
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: this.provider.name ? "编辑提供商" : "添加提供商" });

    new Setting(contentEl)
      .setName("提供商名称")
      .setDesc("例如: DeepSeek, Moonshot")
      .addText(text => text
        .setValue(this.provider.name)
        .onChange(value => this.provider.name = value));

    new Setting(contentEl)
      .setName("API 地址 (Base URL)")
      .setDesc("例如: https://api.deepseek.com/v1")
      .addText(text => text
        .setValue(this.provider.baseUrl)
        .onChange(value => this.provider.baseUrl = value));

    new Setting(contentEl)
      .setName("API Key")
      .addText(text => text
        .setValue(this.provider.apiKey)
        .onChange(value => this.provider.apiKey = value)
        .inputEl.type = "password");

    new Setting(contentEl)
      .setName("模型列表")
      .setDesc("用英文逗号分隔，例如: deepseek-chat,deepseek-coder")
      .addTextArea(text => text
        .setValue(this.provider.models.join(","))
        .onChange(value => {
          this.provider.models = value.split(",").map(s => s.trim()).filter(Boolean);
        }));

    new Setting(contentEl)
      .addButton(btn => btn
        .setButtonText("保存")
        .setCta()
        .onClick(() => {
          if (!this.provider.name || !this.provider.baseUrl || !this.provider.apiKey) {
            new Notice("请填写完整信息");
            return;
          }
          this.onSubmit(this.provider);
          this.close();
        }));
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
