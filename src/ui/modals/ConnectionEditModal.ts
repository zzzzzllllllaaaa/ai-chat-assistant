import { App, Modal, Setting, Notice, ButtonComponent, TextComponent } from "obsidian";
import type { AIConnection } from "../../core/settings";
import type { LLMConnectionConfig, TestConnectionResult } from "../../services/llm/types";
import { safeNotice } from "../../utils/notice";

/**
 * Simple input modal to replace browser's prompt() which is not supported in Obsidian desktop.
 */
class InputModal extends Modal {
  private result: string = '';
  private onSubmit: (result: string | null) => void;
  private title: string;
  private placeholder: string;

  constructor(app: App, title: string, placeholder: string, onSubmit: (result: string | null) => void) {
    super(app);
    this.title = title;
    this.placeholder = placeholder;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: this.title });

    let inputComponent: TextComponent;
    new Setting(contentEl)
      .setName('模型名称')
      .addText(text => {
        inputComponent = text;
        text.setPlaceholder(this.placeholder)
          .onChange(value => this.result = value);
        // Auto focus and handle Enter key
        setTimeout(() => text.inputEl.focus(), 10);
        text.inputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            this.submitAndClose();
          }
        });
      });

    new Setting(contentEl)
      .addButton(btn => btn
        .setButtonText('确定')
        .setCta()
        .onClick(() => this.submitAndClose()))
      .addButton(btn => btn
        .setButtonText('取消')
        .onClick(() => {
          this.onSubmit(null);
          this.close();
        }));
  }

  private submitAndClose() {
    this.onSubmit(this.result);
    this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}

/**
 * Simple confirm modal to replace browser's confirm() which is not supported in Obsidian desktop.
 */
class ConfirmModal extends Modal {
  private onConfirm: (confirmed: boolean) => void;
  private message: string;

  constructor(app: App, message: string, onConfirm: (confirmed: boolean) => void) {
    super(app);
    this.message = message;
    this.onConfirm = onConfirm;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('p', { text: this.message });

    new Setting(contentEl)
      .addButton(btn => btn
        .setButtonText('确定')
        .setCta()
        .onClick(() => {
          this.onConfirm(true);
          this.close();
        }))
      .addButton(btn => btn
        .setButtonText('取消')
        .onClick(() => {
          this.onConfirm(false);
          this.close();
        }));
  }

  onClose() {
    this.contentEl.empty();
  }
}

export interface ConnectionEditServices {
  testConnection: (connection: LLMConnectionConfig) => Promise<TestConnectionResult>;
  listModels: (connection: LLMConnectionConfig) => Promise<string[]>;
  getBoundModels: (connectionId: string) => string[];
  /**
   * Apply model bindings for the connection.
   * - Should be deterministic.
   * - `models` should be normalized before passing in.
   */
  setBoundModels: (connectionId: string, models: string[]) => Promise<void>;
}

export class ConnectionEditModal extends Modal {
  private connection: AIConnection;
  private onSubmit: (connection: AIConnection) => void;
  private services: ConnectionEditServices;
  private onDelete?: () => Promise<void>;

  private models: string[] = [];
  private modelListEl!: HTMLElement;
  private statusEl!: HTMLElement;

  constructor(
    app: App,
    services: ConnectionEditServices,
    connection: AIConnection | undefined,
    onSubmit: (connection: AIConnection) => void,
    onDelete?: () => Promise<void>
  ) {
    super(app);
    this.services = services;
    this.connection = connection || {
      id: Date.now().toString(),
      name: "",
      baseUrl: "",
      apiKey: "",
      enabled: true,
    };
    this.onSubmit = onSubmit;
    this.onDelete = onDelete;

    this.models = Array.from(
      new Set(
        (this.services.getBoundModels(this.connection.id) || [])
          .map(m => String(m || '').trim())
          .filter(Boolean)
      )
    );
  }

  private normalizeBaseUrl(url: string): string {
    return String(url || '').trim().replace(/\/$/, "");
  }

  private setStatus(text: string) {
    if (!this.statusEl) return;
    this.statusEl.empty();
    // 支持多行展示
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (i > 0) this.statusEl.createEl('br');
      this.statusEl.appendText(line);
    });
    this.statusEl.setCssStyles({ whiteSpace: 'pre-wrap' });
  }

  private renderModelList() {
    if (!this.modelListEl) return;
    this.modelListEl.empty();

    if (this.models.length === 0) {
      this.modelListEl.createEl('div', { text: '暂无模型绑定。可手动添加，或点击“拉取模型”。', cls: 'text-muted' });
      return;
    }

    this.models.forEach((model) => {
      const row = this.modelListEl.createDiv({ cls: 'ai-conn-model-row' });
      row.createDiv({ text: model, cls: 'ai-conn-model-name' });
      new ButtonComponent(row)
        .setIcon('play')
        .setTooltip('测试该模型（发送一条简短消息验证模型是否可用）')
        .onClick(async (evt) => {
          const btn = (evt.target as HTMLElement)?.closest('button');
          if (btn) (btn as HTMLButtonElement).disabled = true;
          const baseUrl = this.normalizeBaseUrl(this.connection.baseUrl);
          if (!baseUrl) { new Notice('请先填写 Base URL'); return; }
          this.setStatus(`🔍 正在测试模型 "${model}"...`);
          try {
            const r = await this.services.testConnection({
              id: this.connection.id,
              name: this.connection.name,
              baseUrl,
              apiKey: this.connection.apiKey,
              testModel: model,
            });
            const lines: string[] = [];
            if (r.details?.connectivity) lines.push(`${r.details.connectivity.ok ? '✅' : '❌'} 连通性: ${r.details.connectivity.message}`);
            if (r.details?.auth) lines.push(`${r.details.auth.ok ? '✅' : '❌'} Key: ${r.details.auth.message}`);
            if (r.details?.chat) lines.push(`${r.details.chat.ok ? '✅' : '❌'} 对话: ${r.details.chat.message}`);
            this.setStatus(`${r.ok ? '✅' : '❌'} ${r.message}（${r.durationMs}ms）\n${lines.join('\n')}`);
          } catch (e: any) {
            this.setStatus(`❌ ${e?.message || String(e)}`);
          } finally {
            if (btn) (btn as HTMLButtonElement).disabled = false;
          }
        });
      new ButtonComponent(row)
        .setIcon('trash')
        .setTooltip('移除')
        .onClick(() => {
          this.models = this.models.filter(m => m !== model);
          this.renderModelList();
        });
    });
  }

  onOpen() {
    const { contentEl } = this;

    const root = contentEl.createDiv({ cls: 'ai-conn-modal' });

    const header = root.createDiv({ cls: 'ai-conn-modal-header' });
    header.createEl("h2", { text: this.connection.name ? "编辑连接" : "添加连接" });

    if (this.onDelete && this.connection?.id) {
      const del = new ButtonComponent(header);
      del.setIcon('trash').setTooltip('删除连接');
      del.onClick(async () => {
        if (!confirm(`确定要删除连接“${this.connection.name || '未命名'}”吗？`)) return;
        try {
          await this.onDelete?.();
          new Notice('已删除连接', 4000);
          this.close();
        } catch (e: any) {
          safeNotice(`删除失败：${e?.message || String(e)}`, 8000);
        }
      });
    }

    this.statusEl = root.createDiv({ cls: 'ai-conn-status text-muted' });
    this.setStatus('');

    new Setting(root)
      .setName("连接名称")
      .setDesc("例如：OpenAI / DeepSeek / Moonshot / 本地网关")
      .addText(text => {
        text
          .setPlaceholder("输入连接名称")
          .setValue(this.connection.name)
          .onChange(value => {
            this.connection.name = value.trim();
          });

        // 确保输入框可交互
        const el = text.inputEl;
        el.setCssStyles({ pointerEvents: 'auto' });
        el.setCssStyles({ cursor: 'text' });
        el.removeAttribute('disabled');
        el.removeAttribute('readonly');
      });

    new Setting(root)
      .setName("Base URL")
      .setDesc("例如：https://api.openai.com/v1 或 https://api.deepseek.com/v1（需要包含 /v1）")
      .addText(text => {
        text
          .setPlaceholder("输入 API Base URL")
          .setValue(this.connection.baseUrl)
          .onChange(value => {
            this.connection.baseUrl = value.trim();
            renderEndpointHint();
          });

        // 确保输入框可交互
        const el = text.inputEl;
        el.setCssStyles({ pointerEvents: 'auto' });
        el.setCssStyles({ cursor: 'text' });
        el.removeAttribute('disabled');
        el.removeAttribute('readonly');
      });

    // Show resolved endpoints as a compact hint
    const endpointHint = root.createDiv({ cls: 'ai-conn-endpoints text-muted' });
    const renderEndpointHint = () => {
      const base = this.normalizeBaseUrl(this.connection.baseUrl);
      if (!base) {
        endpointHint.setText('');
        return;
      }
      endpointHint.setText(`${base}/models\n${base}/chat/completions`);
    };
    renderEndpointHint();

    new Setting(root)
      .setName("API Key")
      .setDesc("可留空（如果你的网关不需要 Key）。")
      .addText(text => {
        text.setValue(this.connection.apiKey).onChange(value => (this.connection.apiKey = value));
        text.inputEl.type = "password";
        text.inputEl.autocomplete = 'off';
      })
      .addButton(btn =>
        btn
          .setButtonText('测试连接')
          .setCta()
          .onClick(async () => {
            const baseUrl = this.normalizeBaseUrl(this.connection.baseUrl);
            if (!baseUrl) {
              new Notice('请先填写 Base URL');
              return;
            }
            this.setStatus('🔍 正在全面测试连接...');
            btn.setDisabled(true);
            try {
              // 基础测试（连通性 + Key 验证）
              const r = await this.services.testConnection({
                id: this.connection.id,
                name: this.connection.name,
                baseUrl,
                apiKey: this.connection.apiKey,
              });

              // 构建详细结果展示
              const lines: string[] = [];
              if (r.details?.connectivity) {
                lines.push(`${r.details.connectivity.ok ? '✅' : '❌'} 连通性: ${r.details.connectivity.message}`);
              }
              if (r.details?.auth) {
                lines.push(`${r.details.auth.ok ? '✅' : '❌'} API Key: ${r.details.auth.message}`);
              }
              if (r.details?.model) {
                lines.push(`${r.details.model.ok ? '✅' : 'ℹ️'} 模型列表: ${r.details.model.message}`);
              }
              if (r.details?.chat) {
                lines.push(`${r.details.chat.ok ? '✅' : '⚠️'} 对话测试: ${r.details.chat.message}`);
              }

              const summary = `${r.ok ? '✅' : '❌'} ${r.message}（${r.durationMs}ms）`;
              this.setStatus(lines.length > 0 ? `${summary}\n${lines.join('\n')}` : summary);
            } catch (e: any) {
              this.setStatus(`❌ ${e?.message || String(e)}`);
            } finally {
              btn.setDisabled(false);
            }
          })
      );

    new Setting(root)
      .setName("启用")
      .addToggle(toggle => toggle.setValue(this.connection.enabled).onChange(v => (this.connection.enabled = v)));

    const modelHeader = root.createDiv({ cls: 'ai-conn-model-header' });
    modelHeader.createEl('h3', { text: '模型' });
    const modelActions = modelHeader.createDiv({ cls: 'ai-conn-model-actions' });

    new ButtonComponent(modelActions)
      .setButtonText('添加')
      .setTooltip('手动添加模型')
      .onClick(() => {
        new InputModal(
          this.app,
          '添加模型',
          'gpt-4o 或 deepseek-ai/DeepSeek-V3',
          (value) => {
            const model = String(value || '').trim();
            if (!model) return;
            this.models = Array.from(new Set([...this.models, model]));
            this.renderModelList();
          }
        ).open();
      });

    new ButtonComponent(modelActions)
      .setButtonText('清空')
      .setTooltip('清空该连接的模型绑定（仅在保存后生效）')
      .onClick(() => {
        new ConfirmModal(
          this.app,
          '确定要清空该连接的模型绑定吗？（仅在保存后生效）',
          (confirmed) => {
            if (!confirmed) return;
            this.models = [];
            this.renderModelList();
          }
        ).open();
      });

    new ButtonComponent(modelActions)
      .setButtonText('拉取模型')
      .setCta()
      .setTooltip('从服务商拉取模型列表（不会抢占其它连接已绑定的同名模型）')
      .onClick(async () => {
        const baseUrl = this.normalizeBaseUrl(this.connection.baseUrl);
        if (!baseUrl) {
          new Notice('请先填写 Base URL');
          return;
        }

        this.setStatus('正在拉取模型列表...');
        try {
          const fetched = await this.services.listModels({
            id: this.connection.id,
            name: this.connection.name,
            baseUrl,
            apiKey: this.connection.apiKey,
          });

          const normalized = Array.from(new Set(fetched.map(m => String(m || '').trim()).filter(Boolean)));

          // Safe behavior: don't steal models bound to other connections.
          const currentlyBound = new Set(this.services.getBoundModels(this.connection.id));

          // We can't query "bound elsewhere" directly from service, so infer via setBoundModels behavior is external.
          // Here we keep what we already have + fetched, and let save step resolve conflicts.
          const next = Array.from(new Set([...Array.from(currentlyBound), ...normalized]));
          this.models = next;
          this.renderModelList();
          this.setStatus(`✅ 拉取完成：获取 ${normalized.length} 个模型（待保存后写入绑定）`);
        } catch (e: any) {
          this.setStatus(`❌ 拉取失败：${e?.message || String(e)}`);
        }
      });

    this.modelListEl = root.createDiv({ cls: 'ai-conn-model-list' });
    this.renderModelList();

    new Setting(root).addButton(btn =>
      btn
        .setButtonText("保存")
        .setCta()
        .onClick(() => {
          if (!this.connection.name || !this.connection.baseUrl) {
            new Notice("请填写连接名称与 Base URL");
            return;
          }

          // Persist model bindings first (deterministic behavior decided by caller).
          const normalizedModels = Array.from(
            new Set(this.models.map(m => String(m || '').trim()).filter(Boolean))
          );
          this.services
            .setBoundModels(this.connection.id, normalizedModels)
            .then(() => {
              this.onSubmit(this.connection);
              this.close();
            })
            .catch((e: any) => {
              safeNotice(`保存模型绑定失败：${e?.message || String(e)}`);
            });
        })
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}
