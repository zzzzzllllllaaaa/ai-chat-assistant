/**
 * 叙事视角控制器
 * 检测和强制叙事视角一致性，防止人称混乱
 */

import { Logger } from '../../core/logger';
import {
    NarrativePerspective,
    NarrativeStyle,
    OOCIssue,
    OOCIssueType,
} from './ImmersionTypes';

export class NarrativeController {
    private logger: Logger;

    // 人称检测模式
    private static readonly PERSPECTIVE_PATTERNS = {
        first: [
            /[^，。！？]*[我][^，。！？]*/g,  // 包含"我"的句子
            /[^，。！？]*[咱][^，。！？]*/g,  // 包含"咱"的句子
        ],
        second: [
            /[^，。！？]*[你][^，。！？]*/g,  // 包含"你"的句子
        ],
        third: [
            /[^，。！？]*[他她它][^，。！？]*/g,  // 包含"他/她/它"的句子
        ],
    };

    constructor(logger: Logger) {
        this.logger = logger;
    }

    /**
     * 检测回复的主要叙事视角
     */
    detectPerspective(response: string): NarrativePerspective {
        const counts = {
            first: 0,
            second: 0,
            third: 0,
        };

        // 统计各种人称的出现次数
        for (const [perspective, patterns] of Object.entries(
            NarrativeController.PERSPECTIVE_PATTERNS
        )) {
            for (const pattern of patterns) {
                const matches = response.match(pattern);
                if (matches) {
                    counts[perspective as keyof typeof counts] += matches.length;
                }
            }
        }

        // 判断主要视角
        const total = counts.first + counts.second + counts.third;
        if (total === 0) return NarrativePerspective.THIRD_PERSON; // 默认第三人称

        const firstRatio = counts.first / total;
        const secondRatio = counts.second / total;
        const thirdRatio = counts.third / total;

        // 如果某个视角占比超过 60%，认为是该视角
        if (firstRatio > 0.6) return NarrativePerspective.FIRST_PERSON;
        if (secondRatio > 0.6) return NarrativePerspective.SECOND_PERSON;
        if (thirdRatio > 0.6) return NarrativePerspective.THIRD_PERSON;

        // 否则是混合视角
        return NarrativePerspective.MIXED;
    }

    /**
     * 检测视角切换问题
     */
    detectPerspectiveShift(
        response: string,
        expectedPerspective: NarrativePerspective
    ): OOCIssue[] {
        const issues: OOCIssue[] = [];
        const detected = this.detectPerspective(response);

        // 如果期望的是混合视角，则不检测
        if (expectedPerspective === NarrativePerspective.MIXED) {
            return issues;
        }

        // 如果检测到的视角与期望不符
        if (detected !== expectedPerspective && detected !== NarrativePerspective.MIXED) {
            issues.push({
                type: OOCIssueType.PERSPECTIVE_SHIFT,
                severity: 'high',
                matchedText: response.substring(0, 50) + '...',
                position: { start: 0, end: response.length },
                reason: `期望${this.perspectiveToString(expectedPerspective)}，但检测到${this.perspectiveToString(detected)}`,
                suggestion: `保持${this.perspectiveToString(expectedPerspective)}叙事`,
            });
        }

        // 检测段落内的视角混乱
        const paragraphs = response.split(/\n\n+/);
        for (let i = 0; i < paragraphs.length; i++) {
            const para = paragraphs[i];
            const paraDetected = this.detectPerspective(para);
            
            if (
                paraDetected !== expectedPerspective &&
                paraDetected !== NarrativePerspective.MIXED &&
                para.length > 20 // 忽略太短的段落
            ) {
                const start = response.indexOf(para);
                issues.push({
                    type: OOCIssueType.PERSPECTIVE_SHIFT,
                    severity: 'medium',
                    matchedText: para.substring(0, 50) + '...',
                    position: { start, end: start + para.length },
                    reason: `段落 ${i + 1} 的视角不一致`,
                    suggestion: `统一使用${this.perspectiveToString(expectedPerspective)}`,
                });
            }
        }

        if (issues.length > 0) {
            this.logger.info('Narrative', `检测到 ${issues.length} 个视角问题`, issues);
        }

        return issues;
    }

    /**
     * 生成视角锁定的 Prompt 注入
     */
    injectPerspectiveLock(
        systemPrompt: string,
        style: NarrativeStyle
    ): string {
        const perspectiveInstructions = this.generatePerspectiveInstructions(style);
        
        // 在 System Prompt 最前面注入（最高优先级）
        return `${perspectiveInstructions}\n\n${systemPrompt}`;
    }

    /**
     * 生成视角指令
     */
    private generatePerspectiveInstructions(style: NarrativeStyle): string {
        const instructions: string[] = [];

        // 主要视角指令
        switch (style.primaryPerspective) {
            case NarrativePerspective.FIRST_PERSON:
                instructions.push(
                    '【叙事视角锁定】',
                    '- 必须使用第一人称（"我"）进行叙事',
                    '- 所有描写、对话、思考都从"我"的视角出发',
                    '- 不要切换到第三人称（"他/她"）或旁白视角'
                );
                break;
            case NarrativePerspective.THIRD_PERSON:
                instructions.push(
                    '【叙事视角锁定 - 第三人称】',
                    '- 必须使用第三人称（"他/她/角色名"）进行叙事',
                    '- 你是客观的叙述者，不是角色本身',
                    '- 禁止使用"我"来代表角色（除非在角色的对话引号内）',
                    '- 保持叙述者的视角，不要混淆AI和角色的身份',
                    '- 示例：✅"她低头看着手机" ❌"我低头看着手机"'
                );
                break;
            case NarrativePerspective.SECOND_PERSON:
                instructions.push(
                    '【叙事视角锁定】',
                    '- 使用第二人称（"你"）进行叙事',
                    '- 直接对读者/玩家说话',
                    '- 不要切换到其他人称'
                );
                break;
        }

        // 动作描写指令
        if (style.allowActionMarkers) {
            instructions.push('- 可以使用 *动作* 或 【表情】 标记非语言行为');
        }

        // 内心独白指令
        if (style.allowInnerMonologue) {
            instructions.push('- 可以描写内心想法和感受');
        } else {
            instructions.push('- 避免直接描写内心想法，通过行为和对话暗示');
        }

        // 环境描写指令
        if (style.allowEnvironmentDescription) {
            instructions.push('- 可以适当描写环境和氛围');
        }

        // 语气指令
        if (style.tone) {
            instructions.push(`- 保持${style.tone}的叙事语气`);
        }

        return instructions.join('\n');
    }

    /**
     * 视角枚举转字符串
     */
    private perspectiveToString(perspective: NarrativePerspective): string {
        const map = {
            [NarrativePerspective.FIRST_PERSON]: '第一人称',
            [NarrativePerspective.SECOND_PERSON]: '第二人称',
            [NarrativePerspective.THIRD_PERSON]: '第三人称',
            [NarrativePerspective.MIXED]: '混合视角',
        };
        return map[perspective] || '未知视角';
    }

    /**
     * 从角色卡推断叙事风格
     */
    inferNarrativeStyle(systemPrompt: string): NarrativeStyle {
        // 简单的启发式推断
        const hasFirstPerson = /以.*我.*的(身份|视角|口吻)|使用第一人称|用"我"/i.test(systemPrompt);
        const hasThirdPerson = /以.*第三人称|客观叙述|使用第三人称|用"他\/她"/i.test(systemPrompt);
        
        // 默认第三人称（角色扮演更常见的视角）
        let primaryPerspective = NarrativePerspective.THIRD_PERSON;
        
        // 只有明确要求第一人称时才使用
        if (hasFirstPerson && !hasThirdPerson) {
            primaryPerspective = NarrativePerspective.FIRST_PERSON;
        } else if (hasThirdPerson) {
            primaryPerspective = NarrativePerspective.THIRD_PERSON;
        }

        return {
            primaryPerspective,
            allowActionMarkers: true,
            allowInnerMonologue: true,
            allowEnvironmentDescription: true,
        };
    }

    /**
     * 检测"旁白化"问题
     * AI 突然变成旁白，而不是角色本身
     */
    detectNarratorMode(response: string): OOCIssue[] {
        const issues: OOCIssue[] = [];
        
        // 检测旁白模式的常见模式
        const narratorPatterns = [
            /^(于是|然后|接着|随后|此时|这时)[，,]/gm,  // 以旁白词开头
            /故事(继续|发展|进行)/gi,
            /镜头(转向|切换到)/gi,
            /画面(中|里|上)/gi,
        ];

        for (const pattern of narratorPatterns) {
            let match;
            while ((match = pattern.exec(response)) !== null) {
                issues.push({
                    type: OOCIssueType.PERSPECTIVE_SHIFT,
                    severity: 'medium',
                    matchedText: match[0],
                    position: { start: match.index, end: pattern.lastIndex },
                    reason: '切换到旁白视角，而非角色视角',
                    suggestion: '保持角色第一人称视角，不要变成旁白',
                });
            }
        }

        return issues;
    }
}
