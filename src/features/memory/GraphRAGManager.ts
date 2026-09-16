import { App } from "obsidian";
import type { IPluginContext } from "../../core/plugin-context";;
import type { GraphNode, GraphEdge } from "../../services/vector/VectorDB";
import { logger } from "../../core/logger";

/**
 * 图谱游走结果（子图）
 */
export interface SubGraph {
    centerNode: GraphNode;
    relatedNodes: GraphNode[];
    edges: GraphEdge[];
    contextText: string; // 转换为自然语言的上下文描述
}

/**
 * 三元组提取结果
 */
export interface TripletExtractionResult {
    entities: Array<{
        id: string;
        type: 'Character' | 'Location' | 'Item' | 'Faction' | 'Event' | 'Concept';
        name: string;
        description?: string;
        properties?: Record<string, any>;
    }>;
    relationships: Array<{
        source: string;
        target: string;
        relation: string;
        weight?: number;
        properties?: Record<string, any>;
    }>;
}

/**
 * Graph RAG 管理器
 * 负责知识图谱的构建、查询和游走
 */
export class GraphRAGManager {
    private app: App;
    private plugin: IPluginContext;

    constructor(app: App, plugin: IPluginContext) {
        this.app = app;
        this.plugin = plugin;
    }

    /**
     * 从对话中提取三元组（轻量级 Prompt）
     */
    async extractTriplets(conversationText: string, personaId: string): Promise<TripletExtractionResult | null> {
        const prompt = [
            {
                role: 'system' as const,
                content: `你是知识图谱提取助手。从对话中提取核心的实体和关系。

【提取规则】
1. 只提取明确出现的实体（人物、地点、物品、势力、事件）
2. 只提取明确的关系（谁拥有什么、谁在哪里、谁对谁做了什么）
3. 不要凭空捏造，不确定的不要提取
4. 实体 ID 使用实体的名称（如 "林慧欣"）
5. 关系要简洁明确（如 "拥有"、"位于"、"敌对"、"信任"）

【输出格式】
严格输出 JSON，格式如下：
{
  "entities": [
    {
      "id": "实体唯一标识（使用名称）",
      "type": "Character|Location|Item|Faction|Event|Concept",
      "name": "显示名称",
      "description": "简短描述（1-2句话）",
      "properties": {"关键属性": "值"}
    }
  ],
  "relationships": [
    {
      "source": "源实体ID",
      "target": "目标实体ID",
      "relation": "关系类型",
      "weight": 0.8,
      "properties": {"补充说明": "值"}
    }
  ]
}

【示例】
对话："林慧欣把商队通行证交给了我，说这能免税进入北城区。"
输出：
{
  "entities": [
    {"id": "林慧欣", "type": "Character", "name": "林慧欣", "description": "商队相关人物"},
    {"id": "商队通行证", "type": "Item", "name": "商队通行证", "description": "可免税进入北城区的铁牌"}
  ],
  "relationships": [
    {"source": "林慧欣", "target": "商队通行证", "relation": "曾拥有"},
    {"source": "主角", "target": "商队通行证", "relation": "当前持有"},
    {"source": "商队通行证", "target": "北城区", "relation": "可进入"}
  ]
}

只输出 JSON，不要其他内容。`
            },
            {
                role: 'user' as const,
                content: conversationText
            }
        ];

        try {
            const model = this.getMemoryModel();
            logger.debug("GraphRAG", `提取三元组，使用模型: ${model}`);
            
            const response = await this.plugin.llmService.getCompletion(prompt, model);
            const raw = response?.content || "";
            
            const parsed = this.tryParseJsonObject(raw);
            if (!parsed || !parsed.entities || !parsed.relationships) {
                logger.warn("GraphRAG", "三元组提取失败：JSON 格式错误");
                return null;
            }

            return {
                entities: Array.isArray(parsed.entities) ? parsed.entities : [],
                relationships: Array.isArray(parsed.relationships) ? parsed.relationships : []
            };
        } catch (e) {
            logger.error("GraphRAG", "三元组提取异常", e);
            return null;
        }
    }

    /**
     * 将提取的三元组保存到图数据库
     */
    async saveTriplets(triplets: TripletExtractionResult, personaId: string): Promise<void> {
        const now = Date.now();
        const db = this.plugin.vectorIndexManager?.db;
        if (!db) {
            logger.warn("GraphRAG", "VectorDB 未初始化");
            return;
        }

        // 构建节点
        const nodes: GraphNode[] = triplets.entities.map(entity => ({
            id: `${personaId}:${entity.id}`, // 加上 personaId 前缀避免冲突
            type: entity.type,
            name: entity.name,
            description: entity.description,
            properties: entity.properties,
            personaId,
            createdAt: now,
            updatedAt: now
        }));

        // 构建边
        const edges: GraphEdge[] = triplets.relationships.map(rel => ({
            id: `${personaId}:${rel.source}-${rel.relation}-${rel.target}-${now}`,
            source: `${personaId}:${rel.source}`,
            target: `${personaId}:${rel.target}`,
            relation: rel.relation,
            weight: rel.weight,
            properties: rel.properties,
            personaId,
            createdAt: now
        }));

        // 保存到数据库
        await db.saveGraphNodes(nodes);
        await db.saveGraphEdges(edges);

        logger.info("GraphRAG", `保存了 ${nodes.length} 个节点和 ${edges.length} 条边`);
    }

    /**
     * 从用户查询中识别实体（简单的关键词匹配 + 可选的 NER）
     */
    async extractEntitiesFromQuery(query: string, personaId: string): Promise<string[]> {
        const db = this.plugin.vectorIndexManager?.db;
        if (!db) return [];

        // 获取该角色的所有节点
        const allNodes = await db.getGraphNodesByPersona(personaId);
        
        // 简单匹配：查询中包含节点名称
        const matchedEntities = allNodes
            .filter(node => query.includes(node.name))
            .map(node => node.id);

        return matchedEntities;
    }

    /**
     * 图游走：从中心节点出发，获取 N 跳内的子图
     */
    async getSubGraph(centerNodeId: string, maxHops: number = 1): Promise<SubGraph | null> {
        const db = this.plugin.vectorIndexManager?.db;
        if (!db) return null;

        const centerNode = await db.getGraphNode(centerNodeId);
        if (!centerNode) return null;

        const visitedNodes = new Set<string>([centerNodeId]);
        const visitedEdges = new Set<string>();
        const relatedNodes: GraphNode[] = [];
        const edges: GraphEdge[] = [];

        // BFS 遍历
        let currentLayer = [centerNodeId];
        for (let hop = 0; hop < maxHops; hop++) {
            const nextLayer: string[] = [];

            for (const nodeId of currentLayer) {
                const nodeEdges = await db.getGraphEdgesByNode(nodeId);

                for (const edge of nodeEdges) {
                    if (visitedEdges.has(edge.id)) continue;
                    visitedEdges.add(edge.id);
                    edges.push(edge);

                    // 找到相邻节点
                    const neighborId = edge.source === nodeId ? edge.target : edge.source;
                    if (!visitedNodes.has(neighborId)) {
                        visitedNodes.add(neighborId);
                        nextLayer.push(neighborId);

                        const neighborNode = await db.getGraphNode(neighborId);
                        if (neighborNode) {
                            relatedNodes.push(neighborNode);
                        }
                    }
                }
            }

            currentLayer = nextLayer;
            if (currentLayer.length === 0) break;
        }

        // 转换为自然语言上下文
        const contextText = this.subGraphToText(centerNode, relatedNodes, edges);

        return {
            centerNode,
            relatedNodes,
            edges,
            contextText
        };
    }

    /**
     * 将子图转换为自然语言描述
     */
    private subGraphToText(centerNode: GraphNode, relatedNodes: GraphNode[], edges: GraphEdge[]): string {
        const lines: string[] = [];
        
        lines.push(`## 关于 ${centerNode.name} 的记忆`);
        if (centerNode.description) {
            lines.push(`- ${centerNode.description}`);
        }

        if (edges.length > 0) {
            lines.push(`\n### 相关关系`);
            for (const edge of edges) {
                const sourceName = edge.source.split(':').pop() || edge.source;
                const targetName = edge.target.split(':').pop() || edge.target;
                lines.push(`- ${sourceName} ${edge.relation} ${targetName}`);
            }
        }

        if (relatedNodes.length > 0) {
            lines.push(`\n### 相关实体`);
            for (const node of relatedNodes) {
                lines.push(`- ${node.name}${node.description ? ': ' + node.description : ''}`);
            }
        }

        return lines.join('\n');
    }

    /**
     * 混合检索：结合图谱和向量检索
     */
    async hybridSearch(query: string, personaId: string, maxHops: number = 1): Promise<string> {
        // 1. 从查询中识别实体
        const entities = await this.extractEntitiesFromQuery(query, personaId);
        
        if (entities.length === 0) {
            return ""; // 没有匹配的实体，返回空
        }

        // 2. 对每个实体进行图游走
        const subGraphs: SubGraph[] = [];
        for (const entityId of entities) {
            const subGraph = await this.getSubGraph(entityId, maxHops);
            if (subGraph) {
                subGraphs.push(subGraph);
            }
        }

        // 3. 合并所有子图的上下文
        if (subGraphs.length === 0) return "";

        const contextParts = subGraphs.map(sg => sg.contextText);
        return contextParts.join('\n\n---\n\n');
    }

    /**
     * 获取记忆模型
     */
    private getMemoryModel(): string {
        const settings = this.plugin.settings;
        return settings.memoryModel?.trim() 
            || settings.routerModel?.trim() 
            || settings.chatModels.split(',')[0]?.trim() 
            || 'gpt-3.5-turbo';
    }

    /**
     * 尝试解析 JSON
     */
    private tryParseJsonObject(text: string): any | null {
        const trimmed = String(text || "").trim();
        if (!trimmed) return null;

        const withoutFences = trimmed
            .replace(/^```(?:json)?\s*/i, "")
            .replace(/```\s*$/i, "")
            .trim();

        try {
            const parsed = JSON.parse(withoutFences);
            if (parsed && typeof parsed === "object") return parsed;
            return null;
        } catch {
            return null;
        }
    }
}
