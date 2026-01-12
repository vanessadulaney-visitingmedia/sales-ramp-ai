import { Router, Request, Response } from 'express';
import { KaiaAdapter } from '../adapters/kaia.adapter.js';
import { OutreachAdapter } from '../adapters/outreach.adapter.js';
import { StageEngineService } from '../services/stage-engine.service.js';
import { AuditService } from '../services/audit.service.js';
import {
  WebhookResponse,
  KaiaWebhookPayload,
  OutreachStage,
} from '../types/crm-automation.js';
import { logger } from '../utils/logger.js';

// =============================================================================
// WEBHOOK ENDPOINTS FOR KAIA CRM AUTOMATION
// Receives call transcripts and orchestrates stage updates
// =============================================================================

interface WebhookDependencies {
  kaiaAdapter: KaiaAdapter;
  outreachAdapter: OutreachAdapter;
  stageEngine: StageEngineService;
  auditService: AuditService;
}

interface PendingConfirmation {
  callId: string;
  prospectId: number;
  suggestedStage: OutreachStage;
  confidence: number;
  reasoning: string;
  createdAt: Date;
  auditId: string;
}

// In-memory store for pending confirmations (in production, use Redis or DB)
const pendingConfirmations = new Map<string, PendingConfirmation>();

export function createWebhookRoutes(deps: WebhookDependencies): Router {
  const router = Router();
  const { kaiaAdapter, outreachAdapter, stageEngine, auditService } = deps;

  // ===========================================================================
  // KAIA WEBHOOK RECEIVER
  // ===========================================================================

  /**
   * POST /webhooks/kaia/call
   * Receives Kaia call transcript webhooks and processes them
   */
  router.post('/kaia/call', async (req: Request, res: Response) => {
    const startTime = Date.now();
    let callId = 'unknown';

    try {
      // Verify webhook signature
      const signature = req.headers['x-kaia-signature'] as string;
      const rawBody = JSON.stringify(req.body);

      if (signature && !kaiaAdapter.verifyWebhookSignature(rawBody, signature)) {
        logger.warn('Invalid Kaia webhook signature');
        return res.status(401).json({
          success: false,
          callId,
          processed: false,
          error: 'Invalid webhook signature',
        } satisfies WebhookResponse);
      }

      // Parse and validate payload
      const payload = kaiaAdapter.parseWebhookPayload(req.body);
      if (!payload) {
        return res.status(400).json({
          success: false,
          callId,
          processed: false,
          error: 'Invalid payload format',
        } satisfies WebhookResponse);
      }

      callId = payload.data.callId;
      logger.info({ callId, event: payload.event }, 'Kaia webhook received');

      // Only process completed/analyzed calls
      if (!['call.completed', 'call.analyzed'].includes(payload.event)) {
        return res.json({
          success: true,
          callId,
          processed: false,
          error: `Event type ${payload.event} not processed`,
        } satisfies WebhookResponse);
      }

      // Extract call signals
      const extractedData = kaiaAdapter.extractCallData(payload.data);

      // Map signals to stage
      const stageMapping = stageEngine.mapToStage(extractedData);

      // Find prospect in Outreach
      const repEmail = payload.data.participants.find((p) => p.role === 'rep')?.email;
      const prospectEmail = payload.data.participants.find((p) => p.role === 'prospect')?.email;

      if (!prospectEmail) {
        logger.warn({ callId }, 'No prospect email found in call data');
        return res.json({
          success: true,
          callId,
          processed: false,
          stageUpdate: stageMapping,
          error: 'No prospect email found',
        } satisfies WebhookResponse);
      }

      const prospect = await outreachAdapter.findProspectByEmail(prospectEmail);
      if (!prospect) {
        logger.warn({ callId, prospectEmail }, 'Prospect not found in Outreach');
        return res.json({
          success: true,
          callId,
          processed: false,
          stageUpdate: stageMapping,
          error: 'Prospect not found in Outreach',
        } satisfies WebhookResponse);
      }

      // Determine action based on confidence
      const shouldAutoUpdate = stageEngine.shouldAutoUpdate(stageMapping.confidence);
      const needsConfirmation = stageEngine.needsConfirmation(stageMapping.confidence);

      let updateResult = null;
      let auditIds: string[] = [];

      if (shouldAutoUpdate) {
        // High confidence - auto-update
        logger.info(
          { callId, prospectId: prospect.id, newStage: stageMapping.newStage },
          'Auto-updating prospect stage'
        );

        updateResult = await outreachAdapter.updateProspect({
          prospectId: prospect.id,
          stage: stageMapping.newStage,
          disposition: stageMapping.disposition,
          note: generateCallNote(payload, extractedData, stageMapping),
        });

        // Log to audit
        auditIds = await auditService.logStageMappingResult({
          callId,
          prospectId: prospect.id,
          previousStage: prospect.stage,
          result: stageMapping,
          autoUpdated: true,
        });

        // Log call activity
        await outreachAdapter.logCall(prospect.id, {
          direction: payload.data.callType === 'inbound' ? 'inbound' : 'outbound',
          outcome: stageMapping.disposition || 'Connected',
          duration: payload.data.duration,
          notes: kaiaAdapter.getTranscriptSummary(payload.data),
          externalVendor: 'Kaia',
          externalCallId: callId,
        });
      } else if (needsConfirmation) {
        // Medium confidence - flag for confirmation
        logger.info(
          { callId, prospectId: prospect.id, confidence: stageMapping.confidence },
          'Flagging for rep confirmation'
        );

        auditIds = await auditService.logStageMappingResult({
          callId,
          prospectId: prospect.id,
          previousStage: prospect.stage,
          result: stageMapping,
          autoUpdated: false,
        });

        // Store pending confirmation
        const confirmationId = `${callId}-${prospect.id}`;
        pendingConfirmations.set(confirmationId, {
          callId,
          prospectId: prospect.id,
          suggestedStage: stageMapping.newStage,
          confidence: stageMapping.confidence,
          reasoning: stageMapping.reasoning,
          createdAt: new Date(),
          auditId: auditIds[0],
        });

        // Still log the call activity
        await outreachAdapter.logCall(prospect.id, {
          direction: payload.data.callType === 'inbound' ? 'inbound' : 'outbound',
          outcome: 'Connected - Pending Review',
          duration: payload.data.duration,
          externalVendor: 'Kaia',
          externalCallId: callId,
        });
      } else {
        // Low confidence - log only
        logger.info(
          { callId, confidence: stageMapping.confidence },
          'Low confidence - no automated action'
        );

        await auditService.logStageMappingResult({
          callId,
          prospectId: prospect.id,
          previousStage: prospect.stage,
          result: stageMapping,
          autoUpdated: false,
        });
      }

      const processingTime = Date.now() - startTime;
      logger.info(
        { callId, processingTime, autoUpdated: shouldAutoUpdate },
        'Kaia webhook processed'
      );

      return res.json({
        success: true,
        callId,
        processed: true,
        stageUpdate: stageMapping,
        auditId: auditIds[0],
      } satisfies WebhookResponse);
    } catch (error) {
      logger.error({ error, callId }, 'Error processing Kaia webhook');

      await auditService.logError({
        callId,
        error: error instanceof Error ? error.message : 'Unknown error',
        context: { webhook: 'kaia/call' },
      });

      return res.status(500).json({
        success: false,
        callId,
        processed: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      } satisfies WebhookResponse);
    }
  });

  // ===========================================================================
  // CONFIRMATION ENDPOINTS
  // ===========================================================================

  /**
   * GET /webhooks/confirmations/pending
   * Get all pending stage confirmations
   */
  router.get('/confirmations/pending', async (_req: Request, res: Response) => {
    try {
      const pending = Array.from(pendingConfirmations.values())
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

      return res.json({
        success: true,
        count: pending.length,
        confirmations: pending,
      });
    } catch (error) {
      logger.error({ error }, 'Error fetching pending confirmations');
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * POST /webhooks/confirmations/:confirmationId/confirm
   * Confirm a pending stage change
   */
  router.post('/confirmations/:confirmationId/confirm', async (req: Request, res: Response) => {
    try {
      const { confirmationId } = req.params;
      const { confirmedBy, modifiedStage } = req.body;

      const pending = pendingConfirmations.get(confirmationId);
      if (!pending) {
        return res.status(404).json({
          success: false,
          error: 'Pending confirmation not found',
        });
      }

      const finalStage = modifiedStage || pending.suggestedStage;

      // Apply the update
      const updateResult = await outreachAdapter.updateProspect({
        prospectId: pending.prospectId,
        stage: finalStage,
      });

      if (updateResult.success) {
        // Log the confirmation
        await auditService.logStageChange({
          callId: pending.callId,
          prospectId: pending.prospectId,
          previousStage: updateResult.previousStage,
          newStage: finalStage,
          confidence: pending.confidence,
          automated: false,
          metadata: {
            confirmedBy,
            originalSuggestedStage: pending.suggestedStage,
            modifiedByRep: !!modifiedStage,
          },
        });

        pendingConfirmations.delete(confirmationId);

        return res.json({
          success: true,
          message: 'Stage change confirmed and applied',
          prospectId: pending.prospectId,
          newStage: finalStage,
        });
      } else {
        return res.status(500).json({
          success: false,
          error: updateResult.error || 'Failed to update prospect',
        });
      }
    } catch (error) {
      logger.error({ error }, 'Error confirming stage change');
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * POST /webhooks/confirmations/:confirmationId/reject
   * Reject a pending stage change
   */
  router.post('/confirmations/:confirmationId/reject', async (req: Request, res: Response) => {
    try {
      const { confirmationId } = req.params;
      const { rejectedBy, reason } = req.body;

      const pending = pendingConfirmations.get(confirmationId);
      if (!pending) {
        return res.status(404).json({
          success: false,
          error: 'Pending confirmation not found',
        });
      }

      // Log the rejection
      await auditService.logFlagSet({
        callId: pending.callId,
        prospectId: pending.prospectId,
        flag: 'stage_change_rejected',
        reason: reason || `Rejected by ${rejectedBy}`,
      });

      pendingConfirmations.delete(confirmationId);

      return res.json({
        success: true,
        message: 'Stage change rejected',
        prospectId: pending.prospectId,
      });
    } catch (error) {
      logger.error({ error }, 'Error rejecting stage change');
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // ===========================================================================
  // AUDIT ENDPOINTS
  // ===========================================================================

  /**
   * GET /webhooks/audit/call/:callId
   * Get audit trail for a specific call
   */
  router.get('/audit/call/:callId', async (req: Request, res: Response) => {
    try {
      const { callId } = req.params;
      const entries = auditService.getEntriesForCall(callId);

      return res.json({
        success: true,
        callId,
        entries,
      });
    } catch (error) {
      logger.error({ error }, 'Error fetching audit entries');
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * GET /webhooks/audit/prospect/:prospectId
   * Get audit trail for a specific prospect
   */
  router.get('/audit/prospect/:prospectId', async (req: Request, res: Response) => {
    try {
      const prospectId = parseInt(req.params.prospectId, 10);
      const entries = auditService.getEntriesForProspect(prospectId);

      return res.json({
        success: true,
        prospectId,
        entries,
      });
    } catch (error) {
      logger.error({ error }, 'Error fetching audit entries');
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * GET /webhooks/audit/stats
   * Get audit statistics
   */
  router.get('/audit/stats', async (_req: Request, res: Response) => {
    try {
      const stats = auditService.getStats();

      return res.json({
        success: true,
        stats,
      });
    } catch (error) {
      logger.error({ error }, 'Error fetching audit stats');
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * POST /webhooks/audit/:auditId/rollback
   * Rollback a specific change
   */
  router.post('/audit/:auditId/rollback', async (req: Request, res: Response) => {
    try {
      const { auditId } = req.params;
      const { confirmedBy } = req.body;

      if (!confirmedBy) {
        return res.status(400).json({
          success: false,
          error: 'confirmedBy is required',
        });
      }

      const result = await auditService.rollback(auditId, confirmedBy);

      if (result.success && result.restoredValue) {
        // Get the original entry to find the prospect
        const originalEntry = auditService.getEntry(auditId);
        if (originalEntry?.prospectId && originalEntry.action === 'STAGE_CHANGE') {
          // Revert the stage in Outreach
          await outreachAdapter.updateProspectStage(
            originalEntry.prospectId,
            result.restoredValue as OutreachStage
          );
        }
      }

      return res.json({
        success: result.success,
        message: result.message,
        rollbackAuditId: result.auditId,
        previousValue: result.previousValue,
        restoredValue: result.restoredValue,
      });
    } catch (error) {
      logger.error({ error }, 'Error processing rollback');
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // ===========================================================================
  // HEALTH CHECK
  // ===========================================================================

  /**
   * GET /webhooks/health
   * Health check for webhook system
   */
  router.get('/health', async (_req: Request, res: Response) => {
    try {
      const stats = auditService.getStats();
      const pendingCount = pendingConfirmations.size;

      return res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        outreachAuthenticated: outreachAdapter.isAuthenticated(),
        auditStats: {
          totalEntries: stats.totalEntries,
          automatedChanges: stats.entriesByAutomated.automated,
          errorCount: stats.errorCount,
        },
        pendingConfirmations: pendingCount,
      });
    } catch (error) {
      return res.status(500).json({
        status: 'unhealthy',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  return router;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Generate a note to add to the prospect based on call data
 */
function generateCallNote(
  payload: KaiaWebhookPayload,
  extractedData: ReturnType<KaiaAdapter['extractCallData']>,
  stageMapping: ReturnType<StageEngineService['mapToStage']>
): string {
  const parts: string[] = [];

  parts.push(`Call: ${payload.data.title || payload.data.callId}`);
  parts.push(`Duration: ${Math.round(payload.data.duration / 60)} minutes`);
  parts.push(`Outcome: ${extractedData.primaryOutcome.replace(/_/g, ' ')}`);

  if (extractedData.talkRatio) {
    parts.push(`Talk Ratio - Rep: ${extractedData.talkRatio.rep}%, Prospect: ${extractedData.talkRatio.prospect}%`);
  }

  const keySignals = extractedData.signals
    .filter((s) => s.confidence > 0.6)
    .map((s) => s.type.replace(/_/g, ' ').toLowerCase())
    .slice(0, 5);

  if (keySignals.length > 0) {
    parts.push(`Key Signals: ${keySignals.join(', ')}`);
  }

  if (stageMapping.flags.length > 0) {
    parts.push(`Flags: ${stageMapping.flags.join(', ')}`);
  }

  if (stageMapping.suggestedTasks.length > 0) {
    parts.push(`Suggested Tasks: ${stageMapping.suggestedTasks.join('; ')}`);
  }

  parts.push(`[Auto-logged by Kaia Integration - Confidence: ${(stageMapping.confidence * 100).toFixed(0)}%]`);

  return parts.join('\n');
}
