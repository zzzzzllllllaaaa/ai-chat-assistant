/**
 * 沉浸感管理器
 * 统一管理 OOC 检测、叙事视角、情绪连贯性、场景感知等功能
 */

import { App } from 'obsidian';
import { Logger } from '../../core/logger';
import { OOCDetector } from './OOCDetector';
import { NarrativeController } from './NarrativeController';
import { EmotionCoherenceDetector } from './EmotionCoherenceDetector';
import { SceneAwarenessManager } from './SceneAwarenessManager';
import {
    ImmersionCheckResult,
    OOCDetectionConfig,
    NarrativeStyle,
    EmotionalState,
    SceneContext,
} from './ImmersionTypes';

export class ImmersionManager {
    private app: App;
    private logger: Logger;
    
    private oocDetector: OOCDetector;
    private narrativeController: NarrativeController;
    private emotionDetector: EmotionCoherenceDetector;
    private sceneManager: SceneAwarenessManager;

    // 缓存
    private narrativeStyleCache: Map<string, NarrativeStyle> = new Map();
    private emotionHistoryCache: Map<string, EmotionalState[]> = new Map();

    constructor(app: App, logger: Logger) {
        this.app = app;
        this.logger = logger;
        
        this.oocDetector = new OOCDetector(logger);
        this.narrativeController = new NarrativeController(logger);
        this.emotionDetector = new EmotionCoherenceDetector(logger);
        this.sceneManager = new SceneAwarenessManager(app, logger);
    }

    /**
     * 完整的沉浸感检测
     */
    async checkImmersion(
        response: string,
        personaId: string,
        config: {
            oocConfig?: OOCDetectionConfig;
            narrativeStyle?: NarrativeStyle;
            previousEmotion?: EmotionalState;
            checkEmotion?: boolean;
        } = {}
    ): Promise<ImmersionCheckResult> {
        const result: ImmersionCheckResult = {
            oocIssues: [],
            perspectiveIssues: [],
            emotionIssues: [],
            passed: true,
            score: 100,
            suggestions: [],
        };

        // 1. OOC 检测
        const oocIssues = this.oocDetector.detect(response, config.oocConfig);
        result.oocIssues = oocIssues;

        // 2. 叙事视角检测
        if (config.narrativeStyle) {
            const perspectiveIssues = this.narrativeController.detectPerspectiveShift(
                response,
                config.narrativeStyle.primaryPerspective
            );
            result.perspectiveIssues = perspectiveIssues;

            // 检测旁白化
            const narratorIssues = this.narrativeController.detectNarratorMode(response);
            result.perspectiveIssues.push(...narratorIssues);
        }

        // 3. 情绪连贯性检测
        if (config.checkEmotion !== false) {
            const currentEmotion = this.emotionDetector.extractEmotion(response);
            
            if (currentEmotion && config.previousEmotion) {
                const emotionHistory = this.emotionHistoryCache.get(personaId) || [];
                const inertia = this.emotionDetector.calculateEmotionalInertia(emotionHistory);
                
                const coherenceIssue = this.emotionDetector.checkCoherence(
                    config.previousEmotion,
                    currentEmotion,
                    inertia
                );
                
                if (coherenceIssue) {
                    result.emotionIssues.push(coherenceIssue);
                }

                // 更新情绪历史
                const updatedHistory = this.emotionDetector.updateEmotionHistory(
                    emotionHistory,
                    currentEmotion
                );
                this.emotionHistoryCache.set(personaId, updatedHistory);
            }
        }

        // 4. 计算总体评分
        const totalIssues = 
            result.oocIssues.length +
            result.perspectiveIssues.length +
            result.emotionIssues.length;

        result.score = Math.max(0, 100 - totalIssues * 10);
        result.passed = result.score >= 60;

        // 5. 生成建议
        if (result.oocIssues.length > 0) {
            result.suggestions.push(...this.oocDetector.generateSuggestions(result.oocIssues));
        }
        if (result.perspectiveIssues.length > 0) {
            result.suggestions.push('保持叙事视角一致，避免人称混乱');
        }
        if (result.emotionIssues.length > 0) {
            result.suggestions.push('添加情绪过渡描写，使情感变化更自然');
        }

        if (!result.passed) {
            this.logger.info('Immersion', `沉浸感检测未通过 (评分: ${result.score})`, result);
        }

        return result;
    }

    /**
     * 增强 System Prompt（注入叙事视角、场景、情绪等）
     */
    async enhanceSystemPrompt(
        systemPrompt: string,
        personaId: string,
        conversationId: string,
        messages: Array<{ role: string; content: string }>
    ): Promise<string> {
        let enhanced = systemPrompt;

        // 1. 注入叙事视角锁定
        const narrativeStyle = this.getNarrativeStyle(personaId, systemPrompt);
        enhanced = this.narrativeController.injectPerspectiveLock(enhanced, narrativeStyle);

        // 2. 注入场景上下文
        const scene = await this.sceneManager.extractSceneContext(messages, personaId);
        if (scene) {
            const scenePrompt = this.sceneManager.generateScenePrompt(scene);
            enhanced = `${enhanced}\n\n${scenePrompt}`;
        }

        // 3. 注入情绪上下文
        const emotionHistory = this.emotionHistoryCache.get(personaId);
        if (emotionHistory && emotionHistory.length > 0) {
            const currentEmotion = emotionHistory[emotionHistory.length - 1];
            const emotionPrompt = this.emotionDetector.generateEmotionContext(currentEmotion);
            enhanced = `${enhanced}\n\n${emotionPrompt}`;
        }

        return enhanced;
    }

    /**
     * 获取或推断叙事风格
     */
    getNarrativeStyle(personaId: string, systemPrompt: string): NarrativeStyle {
        if (this.narrativeStyleCache.has(personaId)) {
            return this.narrativeStyleCache.get(personaId)!;
        }

        const style = this.narrativeController.inferNarrativeStyle(systemPrompt);
        this.narrativeStyleCache.set(personaId, style);
        return style;
    }

    /**
     * 设置叙事风格（手动配置）
     */
    setNarrativeStyle(personaId: string, style: NarrativeStyle): void {
        this.narrativeStyleCache.set(personaId, style);
        this.logger.info('Immersion', `设置叙事风格`, { personaId, style });
    }

    /**
     * 获取当前情绪
     */
    getCurrentEmotion(personaId: string): EmotionalState | null {
        const history = this.emotionHistoryCache.get(personaId);
        if (!history || history.length === 0) return null;
        return history[history.length - 1];
    }

    /**
     * 获取当前场景
     */
    getCurrentScene(): SceneContext | null {
        return this.sceneManager.getCurrentScene();
    }

    /**
     * 保存场景
     */
    async saveScene(personaId: string, conversationId: string): Promise<void> {
        await this.sceneManager.saveScene(personaId, conversationId);
    }

    /**
     * 加载场景
     */
    async loadScene(personaId: string, conversationId: string): Promise<SceneContext | null> {
        return await this.sceneManager.loadScene(personaId, conversationId);
    }

    /**
     * 清除缓存
     */
    clearCache(personaId?: string): void {
        if (personaId) {
            this.narrativeStyleCache.delete(personaId);
            this.emotionHistoryCache.delete(personaId);
        } else {
            this.narrativeStyleCache.clear();
            this.emotionHistoryCache.clear();
        }
        this.logger.info('Immersion', '清除缓存', { personaId });
    }

    /**
     * 获取 OOC 检测配置（从角色卡推断）
     */
    inferOOCConfig(systemPrompt: string): OOCDetectionConfig {
        const config: OOCDetectionConfig = {
            detectMoralPreaching: true,
            detectMetaNarrative: true,
            severityThreshold: 'medium',
        };

        // 推断时代背景
        if (/古代|古风|武侠|仙侠/.test(systemPrompt)) {
            config.timePeriod = 'ancient';
        } else if (/中世纪|魔法|奇幻/.test(systemPrompt)) {
            config.timePeriod = 'medieval';
        } else if (/现代|当代/.test(systemPrompt)) {
            config.timePeriod = 'modern';
        } else if (/未来|科幻|赛博/.test(systemPrompt)) {
            config.timePeriod = 'future';
        }

        return config;
    }
}
