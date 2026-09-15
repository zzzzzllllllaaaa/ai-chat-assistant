import { App, TFile } from "obsidian";
import type { Tool } from "../types";

function normalizeVaultPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\\/g, "/");
}

export class GetPropertiesTool implements Tool {
  definition = {
    name: "get_properties",
    description: "获取笔记的 YAML 属性（Frontmatter）。",
    parameters: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "目标笔记的路径或文件名",
        },
      },
      required: ["path"],
    },
  };

  async execute(args: { path: string }, app: App): Promise<string> {
    const path = normalizeVaultPath((args as any)?.path);
    if (!path) {
      return `错误: get_properties 缺少必填参数 path (string)`;
    }
    const file = app.metadataCache.getFirstLinkpathDest(path, "") ||
                 app.vault.getAbstractFileByPath(path) ||
                 app.vault.getAbstractFileByPath(path + ".md");

    if (!file || !(file instanceof TFile)) {
      return `错误: 找不到文件 "${path}"`;
    }

    const cache = app.metadataCache.getFileCache(file);
    if (!cache || !cache.frontmatter) {
      return `文件 "${path}" 没有 YAML 属性。`;
    }

    return JSON.stringify(cache.frontmatter, null, 2);
  }
}

export class UpdatePropertiesTool implements Tool {
  definition = {
    name: "update_properties",
    description: "更新笔记的 YAML 属性（Frontmatter）。可以添加、修改或删除属性。",
    parameters: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "目标笔记的路径或文件名",
        },
        properties: {
          type: "object",
          description: "要更新的属性键值对。必须是对象；将某个键的值设为 null 表示删除该属性。",
        },
      },
      required: ["path", "properties"],
    },
  };

  async execute(args: { path: string; properties: Record<string, any> }, app: App): Promise<string> {
    const path = normalizeVaultPath((args as any)?.path);
    const properties = (args as any)?.properties;
    if (!path) {
      return `错误: update_properties 缺少必填参数 path (string)`;
    }
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
      return `错误: update_properties 缺少必填参数 properties (object)`;
    }
    const file = app.metadataCache.getFirstLinkpathDest(path, "") ||
                 app.vault.getAbstractFileByPath(path) ||
                 app.vault.getAbstractFileByPath(path + ".md");

    if (!file || !(file instanceof TFile)) {
      return `错误: 找不到文件 "${path}"`;
    }

    try {
      await app.fileManager.processFrontMatter(file, (frontmatter) => {
        for (const [key, value] of Object.entries(properties)) {
          if (value === null) {
            delete frontmatter[key];
          } else {
            frontmatter[key] = value;
          }
        }
      });
      return `成功更新文件 "${path}" 的属性。`;
    } catch (error: any) {
      return `更新属性失败: ${error.message}`;
    }
  }
}
