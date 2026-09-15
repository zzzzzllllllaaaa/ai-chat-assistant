import { App, Modal, TextComponent, setIcon, TFile } from "obsidian";
import type { IPluginContext } from "../../core/plugin-context";;
import { Persona } from "../../core/settings";

export type RolePickerMode = "persona" | "agent";

type RoleItem = {
  id: string;
  name: string;
  description?: string;
  avatar?: string;
};

export class RolePickerModal extends Modal {
  private plugin: IPluginContext;
  private mode: RolePickerMode;
  private onSelect: (id: string) => void;
  private query = "";
  private listEl: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;

  constructor(app: App, plugin: IPluginContext, mode: RolePickerMode, onSelect: (id: string) => void) {
    super(app);
    this.plugin = plugin;
    this.mode = mode;
    this.onSelect = onSelect;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("role-picker-modal");

    const title = this.mode === "agent" ? "选择智能体" : "选择角色";
    contentEl.createEl("h2", { text: title });

    const toolbar = contentEl.createDiv({ cls: "role-picker-toolbar" });
    const search = new TextComponent(toolbar);
    search.setPlaceholder(this.mode === "agent" ? "搜索智能体..." : "搜索角色...");
    search.onChange((value) => {
      this.query = String(value || "").trim().toLowerCase();
      this.renderList();
    });

    this.countEl = toolbar.createDiv({ cls: "role-picker-count" });

    this.listEl = contentEl.createDiv({ cls: "role-picker-list" });
    this.renderList();
  }

  private getPinnedIds(): string[] {
    return this.mode === "agent"
      ? Array.isArray(this.plugin.settings.pinnedAgentIds) ? this.plugin.settings.pinnedAgentIds : []
      : Array.isArray(this.plugin.settings.pinnedPersonaIds) ? this.plugin.settings.pinnedPersonaIds : [];
  }

  private async setPinnedIds(ids: string[]): Promise<void> {
    if (this.mode === "agent") {
      this.plugin.settings.pinnedAgentIds = ids;
    } else {
      this.plugin.settings.pinnedPersonaIds = ids;
    }
    await this.plugin.saveSettings();
  }

  private getItems(): RoleItem[] {
    if (this.mode === "agent") {
      return this.plugin.agentManager.getAllAgents().map((agent) => ({
        id: agent.id,
        name: agent.name || "未命名智能体",
        description: agent.description || "",
      }));
    }

    return (this.plugin.settings.personas || []).map((p: Persona) => ({
      id: p.id,
      name: p.name || "未命名角色",
      description: p.description || "",
      avatar: p.avatar,
    }));
  }

  private getCurrentId(): string {
    return this.mode === "agent"
      ? String(this.plugin.settings.activeAgentId || "")
      : String(this.plugin.settings.activePersonaId || "");
  }

  private renderList() {
    if (!this.listEl) return;
    this.listEl.empty();

    const pinnedIds = new Set(this.getPinnedIds());
    const items = this.getItems()
      .filter((item) => {
        if (!this.query) return true;
        const hay = `${item.name} ${item.description || ""}`.toLowerCase();
        return hay.includes(this.query);
      })
      .sort((a, b) => {
        const ap = pinnedIds.has(a.id) ? 1 : 0;
        const bp = pinnedIds.has(b.id) ? 1 : 0;
        if (ap !== bp) return bp - ap;
        return a.name.localeCompare(b.name, "zh-Hans-CN", { sensitivity: "base" });
      });

    if (this.countEl) {
      this.countEl.textContent = `${items.length} 个`;
    }

    if (items.length === 0) {
      const empty = this.listEl.createDiv({ cls: "role-picker-empty" });
      empty.createEl("div", { text: "没有匹配的结果" });
      return;
    }

    const currentId = this.getCurrentId();

    items.forEach((item) => {
      const row = this.listEl!.createDiv({ cls: "role-picker-item" });
      if (item.id === currentId) row.addClass("is-active");
      if (pinnedIds.has(item.id)) row.addClass("is-pinned");

      const left = row.createDiv({ cls: "role-picker-left" });
      const avatarWrap = left.createDiv({ cls: "role-picker-avatar" });
      const avatarSrc = this.resolveAvatarSrc(item.avatar);
      if (avatarSrc) {
        const img = avatarWrap.createEl("img", { cls: "role-picker-avatar-img" });
        img.src = avatarSrc;
        img.onerror = () => {
          img.remove();
          avatarWrap.createDiv({ cls: "role-picker-avatar-fallback", text: this.getInitials(item.name) });
        };
      } else {
        avatarWrap.createDiv({ cls: "role-picker-avatar-fallback", text: this.getInitials(item.name) });
      }

      const meta = left.createDiv({ cls: "role-picker-meta" });
      meta.createDiv({ cls: "role-picker-name", text: item.name });
      if (item.description) {
        meta.createDiv({ cls: "role-picker-desc", text: item.description });
      }

      const actions = row.createDiv({ cls: "role-picker-actions" });
      const pinBtn = actions.createEl("button", { cls: "role-picker-pin", attr: { "aria-label": "置顶" } });
      setIcon(pinBtn, pinnedIds.has(item.id) ? "star" : "star-off");
      pinBtn.onclick = async (evt) => {
        evt.stopPropagation();
        const next = new Set(this.getPinnedIds());
        if (next.has(item.id)) {
          next.delete(item.id);
        } else {
          next.add(item.id);
        }
        await this.setPinnedIds(Array.from(next));
        this.renderList();
      };

      row.onclick = () => {
        this.onSelect(item.id);
        this.close();
      };
    });
  }

  private getInitials(name: string): string {
    const text = String(name || "").trim();
    if (!text) return "?";
    return text.length > 2 ? text.slice(0, 2) : text;
  }

  private resolveAvatarSrc(avatar?: string): string | null {
    const value = String(avatar || "").trim();
    if (!value) return null;
    if (value.startsWith("http") || value.startsWith("data:image")) return value;

    const file = this.app.vault.getAbstractFileByPath(value);
    if (file instanceof TFile) {
      return this.app.vault.getResourcePath(file);
    }
    return value;
  }
}
