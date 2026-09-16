import type { ChatMessage, Conversation } from "../../core/types";

const SUMMARY_TEXT_LIMIT = 120;

export type ConversationIndexEntry = Omit<Conversation, "history"> & {
  lastPart: number;
  messageCount: number;
};

export type ConversationIndex = Record<string, ConversationIndexEntry>;

const DEFAULT_MAX_PART_BYTES = 512 * 1024; // 512KB per part to avoid huge files.

function pad4(n: number): string {
  return String(n).padStart(4, "0");
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function compactMessageText(content: string | null | undefined): string {
  return String(content ?? "").replace(/\s+/g, " ").trim();
}

function clipSummaryText(text: string, limit = SUMMARY_TEXT_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export function buildConversationSummary(history: ChatMessage[] | undefined): Pick<Conversation, "previewText" | "firstUserText"> {
  const messages = Array.isArray(history) ? history : [];
  const nonSystem = messages.filter(msg => msg?.role !== "system");
  const firstUser = messages.find(msg => msg?.role === "user");
  const lastMeaningful = [...nonSystem].reverse().find(msg => compactMessageText(msg?.content));

  return {
    firstUserText: clipSummaryText(compactMessageText(firstUser?.content)),
    previewText: clipSummaryText(compactMessageText(lastMeaningful?.content)),
  };
}

export class ConversationStoreV2 {
  private adapter: any;
  private baseDir: string;
  private indexPath: string;
  private maxPartBytes: number;

  constructor(opts: {
    adapter: any;
    baseDir: string;
    indexPath: string;
    maxPartBytes?: number;
  }) {
    this.adapter = opts.adapter;
    this.baseDir = opts.baseDir;
    this.indexPath = opts.indexPath;
    this.maxPartBytes = Math.max(64 * 1024, opts.maxPartBytes ?? DEFAULT_MAX_PART_BYTES);
  }

  public getConversationDir(conversationId: string): string {
    return `${this.baseDir}/${conversationId}`;
  }

  public getMetaPath(conversationId: string): string {
    return `${this.getConversationDir(conversationId)}/meta.json`;
  }

  public getHistoryPartPath(conversationId: string, part: number): string {
    return `${this.getConversationDir(conversationId)}/history-${pad4(part)}.jsonl`;
  }

  public async ensureBaseDir(): Promise<void> {
    if (!(await this.adapter.exists(this.baseDir))) {
      await this.adapter.mkdir(this.baseDir).catch(() => {});
    }
  }

  public async loadIndex(): Promise<ConversationIndex> {
    await this.ensureBaseDir();
    if (!(await this.adapter.exists(this.indexPath))) {
      // 主文件不存在时，尝试从备份恢复
      const bakPath = this.indexPath + ".bak";
      if (await this.adapter.exists(bakPath)) {
        try {
          const bakRaw = await this.adapter.read(bakPath);
          const bakParsed = safeJsonParse<ConversationIndex>(bakRaw, {});
          if (bakParsed && Object.keys(bakParsed).length > 0) {
            // 从备份恢复主文件
            await this.adapter.write(this.indexPath, bakRaw);
            return bakParsed;
          }
        } catch {
          // 备份也无法读取，放弃
        }
      }
      return {};
    }
    const raw = await this.adapter.read(this.indexPath);
    const parsed = safeJsonParse<ConversationIndex>(raw, {});
    if (!parsed || Object.keys(parsed).length === 0) {
      // 主文件损坏或为空，尝试从备份恢复
      const bakPath = this.indexPath + ".bak";
      if (await this.adapter.exists(bakPath)) {
        try {
          const bakRaw = await this.adapter.read(bakPath);
          const bakParsed = safeJsonParse<ConversationIndex>(bakRaw, {});
          if (bakParsed && Object.keys(bakParsed).length > 0) {
            // 从备份恢复主文件
            await this.adapter.write(this.indexPath, bakRaw);
            return bakParsed;
          }
        } catch {
          // 备份也损坏
        }
      }
    }
    return parsed ?? {};
  }

  public async writeIndex(index: ConversationIndex, opts?: { force?: boolean }): Promise<void> {
    await this.ensureBaseDir();

    // 安全检查：如果新索引为空但旧索引有数据，拒绝写入以防止意外数据丢失
    // 使用 force=true 可跳过此检查（如用户主动删除所有对话）
    if (!opts?.force) {
      const newCount = Object.keys(index ?? {}).length;
      if (newCount === 0 && (await this.adapter.exists(this.indexPath))) {
        const existingRaw = await this.adapter.read(this.indexPath);
        const existingParsed = safeJsonParse<ConversationIndex>(existingRaw, {});
        const oldCount = Object.keys(existingParsed ?? {}).length;
        if (oldCount > 0) {
          // 拒绝用空索引覆盖非空索引（这通常是 bug 而非用户意图）
          return;
        }
      }
    }

    // 写入前先备份旧索引
    if (await this.adapter.exists(this.indexPath)) {
      try {
        const bakPath = this.indexPath + ".bak";
        const existingRaw = await this.adapter.read(this.indexPath);
        await this.adapter.write(bakPath, existingRaw);
      } catch {
        // 备份失败不阻止写入
      }
    }

    await this.adapter.write(this.indexPath, JSON.stringify(index ?? {}, null, 2));
  }

  public async writeMeta(conversation: Conversation, lastPart: number, messageCount: number): Promise<void> {
    const dir = this.getConversationDir(conversation.id);
    if (!(await this.adapter.exists(dir))) {
      await this.adapter.mkdir(dir).catch(() => {});
    }

    const meta: ConversationIndexEntry = {
      id: conversation.id,
      title: conversation.title,
      model: conversation.model,
      todoList: conversation.todoList,
      lastContextTokensEstimate: conversation.lastContextTokensEstimate,
      pinned: conversation.pinned,
      starred: conversation.starred,
      archived: conversation.archived,
      tags: conversation.tags,
      templateId: conversation.templateId,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      personaId: conversation.personaId,
      agentId: conversation.agentId,
      toolPolicyId: conversation.toolPolicyId,
      modelSource: conversation.modelSource,
      uiEntryMode: conversation.uiEntryMode,
      decisionState: conversation.decisionState,
      roleplayState: conversation.roleplayState,
      previewText: conversation.previewText,
      firstUserText: conversation.firstUserText,
      lastPart,
      messageCount,
    };

    await this.adapter.write(this.getMetaPath(conversation.id), JSON.stringify(meta, null, 2));
  }

  public async loadMeta(conversationId: string): Promise<ConversationIndexEntry | null> {
    const metaPath = this.getMetaPath(conversationId);
    if (!(await this.adapter.exists(metaPath))) return null;
    const raw = await this.adapter.read(metaPath);
    const parsed = safeJsonParse<ConversationIndexEntry | null>(raw, null);
    return parsed;
  }

  public async loadFullHistory(conversationId: string, lastPart: number): Promise<ChatMessage[]> {
    const out: ChatMessage[] = [];
    const max = Math.max(1, lastPart || 1);
    for (let part = 1; part <= max; part++) {
      const p = this.getHistoryPartPath(conversationId, part);
      if (!(await this.adapter.exists(p))) continue;
      const raw = await this.adapter.read(p);
      const lines = raw.split("\n").map((l: string) => l.trim()).filter(Boolean);
      for (const line of lines) {
        try {
          out.push(JSON.parse(line) as ChatMessage);
        } catch {
          // ignore corrupt line
        }
      }
    }
    return out;
  }

  public async loadHistoryTail(conversationId: string, lastPart: number, limit: number): Promise<ChatMessage[]> {
    const need = Math.max(0, limit | 0);
    if (need <= 0) return [];

    const acc: ChatMessage[] = [];
    for (let part = Math.max(1, lastPart || 1); part >= 1; part--) {
      const p = this.getHistoryPartPath(conversationId, part);
      if (!(await this.adapter.exists(p))) continue;
      const raw = await this.adapter.read(p);
      const lines = raw.split("\n").map((l: string) => l.trim()).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          acc.push(JSON.parse(lines[i]) as ChatMessage);
        } catch {
          // ignore
        }
        if (acc.length >= need) {
          acc.reverse();
          return acc;
        }
      }
    }

    acc.reverse();
    return acc;
  }

  public async rewriteHistory(conversationId: string, messages: ChatMessage[]): Promise<{ lastPart: number; messageCount: number }> {
    const dir = this.getConversationDir(conversationId);
    if (!(await this.adapter.exists(dir))) {
      await this.adapter.mkdir(dir).catch(() => {});
    }

    let part = 1;
    let buffer = "";
    let messageCount = 0;

    const flush = async () => {
      const p = this.getHistoryPartPath(conversationId, part);
      await this.adapter.write(p, buffer);
      buffer = "";
    };

    for (const msg of messages ?? []) {
      const line = JSON.stringify(msg) + "\n";
      if (buffer.length + line.length > this.maxPartBytes && buffer.length > 0) {
        await flush();
        part++;
      }
      buffer += line;
      messageCount++;
    }

    await flush();

    return { lastPart: part, messageCount };
  }

  public async appendMessages(conversationId: string, startPart: number, messages: ChatMessage[]): Promise<{ lastPart: number; messageCountAppended: number }> {
    let part = Math.max(1, startPart || 1);
    let appended = 0;

    const ensurePartFile = async (p: string) => {
      if (!(await this.adapter.exists(p))) {
        await this.adapter.write(p, "");
      }
    };

    const statSize = async (p: string): Promise<number> => {
      try {
        const st = await this.adapter.stat(p);
        return typeof st?.size === "number" ? st.size : 0;
      } catch {
        return 0;
      }
    };

    const appendText = async (p: string, text: string) => {
      if (typeof this.adapter.append === "function") {
        await this.adapter.append(p, text);
        return;
      }
      // Fallback: read + write
      const prev = (await this.adapter.exists(p)) ? await this.adapter.read(p) : "";
      await this.adapter.write(p, prev + text);
    };

    for (const msg of messages ?? []) {
      const line = JSON.stringify(msg) + "\n";
      const path = this.getHistoryPartPath(conversationId, part);
      await ensurePartFile(path);

      const size = await statSize(path);
      if (size + line.length > this.maxPartBytes && size > 0) {
        part++;
        const nextPath = this.getHistoryPartPath(conversationId, part);
        await ensurePartFile(nextPath);
        await appendText(nextPath, line);
      } else {
        await appendText(path, line);
      }

      appended++;
    }

    return { lastPart: part, messageCountAppended: appended };
  }
}
