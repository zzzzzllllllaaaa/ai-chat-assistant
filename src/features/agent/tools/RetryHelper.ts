/**
 * 重试辅助工具
 * 支持指数退避、User-Agent 轮换、自定义重试条件
 */

import { logger } from "../../../core/logger";

export interface RetryOptions {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  retryableErrors?: string[]; // 可重试的错误关键词
}

export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
  retryableErrors: ['timeout', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'network', '429', '503', '502']
};

export class RetryHelper {
  private static userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Edg/119.0.0.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15'
  ];

  /**
   * 获取随机 User-Agent
   */
  static getRandomUserAgent(): string {
    return this.userAgents[Math.floor(Math.random() * this.userAgents.length)];
  }

  /**
   * 判断错误是否可重试
   */
  static isRetryableError(error: any, retryableErrors: string[]): boolean {
    const errorMessage = error?.message?.toLowerCase() || '';
    const errorString = String(error).toLowerCase();
    
    return retryableErrors.some(keyword => 
      errorMessage.includes(keyword.toLowerCase()) || 
      errorString.includes(keyword.toLowerCase())
    );
  }

  /**
   * 计算延迟时间（指数退避）
   */
  static calculateDelay(attempt: number, options: RetryOptions): number {
    const delay = options.initialDelayMs * Math.pow(options.backoffMultiplier, attempt);
    return Math.min(delay, options.maxDelayMs);
  }

  /**
   * 延迟执行
   */
  static async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 带重试的异步函数执行
   */
  static async withRetry<T>(
    fn: () => Promise<T>,
    options: Partial<RetryOptions> = {},
    context: string = 'operation'
  ): Promise<T> {
    const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
    let lastError: any;

    for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          const delay = this.calculateDelay(attempt - 1, opts);
          logger.info("Network", `${context} 重试 ${attempt}/${opts.maxRetries}，等待 ${delay}ms`, { attempt, delay });
          await this.sleep(delay);
        }

        const result = await fn();
        
        if (attempt > 0) {
          logger.info("Network", `${context} 重试成功`, { attempt });
        }
        
        return result;
      } catch (error: any) {
        lastError = error;
        
        // 最后一次尝试失败
        if (attempt === opts.maxRetries) {
          logger.error("Network", `${context} 重试 ${opts.maxRetries} 次后仍然失败`, { 
            error: error.message,
            attempts: attempt + 1 
          });
          break;
        }

        // 检查是否可重试
        if (!this.isRetryableError(error, opts.retryableErrors || [])) {
          logger.warn("Network", `${context} 遇到不可重试的错误`, { error: error.message });
          throw error;
        }

        logger.warn("Network", `${context} 失败，准备重试`, { 
          attempt: attempt + 1,
          error: error.message,
          retryable: true
        });
      }
    }

    throw lastError;
  }
}
