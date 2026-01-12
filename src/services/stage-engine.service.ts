import {
  ExtractedCallData,
  CallSignal,
  CallSignalType,
  CallOutcome,
  StageMappingResult,
  OutreachStage,
  OutreachDisposition,
  ActionDecision,
  ConfidenceLevel,
  StageEngineConfig,
} from '../types/crm-automation.js';
import { logger } from '../utils/logger.js';

// =============================================================================
// STAGE ENGINE SERVICE
// Decision engine that maps call signals to Outreach stages and dispositions
// =============================================================================

// Default signal weights (can be overridden via config)
const DEFAULT_SIGNAL_WEIGHTS: Record<CallSignalType, number> = {
  LIVE_CONVERSATION: 1.0,
  INTEREST_EXPRESSED: 1.2,
  DEMO_SCHEDULED: 1.5,
  PRICING_DISCUSSED: 1.3,
  SEND_PRICING_REQUEST: 1.0,
  OBJECTION_RAISED: 0.8,
  OBJECTION_HANDLED: 1.1,
  DECISION_MAKER_IDENTIFIED: 1.2,
  NEXT_STEPS_DEFINED: 1.1,
  NO_ANSWER: 0.9,
  VOICEMAIL_LEFT: 0.9,
  WRONG_NUMBER: 1.0,
  GATEKEEPER: 0.8,
  NOT_INTERESTED: 1.0,
  COMPETITOR_MENTIONED: 0.9,
  BUDGET_DISCUSSED: 1.1,
  TIMELINE_DISCUSSED: 1.1,
  FOLLOW_UP_REQUESTED: 1.0,
};

// Stage transition rules based on signal combinations
interface StageRule {
  conditions: {
    requiredSignals?: CallSignalType[];
    anySignals?: CallSignalType[];
    excludeSignals?: CallSignalType[];
    minConfidence?: number;
  };
  result: {
    stage: OutreachStage;
    disposition?: OutreachDisposition;
    flags?: string[];
    suggestedTasks?: string[];
  };
  priority: number; // Higher priority rules are evaluated first
}

const STAGE_RULES: StageRule[] = [
  // Demo Scheduled - highest priority
  {
    conditions: {
      anySignals: ['DEMO_SCHEDULED'],
      minConfidence: 0.6,
    },
    result: {
      stage: 'DEMO_SCHEDULED',
      disposition: 'DEMO_SCHEDULED',
      suggestedTasks: ['Confirm demo meeting details', 'Send calendar invite'],
    },
    priority: 100,
  },

  // Not Interested - disqualify
  {
    conditions: {
      anySignals: ['NOT_INTERESTED'],
      minConfidence: 0.7,
    },
    result: {
      stage: 'CLOSED_LOST',
      disposition: 'NOT_INTERESTED',
      flags: ['disqualified'],
    },
    priority: 95,
  },

  // Wrong Number - cleanup
  {
    conditions: {
      anySignals: ['WRONG_NUMBER'],
      minConfidence: 0.8,
    },
    result: {
      stage: 'CLOSED_LOST',
      disposition: 'WRONG_NUMBER',
      flags: ['data_quality_issue'],
      suggestedTasks: ['Verify contact information'],
    },
    priority: 94,
  },

  // Pricing discussed + interest = Proposal stage
  {
    conditions: {
      requiredSignals: ['PRICING_DISCUSSED'],
      anySignals: ['INTEREST_EXPRESSED', 'BUDGET_DISCUSSED'],
      minConfidence: 0.6,
    },
    result: {
      stage: 'PROPOSAL',
      disposition: 'CONNECTED',
      suggestedTasks: ['Prepare proposal', 'Send pricing document'],
    },
    priority: 85,
  },

  // "Send pricing" request - Negotiation with stall flag
  {
    conditions: {
      anySignals: ['SEND_PRICING_REQUEST'],
      excludeSignals: ['DEMO_SCHEDULED', 'NOT_INTERESTED'],
      minConfidence: 0.5,
    },
    result: {
      stage: 'NEGOTIATION',
      disposition: 'SENT_INFO',
      flags: ['stall_flag', 'needs_follow_up'],
      suggestedTasks: ['Send pricing information', 'Schedule follow-up call in 3 days'],
    },
    priority: 80,
  },

  // Live conversation with interest = Qualified
  {
    conditions: {
      requiredSignals: ['LIVE_CONVERSATION'],
      anySignals: ['INTEREST_EXPRESSED', 'DECISION_MAKER_IDENTIFIED'],
      excludeSignals: ['NOT_INTERESTED'],
      minConfidence: 0.6,
    },
    result: {
      stage: 'QUALIFIED',
      disposition: 'CONNECTED',
      suggestedTasks: ['Schedule follow-up'],
    },
    priority: 75,
  },

  // Objection handled = Working
  {
    conditions: {
      requiredSignals: ['OBJECTION_HANDLED'],
      anySignals: ['LIVE_CONVERSATION'],
      minConfidence: 0.5,
    },
    result: {
      stage: 'WORKING',
      disposition: 'CONNECTED',
      suggestedTasks: ['Continue nurturing relationship'],
    },
    priority: 70,
  },

  // Objection raised but not handled - needs attention
  {
    conditions: {
      requiredSignals: ['OBJECTION_RAISED'],
      excludeSignals: ['OBJECTION_HANDLED', 'DEMO_SCHEDULED'],
      minConfidence: 0.5,
    },
    result: {
      stage: 'WORKING',
      disposition: 'FOLLOW_UP',
      flags: ['objection_unresolved', 'needs_coaching_review'],
      suggestedTasks: ['Address objection in follow-up', 'Review call with manager'],
    },
    priority: 65,
  },

  // Live conversation, neutral outcome
  {
    conditions: {
      requiredSignals: ['LIVE_CONVERSATION'],
      excludeSignals: ['NOT_INTERESTED', 'WRONG_NUMBER'],
      minConfidence: 0.5,
    },
    result: {
      stage: 'WORKING',
      disposition: 'CONNECTED',
    },
    priority: 60,
  },

  // Follow-up requested/scheduled
  {
    conditions: {
      anySignals: ['FOLLOW_UP_REQUESTED', 'NEXT_STEPS_DEFINED'],
      excludeSignals: ['NOT_INTERESTED'],
      minConfidence: 0.5,
    },
    result: {
      stage: 'WORKING',
      disposition: 'CALLBACK_SCHEDULED',
      suggestedTasks: ['Schedule follow-up call'],
    },
    priority: 55,
  },

  // Voicemail left
  {
    conditions: {
      anySignals: ['VOICEMAIL_LEFT'],
      minConfidence: 0.7,
    },
    result: {
      stage: 'ATTEMPTED',
      disposition: 'LEFT_VOICEMAIL',
      suggestedTasks: ['Schedule next call attempt'],
    },
    priority: 50,
  },

  // No answer
  {
    conditions: {
      anySignals: ['NO_ANSWER'],
      minConfidence: 0.7,
    },
    result: {
      stage: 'ATTEMPTED',
      disposition: 'NO_ANSWER',
      suggestedTasks: ['Schedule next call attempt'],
    },
    priority: 45,
  },

  // Gatekeeper - attempted
  {
    conditions: {
      anySignals: ['GATEKEEPER'],
      excludeSignals: ['LIVE_CONVERSATION'],
      minConfidence: 0.6,
    },
    result: {
      stage: 'ATTEMPTED',
      disposition: 'GATEKEEPER_BLOCK',
      flags: ['gatekeeper_encountered'],
      suggestedTasks: ['Try different approach', 'Research direct contact info'],
    },
    priority: 40,
  },
];

export class StageEngineService {
  private config: StageEngineConfig;
  private signalWeights: Record<CallSignalType, number>;

  constructor(config?: Partial<StageEngineConfig>) {
    this.config = {
      highConfidenceThreshold: config?.highConfidenceThreshold ?? 0.8,
      mediumConfidenceThreshold: config?.mediumConfidenceThreshold ?? 0.5,
      enableAutoUpdate: config?.enableAutoUpdate ?? true,
      enableFlagging: config?.enableFlagging ?? true,
      signalWeights: config?.signalWeights ?? {},
    };

    // Merge custom signal weights with defaults
    this.signalWeights = {
      ...DEFAULT_SIGNAL_WEIGHTS,
      ...this.config.signalWeights,
    };

    logger.info('StageEngineService initialized');
  }

  // ===========================================================================
  // MAIN MAPPING LOGIC
  // ===========================================================================

  /**
   * Map extracted call data to Outreach stage and disposition
   */
  mapToStage(callData: ExtractedCallData): StageMappingResult {
    logger.info(
      { callId: callData.callId, signalCount: callData.signals.length },
      'Mapping call data to stage'
    );

    // Sort rules by priority (highest first)
    const sortedRules = [...STAGE_RULES].sort((a, b) => b.priority - a.priority);

    // Try each rule in priority order
    for (const rule of sortedRules) {
      const match = this.evaluateRule(rule, callData.signals);
      if (match) {
        const confidence = this.calculateConfidence(callData.signals, rule);
        const actionDecision = this.getActionDecision(confidence);

        const result: StageMappingResult = {
          newStage: rule.result.stage,
          disposition: rule.result.disposition,
          confidence,
          reasoning: this.generateReasoning(rule, callData.signals),
          flags: rule.result.flags || [],
          requiresConfirmation: actionDecision.action === 'FLAG_FOR_CONFIRMATION',
          suggestedTasks: rule.result.suggestedTasks || [],
        };

        logger.info(
          {
            callId: callData.callId,
            stage: result.newStage,
            confidence,
            requiresConfirmation: result.requiresConfirmation,
          },
          'Stage mapping complete'
        );

        return result;
      }
    }

    // No rule matched - return default
    logger.warn({ callId: callData.callId }, 'No stage rule matched, using default');

    return {
      newStage: 'WORKING',
      confidence: 0.3,
      reasoning: 'No specific stage rule matched. Defaulting to Working stage.',
      flags: ['needs_manual_review'],
      requiresConfirmation: true,
      suggestedTasks: ['Review call recording and update stage manually'],
    };
  }

  // ===========================================================================
  // RULE EVALUATION
  // ===========================================================================

  /**
   * Evaluate if a rule's conditions are met
   */
  private evaluateRule(rule: StageRule, signals: CallSignal[]): boolean {
    const signalTypes = new Set(signals.map((s) => s.type));
    const { conditions } = rule;

    // Check required signals (all must be present)
    if (conditions.requiredSignals) {
      const allRequired = conditions.requiredSignals.every((type) =>
        signalTypes.has(type)
      );
      if (!allRequired) return false;
    }

    // Check any signals (at least one must be present)
    if (conditions.anySignals) {
      const hasAny = conditions.anySignals.some((type) => signalTypes.has(type));
      if (!hasAny) return false;
    }

    // Check excluded signals (none should be present)
    if (conditions.excludeSignals) {
      const hasExcluded = conditions.excludeSignals.some((type) =>
        signalTypes.has(type)
      );
      if (hasExcluded) return false;
    }

    // Check minimum confidence
    if (conditions.minConfidence !== undefined) {
      const relevantSignals = signals.filter((s) => {
        if (conditions.requiredSignals?.includes(s.type)) return true;
        if (conditions.anySignals?.includes(s.type)) return true;
        return false;
      });

      if (relevantSignals.length > 0) {
        const avgConfidence =
          relevantSignals.reduce((sum, s) => sum + s.confidence, 0) /
          relevantSignals.length;
        if (avgConfidence < conditions.minConfidence) return false;
      }
    }

    return true;
  }

  // ===========================================================================
  // CONFIDENCE CALCULATION
  // ===========================================================================

  /**
   * Calculate overall confidence for a stage mapping
   */
  private calculateConfidence(signals: CallSignal[], rule: StageRule): number {
    // Get signals that contributed to this rule matching
    const relevantSignals = signals.filter((s) => {
      if (rule.conditions.requiredSignals?.includes(s.type)) return true;
      if (rule.conditions.anySignals?.includes(s.type)) return true;
      return false;
    });

    if (relevantSignals.length === 0) {
      return 0.5; // Base confidence when no specific signals
    }

    // Calculate weighted average confidence
    let totalWeight = 0;
    let weightedSum = 0;

    for (const signal of relevantSignals) {
      const weight = this.signalWeights[signal.type] || 1.0;
      weightedSum += signal.confidence * weight;
      totalWeight += weight;
    }

    const baseConfidence = weightedSum / totalWeight;

    // Boost confidence if multiple corroborating signals
    const signalCountBoost = Math.min(relevantSignals.length * 0.05, 0.15);

    // Apply priority boost (higher priority rules = slightly higher confidence)
    const priorityBoost = (rule.priority / 100) * 0.1;

    const finalConfidence = Math.min(
      baseConfidence + signalCountBoost + priorityBoost,
      1.0
    );

    return Math.round(finalConfidence * 100) / 100; // Round to 2 decimal places
  }

  // ===========================================================================
  // ACTION DECISION
  // ===========================================================================

  /**
   * Determine what action to take based on confidence level
   */
  getActionDecision(confidence: number): ActionDecision {
    if (confidence >= this.config.highConfidenceThreshold) {
      return {
        action: this.config.enableAutoUpdate ? 'AUTO_UPDATE' : 'FLAG_FOR_CONFIRMATION',
        confidenceLevel: 'HIGH',
        confidence,
        reason: `High confidence (${(confidence * 100).toFixed(0)}%) - automatic update${
          this.config.enableAutoUpdate ? ' enabled' : ' disabled'
        }`,
      };
    }

    if (confidence >= this.config.mediumConfidenceThreshold) {
      return {
        action: this.config.enableFlagging ? 'FLAG_FOR_CONFIRMATION' : 'NO_ACTION',
        confidenceLevel: 'MEDIUM',
        confidence,
        reason: `Medium confidence (${(confidence * 100).toFixed(0)}%) - ${
          this.config.enableFlagging ? 'flagged for rep confirmation' : 'no action taken'
        }`,
      };
    }

    return {
      action: 'NO_ACTION',
      confidenceLevel: 'LOW',
      confidence,
      reason: `Low confidence (${(confidence * 100).toFixed(0)}%) - no automated action`,
    };
  }

  /**
   * Check if stage should be auto-updated
   */
  shouldAutoUpdate(confidence: number): boolean {
    return (
      this.config.enableAutoUpdate &&
      confidence >= this.config.highConfidenceThreshold
    );
  }

  /**
   * Check if stage change needs confirmation
   */
  needsConfirmation(confidence: number): boolean {
    return (
      confidence >= this.config.mediumConfidenceThreshold &&
      confidence < this.config.highConfidenceThreshold
    );
  }

  // ===========================================================================
  // REASONING GENERATION
  // ===========================================================================

  /**
   * Generate human-readable reasoning for stage mapping
   */
  private generateReasoning(rule: StageRule, signals: CallSignal[]): string {
    const matchedSignals = signals.filter((s) => {
      if (rule.conditions.requiredSignals?.includes(s.type)) return true;
      if (rule.conditions.anySignals?.includes(s.type)) return true;
      return false;
    });

    const signalDescriptions = matchedSignals
      .map((s) => `${this.formatSignalType(s.type)} (${(s.confidence * 100).toFixed(0)}%)`)
      .join(', ');

    let reasoning = `Mapped to ${rule.result.stage}`;

    if (rule.result.disposition) {
      reasoning += ` with disposition ${rule.result.disposition}`;
    }

    reasoning += `. Triggered by: ${signalDescriptions}.`;

    if (rule.result.flags && rule.result.flags.length > 0) {
      reasoning += ` Flags: ${rule.result.flags.join(', ')}.`;
    }

    return reasoning;
  }

  /**
   * Format signal type to human-readable string
   */
  private formatSignalType(type: CallSignalType): string {
    return type
      .replace(/_/g, ' ')
      .toLowerCase()
      .replace(/\b\w/g, (l) => l.toUpperCase());
  }

  // ===========================================================================
  // STAGE TRANSITION VALIDATION
  // ===========================================================================

  /**
   * Validate if a stage transition is allowed
   */
  isValidTransition(
    currentStage: OutreachStage,
    newStage: OutreachStage
  ): boolean {
    // Define valid transitions
    const validTransitions: Record<OutreachStage, OutreachStage[]> = {
      NEW: ['ATTEMPTED', 'WORKING', 'QUALIFIED', 'DEMO_SCHEDULED', 'CLOSED_LOST', 'NURTURE'],
      ATTEMPTED: ['WORKING', 'QUALIFIED', 'DEMO_SCHEDULED', 'CLOSED_LOST', 'NURTURE'],
      WORKING: ['QUALIFIED', 'DEMO_SCHEDULED', 'PROPOSAL', 'CLOSED_LOST', 'NURTURE'],
      QUALIFIED: ['DEMO_SCHEDULED', 'PROPOSAL', 'NEGOTIATION', 'CLOSED_LOST', 'NURTURE'],
      DEMO_SCHEDULED: ['PROPOSAL', 'NEGOTIATION', 'CLOSED_WON', 'CLOSED_LOST', 'NURTURE'],
      PROPOSAL: ['NEGOTIATION', 'CLOSED_WON', 'CLOSED_LOST', 'NURTURE'],
      NEGOTIATION: ['CLOSED_WON', 'CLOSED_LOST', 'NURTURE'],
      CLOSED_WON: [], // Terminal state
      CLOSED_LOST: ['WORKING', 'NURTURE'], // Can be reopened
      NURTURE: ['WORKING', 'QUALIFIED', 'DEMO_SCHEDULED'], // Can be re-engaged
    };

    // Same stage is always valid
    if (currentStage === newStage) return true;

    return validTransitions[currentStage]?.includes(newStage) ?? false;
  }

  // ===========================================================================
  // CONFIGURATION
  // ===========================================================================

  /**
   * Update configuration
   */
  updateConfig(config: Partial<StageEngineConfig>): void {
    this.config = { ...this.config, ...config };

    if (config.signalWeights) {
      this.signalWeights = {
        ...DEFAULT_SIGNAL_WEIGHTS,
        ...config.signalWeights,
      };
    }

    logger.info('StageEngineService configuration updated');
  }

  /**
   * Get current configuration
   */
  getConfig(): StageEngineConfig {
    return { ...this.config };
  }
}
