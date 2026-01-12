import { Router, Request, Response } from 'express';
import { BriefBuilderService } from '../services/brief-builder.service.js';
import { BriefRequestSchema } from '../types/brief.js';
import { logger } from '../utils/logger.js';

// =============================================================================
// API ROUTES
// RESTful API for Brief Builder Service
// =============================================================================

export function createRoutes(briefBuilder: BriefBuilderService): Router {
  const router = Router();

  // ===========================================================================
  // HEALTH CHECK
  // ===========================================================================

  router.get('/health', async (_req: Request, res: Response) => {
    try {
      const cacheStats = await briefBuilder.getCacheStats();
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        cache: cacheStats,
      });
    } catch (error) {
      res.status(500).json({
        status: 'unhealthy',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // ===========================================================================
  // BRIEF GENERATION
  // ===========================================================================

  /**
   * POST /api/brief
   * Generate a Live Call Brief for a property
   *
   * Request body:
   * {
   *   "propertyName": "Marriott Downtown",
   *   "propertyId": "001xxx" (optional),
   *   "city": "San Francisco" (optional),
   *   "state": "CA" (optional),
   *   "forceRefresh": false (optional)
   * }
   */
  router.post('/brief', async (req: Request, res: Response) => {
    try {
      // Validate request body
      const parseResult = BriefRequestSchema.safeParse(req.body);

      if (!parseResult.success) {
        return res.status(400).json({
          success: false,
          error: 'Invalid request',
          details: parseResult.error.issues,
        });
      }

      const request = parseResult.data;
      logger.info({ request }, 'Brief request received');

      // Generate brief
      const response = await briefBuilder.generateBrief(request);

      if (response.success) {
        return res.json(response);
      } else {
        return res.status(500).json(response);
      }
    } catch (error) {
      logger.error({ error }, 'Error in POST /brief');
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * GET /api/brief/:propertyName
   * Get a cached brief or generate on-demand
   *
   * Query params:
   * - city: string (optional)
   * - state: string (optional)
   * - refresh: boolean (optional)
   */
  router.get('/brief/:propertyName', async (req: Request, res: Response) => {
    try {
      const { propertyName } = req.params;
      const { city, state, refresh } = req.query;

      const request = {
        propertyName: decodeURIComponent(propertyName),
        city: city as string | undefined,
        state: state as string | undefined,
        forceRefresh: refresh === 'true',
      };

      logger.info({ request }, 'Brief GET request received');

      const response = await briefBuilder.generateBrief(request);

      if (response.success) {
        return res.json(response);
      } else {
        return res.status(500).json(response);
      }
    } catch (error) {
      logger.error({ error }, 'Error in GET /brief/:propertyName');
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // ===========================================================================
  // BATCH OPERATIONS
  // ===========================================================================

  /**
   * POST /api/batch/briefs
   * Generate briefs for multiple properties (used by batch job)
   *
   * Request body:
   * {
   *   "properties": [
   *     { "name": "Hotel A", "city": "NYC", "state": "NY" },
   *     { "name": "Hotel B", "city": "LA", "state": "CA" }
   *   ]
   * }
   */
  router.post('/batch/briefs', async (req: Request, res: Response) => {
    try {
      const { properties } = req.body;

      if (!Array.isArray(properties) || properties.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'properties array is required',
        });
      }

      // Limit batch size
      if (properties.length > 100) {
        return res.status(400).json({
          success: false,
          error: 'Maximum batch size is 100 properties',
        });
      }

      logger.info({ count: properties.length }, 'Batch brief request received');

      const result = await briefBuilder.batchGenerateBriefs(properties);

      return res.json({
        success: true,
        result,
      });
    } catch (error) {
      logger.error({ error }, 'Error in POST /batch/briefs');
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // ===========================================================================
  // CACHE MANAGEMENT
  // ===========================================================================

  /**
   * GET /api/cache/stats
   * Get cache statistics
   */
  router.get('/cache/stats', async (_req: Request, res: Response) => {
    try {
      const stats = await briefBuilder.getCacheStats();
      return res.json({ success: true, stats });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * DELETE /api/cache/:propertyName
   * Invalidate cache for a specific property
   */
  router.delete('/cache/:propertyName', async (req: Request, res: Response) => {
    try {
      const { propertyName } = req.params;
      const { city, state } = req.query;

      await briefBuilder.invalidateCache(
        decodeURIComponent(propertyName),
        city as string | undefined,
        state as string | undefined
      );

      return res.json({ success: true, message: 'Cache invalidated' });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * DELETE /api/cache
   * Clear all cached briefs
   */
  router.delete('/cache', async (_req: Request, res: Response) => {
    try {
      const count = await briefBuilder.clearAllCache();
      return res.json({ success: true, clearedCount: count });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  return router;
}
