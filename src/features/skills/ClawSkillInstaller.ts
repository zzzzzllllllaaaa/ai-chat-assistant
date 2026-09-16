/**
 * Claw Skills 安装器
 * 负责从不同来源安装 Claw 格式技能
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../core/logger';
import { LogCategory } from '../../core/logger';

// 简化的 HTTP 请求函数 (用于测试环境)
async function simpleHttpGet(url: string): Promise<{ status: number; text: string }> {
	const https = await import('https');
	const http = await import('http');
	
	return new Promise((resolve, reject) => {
		const client = url.startsWith('https') ? https : http;
		
		client.get(url, (res) => {
			let data = '';
			res.on('data', (chunk) => data += chunk);
			res.on('end', () => {
				resolve({
					status: res.statusCode || 500,
					text: data
				});
			});
		}).on('error', reject);
	});
}

/**
 * 技能来源类型
 */
export type SkillSource = 
	| 'github'      // GitHub 仓库
	| 'url'         // 直接 URL
	| 'local'       // 本地文件夹
	| 'clawdhub';   // ClawdHub (未来支持)

/**
 * 安装选项
 */
export interface InstallOptions {
	/** 来源类型 */
	source: SkillSource;
	/** 来源地址 (GitHub URL, 文件 URL, 本地路径等) */
	sourceUrl: string;
	/** 目标文件夹名称 (可选,默认从来源推断) */
	targetName?: string;
	/** 是否覆盖已存在的技能 */
	overwrite?: boolean;
}

/**
 * 安装结果
 */
export interface InstallResult {
	success: boolean;
	skillName?: string;
	skillPath?: string;
	error?: string;
}

/**
 * Claw Skills 安装器
 */
export class ClawSkillInstaller {
	private skillsDir: string;

	constructor(skillsDir: string = 'Skills') {
		this.skillsDir = skillsDir;
	}

	/**
	 * 安装技能
	 */
	async install(options: InstallOptions): Promise<InstallResult> {
		logger.info('Skills' as LogCategory, 'Installing skill', { source: options.source, url: options.sourceUrl });

		try {
			switch (options.source) {
				case 'github':
					return await this.installFromGitHub(options);
				case 'url':
					return await this.installFromUrl(options);
				case 'local':
					return await this.installFromLocal(options);
				case 'clawdhub':
					return {
						success: false,
						error: 'ClawdHub integration not yet implemented'
					};
				default:
					return {
						success: false,
						error: `Unsupported source type: ${options.source}`
					};
			}
		} catch (error: any) {
			logger.error('Skills' as LogCategory, 'Installation failed', error);
			return {
				success: false,
				error: error.message
			};
		}
	}

	/**
	 * 从 GitHub 安装技能
	 */
	private async installFromGitHub(options: InstallOptions): Promise<InstallResult> {
		// 解析 GitHub URL
		// 支持格式: https://github.com/user/repo 或 user/repo
		let repoUrl = options.sourceUrl;
		if (!repoUrl.startsWith('http')) {
			repoUrl = `https://github.com/${repoUrl}`;
		}

		// 提取仓库信息
		const match = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
		if (!match) {
			return {
				success: false,
				error: 'Invalid GitHub URL format'
			};
		}

		const [, owner, repo] = match;
		const repoName = repo.replace(/\.git$/, '');

		// 确定目标文件夹名称
		const targetName = options.targetName || repoName;
		const targetPath = path.join(this.skillsDir, targetName);

		// 检查是否已存在
		if (fs.existsSync(targetPath) && !options.overwrite) {
			return {
				success: false,
				error: `Skill already exists: ${targetName}. Use overwrite option to replace.`
			};
		}

		// 下载 ZIP 文件
		const zipUrl = `https://github.com/${owner}/${repoName}/archive/refs/heads/main.zip`;
		
		logger.info('Skills' as LogCategory, 'Downloading from GitHub', { zipUrl });

		try {
			const response = await simpleHttpGet(zipUrl);

			if (response.status !== 200) {
				return {
					success: false,
					error: `Failed to download: HTTP ${response.status}`
				};
			}

			// 保存并解压 (简化版,实际需要 ZIP 解压库)
			// 这里先返回成功,实际实现需要解压逻辑
			logger.warn('Skills' as LogCategory, 'ZIP extraction not yet implemented');

			return {
				success: false,
				error: 'GitHub installation requires ZIP extraction (not yet implemented). Please use local installation instead.'
			};

		} catch (error: any) {
			return {
				success: false,
				error: `Download failed: ${error.message}`
			};
		}
	}

	/**
	 * 从 URL 安装技能
	 */
	private async installFromUrl(options: InstallOptions): Promise<InstallResult> {
		// 下载单个 SKILL.md 文件
		try {
			const response = await simpleHttpGet(options.sourceUrl);

			if (response.status !== 200) {
				return {
					success: false,
					error: `Failed to download: HTTP ${response.status}`
				};
			}

			// 提取文件名
			const urlPath = new URL(options.sourceUrl).pathname;
			const fileName = path.basename(urlPath);
			
			if (!fileName.endsWith('.md')) {
				return {
					success: false,
					error: 'URL must point to a .md file'
				};
			}

			// 确定目标文件夹名称
			const targetName = options.targetName || fileName.replace('.md', '');
			const targetPath = path.join(this.skillsDir, targetName);

			// 检查是否已存在
			if (fs.existsSync(targetPath) && !options.overwrite) {
				return {
					success: false,
					error: `Skill already exists: ${targetName}`
				};
			}

			// 创建目标文件夹
			if (!fs.existsSync(targetPath)) {
				fs.mkdirSync(targetPath, { recursive: true });
			}

			// 保存 SKILL.md
			const skillMdPath = path.join(targetPath, 'SKILL.md');
			fs.writeFileSync(skillMdPath, response.text, 'utf-8');

			logger.info('Skills' as LogCategory, 'Skill installed from URL', { targetPath });

			return {
				success: true,
				skillName: targetName,
				skillPath: targetPath
			};

		} catch (error: any) {
			return {
				success: false,
				error: `Download failed: ${error.message}`
			};
		}
	}

	/**
	 * 从本地文件夹安装技能
	 */
	private async installFromLocal(options: InstallOptions): Promise<InstallResult> {
		const sourcePath = options.sourceUrl;

		// 检查源路径是否存在
		if (!fs.existsSync(sourcePath)) {
			return {
				success: false,
				error: `Source path not found: ${sourcePath}`
			};
		}

		// 检查是否包含 SKILL.md
		const skillMdPath = path.join(sourcePath, 'SKILL.md');
		if (!fs.existsSync(skillMdPath)) {
			return {
				success: false,
				error: 'Source folder must contain SKILL.md'
			};
		}

		// 确定目标文件夹名称
		const targetName = options.targetName || path.basename(sourcePath);
		const targetPath = path.join(this.skillsDir, targetName);

		// 检查是否已存在
		if (fs.existsSync(targetPath) && !options.overwrite) {
			return {
				success: false,
				error: `Skill already exists: ${targetName}`
			};
		}

		// 复制文件夹
		try {
			this.copyFolderRecursive(sourcePath, targetPath);

			logger.info('Skills' as LogCategory, 'Skill installed from local', { targetPath });

			return {
				success: true,
				skillName: targetName,
				skillPath: targetPath
			};

		} catch (error: any) {
			return {
				success: false,
				error: `Copy failed: ${error.message}`
			};
		}
	}

	/**
	 * 递归复制文件夹
	 */
	private copyFolderRecursive(source: string, target: string): void {
		// 创建目标文件夹
		if (!fs.existsSync(target)) {
			fs.mkdirSync(target, { recursive: true });
		}

		// 读取源文件夹内容
		const files = fs.readdirSync(source);

		for (const file of files) {
			const sourcePath = path.join(source, file);
			const targetPath = path.join(target, file);
			const stat = fs.statSync(sourcePath);

			if (stat.isDirectory()) {
				// 递归复制子文件夹
				this.copyFolderRecursive(sourcePath, targetPath);
			} else {
				// 复制文件
				fs.copyFileSync(sourcePath, targetPath);
			}
		}
	}

	/**
	 * 卸载技能
	 */
	async uninstall(skillName: string): Promise<InstallResult> {
		const skillPath = path.join(this.skillsDir, skillName);

		// 检查技能是否存在
		if (!fs.existsSync(skillPath)) {
			return {
				success: false,
				error: `Skill not found: ${skillName}`
			};
		}

		try {
			// 删除文件夹
			this.deleteFolderRecursive(skillPath);

			logger.info('Skills' as LogCategory, 'Skill uninstalled', { skillName });

			return {
				success: true,
				skillName
			};

		} catch (error: any) {
			return {
				success: false,
				error: `Uninstall failed: ${error.message}`
			};
		}
	}

	/**
	 * 递归删除文件夹
	 */
	private deleteFolderRecursive(folderPath: string): void {
		if (!fs.existsSync(folderPath)) {
			return;
		}

		const files = fs.readdirSync(folderPath);

		for (const file of files) {
			const filePath = path.join(folderPath, file);
			const stat = fs.statSync(filePath);

			if (stat.isDirectory()) {
				// 递归删除子文件夹
				this.deleteFolderRecursive(filePath);
			} else {
				// 删除文件
				fs.unlinkSync(filePath);
			}
		}

		// 删除空文件夹
		fs.rmdirSync(folderPath);
	}

	/**
	 * 列出已安装的技能
	 */
	async listInstalled(): Promise<string[]> {
		if (!fs.existsSync(this.skillsDir)) {
			return [];
		}

		const folders = fs.readdirSync(this.skillsDir);
		const skills: string[] = [];

		for (const folder of folders) {
			const folderPath = path.join(this.skillsDir, folder);
			const stat = fs.statSync(folderPath);

			if (stat.isDirectory()) {
				// 检查是否包含 SKILL.md
				const skillMdPath = path.join(folderPath, 'SKILL.md');
				if (fs.existsSync(skillMdPath)) {
					skills.push(folder);
				}
			}
		}

		return skills;
	}

	/**
	 * 更新技能 (重新安装)
	 */
	async update(skillName: string, options: InstallOptions): Promise<InstallResult> {
		// 先卸载
		const uninstallResult = await this.uninstall(skillName);
		if (!uninstallResult.success) {
			return uninstallResult;
		}

		// 重新安装
		return await this.install({
			...options,
			targetName: skillName,
			overwrite: true
		});
	}
}
