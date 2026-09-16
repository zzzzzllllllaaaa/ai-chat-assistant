import { ChatMessage } from "./types";

export function estimateTokensFromText(text: string): number {
  if (!text) return 0;

  // Heuristic tokenizer (fast, no deps):
  // - CJK characters are closer to 1 token each
  // - Non‑CJK (latin, numbers, punctuation) roughly ~4 chars per token
  const cjkMatches = text.match(/[\u4e00-\u9fff]/g);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const nonCjkCount = Math.max(0, text.length - cjkCount);

  const estimated = cjkCount * 0.9 + nonCjkCount / 4;
  return Math.max(0, Math.ceil(estimated));
}

export function estimateTokensFromMessages(messages: ChatMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    // Overhead per message (role, JSON framing, etc.)
    total += 4;

    if (typeof msg?.content === "string") total += estimateTokensFromText(msg.content);

    // Some providers encode tool/function metadata; count lightly.
    if (Array.isArray((msg as any)?.tool_calls)) {
      try {
        total += estimateTokensFromText(JSON.stringify((msg as any).tool_calls));
      } catch {
        // ignore
      }
    }
  }
  return total;
}

export function formatTokenCountCompact(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "0";
  if (tokens < 1000) return String(tokens);
  const k = tokens / 1000;
  // 1.0k, 1.2k, 12k
  if (k < 10) return `${k.toFixed(1)}k`;
  return `${Math.round(k)}k`;
}
