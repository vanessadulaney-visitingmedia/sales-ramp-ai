import 'dotenv/config';
import cron from 'node-cron';
import { BriefBuilderService } from '../services/brief-builder.service.js';
import { logger } from '../utils/logger.js';

// =============================================================================
// NIGHTLY CACHE JOB
// Pre-generates briefs for assigned territories during off-hours
// =============================================================================

interface TerritoryProperty {
  name: string;
  id?: string;
  city?: string;
  state?: string;
}

async function runNightlyCache(briefBuilder: BriefBuilderService) {
  logger.info('Starting nightly cache job');
  const startTime = Date.now();

  try {
    // TODO: Fetch territory assignments from Salesforce or config
    // For now, this is a placeholder that would be populated from your CRM
    const territories = await fetchTerritoryAssignments();

    logger.info({ propertyCount: territories.length }, 'Loaded territory properties');

    // Process in batches to avoid overwhelming external APIs
    const batchSize = 10;
    const batches = chunkArray(territories, batchSize);

    let totalSuccess = 0;
    let totalFailed = 0;

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      logger.info({ batch: i + 1, of: batches.length, size: batch.length }, 'Processing batch');

      const result = await briefBuilder.batchGenerateBriefs(batch);
      totalSuccess += result.success;
      totalFailed += result.failed;

      // Pause between batches
      if (i < batches.length - 1) {
        await sleep(5000); // 5 second pause between batches
      }
    }

    const duration = Date.now() - startTime;
    logger.info({
      totalSuccess,
      totalFailed,
      duration,
      durationMinutes: Math.round(duration / 60000),
    }, 'Nightly cache job complete');

  } catch (error) {
    logger.error({ error }, 'Nightly cache job failed');
  }
}

/**
 * Fetch territory assignments from Salesforce
 * This would query your Salesforce org for properties assigned to reps
 */
async function fetchTerritoryAssignments(): Promise<TerritoryProperty[]> {
  // TODO: Implement actual Salesforce query
  // Example query:
  // SELECT Id, Name, ShippingCity, ShippingState
  // FROM Account
  // WHERE OwnerId IN (SELECT Id FROM User WHERE IsActive = true AND Profile.Name = 'Sales Rep')
  // AND RecordType.Name = 'Prospect'

  // Placeholder - replace with actual data source
  return [
    // { name: 'Sample Hotel', city: 'San Francisco', state: 'CA' },
  ];
}

function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// MAIN - Run as standalone or as scheduled job
// =============================================================================

async function main() {
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

  await briefBuilder.initialize();

  // Check if running in scheduled mode or one-shot
  const runMode = process.argv[2] || 'scheduled';

  if (runMode === 'once') {
    // One-shot execution
    logger.info('Running one-shot cache refresh');
    await runNightlyCache(briefBuilder);
    await briefBuilder.shutdown();
    process.exit(0);
  } else {
    // Scheduled mode - run at 2 AM daily
    logger.info('Starting scheduled cache job (runs at 2:00 AM daily)');

    cron.schedule('0 2 * * *', async () => {
      await runNightlyCache(briefBuilder);
    });

    // Keep process alive
    process.on('SIGINT', async () => {
      logger.info('Shutting down cache job');
      await briefBuilder.shutdown();
      process.exit(0);
    });
  }
}

// Run if executed directly
main().catch((error) => {
  logger.error({ error }, 'Cache job failed to start');
  process.exit(1);
});
