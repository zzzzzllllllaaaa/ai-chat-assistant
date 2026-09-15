/**
 * StateGraph - LangGraph 风格的状态机执行引擎
 * 
 * 核心概念：
 * - State: 可变的执行状态，贯穿整个流程
 * - Node: 执行节点，每个节点处理特定任务并更新状态
 * - Edge: 状态转换边，可以是无条件的或条件分支
 * - Graph: 节点和边的组合，定义完整的执行流程
 */

import { App, Platform } from "obsidian";
import { logger } from "../../core/logger";
import { DebugTrace, DebugEventType } from "../../debug/trace";
import { makeRunId } from "../../debug/ids";
import { PlanStep, ExecutionPlan } from "./types";
import { ReflectionEntry, ReflectionManager, getReflectionManager } from "../agent/reflection";
import { SearchPlanner } from "../agent/SearchPlanner";
import { ToolRouter } from "../agent/ToolRouter";
import { buildToolSurface } from "../agent/ToolSurfaceBuilder";
import { executeToolWithGuards, tryParseToolArgsLoose, validateAndNormalizeToolArgs, buildModelSafeParameters } from "../agent/ToolBatchExecutor";
import type { PermissionManager } from "../agent/PermissionManager";
import type { ExecutionVerifier } from "../agent/ExecutionVerifier";
import { ChatMessage } from "../../core/types";

// ============ 状态定义 ============

export type GraphNodeName = 
    | 'start'
    | 'route'           // 意图路由
    | 'plan'            // 生成执行计划
    | 'execute_step'    // 执行单个步骤
    | 'review_step'     // 评审步骤结果
    | 'replan'          // 动态重规划
    | 'reflect'         // 反思失败原因
    | 'synthesize'      // 汇总最终结果
    | 'end';

export type GraphStatus = 
    | 'initializing'
    | 'routing'
    | 'planning'
    | 'executing'
    | 'reviewing'
    | 'replanning'
    | 'reflecting'
    | 'synthesizing'
    | 'completed'
    | 'failed';

export interface StepResult {
    stepId: number;
    workerType: string;
    success: boolean;
    output: string;
    durationMs: number;
    toolCallsCount: number;
    error?: string;
}

export interface GraphState {
    // 基础信息
    runId: string;
    originalGoal: string;
    systemPrompt: string;
    
    // 执行状态
    status: GraphStatus;
    currentNode: GraphNodeName;
    
    // 意图路由结果
    routeLevel?: 'assistant' | 'specialist' | 'pm' | 'ceo';
    assignedSpecialist?: string;
    
    // 执行计划
    plan: ExecutionPlan | null;
    currentStepIndex: number;
    
    // 结果累积（黑板模式）
    blackboard: Map<string, any>;
    stepResults: StepResult[];
    context: string;  // 文本形式的累积上下文
    
    // 错误与重试
    consecutiveFailures: number;
    totalRetries: number;
    maxRetries: number;
    lastError: string | null;
    
    // 反思记录
    reflections: ReflectionEntry[];
    
    // 最终输出
    finalOutput: string;
    
    // 调试
    debugTrace: DebugTrace | null;
    startedAt: number;
    
    // 回调
    onUpdate?: (msg: string) => void;
    
    // 中止控制
    abortSignal?: AbortSignal;
}

// ============ 节点定义 ============

export type NodeFunction = (state: GraphState, context: NodeContext) => Promise<GraphState>;

export interface NodeContext {
    app: App;
    plugin: any;  // AiChatAssistantPlugin
    llmService: any;
    agentManager: any;
    reflectionManager: ReflectionManager;
    searchPlanner: SearchPlanner;
    toolRouterAgent: ToolRouter;
    permissionManager: PermissionManager;
    executionVerifier: ExecutionVerifier;
}

export interface GraphNode {
    name: GraphNodeName;
    execute: NodeFunction;
}

// ============ 边定义 ============

export type EdgeCondition = (state: GraphState) => GraphNodeName;

export interface GraphEdge {
    from: GraphNodeName;
    to: GraphNodeName | EdgeCondition;  // 可以是固定目标或条件函数
}

function resolveCollaborationToolTimeoutMs(toolName: string): number {
    const name = String(toolName || "").trim();
    const isMobile = Platform.isMobile;

    if (name.startsWith("mcp_")) return isMobile ? 45_000 : 75_000;
    if (/^(read_note|search_notes|list_files|vector_search|knowledge_base_query|get_note_structure|explore_note_links|find_note_relationships|find_symbol|find_references|read_code_region|list_code_dependencies|read_canvas)$/.test(name)) {
        return isMobile ? 15_000 : 20_000;
    }
    if (/^(replace_in_note|modify_note|append_to_note|create_note|move_item|create_folder|update_properties|modify_canvas|create_canvas|create_canvas_mindmap)$/.test(name)) {
        return isMobile ? 20_000 : 30_000;
    }
    return isMobile ? 25_000 : 35_000;
}

export class StateGraph {
    private nodes: Map<GraphNodeName, GraphNode> = new Map();
    private edges: Map<GraphNodeName, GraphEdge[]> = new Map();
    private entryPoint: GraphNodeName = 'start';
    private context: NodeContext;
    
    constructor(context: NodeContext) {
        this.context = context;
    }
    
    /**
     * 添加节点
     */
    addNode(name: GraphNodeName, execute: NodeFunction): this {
        this.nodes.set(name, { name, execute });
        return this;
    }
    
    /**
     * 添加边（无条件转换）
     */
    addEdge(from: GraphNodeName, to: GraphNodeName): this {
        if (!this.edges.has(from)) {
            this.edges.set(from, []);
        }
        this.edges.get(from)!.push({ from, to });
        return this;
    }
    
    /**
     * 添加条件边（根据状态决定下一个节点）
     */
    addConditionalEdge(from: GraphNodeName, condition: EdgeCondition): this {
        if (!this.edges.has(from)) {
            this.edges.set(from, []);
        }
        this.edges.get(from)!.push({ from, to: condition });
        return this;
    }
    
    /**
     * 设置入口点
     */
    setEntryPoint(node: GraphNodeName): this {
        this.entryPoint = node;
        return this;
    }
    
    /**
     * 获取下一个节点
     */
    private getNextNode(currentNode: GraphNodeName, state: GraphState): GraphNodeName | null {
        const edges = this.edges.get(currentNode);
        if (!edges || edges.length === 0) {
            return null;
        }
        
        // 取第一条边（可以扩展为支持多条件）
        const edge = edges[0];
        if (typeof edge.to === 'function') {
            return edge.to(state);
        }
        return edge.to;
    }
    
    /**
     * 执行状态图
     */
    async run(initialState: Partial<GraphState>): Promise<GraphState> {
        const runId = makeRunId("graph");
        const debugTrace = new DebugTrace(runId);
        
        // 初始化完整状态
        const state: GraphState = {
            runId,
            originalGoal: initialState.originalGoal || "",
            systemPrompt: initialState.systemPrompt || "",
            status: 'initializing',
            currentNode: this.entryPoint,
            plan: null,
            currentStepIndex: 0,
            blackboard: new Map(),
            stepResults: [],
            context: "",
            consecutiveFailures: 0,
            totalRetries: 0,
            maxRetries: initialState.maxRetries ?? 3,
            lastError: null,
            reflections: [],
            finalOutput: "",
            debugTrace,
            startedAt: Date.now(),
            onUpdate: initialState.onUpdate,
            ...initialState
        };
        
        logger.debug("AI", `[StateGraph] Run started: ${runId}`, { 
            runId, 
            goal: state.originalGoal.substring(0, 100) 
        });
        debugTrace.add("info", "graph_start", "run", { 
            goal: state.originalGoal,
            entryPoint: this.entryPoint 
        });
        
        let currentNode = this.entryPoint;
        let iterations = 0;
        const maxIterations = 50;  // 防止无限循环
        
        while (currentNode !== 'end' && iterations < maxIterations) {
            // 检查是否已被中止
            if (state.abortSignal?.aborted) {
                logger.info("AI", `[StateGraph] Aborted by user at iteration ${iterations}`);
                state.status = 'failed';
                state.lastError = '用户已停止生成';
                state.finalOutput = state.context || '执行已被用户中止。';
                debugTrace.add("info", "graph_aborted", "run", { iteration: iterations });
                break;
            }
            iterations++;
            
            const node = this.nodes.get(currentNode);
            if (!node) {
                logger.error("AI", `[StateGraph] Node not found: ${currentNode}`);
                state.status = 'failed';
                state.lastError = `Node not found: ${currentNode}`;
                break;
            }
            
            state.currentNode = currentNode;
            
            debugTrace.add("debug", "node_enter", currentNode, { 
                iteration: iterations,
                status: state.status 
            });
            
            const nodeStartedAt = Date.now();
            
            try {
                // 执行节点
                const newState = await node.execute(state, this.context);
                Object.assign(state, newState);
                
                debugTrace.add("debug", "node_exit", currentNode, { 
                    durationMs: Date.now() - nodeStartedAt,
                    status: state.status 
                });
                
            } catch (error: any) {
                logger.error("AI", `[StateGraph] Node error: ${currentNode}`, error);
                state.lastError = error.message || String(error);
                state.consecutiveFailures++;
                
                debugTrace.add("error", "node_error", currentNode, { 
                    error: state.lastError,
                    consecutiveFailures: state.consecutiveFailures 
                });
                
                // 如果连续失败太多次，直接结束
                if (state.consecutiveFailures >= 3) {
                    state.status = 'failed';
                    currentNode = 'end';
                    continue;
                }
            }
            
            // 获取下一个节点
            const nextNode = this.getNextNode(currentNode, state);
            if (!nextNode) {
                logger.debug("AI", `[StateGraph] No next node from ${currentNode}, ending`);
                break;
            }
            
            currentNode = nextNode;
        }
        
        if (iterations >= maxIterations) {
            logger.warn("AI", `[StateGraph] Max iterations reached: ${maxIterations}`);
            state.status = 'failed';
            state.lastError = "Max iterations reached";
        }
        
        debugTrace.add("info", "graph_end", "run", { 
            totalIterations: iterations,
            durationMs: Date.now() - state.startedAt,
            finalStatus: state.status 
        });
        
        logger.debug("AI", `[StateGraph] Run completed: ${runId}`, { 
            runId, 
            iterations, 
            status: state.status,
            durationMs: Date.now() - state.startedAt 
        });
        
        return state;
    }
}

// ============ 预定义节点实现 ============

/**
 * 创建标准的协作状态图
 */
export function createCollaborationGraph(context: NodeContext): StateGraph {
    const graph = new StateGraph(context);
    
    // 添加所有节点
    graph
        .addNode('start', startNode)
        .addNode('route', routeNode)
        .addNode('plan', planNode)
        .addNode('execute_step', executeStepNode)
        .addNode('review_step', reviewStepNode)
        .addNode('replan', replanNode)
        .addNode('reflect', reflectNode)
        .addNode('synthesize', synthesizeNode)
        .addNode('end', endNode);
    
    // 定义边和条件转换
    graph
        .setEntryPoint('start')
        .addEdge('start', 'route')
        .addConditionalEdge('route', routeCondition)
        .addEdge('plan', 'execute_step')
        .addConditionalEdge('execute_step', executeCondition)
        .addConditionalEdge('review_step', reviewCondition)
        .addEdge('replan', 'execute_step')
        .addEdge('reflect', 'replan')
        .addEdge('synthesize', 'end');
    
    return graph;
}

// ============ 节点实现 ============

async function startNode(state: GraphState, ctx: NodeContext): Promise<GraphState> {
    state.onUpdate?.(`🚀 启动智能协作状态机 (StateGraph v2)...`);
    state.status = 'routing';
    
    // 注入历史反思
    const relevantReflections = ctx.reflectionManager.getRelevantReflections({
        taskDescription: state.originalGoal,
        limit: 5
    });
    if (relevantReflections.length > 0) {
        state.reflections = relevantReflections;
        const reflectionContext = ctx.reflectionManager.formatReflectionsForContext(relevantReflections);
        state.systemPrompt += `\n\n${reflectionContext}`;
        state.onUpdate?.(`📚 已加载 ${relevantReflections.length} 条历史反思经验`);
    }
    
    return state;
}

async function routeNode(state: GraphState, ctx: NodeContext): Promise<GraphState> {
    state.onUpdate?.(`🧭 正在分析任务复杂度...`);
    
    const routePrompt = [
        {
            role: 'system' as const,
            content: `You are the "Chief Assistant" of a Decentralized AI Agent Grid. Route the user's request to the most efficient level.

Escalation Levels:
1. 'assistant': Fast Track. Direct reply for greetings, simple questions, translations.
2. 'specialist': Direct Handoff. For tasks requiring one specific expert tool.
3. 'pm': Workflow. For tasks requiring 2-3 clear steps.
4. 'ceo': Strategic Planning. For complex, multi-step projects.

Return ONLY JSON: {"level": "...", "assignedSpecialist": "..."|null, "confidence": number, "reasoning": "..."}`
        },
        { role: 'user' as const, content: state.originalGoal }
    ];
    
    try {
        const response = await ctx.llmService.getCompletion(
            routePrompt, 
            ctx.plugin.settings.routerModel
        );
        
        const content = response.content || "{}";
        const match = content.match(/\{[\s\S]*\}/);
        if (match) {
            const parsed = JSON.parse(match[0]);
            state.routeLevel = parsed.level || 'pm';
            state.assignedSpecialist = parsed.assignedSpecialist;
            
            state.debugTrace?.add("info", "route_result", "route", { 
                level: state.routeLevel,
                specialist: state.assignedSpecialist,
                reasoning: parsed.reasoning 
            });
        }
    } catch (e: any) {
        logger.warn("AI", "[StateGraph] Route failed, defaulting to pm", e);
        state.routeLevel = 'pm';
    }
    
    state.onUpdate?.(`📊 任务级别: ${state.routeLevel?.toUpperCase()} ${state.assignedSpecialist ? `→ ${state.assignedSpecialist}` : ''}`);
    
    return state;
}

function routeCondition(state: GraphState): GraphNodeName {
    switch (state.routeLevel) {
        case 'assistant':
            // 简单任务直接合成回复
            return 'synthesize';
        case 'specialist':
        case 'pm':
        case 'ceo':
            // 需要规划
            return 'plan';
        default:
            return 'plan';
    }
}

async function planNode(state: GraphState, ctx: NodeContext): Promise<GraphState> {
    state.status = 'planning';
    state.onUpdate?.(`📋 [CEO] 正在制定执行计划...`);
    
    const planPrompt = [
        {
            role: 'system' as const,
            content: `You are the Strategic Planner (CEO). Break down the goal into executable steps.

Available Specialists:
- 'researcher': Gathers information from vault or web
- 'analyst': Processes and structures data
- 'writer': Drafts content and reports
- 'coder': Writes and explains code
- 'executor': Performs file operations AND executes Obsidian commands ("执行", "运行", "重建索引", "刷新")

Guidelines:
- For tasks requiring Obsidian command execution, use 'executor' with list_commands + execute_command
- For search/retrieval tasks, use 'researcher'

Return ONLY JSON:
{
  "originalGoal": "${state.originalGoal}",
  "steps": [
    { "id": 1, "description": "...", "workerType": "researcher", "dependencies": [] },
    ...
  ]
}`
        },
        { role: 'user' as const, content: state.originalGoal }
    ];
    
    try {
        const response = await ctx.llmService.getCompletion(
            planPrompt, 
            ctx.plugin.settings.plannerModel
        );
        
        const content = response.content || "{}";
        const match = content.match(/\{[\s\S]*\}/);
        if (match) {
            const parsed = JSON.parse(match[0]);
            
            const steps: PlanStep[] = (parsed.steps || []).map((s: any, idx: number) => ({
                id: s.id || idx + 1,
                description: s.description || "",
                workerType: s.workerType || 'analyst',
                status: 'pending' as const,
                dependencies: s.dependencies || []
            }));
            
            state.plan = {
                originalGoal: state.originalGoal,
                steps
            };
            
            state.onUpdate?.(`📝 计划已生成: ${steps.length} 个步骤`);
            steps.forEach((s, i) => {
                state.onUpdate?.(`   ${i + 1}. [${s.workerType}] ${s.description.substring(0, 50)}...`);
            });
            
            state.debugTrace?.add("info", "plan_generated", "plan", { 
                stepCount: steps.length,
                steps: steps.map(s => ({ id: s.id, type: s.workerType })) 
            });
        }
    } catch (e: any) {
        logger.error("AI", "[StateGraph] Planning failed", e);
        state.lastError = e.message;
        // 创建一个默认的单步计划
        state.plan = {
            originalGoal: state.originalGoal,
            steps: [{
                id: 1,
                description: state.originalGoal,
                workerType: 'analyst',
                status: 'pending',
                dependencies: []
            }]
        };
    }
    
    state.currentStepIndex = 0;
    state.status = 'executing';
    
    return state;
}

async function executeStepNode(state: GraphState, ctx: NodeContext): Promise<GraphState> {
    if (!state.plan || state.currentStepIndex >= state.plan.steps.length) {
        state.status = 'synthesizing';
        return state;
    }
    
    const step = state.plan.steps[state.currentStepIndex];
    step.status = 'running';
    
    state.onUpdate?.(`\n正在处理一项子任务：${step.description}`);

    const stepStartedAt = Date.now();

    try {
        // 获取专家对应的工具
        const baseTools = ctx.agentManager.getToolsForAgent("note-assistant");
        let candidateToolNames: string[] = [];

        switch (step.workerType) {
            case 'researcher':
                candidateToolNames = ['search_notes', 'read_note', 'get_recent_notes', 'list_files',
                    'knowledge_base_query', 'vector_search', 'mcp_list_tools', 'mcp_call_tool'];
                break;
            case 'analyst':
                candidateToolNames = ['list_files', 'get_recent_notes', 'read_note', 'search_notes',
                    'vector_search', 'knowledge_base_query'];
                break;
            case 'writer':
                candidateToolNames = ['read_note', 'search_notes', 'knowledge_base_query'];
                break;
            case 'executor':
                candidateToolNames = ['create_note', 'modify_note', 'move_item', 'delete_file',
                    'append_to_note', 'create_folder', 'read_note',
                    'execute_command', 'list_commands'];
                break;
            case 'coder':
                candidateToolNames = ['read_note', 'search_notes', 'list_files', 'knowledge_base_query'];
                break;
        }

        const candidateToolSet = new Set(candidateToolNames);
        const candidateTools = baseTools.filter((t: any) => candidateToolSet.has(t.definition.name));
        const workerPlanner = await ctx.searchPlanner.plan({
            userInput: step.description,
            context: `${state.originalGoal}\n${state.context || ""}`,
            mode: 'collaboration',
            agentName: step.workerType,
            availableTools: candidateTools.map((t: any) => t.definition.name),
        });
        const prepared = buildToolSurface({
            tools: candidateTools,
            toolPolicyId: ctx.plugin.resolveConversationToolPolicy(undefined, 'note-assistant', ctx.plugin.settings.activePresetId),
            planner: workerPlanner,
            toolRouter: ctx.toolRouterAgent,
            ragReady: Boolean(ctx.plugin?.ragService?.isReady?.()),
        });
        const tools = prepared.tools;
        state.onUpdate?.(`\n已为当前子任务收口可用动作。`,);

        const openAiTools = tools.map((t: any) => ({
            type: "function",
            function: {
                name: t.definition.name,
                description: t.definition.description,
                parameters: buildModelSafeParameters(t.definition.parameters)
            }
        }));
        
        const messages: ChatMessage[] = [
            {
                role: 'system',
                content: `${state.systemPrompt}

[Specialist Role: ${step.workerType.toUpperCase()}]
You are executing step ${step.id} of a multi-step plan.
Original Goal: ${state.originalGoal}

Previous Steps Context:
${state.context || "(This is the first step)"}

Your Task: ${step.description}

Be precise and efficient. Use tools when needed.`
            },
            { role: 'user', content: `Execute: ${step.description}` }
        ];
        
        // 工具循环
        let stepResult = "";
        let toolCallsCount = 0;
        const maxLoops = ctx.plugin.settings.agentMaxSteps || 10;
        
        for (let loop = 0; loop < maxLoops; loop++) {
            // 检查是否已被中止
            if (state.abortSignal?.aborted) {
                stepResult = "执行已被用户中止";
                break;
            }
            
            const response = await ctx.llmService.getCompletion(
                messages,
                ctx.plugin.settings.writerModel,
                openAiTools.length > 0 ? openAiTools : undefined,
                (token: string) => state.onUpdate?.(token)
            );
            
            messages.push(response);
            
            if (response.tool_calls && response.tool_calls.length > 0) {
                for (const toolCall of response.tool_calls) {
                    const toolName = toolCall.function.name;
                    const rawArgs = toolCall.function.arguments;
                    const parsedArgs = tryParseToolArgsLoose(rawArgs);
                    const { ok: argsOk, args, error: argsError } = validateAndNormalizeToolArgs(toolName, parsedArgs);

                    state.onUpdate?.(`\n正在处理：${toolName}`);
                    toolCallsCount++;

                    const toolInstance = ctx.agentManager.getTool(toolName);
                    let toolResult = "";

                    if (!argsOk) {
                        toolResult = `错误: 工具参数不合法，已跳过执行。${argsError ? `\n原因: ${argsError}` : ""}\nArgs: ${JSON.stringify(parsedArgs ?? {}, null, 2)}`;
                    } else if (toolInstance) {
                        try {
                            const execution = await executeToolWithGuards({
                                app: ctx.app,
                                agentManager: ctx.agentManager,
                                permissionManager: ctx.permissionManager,
                                executionVerifier: ctx.executionVerifier,
                                toolRouterAgent: ctx.toolRouterAgent,
                            }, {
                                toolName,
                                tool: toolInstance,
                                args,
                                timeoutMs: resolveCollaborationToolTimeoutMs(toolName),
                                showNotice: false,
                            });
                            toolResult = execution.result;
                        } catch (err: any) {
                            toolResult = `错误: ${err.message}`;
                        }
                    } else {
                        toolResult = `错误: 未找到工具 ${toolName}`;
                    }
                    
                    const toolCallId = (toolCall as any)?.id || `call_${Date.now()}`;
                    messages.push({
                        role: 'tool',
                        tool_call_id: toolCallId,
                        name: toolName,
                        content: toolResult
                    } as ChatMessage);
                }
            } else {
                stepResult = response.content || "";
                break;
            }
        }
        
        // 记录步骤结果
        const stepResultObj: StepResult = {
            stepId: step.id,
            workerType: step.workerType,
            success: true,
            output: stepResult,
            durationMs: Date.now() - stepStartedAt,
            toolCallsCount
        };
        
        state.stepResults.push(stepResultObj);
        state.context += `\n\n[步骤 ${step.id} (${step.workerType}) 结果]:\n${stepResult}`;
        state.blackboard.set(`step_${step.id}`, stepResultObj);
        
        step.status = 'completed';
        step.result = stepResult;
        state.consecutiveFailures = 0;  // 重置连续失败计数
        
        state.debugTrace?.add("info", "step_completed", "execute_step", { 
            stepId: step.id,
            workerType: step.workerType,
            durationMs: stepResultObj.durationMs,
            toolCallsCount 
        });
        
    } catch (e: any) {
        step.status = 'failed';
        step.result = `❌ 失败: ${e.message}`;
        state.lastError = e.message;
        state.consecutiveFailures++;
        
        state.stepResults.push({
            stepId: step.id,
            workerType: step.workerType,
            success: false,
            output: "",
            durationMs: Date.now() - stepStartedAt,
            toolCallsCount: 0,
            error: e.message
        });
        
        state.onUpdate?.(`\n❌ 步骤 ${step.id} 执行失败: ${e.message}`);
        
        state.debugTrace?.add("error", "step_failed", "execute_step", { 
            stepId: step.id,
            error: e.message,
            consecutiveFailures: state.consecutiveFailures 
        });
    }
    
    state.status = 'reviewing';
    return state;
}

async function reviewStepNode(state: GraphState, ctx: NodeContext): Promise<GraphState> {
    const lastResult = state.stepResults[state.stepResults.length - 1];
    
    if (!lastResult) {
        return state;
    }
    
    // 快速评审：检查输出质量
    const outputLen = lastResult.output?.length || 0;
    const hasError = !lastResult.success;
    const outputTooShort = outputLen < 50 && !hasError;
    
    // 如果失败或输出质量差，可能需要反思和重规划
    if (hasError || outputTooShort) {
        state.onUpdate?.(`\n🔍 [Review] 检测到问题: ${hasError ? '执行失败' : '输出过短'}，考虑重规划...`);
        
        // 记录需要反思
        state.blackboard.set('needsReflection', true);
        state.blackboard.set('lastFailureReason', hasError ? lastResult.error : 'output_too_short');
    } else {
        state.blackboard.set('needsReflection', false);
    }
    
    // 更新步骤索引
    state.currentStepIndex++;
    
    return state;
}

function reviewCondition(state: GraphState): GraphNodeName {
    const needsReflection = state.blackboard.get('needsReflection');
    const hasMoreSteps = state.plan && state.currentStepIndex < state.plan.steps.length;
    
    // 如果需要反思且还有重试机会
    if (needsReflection && state.totalRetries < state.maxRetries) {
        return 'reflect';
    }
    
    // 如果还有更多步骤
    if (hasMoreSteps) {
        return 'execute_step';
    }
    
    // 所有步骤完成，进入汇总
    return 'synthesize';
}

function executeCondition(state: GraphState): GraphNodeName {
    // 执行完成后进入评审
    return 'review_step';
}

async function reflectNode(state: GraphState, ctx: NodeContext): Promise<GraphState> {
    state.status = 'reflecting';
    state.onUpdate?.(`\n🤔 [Reflect] 正在分析失败原因并生成改进策略...`);
    
    const failureReason = state.blackboard.get('lastFailureReason') || 'unknown';
    const lastStepResult = state.stepResults[state.stepResults.length - 1];
    
    // 生成反思 Prompt
    const reflectionMessages = ctx.reflectionManager.generateReflectionPrompt({
        toolName: lastStepResult?.workerType,
        errorMessage: lastStepResult?.error || failureReason,
        previousActions: state.context.slice(-1000)
    });
    
    try {
        const response = await ctx.llmService.getCompletion(
            reflectionMessages,
            ctx.plugin.settings.writerModel
        );
        
        const reflectionResult = ctx.reflectionManager.parseReflectionResponse(
            response.content || ""
        );
        
        if (reflectionResult) {
            // 构建完整的反思条目
            const entry = ctx.reflectionManager.addReflection({
                trigger: 'task_failed',
                context: {
                    toolName: lastStepResult?.workerType,
                    errorMessage: lastStepResult?.error || failureReason,
                    taskDescription: state.originalGoal
                },
                reflection: reflectionResult.rootCause,
                lesson: reflectionResult.lesson,
                preventionStrategy: reflectionResult.preventionStrategy
            });
            
            state.reflections.push(entry);
            
            state.onUpdate?.(`\n💡 反思结论: ${reflectionResult.lesson}`);
            
            // 将反思结果注入上下文供重规划使用
            state.context += `\n\n[反思记录]:\n问题: ${reflectionResult.rootCause}\n教训: ${reflectionResult.lesson}\n预防: ${reflectionResult.preventionStrategy}`;
        }
        
    } catch (e: any) {
        logger.warn("AI", "[StateGraph] Reflection failed", e);
    }
    
    state.totalRetries++;
    state.status = 'replanning';
    
    return state;
}

async function replanNode(state: GraphState, ctx: NodeContext): Promise<GraphState> {
    state.status = 'replanning';
    state.onUpdate?.(`\n🔄 [Replan] 根据反思结果调整执行计划...`);
    
    // 获取剩余未完成的步骤
    const remainingSteps = state.plan?.steps.slice(state.currentStepIndex) || [];
    const completedSteps = state.plan?.steps.slice(0, state.currentStepIndex) || [];
    
    const replanPrompt = [
        {
            role: 'system' as const,
            content: `You are re-planning after a step failure. Based on the reflection and context, generate new steps to achieve the goal.

Original Goal: ${state.originalGoal}

Completed Steps:
${completedSteps.map(s => `- [${s.workerType}] ${s.description}: ${s.status}`).join('\n') || '(none)'}

Failed/Remaining Steps:
${remainingSteps.map(s => `- [${s.workerType}] ${s.description}`).join('\n') || '(none)'}

Reflection Context:
${state.context.slice(-2000)}

Generate new steps (JSON array). Consider:
1. Alternative approaches
2. Breaking down complex steps
3. Adding verification steps

Return ONLY JSON: { "steps": [...] }`
        },
        { role: 'user' as const, content: "Generate revised plan" }
    ];
    
    try {
        const response = await ctx.llmService.getCompletion(
            replanPrompt,
            ctx.plugin.settings.plannerModel
        );
        
        const content = response.content || "{}";
        const match = content.match(/\{[\s\S]*\}/);
        if (match) {
            const parsed = JSON.parse(match[0]);
            
            if (parsed.steps && Array.isArray(parsed.steps)) {
                const newSteps: PlanStep[] = parsed.steps.map((s: any, idx: number) => ({
                    id: completedSteps.length + idx + 1,
                    description: s.description || "",
                    workerType: s.workerType || 'analyst',
                    status: 'pending' as const,
                    dependencies: []
                }));
                
                // 更新计划：保留已完成的步骤 + 新步骤
                state.plan = {
                    originalGoal: state.originalGoal,
                    steps: [...completedSteps, ...newSteps]
                };
                
                state.onUpdate?.(`📝 计划已更新: 新增 ${newSteps.length} 个步骤`);
                
                state.debugTrace?.add("info", "replan_complete", "replan", { 
                    newStepCount: newSteps.length,
                    totalSteps: state.plan.steps.length 
                });
            }
        }
    } catch (e: any) {
        logger.warn("AI", "[StateGraph] Replan failed", e);
        // 如果重规划失败，继续执行原计划
    }
    
    state.status = 'executing';
    state.consecutiveFailures = 0;
    
    return state;
}

async function synthesizeNode(state: GraphState, ctx: NodeContext): Promise<GraphState> {
    state.status = 'synthesizing';
    state.onUpdate?.(`\n📝 [CEO] 正在汇总执行结果...`);
    
    // 如果只有一个步骤且成功，直接使用其输出
    if (state.stepResults.length === 1 && state.stepResults[0].success) {
        state.finalOutput = state.stepResults[0].output;
        state.status = 'completed';
        return state;
    }

    // Default to the last successful step's output instead of the blackboard (context)
    const lastSuccessfulStep = [...state.stepResults].reverse().find(r => r.success);
    const fallbackOutput = lastSuccessfulStep ? lastSuccessfulStep.output : "执行完成，但汇总失败且没有成功的子步骤。";
    
    // 多步骤需要汇总
    const synthesisPrompt = [
        {
            role: 'system' as const,
            content: `${state.systemPrompt}

You are the CEO synthesizing the final report from multiple department outputs.

Original Goal: ${state.originalGoal}

Execution Results:
${state.context}

Create a comprehensive, well-structured final report. Include:
1. Key findings from each step
2. Synthesized conclusions
3. Any actionable recommendations

Be professional and thorough.`
        },
        { role: 'user' as const, content: "请给出最终汇总报告。" }
    ];
    
    try {
        const response = await ctx.llmService.getCompletion(
            synthesisPrompt,
            ctx.plugin.settings.writerModel,
            undefined,
            (token: string) => state.onUpdate?.(token)
        );
        
        state.finalOutput = response.content || fallbackOutput;
        
    } catch (e: any) {
        logger.error("AI", "[StateGraph] Synthesis failed", e);
        state.finalOutput = fallbackOutput;
    }
    
    // 添加执行指标
    const metrics = {
        runId: state.runId,
        durationMs: Date.now() - state.startedAt,
        totalSteps: state.stepResults.length,
        successfulSteps: state.stepResults.filter(r => r.success).length,
        totalRetries: state.totalRetries,
        reflections: state.reflections.length
    };
    
    state.finalOutput += `\n\n---\n### 协作执行指标 (StateGraph v2)\n` +
        `- runId: ${metrics.runId}\n` +
        `- 耗时: ${metrics.durationMs}ms\n` +
        `- 步骤: ${metrics.successfulSteps}/${metrics.totalSteps} 成功\n` +
        `- 重试: ${metrics.totalRetries}\n` +
        `- 反思: ${metrics.reflections}\n---`;
    
    state.status = 'completed';
    
    return state;
}

async function endNode(state: GraphState, ctx: NodeContext): Promise<GraphState> {
    state.onUpdate?.(`\n✅ 状态机执行完成`);
    
    state.debugTrace?.add("info", "graph_complete", "end", { 
        finalStatus: state.status,
        outputLength: state.finalOutput.length 
    });
    
    return state;
}
