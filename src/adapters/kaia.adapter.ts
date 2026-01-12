import crypto from 'crypto';
import {
  KaiaWebhookPayload,
  KaiaWebhookPayloadSchema,
  KaiaCallTranscript,
  KaiaConfig,
  CallSignal,
  CallSignalType,
  CallOutcome,
  ExtractedCallData,
} from '../types/crm-automation.js';
import { logger } from '../utils/logger.js';

// =============================================================================
// KAIA ADAPTER
// Receives and processes Kaia call transcripts via webhook
// =============================================================================

// Signal detection patterns with confidence weights
const SIGNAL_PATTERNS: Array<{
  type: CallSignalType;
  patterns: RegExp[];
  baseConfidence: number;
}> = [
  {
    type: 'LIVE_CONVERSATION',
    patterns: [
      /^(?!.*voicemail|.*leave.*message|.*not available)/i,
    ],
    baseConfidence: 0.9,
  },
  {
    type: 'INTEREST_EXPRESSED',
    patterns: [
      /\b(interested|sounds good|tell me more|curious|like to learn|want to know)\b/i,
      /\b(that's interesting|intriguing|appealing)\b/i,
      /\b(how does it work|what does it cost|can you explain)\b/i,
    ],
    baseConfidence: 0.75,
  },
  {
    type: 'DEMO_SCHEDULED',
    patterns: [
      /\b(schedule|book|set up).*(demo|demonstration|meeting|call)\b/i,
      /\b(let's.*find.*time|calendar|next week|tomorrow)\b/i,
      /\b(demo|meeting).*(scheduled|booked|confirmed)\b/i,
    ],
    baseConfidence: 0.85,
  },
  {
    type: 'PRICING_DISCUSSED',
    patterns: [
      /\b(price|pricing|cost|budget|investment|fee|rates)\b/i,
      /\b(how much|what.*cost|afford|expensive|cheap)\b/i,
      /\$\d+|\d+\s*dollars/i,
    ],
    baseConfidence: 0.8,
  },
  {
    type: 'SEND_PRICING_REQUEST',
    patterns: [
      /\b(send|email|forward).*(pricing|quote|proposal|info)\b/i,
      /\b(send me|email me|get me).*(information|details)\b/i,
      /\b(need.*think|discuss.*team|run.*by)\b/i,
    ],
    baseConfidence: 0.7,
  },
  {
    type: 'OBJECTION_RAISED',
    patterns: [
      /\b(not sure|don't know|concern|worried|hesitant)\b/i,
      /\b(too expensive|no budget|not.*right time|too busy)\b/i,
      /\b(already.*using|happy with|have.*solution)\b/i,
      /\b(need to think|consult|check with)\b/i,
    ],
    baseConfidence: 0.7,
  },
  {
    type: 'OBJECTION_HANDLED',
    patterns: [
      /\b(makes sense|understand now|good point|that helps)\b/i,
      /\b(i see|that clarifies|didn't realize)\b/i,
      /\b(okay|alright|fair enough).*(let's|so)\b/i,
    ],
    baseConfidence: 0.65,
  },
  {
    type: 'DECISION_MAKER_IDENTIFIED',
    patterns: [
      /\b(decision maker|final say|sign off|approve|authority)\b/i,
      /\b(i'm the|i am the|i make the|my decision)\b/i,
      /\b(ceo|cfo|vp|director|head of|owner|president)\b/i,
    ],
    baseConfidence: 0.75,
  },
  {
    type: 'NEXT_STEPS_DEFINED',
    patterns: [
      /\b(next step|follow up|get back|touch base|reconnect)\b/i,
      /\b(i'll|we'll|let's).*(call|email|send|schedule)\b/i,
      /\b(action item|to do|plan|move forward)\b/i,
    ],
    baseConfidence: 0.7,
  },
  {
    type: 'NO_ANSWER',
    patterns: [
      /\b(no answer|didn't.*pick up|unanswered|ring.*out)\b/i,
      /\b(unable to reach|couldn't connect|didn't respond)\b/i,
    ],
    baseConfidence: 0.95,
  },
  {
    type: 'VOICEMAIL_LEFT',
    patterns: [
      /\b(voicemail|leave.*message|message.*left|voice.*mail)\b/i,
      /\b(at the tone|after the beep|recording)\b/i,
      /\b(left.*message|dropped.*voicemail)\b/i,
    ],
    baseConfidence: 0.9,
  },
  {
    type: 'WRONG_NUMBER',
    patterns: [
      /\b(wrong number|no.*work.*here|never heard|don't know)\b/i,
      /\b(who\?|wrong person|not.*right)\b/i,
    ],
    baseConfidence: 0.85,
  },
  {
    type: 'GATEKEEPER',
    patterns: [
      /\b(assistant|receptionist|secretary|front desk)\b/i,
      /\b(not available|in.*meeting|out.*office|busy)\b/i,
      /\b(take.*message|call back|transfer)\b/i,
    ],
    baseConfidence: 0.7,
  },
  {
    type: 'NOT_INTERESTED',
    patterns: [
      /\b(not interested|no thank|no thanks|don't call|remove|unsubscribe)\b/i,
      /\b(don't need|not.*looking|not.*market)\b/i,
      /\b(please stop|never call|do not contact)\b/i,
    ],
    baseConfidence: 0.85,
  },
  {
    type: 'COMPETITOR_MENTIONED',
    patterns: [
      /\b(competitor|alternative|other vendor|other solution)\b/i,
      /\b(using.*already|have.*in place|current provider)\b/i,
      /\b(compared to|versus|vs\.?|better than)\b/i,
    ],
    baseConfidence: 0.7,
  },
  {
    type: 'BUDGET_DISCUSSED',
    patterns: [
      /\b(budget|allocated|spend|funds|fiscal)\b/i,
      /\b(quarter|year end|approval|procurement)\b/i,
    ],
    baseConfidence: 0.75,
  },
  {
    type: 'TIMELINE_DISCUSSED',
    patterns: [
      /\b(timeline|timeframe|when.*start|implement.*by)\b/i,
      /\b(q1|q2|q3|q4|next month|this year)\b/i,
      /\b(urgent|asap|soon|priority)\b/i,
    ],
    baseConfidence: 0.7,
  },
  {
    type: 'FOLLOW_UP_REQUESTED',
    patterns: [
      /\b(follow up|call back|reach out|contact.*later)\b/i,
      /\b(get back to|touch base|reconnect|circle back)\b/i,
    ],
    baseConfidence: 0.75,
  },
];

export class KaiaAdapter {
  private config: KaiaConfig;

  constructor(config: KaiaConfig) {
    this.config = config;
    logger.info('KaiaAdapter initialized');
  }

  // ===========================================================================
  // WEBHOOK VERIFICATION
  // ===========================================================================

  /**
   * Verify webhook signature from Kaia
   * Uses HMAC-SHA256 with the webhook secret
   */
  verifyWebhookSignature(payload: string, signature: string): boolean {
    try {
      const expectedSignature = crypto
        .createHmac('sha256', this.config.webhookSecret)
        .update(payload)
        .digest('hex');

      // Use timing-safe comparison to prevent timing attacks
      const signatureBuffer = Buffer.from(signature, 'hex');
      const expectedBuffer = Buffer.from(expectedSignature, 'hex');

      if (signatureBuffer.length !== expectedBuffer.length) {
        logger.warn('Webhook signature length mismatch');
        return false;
      }

      const isValid = crypto.timingSafeEqual(signatureBuffer, expectedBuffer);

      if (!isValid) {
        logger.warn('Invalid webhook signature');
      }

      return isValid;
    } catch (error) {
      logger.error({ error }, 'Error verifying webhook signature');
      return false;
    }
  }

  // ===========================================================================
  // WEBHOOK PAYLOAD PARSING
  // ===========================================================================

  /**
   * Parse and validate incoming webhook payload
   */
  parseWebhookPayload(rawPayload: unknown): KaiaWebhookPayload | null {
    try {
      const result = KaiaWebhookPayloadSchema.safeParse(rawPayload);

      if (!result.success) {
        logger.warn({ errors: result.error.issues }, 'Invalid webhook payload');
        return null;
      }

      logger.info({ event: result.data.event, callId: result.data.data.callId }, 'Webhook payload parsed');
      return result.data;
    } catch (error) {
      logger.error({ error }, 'Error parsing webhook payload');
      return null;
    }
  }

  // ===========================================================================
  // SIGNAL EXTRACTION
  // ===========================================================================

  /**
   * Extract call signals from transcript
   * Analyzes the full transcript and identifies relevant signals
   */
  extractSignals(transcript: KaiaCallTranscript): CallSignal[] {
    const signals: CallSignal[] = [];
    const fullText = transcript.transcript.map((s) => s.text).join(' ');

    logger.debug({ callId: transcript.callId }, 'Extracting signals from transcript');

    // Check if this was a live conversation (has meaningful exchanges)
    const hasMultipleSpeakers = new Set(transcript.transcript.map((s) => s.speakerId)).size > 1;
    const hasMeaningfulLength = transcript.duration > 30; // At least 30 seconds

    if (hasMultipleSpeakers && hasMeaningfulLength) {
      signals.push({
        type: 'LIVE_CONVERSATION',
        confidence: 0.95,
        evidence: `Call duration: ${transcript.duration}s with ${transcript.participants.length} participants`,
      });
    }

    // Process each segment for signals
    for (const segment of transcript.transcript) {
      for (const pattern of SIGNAL_PATTERNS) {
        // Skip LIVE_CONVERSATION as we handle it separately
        if (pattern.type === 'LIVE_CONVERSATION') continue;

        for (const regex of pattern.patterns) {
          if (regex.test(segment.text)) {
            // Check if we already have this signal type
            const existingSignal = signals.find((s) => s.type === pattern.type);

            if (existingSignal) {
              // Boost confidence if signal appears multiple times
              existingSignal.confidence = Math.min(existingSignal.confidence + 0.1, 1);
              existingSignal.evidence += ` | ${segment.text.substring(0, 100)}`;
            } else {
              signals.push({
                type: pattern.type,
                confidence: pattern.baseConfidence,
                evidence: segment.text.substring(0, 200),
                timestamp: segment.startTime,
              });
            }
            break; // Only match first pattern per type per segment
          }
        }
      }
    }

    // Check full text for patterns that might span segments
    for (const pattern of SIGNAL_PATTERNS) {
      if (signals.some((s) => s.type === pattern.type)) continue;

      for (const regex of pattern.patterns) {
        const match = fullText.match(regex);
        if (match) {
          signals.push({
            type: pattern.type,
            confidence: pattern.baseConfidence * 0.8, // Slightly lower confidence for full-text matches
            evidence: match[0].substring(0, 200),
          });
          break;
        }
      }
    }

    logger.info(
      { callId: transcript.callId, signalCount: signals.length },
      'Signals extracted'
    );

    return signals;
  }

  // ===========================================================================
  // OUTCOME DETERMINATION
  // ===========================================================================

  /**
   * Determine the primary call outcome based on extracted signals
   */
  determineOutcome(signals: CallSignal[]): CallOutcome {
    const signalTypes = new Set(signals.map((s) => s.type));

    // Priority-based outcome determination
    if (signalTypes.has('DEMO_SCHEDULED')) {
      return 'DEMO_BOOKED';
    }

    if (signalTypes.has('NEXT_STEPS_DEFINED') || signalTypes.has('FOLLOW_UP_REQUESTED')) {
      return 'CALLBACK_SCHEDULED';
    }

    if (signalTypes.has('NOT_INTERESTED')) {
      return 'DISQUALIFIED';
    }

    if (signalTypes.has('VOICEMAIL_LEFT')) {
      return 'VOICEMAIL';
    }

    if (signalTypes.has('NO_ANSWER') || signalTypes.has('WRONG_NUMBER')) {
      return 'NO_CONNECT';
    }

    if (signalTypes.has('SEND_PRICING_REQUEST')) {
      return 'SENT_TO_NURTURE';
    }

    if (signalTypes.has('LIVE_CONVERSATION')) {
      if (signalTypes.has('INTEREST_EXPRESSED') || signalTypes.has('PRICING_DISCUSSED')) {
        return 'CONNECTED_POSITIVE';
      }
      if (signalTypes.has('OBJECTION_RAISED') && !signalTypes.has('OBJECTION_HANDLED')) {
        return 'CONNECTED_NEGATIVE';
      }
      return 'CONNECTED_NEUTRAL';
    }

    return 'NO_CONNECT';
  }

  // ===========================================================================
  // FULL EXTRACTION PIPELINE
  // ===========================================================================

  /**
   * Extract all relevant data from a Kaia call transcript
   */
  extractCallData(transcript: KaiaCallTranscript): ExtractedCallData {
    logger.info({ callId: transcript.callId }, 'Starting full call data extraction');

    const signals = this.extractSignals(transcript);
    const primaryOutcome = this.determineOutcome(signals);

    // Calculate overall confidence
    const avgConfidence =
      signals.length > 0
        ? signals.reduce((sum, s) => sum + s.confidence, 0) / signals.length
        : 0.5;

    // Calculate talk ratio if possible
    let talkRatio: { rep: number; prospect: number } | undefined;

    const repParticipant = transcript.participants.find((p) => p.role === 'rep');
    const prospectParticipant = transcript.participants.find((p) => p.role === 'prospect');

    if (repParticipant && prospectParticipant) {
      const repTime = transcript.transcript
        .filter((s) => s.speakerId === repParticipant.id)
        .reduce((sum, s) => sum + (s.endTime - s.startTime), 0);

      const prospectTime = transcript.transcript
        .filter((s) => s.speakerId === prospectParticipant.id)
        .reduce((sum, s) => sum + (s.endTime - s.startTime), 0);

      const totalTime = repTime + prospectTime;
      if (totalTime > 0) {
        talkRatio = {
          rep: Math.round((repTime / totalTime) * 100),
          prospect: Math.round((prospectTime / totalTime) * 100),
        };
      }
    }

    const extractedData: ExtractedCallData = {
      callId: transcript.callId,
      signals,
      primaryOutcome,
      overallConfidence: avgConfidence,
      duration: transcript.duration,
      talkRatio,
      extractedAt: new Date(),
    };

    logger.info(
      {
        callId: transcript.callId,
        outcome: primaryOutcome,
        signalCount: signals.length,
        confidence: avgConfidence,
      },
      'Call data extraction complete'
    );

    return extractedData;
  }

  // ===========================================================================
  // UTILITY METHODS
  // ===========================================================================

  /**
   * Get transcript summary for logging/audit purposes
   */
  getTranscriptSummary(transcript: KaiaCallTranscript): string {
    const participantNames = transcript.participants.map((p) => p.name).join(', ');
    const durationMin = Math.round(transcript.duration / 60);
    const segmentCount = transcript.transcript.length;

    return `Call ${transcript.callId}: ${participantNames} (${durationMin}min, ${segmentCount} segments)`;
  }
}
