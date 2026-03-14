import { Document } from '@/lib/api/types';
import { redisService } from './redis-service';

interface SearchResult {
  documentId: string;
  title: string;
  content: string;
  score: number;
  pageNumbers: number[];
  documentSection?: string;
 confidenceScore?: number;
  snippet: string;
 document: Document;
  visualContent?: string; // Base64 encoded visual content
  extractedText?: string; // Extracted text content
  screenshots?: string[]; // Array of screenshot base64 strings
}

interface SearchResults {
  results: SearchResult[];
  total: number;
 query: string;
 processingTime: number;
}

// Cache configuration - TTL in seconds for Redis
const DEFAULT_CACHE_TTL = 30 * 60; // 30 minutes in seconds
const MAX_CACHE_SIZE = 50; // Maximum number of cached search results

// Interface for cache metrics
interface CacheMetrics {
  hits: number;
  misses: number;
 totalRequests: number;
  averageResponseTime: number;
  hitRate: number;
}

interface CachedSearchResult {
  query: string;
  unitId?: string;
  category?: string;
  filters?: any;
  results: SearchResults;
  timestamp: number;
  ttl: number;
}

class SearchCacheService {
  private readonly maxCacheSize: number;
  private metrics: CacheMetrics = {
    hits: 0,
    misses: 0,
    totalRequests: 0,
    averageResponseTime: 0,
    hitRate: 0
  };

  constructor(maxSize: number = MAX_CACHE_SIZE) {
    this.maxCacheSize = maxSize;
  }

 /**
   * Generate a cache key based on search parameters
   */
  private generateCacheKey(query: string, unitId?: string, category?: string, filters?: any): string {
    // Ensure query is a string and handle null/undefined
    const safeQuery = (query || '').toLowerCase().trim();
    // Convert "undefined" string to proper undefined/null for consistent cache keys
    const safeUnitId = (unitId === 'undefined' || unitId === undefined || unitId === null) ? 'all' : unitId;
    const safeCategory = (category === 'undefined' || category === undefined || category === null) ? 'all' : category;
    // Ensure filters is a valid object and stringify it safely
    let filtersString = '{}';
    try {
      // Convert "undefined" string to empty object for consistent cache keys
      const safeFilters = (filters === 'undefined' || filters === undefined || filters === null) ? {} : filters;
      filtersString = JSON.stringify(safeFilters);
    } catch (error) {
      console.error('Error stringifying filters for cache key:', error);
      filtersString = '{}'; // Fallback to empty object
    }
    
    const params = [safeQuery, safeUnitId, safeCategory, filtersString];
    // Create a hash-based cache key to avoid special character issues
    const keyString = params.join('|');
    
    // Create a simple hash function to generate a consistent key
    let hash = 0;
    for (let i = 0; i < keyString.length; i++) {
      const char = keyString.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    
    // Create a readable key with the hash to ensure uniqueness
    const readablePrefix = safeQuery.substring(0, 20).replace(/[^a-zA-Z0-9]/g, '_');
    return `search:${readablePrefix}_${Math.abs(hash).toString(36)}`;
  }

  /**
   * Check if a cached result exists and is still valid
   */
 async getCachedResult(query: string, unitId?: string, category?: string, filters?: any): Promise<SearchResults | null> {
    this.metrics.totalRequests++;
    // Normalize parameters to handle "undefined" strings consistently
    const normalizedUnitId = (unitId === 'undefined') ? undefined : unitId;
    const normalizedCategory = (category === 'undefined') ? undefined : category;
    const normalizedFilters = (filters === 'undefined') ? undefined : filters;
    const cacheKey = this.generateCacheKey(query, normalizedUnitId, normalizedCategory, normalizedFilters);
    
    const cachedResult = await redisService.get<CachedSearchResult>(cacheKey);

    if (!cachedResult) {
      this.metrics.misses++;
      this.updateHitRate();
      return null;
    }

    // Check if cache is expired (note: Redis handles TTL automatically, but we still check timestamp for consistency)
    if (Date.now() - cachedResult.timestamp > cachedResult.ttl) {
      await redisService.del(cacheKey);
      this.metrics.misses++;
      this.updateHitRate();
      return null;
    }

    this.metrics.hits++;
    this.updateHitRate();
    return cachedResult.results;
  }

  /**
   * Store search results in cache
   */
 async setCachedResult(
    query: string,
    results: SearchResults,
    unitId?: string,
    category?: string,
    filters?: any,
    ttl: number = DEFAULT_CACHE_TTL
 ): Promise<void> {
    // Normalize parameters to handle "undefined" strings consistently
    const normalizedUnitId = (unitId === 'undefined') ? undefined : unitId;
    const normalizedCategory = (category === 'undefined') ? undefined : category;
    const normalizedFilters = (filters === 'undefined') ? undefined : filters;
    const cacheKey = this.generateCacheKey(query, normalizedUnitId, normalizedCategory, normalizedFilters);

    const cachedResult: CachedSearchResult = {
      query,
      unitId: normalizedUnitId,
      category: normalizedCategory,
      filters: normalizedFilters,
      results,
      timestamp: Date.now(),
      ttl: ttl * 1000 // Convert to milliseconds for timestamp comparison
    };

    // Store in Redis with TTL
    await redisService.set(cacheKey, cachedResult, ttl);
  }

  /**
   * Remove a specific cached result
   */
 async removeCachedResult(query: string, unitId?: string, category?: string, filters?: any): Promise<void> {
    // Normalize parameters to handle "undefined" strings consistently
    const normalizedUnitId = (unitId === 'undefined') ? undefined : unitId;
    const normalizedCategory = (category === 'undefined') ? undefined : category;
    const normalizedFilters = (filters === 'undefined') ? undefined : filters;
    const cacheKey = this.generateCacheKey(query, normalizedUnitId, normalizedCategory, normalizedFilters);
    await redisService.del(cacheKey);
  }

  /**
   * Clear all cached search results
   */
  async clearCache(): Promise<void> {
    const keys = await redisService.keys('search:*');
    if (keys.length > 0) {
      await redisService.redis.del(keys as any);
    }
 }

  /**
   * Invalidate cache entries that might be affected by document changes
   */
  async invalidateCacheForDocument(documentId: string): Promise<void> {
    // This is more complex with Redis - we'd need to maintain a reverse mapping
    // For now, we'll clear all search cache when a document is updated
    await this.clearCache();
  }

 /**
   * Invalidate cache entries that match a specific query pattern
   */
  async invalidateCacheByQuery(queryPattern: string): Promise<void> {
    const pattern = `*${queryPattern.toLowerCase()}*`;
    const keys = await redisService.keys(pattern);
    if (keys.length > 0) {
      await redisService.redis.del(keys as any);
    }
 }

  /**
   * Invalidate cache entries by unit ID
   */
  async invalidateCacheByUnit(unitId: string): Promise<void> {
    // For a more sophisticated implementation, you'd need to maintain tags for cache invalidation
    // For now, we'll clear all search cache when a unit is updated
    await this.clearCache();
 }

  /**
   * Invalidate cache entries by category
   */
  async invalidateCacheByCategory(category: string): Promise<void> {
    // For a more sophisticated implementation, you'd need to maintain tags for cache invalidation
    // For now, we'll clear all search cache when a category is updated
    await this.clearCache();
  }

  /**
   * Get cache statistics
   */
  async getCacheStats(): Promise<{ size: number; keys: string[] }> {
    const keys = await redisService.keys('search:*');
    return {
      size: keys.length,
      keys
    };
  }

 /**
   * Pre-warm the cache with frequently searched queries
   */
  async prewarmCache(queries: { query: string; results: SearchResults; unitId?: string; category?: string; filters?: any }[]): Promise<void> {
    for (const { query, results, unitId, category, filters } of queries) {
      // Normalize parameters to handle "undefined" strings consistently
      const normalizedUnitId = (unitId === 'undefined') ? undefined : unitId;
      const normalizedCategory = (category === 'undefined') ? undefined : category;
      const normalizedFilters = (filters === 'undefined') ? undefined : filters;
      await this.setCachedResult(query, results, normalizedUnitId, normalizedCategory, normalizedFilters);
    }
  }

  /**
   * Get the most frequently searched queries from cache usage
   */
  getFrequentQueries(limit: number = 10): string[] {
    // This would normally track usage statistics over time
    // For now, we'll return an empty array - in a real implementation,
    // you'd track query usage and return the most frequent ones
    return [];
  }

  /**
   * Update the cache hit rate metric
   */
  private updateHitRate(): void {
    if (this.metrics.totalRequests > 0) {
      this.metrics.hitRate = this.metrics.hits / this.metrics.totalRequests;
    }
  }

  /**
   * Get cache metrics
   */
  getCacheMetrics(): CacheMetrics {
    return { ...this.metrics };
  }

  /**
   * Reset cache metrics
   */
  resetMetrics(): void {
    this.metrics = {
      hits: 0,
      misses: 0,
      totalRequests: 0,
      averageResponseTime: 0,
      hitRate: 0
    };
  }
}

// Export a singleton instance
export const searchCacheService = new SearchCacheService();
export { SearchCacheService };