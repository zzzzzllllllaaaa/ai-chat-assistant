import { App, TFile } from "obsidian";
import type { IPluginContext } from "../../core/plugin-context";;
import type { ChatMessage } from "../../core/types";
import type { 
    CharacterState, 
    StateSnapshot, 
    StateUpdateResult,
    StateExtractionConfig 
} from "./StateTypes";
import { logger } from "../../core/logger";

/**
 * 状态机管理器
 * 负责角色动态状态的提取、存储和注入
 */
export class StateMachineManager {
    private app: App;
    private plugin: IPluginContext;
    private memoryBasePath: string;

    constructor(app: App, plugin: IPluginContext, memoryBasePath: string) {
        this.app = app;
        this.plugin = plugin;
        this.memoryBasePath = memoryBasePath;
    }

    /**
     * 获取状态文件路径
     */
    private getStatePath(personaId: string, personaFolderName: string): string {
        return `${this.memoryBasePath}/${personaFolderName}/state.json`;
    }

    /**
     * 加载状态快照
     */
    async loadState(personaId: string, personaFolderName: string): Promise<StateSnapshot | null> {
        const statePath = this.getStatePath(personaId, personaFolderName);
        const file = this.app.vault.getAbstractFileByPath(statePath);

        if (!(file instanceof TFile)) {
            return null;
        }

        try {
            const content = await this.app.vault.read(file);
            const snapshot = JSON.parse(content) as StateSnapshot;
            return snapshot;
        } catch (e) {
            logger.error("StateMachine", "加载状态失败", e);
            return null;
        }
    }

    /**
     * 保存状态快照
     */
    async saveState(snapshot: StateSnapshot, personaFolderName: string): Promise<void> {
        const statePath = this.getStatePath(snapshot.personaId, personaFolderName);
        const file = this.app.vault.getAbstractFileByPath(statePath);

        snapshot.lastUpdated = Date.now();
        const content = JSON.stringify(snapshot, null, 2);

        try {
            if (file instanceof TFile) {
                await this.app.vault.modify(file, content);
            } else {
                await this.app.vault.create(statePath, content);
            }
            logger.debug("StateMachine", `状态已保存: ${statePath}`);
        } catch (e) {
            logger.error("StateMachine", "保存状态失败", e);
        }
    }

    /**
     * 从对话中提取状态更新（轻量级 Prompt）
     */
    async extractStateUpdates(
        messages: ChatMessage[], 
        personaId: string,
        config?: StateExtractionConfig
    ): Promise<Record<string, Partial<CharacterState>> | null> {
        const conversationText = messages
            .filter(msg => msg.role === 'user' || msg.role === 'assistant')
            .slice(-6) // 只看最近 6 条消息
            .map(msg => `${msg.role === 'user' ? '用户' : '角色'}: ${msg.content}`)
            .join("\n");

        const prompt = [
            {
                role: 'system' as const,
                content: `你是状态提取助手。从对话中提取角色的**当前瞬时状态**。

【重要规则】
1. 只提取**明确变化**的状态，没有变化的不要输出
2. 只提取**当前时刻**的状态，不要提取历史或计划
3. 位置、情绪、活动必须是**此时此刻**正在发生的
4. 好感度/信任度用 0-100 的数字表示
5. 物品变化用 "+物品名" 表示获得，"-物品名" 表示失去
6. 如果没有任何状态变化，返回空对象 {}

【输出格式】
严格输出 JSON，格式如下：
{
  "角色名或protagonist": {
    "currentLocation": "当前位置（如果明确提到）",
    "currentEmotion": "当前情绪（如：警惕、放松、愤怒）",
    "currentActivity": "正在做什么（如：喝酒、战斗、休息）",
    "attitudeToPlayer": "对主角的态度（如：信任、敌对、中立）",
    "affectionLevel": 65,
    "trustLevel": 70,
    "inventoryChanges": ["+商队通行证", "-银币"],
    "flags": {
      "已知玩家身份": true,
      "承诺帮助玩家": true
    }
  }
}

【示例】
对话：
用户: 我们现在在酒馆吗？
角色: *放松地靠在椅背上* 是的，这里很安全。我现在相信你了。*把一枚铁牌推过来* 这是商队通行证，你拿着吧。

输出：
{
  "林慧欣": {
    "currentLocation": "酒馆",
    "currentEmotion": "放松",
    "currentActivity": "坐着聊天",
    "attitudeToPlayer": "信任",
    "affectionLevel": 70,
    "inventoryChanges": ["-商队通行证"]
  },
  "protagonist": {
    "currentLocation": "酒馆",
    "inventoryChanges": ["+商队通行证"]
  }
}

只输出 JSON，不要其他内容。`
            },
            {
                role: 'user' as const,
                content: conversationText
            }
        ];

        try {
            const model = this.getMemoryModel();
            logger.debug("StateMachine", `提取状态更新，使用模型: ${model}`);
            
            const response = await this.plugin.llmService.getCompletion(prompt, model);
            const raw = response?.content || "";
            
            const parsed = this.tryParseJsonObject(raw);
            if (!parsed || typeof parsed !== 'object') {
                logger.warn("StateMachine", "状态提取失败：JSON 格式错误");
                return null;
            }

            // 如果返回空对象，说明没有状态变化
            if (Object.keys(parsed).length === 0) {
                logger.debug("StateMachine", "没有检测到状态变化");
                return null;
            }

            return parsed;
        } catch (e) {
            logger.error("StateMachine", "状态提取异常", e);
            return null;
        }
    }

    /**
     * 应用状态更新到快照
     */
    applyStateUpdates(
        snapshot: StateSnapshot,
        updates: Record<string, Partial<CharacterState>>
    ): StateUpdateResult {
        const changes: Array<{ field: string; oldValue: any; newValue: any }> = [];
        const updatedFields: string[] = [];

        for (const [characterId, stateUpdate] of Object.entries(updates)) {
            // 获取或创建角色状态
            if (!snapshot.characters[characterId]) {
                snapshot.characters[characterId] = {
                    characterId,
                    characterName: characterId,
                    lastUpdated: Date.now()
                };
            }

            const characterState = snapshot.characters[characterId];

            // 应用每个字段的更新
            for (const [field, newValue] of Object.entries(stateUpdate)) {
                if (field === 'inventoryChanges') {
                    // 特殊处理物品变化
                    const inventoryChanges = newValue as string[];
                    if (!characterState.inventory) {
                        characterState.inventory = [];
                    }

                    for (const change of inventoryChanges) {
                        if (change.startsWith('+')) {
                            const item = change.substring(1);
                            if (!characterState.inventory.includes(item)) {
                                characterState.inventory.push(item);
                                changes.push({
                                    field: `${characterId}.inventory`,
                                    oldValue: null,
                                    newValue: item
                                });
                            }
                        } else if (change.startsWith('-')) {
                            const item = change.substring(1);
                            const index = characterState.inventory.indexOf(item);
                            if (index > -1) {
                                characterState.inventory.splice(index, 1);
                                changes.push({
                                    field: `${characterId}.inventory`,
                                    oldValue: item,
                                    newValue: null
                                });
                            }
                        }
                    }
                    updatedFields.push(`${characterId}.inventory`);
                } else {
                    // 普通字段更新
                    const oldValue = (characterState as any)[field];
                    if (oldValue !== newValue) {
                        changes.push({
                            field: `${characterId}.${field}`,
                            oldValue,
                            newValue
                        });
                        (characterState as any)[field] = newValue;
                        updatedFields.push(`${characterId}.${field}`);
                    }
                }
            }

            characterState.lastUpdated = Date.now();
            characterState.updateReason = "对话状态提取";
        }

        snapshot.version = (snapshot.version || 0) + 1;
        snapshot.lastUpdated = Date.now();

        return {
            success: true,
            updatedFields,
            changes,
            snapshot
        };
    }

    /**
     * 更新状态（提取 + 应用 + 保存）
     */
    async updateState(
        messages: ChatMessage[],
        personaId: string,
        personaFolderName: string,
        config?: StateExtractionConfig
    ): Promise<StateUpdateResult | null> {
        // 1. 提取状态更新
        const updates = await this.extractStateUpdates(messages, personaId, config);
        if (!updates) {
            return null;
        }

        // 2. 加载现有状态
        let snapshot = await this.loadState(personaId, personaFolderName);
        if (!snapshot) {
            // 创建新快照
            snapshot = {
                personaId,
                characters: {},
                createdAt: Date.now(),
                lastUpdated: Date.now(),
                version: 0
            };
        }

        // 3. 应用更新
        const result = this.applyStateUpdates(snapshot, updates);

        // 4. 保存
        await this.saveState(result.snapshot, personaFolderName);

        logger.info("StateMachine", `状态已更新: ${result.updatedFields.length} 个字段变化`);
        return result;
    }

    /**
     * 将状态快照转换为自然语言（用于注入 Prompt）
     */
    stateToPromptText(snapshot: StateSnapshot | null): string {
        if (!snapshot || Object.keys(snapshot.characters).length === 0) {
            return "";
        }

        const lines: string[] = ["## 当前状态"];

        for (const [characterId, state] of Object.entries(snapshot.characters)) {
            const parts: string[] = [];
            
            if (state.currentLocation) parts.push(`位置: ${state.currentLocation}`);
            if (state.currentEmotion) parts.push(`情绪: ${state.currentEmotion}`);
            if (state.currentActivity) parts.push(`正在: ${state.currentActivity}`);
            if (state.attitudeToPlayer) parts.push(`对主角态度: ${state.attitudeToPlayer}`);
            if (state.affectionLevel !== undefined) parts.push(`好感度: ${state.affectionLevel}/100`);
            if (state.trustLevel !== undefined) parts.push(`信任度: ${state.trustLevel}/100`);
            if (state.inventory && state.inventory.length > 0) {
                parts.push(`持有物品: ${state.inventory.join('、')}`);
            }

            if (parts.length > 0) {
                lines.push(`- **${state.characterName}**: ${parts.join(' | ')}`);
            }
        }

        return lines.length > 1 ? lines.join('\n') : "";
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
