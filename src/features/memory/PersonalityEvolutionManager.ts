import { App, TFile } from "obsidian";
import type { IPluginContext } from "../../core/plugin-context";;
import type { ChatMessage } from "../../core/types";
import type { StateSnapshot } from "./StateTypes";
import type { 
    PersonalityPatch, 
    PersonalityEvolution, 
    PersonalityChangeDetection,
    PersonalityEvolutionConfig 
} from "./PersonalityTypes";
import { logger } from "../../core/logger";

/**
 * 性格演进管理器
 * 负责检测角色性格的重大转变，并生成性格补丁
 */
export class PersonalityEvolutionManager {
    private app: App;
    private plugin: IPluginContext;
    private memoryBasePath: string;

    constructor(app: App, plugin: IPluginContext, memoryBasePath: string) {
        this.app = app;
        this.plugin = plugin;
        this.memoryBasePath = memoryBasePath;
    }

    /**
     * 获取性格演进文件路径
     */
    private getEvolutionPath(personaId: string, personaFolderName: string, characterId: string): string {
        return `${this.memoryBasePath}/${personaFolderName}/personality_evolution_${characterId}.json`;
    }

    /**
     * 加载性格演进历史
     */
    async loadEvolution(personaId: string, personaFolderName: string, characterId: string): Promise<PersonalityEvolution | null> {
        const evolutionPath = this.getEvolutionPath(personaId, personaFolderName, characterId);
        const file = this.app.vault.getAbstractFileByPath(evolutionPath);

        if (!(file instanceof TFile)) {
            return null;
        }

        try {
            const content = await this.app.vault.read(file);
            const evolution = JSON.parse(content) as PersonalityEvolution;
            return evolution;
        } catch (e) {
            logger.error("PersonalityEvolution", "加载性格演进历史失败", e);
            return null;
        }
    }

    /**
     * 保存性格演进历史
     */
    async saveEvolution(evolution: PersonalityEvolution, personaFolderName: string): Promise<void> {
        const evolutionPath = this.getEvolutionPath(
            evolution.personaId, 
            personaFolderName, 
            evolution.characterId
        );

        evolution.lastUpdated = Date.now();
        const content = JSON.stringify(evolution, null, 2);

        try {
            const file = this.app.vault.getAbstractFileByPath(evolutionPath);
            if (file instanceof TFile) {
                await this.app.vault.modify(file, content);
            } else {
                await this.app.vault.create(evolutionPath, content);
            }
            logger.debug("PersonalityEvolution", `性格演进历史已保存: ${evolutionPath}`);
        } catch (e) {
            logger.error("PersonalityEvolution", "保存性格演进历史失败", e);
        }
    }

    /**
     * 检测性格变化（通过分析状态历史和对话）
     */
    async detectPersonalityChange(
        recentMessages: ChatMessage[],
        stateHistory: StateSnapshot[],
        personaId: string
    ): Promise<PersonalityChangeDetection | null> {
        // 构建分析上下文
        const conversationText = recentMessages
            .filter(msg => msg.role === 'user' || msg.role === 'assistant')
            .slice(-20) // 最近 20 条消息
            .map(msg => `${msg.role === 'user' ? '用户' : '角色'}: ${msg.content}`)
            .join("\n");

        // 构建状态变化摘要
        const stateChangeSummary = this.summarizeStateChanges(stateHistory);

        const prompt = [
            {
                role: 'system' as const,
                content: `你是性格演进分析助手。分析角色是否发生了**重大的、持久的性格转变**。

【重要规则】
1. 只关注**重大且持久**的转变，不要被短期情绪波动误导
2. 必须有**明确的触发事件**和**充分的证据**
3. 转变类型：
   - attitude: 对某人/某事的根本态度改变（如从敌对到信任）
   - belief: 核心信念/价值观改变（如从"不相信爱情"到"愿意相信"）
   - goal: 人生目标/追求改变（如从"复仇"到"守护"）
   - trauma: 遭受重大创伤导致的性格变化
   - growth: 正向成长（如从"胆小"到"勇敢"）

【判断标准】
- 好感度从 30 涨到 50 → **不算**重大转变（正常波动）
- 好感度从 10 涨到 80，且有关键事件 → **算**重大转变
- 情绪从"警惕"到"放松" → **不算**（短期状态）
- 态度从"敌对"到"信任"，且多次确认 → **算**重大转变

【输出格式】
严格输出 JSON：
{
  "hasSignificantChange": true/false,
  "confidence": 0.85,
  "changes": [
    {
      "characterId": "角色名或protagonist",
      "changeType": "attitude|belief|goal|trauma|growth",
      "fromState": "转变前的状态（简短描述）",
      "toState": "转变后的状态（简短描述）",
      "trigger": "触发转变的关键事件（1-2句话）",
      "evidence": ["证据1：对话片段", "证据2：状态变化"],
      "priority": 8
    }
  ]
}

如果没有重大转变，返回：
{
  "hasSignificantChange": false,
  "confidence": 0.0,
  "changes": []
}

只输出 JSON，不要其他内容。`
            },
            {
                role: 'user' as const,
                content: `## 最近对话\n${conversationText}\n\n## 状态变化趋势\n${stateChangeSummary}`
            }
        ];

        try {
            const model = this.getMemoryModel();
            logger.debug("PersonalityEvolution", `检测性格变化，使用模型: ${model}`);
            
            const response = await this.plugin.llmService.getCompletion(prompt, model);
            const raw = response?.content || "";
            
            const parsed = this.tryParseJsonObject(raw);
            if (!parsed || typeof parsed !== 'object') {
                logger.warn("PersonalityEvolution", "性格变化检测失败：JSON 格式错误");
                return null;
            }

            return parsed as PersonalityChangeDetection;
        } catch (e) {
            logger.error("PersonalityEvolution", "性格变化检测异常", e);
            return null;
        }
    }

    /**
     * 生成性格补丁文本（用于注入角色卡）
     */
    async generatePatchText(change: PersonalityChangeDetection['changes'][0]): Promise<string> {
        const prompt = [
            {
                role: 'system' as const,
                content: `你是性格补丁生成助手。将角色的性格转变转换为简洁的补丁文本，用于注入角色卡。

【要求】
1. 简洁明确，1-3 句话
2. 使用现在时态
3. 强调转变后的**当前状态**，而不是过程
4. 可以提及触发事件，但重点是结果

【示例】
输入：
{
  "changeType": "attitude",
  "fromState": "对主角敌对",
  "toState": "对主角信任",
  "trigger": "主角救了她的命"
}

输出：
"经历了生死考验后，她现在完全信任主角，愿意将自己的秘密托付给他。"

只输出补丁文本，不要其他内容。`
            },
            {
                role: 'user' as const,
                content: JSON.stringify(change, null, 2)
            }
        ];

        try {
            const model = this.getMemoryModel();
            const response = await this.plugin.llmService.getCompletion(prompt, model);
            return response?.content?.trim() || "";
        } catch (e) {
            logger.error("PersonalityEvolution", "生成补丁文本失败", e);
            return "";
        }
    }

    /**
     * 创建性格补丁
     */
    async createPatch(
        change: PersonalityChangeDetection['changes'][0],
        personaId: string,
        personaFolderName: string
    ): Promise<PersonalityPatch | null> {
        const patchText = await this.generatePatchText(change);
        if (!patchText) {
            return null;
        }

        const patch: PersonalityPatch = {
            id: `${change.characterId}_${Date.now()}`,
            characterId: change.characterId,
            changeType: change.changeType,
            fromState: change.fromState,
            toState: change.toState,
            trigger: change.trigger,
            patchText,
            priority: change.priority || 5,
            createdAt: Date.now(),
            isActive: true,
            evidence: change.evidence || []
        };

        // 保存到演进历史
        let evolution = await this.loadEvolution(personaId, personaFolderName, change.characterId);
        if (!evolution) {
            evolution = {
                personaId,
                characterId: change.characterId,
                patches: [],
                createdAt: Date.now(),
                lastUpdated: Date.now(),
                version: 0
            };
        }

        evolution.patches.push(patch);
        evolution.version++;
        await this.saveEvolution(evolution, personaFolderName);

        logger.info("PersonalityEvolution", `创建性格补丁: ${change.characterId} - ${change.changeType}`);
        return patch;
    }

    /**
     * 获取所有激活的补丁文本（用于注入角色卡）
     */
    async getActivePatchesText(
        personaId: string, 
        personaFolderName: string, 
        characterId: string
    ): Promise<string> {
        const evolution = await this.loadEvolution(personaId, personaFolderName, characterId);
        if (!evolution || evolution.patches.length === 0) {
            return "";
        }

        const activePatches = evolution.patches
            .filter(p => p.isActive)
            .sort((a, b) => b.priority - a.priority); // 按优先级排序

        if (activePatches.length === 0) {
            return "";
        }

        const lines = ["## 性格演进"];
        for (const patch of activePatches) {
            lines.push(`- ${patch.patchText}`);
        }

        return lines.join('\n');
    }

    /**
     * 应用补丁到角色卡（更新 Character 对象）
     */
    async applyPatchToCharacter(
        patch: PersonalityPatch,
        personaId: string
    ): Promise<boolean> {
        try {
            // 获取角色卡
            const personas = this.plugin.settings.personas || [];
            const character = personas.find((c: any) => c.id === personaId);
            
            if (!character) {
                logger.warn("PersonalityEvolution", `未找到角色卡: ${personaId}`);
                return false;
            }

            // 将补丁注入到 systemPrompt（系统提示词）
            const patchSection = `\n\n[性格演进补丁]\n${patch.patchText}`;
            
            if (!character.systemPrompt) {
                character.systemPrompt = patchSection;
            } else if (!character.systemPrompt.includes(patch.patchText)) {
                character.systemPrompt += patchSection;
            }

            // 保存设置
            await this.plugin.saveSettings();
            
            patch.appliedAt = Date.now();
            logger.info("PersonalityEvolution", `补丁已应用到角色卡: ${personaId}`);
            return true;
        } catch (e) {
            logger.error("PersonalityEvolution", "应用补丁失败", e);
            return false;
        }
    }

    /**
     * 总结状态变化趋势
     */
    private summarizeStateChanges(stateHistory: StateSnapshot[]): string {
        if (stateHistory.length === 0) {
            return "无状态历史";
        }

        const lines: string[] = [];
        
        // 分析每个角色的状态变化
        const characterIds = new Set<string>();
        stateHistory.forEach(snapshot => {
            Object.keys(snapshot.characters).forEach(id => characterIds.add(id));
        });

        for (const characterId of characterIds) {
            const states = stateHistory
                .map(s => s.characters[characterId])
                .filter(Boolean);

            if (states.length < 2) continue;

            const first = states[0];
            const last = states[states.length - 1];

            const changes: string[] = [];
            
            if (first.affectionLevel !== undefined && last.affectionLevel !== undefined) {
                const diff = last.affectionLevel - first.affectionLevel;
                if (Math.abs(diff) >= 20) {
                    changes.push(`好感度: ${first.affectionLevel} → ${last.affectionLevel} (${diff > 0 ? '+' : ''}${diff})`);
                }
            }

            if (first.attitudeToPlayer !== last.attitudeToPlayer) {
                changes.push(`态度: ${first.attitudeToPlayer} → ${last.attitudeToPlayer}`);
            }

            if (changes.length > 0) {
                lines.push(`- **${characterId}**: ${changes.join(', ')}`);
            }
        }

        return lines.length > 0 ? lines.join('\n') : "无显著状态变化";
    }

    /**
     * 获取记忆模型
     */
    private getMemoryModel(): string {
        const settings = this.plugin.settings;
        return settings.memoryModel?.trim() 
            || settings.routerModel?.trim() 
            || settings.chatModels.split(',')[0]?.trim() 
            || 'gpt-3.5-turbo';
    }

    /**
     * 尝试解析 JSON
     */
    private tryParseJsonObject(text: string): any | null {
        const trimmed = String(text || "").trim();
        if (!trimmed) return null;

        const withoutFences = trimmed
            .replace(/^```(?:json)?\s*/i, "")
            .replace(/```\s*$/i, "")
            .trim();

        try {
            const parsed = JSON.parse(withoutFences);
            if (parsed && typeof parsed === "object") return parsed;
            return null;
        } catch {
            return null;
        }
    }
}
