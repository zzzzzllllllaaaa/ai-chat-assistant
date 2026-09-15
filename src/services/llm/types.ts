export type { ReferenceItem, ChatMessage } from "../../core/types";
import type { ChatMessage } from "../../core/types";

export interface LLMConnectionConfig {
    id?: string;
    name?: string;
    baseUrl: string;
    apiKey?: string;
    /** Optional: test this specific model during connection test */
    testModel?: string;
}

export interface TestConnectionResult {
    ok: boolean;
    status?: number;
    message: string;
    durationMs: number;
    /** Detailed test results for each step */
    details?: {
        /** API connectivity test (GET /models) */
        connectivity?: { ok: boolean; message: string };
        /** API key validation */
        auth?: { ok: boolean; message: string };
        /** Model availability check */
        model?: { ok: boolean; message: string; availableModels?: string[] };
        /** Chat completion test (optional, with specific model) */
        chat?: { ok: boolean; message: string };
    };
}

export interface LLMProvider {
    id: string;
    name: string;
    getCompletion(messages: ChatMessage[], model: string, tools?: any[], onUpdate?: (content: string) => void, signal?: AbortSignal): Promise<ChatMessage>;
    getEmbedding(text: string, model: string): Promise<number[]>;
    /** Batch embedding for multiple texts in one API call - more efficient for indexing */
    getBatchEmbedding?(texts: string[], model: string): Promise<number[][]>;

    /** Optional: provider can validate baseUrl/apiKey without generating tokens. */
    testConnection?(connection: LLMConnectionConfig): Promise<TestConnectionResult>;
    /** Optional: provider can fetch a model list from upstream API. */
    listModels?(connection: LLMConnectionConfig): Promise<string[]>;
}
