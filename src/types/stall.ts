import { z } from 'zod';

// =============================================================================
// STALL DETECTION TYPES
// Types for the Stall Detection System
// =============================================================================

// =============================================================================
// STALL PHRASE PATTERNS
// =============================================================================

export const StallPhraseCategory = z.enum([
  'PRICING_REQUEST',      // "send pricing" / "send me pricing"
  'APPROVAL_NEEDED',      // "need approval" / "need to get approval"
  'THINKING',             // "let me think about it"
  'TEAM_CHECK',           // "check with my team"
  'DECISION_MAKER',       // "talk to [decision maker]"
  'CALLBACK_REQUEST',     // "call back next week/month"
  'FOLLOWUP_PROMISE',     // "we'll get back to you"
  'INTERNAL_DISCUSSION',  // "need to discuss internally"
]);

export type StallPhraseCategory = z.infer<typeof StallPhraseCategory>;

export const StallPhraseMatch = z.object({
  phrase: z.string(),
  category: StallPhraseCategory,
  matchedText: z.string(),
  confidence: z.number().min(0).max(1),
  position: z.number(), // Position in source text
  context: z.string().optional(), // Surrounding text for context
});

export type StallPhraseMatch = z.infer<typeof StallPhraseMatch>;

// =============================================================================
// STALL SIGNAL (Individual detection)
// =============================================================================

export const StallSignalSource = z.enum([
  'CALL_TRANSCRIPT',  // From Kaia call transcripts
  'EMAIL',            // From email content
  'MEETING_NOTES',    // From meeting notes
  'CRM_NOTES',        // From Salesforce notes
]);

export type StallSignalSource = z.infer<typeof StallSignalSource>;

export const StallSignalSchema = z.object({
  id: z.string(),
  dealId: z.string(),
  accountId: z.string(),
  accountName: z.string(),

  // Source information
  source: StallSignalSource,
  sourceId: z.string(), // ID of the source document/transcript
  sourceTimestamp: z.date(),

  // Detection details
  phraseMatches: z.array(StallPhraseMatch),
  rawContent: z.string().optional(), // Original content snippet

  // Scoring
  baseConfidence: z.number().min(0).max(1),
  timeDecayedConfidence: z.number().min(0).max(1),
  aggregateStrength: z.number().min(0).max(10), // Overall stall strength

  // Metadata
  detectedAt: z.date(),
  processedAt: z.date().nullable(),
});

export type StallSignal = z.infer<typeof StallSignalSchema>;

// =============================================================================
// STALL STATUS (Aggregated deal status)
// =============================================================================

export const StallSeverity = z.enum([
  'LOW',       // Minor stall signals, may recover
  'MEDIUM',    // Notable stall signals, needs attention
  'HIGH',      // Strong stall signals, intervention needed
  'CRITICAL',  // Deal likely stuck, immediate action required
]);

export type StallSeverity = z.infer<typeof StallSeverity>;

export const DealStage = z.enum([
  'QUALIFICATION',
  'DISCOVERY',
  'DEMO',
  'PROPOSAL',
  'NEGOTIATION',
  'CLOSED_WON',
  'CLOSED_LOST',
]);

export type DealStage = z.infer<typeof DealStage>;

export const StallStatusSchema = z.object({
  dealId: z.string(),
  accountId: z.string(),
  accountName: z.string(),

  // Deal context
  dealStage: DealStage,
  dealValue: z.number().nullable(),
  ownerRepId: z.string(),
  ownerRepName: z.string(),
  managerId: z.string().nullable(),
  managerName: z.string().nullable(),

  // Stall analysis
  isStalled: z.boolean(),
  severity: StallSeverity,
  stallScore: z.number().min(0).max(100),
  primaryCategory: StallPhraseCategory.nullable(),

  // Signals
  signalCount: z.number(),
  latestSignalAt: z.date().nullable(),
  signals: z.array(StallSignalSchema),

  // Engagement tracking
  daysSinceLastPositiveEngagement: z.number().nullable(),
  lastPositiveEngagementDate: z.date().nullable(),
  lastPositiveEngagementType: z.string().nullable(),

  // Recommended actions
  recommendedActions: z.array(z.string()),

  // Metadata
  calculatedAt: z.date(),
  alertSentAt: z.date().nullable(),
});

export type StallStatus = z.infer<typeof StallStatusSchema>;

// =============================================================================
// ALERT TYPES
// =============================================================================

export const AlertPriority = z.enum([
  'LOW',
  'MEDIUM',
  'HIGH',
  'URGENT',
]);

export type AlertPriority = z.infer<typeof AlertPriority>;

export const AlertChannel = z.enum([
  'EMAIL',
  'SLACK',
  'SALESFORCE_TASK',
  'WEBHOOK',
]);

export type AlertChannel = z.infer<typeof AlertChannel>;

export const AlertRecipientType = z.enum([
  'REP',
  'MANAGER',
  'BOTH',
]);

export type AlertRecipientType = z.infer<typeof AlertRecipientType>;

export const StallAlertSchema = z.object({
  id: z.string(),
  dealId: z.string(),
  accountId: z.string(),
  accountName: z.string(),

  // Alert content
  title: z.string(),
  summary: z.string(),
  detectedPhrase: z.string(),
  confidenceScore: z.number().min(0).max(1),

  // Timing
  timeSinceStallSignal: z.number(), // Hours
  timeSinceLastPositiveEngagement: z.number().nullable(), // Days

  // Priority and routing
  priority: AlertPriority,
  recipientType: AlertRecipientType,
  recipients: z.array(z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    type: AlertRecipientType,
  })),

  // Delivery
  channels: z.array(AlertChannel),
  deliveredVia: z.array(AlertChannel).default([]),
  deliveredAt: z.date().nullable(),

  // Recommended action
  recommendedAction: z.string(),
  actionUrl: z.string().nullable(), // Deep link to CRM

  // Status
  acknowledged: z.boolean().default(false),
  acknowledgedAt: z.date().nullable(),
  acknowledgedBy: z.string().nullable(),

  // Metadata
  createdAt: z.date(),
  expiresAt: z.date(), // Alert expires if not acted upon

  // Source data
  stallStatus: StallStatusSchema,
});

export type StallAlert = z.infer<typeof StallAlertSchema>;

// =============================================================================
// TRANSCRIPT INPUT TYPES
// =============================================================================

export const CallTranscriptSchema = z.object({
  id: z.string(),
  dealId: z.string().optional(),
  accountId: z.string(),
  accountName: z.string(),
  callDate: z.date(),
  duration: z.number(), // seconds
  repId: z.string(),
  repName: z.string(),
  transcript: z.string(),
  summary: z.string().optional(),
  sentiment: z.number().min(-1).max(1).optional(), // -1 negative, 1 positive
  source: z.literal('KAIA').default('KAIA'),
});

export type CallTranscript = z.infer<typeof CallTranscriptSchema>;

export const EmailContentSchema = z.object({
  id: z.string(),
  dealId: z.string().optional(),
  accountId: z.string(),
  accountName: z.string(),
  sentDate: z.date(),
  from: z.string(),
  to: z.array(z.string()),
  subject: z.string(),
  body: z.string(),
  direction: z.enum(['INBOUND', 'OUTBOUND']),
  repId: z.string().optional(),
  repName: z.string().optional(),
});

export type EmailContent = z.infer<typeof EmailContentSchema>;

// =============================================================================
// API REQUEST/RESPONSE TYPES
// =============================================================================

export const AnalyzeTranscriptRequestSchema = z.object({
  transcript: CallTranscriptSchema,
});

export type AnalyzeTranscriptRequest = z.infer<typeof AnalyzeTranscriptRequestSchema>;

export const AnalyzeTranscriptResponseSchema = z.object({
  success: z.boolean(),
  signals: z.array(StallSignalSchema),
  stallDetected: z.boolean(),
  highestConfidence: z.number().nullable(),
  error: z.string().nullable(),
});

export type AnalyzeTranscriptResponse = z.infer<typeof AnalyzeTranscriptResponseSchema>;

export const GetStalledDealsRequestSchema = z.object({
  repId: z.string().optional(),
  managerId: z.string().optional(),
  stage: DealStage.optional(),
  minSeverity: StallSeverity.optional(),
  limit: z.number().default(50),
  offset: z.number().default(0),
});

export type GetStalledDealsRequest = z.infer<typeof GetStalledDealsRequestSchema>;

export const GetStalledDealsResponseSchema = z.object({
  success: z.boolean(),
  deals: z.array(StallStatusSchema),
  total: z.number(),
  error: z.string().nullable(),
});

export type GetStalledDealsResponse = z.infer<typeof GetStalledDealsResponseSchema>;

export const ManagerDashboardRequestSchema = z.object({
  managerId: z.string(),
  includeAllReps: z.boolean().default(true),
  dateRange: z.object({
    start: z.date(),
    end: z.date(),
  }).optional(),
});

export type ManagerDashboardRequest = z.infer<typeof ManagerDashboardRequestSchema>;

export const ManagerDashboardResponseSchema = z.object({
  success: z.boolean(),
  managerId: z.string(),
  managerName: z.string(),
  summary: z.object({
    totalDeals: z.number(),
    stalledDeals: z.number(),
    criticalStalls: z.number(),
    highStalls: z.number(),
    mediumStalls: z.number(),
    lowStalls: z.number(),
    avgDaysSinceEngagement: z.number(),
    totalAtRiskValue: z.number(),
  }),
  byRep: z.array(z.object({
    repId: z.string(),
    repName: z.string(),
    totalDeals: z.number(),
    stalledDeals: z.number(),
    stalledValue: z.number(),
    topStallCategory: StallPhraseCategory.nullable(),
    deals: z.array(StallStatusSchema),
  })),
  byStage: z.array(z.object({
    stage: DealStage,
    stalledCount: z.number(),
    totalValue: z.number(),
  })),
  error: z.string().nullable(),
});

export type ManagerDashboardResponse = z.infer<typeof ManagerDashboardResponseSchema>;

export const AcknowledgeAlertRequestSchema = z.object({
  alertId: z.string(),
  acknowledgedBy: z.string(),
  notes: z.string().optional(),
});

export type AcknowledgeAlertRequest = z.infer<typeof AcknowledgeAlertRequestSchema>;

export const AcknowledgeAlertResponseSchema = z.object({
  success: z.boolean(),
  alert: StallAlertSchema.nullable(),
  error: z.string().nullable(),
});

export type AcknowledgeAlertResponse = z.infer<typeof AcknowledgeAlertResponseSchema>;
