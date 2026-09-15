/**
 * 情绪连贯性检测器
 * 检测情绪突变，确保情感变化的自然性
 */

import { Logger } from '../../core/logger';
import {
    EmotionalState,
    EmotionCoherenceIssue,
} from './ImmersionTypes';

export class EmotionCoherenceDetector {
    private logger: Logger;

    // 情绪词典（简化版，可扩展）
    private static readonly EMOTION_LEXICON: Record<string, {
        valence: number;  // 情感效价 (-100 到 100)
        arousal: number;  // 唤醒度 (0 到 100)
    }> = {
        // 负面低唤醒
        '悲伤': { valence: -70, arousal: 30 },
        '沮丧': { valence: -60, arousal: 20 },
        '失望': { valence: -50, arousal: 25 },
        '忧郁': { valence: -65, arousal: 20 },
        '孤独': { valence: -55, arousal: 15 },
        
        // 负面高唤醒
        '愤怒': { valence: -80, arousal: 90 },
        '恐惧': { valence: -75, arousal: 85 },
        '焦虑': { valence: -60, arousal: 70 },
        '惊恐': { valence: -85, arousal: 95 },
        '暴怒': { valence: -90, arousal: 95 },
        
        // 正面低唤醒
        '平静': { valence: 20, arousal: 10 },
        '放松': { valence: 30, arousal: 15 },
        '满足': { valence: 50, arousal: 20 },
        '安心': { valence: 40, arousal: 15 },
        
        // 正面高唤醒
        '快乐': { valence: 70, arousal: 60 },
        '兴奋': { valence: 80, arousal: 85 },
        '狂喜': { valence: 90, arousal: 95 },
        '激动': { valence: 75, arousal: 80 },
        
        // 中性
        '中立': { valence: 0, arousal: 30 },
        '困惑': { valence: -10, arousal: 40 },
        '好奇': { valence: 10, arousal: 50 },
        '惊讶': { valence: 0, arousal: 70 },
    };

    // 情绪惯性阈值（变化速率超过此值认为是突变）
    private static readonly ABRUPT_CHANGE_THRESHOLD = 60;

    constructor(logger: Logger) {
        this.logger = logger;
    }

    /**
     * 从文本中提取情绪
     */
    extractEmotion(text: string): EmotionalState | null {
        // 简单的关键词匹配（实际可用 LLM 提取）
        for (const [emotion, metrics] of Object.entries(EmotionCoherenceDetector.EMOTION_LEXICON)) {
            if (text.includes(emotion)) {
                return {
                    emotion,
                    intensity: 70, // 默认强度
                    valence: metrics.valence,
                    arousal: metrics.arousal,
                    timestamp: Date.now(),
                };
            }
        }

        // 如果没有明确情绪词，尝试从语气推断
        return this.inferEmotionFromTone(text);
    }

    /**
     * 从语气推断情绪
     */
    private inferEmotionFromTone(text: string): EmotionalState | null {
        // 检测感叹号（高唤醒）
        const exclamationCount = (text.match(/！|!/g) || []).length;
        // 检测问号（困惑/好奇）
        const questionCount = (text.match(/？|\?/g) || []).length;
        // 检测省略号（犹豫/沉思）
        const ellipsisCount = (text.match(/\.\.\.|…/g) || []).length;

        if (exclamationCount > 2) {
            return {
                emotion: '激动',
                intensity: Math.min(exclamationCount * 20, 100),
                valence: 50,
                arousal: 80,
                timestamp: Date.now(),
            };
        }

        if (questionCount > 2) {
            return {
                emotion: '困惑',
                intensity: 50,
                valence: -10,
                arousal: 40,
                timestamp: Date.now(),
            };
        }

        if (ellipsisCount > 1) {
            return {
                emotion: '沉思',
                intensity: 40,
                valence: 0,
                arousal: 20,
                timestamp: Date.now(),
            };
        }

        // 默认中性
        return {
            emotion: '中立',
            intensity: 30,
            valence: 0,
            arousal: 30,
            timestamp: Date.now(),
        };
    }

    /**
     * 检测情绪连贯性
     */
    checkCoherence(
        previousEmotion: EmotionalState,
        currentEmotion: EmotionalState,
        emotionalInertia: number = 0.5 // 情绪惯性 (0-1)
    ): EmotionCoherenceIssue | null {
        // 计算情绪变化速率
        const valenceChange = Math.abs(currentEmotion.valence - previousEmotion.valence);
        const arousalChange = Math.abs(currentEmotion.arousal - previousEmotion.arousal);
        const changeRate = (valenceChange + arousalChange) / 2;

        // 考虑情绪惯性（惯性越高，越难改变）
        const adjustedThreshold = EmotionCoherenceDetector.ABRUPT_CHANGE_THRESHOLD * (1 + emotionalInertia);

        const isAbrupt = changeRate > adjustedThreshold;

        if (isAbrupt) {
            this.logger.info('EmotionCoherence', `检测到情绪突变: ${previousEmotion.emotion} → ${currentEmotion.emotion}`, {
                changeRate,
                threshold: adjustedThreshold,
            });

            return {
                previousEmotion,
                currentEmotion,
                changeRate,
                isAbrupt: true,
                reason: `情绪从"${previousEmotion.emotion}"突然变为"${currentEmotion.emotion}"，变化过快`,
                suggestion: this.generateTransitionSuggestion(previousEmotion, currentEmotion),
            };
        }

        return null;
    }

    /**
     * 生成过渡建议
     */
    private generateTransitionSuggestion(
        from: EmotionalState,
        to: EmotionalState
    ): string {
        const valenceChange = to.valence - from.valence;
        const arousalChange = to.arousal - from.arousal;

        if (valenceChange > 50 && arousalChange > 50) {
            return '建议添加情绪过渡：先描写情绪逐渐变化的过程，而非直接跳转';
        }

        if (valenceChange < -50 && arousalChange > 50) {
            return '建议添加触发事件：解释是什么导致了情绪的剧烈转变';
        }

        if (Math.abs(valenceChange) > 70) {
            return '建议分段描写：将情绪变化分解为多个小步骤';
        }

        return '建议添加情绪过渡描写，使变化更自然';
    }

    /**
     * 计算情绪惯性
     * 基于情绪历史，某些情绪更"粘滞"
     */
    calculateEmotionalInertia(emotionHistory: EmotionalState[]): number {
        if (emotionHistory.length < 2) return 0.5; // 默认中等惯性

        // 如果最近的情绪都相同，惯性增加
        const recentEmotions = emotionHistory.slice(-3);
        const sameEmotionCount = recentEmotions.filter(
            (e) => e.emotion === recentEmotions[0].emotion
        ).length;

        const inertia = 0.3 + (sameEmotionCount / recentEmotions.length) * 0.5;
        return Math.min(inertia, 0.9); // 最大 0.9
    }

    /**
     * 扩展 CharacterState 的情绪历史
     */
    updateEmotionHistory(
        history: EmotionalState[],
        newEmotion: EmotionalState,
        maxHistory: number = 10
    ): EmotionalState[] {
        const updated = [...history, newEmotion];
        if (updated.length > maxHistory) {
            return updated.slice(-maxHistory);
        }
        return updated;
    }

    /**
     * 生成情绪上下文注入（用于 Prompt）
     */
    generateEmotionContext(currentEmotion: EmotionalState): string {
        return `【当前情绪状态】\n- 情绪: ${currentEmotion.emotion}\n- 强度: ${currentEmotion.intensity}/100\n- 情感倾向: ${this.valenceToString(currentEmotion.valence)}\n- 激活程度: ${this.arousalToString(currentEmotion.arousal)}`;
    }

    private valenceToString(valence: number): string {
        if (valence > 50) return '非常正面';
        if (valence > 20) return '正面';
        if (valence > -20) return '中性';
        if (valence > -50) return '负面';
        return '非常负面';
    }

    private arousalToString(arousal: number): string {
        if (arousal > 70) return '高度激动';
        if (arousal > 40) return '中度激活';
        return '平静';
    }
}
