export interface VectorRecord {
    path: string;
    vector: Float32Array;
    mtime: number;
    startOffset?: number;
    endOffset?: number;
    links?: string[];
    frontmatter?: Record<string, any>;
}

export interface PrivateMemoryRecord {
    id: string;
    type: 'diary' | 'interest' | 'belief';
    content: string;
    timestamp: number;
    /**
     * 上次被引用/命中的时间戳（用于遗忘衰减）。
     * 兼容旧数据：可能不存在，此时回退到 timestamp。
     */
    lastAccessAt?: number;
    accessCount: number; // 访问次数
    emotionalWeight: number; // 情感权重 (0-1)
    metadata?: any;
}

/**
 * 知识图谱节点（实体）
 */
export interface GraphNode {
    id: string; // 实体唯一标识（如 "林慧欣"）
    type: 'Character' | 'Location' | 'Item' | 'Faction' | 'Event' | 'Concept'; // 实体类型
    name: string; // 显示名称
    description?: string; // 实体描述
    properties?: Record<string, any>; // 扩展属性（如角色的性格、物品的状态等）
    personaId?: string; // 所属角色ID（用于隔离不同角色的记忆）
    createdAt: number; // 创建时间戳
    updatedAt: number; // 最后更新时间戳
}

/**
 * 知识图谱边（关系）
 */
export interface GraphEdge {
    id: string; // 边的唯一标识（自动生成）
    source: string; // 源节点 ID
    target: string; // 目标节点 ID
    relation: string; // 关系类型（如 "拥有"、"位于"、"敌对"）
    weight?: number; // 关系权重/强度 (0-1)，可选
    properties?: Record<string, any>; // 扩展属性（如关系的具体描述、时间等）
    personaId?: string; // 所属角色ID
    createdAt: number; // 创建时间戳
    bidirectional?: boolean; // 是否为双向关系（默认单向）
}

export class VectorDB {
    private dbName = "AiChatAssistantVectors";
    private storeName = "vectors";
    private privateStoreName = "private_memory";
    private graphNodesStoreName = "graph_nodes";
    private graphEdgesStoreName = "graph_edges";
    private db: IDBDatabase | null = null;

    async init(): Promise<void> {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 3); // Version 3 - 新增图谱支持

            request.onupgradeneeded = (event: any) => {
                const db = event.target.result;
                const oldVersion = event.oldVersion;

                // 向量存储
                if (!db.objectStoreNames.contains(this.storeName)) {
                    const store = db.createObjectStore(this.storeName, { keyPath: ["path", "startOffset"] });
                    store.createIndex("path", "path", { unique: false });
                    store.createIndex("mtime", "mtime", { unique: false });
                }

                // 私密记忆
                if (!db.objectStoreNames.contains(this.privateStoreName)) {
                    const store = db.createObjectStore(this.privateStoreName, { keyPath: "id" });
                    store.createIndex("type", "type", { unique: false });
                    store.createIndex("timestamp", "timestamp", { unique: false });
                }

                // 图谱节点（Version 3 新增）
                if (oldVersion < 3 && !db.objectStoreNames.contains(this.graphNodesStoreName)) {
                    const store = db.createObjectStore(this.graphNodesStoreName, { keyPath: "id" });
                    store.createIndex("type", "type", { unique: false });
                    store.createIndex("personaId", "personaId", { unique: false });
                    store.createIndex("updatedAt", "updatedAt", { unique: false });
                }

                // 图谱边（Version 3 新增）
                if (oldVersion < 3 && !db.objectStoreNames.contains(this.graphEdgesStoreName)) {
                    const store = db.createObjectStore(this.graphEdgesStoreName, { keyPath: "id" });
                    store.createIndex("source", "source", { unique: false });
                    store.createIndex("target", "target", { unique: false });
                    store.createIndex("relation", "relation", { unique: false });
                    store.createIndex("personaId", "personaId", { unique: false });
                }
            };

            request.onsuccess = (event: any) => {
                this.db = event.target.result;
                resolve();
            };

            request.onerror = (event: any) => {
                reject(event.target.error);
            };
        });
    }

    async saveVectors(records: VectorRecord[]): Promise<void> {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction([this.storeName], "readwrite");
            const store = transaction.objectStore(this.storeName);

            records.forEach(record => {
                store.put(record);
            });

            transaction.oncomplete = () => resolve();
            transaction.onerror = (event: any) => reject(event.target.error);
        });
    }

    async getAllVectors(): Promise<VectorRecord[]> {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction([this.storeName], "readonly");
            const store = transaction.objectStore(this.storeName);
            const request = store.getAll();

            request.onsuccess = () => resolve(request.result);
            request.onerror = (event: any) => reject(event.target.error);
        });
    }

    async deleteByPath(path: string): Promise<void> {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction([this.storeName], "readwrite");
            const store = transaction.objectStore(this.storeName);
            const index = store.index("path");
            const request = index.openKeyCursor(IDBKeyRange.only(path));

            request.onsuccess = (event: any) => {
                const cursor = event.target.result;
                if (cursor) {
                    store.delete(cursor.primaryKey);
                    cursor.continue();
                } else {
                    resolve();
                }
            };
            request.onerror = (event: any) => reject(event.target.error);
        });
    }

    async clear(): Promise<void> {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction([this.storeName], "readwrite");
            const store = transaction.objectStore(this.storeName);
            const request = store.clear();
            request.onsuccess = () => resolve();
            request.onerror = (event: any) => reject(event.target.error);
        });
    }

    async savePrivateMemory(record: PrivateMemoryRecord): Promise<void> {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction([this.privateStoreName], "readwrite");
            const store = transaction.objectStore(this.privateStoreName);
            store.put(record);
            transaction.oncomplete = () => resolve();
            transaction.onerror = (event: any) => reject(event.target.error);
        });
    }

    async getPrivateMemory(type?: string): Promise<PrivateMemoryRecord[]> {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction([this.privateStoreName], "readonly");
            const store = transaction.objectStore(this.privateStoreName);
            let request: IDBRequest;
            if (type) {
                const index = store.index("type");
                request = index.getAll(IDBKeyRange.only(type));
            } else {
                request = store.getAll();
            }
            request.onsuccess = () => resolve(request.result);
            request.onerror = (event: any) => reject(event.target.error);
        });
    }

    async deletePrivateMemory(id: string): Promise<void> {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction([this.privateStoreName], "readwrite");
            const store = transaction.objectStore(this.privateStoreName);
            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = (event: any) => reject(event.target.error);
        });
    }

    // ============ 知识图谱相关方法 ============

    /**
     * 保存或更新图谱节点（批量）
     */
    async saveGraphNodes(nodes: GraphNode[]): Promise<void> {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction([this.graphNodesStoreName], "readwrite");
            const store = transaction.objectStore(this.graphNodesStoreName);

            nodes.forEach(node => {
                store.put(node);
            });

            transaction.oncomplete = () => resolve();
            transaction.onerror = (event: any) => reject(event.target.error);
        });
    }

    /**
     * 保存或更新图谱边（批量）
     */
    async saveGraphEdges(edges: GraphEdge[]): Promise<void> {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction([this.graphEdgesStoreName], "readwrite");
            const store = transaction.objectStore(this.graphEdgesStoreName);

            edges.forEach(edge => {
                store.put(edge);
            });

            transaction.oncomplete = () => resolve();
            transaction.onerror = (event: any) => reject(event.target.error);
        });
    }

    /**
     * 根据 ID 获取节点
     */
    async getGraphNode(id: string): Promise<GraphNode | null> {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction([this.graphNodesStoreName], "readonly");
            const store = transaction.objectStore(this.graphNodesStoreName);
            const request = store.get(id);

            request.onsuccess = () => resolve(request.result || null);
            request.onerror = (event: any) => reject(event.target.error);
        });
    }

    /**
     * 根据 personaId 获取所有节点
     */
    async getGraphNodesByPersona(personaId: string): Promise<GraphNode[]> {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction([this.graphNodesStoreName], "readonly");
            const store = transaction.objectStore(this.graphNodesStoreName);
            const index = store.index("personaId");
            const request = index.getAll(IDBKeyRange.only(personaId));

            request.onsuccess = () => resolve(request.result);
            request.onerror = (event: any) => reject(event.target.error);
        });
    }

    /**
     * 根据源节点 ID 获取所有出边
     */
    async getGraphEdgesBySource(sourceId: string): Promise<GraphEdge[]> {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction([this.graphEdgesStoreName], "readonly");
            const store = transaction.objectStore(this.graphEdgesStoreName);
            const index = store.index("source");
            const request = index.getAll(IDBKeyRange.only(sourceId));

            request.onsuccess = () => resolve(request.result);
            request.onerror = (event: any) => reject(event.target.error);
        });
    }

    /**
     * 根据目标节点 ID 获取所有入边
     */
    async getGraphEdgesByTarget(targetId: string): Promise<GraphEdge[]> {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction([this.graphEdgesStoreName], "readonly");
            const store = transaction.objectStore(this.graphEdgesStoreName);
            const index = store.index("target");
            const request = index.getAll(IDBKeyRange.only(targetId));

            request.onsuccess = () => resolve(request.result);
            request.onerror = (event: any) => reject(event.target.error);
        });
    }

    /**
     * 获取与某节点相关的所有边（出边 + 入边）
     */
    async getGraphEdgesByNode(nodeId: string): Promise<GraphEdge[]> {
        const [outEdges, inEdges] = await Promise.all([
            this.getGraphEdgesBySource(nodeId),
            this.getGraphEdgesByTarget(nodeId)
        ]);
        return [...outEdges, ...inEdges];
    }

    /**
     * 根据 personaId 获取所有边
     */
    async getGraphEdgesByPersona(personaId: string): Promise<GraphEdge[]> {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction([this.graphEdgesStoreName], "readonly");
            const store = transaction.objectStore(this.graphEdgesStoreName);
            const index = store.index("personaId");
            const request = index.getAll(IDBKeyRange.only(personaId));

            request.onsuccess = () => resolve(request.result);
            request.onerror = (event: any) => reject(event.target.error);
        });
    }

    /**
     * 删除节点（同时删除相关的所有边）
     */
    async deleteGraphNode(id: string): Promise<void> {
        if (!this.db) await this.init();
        
        // 先删除所有相关的边
        const edges = await this.getGraphEdgesByNode(id);
        const edgeIds = edges.map(e => e.id);
        
        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction(
                [this.graphNodesStoreName, this.graphEdgesStoreName], 
                "readwrite"
            );
            
            const nodeStore = transaction.objectStore(this.graphNodesStoreName);
            const edgeStore = transaction.objectStore(this.graphEdgesStoreName);
            
            nodeStore.delete(id);
            edgeIds.forEach(edgeId => edgeStore.delete(edgeId));

            transaction.oncomplete = () => resolve();
            transaction.onerror = (event: any) => reject(event.target.error);
        });
    }

    /**
     * 删除边
     */
    async deleteGraphEdge(id: string): Promise<void> {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction([this.graphEdgesStoreName], "readwrite");
            const store = transaction.objectStore(this.graphEdgesStoreName);
            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = (event: any) => reject(event.target.error);
        });
    }

    /**
     * 清空某个角色的所有图谱数据
     */
    async clearGraphByPersona(personaId: string): Promise<void> {
        if (!this.db) await this.init();
        
        const [nodes, edges] = await Promise.all([
            this.getGraphNodesByPersona(personaId),
            this.getGraphEdgesByPersona(personaId)
        ]);

        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction(
                [this.graphNodesStoreName, this.graphEdgesStoreName], 
                "readwrite"
            );
            
            const nodeStore = transaction.objectStore(this.graphNodesStoreName);
            const edgeStore = transaction.objectStore(this.graphEdgesStoreName);
            
            nodes.forEach(node => nodeStore.delete(node.id));
            edges.forEach(edge => edgeStore.delete(edge.id));

            transaction.oncomplete = () => resolve();
            transaction.onerror = (event: any) => reject(event.target.error);
        });
    }
}
