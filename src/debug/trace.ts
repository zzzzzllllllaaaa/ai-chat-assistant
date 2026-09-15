export type DebugEventLevel = "debug" | "info" | "warn" | "error";

export type DebugEventType =
  | "run_start"
  | "run_end"
  | "intent_routed"
  | "plan_generated"
  | "step_start"
  | "step_end"
  | "step_completed"
  | "step_failed"
  | "llm_call"
  | "tool_call"
  | "tool_result"
  | "guardrail_triggered"
  // StateGraph specific
  | "graph_start"
  | "graph_end"
  | "graph_complete"
  | "graph_aborted"
  | "node_enter"
  | "node_exit"
  | "node_error"
  | "route_result"
  | "replan_complete";

export interface DebugEvent {
  runId: string;
  ts: number;
  level: DebugEventLevel;
  type: DebugEventType;
  message: string;
  // optional structured payload
  data?: Record<string, any>;
}

export class DebugTrace {
  private events: DebugEvent[] = [];

  constructor(public readonly runId: string) {}

  add(level: DebugEventLevel, type: DebugEventType, message: string, data?: Record<string, any>) {
    this.events.push({
      runId: this.runId,
      ts: Date.now(),
      level,
      type,
      message,
      data,
    });
  }

  toJSONLines(maxEvents = 2000): string {
    const slice = this.events.slice(0, maxEvents);
    return slice.map((e) => JSON.stringify(e)).join("\n");
  }

  toMarkdownSummary(): string {
    const counts: Record<string, number> = {};
    for (const e of this.events) counts[e.type] = (counts[e.type] || 0) + 1;

    const lines: string[] = [];
    lines.push("## Debug summary");
    lines.push("");
    lines.push(`runId: ${this.runId}`);
    lines.push("");
    lines.push("事件计数:");
    for (const [k, v] of Object.entries(counts)) {
      lines.push(`- ${k}: ${v}`);
    }
    return lines.join("\n");
  }
}
