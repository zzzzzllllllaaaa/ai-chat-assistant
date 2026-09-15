/**
 * OOC（Out of Character）检测器
 * 检测 AI 回复中的出戏问题，防止角色说出不该说的话
 */

import { Logger } from '../../core/logger';
import {
    OOCIssue,
    OOCIssueType,
    OOCDetectionConfig,
} from './ImmersionTypes';

export class OOCDetector {
    private logger: Logger;

    // 通用禁忌词库（适用于大多数角色扮演场景）
    private static readonly COMMON_FORBIDDEN_PATTERNS = [
        // 元叙事/打破第四面墙
        /作为(一个)?AI|作为(一个)?语言模型|作为(一个)?助手/gi,
        /我(只)?是(一个)?程序|我(只)?是(一个)?虚拟/gi,
        /在(这个)?(虚拟)?世界(中|里)/gi,
        /这(只)?是(一个)?游戏|这(只)?是(一个)?故事/gi,
        
        // 道德说教（常见模式）
        /我(们)?应该(要)?尊重|我(们)?需要理解/gi,
        /让我们一起|让我们共同/gi,
        /重要的是要记住|需要注意的是/gi,
        /从道德(的)?角度|从伦理(的)?角度/gi,
        
        // 现代网络用语（可根据时代背景调整）
        /yyds|awsl|绝绝子|芭比Q|栓Q/gi,
        /打call|安利|种草|拔草/gi,
        
        // AI 常见的"安全回复"模式
        /我无法(提供|给出|回答)|我不能(提供|给出|回答)/gi,
        /这(可能)?涉及(到)?隐私|这(可能)?不太合适/gi,
        /建议(您)?咨询专业(人士|医生|律师)/gi,
    ];

    // 时代错误词库
    private static readonly ANACHRONISM_PATTERNS: Record<string, RegExp[]> = {
        ancient: [
            /手机|电脑|互联网|网络|电话/gi,
            /汽车|飞机|火车|地铁/gi,
            /民主|人权|自由|平等/gi, // 现代政治概念
        ],
        medieval: [
            /手机|电脑|互联网|网络/gi,
            /汽车|飞机|火车/gi,
            /科学|实验|理论/gi, // 现代科学概念
        ],
        fantasy: [
            /手机|电脑|互联网/gi, // 除非是魔法世界的等价物
        ],
    };

    constructor(logger: Logger) {
        this.logger = logger;
    }

    /**
     * 检测 AI 回复中的 OOC 问题
     */
    detect(
        response: string,
        config: OOCDetectionConfig = {}
    ): OOCIssue[] {
        const issues: OOCIssue[] = [];

        // 1. 检测禁忌词
        issues.push(...this.detectForbiddenWords(response, config));

        // 2. 检测元叙事
        if (config.detectMetaNarrative !== false) {
            issues.push(...this.detectMetaNarrative(response));
        }

        // 3. 检测道德说教
        if (config.detectMoralPreaching !== false) {
            issues.push(...this.detectMoralPreaching(response));
        }

        // 4. 检测时代错误
        if (config.timePeriod) {
            issues.push(...this.detectAnachronism(response, config.timePeriod));
        }

        // 5. 过滤低于阈值的问题
        const threshold = config.severityThreshold || 'low';
        const filtered = this.filterBySeverity(issues, threshold);

        if (filtered.length > 0) {
            this.logger.info('OOC', `检测到 ${filtered.length} 个 OOC 问题`, filtered);
        }

        return filtered;
    }

    /**
     * 检测禁忌词
     */
    private detectForbiddenWords(
        response: string,
        config: OOCDetectionConfig
    ): OOCIssue[] {
        const issues: OOCIssue[] = [];

        // 检测自定义禁忌词
        if (config.forbiddenWords) {
            for (const word of config.forbiddenWords) {
                const regex = new RegExp(word, 'gi');
                let match;
                while ((match = regex.exec(response)) !== null) {
                    issues.push({
                        type: OOCIssueType.FORBIDDEN_WORD,
                        severity: 'high',
                        matchedText: match[0],
                        position: { start: match.index, end: regex.lastIndex },
                        reason: `角色不应使用词汇"${match[0]}"`,
                        suggestion: '请使用符合角色设定的表达方式',
                    });
                }
            }
        }

        // 检测自定义正则
        if (config.forbiddenPatterns) {
            for (const pattern of config.forbiddenPatterns) {
                let match;
                while ((match = pattern.exec(response)) !== null) {
                    issues.push({
                        type: OOCIssueType.FORBIDDEN_WORD,
                        severity: 'high',
                        matchedText: match[0],
                        position: { start: match.index, end: pattern.lastIndex },
                        reason: `匹配到禁忌模式`,
                        suggestion: '请重新表达',
                    });
                }
            }
        }

        return issues;
    }

    /**
     * 检测元叙事
     */
    private detectMetaNarrative(response: string): OOCIssue[] {
        const issues: OOCIssue[] = [];
        const patterns = [
            /作为(一个)?AI|作为(一个)?语言模型|作为(一个)?助手/gi,
            /我(只)?是(一个)?程序|我(只)?是(一个)?虚拟/gi,
            /在(这个)?(虚拟)?世界(中|里)/gi,
            /这(只)?是(一个)?游戏|这(只)?是(一个)?故事/gi,
            /让我们(继续)?扮演|让我们(继续)?角色扮演/gi,
        ];

        for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(response)) !== null) {
                issues.push({
                    type: OOCIssueType.META_NARRATIVE,
                    severity: 'high',
                    matchedText: match[0],
                    position: { start: match.index, end: pattern.lastIndex },
                    reason: '打破第四面墙，提及自己是 AI 或虚拟角色',
                    suggestion: '保持角色沉浸，不要提及虚拟性质',
                });
            }
        }

        return issues;
    }

    /**
     * 检测道德说教
     */
    private detectMoralPreaching(response: string): OOCIssue[] {
        const issues: OOCIssue[] = [];
        const patterns = [
            /我(们)?应该(要)?尊重|我(们)?需要理解/gi,
            /让我们一起|让我们共同/gi,
            /重要的是要记住|需要注意的是/gi,
            /从道德(的)?角度|从伦理(的)?角度/gi,
            /我无法(提供|给出|回答)|我不能(提供|给出|回答)/gi,
            /这(可能)?涉及(到)?隐私|这(可能)?不太合适/gi,
            /建议(您)?咨询专业(人士|医生|律师)/gi,
        ];

        for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(response)) !== null) {
                issues.push({
                    type: OOCIssueType.MORAL_PREACHING,
                    severity: 'medium',
                    matchedText: match[0],
                    position: { start: match.index, end: pattern.lastIndex },
                    reason: 'AI 安全回复模式或道德说教',
                    suggestion: '以角色身份自然回应，而非说教',
                });
            }
        }

        return issues;
    }

    /**
     * 检测时代错误
     */
    private detectAnachronism(
        response: string,
        timePeriod: string
    ): OOCIssue[] {
        const issues: OOCIssue[] = [];
        const patterns = OOCDetector.ANACHRONISM_PATTERNS[timePeriod];

        if (!patterns) return issues;

        for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(response)) !== null) {
                issues.push({
                    type: OOCIssueType.ANACHRONISM,
                    severity: 'high',
                    matchedText: match[0],
                    position: { start: match.index, end: pattern.lastIndex },
                    reason: `"${match[0]}"不符合${timePeriod}时代背景`,
                    suggestion: '使用符合时代背景的词汇',
                });
            }
        }

        return issues;
    }

    /**
     * 按严重程度过滤
     */
    private filterBySeverity(
        issues: OOCIssue[],
        threshold: 'low' | 'medium' | 'high'
    ): OOCIssue[] {
        const severityOrder = { low: 0, medium: 1, high: 2 };
        const minLevel = severityOrder[threshold];

        return issues.filter(
            (issue) => severityOrder[issue.severity] >= minLevel
        );
    }

    /**
     * 生成修复建议
     */
    generateSuggestions(issues: OOCIssue[]): string[] {
        const suggestions: string[] = [];

        const groupedByType = issues.reduce((acc, issue) => {
            if (!acc[issue.type]) acc[issue.type] = [];
            acc[issue.type].push(issue);
            return acc;
        }, {} as Record<string, OOCIssue[]>);

        for (const [type, typeIssues] of Object.entries(groupedByType)) {
            switch (type) {
                case OOCIssueType.META_NARRATIVE:
                    suggestions.push(
                        '避免提及自己是 AI 或虚拟角色，保持角色沉浸感'
                    );
                    break;
                case OOCIssueType.MORAL_PREACHING:
                    suggestions.push(
                        '以角色身份自然回应，避免说教或"安全回复"模式'
                    );
                    break;
                case OOCIssueType.ANACHRONISM:
                    suggestions.push(
                        `避免使用现代词汇，使用符合时代背景的表达`
                    );
                    break;
                case OOCIssueType.FORBIDDEN_WORD:
                    suggestions.push(
                        `避免使用禁忌词：${typeIssues.map((i) => i.matchedText).join('、')}`
                    );
                    break;
            }
        }

        return suggestions;
    }
}
