import { Notice } from "obsidian";
import { redactForLog, redactString } from "../utils/redact";

export enum LogLevel {
    INFO = "INFO",
    WARN = "WARN",
    ERROR = "ERROR",
    DEBUG = "DEBUG"
}

export type LogCategory = 'System' | 'Network' | 'AI' | 'Database' | 'UI' | 'Reflection' | 'Skills' | 'OpenClaw' | 'GraphRAG' | 'StateMachine' | 'PersonalityEvolution' | 'OOC' | 'Narrative' | 'EmotionCoherence' | 'SceneAwareness' | 'Immersion';

export interface LogEntry {
    id: string;
    timestamp: Date;
    level: LogLevel;
    category: LogCategory;
    message: string;
    details?: string; // More detailed technical info
    context?: any;
}

type LogListener = (entry: LogEntry) => void;

export class Logger {
    private static instance: Logger;
    private logs: LogEntry[] = [];
    private maxLogs: number = 1000;
    private listeners: LogListener[] = [];

    private constructor() {}

    public static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }

    public addListener(listener: LogListener) {
        this.listeners.push(listener);
    }

    public removeListener(listener: LogListener) {
        this.listeners = this.listeners.filter(l => l !== listener);
    }

    private notifyListeners(entry: LogEntry) {
        this.listeners.forEach(l => l(entry));
    }

    public log(level: LogLevel, category: LogCategory, message: string, context?: any, details?: string) {
        const safeMessage = redactString(String(message || ""));
        const safeDetails = typeof details === "string" ? redactString(details) : details;
        const safeContext = context !== undefined ? redactForLog(context) : context;
        const entry: LogEntry = {
            id: Math.random().toString(36).substring(2, 9),
            timestamp: new Date(),
            level,
            category,
            message: safeMessage,
            details: safeDetails,
            context: safeContext
        };
        this.logs.push(entry);
        if (this.logs.length > this.maxLogs) {
            this.logs.shift();
        }
        
        this.notifyListeners(entry);
        
        // Console fallback
        const consoleMsg = `[AiChat] [${category}] ${safeMessage}`;
        if (level === LogLevel.ERROR) {
            console.error(consoleMsg, safeContext);
        } else if (level === LogLevel.WARN) {
            console.warn(consoleMsg, safeContext);
        } else {
            console.log(consoleMsg, safeContext);
        }
    }

    public info(category: LogCategory, message: string, context?: any) {
        this.log(LogLevel.INFO, category, message, context);
    }

    public warn(category: LogCategory, message: string, context?: any) {
        this.log(LogLevel.WARN, category, message, context);
    }

    public error(category: LogCategory, message: string, context?: any) {
        this.log(LogLevel.ERROR, category, message, context);
    }

    public debug(category: LogCategory, message: string, context?: any) {
        this.log(LogLevel.DEBUG, category, message, context);
    }

    public getLogs(): LogEntry[] {
        return [...this.logs];
    }

    public clearLogs() {
        this.logs = [];
        // Notify clear? Maybe just let view handle it via refresh or specific event
        // For simplicity, we can emit a special 'clear' event or just let view re-render
    }
}

export const logger = Logger.getInstance();
