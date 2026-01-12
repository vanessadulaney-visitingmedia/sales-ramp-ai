import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger.js';
import {
  StallSignal,
  StallStatus,
  StallPhraseMatch,
  StallPhraseCategory,
  StallSeverity,
  StallSignalSource,
  DealStage,
  CallTranscript,
  EmailContent,
} from '../types/stall.js';

// =============================================================================
// STALL DETECTOR SERVICE
// Core detection logic for identifying stalled deals
// =============================================================================

// =============================================================================
// PHRASE PATTERNS CONFIGURATION
// =============================================================================

interface PhrasePattern {
  pattern: RegExp;
  category: StallPhraseCategory;
  baseConfidence: number; // 0-1, how strong an indicator this phrase is
  phraseLabel: string; // Human-readable version
}

const STALL_PATTERNS: PhrasePattern[] = [
  // PRICING_REQUEST - Often indicates buyer is shopping or delaying
  {
    pattern: /\b(send|email|get)\s+(me\s+)?(the\s+)?(pricing|price\s*list|quote|proposal)\b/i,
    category: 'PRICING_REQUEST',
    baseConfidence: 0.6,
    phraseLabel: 'send pricing',
  },
  {
    pattern: /\bwhat('s|\s+is)\s+(the\s+)?(price|cost|pricing)\b/i,
    category: 'PRICING_REQUEST',
    baseConfidence: 0.4,
    phraseLabel: 'price inquiry',
  },
  {
    pattern: /\bjust\s+send\s+(me\s+)?(the\s+)?pricing\b/i,
    category: 'PRICING_REQUEST',
    baseConfidence: 0.8,
    phraseLabel: 'just send pricing',
  },

  // APPROVAL_NEEDED - Budget or authority constraints
  {
    pattern: /\b(need|have)\s+to\s+(get\s+)?approval\b/i,
    category: 'APPROVAL_NEEDED',
    baseConfidence: 0.75,
    phraseLabel: 'need to get approval',
  },
  {
    pattern: /\bneed\s+(my\s+)?(boss|manager|director|vp|cfo|ceo)('s)?\s+approval\b/i,
    category: 'APPROVAL_NEEDED',
    baseConfidence: 0.8,
    phraseLabel: 'need executive approval',
  },
  {
    pattern: /\bwait(ing)?\s+for\s+approval\b/i,
    category: 'APPROVAL_NEEDED',
    baseConfidence: 0.7,
    phraseLabel: 'waiting for approval',
  },
  {
    pattern: /\bnot\s+in\s+(the\s+)?budget\b/i,
    category: 'APPROVAL_NEEDED',
    baseConfidence: 0.85,
    phraseLabel: 'not in budget',
  },

  // THINKING - Classic delay tactic
  {
    pattern: /\blet\s+me\s+think\s+(about\s+it|on\s+it|it\s+over)\b/i,
    category: 'THINKING',
    baseConfidence: 0.7,
    phraseLabel: 'let me think about it',
  },
  {
    pattern: /\b(i\s+)?need\s+(some\s+)?time\s+to\s+think\b/i,
    category: 'THINKING',
    baseConfidence: 0.65,
    phraseLabel: 'need time to think',
  },
  {
    pattern: /\bgive\s+(me|us)\s+(some\s+)?time\s+to\s+(think|consider|evaluate)\b/i,
    category: 'THINKING',
    baseConfidence: 0.7,
    phraseLabel: 'give us time to consider',
  },

  // TEAM_CHECK - Consensus building / potential blockers
  {
    pattern: /\b(need\s+to\s+)?check\s+with\s+(my\s+)?team\b/i,
    category: 'TEAM_CHECK',
    baseConfidence: 0.6,
    phraseLabel: 'check with my team',
  },
  {
    pattern: /\brun\s+(it|this)\s+by\s+(my\s+)?team\b/i,
    category: 'TEAM_CHECK',
    baseConfidence: 0.6,
    phraseLabel: 'run by team',
  },
  {
    pattern: /\bget\s+(my\s+)?team('s)?\s+(buy-in|input|feedback)\b/i,
    category: 'TEAM_CHECK',
    baseConfidence: 0.65,
    phraseLabel: 'get team buy-in',
  },
  {
    pattern: /\bdiscuss\s+(it\s+)?with\s+(the\s+)?team\b/i,
    category: 'TEAM_CHECK',
    baseConfidence: 0.55,
    phraseLabel: 'discuss with team',
  },

  // DECISION_MAKER - Not talking to the right person
  {
    pattern: /\b(need\s+to\s+)?talk\s+to\s+(my\s+)?(boss|manager|director|vp|cfo|ceo|owner|partner)\b/i,
    category: 'DECISION_MAKER',
    baseConfidence: 0.8,
    phraseLabel: 'talk to decision maker',
  },
  {
    pattern: /\b(my\s+)?(boss|manager|director|vp|cfo|ceo)\s+(makes|handles|decides)\b/i,
    category: 'DECISION_MAKER',
    baseConfidence: 0.75,
    phraseLabel: 'executive decides',
  },
  {
    pattern: /\bi('m|\s+am)\s+not\s+the\s+(decision\s*maker|one\s+who\s+decides)\b/i,
    category: 'DECISION_MAKER',
    baseConfidence: 0.9,
    phraseLabel: 'not the decision maker',
  },
  {
    pattern: /\bsomeone\s+else\s+(makes|handles)\s+(that\s+)?decision\b/i,
    category: 'DECISION_MAKER',
    baseConfidence: 0.85,
    phraseLabel: 'someone else decides',
  },

  // CALLBACK_REQUEST - Pushing out timeline
  {
    pattern: /\bcall\s+(me\s+)?back\s+(next\s+)?(week|month|quarter)\b/i,
    category: 'CALLBACK_REQUEST',
    baseConfidence: 0.75,
    phraseLabel: 'call back later',
  },
  {
    pattern: /\b(reach\s+out|follow\s+up|get\s+back\s+to\s+me)\s+(next\s+)?(week|month|quarter)\b/i,
    category: 'CALLBACK_REQUEST',
    baseConfidence: 0.7,
    phraseLabel: 'follow up later',
  },
  {
    pattern: /\btouch\s+base\s+(in\s+)?a\s+(few\s+)?(weeks?|months?)\b/i,
    category: 'CALLBACK_REQUEST',
    baseConfidence: 0.7,
    phraseLabel: 'touch base in weeks/months',
  },
  {
    pattern: /\bnot\s+(a\s+good|the\s+right)\s+time\b/i,
    category: 'CALLBACK_REQUEST',
    baseConfidence: 0.8,
    phraseLabel: 'not the right time',
  },
  {
    pattern: /\bmaybe\s+(next\s+)?(quarter|year)\b/i,
    category: 'CALLBACK_REQUEST',
    baseConfidence: 0.85,
    phraseLabel: 'maybe next quarter/year',
  },

  // FOLLOWUP_PROMISE - Vague commitments
  {
    pattern: /\bwe('ll|\s+will)\s+get\s+back\s+to\s+you\b/i,
    category: 'FOLLOWUP_PROMISE',
    baseConfidence: 0.65,
    phraseLabel: "we'll get back to you",
  },
  {
    pattern: /\bi('ll|\s+will)\s+(let\s+you\s+know|be\s+in\s+touch)\b/i,
    category: 'FOLLOWUP_PROMISE',
    baseConfidence: 0.6,
    phraseLabel: "I'll let you know",
  },
  {
    pattern: /\bwe('ll|\s+will)\s+(reach\s+out|contact\s+you)\s+(when|if)\b/i,
    category: 'FOLLOWUP_PROMISE',
    baseConfidence: 0.7,
    phraseLabel: "we'll contact you when...",
  },

  // INTERNAL_DISCUSSION - Internal process delays
  {
    pattern: /\bneed\s+to\s+discuss\s+(this\s+)?internally\b/i,
    category: 'INTERNAL_DISCUSSION',
    baseConfidence: 0.7,
    phraseLabel: 'need to discuss internally',
  },
  {
    pattern: /\bhave\s+(some\s+)?internal\s+(discussions?|meetings?|reviews?)\b/i,
    category: 'INTERNAL_DISCUSSION',
    baseConfidence: 0.65,
    phraseLabel: 'internal discussions',
  },
  {
    pattern: /\b(taking|take)\s+(it|this)\s+to\s+(our\s+)?(internal|leadership|board)\b/i,
    category: 'INTERNAL_DISCUSSION',
    baseConfidence: 0.7,
    phraseLabel: 'taking to leadership',
  },
  {
    pattern: /\bgoing\s+through\s+(our\s+)?(internal\s+)?process\b/i,
    category: 'INTERNAL_DISCUSSION',
    baseConfidence: 0.6,
    phraseLabel: 'going through process',
  },
];

// =============================================================================
// RECOMMENDED ACTIONS BY CATEGORY
// =============================================================================

const RECOMMENDED_ACTIONS: Record<StallPhraseCategory, string[]> = {
  PRICING_REQUEST: [
    'Schedule a pricing review call to discuss value, not just cost',
    'Send ROI calculator with the pricing to justify investment',
    'Ask what specific budget constraints they are working within',
  ],
  APPROVAL_NEEDED: [
    'Offer to join the approval conversation to address concerns directly',
    'Provide executive summary document for the approver',
    'Ask to understand the approval process and timeline',
  ],
  THINKING: [
    'Set a specific follow-up date and time',
    'Ask what specific aspects they need to think about',
    'Offer additional resources or references to help evaluation',
  ],
  TEAM_CHECK: [
    'Offer to present to the full team',
    'Provide team-ready materials and ROI documentation',
    'Identify potential champions and blockers within the team',
  ],
  DECISION_MAKER: [
    'Request introduction to the decision maker',
    'Offer executive-to-executive conversation',
    'Provide materials specifically designed for executive review',
  ],
  CALLBACK_REQUEST: [
    'Book a specific calendar slot before ending the call',
    'Understand what will change by the requested callback time',
    'Offer a shorter check-in call to maintain momentum',
  ],
  FOLLOWUP_PROMISE: [
    'Establish specific next steps with dates',
    'Send calendar invite for follow-up immediately',
    'Ask what information they need to move forward',
  ],
  INTERNAL_DISCUSSION: [
    'Offer to provide materials for internal presentation',
    'Ask to understand what questions may come up internally',
    'Request to be included in internal discussions as a resource',
  ],
};

// =============================================================================
// SERVICE CONFIGURATION
// =============================================================================

export interface StallDetectorConfig {
  // Time decay settings
  timeDecayHalfLifeHours: number; // Confidence halves after this many hours
  maxSignalAgeHours: number; // Signals older than this are ignored

  // Severity thresholds (stallScore 0-100)
  criticalThreshold: number; // >= this is CRITICAL
  highThreshold: number; // >= this is HIGH
  mediumThreshold: number; // >= this is MEDIUM
  // Below medium is LOW

  // Alert settings
  alertWithinHours: number; // Generate alert within this many hours of signal
  minConfidenceForAlert: number; // Minimum confidence to generate alert

  // Storage (optional - for persistence)
  redisUrl?: string;
}

const DEFAULT_CONFIG: StallDetectorConfig = {
  timeDecayHalfLifeHours: 48,
  maxSignalAgeHours: 168, // 7 days
  criticalThreshold: 80,
  highThreshold: 60,
  mediumThreshold: 40,
  alertWithinHours: 24,
  minConfidenceForAlert: 0.5,
};

// =============================================================================
// STALL DETECTOR SERVICE
// =============================================================================

export class StallDetectorService {
  private config: StallDetectorConfig;

  // In-memory storage (replace with Redis/DB in production)
  private signals: Map<string, StallSignal> = new Map();
  private dealStatuses: Map<string, StallStatus> = new Map();

  constructor(config: Partial<StallDetectorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    logger.info({ config: this.config }, 'StallDetectorService initialized');
  }

  // ===========================================================================
  // MAIN DETECTION METHODS
  // ===========================================================================

  /**
   * Analyze a call transcript for stall signals
   */
  async analyzeTranscript(transcript: CallTranscript): Promise<StallSignal[]> {
    logger.info(
      { transcriptId: transcript.id, accountName: transcript.accountName },
      'Analyzing transcript for stall signals'
    );

    const signals: StallSignal[] = [];
    const matches = this.detectPhrases(transcript.transcript);

    if (matches.length === 0) {
      logger.debug({ transcriptId: transcript.id }, 'No stall phrases detected');
      return signals;
    }

    // Group matches by category to avoid duplicate signals
    const matchesByCategory = this.groupMatchesByCategory(matches);

    for (const [category, categoryMatches] of Object.entries(matchesByCategory)) {
      // Take the highest confidence match for each category
      const bestMatch = categoryMatches.reduce((best, current) =>
        current.confidence > best.confidence ? current : best
      );

      const signal = this.createSignal(
        transcript,
        'CALL_TRANSCRIPT',
        [bestMatch],
        categoryMatches
      );

      signals.push(signal);
      this.signals.set(signal.id, signal);
    }

    logger.info(
      { transcriptId: transcript.id, signalCount: signals.length },
      'Stall signals detected'
    );

    return signals;
  }

  /**
   * Analyze email content for stall signals
   */
  async analyzeEmail(email: EmailContent): Promise<StallSignal[]> {
    logger.info(
      { emailId: email.id, accountName: email.accountName },
      'Analyzing email for stall signals'
    );

    const signals: StallSignal[] = [];

    // Only analyze inbound emails (from prospect)
    if (email.direction !== 'INBOUND') {
      return signals;
    }

    const contentToAnalyze = `${email.subject} ${email.body}`;
    const matches = this.detectPhrases(contentToAnalyze);

    if (matches.length === 0) {
      return signals;
    }

    const matchesByCategory = this.groupMatchesByCategory(matches);

    for (const [category, categoryMatches] of Object.entries(matchesByCategory)) {
      const bestMatch = categoryMatches.reduce((best, current) =>
        current.confidence > best.confidence ? current : best
      );

      const signal: StallSignal = {
        id: uuidv4(),
        dealId: email.dealId || '',
        accountId: email.accountId,
        accountName: email.accountName,
        source: 'EMAIL',
        sourceId: email.id,
        sourceTimestamp: email.sentDate,
        phraseMatches: categoryMatches,
        rawContent: this.extractContext(contentToAnalyze, bestMatch.position, 200),
        baseConfidence: bestMatch.confidence,
        timeDecayedConfidence: this.calculateTimeDecayedConfidence(
          bestMatch.confidence,
          email.sentDate
        ),
        aggregateStrength: this.calculateAggregateStrength(categoryMatches),
        detectedAt: new Date(),
        processedAt: null,
      };

      signals.push(signal);
      this.signals.set(signal.id, signal);
    }

    return signals;
  }

  /**
   * Detect stall phrases in text content
   */
  detectPhrases(content: string): StallPhraseMatch[] {
    const matches: StallPhraseMatch[] = [];

    for (const pattern of STALL_PATTERNS) {
      let match: RegExpExecArray | null;
      const regex = new RegExp(pattern.pattern.source, pattern.pattern.flags + 'g');

      while ((match = regex.exec(content)) !== null) {
        matches.push({
          phrase: pattern.phraseLabel,
          category: pattern.category,
          matchedText: match[0],
          confidence: pattern.baseConfidence,
          position: match.index,
          context: this.extractContext(content, match.index, 100),
        });
      }
    }

    // Sort by position in text
    matches.sort((a, b) => a.position - b.position);

    return matches;
  }

  // ===========================================================================
  // DEAL STATUS CALCULATION
  // ===========================================================================

  /**
   * Calculate and update stall status for a deal
   */
  async calculateDealStatus(
    dealId: string,
    accountId: string,
    accountName: string,
    dealStage: DealStage,
    dealValue: number | null,
    ownerRepId: string,
    ownerRepName: string,
    managerId: string | null,
    managerName: string | null,
    lastPositiveEngagement?: { date: Date; type: string }
  ): Promise<StallStatus> {
    logger.debug({ dealId }, 'Calculating deal stall status');

    // Get all signals for this deal
    const dealSignals = this.getSignalsForDeal(dealId);

    // Filter out old signals
    const validSignals = dealSignals.filter((signal) => {
      const ageHours = (Date.now() - signal.sourceTimestamp.getTime()) / (1000 * 60 * 60);
      return ageHours <= this.config.maxSignalAgeHours;
    });

    // Calculate aggregate stall score
    const stallScore = this.calculateStallScore(validSignals);
    const severity = this.calculateSeverity(stallScore);
    const isStalled = stallScore >= this.config.mediumThreshold;

    // Determine primary category
    const primaryCategory = this.determinePrimaryCategory(validSignals);

    // Calculate days since positive engagement
    const daysSincePositive = lastPositiveEngagement
      ? Math.floor((Date.now() - lastPositiveEngagement.date.getTime()) / (1000 * 60 * 60 * 24))
      : null;

    // Generate recommended actions
    const recommendedActions = this.generateRecommendedActions(
      primaryCategory,
      severity,
      validSignals
    );

    const status: StallStatus = {
      dealId,
      accountId,
      accountName,
      dealStage,
      dealValue,
      ownerRepId,
      ownerRepName,
      managerId,
      managerName,
      isStalled,
      severity,
      stallScore,
      primaryCategory,
      signalCount: validSignals.length,
      latestSignalAt: validSignals.length > 0
        ? new Date(Math.max(...validSignals.map(s => s.sourceTimestamp.getTime())))
        : null,
      signals: validSignals,
      daysSinceLastPositiveEngagement: daysSincePositive,
      lastPositiveEngagementDate: lastPositiveEngagement?.date || null,
      lastPositiveEngagementType: lastPositiveEngagement?.type || null,
      recommendedActions,
      calculatedAt: new Date(),
      alertSentAt: null,
    };

    this.dealStatuses.set(dealId, status);

    logger.info(
      { dealId, stallScore, severity, isStalled, signalCount: validSignals.length },
      'Deal stall status calculated'
    );

    return status;
  }

  /**
   * Get stalled deals for dashboard
   */
  async getStalledDeals(
    filters: {
      repId?: string;
      managerId?: string;
      stage?: DealStage;
      minSeverity?: StallSeverity;
    } = {},
    limit: number = 50,
    offset: number = 0
  ): Promise<{ deals: StallStatus[]; total: number }> {
    let deals = Array.from(this.dealStatuses.values())
      .filter((status) => status.isStalled);

    // Apply filters
    if (filters.repId) {
      deals = deals.filter((d) => d.ownerRepId === filters.repId);
    }
    if (filters.managerId) {
      deals = deals.filter((d) => d.managerId === filters.managerId);
    }
    if (filters.stage) {
      deals = deals.filter((d) => d.dealStage === filters.stage);
    }
    if (filters.minSeverity) {
      const severityOrder: StallSeverity[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
      const minIndex = severityOrder.indexOf(filters.minSeverity);
      deals = deals.filter((d) => severityOrder.indexOf(d.severity) >= minIndex);
    }

    // Sort by stall score descending
    deals.sort((a, b) => b.stallScore - a.stallScore);

    const total = deals.length;
    const paginatedDeals = deals.slice(offset, offset + limit);

    return { deals: paginatedDeals, total };
  }

  /**
   * Get manager dashboard data
   */
  async getManagerDashboard(
    managerId: string,
    managerName: string,
    repIds: string[]
  ): Promise<{
    summary: {
      totalDeals: number;
      stalledDeals: number;
      criticalStalls: number;
      highStalls: number;
      mediumStalls: number;
      lowStalls: number;
      avgDaysSinceEngagement: number;
      totalAtRiskValue: number;
    };
    byRep: Array<{
      repId: string;
      repName: string;
      totalDeals: number;
      stalledDeals: number;
      stalledValue: number;
      topStallCategory: StallPhraseCategory | null;
      deals: StallStatus[];
    }>;
    byStage: Array<{
      stage: DealStage;
      stalledCount: number;
      totalValue: number;
    }>;
  }> {
    // Get all deals for the manager's reps
    const allDeals = Array.from(this.dealStatuses.values())
      .filter((d) => repIds.includes(d.ownerRepId));

    const stalledDeals = allDeals.filter((d) => d.isStalled);

    // Calculate summary
    const summary = {
      totalDeals: allDeals.length,
      stalledDeals: stalledDeals.length,
      criticalStalls: stalledDeals.filter((d) => d.severity === 'CRITICAL').length,
      highStalls: stalledDeals.filter((d) => d.severity === 'HIGH').length,
      mediumStalls: stalledDeals.filter((d) => d.severity === 'MEDIUM').length,
      lowStalls: stalledDeals.filter((d) => d.severity === 'LOW').length,
      avgDaysSinceEngagement: this.calculateAvgDaysSinceEngagement(stalledDeals),
      totalAtRiskValue: stalledDeals.reduce((sum, d) => sum + (d.dealValue || 0), 0),
    };

    // Group by rep
    const byRepMap = new Map<string, StallStatus[]>();
    for (const repId of repIds) {
      byRepMap.set(repId, []);
    }
    for (const deal of allDeals) {
      const existing = byRepMap.get(deal.ownerRepId) || [];
      existing.push(deal);
      byRepMap.set(deal.ownerRepId, existing);
    }

    const byRep = Array.from(byRepMap.entries()).map(([repId, deals]) => {
      const stalledRepDeals = deals.filter((d) => d.isStalled);
      return {
        repId,
        repName: deals[0]?.ownerRepName || 'Unknown',
        totalDeals: deals.length,
        stalledDeals: stalledRepDeals.length,
        stalledValue: stalledRepDeals.reduce((sum, d) => sum + (d.dealValue || 0), 0),
        topStallCategory: this.getTopCategory(stalledRepDeals),
        deals: stalledRepDeals,
      };
    });

    // Group by stage
    const stageGroups: Record<string, { count: number; value: number }> = {};
    for (const deal of stalledDeals) {
      if (!stageGroups[deal.dealStage]) {
        stageGroups[deal.dealStage] = { count: 0, value: 0 };
      }
      stageGroups[deal.dealStage].count++;
      stageGroups[deal.dealStage].value += deal.dealValue || 0;
    }

    const byStage = Object.entries(stageGroups).map(([stage, data]) => ({
      stage: stage as DealStage,
      stalledCount: data.count,
      totalValue: data.value,
    }));

    return { summary, byRep, byStage };
  }

  // ===========================================================================
  // HELPER METHODS
  // ===========================================================================

  private createSignal(
    transcript: CallTranscript,
    source: StallSignalSource,
    bestMatches: StallPhraseMatch[],
    allMatches: StallPhraseMatch[]
  ): StallSignal {
    const bestMatch = bestMatches[0];

    return {
      id: uuidv4(),
      dealId: transcript.dealId || '',
      accountId: transcript.accountId,
      accountName: transcript.accountName,
      source,
      sourceId: transcript.id,
      sourceTimestamp: transcript.callDate,
      phraseMatches: allMatches,
      rawContent: this.extractContext(transcript.transcript, bestMatch.position, 200),
      baseConfidence: bestMatch.confidence,
      timeDecayedConfidence: this.calculateTimeDecayedConfidence(
        bestMatch.confidence,
        transcript.callDate
      ),
      aggregateStrength: this.calculateAggregateStrength(allMatches),
      detectedAt: new Date(),
      processedAt: null,
    };
  }

  private extractContext(text: string, position: number, radius: number): string {
    const start = Math.max(0, position - radius);
    const end = Math.min(text.length, position + radius);
    let context = text.slice(start, end);

    if (start > 0) context = '...' + context;
    if (end < text.length) context = context + '...';

    return context.trim();
  }

  private groupMatchesByCategory(
    matches: StallPhraseMatch[]
  ): Record<string, StallPhraseMatch[]> {
    const groups: Record<string, StallPhraseMatch[]> = {};

    for (const match of matches) {
      if (!groups[match.category]) {
        groups[match.category] = [];
      }
      groups[match.category].push(match);
    }

    return groups;
  }

  private calculateTimeDecayedConfidence(
    baseConfidence: number,
    signalDate: Date
  ): number {
    const hoursOld = (Date.now() - signalDate.getTime()) / (1000 * 60 * 60);
    const decayFactor = Math.pow(0.5, hoursOld / this.config.timeDecayHalfLifeHours);
    return baseConfidence * decayFactor;
  }

  private calculateAggregateStrength(matches: StallPhraseMatch[]): number {
    if (matches.length === 0) return 0;

    // Base strength from highest confidence match
    const maxConfidence = Math.max(...matches.map(m => m.confidence));

    // Bonus for multiple matches (diminishing returns)
    const countBonus = Math.min(matches.length - 1, 3) * 0.5;

    // Scale to 0-10
    return Math.min(10, maxConfidence * 8 + countBonus);
  }

  private getSignalsForDeal(dealId: string): StallSignal[] {
    return Array.from(this.signals.values())
      .filter((signal) => signal.dealId === dealId);
  }

  private calculateStallScore(signals: StallSignal[]): number {
    if (signals.length === 0) return 0;

    // Sum of time-decayed confidence scores, capped at 100
    const totalScore = signals.reduce((sum, signal) => {
      return sum + signal.timeDecayedConfidence * 30;
    }, 0);

    // Bonus for signal recency
    const latestSignal = signals.reduce((latest, s) =>
      s.sourceTimestamp > latest.sourceTimestamp ? s : latest
    );
    const hoursSinceLatest = (Date.now() - latestSignal.sourceTimestamp.getTime()) / (1000 * 60 * 60);
    const recencyBonus = hoursSinceLatest < 24 ? 10 : hoursSinceLatest < 48 ? 5 : 0;

    return Math.min(100, totalScore + recencyBonus);
  }

  private calculateSeverity(stallScore: number): StallSeverity {
    if (stallScore >= this.config.criticalThreshold) return 'CRITICAL';
    if (stallScore >= this.config.highThreshold) return 'HIGH';
    if (stallScore >= this.config.mediumThreshold) return 'MEDIUM';
    return 'LOW';
  }

  private determinePrimaryCategory(signals: StallSignal[]): StallPhraseCategory | null {
    if (signals.length === 0) return null;

    // Count categories weighted by confidence
    const categoryScores: Record<string, number> = {};

    for (const signal of signals) {
      for (const match of signal.phraseMatches) {
        if (!categoryScores[match.category]) {
          categoryScores[match.category] = 0;
        }
        categoryScores[match.category] += match.confidence;
      }
    }

    // Find highest scoring category
    let maxCategory: string | null = null;
    let maxScore = 0;

    for (const [category, score] of Object.entries(categoryScores)) {
      if (score > maxScore) {
        maxScore = score;
        maxCategory = category;
      }
    }

    return maxCategory as StallPhraseCategory | null;
  }

  private generateRecommendedActions(
    primaryCategory: StallPhraseCategory | null,
    severity: StallSeverity,
    signals: StallSignal[]
  ): string[] {
    const actions: string[] = [];

    // Category-specific actions
    if (primaryCategory && RECOMMENDED_ACTIONS[primaryCategory]) {
      actions.push(...RECOMMENDED_ACTIONS[primaryCategory].slice(0, 2));
    }

    // Severity-based generic actions
    if (severity === 'CRITICAL') {
      actions.push('Escalate to manager for immediate coaching session');
      actions.push('Consider offering limited-time incentive to create urgency');
    } else if (severity === 'HIGH') {
      actions.push('Schedule manager call review within 24 hours');
    }

    // Multi-category detection
    const uniqueCategories = new Set(
      signals.flatMap(s => s.phraseMatches.map(m => m.category))
    );
    if (uniqueCategories.size >= 3) {
      actions.push('Multiple stall patterns detected - consider requalification of opportunity');
    }

    return actions.slice(0, 5); // Max 5 actions
  }

  private calculateAvgDaysSinceEngagement(deals: StallStatus[]): number {
    const dealsWithEngagement = deals.filter(d => d.daysSinceLastPositiveEngagement !== null);
    if (dealsWithEngagement.length === 0) return 0;

    const total = dealsWithEngagement.reduce(
      (sum, d) => sum + (d.daysSinceLastPositiveEngagement || 0),
      0
    );
    return Math.round(total / dealsWithEngagement.length);
  }

  private getTopCategory(deals: StallStatus[]): StallPhraseCategory | null {
    const categoryCount: Record<string, number> = {};

    for (const deal of deals) {
      if (deal.primaryCategory) {
        categoryCount[deal.primaryCategory] = (categoryCount[deal.primaryCategory] || 0) + 1;
      }
    }

    let topCategory: string | null = null;
    let maxCount = 0;

    for (const [category, count] of Object.entries(categoryCount)) {
      if (count > maxCount) {
        maxCount = count;
        topCategory = category;
      }
    }

    return topCategory as StallPhraseCategory | null;
  }

  // ===========================================================================
  // DATA MANAGEMENT
  // ===========================================================================

  /**
   * Add a signal manually (for testing or manual detection)
   */
  addSignal(signal: StallSignal): void {
    this.signals.set(signal.id, signal);
  }

  /**
   * Get a signal by ID
   */
  getSignal(signalId: string): StallSignal | undefined {
    return this.signals.get(signalId);
  }

  /**
   * Get deal status by ID
   */
  getDealStatus(dealId: string): StallStatus | undefined {
    return this.dealStatuses.get(dealId);
  }

  /**
   * Clear all data (for testing)
   */
  clearAll(): void {
    this.signals.clear();
    this.dealStatuses.clear();
    logger.info('All stall detection data cleared');
  }
}
