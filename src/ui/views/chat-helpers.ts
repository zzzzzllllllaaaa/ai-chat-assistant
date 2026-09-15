/**
 * 聊天视图辅助函数
 * 从 view.ts 提取的纯数据处理方法，无 DOM 依赖
 */
import type { Conversation, TodoItem } from "../../core/types";
import type { ConversationRoleplayState } from "../../core/types";

/** 从用户输入中提取 [[wikilink]] 引用 */
export function extractWikilinks(text: string): string[] {
  const raw = String(text || "");
  const out: string[] = [];
  const re = /!?\[\[([^\]|#]+)(?:#[^\]]+)?(?:\|[^\]]+)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const name = String(m[1] || "").trim();
    if (name) out.push(name);
  }
  return Array.from(new Set(out));
}

/** 分解上下文内容为结构化块 */
export function extractContextBlocks(contextContent: string): Array<{ key: string; content: string }> {
  const trimmed = String(contextContent || '').trim();
  if (!trimmed) return [];
  const blocks: Array<{ key: string; content: string }> = [];
  const regex = /---\s*(文件|子文件|文件夹|标签):\s*([^\n]+?)\s*---\n([\s\S]*?)(?=(?:\n---\s*(?:文件|子文件|文件夹|标签):)|$)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(trimmed))) {
    const [, type, name, content] = match;
    blocks.push({ key: `${type}:${name.trim()}`, content: String(content || '').trim() });
  }
  if (blocks.length === 0) {
    blocks.push({ key: 'manual-context', content: trimmed });
  }
  return blocks;
}

/** 提取对话目标信息（入口模式、agent、persona） */
export function extractConversationTargetInfo(conversation: Conversation | null | undefined): {
  entry: 'chat' | 'search' | 'agent' | 'collaboration' | 'groupchat';
  mode: 'normal' | 'kb' | 'agent' | 'collaboration' | 'groupchat';
  agentId?: string;
  personaId?: string;
} {
  const entry = (conversation?.uiEntryMode === 'search' ? 'search'
    : conversation?.uiEntryMode === 'agent' ? 'agent'
    : conversation?.uiEntryMode === 'collaboration' ? 'collaboration'
    : conversation?.uiEntryMode === 'groupchat' ? 'groupchat'
    : 'chat') as 'chat' | 'search' | 'agent' | 'collaboration' | 'groupchat';
  const mode = entry === 'search' ? 'kb' : entry === 'chat' ? 'normal' : entry;
  return {
    entry,
    mode,
    agentId: conversation?.agentId,
    personaId: conversation?.personaId,
  };
}

/** 从助手输出中解析角色扮演 data_block */
export function extractRoleplayDataBlock(rawContent: string): {
  visibleContent: string;
  roleplayState: ConversationRoleplayState | null;
} {
  const raw = String(rawContent || '');
  const match = raw.match(/<data_block>([\s\S]*?)<\/data_block>/i);
  if (!match) {
    return { visibleContent: raw, roleplayState: null };
  }

  const xml = `<data_block>${match[1]}</data_block>`;
  const visibleContent = raw.replace(match[0], '').trim();

  const getTag = (source: string, tag: string): string => {
    const m = source.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    return m?.[1] ? String(m[1]).trim() : '';
  };

  const getItems = (source: string, containerTag: string, itemTag: string): Array<Record<string, string>> => {
    const container = getTag(source, containerTag);
    if (!container) return [];
    const regex = new RegExp(`<${itemTag}>([\\s\\S]*?)<\\/${itemTag}>`, 'gi');
    const items: Array<Record<string, string>> = [];
    let m: RegExpExecArray | null;
    while ((m = regex.exec(container))) {
      const itemSrc = m[1] || '';
      const fieldRegex = /<([a-zA-Z0-9_:-]+)(?:\s+[^>]*)?>([\s\S]*?)<\/\1>/g;
      const obj: Record<string, string> = {};
      let fm: RegExpExecArray | null;
      while ((fm = fieldRegex.exec(itemSrc))) {
        obj[String(fm[1] || '').trim()] = String(fm[2] || '').trim();
      }
      if (Object.keys(obj).length > 0) items.push(obj);
    }
    return items;
  };

  const player: Record<string, string> = {};
  const playerKeys = ['rank','clan','hp_current','hp_max','blood_current','blood_max','mp_current','mp_max','exp_current','exp_max','san_current','san_max','daoxin_current','daoxin_max','san_status','luck_status','spirit_root_status','status_effects','location','time','threat_level','inventory'];
  for (const key of playerKeys) {
    const value = getTag(xml, key);
    if (value) player[key] = value;
  }

  const roleplayState: ConversationRoleplayState = {
    version: 1,
    updatedAt: Date.now(),
    rawDataBlock: xml,
    player: Object.keys(player).length > 0 ? player : undefined,
    partners: getItems(xml, 'partners', 'partner'),
    npcs: getItems(xml, 'npcs', 'npc'),
    quests: getItems(xml, 'quests', 'quest'),
    beauties: getItems(xml, 'beauties', 'beauty'),
    worldEvents: getItems(xml, 'world_events', 'event'),
    messages: getItems(xml, 'messages', 'message'),
  };

  return { visibleContent, roleplayState };
}

/** 尝试从工具输出中解析 TodoList */
export function tryParseTodoListFromToolOutput(content: string): TodoItem[] | null {
  if (!content) return null;

  const tryParse = (raw: string): any => {
    try { return JSON.parse(raw); } catch { return null; }
  };

  let raw = content.trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) raw = fenced[1].trim();

  const parsed = tryParse(raw) ?? tryParse(content);
  if (!parsed) return null;

  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.todoList) ? parsed.todoList : null;
  if (!Array.isArray(list)) return null;

  const allowed = new Set(['not-started', 'in-progress', 'completed']);
  const normalized: TodoItem[] = [];
  for (const item of list) {
    const idRaw = (item as any)?.id;
    const id = typeof idRaw === 'number' ? idRaw : typeof idRaw === 'string' ? Number.parseInt(idRaw, 10) : NaN;
    const title = typeof (item as any)?.title === 'string' ? (item as any).title.trim() : '';
    const description = typeof (item as any)?.description === 'string' ? (item as any).description : '';
    const statusRaw = typeof (item as any)?.status === 'string' ? (item as any).status : 'not-started';
    const status = (allowed.has(statusRaw) ? statusRaw : 'not-started') as TodoItem['status'];

    if (!Number.isFinite(id) || id <= 0) continue;
    if (!title) continue;
    normalized.push({ id, title, description, status });
  }
  if (!normalized.length) return null;
  normalized.sort((a, b) => a.id - b.id);
  return normalized;
}
