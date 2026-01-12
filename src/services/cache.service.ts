import { createClient, RedisClientType } from 'redis';
import { LiveCallBrief } from '../types/brief.js';
import { logger } from '../utils/logger.js';

// =============================================================================
// CACHE SERVICE
// Redis-based caching for Live Call Briefs
// =============================================================================

export class CacheService {
  private client: RedisClientType | null = null;
  private defaultTTLHours: number;
  private keyPrefix = 'brief:';

  constructor(redisUrl?: string, ttlHours: number = 24) {
    this.defaultTTLHours = ttlHours;
    if (redisUrl) {
      this.client = createClient({ url: redisUrl });
      this.client.on('error', (err) => logger.error({ err }, 'Redis Client Error'));
    }
    logger.info({ ttlHours, hasRedis: !!redisUrl }, 'CacheService initialized');
  }

  async connect(): Promise<void> {
    if (this.client && !this.client.isOpen) {
      await this.client.connect();
      logger.info('Connected to Redis');
    }
  }

  async disconnect(): Promise<void> {
    if (this.client && this.client.isOpen) {
      await this.client.quit();
      logger.info('Disconnected from Redis');
    }
  }

  // ===========================================================================
  // BRIEF CACHING
  // ===========================================================================

  /**
   * Generate cache key for a brief
   */
  private generateKey(propertyName: string, city?: string, state?: string): string {
    const parts = [propertyName, city || '', state || ''].map((p) =>
      p.toLowerCase().replace(/\s+/g, '_')
    );
    return `${this.keyPrefix}${parts.join(':')}`;
  }

  /**
   * Get cached brief
   */
  async getBrief(
    propertyName: string,
    city?: string,
    state?: string
  ): Promise<LiveCallBrief | null> {
    if (!this.client || !this.client.isOpen) {
      logger.debug('Cache not available, returning null');
      return null;
    }

    const key = this.generateKey(propertyName, city, state);

    try {
      const cached = await this.client.get(key);

      if (!cached) {
        logger.debug({ key }, 'Cache miss');
        return null;
      }

      const brief = JSON.parse(cached) as LiveCallBrief;

      // Parse dates back from JSON
      brief.generatedAt = new Date(brief.generatedAt);
      if (brief.cachedAt) brief.cachedAt = new Date(brief.cachedAt);
      if (brief.cacheExpiresAt) brief.cacheExpiresAt = new Date(brief.cacheExpiresAt);

      logger.debug({ key }, 'Cache hit');
      return brief;
    } catch (error) {
      logger.error({ error, key }, 'Error reading from cache');
      return null;
    }
  }

  /**
   * Cache a brief
   */
  async setBrief(
    brief: LiveCallBrief,
    propertyName: string,
    city?: string,
    state?: string,
    ttlHours?: number
  ): Promise<void> {
    if (!this.client || !this.client.isOpen) {
      logger.debug('Cache not available, skipping set');
      return;
    }

    const key = this.generateKey(propertyName, city, state);
    const ttl = (ttlHours || this.defaultTTLHours) * 3600; // Convert to seconds

    try {
      // Add cache metadata
      const cachedBrief: LiveCallBrief = {
        ...brief,
        cachedAt: new Date(),
        cacheExpiresAt: new Date(Date.now() + ttl * 1000),
      };

      await this.client.setEx(key, ttl, JSON.stringify(cachedBrief));
      logger.debug({ key, ttl }, 'Brief cached');
    } catch (error) {
      logger.error({ error, key }, 'Error writing to cache');
    }
  }

  /**
   * Invalidate cached brief
   */
  async invalidateBrief(propertyName: string, city?: string, state?: string): Promise<void> {
    if (!this.client || !this.client.isOpen) {
      return;
    }

    const key = this.generateKey(propertyName, city, state);

    try {
      await this.client.del(key);
      logger.debug({ key }, 'Cache invalidated');
    } catch (error) {
      logger.error({ error, key }, 'Error invalidating cache');
    }
  }

  // ===========================================================================
  // BULK OPERATIONS (for batch jobs)
  // ===========================================================================

  /**
   * Get all cached brief keys
   */
  async getAllBriefKeys(): Promise<string[]> {
    if (!this.client || !this.client.isOpen) {
      return [];
    }

    try {
      const keys = await this.client.keys(`${this.keyPrefix}*`);
      return keys;
    } catch (error) {
      logger.error({ error }, 'Error getting cached keys');
      return [];
    }
  }

  /**
   * Get cache stats
   */
  async getStats(): Promise<CacheStats> {
    if (!this.client || !this.client.isOpen) {
      return {
        connected: false,
        totalKeys: 0,
        briefKeys: 0,
      };
    }

    try {
      const info = await this.client.info('keyspace');
      const briefKeys = await this.client.keys(`${this.keyPrefix}*`);

      return {
        connected: true,
        totalKeys: briefKeys.length,
        briefKeys: briefKeys.length,
        info,
      };
    } catch (error) {
      logger.error({ error }, 'Error getting cache stats');
      return {
        connected: false,
        totalKeys: 0,
        briefKeys: 0,
      };
    }
  }

  /**
   * Clear all brief cache
   */
  async clearAllBriefs(): Promise<number> {
    if (!this.client || !this.client.isOpen) {
      return 0;
    }

    try {
      const keys = await this.client.keys(`${this.keyPrefix}*`);
      if (keys.length > 0) {
        await this.client.del(keys);
      }
      logger.info({ count: keys.length }, 'Cleared all cached briefs');
      return keys.length;
    } catch (error) {
      logger.error({ error }, 'Error clearing cache');
      return 0;
    }
  }
}

export interface CacheStats {
  connected: boolean;
  totalKeys: number;
  briefKeys: number;
  info?: string;
}
