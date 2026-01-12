import { z } from 'zod';

// =============================================================================
// KAIA TRANSCRIPT TYPES
// =============================================================================

export const KaiaParticipantSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email().optional(),
  role: z.enum(['rep', 'prospect', 'other']).default('other'),
});

export type KaiaParticipant = z.infer<typeof KaiaParticipantSchema>;

export const KaiaTranscriptSegmentSchema = z.object({
  speakerId: z.string(),
  speakerName: z.string(),
  text: z.string(),
  startTime: z.number(), // seconds
  endTime: z.number(),
});

export type KaiaTranscriptSegment = z.infer<typeof KaiaTranscriptSegmentSchema>;

export const KaiaCallTranscriptSchema = z.object({
  callId: z.string(),
  externalCallId: z.string().optional(),
  title: z.string().optional(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  duration: z.number(), // seconds
  participants: z.array(KaiaParticipantSchema),
  transcript: z.array(KaiaTranscriptSegmentSchema),
  callType: z.enum(['inbound', 'outbound', 'scheduled']).default('outbound'),
  recordingUrl: z.string().url().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type KaiaCallTranscript = z.infer<typeof KaiaCallTranscriptSchema>;

export const KaiaWebhookPayloadSchema = z.object({
  event: z.enum(['call.completed', 'call.analyzed', 'call.transcribed']),
  timestamp: z.string().datetime(),
  data: KaiaCallTranscriptSchema,
  webhookId: z.string().optional(),
});

export type KaiaWebhookPayload = z.infer<typeof KaiaWebhookPayloadSchema>;

// =============================================================================
// CALL SIGNALS & OUTCOMES
// =============================================================================

export const CallSignalTypeSchema = z.enum([
  'LIVE_CONVERSATION',
  'INTEREST_EXPRESSED',
  'DEMO_SCHEDULED',
  'PRICING_DISCUSSED',
  'SEND_PRICING_REQUEST',
  'OBJECTION_RAISED',
  'OBJECTION_HANDLED',
  'DECISION_MAKER_IDENTIFIED',
  'NEXT_STEPS_DEFINED',
  'NO_ANSWER',
  'VOICEMAIL_LEFT',
  'WRONG_NUMBER',
  'GATEKEEPER',
  'NOT_INTERESTED',
  'COMPETITOR_MENTIONED',
  'BUDGET_DISCUSSED',
  'TIMELINE_DISCUSSED',
  'FOLLOW_UP_REQUESTED',
]);

export type CallSignalType = z.infer<typeof CallSignalTypeSchema>;

export const CallSignalSchema = z.object({
  type: CallSignalTypeSchema,
  confidence: z.number().min(0).max(1),
  evidence: z.string(), // The text that triggered this signal
  timestamp: z.number().optional(), // seconds into call
  metadata: z.record(z.unknown()).optional(),
});

export type CallSignal = z.infer<typeof CallSignalSchema>;

export const CallOutcomeSchema = z.enum([
  'CONNECTED_POSITIVE',
  'CONNECTED_NEUTRAL',
  'CONNECTED_NEGATIVE',
  'NO_CONNECT',
  'VOICEMAIL',
  'CALLBACK_SCHEDULED',
  'DEMO_BOOKED',
  'MEETING_BOOKED',
  'SENT_TO_NURTURE',
  'DISQUALIFIED',
]);

export type CallOutcome = z.infer<typeof CallOutcomeSchema>;

export const ExtractedCallDataSchema = z.object({
  callId: z.string(),
  signals: z.array(CallSignalSchema),
  primaryOutcome: CallOutcomeSchema,
  overallConfidence: z.number().min(0).max(1),
  duration: z.number(),
  talkRatio: z.object({
    rep: z.number(),
    prospect: z.number(),
  }).optional(),
  extractedAt: z.date(),
});

export type ExtractedCallData = z.infer<typeof ExtractedCallDataSchema>;

// =============================================================================
// OUTREACH STAGE MAPPING
// =============================================================================

export const OutreachStageSchema = z.enum([
  'NEW',
  'ATTEMPTED',
  'WORKING',
  'QUALIFIED',
  'DEMO_SCHEDULED',
  'PROPOSAL',
  'NEGOTIATION',
  'CLOSED_WON',
  'CLOSED_LOST',
  'NURTURE',
]);

export type OutreachStage = z.infer<typeof OutreachStageSchema>;

export const OutreachDispositionSchema = z.enum([
  'NO_ANSWER',
  'LEFT_VOICEMAIL',
  'WRONG_NUMBER',
  'GATEKEEPER_BLOCK',
  'NOT_INTERESTED',
  'CONNECTED',
  'DEMO_SCHEDULED',
  'MEETING_SCHEDULED',
  'SENT_INFO',
  'CALLBACK_SCHEDULED',
  'FOLLOW_UP',
]);

export type OutreachDisposition = z.infer<typeof OutreachDispositionSchema>;

export const StageMappingResultSchema = z.object({
  newStage: OutreachStageSchema,
  disposition: OutreachDispositionSchema.optional(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  flags: z.array(z.string()).default([]), // e.g., ['stall_flag', 'escalate_to_manager']
  requiresConfirmation: z.boolean(),
  suggestedTasks: z.array(z.string()).default([]),
});

export type StageMappingResult = z.infer<typeof StageMappingResultSchema>;

// =============================================================================
// CONFIDENCE ROUTING
// =============================================================================

export const ConfidenceLevelSchema = z.enum(['HIGH', 'MEDIUM', 'LOW']);

export type ConfidenceLevel = z.infer<typeof ConfidenceLevelSchema>;

export const ActionDecisionSchema = z.object({
  action: z.enum(['AUTO_UPDATE', 'FLAG_FOR_CONFIRMATION', 'NO_ACTION']),
  confidenceLevel: ConfidenceLevelSchema,
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

export type ActionDecision = z.infer<typeof ActionDecisionSchema>;

// =============================================================================
// OUTREACH API TYPES
// =============================================================================

export const OutreachProspectSchema = z.object({
  id: z.number(),
  email: z.string().email().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  title: z.string().optional(),
  company: z.string().optional(),
  stage: OutreachStageSchema.optional(),
  owner: z.object({
    id: z.number(),
    email: z.string().email(),
  }).optional(),
  customFields: z.record(z.unknown()).optional(),
});

export type OutreachProspect = z.infer<typeof OutreachProspectSchema>;

export const OutreachUpdatePayloadSchema = z.object({
  prospectId: z.number(),
  stage: OutreachStageSchema.optional(),
  disposition: OutreachDispositionSchema.optional(),
  customFields: z.record(z.unknown()).optional(),
  note: z.string().optional(),
  taskDescription: z.string().optional(),
});

export type OutreachUpdatePayload = z.infer<typeof OutreachUpdatePayloadSchema>;

export const OutreachUpdateResultSchema = z.object({
  success: z.boolean(),
  prospectId: z.number(),
  previousStage: OutreachStageSchema.optional(),
  newStage: OutreachStageSchema.optional(),
  updatedAt: z.date(),
  error: z.string().optional(),
});

export type OutreachUpdateResult = z.infer<typeof OutreachUpdateResultSchema>;

// =============================================================================
// AUDIT TYPES
// =============================================================================

export const AuditActionSchema = z.enum([
  'STAGE_CHANGE',
  'DISPOSITION_SET',
  'NOTE_ADDED',
  'TASK_CREATED',
  'FLAG_SET',
  'CONFIRMATION_REQUIRED',
  'ROLLBACK',
  'ERROR',
]);

export type AuditAction = z.infer<typeof AuditActionSchema>;

export const AuditEntrySchema = z.object({
  id: z.string(),
  timestamp: z.date(),
  callId: z.string(),
  prospectId: z.number().optional(),
  action: AuditActionSchema,
  previousValue: z.unknown().optional(),
  newValue: z.unknown().optional(),
  confidence: z.number().optional(),
  automated: z.boolean(),
  confirmedBy: z.string().optional(),
  rollbackOf: z.string().optional(), // Reference to audit entry being rolled back
  metadata: z.record(z.unknown()).optional(),
});

export type AuditEntry = z.infer<typeof AuditEntrySchema>;

// =============================================================================
// API WEBHOOK TYPES
// =============================================================================

export const WebhookResponseSchema = z.object({
  success: z.boolean(),
  callId: z.string(),
  processed: z.boolean(),
  stageUpdate: StageMappingResultSchema.optional(),
  auditId: z.string().optional(),
  error: z.string().optional(),
});

export type WebhookResponse = z.infer<typeof WebhookResponseSchema>;

// =============================================================================
// CONFIGURATION
// =============================================================================

export interface StageEngineConfig {
  highConfidenceThreshold: number; // default 0.8
  mediumConfidenceThreshold: number; // default 0.5
  enableAutoUpdate: boolean;
  enableFlagging: boolean;
  signalWeights: Partial<Record<CallSignalType, number>>;
}

export interface OutreachConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  accessToken?: string;
  refreshToken?: string;
}

export interface KaiaConfig {
  apiKey: string;
  webhookSecret: string;
}

export interface AuditConfig {
  retentionDays: number;
  enableRollback: boolean;
  logToFile: boolean;
  logFilePath?: string;
}
