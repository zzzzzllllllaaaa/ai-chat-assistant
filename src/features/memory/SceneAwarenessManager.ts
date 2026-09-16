/**
 * 场景感知管理器
 * 自动追踪和注入场景上下文，增强环境沉浸感
 */

import { Logger } from '../../core/logger';
import { SceneContext } from './ImmersionTypes';
import { App } from 'obsidian';

export class SceneAwarenessManager {
    private logger: Logger;
    private app: App;
    private currentScene: SceneContext | null = null;

    constructor(app: App, logger: Logger) {
        this.app = app;
        this.logger = logger;
    }

    /**
     * 从对话中提取场景信息
     */
    async extractSceneContext(
        messages: Array<{ role: string; content: string }>,
        personaId: string
    ): Promise<SceneContext | null> {
        // 取最近 3 条消息分析场景
        const recentMessages = messages.slice(-3);
        const combinedText = recentMessages.map((m) => m.content).join('\n');

        // 简单的关键词提取（实际可用 LLM）
        const location = this.extractLocation(combinedText);
        const timeOfDay = this.extractTimeOfDay(combinedText);
        const weather = this.extractWeather(combinedText);
        const ambience = this.extractAmbience(combinedText);
        const sensoryDetails = this.extractSensoryDetails(combinedText);
        const presentCharacters = this.extractPresentCharacters(combinedText);

        if (!location && !timeOfDay && !weather) {
            return null; // 没有明确的场景信息
        }

        const scene: SceneContext = {
            location: location || '未知地点',
            timeOfDay,
            weather,
            ambience,
            sensoryDetails,
            presentCharacters,
            lastUpdated: Date.now(),
        };

        this.currentScene = scene;
        this.logger.info('SceneAwareness', '提取场景上下文', scene);

        return scene;
    }

    /**
     * 提取位置
     */
    private extractLocation(text: string): string | undefined {
        // 常见位置模式
        const patterns = [
            /(?:在|来到|走进|进入|到达)([^，。！？\n]{2,10})/g,
            /([^，。！？\n]{2,10})(?:里|中|内|上|下)/g,
        ];

        for (const pattern of patterns) {
            const match = pattern.exec(text);
            if (match) {
                return match[1].trim();
            }
        }

        // 检测常见地点词
        const locationKeywords = ['房间', '街道', '森林', '城堡', '酒馆', '教室', '办公室', '公园', '海边', '山顶'];
        for (const keyword of locationKeywords) {
            if (text.includes(keyword)) {
                return keyword;
            }
        }

        return undefined;
    }

    /**
     * 提取时间
     */
    private extractTimeOfDay(text: string): SceneContext['timeOfDay'] {
        const timeKeywords: Record<string, SceneContext['timeOfDay']> = {
            '黎明': 'dawn',
            '清晨': 'morning',
            '早晨': 'morning',
            '上午': 'morning',
            '中午': 'noon',
            '正午': 'noon',
            '下午': 'afternoon',
            '傍晚': 'evening',
            '黄昏': 'evening',
            '晚上': 'night',
            '夜晚': 'night',
            '深夜': 'night',
            '午夜': 'midnight',
        };

        for (const [keyword, time] of Object.entries(timeKeywords)) {
            if (text.includes(keyword)) {
                return time;
            }
        }

        return undefined;
    }

    /**
     * 提取天气
     */
    private extractWeather(text: string): string | undefined {
        const weatherKeywords = [
            '晴天', '阴天', '多云', '下雨', '雨天', '雪天', '下雪',
            '雾', '起雾', '刮风', '风大', '闷热', '寒冷',
        ];

        for (const keyword of weatherKeywords) {
            if (text.includes(keyword)) {
                return keyword;
            }
        }

        return undefined;
    }

    /**
     * 提取氛围
     */
    private extractAmbience(text: string): string | undefined {
        const ambienceKeywords = [
            '安静', '嘈杂', '热闹', '冷清', '紧张', '轻松',
            '压抑', '欢快', '诡异', '温馨', '肃穆', '混乱',
        ];

        for (const keyword of ambienceKeywords) {
            if (text.includes(keyword)) {
                return keyword;
            }
        }

        return undefined;
    }

    /**
     * 提取五感细节
     */
    private extractSensoryDetails(text: string): SceneContext['sensoryDetails'] {
        const details: SceneContext['sensoryDetails'] = {};

        // 视觉
        const sightPatterns = [
            /看到([^，。！？\n]{2,20})/g,
            /眼前([^，。！？\n]{2,20})/g,
            /([^，。！？\n]{2,20})映入眼帘/g,
        ];
        details.sight = this.extractMatches(text, sightPatterns);

        // 听觉
        const soundPatterns = [
            /听到([^，。！？\n]{2,20})/g,
            /([^，。！？\n]{2,20})(?:声|响)/g,
        ];
        details.sound = this.extractMatches(text, soundPatterns);

        // 嗅觉
        const smellPatterns = [
            /闻到([^，。！？\n]{2,20})/g,
            /([^，。！？\n]{2,20})(?:味|香|臭)/g,
        ];
        details.smell = this.extractMatches(text, smellPatterns);

        // 触觉
        const touchPatterns = [
            /感觉到([^，。！？\n]{2,20})/g,
            /触摸([^，。！？\n]{2,20})/g,
        ];
        details.touch = this.extractMatches(text, touchPatterns);

        return details;
    }

    /**
     * 提取在场人物
     */
    private extractPresentCharacters(text: string): string[] {
        const characters: string[] = [];
        
        // 简单的人名检测（可扩展）
        const patterns = [
            /([^，。！？\n]{2,5})(?:走了过来|出现了|说道|回答)/g,
        ];

        for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(text)) !== null) {
                const name = match[1].trim();
                if (!characters.includes(name)) {
                    characters.push(name);
                }
            }
        }

        return characters;
    }

    /**
     * 辅助方法：提取匹配项
     */
    private extractMatches(text: string, patterns: RegExp[]): string[] {
        const matches: string[] = [];
        for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(text)) !== null) {
                const extracted = match[1].trim();
                if (extracted && !matches.includes(extracted)) {
                    matches.push(extracted);
                }
            }
        }
        return matches.length > 0 ? matches : [];
    }

    /**
     * 生成场景上下文注入（用于 Prompt）
     */
    generateScenePrompt(scene: SceneContext): string {
        const parts: string[] = ['【当前场景】'];

        parts.push(`- 地点: ${scene.location}`);

        if (scene.timeOfDay) {
            parts.push(`- 时间: ${this.timeOfDayToString(scene.timeOfDay)}`);
        }

        if (scene.weather) {
            parts.push(`- 天气: ${scene.weather}`);
        }

        if (scene.ambience) {
            parts.push(`- 氛围: ${scene.ambience}`);
        }

        if (scene.sensoryDetails) {
            const sensory: string[] = [];
            if (scene.sensoryDetails.sight?.length) {
                sensory.push(`视觉: ${scene.sensoryDetails.sight.join('、')}`);
            }
            if (scene.sensoryDetails.sound?.length) {
                sensory.push(`听觉: ${scene.sensoryDetails.sound.join('、')}`);
            }
            if (scene.sensoryDetails.smell?.length) {
                sensory.push(`嗅觉: ${scene.sensoryDetails.smell.join('、')}`);
            }
            if (scene.sensoryDetails.touch?.length) {
                sensory.push(`触觉: ${scene.sensoryDetails.touch.join('、')}`);
            }
            if (sensory.length > 0) {
                parts.push(`- 感官细节:\n  ${sensory.join('\n  ')}`);
            }
        }

        if (scene.presentCharacters?.length) {
            parts.push(`- 在场人物: ${scene.presentCharacters.join('、')}`);
        }

        return parts.join('\n');
    }

    /**
     * 时间转字符串
     */
    private timeOfDayToString(time: SceneContext['timeOfDay']): string {
        if (!time) return '';
        const map: Record<string, string> = {
            dawn: '黎明',
            morning: '早晨',
            noon: '中午',
            afternoon: '下午',
            evening: '傍晚',
            night: '夜晚',
            midnight: '午夜',
        };
        return map[time] || time;
    }

    /**
     * 获取当前场景
     */
    getCurrentScene(): SceneContext | null {
        return this.currentScene;
    }

    /**
     * 持久化场景到文件
     */
    async saveScene(personaId: string, conversationId: string): Promise<void> {
        if (!this.currentScene) return;

        const scenePath = `Personas/${personaId}/Conversations/${conversationId}/scene.json`;
        const sceneData = JSON.stringify(this.currentScene, null, 2);

        try {
            await this.app.vault.adapter.write(scenePath, sceneData);
            this.logger.info('SceneAwareness', '保存场景上下文', { path: scenePath });
        } catch (error) {
            this.logger.error('SceneAwareness', '保存场景失败', error);
        }
    }

    /**
     * 加载场景
     */
    async loadScene(personaId: string, conversationId: string): Promise<SceneContext | null> {
        const scenePath = `Personas/${personaId}/Conversations/${conversationId}/scene.json`;

        try {
            const exists = await this.app.vault.adapter.exists(scenePath);
            if (!exists) return null;

            const sceneData = await this.app.vault.adapter.read(scenePath);
            this.currentScene = JSON.parse(sceneData);
            this.logger.info('SceneAwareness', '加载场景上下文', { path: scenePath });
            return this.currentScene;
        } catch (error) {
            this.logger.error('SceneAwareness', '加载场景失败', error);
            return null;
        }
    }
}
