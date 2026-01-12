import { v4 as uuidv4 } from 'uuid';
import { FirecrawlAdapter } from '../adapters/firecrawl.adapter.js';
import { SalesforceAdapter } from '../adapters/salesforce.adapter.js';
import { LinkedInAdapter } from '../adapters/linkedin.adapter.js';
import { CacheService, CacheStats } from './cache.service.js';
import {
  LiveCallBrief,
  BriefRequest,
  BriefResponse,
  PropertyScope,
  AdjacencyData,
  ParentNotes,
  ContactLinks,
  Article,
} from '../types/brief.js';
import { logger } from '../utils/logger.js';

// =============================================================================
// BRIEF BUILDER SERVICE
// Orchestrates all data sources to generate Live Call Briefs
// =============================================================================

export interface BriefBuilderConfig {
  firecrawlApiKey: string;
  salesforce: {
    loginUrl: string;
    username: string;
    password: string;
    securityToken: string;
  };
  redisUrl?: string;
  cacheTTLHours?: number;
  articleLookbackDays?: number;
}

export class BriefBuilderService {
  private firecrawl: FirecrawlAdapter;
  private salesforce: SalesforceAdapter;
  private linkedin: LinkedInAdapter;
  private cache: CacheService;
  private articleLookbackDays: number;

  constructor(config: BriefBuilderConfig) {
    this.firecrawl = new FirecrawlAdapter(config.firecrawlApiKey);
    this.salesforce = new SalesforceAdapter(config.salesforce);
    this.linkedin = new LinkedInAdapter();
    this.cache = new CacheService(config.redisUrl, config.cacheTTLHours || 24);
    this.articleLookbackDays = config.articleLookbackDays || 90;

    logger.info('BriefBuilderService initialized');
  }

  // ===========================================================================
  // INITIALIZATION
  // ===========================================================================

  async initialize(): Promise<void> {
    await Promise.all([
      this.cache.connect(),
      this.salesforce.connect(),
    ]);
    logger.info('BriefBuilderService connections established');
  }

  async shutdown(): Promise<void> {
    await Promise.all([
      this.cache.disconnect(),
      this.salesforce.disconnect(),
    ]);
    logger.info('BriefBuilderService connections closed');
  }

  // ===========================================================================
  // MAIN BRIEF GENERATION
  // ===========================================================================

  /**
   * Generate a Live Call Brief for a property
   * This is the main entry point used by the API
   */
  async generateBrief(request: BriefRequest): Promise<BriefResponse> {
    const startTime = Date.now();
    const { propertyName, propertyId, city, state, forceRefresh } = request;

    logger.info({ propertyName, city, state, forceRefresh }, 'Generating brief');

    try {
      // Check cache first (unless force refresh)
      if (!forceRefresh) {
        const cached = await this.cache.getBrief(propertyName, city, state);
        if (cached) {
          logger.info({ propertyName }, 'Returning cached brief');
          return {
            success: true,
            brief: cached,
            error: null,
            fromCache: true,
            generationTimeMs: Date.now() - startTime,
          };
        }
      }

      // Generate fresh brief by fetching all data in parallel
      const brief = await this.buildFreshBrief(propertyName, propertyId, city, state);
      const generationTimeMs = Date.now() - startTime;

      // Update generation time
      brief.generationTimeMs = generationTimeMs;

      // Cache the result
      await this.cache.setBrief(brief, propertyName, city, state);

      logger.info({ propertyName, generationTimeMs }, 'Brief generated successfully');

      return {
        success: true,
        brief,
        error: null,
        fromCache: false,
        generationTimeMs,
      };
    } catch (error) {
      logger.error({ error, propertyName }, 'Failed to generate brief');

      return {
        success: false,
        brief: null,
        error: error instanceof Error ? error.message : 'Unknown error',
        fromCache: false,
        generationTimeMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Build a fresh brief by fetching all data sources in parallel
   */
  private async buildFreshBrief(
    propertyName: string,
    propertyId?: string,
    city?: string,
    state?: string
  ): Promise<LiveCallBrief> {
    logger.debug({ propertyName }, 'Building fresh brief');

    // Fetch all data sources in parallel for speed
    const [propertyScope, parentNotes, recentArticles] = await Promise.all([
      this.fetchPropertyScope(propertyName, city, state),
      this.fetchParentNotes(propertyName, propertyId),
      this.fetchRecentArticles(propertyName, city),
    ]);

    // Get adjacency data (depends on property location)
    const effectiveCity = city || propertyScope?.city || undefined;
    const effectiveState = state || propertyScope?.state || undefined;

    const adjacencyData = await this.fetchAdjacencyData(
      effectiveCity,
      effectiveState,
      undefined, // TODO: Get brand from Salesforce
      undefined  // TODO: Get management company from Salesforce
    );

    // Generate LinkedIn search links
    const contactLinks = this.linkedin.generateContactLinks(propertyName, effectiveCity);

    // Calculate data quality
    const dataQuality = this.calculateDataQuality(
      propertyScope,
      adjacencyData,
      parentNotes,
      contactLinks,
      recentArticles
    );

    // Assemble the brief
    const brief: LiveCallBrief = {
      id: uuidv4(),
      propertyId: propertyId || null,
      propertyName,
      propertyScope,
      adjacencyData,
      parentNotes,
      contactLinks,
      recentArticles,
      generatedAt: new Date(),
      cachedAt: null,
      cacheExpiresAt: null,
      generationTimeMs: 0, // Will be set by caller
      dataQuality,
    };

    return brief;
  }

  // ===========================================================================
  // DATA FETCHING METHODS
  // ===========================================================================

  private async fetchPropertyScope(
    propertyName: string,
    city?: string,
    state?: string
  ): Promise<PropertyScope | null> {
    try {
      return await this.firecrawl.scrapePropertyScope(propertyName, city, state);
    } catch (error) {
      logger.warn({ error, propertyName }, 'Failed to fetch property scope');
      return null;
    }
  }

  private async fetchParentNotes(
    propertyName: string,
    propertyId?: string
  ): Promise<ParentNotes | null> {
    try {
      if (propertyId) {
        return await this.salesforce.getParentNotes(propertyId);
      }
      return await this.salesforce.getParentNotesByPropertyName(propertyName);
    } catch (error) {
      logger.warn({ error, propertyName }, 'Failed to fetch parent notes');
      return null;
    }
  }

  private async fetchAdjacencyData(
    city?: string,
    state?: string,
    brandAffiliation?: string,
    managementCompany?: string
  ): Promise<AdjacencyData | null> {
    try {
      if (!city) {
        return null;
      }
      return await this.salesforce.getAdjacencyData(
        city,
        state,
        brandAffiliation,
        managementCompany
      );
    } catch (error) {
      logger.warn({ error, city }, 'Failed to fetch adjacency data');
      return null;
    }
  }

  private async fetchRecentArticles(
    propertyName: string,
    city?: string
  ): Promise<Article[]> {
    try {
      return await this.firecrawl.scrapeRecentArticles(
        propertyName,
        city,
        this.articleLookbackDays
      );
    } catch (error) {
      logger.warn({ error, propertyName }, 'Failed to fetch recent articles');
      return [];
    }
  }

  // ===========================================================================
  // DATA QUALITY CALCULATION
  // ===========================================================================

  private calculateDataQuality(
    propertyScope: PropertyScope | null,
    adjacencyData: AdjacencyData | null,
    parentNotes: ParentNotes | null,
    contactLinks: ContactLinks | null,
    recentArticles: Article[]
  ): LiveCallBrief['dataQuality'] {
    const hasPropertyScope = !!propertyScope;
    const hasLocalCompetitors = (adjacencyData?.localCompetitors?.length || 0) > 0;
    const hasAdjacencyCustomers = (adjacencyData?.adjacencyCustomers?.length || 0) > 0;
    const hasParentNotes = !!parentNotes?.sellingNotes;
    const hasContactLinks = !!contactLinks;
    const hasRecentArticles = recentArticles.length > 0;

    // Calculate completeness score (0-100)
    const weights = {
      propertyScope: 30,
      localCompetitors: 20,
      adjacencyCustomers: 15,
      parentNotes: 15,
      contactLinks: 10,
      recentArticles: 10,
    };

    const completenessScore =
      (hasPropertyScope ? weights.propertyScope : 0) +
      (hasLocalCompetitors ? weights.localCompetitors : 0) +
      (hasAdjacencyCustomers ? weights.adjacencyCustomers : 0) +
      (hasParentNotes ? weights.parentNotes : 0) +
      (hasContactLinks ? weights.contactLinks : 0) +
      (hasRecentArticles ? weights.recentArticles : 0);

    return {
      hasPropertyScope,
      hasLocalCompetitors,
      hasAdjacencyCustomers,
      hasParentNotes,
      hasContactLinks,
      hasRecentArticles,
      completenessScore,
    };
  }

  // ===========================================================================
  // BATCH OPERATIONS (for nightly cache jobs)
  // ===========================================================================

  /**
   * Pre-generate briefs for a list of properties (used by batch job)
   */
  async batchGenerateBriefs(
    properties: Array<{ name: string; id?: string; city?: string; state?: string }>
  ): Promise<BatchResult> {
    logger.info({ count: properties.length }, 'Starting batch brief generation');

    const results: BatchResult = {
      total: properties.length,
      success: 0,
      failed: 0,
      errors: [],
    };

    for (const property of properties) {
      try {
        const response = await this.generateBrief({
          propertyName: property.name,
          propertyId: property.id,
          city: property.city,
          state: property.state,
          forceRefresh: true, // Always refresh in batch
        });

        if (response.success) {
          results.success++;
        } else {
          results.failed++;
          results.errors.push({
            propertyName: property.name,
            error: response.error || 'Unknown error',
          });
        }
      } catch (error) {
        results.failed++;
        results.errors.push({
          propertyName: property.name,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }

      // Small delay between batch items to avoid rate limits
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    logger.info(results, 'Batch brief generation complete');
    return results;
  }

  // ===========================================================================
  // CACHE MANAGEMENT
  // ===========================================================================

  async getCacheStats() {
    return this.cache.getStats();
  }

  async invalidateCache(propertyName: string, city?: string, state?: string) {
    return this.cache.invalidateBrief(propertyName, city, state);
  }

  async clearAllCache() {
    return this.cache.clearAllBriefs();
  }
}

interface BatchResult {
  total: number;
  success: number;
  failed: number;
  errors: Array<{ propertyName: string; error: string }>;
}
