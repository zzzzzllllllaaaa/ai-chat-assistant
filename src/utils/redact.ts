export type RedactOptions = {
  maxDepth?: number;
  maxStringLength?: number;
};

const DEFAULT_OPTS: Required<RedactOptions> = {
  maxDepth: 6,
  maxStringLength: 20000,
};

const SENSITIVE_KEY_RE = /(^|[^a-z])(api[-_]?key|authorization|cookie|set-cookie|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|password)([^a-z]|$)/i;

export function redactString(input: string, opts?: RedactOptions): string {
  const { maxStringLength } = { ...DEFAULT_OPTS, ...opts };
  const s = String(input ?? "");
  const clipped = s.length > maxStringLength ? s.slice(0, maxStringLength) + "…" : s;

  return clipped
    // Common auth header formats
    .replace(/Bearer\s+[A-Za-z0-9._\-]{8,}/gi, "Bearer ***")
    .replace(/Basic\s+[A-Za-z0-9+/=]{8,}/gi, "Basic ***")
    // OpenAI-style keys
    .replace(/\bsk-[A-Za-z0-9]{8,}\b/g, "sk-***")
    // Querystring-ish leaks
    .replace(/([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|key)=)[^&#\s]+/gi, "$1***")
    // JSON-ish leaks
    .replace(/("(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization|cookie|set-cookie)"\s*:\s*")([^"]+)(")/gi, "$1***$3")
    // Header-ish leaks
    .replace(/(^|\n)(authorization|cookie|set-cookie)\s*:\s*[^\n]+/gi, (_m, p1, k) => `${p1}${k}: ***`);
}

export function redactForLog<T = any>(value: T, opts?: RedactOptions, depth = 0, seen?: WeakSet<object>): T {
  const options = { ...DEFAULT_OPTS, ...opts };

  if (value == null) return value;

  if (typeof value === "string") {
    return redactString(value, options) as any;
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value;
  }

  if (typeof value === "function") {
    return "[Function]" as any;
  }

  if (value instanceof Date) {
    return value;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message || "", options),
      stack: redactString(value.stack || "", options),
    } as any;
  }

  if (depth >= options.maxDepth) {
    return "[MaxDepth]" as any;
  }

  if (Array.isArray(value)) {
    return value.map((v) => redactForLog(v as any, options, depth + 1, seen)) as any;
  }

  if (typeof value === "object") {
    const obj = value as any;
    const ws = seen ?? new WeakSet<object>();
    if (ws.has(obj)) return "[Circular]" as any;
    ws.add(obj);

    const out: any = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SENSITIVE_KEY_RE.test(k)) {
        out[k] = "***";
      } else {
        out[k] = redactForLog(v as any, options, depth + 1, ws);
      }
    }
    return out;
  }

  // symbol/unknown
  try {
    return redactString(String(value), options) as any;
  } catch {
    return "[Unserializable]" as any;
  }
}
