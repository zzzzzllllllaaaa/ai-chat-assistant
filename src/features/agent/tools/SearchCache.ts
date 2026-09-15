/**
 * 搜索结果缓存管理器
 * 使用 LRU 策略,支持可配置的缓存时间和容量
 */

interface CacheEntry {
  result: string;
  timestamp: number;
  query: string;
  provider: string;
}

export class SearchCache {
  private cache: Map<string, CacheEntry>;
  private maxSize: number;
  private ttlMs: number; // Time to live in milliseconds

  constructor(maxSize: number = 100, ttlMinutes: number = 60) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.ttlMs = ttlMinutes * 60 * 1000;
  }

  /**
   * 生成缓存键
   */
  private generateKey(query: string, count: number, timeRange: string, provider: string): string {
    return `${provider}:${query}:${count}:${timeRange}`.toLowerCase();
  }

  /**
   * 获取缓存结果
   */
  get(query: string, count: number, timeRange: string, provider: string): string | null {
    const key = this.generateKey(query, count, timeRange, provider);
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    // 检查是否过期
    const now = Date.now();
    if (now - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }

    // LRU: 重新插入到末尾
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.result;
  }

  /**
   * 设置缓存结果
   */
  set(query: string, count: number, timeRange: string, provider: string, result: string): void {
    const key = this.generateKey(query, count, timeRange, provider);

    // 如果缓存已满,删除最旧的条目 (Map 的第一个元素)
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }

    const entry: CacheEntry = {
      result,
      timestamp: Date.now(),
      query,
      provider
    };

    this.cache.set(key, entry);
  }

  /**
   * 清空缓存
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * 获取缓存统计信息
   */
  getStats(): { size: number; maxSize: number; ttlMinutes: number } {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      ttlMinutes: this.ttlMs / (60 * 1000)
    };
  }

  /**
   * 清理过期条目
   */
  cleanExpired(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttlMs) {
        this.cache.delete(key);
        cleaned++;
      }
    }

    return cleaned;
  }
}
