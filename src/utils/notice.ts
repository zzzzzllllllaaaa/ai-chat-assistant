import { Notice } from "obsidian";
import { redactString } from "./redact";

export function safeNotice(message: string, timeout?: number): Notice {
  const safe = redactString(String(message ?? ""));
  return new Notice(safe, timeout);
}
