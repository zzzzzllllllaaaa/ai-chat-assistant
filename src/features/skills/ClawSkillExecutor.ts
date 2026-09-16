/**
 * Claw Skills 执行引擎
 * 负责执行 Claw 格式技能的 scripts、hooks、references 等
 */

import { App } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '../../core/logger';
import { LogCategory } from '../../core/logger';

const execAsync = promisify(exec);

/**
 * 脚本执行结果
 */
export interface ScriptResult {
	success: boolean;
	output: string;
	error?: string;
	exitCode?: number;
}

/**
 * Hook 事件类型
 */
export type HookEventType = 
	| 'agent:bootstrap'
	| 'agent:start'
	| 'agent:end'
	| 'user:prompt:submit'
	| 'tool:pre:execute'
	| 'tool:post:execute'
	| 'skill:activate'
	| 'skill:deactivate';

/**
 * Hook 事件对象
 */
export interface HookEvent {
	type: string;
	action: string;
	sessionKey?: string;
	context?: any;
	data?: any;
}

/**
 * Hook 处理器
 */
export type HookHandler = (event: HookEvent) => Promise<void> | void;

/**
 * 引用文档
 */
export interface ReferenceDoc {
	path: string;
	content: string;
	title?: string;
}

/**
 * Claw Skills 执行引擎
 */
export class ClawSkillExecutor {
	private app: App;
	private skillPath: string;
	private hooks: Map<HookEventType, HookHandler[]> = new Map();

	constructor(app: App, skillPath: string) {
		this.app = app;
		this.skillPath = skillPath;
	}

	/**
	 * 执行脚本文件
	 */
	async executeScript(scriptName: string, args: string[] = []): Promise<ScriptResult> {
		const scriptsDir = path.join(this.skillPath, 'scripts');
		const scriptPath = path.join(scriptsDir, scriptName);

		// 检查脚本是否存在
		if (!fs.existsSync(scriptPath)) {
			logger.warn('OpenClaw' as LogCategory, `Script not found: ${scriptPath}`);
			return {
				success: false,
				output: '',
				error: `Script not found: ${scriptName}`
			};
		}

		try {
			// 检查脚本类型
			const ext = path.extname(scriptName);
			let command: string;

			if (ext === '.sh') {
				// Bash 脚本 - Windows 环境下跳过
				if (process.platform === 'win32') {
					logger.warn('OpenClaw' as LogCategory, `Bash scripts not supported on Windows: ${scriptName}`);
					return {
						success: false,
						output: '',
						error: 'Bash scripts are not supported on Windows. Please use .js, .ts, or .py scripts.'
					};
				}
				command = `bash "${scriptPath}" ${args.join(' ')}`;
			} else if (ext === '.js') {
				// JavaScript 脚本
				command = `node "${scriptPath}" ${args.join(' ')}`;
			} else if (ext === '.ts') {
				// TypeScript 脚本 (需要 tsx)
				command = `npx tsx "${scriptPath}" ${args.join(' ')}`;
			} else if (ext === '.py') {
				// Python 脚本
				command = `python "${scriptPath}" ${args.join(' ')}`;
			} else {
				return {
					success: false,
					output: '',
					error: `Unsupported script type: ${ext}`
				};
			}

			logger.info('OpenClaw' as LogCategory, `Executing script: ${command}`);

			// 执行脚本
			const { stdout, stderr } = await execAsync(command, {
				cwd: this.skillPath,
				timeout: 30000, // 30 秒超时
				maxBuffer: 1024 * 1024 // 1MB 输出限制
			});

			return {
				success: true,
				output: stdout,
				error: stderr || undefined,
				exitCode: 0
			};

		} catch (error: any) {
			logger.error('OpenClaw' as LogCategory, 'Script execution failed:', error);
			return {
				success: false,
				output: error.stdout || '',
				error: error.stderr || error.message,
				exitCode: error.code
			};
		}
	}

	/**
	 * 加载并注册 Hook
	 */
	async loadHooks(): Promise<void> {
		const hooksDir = path.join(this.skillPath, 'hooks', 'openclaw');
		
		// 检查 hooks 目录是否存在
		if (!fs.existsSync(hooksDir)) {
			logger.debug('OpenClaw' as LogCategory, 'No hooks directory found');
			return;
		}

		try {
			// 查找 handler.ts 或 handler.js
			const handlerTs = path.join(hooksDir, 'handler.ts');
			const handlerJs = path.join(hooksDir, 'handler.js');
			
			let handlerPath: string | null = null;
			if (fs.existsSync(handlerTs)) {
				handlerPath = handlerTs;
			} else if (fs.existsSync(handlerJs)) {
				handlerPath = handlerJs;
			}

			if (!handlerPath) {
				logger.debug('OpenClaw' as LogCategory, 'No hook handler found');
				return;
			}

			// 读取 HOOK.md 获取元数据
			const hookMdPath = path.join(hooksDir, 'HOOK.md');
			let events: HookEventType[] = ['agent:bootstrap']; // 默认事件

			if (fs.existsSync(hookMdPath)) {
				const hookMdContent = fs.readFileSync(hookMdPath, 'utf-8');
				const eventsMatch = hookMdContent.match(/events":\s*\[(.*?)\]/);
				if (eventsMatch) {
					const eventsStr = eventsMatch[1];
					events = eventsStr.split(',').map(e => 
						e.trim().replace(/['"]/g, '') as HookEventType
					);
				}
			}

			// 动态加载 handler
			// 注意: 在 Obsidian 插件中,需要使用 require 或编译后的代码
			// 这里简化处理,实际需要根据环境调整
			logger.info('OpenClaw' as LogCategory, `Loading hook handler: ${handlerPath}`);
			
			// 读取 handler 代码 (简化版,实际需要编译 TypeScript)
			const handlerCode = fs.readFileSync(handlerPath, 'utf-8');
			
			// 注册到对应的事件
			for (const event of events) {
				if (!this.hooks.has(event)) {
					this.hooks.set(event, []);
				}
				
				// 创建一个简单的 handler 包装器
				const handler: HookHandler = async (hookEvent: HookEvent) => {
					logger.info('OpenClaw' as LogCategory, `Hook triggered: ${event}`);
					// 实际执行需要动态加载模块
					// 这里先记录日志
				};
				
				this.hooks.get(event)!.push(handler);
			}

			logger.info('OpenClaw' as LogCategory, `Hooks loaded: ${events.join(', ')}`);

		} catch (error) {
			logger.error('OpenClaw' as LogCategory, 'Failed to load hooks:', error);
		}
	}

	/**
	 * 触发 Hook 事件
	 */
	async triggerHook(eventType: HookEventType, event: HookEvent): Promise<void> {
		const handlers = this.hooks.get(eventType);
		if (!handlers || handlers.length === 0) {
			return;
		}

		logger.info('OpenClaw' as LogCategory, `Triggering hook: ${eventType}`);

		for (const handler of handlers) {
			try {
				await handler(event);
			} catch (error) {
				logger.error('OpenClaw' as LogCategory, 'Hook handler failed:', error);
			}
		}
	}

	/**
	 * 加载引用文档
	 */
	async loadReferences(): Promise<ReferenceDoc[]> {
		const referencesDir = path.join(this.skillPath, 'references');
		
		// 检查 references 目录是否存在
		if (!fs.existsSync(referencesDir)) {
			logger.debug('OpenClaw' as LogCategory, 'No references directory found');
			return [];
		}

		const references: ReferenceDoc[] = [];

		try {
			const files = fs.readdirSync(referencesDir);
			
			for (const file of files) {
				if (!file.endsWith('.md')) {
					continue;
				}

				const filePath = path.join(referencesDir, file);
				const content = fs.readFileSync(filePath, 'utf-8');
				
				// 提取标题 (第一个 # 标题)
				const titleMatch = content.match(/^#\s+(.+)$/m);
				const title = titleMatch ? titleMatch[1] : file.replace('.md', '');

				references.push({
					path: file,
					content,
					title
				});
			}

			logger.info('OpenClaw' as LogCategory, `Loaded ${references.length} reference documents`);

		} catch (error) {
			logger.error('OpenClaw' as LogCategory, 'Failed to load references:', error);
		}

		return references;
	}

	/**
	 * 加载资源文件
	 */
	async loadAssets(): Promise<Map<string, string>> {
		const assetsDir = path.join(this.skillPath, 'assets');
		const assets = new Map<string, string>();

		// 检查 assets 目录是否存在
		if (!fs.existsSync(assetsDir)) {
			logger.debug('OpenClaw' as LogCategory, 'No assets directory found');
			return assets;
		}

		try {
			const files = fs.readdirSync(assetsDir);
			
			for (const file of files) {
				const filePath = path.join(assetsDir, file);
				const stat = fs.statSync(filePath);
				
				if (stat.isFile()) {
					const content = fs.readFileSync(filePath, 'utf-8');
					assets.set(file, content);
				}
			}

			logger.info('OpenClaw' as LogCategory, `Loaded ${assets.size} asset files`);

		} catch (error) {
			logger.error('OpenClaw' as LogCategory, 'Failed to load assets:', error);
		}

		return assets;
	}

	/**
	 * 构建增强的系统提示词
	 * 包含 references 和 assets 的内容
	 */
	async buildEnhancedPrompt(basePrompt: string): Promise<string> {
		const parts: string[] = [basePrompt];

		// 加载引用文档
		const references = await this.loadReferences();
		if (references.length > 0) {
			parts.push('\n## Reference Documents\n');
			for (const ref of references) {
				parts.push(`### ${ref.title}\n\n${ref.content}\n`);
			}
		}

		// 加载资源文件 (仅 Markdown)
		const assets = await this.loadAssets();
		const mdAssets = Array.from(assets.entries()).filter(([name]) => name.endsWith('.md'));
		
		if (mdAssets.length > 0) {
			parts.push('\n## Asset Templates\n');
			for (const [name, content] of mdAssets) {
				parts.push(`### ${name}\n\n${content}\n`);
			}
		}

		return parts.join('\n');
	}

	/**
	 * 获取已注册的 Hook 事件类型
	 */
	getRegisteredHooks(): HookEventType[] {
		return Array.from(this.hooks.keys());
	}

	/**
	 * 清理资源
	 */
	dispose(): void {
		this.hooks.clear();
	}
}
