export type EscalationLevel = 'assistant' | 'specialist' | 'pm' | 'ceo';

export interface IntentResult {
    level: EscalationLevel;
    confidence: number;
    reasoning: string;
    assignedSpecialist?: 'researcher' | 'analyst' | 'writer' | 'coder' | 'executor';
}

export interface PlanStep {
    id: number;
    description: string;
    workerType: 'researcher' | 'analyst' | 'writer' | 'coder' | 'executor';
    status: 'pending' | 'running' | 'completed' | 'failed';
    result?: string;
    dependencies?: number[]; // IDs of steps that must be completed first
}

export interface ExecutionPlan {
    originalGoal: string;
    steps: PlanStep[];
}

export interface BlackboardMessage {
    agentName: string;
    mbti: string;
    content: string;
    timestamp: number;
}

export interface Blackboard {
    topic: string;
    messages: BlackboardMessage[];
}
