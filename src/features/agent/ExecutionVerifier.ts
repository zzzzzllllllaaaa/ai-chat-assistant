import { App, TFile, TFolder } from "obsidian";

export interface VerificationResult {
  ok: boolean;
  summary: string;
  details?: string[];
}

export class ExecutionVerifier {
  constructor(private app: App) {}

  public async verify(toolName: string, args: any, result: string): Promise<VerificationResult | null> {
    const rawResult = String(result || "");
    if (!rawResult || /^错误[:：]/.test(rawResult) || /失败/.test(rawResult)) {
      return null;
    }

    switch (toolName) {
      case "create_note":
        return await this.verifyCreateNote(args);
      case "modify_note":
      case "append_to_note":
      case "prepend_to_note":
        return await this.verifyNoteContains(args?.path, args?.content, toolName);
      case "replace_in_note":
        return await this.verifyReplaceInNote(args);
      case "create_folder":
        return this.verifyCreateFolder(args);
      case "move_item":
        return this.verifyMoveItem(args);
      case "delete_file":
        return this.verifyDeleteFile(args);
      case "update_properties":
        return this.verifyUpdateProperties(args);
      case "create_canvas":
      case "create_canvas_mindmap":
      case "modify_canvas":
        return await this.verifyCanvas(args, toolName);
      default:
        return null;
    }
  }

  public appendToToolResult(toolResult: string, verification: VerificationResult | null): string {
    if (!verification) return toolResult;
    const lines = [`[Verify] ${verification.ok ? "通过" : "失败"}: ${verification.summary}`];
    if (verification.details && verification.details.length > 0) {
      for (const line of verification.details) lines.push(`- ${line}`);
    }
    return `${toolResult}\n\n${lines.join("\n")}`;
  }

  private async verifyCreateNote(args: any): Promise<VerificationResult> {
    const path = this.resolveMarkdownPath(args?.path);
    if (!path) return { ok: false, summary: "缺少 path，无法验证 create_note 结果。" };
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      return { ok: false, summary: `未找到新建笔记 ${path}` };
    }
    return { ok: true, summary: `已确认笔记存在：${file.path}` };
  }

  private async verifyNoteContains(pathLike: any, expectedText: any, toolName: string): Promise<VerificationResult> {
    const path = this.resolveMarkdownPath(pathLike);
    if (!path) return { ok: false, summary: `缺少 path，无法验证 ${toolName}。` };
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return { ok: false, summary: `目标笔记不存在：${path}` };
    const content = await this.app.vault.read(file);
    const snippet = this.normalizeSnippet(expectedText);
    if (!snippet) {
      return { ok: true, summary: `已确认目标笔记可读取：${file.path}` };
    }
    const normalizedContent = content.replace(/\s+/g, " ");
    if (normalizedContent.includes(snippet)) {
      return { ok: true, summary: `已确认目标内容写入：${file.path}` };
    }
    return {
      ok: false,
      summary: `未在 ${file.path} 中找到预期写入片段`,
      details: [`期望片段: ${snippet.substring(0, 80)}`],
    };
  }

  private async verifyReplaceInNote(args: any): Promise<VerificationResult> {
    const path = this.resolveMarkdownPath(args?.path);
    if (!path) return { ok: false, summary: "缺少 path，无法验证 replace_in_note。" };
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return { ok: false, summary: `目标笔记不存在：${path}` };
    const content = await this.app.vault.read(file);
    const normalizedContent = content.replace(/\s+/g, " ");
    const newText = this.normalizeSnippet(args?.newText);
    const oldText = this.normalizeSnippet(args?.oldText);
    
    const isNewTextFound = newText && normalizedContent.includes(newText);
    const isOldTextGone = !oldText || !normalizedContent.includes(oldText);
    const isOldTextInNewText = oldText && newText && newText.includes(oldText);

    if (isNewTextFound && (isOldTextGone || isOldTextInNewText)) {
      return { ok: true, summary: `已确认替换结果写回：${file.path}` };
    }
    return {
      ok: false,
      summary: `替换验证未通过：${file.path}`,
      details: [
        newText ? `新内容命中: ${isNewTextFound}` : "未提供 newText",
        oldText ? `旧内容仍存在: ${!isOldTextGone}` : "未提供 oldText",
      ],
    };
  }

  private verifyCreateFolder(args: any): VerificationResult {
    const path = String(args?.path || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (!path) return { ok: false, summary: "缺少 path，无法验证 create_folder。" };
    const folder = this.app.vault.getAbstractFileByPath(path);
    if (folder instanceof TFolder) {
      return { ok: true, summary: `已确认文件夹存在：${path}` };
    }
    return { ok: false, summary: `未找到新建文件夹：${path}` };
  }

  private verifyMoveItem(args: any): VerificationResult {
    const sourcePath = String(args?.sourcePath || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
    const destinationPath = String(args?.destinationPath || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (!sourcePath || !destinationPath) {
      return { ok: false, summary: "缺少 sourcePath 或 destinationPath，无法验证 move_item。" };
    }
    const source = this.app.vault.getAbstractFileByPath(sourcePath) || this.app.vault.getAbstractFileByPath(this.resolveMarkdownPath(sourcePath));
    const destination = this.app.vault.getAbstractFileByPath(destinationPath) || this.app.vault.getAbstractFileByPath(this.resolveMarkdownPath(destinationPath));
    if (!source && destination) {
      return { ok: true, summary: `已确认目标存在且源路径已消失：${destinationPath}` };
    }
    return {
      ok: false,
      summary: `移动验证未通过`,
      details: [`源路径仍存在: ${Boolean(source)}`, `目标路径存在: ${Boolean(destination)}`],
    };
  }

  private verifyDeleteFile(args: any): VerificationResult {
    const path = String(args?.path || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (!path) return { ok: false, summary: "缺少 path，无法验证 delete_file。" };
    const direct = this.app.vault.getAbstractFileByPath(path);
    const md = this.app.vault.getAbstractFileByPath(this.resolveMarkdownPath(path));
    if (!direct && !md) {
      return { ok: true, summary: `已确认文件不存在：${path}` };
    }
    return { ok: false, summary: `删除验证未通过，文件仍存在：${path}` };
  }

  private verifyUpdateProperties(args: any): VerificationResult {
    const path = this.resolveMarkdownPath(args?.path);
    if (!path) return { ok: false, summary: "缺少 path，无法验证 update_properties。" };
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return { ok: false, summary: `目标笔记不存在：${path}` };
    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter = cache?.frontmatter || {};
    const expected = args?.properties || {};
    const details: string[] = [];
    let ok = true;
    for (const [key, value] of Object.entries(expected)) {
      const exists = Object.prototype.hasOwnProperty.call(frontmatter, key);
      if (value === null) {
        if (exists) {
          ok = false;
          details.push(`属性 ${key} 仍存在`);
        }
      } else if (!exists || String((frontmatter as any)[key]) !== String(value)) {
        ok = false;
        details.push(`属性 ${key} 期望=${String(value)} 实际=${String((frontmatter as any)[key])}`);
      }
    }
    return ok
      ? { ok: true, summary: `已确认属性更新写回：${file.path}` }
      : { ok: false, summary: `属性验证未通过：${file.path}`, details };
  }

  private async verifyCanvas(args: any, toolName: string): Promise<VerificationResult> {
    const rawPath = toolName === "create_canvas_mindmap" ? `${String(args?.filename || "").trim()}.canvas` : String(args?.path || "").trim();
    const path = this.resolveCanvasPath(rawPath);
    if (!path) return { ok: false, summary: `缺少路径，无法验证 ${toolName}。` };
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return { ok: false, summary: `未找到 Canvas 文件：${path}` };
    try {
      const content = await this.app.vault.read(file);
      const parsed = JSON.parse(content);
      const nodes = Array.isArray(parsed?.nodes) ? parsed.nodes.length : 0;
      return { ok: true, summary: `已确认 Canvas 可读取：${file.path}`, details: [`nodes=${nodes}`] };
    } catch (e: any) {
      return { ok: false, summary: `Canvas 验证失败：${path}`, details: [e?.message || String(e)] };
    }
  }

  private resolveMarkdownPath(pathLike: any): string {
    const raw = String(pathLike || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (!raw) return "";
    return raw.toLowerCase().endsWith(".md") ? raw : `${raw}.md`;
  }

  private resolveCanvasPath(pathLike: any): string {
    const raw = String(pathLike || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (!raw) return "";
    return raw.toLowerCase().endsWith(".canvas") ? raw : `${raw}.canvas`;
  }

  private normalizeSnippet(value: any): string {
    if (typeof value !== "string") return "";
    // 将连续空白归一化为单个空格，避免因缩进/换行差异导致验证失败
    return value.replace(/\s+/g, " ").trim();
  }
}
