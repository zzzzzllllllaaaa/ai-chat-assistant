import { App, Notice, TFile } from "obsidian";
import type { IPluginContext } from "../../core/plugin-context";;
import { SEARCH_WORKER_CODE } from "../search/SearchWorker";
import { VectorDB } from "./VectorDB";
import type { VectorRecord } from "./VectorDB";
import { logger } from "../../core/logger";
import { safeNotice } from "../../utils/notice";

export interface NoteVector {
    path: string;
    vector: number[];
    mtime: number;
    startOffset?: number;
    endOffset?: number;
    links?: string[];
    frontmatter?: Record<string, any>;
}

const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 200;

export class VectorIndexManager {
    app: App;
    plugin: IPluginContext;
    vectorIndex: VectorRecord[] = [];
    private isIndexing = false;
    private readonly BATCH_SIZE = 50;
    private worker: Worker | null = null;
    private workerReady = false;
    public db: VectorDB; // 改为 public，供 GraphRAGManager 访问

    constructor(plugin: IPluginContext) {
        this.app = plugin.app;
        this.plugin = plugin;
        this.db = new VectorDB();
        this.initWorker();
    }

    private initWorker() {
        try {
            const blob = new Blob([SEARCH_WORKER_CODE], { type: 'application/javascript' });
            this.worker = new Worker(URL.createObjectURL(blob));
            this.worker.onmessage = (e) => {
                if (e.data.type === 'READY') {
                    this.workerReady = true;
                    logger.info("System", "Search Worker is ready");
                } else if (e.data.type === 'INDEX_UPDATED') {
                    // index refresh/update event; avoid logging as "ready" every time
                    // (kept as debug to reduce noise)
                    logger.debug("System", `Search Worker index updated: size=${e.data.size ?? 'unknown'}`);
                }
            };
        } catch (e) {
            logger.error("System", "Failed to initialize worker", e);
        }
    }

    private updateWorkerIndex() {
        if (this.worker) {
            // Data is already in Float32Array format in VectorRecord
            this.worker.postMessage({ type: 'SET_INDEX', data: this.vectorIndex });
        }
    }

    async loadIndexData() {
        logger.info("Database", "Loading index from IndexedDB...");
        try {
            await this.db.init();
            this.vectorIndex = await this.db.getAllVectors();
            logger.info("Database", `Index loaded successfully. Total items: ${this.vectorIndex.length}`);
            this.updateWorkerIndex();
        } catch (e) {
            logger.error("Database", "Error loading index from IndexedDB", e);
            new Notice("加载向量数据库失败，可能需要重新索引。");
        }
    }

    async saveFullState() {
        // IndexedDB handles persistence incrementally, just update worker
        this.updateWorkerIndex();
    }

    async indexVault() {

        if (this.isIndexing) {
            new Notice("正在索引中，请勿重复操作。");
            return;
        }
        this.isIndexing = true;
        const notice = new Notice("开始更新AI索引 (高性能模式)...", 0);

        try {
            const files = this.app.vault.getMarkdownFiles();
            const excludedFolders = this.plugin.settings.excludedFolders;

            const validFiles = files.filter(file =>
                !excludedFolders.some(folder => file.path.startsWith(folder))
            );

            const validFilePaths = new Set(validFiles.map(f => f.path));

            // 1. Cleanup deleted files from DB
            const existingPaths = new Set(this.vectorIndex.map(item => item.path));
            for (const path of existingPaths) {
                if (!validFilePaths.has(path)) {
                    await this.db.deleteByPath(path);
                }
            }
            
            // Refresh local index after cleanup
            this.vectorIndex = await this.db.getAllVectors();

            const filesToIndex: TFile[] = [];
            const existingIndexedPaths = new Map<string, number>();
            this.vectorIndex.forEach(item => {
                const currentMtime = existingIndexedPaths.get(item.path) || 0;
                if (item.mtime > currentMtime) {
                    existingIndexedPaths.set(item.path, item.mtime);
                }
            });

            for (const file of validFiles) {
                const indexedMtime = existingIndexedPaths.get(file.path);
                // 重索引条件：未索引 / mtime 更新
                const needsReindex = indexedMtime === undefined 
                    || file.stat.mtime > indexedMtime;
                if (needsReindex) {
                    filesToIndex.push(file);
                }
            }

            if (filesToIndex.length === 0) {
                notice.setMessage("所有笔记都已是最新，无需更新索引。");
                setTimeout(() => notice.hide(), 3000);
                this.isIndexing = false;
                this.updateWorkerIndex();
                return;
            }

            notice.setMessage(`准备更新 ${filesToIndex.length} 篇笔记...`);

            const errors: string[] = [];
            let successCount = 0;
            
            for (let i = 0; i < filesToIndex.length; i++) {
                const file = filesToIndex[i];
                notice.setMessage(`正在处理: ${i + 1}/${filesToIndex.length}\n${file.basename}`);

                const result = await this.indexFile(file);
                if (result.success) {
                    successCount++;
                } else if (result.error) {
                    errors.push(result.error);
                    // 如果连续多个文件都是同类错误（如网络问题），提前终止
                    if (errors.length >= 3) {
                        const lastThree = errors.slice(-3);
                        const sameErrorType = lastThree.every(e => e.startsWith(lastThree[0].split('】')[0] + '】'));
                        if (sameErrorType) {
                            notice.setMessage(`索引提前终止：连续出现相同类型错误。\n${lastThree[0]}`);
                            setTimeout(() => notice.hide(), 8000);
                            this.isIndexing = false;
                            return;
                        }
                    }
                }

                if ((i + 1) % this.BATCH_SIZE === 0) {
                    this.updateWorkerIndex();
                }
            }

            this.updateWorkerIndex();
            
            // 显示最终结果
            if (errors.length === 0) {
                notice.setMessage(`AI索引更新完成！\n处理了 ${filesToIndex.length} 篇笔记，当前总索引数 ${this.vectorIndex.length}。`);
                setTimeout(() => notice.hide(), 5000);
            } else {
                const summary = `索引完成，但有 ${errors.length} 个文件失败。\n成功：${successCount}，失败：${errors.length}`;
                notice.setMessage(summary);
                setTimeout(() => notice.hide(), 5000);
                // 显示详细错误（最多显示前3个）
                const detailErrors = errors.slice(0, 3).join('\n\n');
                setTimeout(() => {
                    safeNotice(`索引错误详情（前${Math.min(3, errors.length)}个）：\n\n${detailErrors}`, 15000);
                }, 500);
            }

        } catch (error: any) {
            safeNotice(`索引失败: ${error?.message || String(error)}`);
            logger.error("Database", "Index vault failed", error);
        } finally {
            this.isIndexing = false;
        }
    }

    private chunkText(text: string, size: number, overlap: number): { text: string, start: number, end: number, links: string[] }[] {
        const chunks: { text: string, start: number, end: number, links: string[] }[] = [];
        let start = 0;
        const linkRegex = /\[\[([^\]]+)\]\]/g;

        while (start < text.length) {
            const end = Math.min(start + size, text.length);
            const chunkText = text.slice(start, end);
            
            const links: string[] = [];
            const matches = chunkText.matchAll(linkRegex);
            for (const m of matches) {
                const linkTarget = m[1].split('|')[0];
                links.push(linkTarget);
            }

            chunks.push({
                text: chunkText,
                start,
                end,
                links
            });
            start += size - overlap;
            if (size <= overlap) start++; 
        }
        return chunks;
    }

    public async search(queryVector: number[], k: number): Promise<Array<{ path: string; similarity: number; startOffset?: number; endOffset?: number; links?: string[]; frontmatter?: Record<string, any> }>> {
        if (this.vectorIndex.length === 0) return [];

        if (this.worker && this.workerReady) {
            return new Promise((resolve) => {
                const handler = (e: MessageEvent) => {
                    if (e.data.type === 'SEARCH_RESULTS') {
                        this.worker?.removeEventListener('message', handler);
                        resolve(e.data.data);
                    }
                };
                this.worker?.addEventListener('message', handler);
                this.worker?.postMessage({ type: 'SEARCH', data: { queryVector, k } });
            });
        }

        // Fallback to main thread search
        const qVec = new Float32Array(queryVector);
        const results = this.vectorIndex.map(item => {
            const similarity = this.cosineSimilarity(qVec, item.vector);
            return {
                path: item.path,
                similarity,
                startOffset: item.startOffset,
                endOffset: item.endOffset,
                links: item.links,
                frontmatter: item.frontmatter
            };
        });

        results.sort((a, b) => b.similarity - a.similarity);
        return results.slice(0, k);
    }

    private cosineSimilarity(vecA: Float32Array, vecB: Float32Array): number {
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        if (normA === 0 || normB === 0) return 0;
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    /**
     * 手动解析 Markdown frontmatter（元数据缓存不可用时的回退方案）
     */
    private parseFrontmatter(content: string): Record<string, any> | undefined {
        const trimmed = content.trimStart();
        // Use split to avoid esbuild mangling '---' in string literals
        if (!trimmed.startsWith('-' + '--')) return undefined;
        const rest = trimmed.slice(3);
        // Normalize CRLF → LF for Windows files (also esbuild-proof)
        const CRLF = String.fromCharCode(13, 10);
        const LF = String.fromCharCode(10);
        const normalized = rest.split(CRLF).join(LF);
        // String.fromCharCode(10,45,45,45) = "\n---" — esbuild-proof
        const FM_END = String.fromCharCode(10, 45, 45, 45);
        const endIdx = normalized.indexOf(FM_END);
        if (endIdx === -1) return undefined;
        const yamlBlock = normalized.slice(0, endIdx);
        const result: Record<string, any> = {};
        const lines = yamlBlock.split('\n');
        for (const line of lines) {
            const colonIdx = line.indexOf(':');
            if (colonIdx === -1) continue;
            const key = line.slice(0, colonIdx).trim();
            let value = line.slice(colonIdx + 1).trim();
            // 去掉引号
            if ((value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            // 简单数组解析: [a, b, c]
            if (value.startsWith('[') && value.endsWith(']')) {
                result[key] = value.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
            } else {
                result[key] = value;
            }
        }
        return Object.keys(result).length > 0 ? result : undefined;
    }

    public async clearDatabase() {
        await this.db.clear();
        this.vectorIndex = [];
        this.updateWorkerIndex();
        new Notice("向量数据库已清空。");
    }

    public async indexFile(file: TFile): Promise<{ success: boolean; error?: string }> {
        const content = await this.app.vault.cachedRead(file);
        if (content && content.trim().length > 10) {
            try {
                await this.db.deleteByPath(file.path);

                // 提取 frontmatter（优先元数据缓存，回退手动解析）
                let frontmatter: Record<string, any> | undefined;
                const cache = this.app.metadataCache.getFileCache(file);
                if (cache?.frontmatter) {
                    frontmatter = cache.frontmatter;
                    console.log(`[FM-DEBUG] ${file.path}: cache hit, keys=`, Object.keys(frontmatter));
                } else {
                    frontmatter = this.parseFrontmatter(content);
                    console.log(`[FM-DEBUG] ${file.path}: cache MISS, parseFrontmatter result=`, frontmatter);
                }
                console.log(`[FM-DEBUG] ${file.path}: final frontmatter=`, JSON.stringify(frontmatter));

                const chunks = this.chunkText(content, CHUNK_SIZE, CHUNK_OVERLAP);
                if (chunks.length === 0) {
                    return { success: true };
                }

                // Batch embedding: send all chunk texts in one API call
                const chunkTexts = chunks.map(c => c.text);
                const vectors = await this.plugin.llmService.getBatchEmbedding(chunkTexts);

                const newRecords: VectorRecord[] = chunks.map((chunk, i) => ({
                    path: file.path,
                    vector: new Float32Array(vectors[i]),
                    mtime: file.stat.mtime,
                    startOffset: chunk.start,
                    endOffset: chunk.end,
                    links: chunk.links,
                    frontmatter
                }));

                await this.db.saveVectors(newRecords);

                this.vectorIndex = this.vectorIndex.filter(item => item.path !== file.path);
                this.vectorIndex.push(...newRecords);
                
                return { success: true };

            } catch (error: any) {
                const errorMsg = this.analyzeIndexError(error, file, content);
                logger.error("Database", `为文件 ${file.path} 创建向量失败`, error);
                return { success: false, error: errorMsg };
            }
        }
        return { success: true }; // 空文件直接跳过
    }

    /**
     * 分析索引错误原因，返回用户友好的错误信息
     */
    private analyzeIndexError(error: any, file: TFile, content: string): string {
        const errStr = String(error?.message || error || '').toLowerCase();
        const fileName = file.basename;
        const contentLength = content?.length || 0;
        
        // 网络错误
        if (errStr.includes('fetch') || errStr.includes('network') || errStr.includes('econnrefused') || 
            errStr.includes('enotfound') || errStr.includes('timeout') || errStr.includes('socket')) {
            return `【网络错误】处理 "${fileName}" 时无法连接到嵌入模型服务，请检查网络连接和 API 地址是否正确。`;
        }
        
        // API Key 错误
        if (errStr.includes('401') || errStr.includes('unauthorized') || errStr.includes('invalid api key') ||
            errStr.includes('authentication') || errStr.includes('apikey')) {
            return `【认证失败】处理 "${fileName}" 时 API Key 无效或未设置，请检查嵌入模型的 API Key 配置。`;
        }
        
        // 配额/限流错误
        if (errStr.includes('429') || errStr.includes('rate limit') || errStr.includes('quota') ||
            errStr.includes('too many requests')) {
            return `【请求过多】处理 "${fileName}" 时触发了 API 限流，请稍后重试或降低请求频率。`;
        }
        
        // 模型不存在 / 404
        if (errStr.includes('404') || (errStr.includes('model') && (errStr.includes('not found') || errStr.includes('does not exist')))) {
            // 从增强的错误信息中提取 URL 和模型名
            const urlMatch = String(error?.message || '').match(/url=([^,]+)/);
            const modelMatch = String(error?.message || '').match(/model=([^,]+)/);
            const actualUrl = urlMatch?.[1] || '未知';
            const actualModel = modelMatch?.[1] || this.plugin.settings.embeddingModel;
            return `【404 错误】嵌入请求返回 404。请求地址: ${actualUrl}，模型: ${actualModel}。请检查：1) 嵌入模型名称是否正确；2) 该模型是否绑定到了正确的连接（Connection）；3) 连接的 Base URL 是否包含 /v1 后缀。`;
        }
        
        // 内容过长
        if (errStr.includes('too long') || errStr.includes('maximum context') || errStr.includes('token limit') ||
            errStr.includes('max tokens') || errStr.includes('context length')) {
            return `【内容过长】"${fileName}" 的单个分块超出了嵌入模型的最大长度限制（当前分块大小：${CHUNK_SIZE}），建议减小分块大小或使用支持更长上下文的嵌入模型。`;
        }
        
        // 余额不足
        if (errStr.includes('insufficient') || errStr.includes('balance') || errStr.includes('402') ||
            errStr.includes('payment required')) {
            return `【余额不足】API 账户余额不足，请充值后重试。`;
        }
        
        // 服务端错误
        if (errStr.includes('500') || errStr.includes('502') || errStr.includes('503') || errStr.includes('504') ||
            errStr.includes('internal server') || errStr.includes('service unavailable')) {
            return `【服务异常】嵌入模型服务暂时不可用（可能是服务器过载），请稍后重试。`;
        }
        
        // 未知错误，返回原始信息
        return `【索引失败】处理 "${fileName}" 失败：${error?.message || String(error)}（文件大小：${contentLength} 字符）`;
    }

    async savePrivateMemory(type: 'diary' | 'interest' | 'belief', content: string, metadata?: any, emotionalWeight?: number) {
        const now = Date.now();
        const record: any = {
            id: `mem-${Date.now()}`,
            type,
            content,
            timestamp: now,
            lastAccessAt: now,
            accessCount: 0,
            emotionalWeight: emotionalWeight !== undefined ? emotionalWeight : (type === 'diary' ? 0.8 : 0.5),
            metadata
        };
        await this.db.savePrivateMemory(record);
    }

    async incrementMemoryAccess(id: string) {
        const memories = await this.db.getPrivateMemory();
        const memory = memories.find(m => m.id === id);
        if (memory) {
            memory.accessCount = (memory.accessCount || 0) + 1;
            (memory as any).lastAccessAt = Date.now();
            await this.db.savePrivateMemory(memory);
        }
    }

    async forgetOldMemories(limit: number = 50) {
        const memories = await this.db.getPrivateMemory();
        if (memories.length <= limit) return;

        // 可解释的遗忘模型（类“复习增强 + 时间衰减”）：
        // - ageDays：距离“最后一次被引用/命中”的时间（旧数据回退到 timestamp）
        // - strength：访问次数与情感权重会提升记忆强度（衰减更慢）
        // - retention：指数衰减 exp(-ageDays / strength)
        // - importance：情感权重 + 访问次数带来的重要性加成
        const now = Date.now();
        const DAY_MS = 1000 * 60 * 60 * 24;

        const typeBase: Record<string, number> = {
            diary: 1.2,
            belief: 1.1,
            interest: 1.0,
        };

        const scoredMemories = memories.map(m => {
            const lastAccessAt = Number((m as any).lastAccessAt ?? m.timestamp) || m.timestamp;
            const ageDays = Math.max(0, (now - lastAccessAt) / DAY_MS);

            const accessCount = Math.max(0, Number((m as any).accessCount ?? 0) || 0);
            const emotionalWeight = Math.max(0, Math.min(1, Number((m as any).emotionalWeight ?? 0) || 0));

            // strength >= 1：被引用越多、情感权重越高 → 遗忘越慢
            const strength = 1 + accessCount * 0.6 + emotionalWeight * 3.0;
            const retention = Math.exp(-ageDays / strength);

            // importance：访问次数采用 log，避免高频访问把 score 拉爆
            const importance = (typeBase[String(m.type)] ?? 1.0) * (1 + emotionalWeight * 2.0) * (1 + Math.log1p(accessCount) * 0.8);

            const score = importance * retention;
            return { ...m, score };
        });

        // 按分数排序，删除分数最低的
        scoredMemories.sort((a, b) => a.score - b.score);
        const toDelete = scoredMemories.slice(0, memories.length - limit);

        for (const mem of toDelete) {
            logger.info("Database", `Forgetting memory [${mem.type}] due to low retention score: ${mem.score.toFixed(3)}`);
            // 需要在 VectorDB 中实现 deletePrivateMemory
            await this.db.deletePrivateMemory(mem.id);
        }
    }

    async getPrivateMemory(type?: string) {
        return await this.db.getPrivateMemory(type);
    }
}
