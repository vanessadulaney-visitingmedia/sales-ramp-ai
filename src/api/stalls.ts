import { Router, Request, Response } from 'express';
import { StallDetectorService } from '../services/stall-detector.service.js';
import { AlertService } from '../services/alert.service.js';
import {
  CallTranscriptSchema,
  EmailContentSchema,
  GetStalledDealsRequestSchema,
  ManagerDashboardRequestSchema,
  AcknowledgeAlertRequestSchema,
  DealStage,
} from '../types/stall.js';
import { logger } from '../utils/logger.js';

// =============================================================================
// STALL DETECTION API ROUTES
// RESTful API for Stall Detection System
// =============================================================================

export function createStallRoutes(
  stallDetector: StallDetectorService,
  alertService: AlertService
): Router {
  const router = Router();

  // ===========================================================================
  // HEALTH CHECK
  // ===========================================================================

  router.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'healthy',
      service: 'stall-detection',
      timestamp: new Date().toISOString(),
    });
  });

  // ===========================================================================
  // TRANSCRIPT ANALYSIS
  // ===========================================================================

  /**
   * POST /api/stalls/analyze/transcript
   * Analyze a call transcript for stall signals
   *
   * Request body: CallTranscript
   */
  router.post('/analyze/transcript', async (req: Request, res: Response) => {
    try {
      const parseResult = CallTranscriptSchema.safeParse(req.body);

      if (!parseResult.success) {
        return res.status(400).json({
          success: false,
          error: 'Invalid transcript data',
          details: parseResult.error.issues,
        });
      }

      const transcript = parseResult.data;

      // Parse date if string
      if (typeof transcript.callDate === 'string') {
        transcript.callDate = new Date(transcript.callDate);
      }

      logger.info(
        { transcriptId: transcript.id, accountName: transcript.accountName },
        'Analyzing transcript'
      );

      const signals = await stallDetector.analyzeTranscript(transcript);

      // Calculate deal status if we have a deal ID
      let stallStatus = null;
      if (transcript.dealId) {
        stallStatus = await stallDetector.calculateDealStatus(
          transcript.dealId,
          transcript.accountId,
          transcript.accountName,
          'DEMO', // Default stage - should be passed in or looked up
          null,   // Deal value - should be passed in or looked up
          transcript.repId,
          transcript.repName,
          null,   // Manager ID
          null    // Manager name
        );

        // Generate alert if appropriate
        if (stallStatus.isStalled) {
          await alertService.generateAlert(stallStatus);
        }
      }

      return res.json({
        success: true,
        signals,
        stallDetected: signals.length > 0,
        highestConfidence: signals.length > 0
          ? Math.max(...signals.map((s) => s.baseConfidence))
          : null,
        stallStatus,
        error: null,
      });
    } catch (error) {
      logger.error({ error }, 'Error analyzing transcript');
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * POST /api/stalls/analyze/email
   * Analyze email content for stall signals
   *
   * Request body: EmailContent
   */
  router.post('/analyze/email', async (req: Request, res: Response) => {
    try {
      const parseResult = EmailContentSchema.safeParse(req.body);

      if (!parseResult.success) {
        return res.status(400).json({
          success: false,
          error: 'Invalid email data',
          details: parseResult.error.issues,
        });
      }

      const email = parseResult.data;

      // Parse date if string
      if (typeof email.sentDate === 'string') {
        email.sentDate = new Date(email.sentDate);
      }

      logger.info(
        { emailId: email.id, accountName: email.accountName },
        'Analyzing email'
      );

      const signals = await stallDetector.analyzeEmail(email);

      return res.json({
        success: true,
        signals,
        stallDetected: signals.length > 0,
        highestConfidence: signals.length > 0
          ? Math.max(...signals.map((s) => s.baseConfidence))
          : null,
        error: null,
      });
    } catch (error) {
      logger.error({ error }, 'Error analyzing email');
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * POST /api/stalls/detect
   * Detect stall phrases in raw text
   * Useful for testing patterns
   *
   * Request body: { text: string }
   */
  router.post('/detect', (req: Request, res: Response) => {
    try {
      const { text } = req.body;

      if (!text || typeof text !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'text field is required and must be a string',
        });
      }

      const matches = stallDetector.detectPhrases(text);

      return res.json({
        success: true,
        matches,
        stallDetected: matches.length > 0,
      });
    } catch (error) {
      logger.error({ error }, 'Error detecting phrases');
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // ===========================================================================
  // STALLED DEALS
  // ===========================================================================

  /**
   * GET /api/stalls/deals
   * Get stalled deals with optional filters
   *
   * Query params:
   * - repId: string (optional)
   * - managerId: string (optional)
   * - stage: DealStage (optional)
   * - minSeverity: StallSeverity (optional)
   * - limit: number (default: 50)
   * - offset: number (default: 0)
   */
  router.get('/deals', async (req: Request, res: Response) => {
    try {
      const { repId, managerId, stage, minSeverity, limit, offset } = req.query;

      const parseResult = GetStalledDealsRequestSchema.safeParse({
        repId: repId as string,
        managerId: managerId as string,
        stage: stage as string,
        minSeverity: minSeverity as string,
        limit: limit ? parseInt(limit as string, 10) : 50,
        offset: offset ? parseInt(offset as string, 10) : 0,
      });

      if (!parseResult.success) {
        return res.status(400).json({
          success: false,
          error: 'Invalid request parameters',
          details: parseResult.error.issues,
        });
      }

      const filters = parseResult.data;
      const result = await stallDetector.getStalledDeals(
        {
          repId: filters.repId,
          managerId: filters.managerId,
          stage: filters.stage,
          minSeverity: filters.minSeverity,
        },
        filters.limit,
        filters.offset
      );

      return res.json({
        success: true,
        deals: result.deals,
        total: result.total,
        error: null,
      });
    } catch (error) {
      logger.error({ error }, 'Error getting stalled deals');
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * GET /api/stalls/deals/:dealId
   * Get stall status for a specific deal
   */
  router.get('/deals/:dealId', (req: Request, res: Response) => {
    try {
      const { dealId } = req.params;
      const status = stallDetector.getDealStatus(dealId);

      if (!status) {
        return res.status(404).json({
          success: false,
          error: 'Deal not found or no stall data available',
        });
      }

      return res.json({
        success: true,
        deal: status,
        error: null,
      });
    } catch (error) {
      logger.error({ error }, 'Error getting deal status');
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * POST /api/stalls/deals/:dealId/calculate
   * Calculate/update stall status for a deal
   *
   * Request body: {
   *   accountId: string
   *   accountName: string
   *   dealStage: DealStage
   *   dealValue?: number
   *   ownerRepId: string
   *   ownerRepName: string
   *   managerId?: string
   *   managerName?: string
   *   lastPositiveEngagement?: { date: string, type: string }
   * }
   */
  router.post('/deals/:dealId/calculate', async (req: Request, res: Response) => {
    try {
      const { dealId } = req.params;
      const {
        accountId,
        accountName,
        dealStage,
        dealValue,
        ownerRepId,
        ownerRepName,
        managerId,
        managerName,
        lastPositiveEngagement,
      } = req.body;

      if (!accountId || !accountName || !dealStage || !ownerRepId || !ownerRepName) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: accountId, accountName, dealStage, ownerRepId, ownerRepName',
        });
      }

      // Validate deal stage
      const validStages: DealStage[] = [
        'QUALIFICATION',
        'DISCOVERY',
        'DEMO',
        'PROPOSAL',
        'NEGOTIATION',
        'CLOSED_WON',
        'CLOSED_LOST',
      ];
      if (!validStages.includes(dealStage)) {
        return res.status(400).json({
          success: false,
          error: `Invalid dealStage. Must be one of: ${validStages.join(', ')}`,
        });
      }

      const status = await stallDetector.calculateDealStatus(
        dealId,
        accountId,
        accountName,
        dealStage,
        dealValue || null,
        ownerRepId,
        ownerRepName,
        managerId || null,
        managerName || null,
        lastPositiveEngagement
          ? {
              date: new Date(lastPositiveEngagement.date),
              type: lastPositiveEngagement.type,
            }
          : undefined
      );

      // Generate alert if stalled
      let alert = null;
      if (status.isStalled) {
        alert = await alertService.generateAlert(status);
        if (alert) {
          await alertService.deliverAlert(alert.id);
        }
      }

      return res.json({
        success: true,
        deal: status,
        alertGenerated: !!alert,
        alert,
        error: null,
      });
    } catch (error) {
      logger.error({ error }, 'Error calculating deal status');
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // ===========================================================================
  // MANAGER DASHBOARD
  // ===========================================================================

  /**
   * GET /api/stalls/dashboard/manager/:managerId
   * Get manager dashboard showing stalled deals by rep and stage
   *
   * Query params:
   * - repIds: comma-separated list of rep IDs (required)
   * - startDate: ISO date string (optional)
   * - endDate: ISO date string (optional)
   */
  router.get('/dashboard/manager/:managerId', async (req: Request, res: Response) => {
    try {
      const { managerId } = req.params;
      const { repIds, managerName } = req.query;

      if (!repIds || typeof repIds !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'repIds query parameter is required (comma-separated)',
        });
      }

      const repIdList = repIds.split(',').map((id) => id.trim());

      const dashboard = await stallDetector.getManagerDashboard(
        managerId,
        (managerName as string) || 'Manager',
        repIdList
      );

      return res.json({
        success: true,
        managerId,
        managerName: managerName || 'Manager',
        ...dashboard,
        error: null,
      });
    } catch (error) {
      logger.error({ error }, 'Error getting manager dashboard');
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * POST /api/stalls/dashboard/manager
   * Get manager dashboard with full configuration
   *
   * Request body: ManagerDashboardRequest
   */
  router.post('/dashboard/manager', async (req: Request, res: Response) => {
    try {
      const parseResult = ManagerDashboardRequestSchema.safeParse(req.body);

      if (!parseResult.success) {
        return res.status(400).json({
          success: false,
          error: 'Invalid request',
          details: parseResult.error.issues,
        });
      }

      // Note: In production, you'd look up rep IDs from the manager's team
      // For now, require them to be passed in via query or body
      const { repIds } = req.body;

      if (!repIds || !Array.isArray(repIds) || repIds.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'repIds array is required in request body',
        });
      }

      const { managerId } = parseResult.data;

      const dashboard = await stallDetector.getManagerDashboard(
        managerId,
        req.body.managerName || 'Manager',
        repIds
      );

      return res.json({
        success: true,
        managerId,
        managerName: req.body.managerName || 'Manager',
        ...dashboard,
        error: null,
      });
    } catch (error) {
      logger.error({ error }, 'Error getting manager dashboard');
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // ===========================================================================
  // ALERTS
  // ===========================================================================

  /**
   * GET /api/stalls/alerts
   * Get pending alerts
   *
   * Query params:
   * - dealId: string (optional)
   * - repId: string (optional)
   * - priority: AlertPriority (optional)
   */
  router.get('/alerts', (req: Request, res: Response) => {
    try {
      const { dealId, repId, priority } = req.query;

      const alerts = alertService.getPendingAlerts({
        dealId: dealId as string,
        repId: repId as string,
        priority: priority as any,
      });

      return res.json({
        success: true,
        alerts,
        total: alerts.length,
        error: null,
      });
    } catch (error) {
      logger.error({ error }, 'Error getting alerts');
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * GET /api/stalls/alerts/:alertId
   * Get a specific alert
   */
  router.get('/alerts/:alertId', (req: Request, res: Response) => {
    try {
      const { alertId } = req.params;
      const alert = alertService.getAlert(alertId);

      if (!alert) {
        return res.status(404).json({
          success: false,
          error: 'Alert not found',
        });
      }

      return res.json({
        success: true,
        alert,
        error: null,
      });
    } catch (error) {
      logger.error({ error }, 'Error getting alert');
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * POST /api/stalls/alerts/:alertId/acknowledge
   * Acknowledge an alert
   *
   * Request body: {
   *   acknowledgedBy: string
   *   notes?: string
   * }
   */
  router.post('/alerts/:alertId/acknowledge', async (req: Request, res: Response) => {
    try {
      const { alertId } = req.params;
      const parseResult = AcknowledgeAlertRequestSchema.safeParse({
        alertId,
        ...req.body,
      });

      if (!parseResult.success) {
        return res.status(400).json({
          success: false,
          error: 'Invalid request',
          details: parseResult.error.issues,
        });
      }

      const { acknowledgedBy, notes } = parseResult.data;
      const alert = await alertService.acknowledgeAlert(alertId, acknowledgedBy, notes);

      if (!alert) {
        return res.status(404).json({
          success: false,
          error: 'Alert not found',
        });
      }

      return res.json({
        success: true,
        alert,
        error: null,
      });
    } catch (error) {
      logger.error({ error }, 'Error acknowledging alert');
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * GET /api/stalls/alerts/deal/:dealId
   * Get all alerts for a specific deal
   */
  router.get('/alerts/deal/:dealId', (req: Request, res: Response) => {
    try {
      const { dealId } = req.params;
      const alerts = alertService.getAlertsForDeal(dealId);

      return res.json({
        success: true,
        alerts,
        total: alerts.length,
        error: null,
      });
    } catch (error) {
      logger.error({ error }, 'Error getting deal alerts');
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // ===========================================================================
  // MAINTENANCE
  // ===========================================================================

  /**
   * POST /api/stalls/maintenance/cleanup
   * Clean up expired alerts
   */
  router.post('/maintenance/cleanup', (_req: Request, res: Response) => {
    try {
      const cleaned = alertService.cleanupExpiredAlerts();

      return res.json({
        success: true,
        cleanedAlerts: cleaned,
      });
    } catch (error) {
      logger.error({ error }, 'Error during cleanup');
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  return router;
}
