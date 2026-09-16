/**
 * Plugin Context — 依赖注入容器接口
 * 替代直接 import main.ts
 */
import type { App, PluginManifest } from "obsidian";
import type { AiChatAssistantSettings } from "./settings-types";
import type { AgentManager } from "../features/agent/manager";
import type { LLMService } from "../services/llm/LLMService";
import type { RAGService } from "../services/rag/RAGService";
import type { SkillRegistry } from "../features/skills/SkillRegistry";
import type { MemoryManager } from "../features/memory/MemoryManager";
import type { CollaborationManager } from "../features/collaboration/CollaborationManager";
import type { WorldStateManager } from "../features/world/WorldStateManager";
import type { ToolRegistry } from "../mcp/ToolRegistry";
import type { VectorIndexManager } from "../services/vector/VectorIndexManager";
import type { SearchPlanner } from "../features/agent/SearchPlanner";
import type { ToolRouter } from "../features/agent/ToolRouter";
import type { PermissionManager } from "../features/agent/PermissionManager";
import type { ExecutionVerifier } from "../features/agent/ExecutionVerifier";
import type { Conversation, ChatMessage } from "./types";

export interface IPluginContext {
  readonly app: App;
  readonly manifest: PluginManifest;
  readonly settings: AiChatAssistantSettings;
  saveSettings(): Promise<void>;
  
  // Core services
  llmService: LLMService;
  ragService: RAGService;
  agentManager: AgentManager;
  skillRegistry: SkillRegistry;
  memoryManager: MemoryManager;
  collaborationManager: CollaborationManager;
  worldStateManager: WorldStateManager;
  toolRegistry: ToolRegistry;
  vectorIndexManager: VectorIndexManager;
  
  // Agent services
  searchPlanner: SearchPlanner;
  toolRouterAgent: ToolRouter;
  permissionManager: PermissionManager;
  executionVerifier: ExecutionVerifier;
  
  // Conversation
  getConversations(): Record<string, Conversation>;
  getLatestConversationTail(limit: number): Promise<{ conversation: Conversation; history: ChatMessage[] } | null>;
  
  // Obsidian helpers
  getConfigDir(): string;
  registerInterval(id: number): number;
}
