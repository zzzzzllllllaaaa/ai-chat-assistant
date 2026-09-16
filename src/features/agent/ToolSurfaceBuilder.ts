import type { Tool } from "./types";
import { filterToolNamesByPolicy } from "./ToolPolicy";
import type { SearchPlannerResult } from "./SearchPlanner";
import type { ToolRouter, ToolRoutingDecision } from "./ToolRouter";

export interface ToolSurfaceBuildInput {
  tools: Tool[];
  toolPolicyId?: string | null;
  planner: SearchPlannerResult;
  toolRouter: ToolRouter;
  preferredStartTools?: string[];
  learnedToolSignals?: any[];
  ragReady?: boolean;
  isCustomAgent?: boolean;
}

export interface ToolSurfaceBuildResult {
  policy: ReturnType<typeof filterToolNamesByPolicy>["policy"];
  filtered: boolean;
  policyAllowedToolNames: string[];
  toolRouting: ToolRoutingDecision;
  tools: Tool[];
}

export function buildToolSurface(input: ToolSurfaceBuildInput): ToolSurfaceBuildResult {
  let tools = [...(input.tools || [])];
  const { policy, toolNames: policyAllowedToolNames, filtered } = filterToolNamesByPolicy(
    input.toolPolicyId,
    tools.map(t => t.definition.name),
  );

  if (filtered) {
    const allowedSet = new Set(policyAllowedToolNames);
    tools = tools.filter(t => allowedSet.has(t.definition.name));
  }

  input.toolRouter.registerToolDefinitions(tools.map(t => t.definition));
  const toolRouting = input.toolRouter.route({
    toolNames: tools.map(t => t.definition.name),
    planner: input.planner,
    preferredStartTools: input.preferredStartTools,
    learnedToolSignals: input.learnedToolSignals,
    ragReady: Boolean((input as any)?.ragReady),
    isCustomAgent: input.isCustomAgent,
  });

  const routedToolSet = new Set(toolRouting.allowedToolNames);
  tools = tools.filter(t => routedToolSet.has(t.definition.name));

  if (toolRouting.prioritizedToolNames.length > 0) {
    const ranking = new Map(toolRouting.prioritizedToolNames.map((name, idx) => [name, idx]));
    tools = [...tools].sort((a, b) => {
      const aRank = ranking.has(a.definition.name) ? (ranking.get(a.definition.name) as number) : Number.MAX_SAFE_INTEGER;
      const bRank = ranking.has(b.definition.name) ? (ranking.get(b.definition.name) as number) : Number.MAX_SAFE_INTEGER;
      if (aRank !== bRank) return aRank - bRank;
      return a.definition.name.localeCompare(b.definition.name);
    });
  }

  return {
    policy,
    filtered,
    policyAllowedToolNames,
    toolRouting,
    tools,
  };
}
