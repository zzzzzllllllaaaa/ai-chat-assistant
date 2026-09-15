import { App, TFile, TFolder } from "obsidian";
import type { Tool } from "../types";

function toNonEmptyTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeVaultPath(value: unknown): string | null {
  const raw = toNonEmptyTrimmedString(value);
  if (!raw) return null;
  // Obsidian vault paths are POSIX-style. Guard against accidental Windows paths.
  return raw.replace(/\\/g, "/");
}

function ensureMarkdownExtension(path: string): string {
  return path.toLowerCase().endsWith(".md") ? path : `${path}.md`;
}

/**
 * 获取笔记结构工具 - 返回标题树，帮助精准定位
 */
export class GetNoteStructureTool implements Tool {
  definition = {
    name: "get_note_structure",
    description: "获取笔记的结构概览，包括标题层级、行号范围。在修改笔记前先调用此工具了解结构，以便精准定位要修改的部分。",
    parameters: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "笔记的文件路径",
        },
        includePreview: {
          type: "boolean",
          description: "（可选）是否包含每个段落的前几行预览，默认 true",
        },
      },
      required: ["path"],
    },
  };

  async execute(args: { path: string; includePreview?: boolean }, app: App): Promise<string> {
    const path = normalizeVaultPath((args as any)?.path);
    if (!path) {
      return `错误: get_note_structure 缺少必填参数 path (string)`;
    }
    
    const file = app.metadataCache.getFirstLinkpathDest(path, "") || 
                 app.vault.getAbstractFileByPath(path) ||
                 app.vault.getAbstractFileByPath(path + ".md");

    if (!file || !(file instanceof TFile)) {
      return `错误: 找不到文件 "${path}"`;
    }

    try {
      const content = await app.vault.read(file);
      const lines = content.split('\n');
      const includePreview = args.includePreview !== false;
      
      const structure: Array<{
        level: number;
        title: string;
        lineStart: number;
        lineEnd: number;
        preview?: string;
      }> = [];
      
      // 解析标题结构
      const headings: Array<{ level: number; title: string; lineIdx: number }> = [];
      
      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(/^(#{1,6})\s+(.+)$/);
        if (match) {
          headings.push({
            level: match[1].length,
            title: match[2].trim(),
            lineIdx: i,
          });
        }
      }
      
      // 计算每个标题的范围
      for (let i = 0; i < headings.length; i++) {
        const current = headings[i];
        const next = headings[i + 1];
        const lineEnd = next ? next.lineIdx : lines.length;
        
        let preview = '';
        if (includePreview) {
          // 获取标题后的前3行非空内容作为预览
          const previewLines: string[] = [];
          for (let j = current.lineIdx + 1; j < lineEnd && previewLines.length < 3; j++) {
            const line = lines[j].trim();
            if (line && !line.startsWith('#')) {
              previewLines.push(line.substring(0, 80) + (line.length > 80 ? '...' : ''));
            }
          }
          preview = previewLines.join(' | ');
        }
        
        structure.push({
          level: current.level,
          title: current.title,
          lineStart: current.lineIdx + 1,
          lineEnd: lineEnd,
          preview: preview || undefined,
        });
      }
      
      // 格式化输出
      let result = `📄 笔记结构: ${file.path}\n`;
      result += `总行数: ${lines.length}\n`;
      result += `标题数: ${headings.length}\n\n`;
      
      if (structure.length === 0) {
        result += `（此笔记没有使用 Markdown 标题）\n`;
        result += `\n前10行预览:\n`;
        result += lines.slice(0, 10).map((l, i) => `${i + 1}: ${l}`).join('\n');
      } else {
        result += `标题结构:\n`;
        for (const s of structure) {
          const indent = '  '.repeat(s.level - 1);
          const lineInfo = `(行 ${s.lineStart}-${s.lineEnd})`;
          result += `${indent}${'#'.repeat(s.level)} ${s.title} ${lineInfo}\n`;
          if (s.preview) {
            result += `${indent}   └─ ${s.preview}\n`;
          }
        }
      }
      
      result += `\n💡 提示: 使用 read_note 的 heading 参数可以只读取特定标题的内容`;
      result += `\n💡 提示: 使用 replace_in_note 可以精准替换指定内容`;
      
      return result;
    } catch (error: any) {
      return `错误: 读取文件失败 - ${error.message}`;
    }
  }
}

/**
 * 精准替换工具 - 类似 Cursor 的 Diff 编辑
 */
export class ReplaceInNoteTool implements Tool {
  definition = {
    name: "replace_in_note",
    description: "对现有笔记做精确局部修改：把 oldText 完整匹配到的原文替换成 newText。适合改某一段、某几行或某个标题下的片段；如果要整段追加、前置或整篇重写，请改用 modify_note。",
    parameters: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "笔记的文件路径",
        },
        oldText: {
          type: "string",
          description: "要被替换的原文，必须与笔记中的实际内容完全一致（包括换行、空格和标点）",
        },
        newText: {
          type: "string",
          description: "替换后的新内容",
        },
        replaceAll: {
          type: "boolean",
          description: "（可选）是否替换所有匹配项，默认 false（只替换第一个）",
        },
      },
      required: ["path", "oldText", "newText"],
    },
  };

  async execute(args: { path: string; oldText: string; newText: string; replaceAll?: boolean }, app: App): Promise<string> {
    const path = normalizeVaultPath((args as any)?.path);
    const oldText = (args as any)?.oldText;
    const newText = (args as any)?.newText;
    const replaceAll = (args as any)?.replaceAll === true;
    
    if (!path) {
      return `错误: replace_in_note 缺少必填参数 path (string)`;
    }
    if (typeof oldText !== 'string') {
      return `错误: replace_in_note 缺少必填参数 oldText (string)`;
    }
    if (typeof newText !== 'string') {
      return `错误: replace_in_note 缺少必填参数 newText (string)`;
    }
    
    const file = app.metadataCache.getFirstLinkpathDest(path, "") || 
                 app.vault.getAbstractFileByPath(path) ||
                 app.vault.getAbstractFileByPath(path + ".md");

    if (!file || !(file instanceof TFile)) {
      return `错误: 找不到文件 "${path}"`;
    }

    try {
      const content = await app.vault.read(file);
      
      // 检查是否存在匹配
      if (!content.includes(oldText)) {
        // 尝试模糊匹配提供帮助
        const normalizedOld = oldText.replace(/\s+/g, ' ').trim();
        const normalizedContent = content.replace(/\s+/g, ' ');
        
        if (normalizedContent.includes(normalizedOld)) {
          return `错误: 未找到完全匹配的内容。\n` +
                 `提示: 内容存在但空格/换行不匹配。请使用 read_note 读取原文后精确复制。`;
        }
        
        // 显示相似内容帮助定位
        const lines = content.split('\n');
        const searchTerms = oldText.split('\n')[0].substring(0, 50);
        const similarLines = lines
          .map((line, idx) => ({ line, idx: idx + 1 }))
          .filter(({ line }) => line.toLowerCase().includes(searchTerms.toLowerCase().substring(0, 20)))
          .slice(0, 3);
        
        let hint = `错误: 未找到要替换的内容。\n`;
        if (similarLines.length > 0) {
          hint += `\n可能相关的行:\n`;
          similarLines.forEach(({ line, idx }) => {
            hint += `  行 ${idx}: ${line.substring(0, 100)}${line.length > 100 ? '...' : ''}\n`;
          });
        }
        hint += `\n💡 建议: 先使用 get_note_structure 或 read_note 查看笔记内容，确保 oldText 完全匹配。`;
        return hint;
      }
      
      // 执行替换
      let newContent: string;
      let replaceCount: number;
      
      if (replaceAll) {
        const regex = new RegExp(escapeRegExp(oldText), 'g');
        replaceCount = (content.match(regex) || []).length;
        newContent = content.replace(regex, newText);
      } else {
        replaceCount = 1;
        newContent = content.replace(oldText, newText);
      }
      
      await app.vault.modify(file, newContent);
      
      return `成功: 已在 "${file.path}" 中替换 ${replaceCount} 处内容。\n` +
             `原文 (${oldText.length} 字符) → 新内容 (${newText.length} 字符)`;
    } catch (error: any) {
      return `错误: 替换失败 - ${error.message}`;
    }
  }
}

// 辅助函数：转义正则表达式特殊字符
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class ReadNoteTool implements Tool {
  definition = {
    name: "read_note",
    description: "读取笔记内容。支持读取完整内容、按标题读取段落、或按行范围读取；若提供 heading，则优先按标题读取。",
    parameters: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "笔记的文件路径或文件名（如 'Daily/2024-01-01.md' 或 '2024-01-01'）",
        },
        heading: {
          type: "string",
          description: "（可选）要读取的标题文本，如 '## 第二章' 或 '第二章'。当前会先去掉开头的 # 再匹配标题文本；若存在包含关系，也可能命中相似标题。",
        },
        startLine: {
          type: "number",
          description: "（可选）起始行号（从 1 开始）。必须与 endLine 一起提供，用于按行范围读取。",
        },
        endLine: {
          type: "number",
          description: "（可选）结束行号（包含）。必须与 startLine 一起提供。",
        },
      },
      required: ["path"],
    },
  };

  async execute(args: { path: string; heading?: string; startLine?: number; endLine?: number }, app: App): Promise<string> {
    const path = normalizeVaultPath((args as any)?.path);
    if (!path) {
      return `错误: read_note 缺少必填参数 path (string)`;
    }
    const file = app.metadataCache.getFirstLinkpathDest(path, "") ||
                 app.vault.getAbstractFileByPath(path) ||
                 app.vault.getAbstractFileByPath(path + ".md");

    if (!file || !(file instanceof TFile)) {
      return `错误: 找不到文件 "${path}"`;
    }

    if ((args.startLine !== undefined) !== (args.endLine !== undefined)) {
      return `错误: read_note 的 startLine 和 endLine 必须同时提供。`;
    }

    try {
      const content = await app.vault.read(file);
      const lines = content.split('\n');
      const stat = file.stat;
      const ctime = new Date(stat.ctime).toLocaleString();
      const mtime = new Date(stat.mtime).toLocaleString();
      
      let result = '';
      let contentToReturn = '';
      
      // 按标题读取
      if (args.heading) {
        const headingResult = this.extractHeadingSection(lines, args.heading);
        if (headingResult.error) {
          return headingResult.error;
        }
        contentToReturn = headingResult.content;
        result = `--- 文件: ${file.path} ---\n` +
                 `标题匹配: ${args.heading} (行 ${headingResult.startLine}-${headingResult.endLine})\n\n` +
                 contentToReturn;
      }
      // 按行范围读取
      else if (args.startLine !== undefined && args.endLine !== undefined) {
        const start = Math.max(1, args.startLine) - 1;
        const end = Math.min(lines.length, args.endLine);
        if (start >= lines.length) {
          return `错误: 起始行 ${args.startLine} 超出文件总行数 ${lines.length}`;
        }
        contentToReturn = lines.slice(start, end).join('\n');
        result = `--- 文件: ${file.path} (行 ${args.startLine}-${end}) ---\n` +
                 `总行数: ${lines.length}\n\n` +
                 contentToReturn;
      }
      // 读取完整内容
      else {
        contentToReturn = content;
        result = `--- 文件: ${file.path} ---\n` +
                 `创建时间: ${ctime}\n修改时间: ${mtime}\n总行数: ${lines.length}\n\n` +
                 contentToReturn;
      }
      
      return result;
    } catch (error: any) {
      return `错误: 读取文件失败 - ${error.message}`;
    }
  }
  
  private extractHeadingSection(lines: string[], targetHeading: string): { content: string; startLine: number; endLine: number; error?: string } {
    // 规范化目标标题（移除开头的 # 号）
    const normalizedTarget = targetHeading.replace(/^#+\s*/, '').trim().toLowerCase();
    
    let targetLevel = 0;
    let startIdx = -1;
    let endIdx = lines.length;
    
    // 查找目标标题
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        const title = headingMatch[2].trim().toLowerCase();
        
        if (startIdx === -1) {
          // 还没找到目标标题
          if (title === normalizedTarget || title.includes(normalizedTarget)) {
            startIdx = i;
            targetLevel = level;
          }
        } else {
          // 已找到目标标题，查找结束位置
          if (level <= targetLevel) {
            endIdx = i;
            break;
          }
        }
      }
    }
    
    if (startIdx === -1) {
      return { 
        content: '', 
        startLine: 0, 
        endLine: 0, 
        error: `错误: 找不到标题 "${targetHeading}"。提示：使用 get_note_structure 工具查看笔记的标题结构。` 
      };
    }
    
    return {
      content: lines.slice(startIdx, endIdx).join('\n'),
      startLine: startIdx + 1,
      endLine: endIdx,
    };
  }
}

export class ListFilesTool implements Tool {
  definition = {
    name: "list_files",
    description: "列出指定文件夹下的所有文件。当不确定文件名时，可以先列出目录。",
    parameters: {
      type: "object" as const,
      properties: {
        folderPath: {
          type: "string",
          description: "文件夹路径（根目录请传 '/' 或空字符串）",
        },
      },
      required: ["folderPath"],
    },
  };

  async execute(args: { folderPath: string }, app: App): Promise<string> {
    let { folderPath } = args;
    if (folderPath === "/" || folderPath === ".") folderPath = "";
    
    const folder = folderPath ? app.vault.getAbstractFileByPath(folderPath) : app.vault.getRoot();

    if (!folder || !(folder instanceof TFolder)) {
      return `错误: 找不到文件夹 "${folderPath}"`;
    }

    const files = folder.children.map(child => {
      const type = child instanceof TFolder ? "文件夹" : "文件";
      return `- [${type}] ${child.name}`;
    });

    return `文件夹 "${folderPath || '/'}" 的内容:\n${files.join("\n")}`;
  }
}

export class CreateNoteTool implements Tool {
  definition = {
    name: "create_note",
    description: "创建一个新的 Markdown 笔记。请始终提供 path 和 content；path 可不带 .md 后缀，例如 'Ideas/MyIdea'。",
    parameters: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "新笔记的完整路径（可不带 .md 后缀），例如 'Ideas/MyIdea' 或 'Ideas/MyIdea.md'",
        },
        title: {
          type: "string",
          description: "兼容旧调用的可选字段；正常情况下请不要使用，优先直接传 path。",
        },
        folder: {
          type: "string",
          description: "兼容旧调用的可选字段；正常情况下请不要使用，优先直接把目录写进 path。",
        },
        content: {
          type: "string",
          description: "笔记的初始内容",
        },
      },
      required: ["path", "title", "folder", "content"],
    },
  };

  async execute(args: { path?: string; title?: string; folder?: string; content: string }, app: App): Promise<string> {
    const rawPath = normalizeVaultPath((args as any)?.path);
    const rawTitle = toNonEmptyTrimmedString((args as any)?.title);
    const rawFolder = normalizeVaultPath((args as any)?.folder);
    const content = typeof (args as any)?.content === "string" ? (args as any).content : null;

    if (content === null) {
      return `错误: create_note 缺少必填参数 content (string)`;
    }

    let finalPath: string | null = rawPath;
    if (!finalPath && rawTitle) {
      finalPath = rawFolder ? `${rawFolder}/${rawTitle}` : rawTitle;
    }

    if (!finalPath) {
      return `错误: create_note 缺少必填参数 path (string)。也可以提供 title (string) 来生成文件名。`;
    }

    finalPath = ensureMarkdownExtension(finalPath);

    if (app.vault.getAbstractFileByPath(finalPath)) {
      return `错误: 文件 "${finalPath}" 已存在。`;
    }

    try {
      await app.vault.create(finalPath, content);
      return `成功: 已创建笔记 "${finalPath}"`;
    } catch (error: any) {
      return `错误: 创建笔记失败 - ${error.message}`;
    }
  }
}

export class CreateFolderTool implements Tool {
  definition = {
    name: "create_folder",
    description: "创建一个新的文件夹。",
    parameters: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "新文件夹的路径，例如 'Projects/NewProject'",
        },
      },
      required: ["path"],
    },
  };

  async execute(args: { path: string }, app: App): Promise<string> {
    const path = normalizeVaultPath((args as any)?.path);
    if (!path) {
      return `错误: create_folder 缺少必填参数 path (string)`;
    }
    
    if (app.vault.getAbstractFileByPath(path)) {
      return `错误: 路径 "${path}" 已存在。`;
    }

    try {
      await app.vault.createFolder(path);
      return `成功: 已创建文件夹 "${path}"`;
    } catch (error: any) {
      return `错误: 创建文件夹失败 - ${error.message}`;
    }
  }
}

export class ModifyNoteTool implements Tool {
  definition = {
    name: "modify_note",
    description: "对整篇笔记执行粗粒度写入：在末尾追加、在开头插入，或直接整篇覆盖。适合新增一整段内容、补充汇总结果，或在用户明确要求时重写全文；若只想改局部片段，优先使用 replace_in_note。",
    parameters: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "笔记的文件路径",
        },
        content: {
          type: "string",
          description: "要写入的内容",
        },
        mode: {
          type: "string",
          enum: ["append", "prepend", "overwrite"],
          description: "写入模式：append=追加到末尾；prepend=插入到开头；overwrite=用 content 完全替换整篇笔记",
          default: "append",
        },
      },
      required: ["path", "content"],
    },
  };

  async execute(args: { path: string; content: string; mode?: "append" | "prepend" | "overwrite" }, app: App): Promise<string> {
    const path = normalizeVaultPath((args as any)?.path);
    const content = typeof (args as any)?.content === "string" ? (args as any).content : null;
    // Default to append to avoid accidental data loss
    const mode = ((args as any)?.mode as "append" | "prepend" | "overwrite") || "append";
    if (!path) {
      return `错误: modify_note 缺少必填参数 path (string)`;
    }
    if (content === null) {
      return `错误: modify_note 缺少必填参数 content (string)`;
    }
    const file = app.metadataCache.getFirstLinkpathDest(path, "") || 
                 app.vault.getAbstractFileByPath(path) ||
                 app.vault.getAbstractFileByPath(path + ".md");

    if (!file || !(file instanceof TFile)) {
      return `错误: 找不到文件 "${path}"`;
    }

    try {
      let newContent = "";
      const oldContent = await app.vault.read(file);
      const oldContentLength = oldContent.trim().length;

      if (mode === "overwrite") {
        newContent = content;
      } else if (mode === "append") {
        newContent = oldContent + "\n" + content;
      } else if (mode === "prepend") {
        newContent = content + "\n" + oldContent;
      } else {
        return `错误: 未知的修改模式 "${mode}"`;
      }

      await app.vault.modify(file, newContent);
      
      // Warn if overwrite discarded existing content
      if (mode === "overwrite" && oldContentLength > 0) {
        return `成功: 已修改笔记 "${file.path}" (模式: ${mode})。⚠️ 注意：原有内容（${oldContentLength} 字符）已被覆盖丢失。`;
      }
      return `成功: 已修改笔记 "${file.path}" (模式: ${mode})`;
    } catch (error: any) {
      return `错误: 修改笔记失败 - ${error.message}`;
    }
  }
}

export class AppendToNoteTool implements Tool {
  definition = {
    name: "append_to_note",
    description: "仅向现有笔记末尾追加内容。它是 modify_note(mode=append) 的窄化版本；默认主路径优先使用 modify_note，只有在你明确只需要“追加到末尾”这一种动作时再使用本工具。",
    parameters: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "笔记路径",
        },
        content: {
          type: "string",
          description: "要追加到笔记末尾的内容",
        },
      },
      required: ["path", "content"],
    },
  };

  async execute(args: { path: string; content: string }, app: App): Promise<string> {
    const path = normalizeVaultPath((args as any)?.path);
    const content = typeof (args as any)?.content === "string" ? (args as any).content : null;
    if (!path) {
      return `错误: append_to_note 缺少必填参数 path (string)`;
    }
    if (content === null) {
      return `错误: append_to_note 缺少必填参数 content (string)`;
    }
    // Use the same smart path resolution as read_note
    const file = app.metadataCache.getFirstLinkpathDest(path, "") || 
                 app.vault.getAbstractFileByPath(path) ||
                 app.vault.getAbstractFileByPath(path + ".md");

    if (!file || !(file instanceof TFile)) {
      return `错误: 找不到笔记 "${path}"`;
    }

    try {
      await app.vault.append(file, "\n" + content);
      return `成功: 已追加内容到 "${path}"`;
    } catch (error: any) {
      return `错误: 追加内容失败 - ${error.message}`;
    }
  }
}

export class MoveItemTool implements Tool {
  definition = {
    name: "move_item",
    description: "移动或重命名文件/文件夹。",
    parameters: {
      type: "object" as const,
      properties: {
        sourcePath: {
          type: "string",
          description: "源文件或文件夹的路径",
        },
        destinationPath: {
          type: "string",
          description: "目标路径（包含新的文件名/文件夹名）",
        },
      },
      required: ["sourcePath", "destinationPath"],
    },
  };

  async execute(args: { sourcePath: string; destinationPath: string }, app: App): Promise<string> {
    const sourcePath = normalizeVaultPath((args as any)?.sourcePath);
    const destinationPath = normalizeVaultPath((args as any)?.destinationPath);
    if (!sourcePath) {
      return `错误: move_item 缺少必填参数 sourcePath (string)`;
    }
    if (!destinationPath) {
      return `错误: move_item 缺少必填参数 destinationPath (string)`;
    }
    const file = app.vault.getAbstractFileByPath(sourcePath);

    if (!file) {
      return `错误: 找不到源文件/文件夹 "${sourcePath}"`;
    }

    if (app.vault.getAbstractFileByPath(destinationPath)) {
      return `错误: 目标路径 "${destinationPath}" 已存在。`;
    }

    try {
      await app.vault.rename(file, destinationPath);
      return `成功: 已将 "${sourcePath}" 移动/重命名为 "${destinationPath}"`;
    } catch (error: any) {
      return `错误: 移动失败 - ${error.message}`;
    }
  }
}

export class DeleteFileTool implements Tool {
  definition = {
    name: "delete_file",
    description: "删除指定的文件或文件夹。请谨慎使用。",
    parameters: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "要删除的文件或文件夹路径",
        },
      },
      required: ["path"],
    },
  };

  async execute(args: { path: string }, app: App): Promise<string> {
    const path = normalizeVaultPath((args as any)?.path);
    console.log(`[delete_file] 收到删除请求，原始参数: ${JSON.stringify(args)}, 规范化路径: ${path}`);
    
    if (!path) {
      console.log(`[delete_file] 错误: 路径为空`);
      return `错误: delete_file 缺少必填参数 path (string)`;
    }
    // Use smart path resolution for better compatibility
    const file = app.metadataCache.getFirstLinkpathDest(path, "") || 
                 app.vault.getAbstractFileByPath(path) ||
                 app.vault.getAbstractFileByPath(path + ".md");

    console.log(`[delete_file] 文件查找结果: ${file ? file.path : '未找到'}`);
    
    if (!file) {
      return `错误: 找不到文件/文件夹 "${path}"`;
    }

    try {
      await app.vault.delete(file);
      console.log(`[delete_file] 成功删除: ${file.path}`);
      return `成功: 已删除 "${path}"`;
    } catch (error: any) {
      console.log(`[delete_file] 删除失败: ${error.message}`);
      return `错误: 删除失败 - ${error.message}`;
    }
  }
}

export class ExecuteCommandTool implements Tool {
  definition = {
    name: "execute_command",
    description: "执行 Obsidian 命令面板中的命令。",
    parameters: {
      type: "object" as const,
      properties: {
        commandId: {
          type: "string",
          description: "要执行的命令 ID (例如 'editor:toggle-bold')",
        },
      },
      required: ["commandId"],
    },
  };

  async execute(args: { commandId: string }, app: App): Promise<string> {
    const { commandId } = args;
    // @ts-ignore: commands is internal API
    const commands = (app as any).commands;
    
    if (!commands.findCommand(commandId)) {
      return `错误: 找不到命令 ID "${commandId}"`;
    }

    try {
      commands.executeCommandById(commandId);
      return `成功: 已执行命令 "${commandId}"`;
    } catch (error: any) {
      return `错误: 执行命令失败 - ${error.message}`;
    }
  }
}

export class ListCommandsTool implements Tool {
  definition = {
    name: "list_commands",
    description: "列出 Obsidian 中所有可用的命令及其 ID。当需要执行命令但不知道 ID 时使用。",
    parameters: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  };

  async execute(args: {}, app: App): Promise<string> {
    // @ts-ignore: commands is internal API
    const commands = (app as any).commands;
    const cmds = commands.listCommands();
    
    const list = cmds.map((cmd: any) => `- ${cmd.name} (ID: ${cmd.id})`).join("\n");
    return `可用命令列表 (共 ${cmds.length} 个):\n${list}`;
  }
}

export class GetBacklinksTool implements Tool {
  definition = {
    name: "get_backlinks",
    description: "获取链接到指定笔记的所有其他笔记（反向链接）。",
    parameters: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "目标笔记路径",
        },
      },
      required: ["path"],
    },
  };

  async execute(args: { path: string }, app: App): Promise<string> {
    const path = normalizeVaultPath((args as any)?.path);
    if (!path) {
      return `错误: get_backlinks 缺少必填参数 path (string)`;
    }
    // Use smart path resolution for better compatibility
    const file = app.metadataCache.getFirstLinkpathDest(path, "") || 
                 app.vault.getAbstractFileByPath(path) ||
                 app.vault.getAbstractFileByPath(path + ".md");

    if (!file || !(file instanceof TFile)) {
      return `错误: 找不到笔记 "${path}"`;
    }

    // @ts-ignore: Obsidian API type definition might be incomplete for metadataCache
    const backlinks = app.metadataCache.getBacklinksForFile(file);
    
    if (!backlinks || backlinks.data.size === 0) {
      return `笔记 "${path}" 没有反向链接。`;
    }

    const paths: string[] = [];
    // @ts-ignore
    for (const sourcePath of backlinks.data.keys()) {
      paths.push(sourcePath);
    }

    return `链接到 "${path}" 的笔记:\n${paths.map(p => `- ${p}`).join("\n")}`;
  }
}

export class GetChildNotesTool implements Tool {
  definition = {
    name: "get_child_notes",
    description: "获取将指定笔记作为父笔记的所有子笔记。通过搜索 frontmatter 中包含 '父笔记: [[目标笔记]]' 的所有笔记来实现。",
    parameters: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "父笔记的路径（可以是完整路径或笔记名称）",
        },
      },
      required: ["path"],
    },
  };

  async execute(args: { path: string }, app: App): Promise<string> {
    const path = normalizeVaultPath((args as any)?.path);
    if (!path) {
      return `错误: get_child_notes 缺少必填参数 path (string)`;
    }

    // 解析目标文件
    const file = app.metadataCache.getFirstLinkpathDest(path, "") || 
                 app.vault.getAbstractFileByPath(path) ||
                 app.vault.getAbstractFileByPath(path + ".md");

    if (!file || !(file instanceof TFile)) {
      return `错误: 找不到笔记 "${path}"`;
    }

    // 获取笔记的basename（不含扩展名）用于匹配
    const targetBasename = file.basename;
    const childNotes: Array<{ path: string; title: string; mtime: number }> = [];

    // 遍历所有文件，查找在 frontmatter 中引用了目标笔记作为父笔记的文件
    const allFiles = app.vault.getMarkdownFiles();
    
    for (const mdFile of allFiles) {
      const cache = app.metadataCache.getFileCache(mdFile);
      if (!cache || !cache.frontmatter) continue;

      const frontmatter = cache.frontmatter;
      
      // 检查 frontmatter 中的 "父笔记" 字段
      const parentNotes = frontmatter["父笔记"] || frontmatter["parent"] || frontmatter["parents"];
      
      if (!parentNotes) continue;

      // 父笔记可能是字符串、数组或其他格式
      let parentList: string[] = [];
      if (typeof parentNotes === "string") {
        parentList = [parentNotes];
      } else if (Array.isArray(parentNotes)) {
        parentList = parentNotes;
      }

      // 检查是否包含目标笔记的引用
      const hasTargetParent = parentList.some(parent => {
        // 移除 [[ ]] 标记和引号
        const cleanParent = parent.replace(/^\[\[|\]\]$/g, "").replace(/^["']|["']$/g, "").trim();
        return cleanParent === targetBasename || cleanParent === file.path;
      });

      if (hasTargetParent) {
        childNotes.push({
          path: mdFile.path,
          title: mdFile.basename,
          mtime: mdFile.stat.mtime,
        });
      }
    }

    if (childNotes.length === 0) {
      return `笔记 "${path}" 没有子笔记。\n\n💡 提示: 子笔记需要在 frontmatter 中包含:\n---\n父笔记:\n  - "[[${targetBasename}]]"\n---`;
    }

    // 按修改时间排序（最新的在前）
    childNotes.sort((a, b) => b.mtime - a.mtime);

    let result = `📁 笔记 "${path}" 的子笔记 (共 ${childNotes.length} 个):\n\n`;
    
    for (const child of childNotes) {
      const modTime = new Date(child.mtime).toLocaleString();
      result += `- ${child.title}\n`;
      result += `  路径: ${child.path}\n`;
      result += `  修改时间: ${modTime}\n\n`;
    }

    result += `💡 提示: 使用 read_note 工具读取具体子笔记的内容`;
    
    return result;
  }
}
