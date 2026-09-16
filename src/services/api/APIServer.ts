/**
 * HTTP API Server for AI Chat Assistant Plugin
 * 
 * 提供 HTTP API 接口供外部调用（WorkBuddy 等）
 * 覆盖：向量搜索、笔记 CRUD、记忆写入、对话访问、内容搜索
 */

import * as http from 'http';
import type { IPluginContext } from "../../core/plugin-context";;
import { logger } from '../../core/logger';
import { TFile } from 'obsidian';

export interface APIServerConfig {
    enabled: boolean;
    port: number;
    host: string;
    allowedOrigins: string[];
}

export class APIServer {
    private server: http.Server | null = null;
    private plugin: IPluginContext;
    private config: APIServerConfig;

    constructor(plugin: IPluginContext, config: APIServerConfig) {
        this.plugin = plugin;
        this.config = config;
    }

    async start() {
        if (this.server) {
            logger.warn("System", "Server already running");
            return;
        }

        this.server = http.createServer(async (req, res) => {
            await this.handleRequest(req, res);
        });

        return new Promise<void>((resolve, reject) => {
            this.server!.listen(this.config.port, this.config.host, () => {
                logger.info("System", `Server running on http://${this.config.host}:${this.config.port}`);
                resolve();
            });

            this.server!.on('error', (error) => {
                logger.error("System", "Server error", error);
                reject(error);
            });
        });
    }

    async stop() {
        if (!this.server) return;

        return new Promise<void>((resolve) => {
            this.server!.close(() => {
                logger.info("System", "Server stopped");
                this.server = null;
                resolve();
            });
        });
    }

    // ── 工具方法 ──────────────────────────────────────────

    private async parseBody(req: http.IncomingMessage): Promise<any> {
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            req.on('data', (chunk: Buffer) => chunks.push(chunk));
            req.on('end', () => {
                try {
                    const raw = Buffer.concat(chunks).toString('utf-8');
                    resolve(raw ? JSON.parse(raw) : {});
                } catch {
                    reject(new Error('Invalid JSON body'));
                }
            });
            req.on('error', reject);
        });
    }

    private sendCorsHeaders(req: http.IncomingMessage, res: http.ServerResponse) {
        const origin = req.headers.origin || '*';
        if (this.config.allowedOrigins.includes('*') || this.config.allowedOrigins.includes(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        }
    }

    private ok(res: http.ServerResponse, data: any) {
        res.writeHead(200);
        res.end(JSON.stringify(data));
    }

    private created(res: http.ServerResponse, data: any) {
        res.writeHead(201);
        res.end(JSON.stringify(data));
    }

    private accepted(res: http.ServerResponse, data: any) {
        res.writeHead(202);
        res.end(JSON.stringify(data));
    }

    private badRequest(res: http.ServerResponse, message: string) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: message }));
    }

    private notFound(res: http.ServerResponse, message: string) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: message }));
    }

    private serverError(res: http.ServerResponse, error: any) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: error.message || 'Internal server error' }));
    }

    // ── 路由处理 ──────────────────────────────────────────

    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
        this.sendCorsHeaders(req, res);

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        res.setHeader('Content-Type', 'application/json; charset=utf-8');

        try {
            const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
            const pathname = url.pathname;
            const method = req.method || 'GET';

            // ── 健康检查 ──
            if (method === 'GET' && pathname === '/api/health') {
                return this.handleHealth(res);
            }

            // ── 向量语义搜索 ──
            if (method === 'GET' && pathname === '/api/search') {
                return await this.handleSearch(url, res);
            }

            // ── 关键词内容搜索 ──
            if (method === 'POST' && pathname === '/api/search/content') {
                return await this.handleContentSearch(req, res);
            }

            // ── 索引统计 ──
            if (method === 'GET' && pathname === '/api/stats') {
                return await this.handleStats(res);
            }

            // ── 索引更新 ──
            if (method === 'POST' && pathname === '/api/index/update') {
                return await this.handleIndexUpdate(res);
            }

            // ── 笔记 CRUD ──
            if (method === 'POST' && pathname === '/api/notes/create') {
                return await this.handleNoteCreate(req, res);
            }
            if (method === 'PUT' && pathname === '/api/notes/update') {
                return await this.handleNoteUpdate(req, res);
            }
            if (method === 'GET' && pathname === '/api/notes/read') {
                return await this.handleNoteRead(url, res);
            }
            if (method === 'DELETE' && pathname === '/api/notes/delete') {
                return await this.handleNoteDelete(req, res);
            }
            if (method === 'POST' && pathname === '/api/notes/move') {
                return await this.handleNoteMove(req, res);
            }

            // ── AI 记忆存取 ──
            if (method === 'POST' && pathname === '/api/memory/write') {
                return await this.handleMemoryWrite(req, res);
            }
            if (method === 'GET' && pathname === '/api/memory/search') {
                return await this.handleMemorySearch(url, res);
            }

            // ── 对话记录 ──
            if (method === 'GET' && pathname === '/api/conversations/list') {
                return this.handleConversationList(res);
            }
            if (method === 'GET' && pathname === '/api/conversations/read') {
                return this.handleConversationRead(url, res);
            }

            // ── 调试：查看原始向量索引数据 ──
            if (method === 'GET' && pathname === '/api/debug/vector') {
                return await this.handleDebugVector(url, res);
            }

            // 404
            this.notFound(res, `Unknown endpoint: ${method} ${pathname}`);

        } catch (error: any) {
            logger.error("System", "Request handler error", error);
            this.serverError(res, error);
        }
    }

    // ── 现有端点 ──────────────────────────────────────────

    private handleHealth(res: http.ServerResponse) {
        this.ok(res, {
            status: 'ok',
            version: this.plugin.manifest.version,
            timestamp: Date.now(),
            endpoints: {
                vectorSearch: 'GET /api/search?q=query&k=5&content=true&folder=可选文件夹',
                contentSearch: 'POST /api/search/content',
                stats: 'GET /api/stats',
                indexUpdate: 'POST /api/index/update',
                notesCreate: 'POST /api/notes/create',
                notesUpdate: 'PUT /api/notes/update',
                notesRead: 'GET /api/notes/read?path=xxx',
                notesDelete: 'DELETE /api/notes/delete',
                notesMove: 'POST /api/notes/move',
                memoryWrite: 'POST /api/memory/write',
                memorySearch: 'GET /api/memory/search?q=xxx&k=5',
                conversationsList: 'GET /api/conversations/list',
                conversationsRead: 'GET /api/conversations/read?id=xxx',
            }
        });
    }

    private async handleSearch(url: URL, res: http.ServerResponse) {
        const query = url.searchParams.get('q');
        const k = parseInt(url.searchParams.get('k') || '5');
        const showContent = url.searchParams.get('content') === 'true';
        const folder = url.searchParams.get('folder') || undefined;
        const frontmatterRaw = url.searchParams.get('frontmatter');
        let frontmatterFilter: Record<string, string> | undefined;
        if (frontmatterRaw) {
            try {
                frontmatterFilter = JSON.parse(frontmatterRaw);
            } catch {
                return this.badRequest(res, 'Invalid frontmatter JSON');
            }
        }

        if (!query) {
            return this.badRequest(res, 'Missing query parameter "q"');
        }
        if (k < 1 || k > 100) {
            return this.badRequest(res, 'Parameter "k" must be between 1 and 100');
        }

        try {
            // 走完整 RAG 管线：语义搜索 + 关键词BM25 + RRF融合 + 时间衰减
            const searchResults = await this.plugin.ragService.search(query, k * 2, undefined, folder, frontmatterFilter); // 多取一些给切片去重用
            
            // 取前 k 个结果，去重（按 path）
            const seen = new Set<string>();
            const results: Array<{
                path: string;
                similarity: number;
                startOffset?: number;
                endOffset?: number;
                links?: string[];
                frontmatter?: Record<string, any>;
            }> = [];
            
            for (const r of searchResults) {
                const key = `${r.path}-${r.startOffset || 0}`;
                if (seen.has(key)) continue;
                seen.add(key);
                results.push({
                    path: r.path,
                    similarity: r.similarity,
                    startOffset: r.startOffset,
                    endOffset: r.endOffset,
                    links: r.links,
                    frontmatter: r.frontmatter,
                });
                if (results.length >= k) break;
            }

            const enrichedResults = await Promise.all(results.map(async (result) => {
                let content = undefined;

                if (showContent) {
                    const file = this.plugin.app.vault.getAbstractFileByPath(result.path);
                    if (file && file instanceof TFile) {
                        const fullContent = await this.plugin.app.vault.cachedRead(file);
                        if (result.startOffset !== undefined && result.endOffset !== undefined) {
                            content = fullContent.slice(result.startOffset, result.endOffset);
                        } else {
                            content = fullContent;
                        }
                    }
                }

                return {
                    path: result.path,
                    similarity: result.similarity,
                    startOffset: result.startOffset,
                    endOffset: result.endOffset,
                    links: result.links,
                    frontmatter: result.frontmatter,
                    content
                };
            }));

            this.ok(res, {
                query,
                results: enrichedResults,
                count: enrichedResults.length
            });

        } catch (error: any) {
            logger.error("System", "Vector search error", error);
            this.serverError(res, new Error(error.message || 'Search failed'));
        }
    }

    private async handleStats(res: http.ServerResponse) {
        try {
            const vectorCount = this.plugin.vectorIndexManager.vectorIndex.length;
            const files = this.plugin.app.vault.getMarkdownFiles();
            const totalFiles = files.length;

            this.ok(res, {
                vectorCount,
                totalFiles,
                indexedRatio: totalFiles > 0 ? (vectorCount / totalFiles).toFixed(2) : '0',
                isIndexing: (this.plugin.vectorIndexManager as any).isIndexing || false
            });

        } catch (error: any) {
            logger.error("System", "Stats error", error);
            this.serverError(res, error);
        }
    }

    private async handleIndexUpdate(res: http.ServerResponse) {
        try {
            this.plugin.vectorIndexManager.indexVault().catch(error => {
                logger.error("System", "Index update failed", error);
            });

            this.accepted(res, {
                message: 'Index update started',
                status: 'processing'
            });

        } catch (error: any) {
            logger.error("System", "Index update trigger error", error);
            this.serverError(res, error);
        }
    }

    // ── 调试：查看原始向量索引数据 ──────────────────────────
    private async handleDebugVector(url: URL, res: http.ServerResponse) {
        const path = url.searchParams.get('path');
        const all = this.plugin.vectorIndexManager.vectorIndex;
        if (path) {
            const items = all.filter(v => v.path === path);
            this.ok(res, { path, count: items.length, items: items.map(v => ({
                path: v.path,
                mtime: v.mtime,
                startOffset: v.startOffset,
                endOffset: v.endOffset,
                links: v.links,
                hasFrontmatter: v.frontmatter !== undefined && v.frontmatter !== null,
                frontmatterKeys: v.frontmatter ? Object.keys(v.frontmatter) : null,
                frontmatter: v.frontmatter
            }))});
        } else {
            this.ok(res, { total: all.length, sample: all.slice(0, 10).map(v => ({
                path: v.path,
                hasFrontmatter: v.frontmatter !== undefined && v.frontmatter !== null,
                frontmatterKeys: v.frontmatter ? Object.keys(v.frontmatter) : null,
            }))});
        }
    }

    // ── 新增：关键词内容搜索 ──────────────────────────────

    private async handleContentSearch(req: http.IncomingMessage, res: http.ServerResponse) {
        try {
            const body = await this.parseBody(req);
            const query = String(body.query || '').trim();
            const folder = String(body.folder || '').trim();
            const maxResults = parseInt(String(body.maxResults || '20'));

            if (!query) {
                return this.badRequest(res, 'Missing required field "query"');
            }

            const allFiles = this.plugin.app.vault.getMarkdownFiles();
            const results: Array<{
                path: string;
                score: number;
                snippet: string;
            }> = [];

            const qLower = query.toLowerCase();
            for (const file of allFiles) {
                if (folder && !file.path.startsWith(folder)) continue;

                try {
                    const content = await this.plugin.app.vault.cachedRead(file);
                    const contentLower = content.toLowerCase();
                    
                    // 简单匹配打分：出现次数 + 标题匹配加分
                    let score = 0;
                    const idx = contentLower.indexOf(qLower);
                    if (idx !== -1) {
                        // 出现次数
                        const matches = contentLower.split(qLower).length - 1;
                        score += matches;
                        // 文件名匹配加分
                        if (file.name.toLowerCase().includes(qLower)) {
                            score += 5;
                        }
                        // 前 200 字符匹配加分（标题区域）
                        if (idx < 200) {
                            score += 3;
                        }

                        // 摘录上下文
                        const snippetStart = Math.max(0, idx - 60);
                        const snippetEnd = Math.min(content.length, idx + qLower.length + 120);
                        const snippet = (snippetStart > 0 ? '…' : '') + content.slice(snippetStart, snippetEnd) + (snippetEnd < content.length ? '…' : '');

                        results.push({ path: file.path, score, snippet });
                    }
                } catch {
                    // 跳过读取失败的文件
                }
            }

            results.sort((a, b) => b.score - a.score);
            const topResults = results.slice(0, Math.min(maxResults, 200));

            this.ok(res, {
                query,
                results: topResults,
                count: topResults.length
            });

        } catch (error: any) {
            logger.error("System", "Content search error", error);
            this.serverError(res, error);
        }
    }

    // ── 新增：笔记 CRUD ────────────────────────────────────

    private async ensureParentFolders(filePath: string): Promise<void> {
        const parts = filePath.split('/');
        if (parts.length <= 1) return;

        let current = '';
        for (let i = 0; i < parts.length - 1; i++) {
            current += (current ? '/' : '') + parts[i];
            const existing = this.plugin.app.vault.getAbstractFileByPath(current);
            if (!existing) {
                await this.plugin.app.vault.createFolder(current);
            }
        }
    }

    private async handleNoteCreate(req: http.IncomingMessage, res: http.ServerResponse) {
        try {
            const body = await this.parseBody(req);
            const filePath = String(body.path || '').trim();
            const content = String(body.content || '');

            if (!filePath) {
                return this.badRequest(res, 'Missing required field "path"');
            }

            // 确保 .md 后缀
            const finalPath = filePath.endsWith('.md') ? filePath : `${filePath}.md`;

            // 检查是否已存在
            const existing = this.plugin.app.vault.getAbstractFileByPath(finalPath);
            if (existing) {
                return this.badRequest(res, `Note already exists: ${finalPath}`);
            }

            // 创建父文件夹
            await this.ensureParentFolders(finalPath);

            // 创建文件
            const file = await this.plugin.app.vault.create(finalPath, content);

            logger.info("System", `Note created: ${finalPath}`);

            this.created(res, {
                path: file.path,
                name: file.name,
                message: 'Note created successfully'
            });

        } catch (error: any) {
            logger.error("System", "Note create error", error);
            this.serverError(res, error);
        }
    }

    private async handleNoteUpdate(req: http.IncomingMessage, res: http.ServerResponse) {
        try {
            const body = await this.parseBody(req);
            const filePath = String(body.path || '').trim();
            const content = String(body.content ?? null);
            const mode = String(body.mode || 'overwrite').trim();

            if (!filePath) {
                return this.badRequest(res, 'Missing required field "path"');
            }

            const finalPath = filePath.endsWith('.md') ? filePath : `${filePath}.md`;

            const file = this.plugin.app.vault.getAbstractFileByPath(finalPath);
            if (!file || !(file instanceof TFile)) {
                return this.notFound(res, `Note not found: ${finalPath}`);
            }

            if (mode === 'append' && content !== null) {
                await this.plugin.app.vault.append(file, content);
            } else if (content !== null) {
                await this.plugin.app.vault.modify(file, content);
            } else {
                return this.badRequest(res, 'Missing "content" field');
            }

            logger.info("System", `Note updated (${mode}): ${finalPath}`);

            this.ok(res, {
                path: file.path,
                name: file.name,
                mode,
                message: 'Note updated successfully'
            });

        } catch (error: any) {
            logger.error("System", "Note update error", error);
            this.serverError(res, error);
        }
    }

    private async handleNoteRead(url: URL, res: http.ServerResponse) {
        try {
            const filePath = url.searchParams.get('path');
            if (!filePath) {
                return this.badRequest(res, 'Missing query parameter "path"');
            }

            const finalPath = filePath.endsWith('.md') ? filePath : `${filePath}.md`;

            const file = this.plugin.app.vault.getAbstractFileByPath(finalPath);
            if (!file || !(file instanceof TFile)) {
                return this.notFound(res, `Note not found: ${finalPath}`);
            }

            const content = await this.plugin.app.vault.cachedRead(file);

            this.ok(res, {
                path: file.path,
                name: file.name,
                stat: file.stat,
                content
            });

        } catch (error: any) {
            logger.error("System", "Note read error", error);
            this.serverError(res, error);
        }
    }

    private async handleNoteDelete(req: http.IncomingMessage, res: http.ServerResponse) {
        try {
            const body = await this.parseBody(req);
            const filePath = String(body.path || '').trim();

            if (!filePath) {
                return this.badRequest(res, 'Missing required field "path"');
            }

            const finalPath = filePath.endsWith('.md') ? filePath : `${filePath}.md`;

            const file = this.plugin.app.vault.getAbstractFileByPath(finalPath);
            if (!file) {
                return this.notFound(res, `Note not found: ${finalPath}`);
            }

            await this.plugin.app.vault.delete(file);

            logger.info("System", `Note deleted: ${finalPath}`);

            this.ok(res, {
                path: finalPath,
                message: 'Note deleted successfully'
            });

        } catch (error: any) {
            logger.error("System", "Note delete error", error);
            this.serverError(res, error);
        }
    }

    private async handleNoteMove(req: http.IncomingMessage, res: http.ServerResponse) {
        try {
            const body = await this.parseBody(req);
            const from = String(body.from || '').trim();
            const to = String(body.to || '').trim();

            if (!from || !to) {
                return this.badRequest(res, 'Missing required fields "from" and "to"');
            }

            const fromPath = from.endsWith('.md') ? from : `${from}.md`;
            const toPath = to.endsWith('.md') ? to : `${to}.md`;

            const file = this.plugin.app.vault.getAbstractFileByPath(fromPath);
            if (!file) {
                return this.notFound(res, `Source note not found: ${fromPath}`);
            }

            // 确保目标文件夹存在
            await this.ensureParentFolders(toPath);

            await this.plugin.app.vault.rename(file, toPath);

            logger.info("System", `Note moved: ${fromPath} → ${toPath}`);

            this.ok(res, {
                from: fromPath,
                to: toPath,
                message: 'Note moved successfully'
            });

        } catch (error: any) {
            logger.error("System", "Note move error", error);
            this.serverError(res, error);
        }
    }

    // ── 新增：AI 记忆存取 ──────────────────────────────────

    private async handleMemoryWrite(req: http.IncomingMessage, res: http.ServerResponse) {
        try {
            const body = await this.parseBody(req);

            const personaId = String(body.personaId || 'default').trim();
            const topic = String(body.topic || '日常').trim();
            const tags: string[] = Array.isArray(body.tags) ? body.tags.map((t: any) => String(t).trim()).filter(Boolean) : [];
            const summary = String(body.summary || '').trim();
            const projectKey = String(body.projectKey || '').trim() || undefined;
            const source = String(body.source || 'WorkBuddy写入').trim();

            if (!summary) {
                return this.badRequest(res, 'Missing required field "summary"');
            }

            if (!this.plugin.memoryManager || typeof this.plugin.memoryManager.writeEpisodicMemory !== 'function') {
                return this.serverError(res, new Error('Memory manager or writeEpisodicMemory not available. Make sure the MemoryManager is loaded with the latest code.'));
            }

            const result = await this.plugin.memoryManager.writeEpisodicMemory(
                personaId, topic, tags, summary, projectKey, source
            );

            logger.info("System", `Memory written: ${result.path}`);

            this.created(res, {
                path: result.path,
                topic,
                tags,
                personaId,
                message: 'Memory written successfully'
            });

        } catch (error: any) {
            logger.error("System", "Memory write error", error);
            this.serverError(res, error);
        }
    }

    private async handleMemorySearch(url: URL, res: http.ServerResponse) {
        try {
            const query = url.searchParams.get('q');
            const k = parseInt(url.searchParams.get('k') || '5');

            if (!query) {
                return this.badRequest(res, 'Missing query parameter "q"');
            }

            // 在向量索引中搜索，并用 AI_Memory 路径过滤
            const queryVector = await this.plugin.llmService.getEmbedding(query);
            const allResults = await this.plugin.vectorIndexManager.search(queryVector, k * 3);

            // 过滤：只保留 AI_Memory 目录下的记忆
            const memoryResults = allResults
                .filter(r => r.path.includes('AI_Memory') || r.path.includes('AI_Memory'))
                .slice(0, k);

            this.ok(res, {
                query,
                results: memoryResults.map(r => ({
                    path: r.path,
                    similarity: r.similarity,
                    startOffset: r.startOffset,
                    endOffset: r.endOffset,
                })),
                count: memoryResults.length
            });

        } catch (error: any) {
            logger.error("System", "Memory search error", error);
            this.serverError(res, error);
        }
    }

    // ── 新增：对话记录 ─────────────────────────────────────

    private handleConversationList(res: http.ServerResponse) {
        try {
            const conversations = this.plugin.getConversations();
            const list = Object.entries(conversations).map(([id, conv]) => ({
                id,
                title: conv.title || '未命名对话',
                previewText: conv.previewText || '',
                messageCount: Array.isArray(conv.history) ? conv.history.length : 0,
                createdAt: (conv as any).createdAt || null,
            }));

            this.ok(res, {
                conversations: list,
                count: list.length
            });

        } catch (error: any) {
            logger.error("System", "Conversation list error", error);
            this.serverError(res, error);
        }
    }

    private handleConversationRead(url: URL, res: http.ServerResponse) {
        try {
            const id = url.searchParams.get('id');
            if (!id) {
                return this.badRequest(res, 'Missing query parameter "id"');
            }

            const conversations = this.plugin.getConversations();
            const conv = conversations[id];
            if (!conv) {
                return this.notFound(res, `Conversation not found: ${id}`);
            }

            this.ok(res, {
                id,
                title: conv.title || '未命名对话',
                previewText: conv.previewText || '',
                messages: conv.history || [],
                messageCount: Array.isArray(conv.history) ? conv.history.length : 0,
            });

        } catch (error: any) {
            logger.error("System", "Conversation read error", error);
            this.serverError(res, error);
        }
    }
}
