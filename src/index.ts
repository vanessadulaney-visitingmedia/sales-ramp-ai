import 'dotenv/config';
import express from 'express';
import { BriefBuilderService } from './services/brief-builder.service.js';
import { StallDetectorService } from './services/stall-detector.service.js';
import { AlertService } from './services/alert.service.js';
import { StageEngineService } from './services/stage-engine.service.js';
import { AuditService } from './services/audit.service.js';
import { KaiaAdapter } from './adapters/kaia.adapter.js';
import { OutreachAdapter } from './adapters/outreach.adapter.js';
import { createRoutes } from './api/routes.js';
import { createStallRoutes } from './api/stalls.js';
import { createWebhookRoutes } from './api/webhooks.js';
import { logger } from './utils/logger.js';

// =============================================================================
// MAIN APPLICATION ENTRY POINT
// =============================================================================

async function main() {
  logger.info('Starting Sales Ramp AI Service...');

  // Validate required environment variables
  const requiredEnvVars = [
    'FIRECRAWL_API_KEY',
    'SF_LOGIN_URL',
    'SF_USERNAME',
    'SF_PASSWORD',
    'SF_SECURITY_TOKEN',
  ];

  const missingVars = requiredEnvVars.filter((v) => !process.env[v]);
  if (missingVars.length > 0) {
    logger.warn({ missingVars }, 'Missing environment variables (service may have limited functionality)');
  }

  // Initialize Brief Builder Service
  const briefBuilder = new BriefBuilderService({
    firecrawlApiKey: process.env.FIRECRAWL_API_KEY || '',
    salesforce: {
      loginUrl: process.env.SF_LOGIN_URL || 'https://login.salesforce.com',
      username: process.env.SF_USERNAME || '',
      password: process.env.SF_PASSWORD || '',
      securityToken: process.env.SF_SECURITY_TOKEN || '',
    },
    redisUrl: process.env.REDIS_URL,
    cacheTTLHours: parseInt(process.env.BRIEF_CACHE_TTL_HOURS || '24', 10),
    articleLookbackDays: parseInt(process.env.ARTICLE_LOOKBACK_DAYS || '90', 10),
  });

  // Initialize connections
  try {
    await briefBuilder.initialize();
  } catch (error) {
    logger.warn({ error }, 'Failed to initialize some connections (continuing anyway)');
  }

  // Initialize Stall Detection Services
  const stallDetector = new StallDetectorService({
    timeDecayHalfLifeHours: parseInt(process.env.STALL_DECAY_HALF_LIFE_HOURS || '48', 10),
    maxSignalAgeHours: parseInt(process.env.STALL_MAX_SIGNAL_AGE_HOURS || '168', 10),
    criticalThreshold: parseInt(process.env.STALL_CRITICAL_THRESHOLD || '80', 10),
    highThreshold: parseInt(process.env.STALL_HIGH_THRESHOLD || '60', 10),
    mediumThreshold: parseInt(process.env.STALL_MEDIUM_THRESHOLD || '40', 10),
    alertWithinHours: parseInt(process.env.STALL_ALERT_WITHIN_HOURS || '24', 10),
    minConfidenceForAlert: parseFloat(process.env.STALL_MIN_CONFIDENCE || '0.5'),
  });

  const alertService = new AlertService({
    alertWithinHours: parseInt(process.env.ALERT_WITHIN_HOURS || '24', 10),
    alertExpirationHours: parseInt(process.env.ALERT_EXPIRATION_HOURS || '72', 10),
    enabledChannels: (process.env.ALERT_CHANNELS || 'WEBHOOK').split(',') as any[],
    escalateToManagerAfterHours: parseInt(process.env.ALERT_ESCALATE_AFTER_HOURS || '24', 10),
    escalateToBothOnCritical: process.env.ALERT_ESCALATE_CRITICAL !== 'false',
    webhookUrl: process.env.ALERT_WEBHOOK_URL,
    webhookSecret: process.env.ALERT_WEBHOOK_SECRET,
  });

  logger.info('Stall Detection Services initialized');

  // Initialize CRM Automation Services (Kaia -> Outreach)
  const kaiaAdapter = new KaiaAdapter({
    apiKey: process.env.KAIA_API_KEY || '',
    webhookSecret: process.env.KAIA_WEBHOOK_SECRET || '',
  });

  const outreachAdapter = new OutreachAdapter({
    clientId: process.env.OUTREACH_CLIENT_ID || '',
    clientSecret: process.env.OUTREACH_CLIENT_SECRET || '',
    redirectUri: process.env.OUTREACH_REDIRECT_URI || 'http://localhost:3000/oauth/callback',
    accessToken: process.env.OUTREACH_ACCESS_TOKEN,
    refreshToken: process.env.OUTREACH_REFRESH_TOKEN,
  });

  const stageEngine = new StageEngineService({
    highConfidenceThreshold: parseFloat(process.env.STAGE_HIGH_CONFIDENCE || '0.8'),
    mediumConfidenceThreshold: parseFloat(process.env.STAGE_MEDIUM_CONFIDENCE || '0.5'),
    enableAutoUpdate: process.env.STAGE_AUTO_UPDATE !== 'false',
    enableFlagging: process.env.STAGE_ENABLE_FLAGGING !== 'false',
  });

  const auditService = new AuditService({
    retentionDays: parseInt(process.env.AUDIT_RETENTION_DAYS || '90', 10),
    enableRollback: process.env.AUDIT_ENABLE_ROLLBACK !== 'false',
    logToFile: process.env.AUDIT_LOG_TO_FILE === 'true',
    logFilePath: process.env.AUDIT_LOG_FILE_PATH,
  });

  logger.info('CRM Automation Services initialized');

  // Create Express app
  const app = express();

  // Middleware
  app.use(express.json());

  // Request logging
  app.use((req, _res, next) => {
    logger.debug({ method: req.method, url: req.url }, 'Request received');
    next();
  });

  // Mount API routes
  app.use('/api', createRoutes(briefBuilder));
  app.use('/api/stalls', createStallRoutes(stallDetector, alertService));
  app.use('/api/webhooks', createWebhookRoutes({
    kaiaAdapter,
    outreachAdapter,
    stageEngine,
    auditService,
  }));

  // Root endpoint
  app.get('/', (_req, res) => {
    res.json({
      service: 'Sales Ramp AI - Brief Builder & Stall Detection Service',
      version: '1.1.0',
      endpoints: {
        // Brief Builder
        health: 'GET /api/health',
        generateBrief: 'POST /api/brief',
        getBrief: 'GET /api/brief/:propertyName',
        batchBriefs: 'POST /api/batch/briefs',
        cacheStats: 'GET /api/cache/stats',
        invalidateCache: 'DELETE /api/cache/:propertyName',
        clearCache: 'DELETE /api/cache',
        // Stall Detection
        stallHealth: 'GET /api/stalls/health',
        analyzeTranscript: 'POST /api/stalls/analyze/transcript',
        analyzeEmail: 'POST /api/stalls/analyze/email',
        detectPhrases: 'POST /api/stalls/detect',
        stalledDeals: 'GET /api/stalls/deals',
        dealStatus: 'GET /api/stalls/deals/:dealId',
        calculateStall: 'POST /api/stalls/deals/:dealId/calculate',
        managerDashboard: 'GET /api/stalls/dashboard/manager/:managerId',
        alerts: 'GET /api/stalls/alerts',
        acknowledgeAlert: 'POST /api/stalls/alerts/:alertId/acknowledge',
        dealAlerts: 'GET /api/stalls/alerts/deal/:dealId',
        // CRM Automation (Kaia -> Outreach)
        kaiaWebhook: 'POST /api/webhooks/kaia/call',
        webhookHealth: 'GET /api/webhooks/health',
        pendingConfirmations: 'GET /api/webhooks/confirmations/pending',
        confirmStage: 'POST /api/webhooks/confirmations/:confirmationId/confirm',
        rejectStage: 'POST /api/webhooks/confirmations/:confirmationId/reject',
        auditByCall: 'GET /api/webhooks/audit/call/:callId',
        auditByProspect: 'GET /api/webhooks/audit/prospect/:prospectId',
        auditStats: 'GET /api/webhooks/audit/stats',
        rollback: 'POST /api/webhooks/audit/:auditId/rollback',
      },
    });
  });

  // Error handler
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ error: err }, 'Unhandled error');
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  });

  // Start server
  const port = parseInt(process.env.PORT || '3000', 10);
  const server = app.listen(port, () => {
    logger.info({ port }, `Server running on http://localhost:${port}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    server.close();
    await briefBuilder.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Run
main().catch((error) => {
  logger.error({ error }, 'Failed to start server');
  process.exit(1);
});
