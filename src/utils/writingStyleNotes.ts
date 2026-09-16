import { App, TFile, parseYaml } from "obsidian";
import { WritingStyle } from "../features/character/types";

export const WRITING_STYLE_NOTE_FOLDER = "AI Chat Assistant/文风库";

const INVALID_FILENAME_CHARS = /[\\/:*?"<>|]/g;

export function sanitizeFileName(name: string): string {
  const trimmed = String(name || "").trim();
  const base = trimmed.length > 0 ? trimmed : "未命名文风";
  return base.replace(INVALID_FILENAME_CHARS, "-");
}

async function ensureFolder(app: App, folderPath: string): Promise<void> {
  const adapter = app.vault.adapter;
  if (!await adapter.exists(folderPath)) {
    await adapter.mkdir(folderPath);
  }
}

function yamlEscape(value: string): string {
  const text = String(value ?? "");
  if (text.includes(":") || text.includes("#") || text.includes("\n")) {
    return `"${text.replace(/"/g, "\\\"")}"`;
  }
  return text;
}

function yamlBlock(key: string, value?: string): string[] {
  const text = String(value ?? "").trim();
  if (!text) return [];
  if (!text.includes("\n")) {
    return [`${key}: ${yamlEscape(text)}`];
  }
  const lines = text.split(/\r?\n/).map(line => `  ${line}`);
  return [`${key}: |`, ...lines];
}

export function serializeWritingStyleNote(style: WritingStyle): string {
  const name = String(style.name || "未命名文风").trim();
  const frontmatter: string[] = [
    "---",
    "writingStyle: true",
    `name: ${yamlEscape(name)}`,
    `enabled: ${style.enabled ? "true" : "false"}`,
    ...yamlBlock("styleDescription", style.styleDescription),
    ...yamlBlock("customInstructions", style.customInstructions),
    ...yamlBlock("sampleText", style.sampleText),
  ];

  if (style.dimensions) {
    frontmatter.push("dimensions:");
    const dims = style.dimensions;
    const entries: Array<[string, number | undefined]> = [
      ["informationDensity", dims.informationDensity],
      ["emotionalIntensity", dims.emotionalIntensity],
      ["narrativePace", dims.narrativePace],
      ["rhetoricalLevel", dims.rhetoricalLevel],
      ["colloquialLevel", dims.colloquialLevel],
      ["detailLevel", dims.detailLevel],
    ];
    entries.forEach(([key, value]) => {
      if (typeof value === "number") {
        frontmatter.push(`  ${key}: ${value}`);
      }
    });
  }

  if (style.analyzedBy) {
    frontmatter.push(`analyzedBy: ${yamlEscape(style.analyzedBy)}`);
  }

  frontmatter.push("---", "");

  const sections: string[] = [];
  sections.push("# 文风描述", style.styleDescription || "", "");
  sections.push("# 额外指令", style.customInstructions || "", "");
  sections.push("# 样本文本", style.sampleText || "", "");

  return [...frontmatter, ...sections].join("\n");
}

function extractFrontmatter(content: string): { fm: any; body: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return { fm: {}, body: content };
  const fm = parseYaml(match[1]) || {};
  const body = content.slice(match[0].length);
  return { fm, body };
}

export function parseWritingStyleNote(content: string, fallbackName: string): WritingStyle | null {
  const { fm, body } = extractFrontmatter(content);
  const isStyle = Boolean(fm?.writingStyle) || Boolean(fm?.styleDescription) || Boolean(fm?.dimensions);

  if (isStyle) {
    const dims = fm?.dimensions || {};
    return {
      enabled: fm?.enabled !== false,
      name: fm?.name || fallbackName,
      styleDescription: fm?.styleDescription || "",
      customInstructions: fm?.customInstructions || "",
      sampleText: fm?.sampleText || "",
      analyzedBy: fm?.analyzedBy || undefined,
      dimensions: {
        informationDensity: typeof dims.informationDensity === "number" ? dims.informationDensity : undefined,
        emotionalIntensity: typeof dims.emotionalIntensity === "number" ? dims.emotionalIntensity : undefined,
        narrativePace: typeof dims.narrativePace === "number" ? dims.narrativePace : undefined,
        rhetoricalLevel: typeof dims.rhetoricalLevel === "number" ? dims.rhetoricalLevel : undefined,
        colloquialLevel: typeof dims.colloquialLevel === "number" ? dims.colloquialLevel : undefined,
        detailLevel: typeof dims.detailLevel === "number" ? dims.detailLevel : undefined,
      },
    };
  }

  const fallback = String(body || "").trim();
  if (!fallback) return null;
  return {
    enabled: true,
    name: fallbackName,
    styleDescription: fallback,
  };
}

export async function saveWritingStyleAsNote(app: App, style: WritingStyle): Promise<TFile> {
  await ensureFolder(app, WRITING_STYLE_NOTE_FOLDER);
  const fileName = sanitizeFileName(style.name || "未命名文风");
  const filePath = `${WRITING_STYLE_NOTE_FOLDER}/${fileName}.md`;
  const content = serializeWritingStyleNote(style);
  const existing = app.vault.getAbstractFileByPath(filePath);
  if (existing instanceof TFile) {
    await app.vault.modify(existing, content);
    return existing;
  }
  return await app.vault.create(filePath, content);
}