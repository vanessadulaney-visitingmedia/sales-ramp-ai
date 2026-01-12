import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger.js';
import {
  StallAlert,
  StallStatus,
  AlertPriority,
  AlertChannel,
  AlertRecipientType,
  StallSeverity,
} from '../types/stall.js';

// =============================================================================
// ALERT SERVICE
// Generates and delivers alerts for stalled deals
// =============================================================================

// =============================================================================
// CONFIGURATION
// =============================================================================

export interface AlertServiceConfig {
  // Alert timing
  alertWithinHours: number; // Generate alert within X hours of stall detection
  alertExpirationHours: number; // Alert expires after X hours if not acknowledged

  // Channel configuration
  enabledChannels: AlertChannel[];

  // Escalation rules
  escalateToManagerAfterHours: number; // Escalate to manager if not acknowledged
  escalateToBothOnCritical: boolean; // Always alert both rep and manager on critical

  // Webhook configuration (optional)
  webhookUrl?: string;
  webhookSecret?: string;

  // Email configuration (optional - stub for now)
  emailFromAddress?: string;

  // Slack configuration (optional - stub for now)
  slackBotToken?: string;
  slackChannelId?: string;
}

const DEFAULT_CONFIG: AlertServiceConfig = {
  alertWithinHours: 24,
  alertExpirationHours: 72,
  enabledChannels: ['WEBHOOK'],
  escalateToManagerAfterHours: 24,
  escalateToBothOnCritical: true,
};

// =============================================================================
// ALERT TEMPLATES
// =============================================================================

interface AlertTemplate {
  title: (status: StallStatus) => string;
  summary: (status: StallStatus, context: AlertContext) => string;
  recommendedAction: (status: StallStatus) => string;
}

interface AlertContext {
  topPhrase: string;
  signalSource: string;
  daysSinceEngagement: number | null;
}

const ALERT_TEMPLATES: Record<AlertPriority, AlertTemplate> = {
  URGENT: {
    title: (status) => `URGENT: ${status.accountName} - Deal Stall Detected`,
    summary: (status, ctx) =>
      `Critical stall signal detected on ${status.accountName}. ` +
      `Prospect said "${ctx.topPhrase}" during ${ctx.signalSource}. ` +
      `${ctx.daysSinceEngagement ? `No positive engagement in ${ctx.daysSinceEngagement} days. ` : ''}` +
      `Immediate action required - deal value: $${(status.dealValue || 0).toLocaleString()}.`,
    recommendedAction: (status) =>
      status.recommendedActions[0] || 'Review deal immediately and take action within 24 hours',
  },
  HIGH: {
    title: (status) => `HIGH PRIORITY: ${status.accountName} - Stall Warning`,
    summary: (status, ctx) =>
      `High-priority stall warning on ${status.accountName}. ` +
      `Detected phrase: "${ctx.topPhrase}". ` +
      `${ctx.daysSinceEngagement ? `Last positive engagement: ${ctx.daysSinceEngagement} days ago. ` : ''}` +
      `Deal value at risk: $${(status.dealValue || 0).toLocaleString()}.`,
    recommendedAction: (status) =>
      status.recommendedActions[0] || 'Schedule follow-up within 48 hours',
  },
  MEDIUM: {
    title: (status) => `${status.accountName} - Deal Momentum Alert`,
    summary: (status, ctx) =>
      `Potential stall detected on ${status.accountName}. ` +
      `Prospect indicated: "${ctx.topPhrase}". ` +
      `Review engagement strategy to maintain momentum.`,
    recommendedAction: (status) =>
      status.recommendedActions[0] || 'Review and adjust engagement approach',
  },
  LOW: {
    title: (status) => `${status.accountName} - Minor Stall Indicator`,
    summary: (status, ctx) =>
      `Minor stall signal on ${status.accountName}: "${ctx.topPhrase}". ` +
      `Monitor for additional signals.`,
    recommendedAction: (_status) => 'Monitor deal and prepare contingency approach',
  },
};

// =============================================================================
// ALERT SERVICE
// =============================================================================

export class AlertService {
  private config: AlertServiceConfig;

  // In-memory storage (replace with DB in production)
  private alerts: Map<string, StallAlert> = new Map();
  private alertsByDeal: Map<string, string[]> = new Map(); // dealId -> alertIds

  constructor(config: Partial<AlertServiceConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    logger.info({ config: this.config }, 'AlertService initialized');
  }

  // ===========================================================================
  // ALERT GENERATION
  // ===========================================================================

  /**
   * Generate alert from stall status if criteria are met
   */
  async generateAlert(status: StallStatus): Promise<StallAlert | null> {
    // Don't generate alerts for non-stalled deals
    if (!status.isStalled) {
      logger.debug({ dealId: status.dealId }, 'Deal not stalled, skipping alert');
      return null;
    }

    // Check if we already have a recent unacknowledged alert for this deal
    const existingAlerts = this.alertsByDeal.get(status.dealId) || [];
    const recentUnacked = existingAlerts.some((alertId) => {
      const alert = this.alerts.get(alertId);
      if (!alert) return false;
      const hoursSinceCreated =
        (Date.now() - alert.createdAt.getTime()) / (1000 * 60 * 60);
      return !alert.acknowledged && hoursSinceCreated < this.config.alertWithinHours;
    });

    if (recentUnacked) {
      logger.debug(
        { dealId: status.dealId },
        'Recent unacknowledged alert exists, skipping'
      );
      return null;
    }

    // Determine priority based on severity
    const priority = this.mapSeverityToPriority(status.severity);

    // Determine recipients
    const recipientType = this.determineRecipientType(status, priority);

    // Build alert context
    const context = this.buildAlertContext(status);

    // Get the template
    const template = ALERT_TEMPLATES[priority];

    // Build recipients list
    const recipients = this.buildRecipients(status, recipientType);

    // Calculate expiration
    const expiresAt = new Date(
      Date.now() + this.config.alertExpirationHours * 60 * 60 * 1000
    );

    // Create alert
    const alert: StallAlert = {
      id: uuidv4(),
      dealId: status.dealId,
      accountId: status.accountId,
      accountName: status.accountName,

      title: template.title(status),
      summary: template.summary(status, context),
      detectedPhrase: context.topPhrase,
      confidenceScore: this.getHighestConfidence(status),

      timeSinceStallSignal: status.latestSignalAt
        ? (Date.now() - status.latestSignalAt.getTime()) / (1000 * 60 * 60)
        : 0,
      timeSinceLastPositiveEngagement: status.daysSinceLastPositiveEngagement,

      priority,
      recipientType,
      recipients,

      channels: this.config.enabledChannels,
      deliveredVia: [],
      deliveredAt: null,

      recommendedAction: template.recommendedAction(status),
      actionUrl: this.buildActionUrl(status),

      acknowledged: false,
      acknowledgedAt: null,
      acknowledgedBy: null,

      createdAt: new Date(),
      expiresAt,

      stallStatus: status,
    };

    // Store alert
    this.alerts.set(alert.id, alert);
    const dealAlerts = this.alertsByDeal.get(status.dealId) || [];
    dealAlerts.push(alert.id);
    this.alertsByDeal.set(status.dealId, dealAlerts);

    logger.info(
      {
        alertId: alert.id,
        dealId: status.dealId,
        priority,
        recipientType,
      },
      'Alert generated'
    );

    return alert;
  }

  /**
   * Deliver an alert through configured channels
   */
  async deliverAlert(alertId: string): Promise<boolean> {
    const alert = this.alerts.get(alertId);
    if (!alert) {
      logger.warn({ alertId }, 'Alert not found for delivery');
      return false;
    }

    if (alert.acknowledged) {
      logger.debug({ alertId }, 'Alert already acknowledged, skipping delivery');
      return true;
    }

    const deliveredChannels: AlertChannel[] = [];

    for (const channel of this.config.enabledChannels) {
      try {
        const delivered = await this.deliverToChannel(alert, channel);
        if (delivered) {
          deliveredChannels.push(channel);
        }
      } catch (error) {
        logger.error({ error, alertId, channel }, 'Failed to deliver alert to channel');
      }
    }

    // Update alert with delivery info
    alert.deliveredVia = deliveredChannels;
    if (deliveredChannels.length > 0) {
      alert.deliveredAt = new Date();
    }

    logger.info(
      { alertId, deliveredChannels },
      'Alert delivery complete'
    );

    return deliveredChannels.length > 0;
  }

  /**
   * Acknowledge an alert
   */
  async acknowledgeAlert(
    alertId: string,
    acknowledgedBy: string,
    notes?: string
  ): Promise<StallAlert | null> {
    const alert = this.alerts.get(alertId);
    if (!alert) {
      logger.warn({ alertId }, 'Alert not found for acknowledgment');
      return null;
    }

    alert.acknowledged = true;
    alert.acknowledgedAt = new Date();
    alert.acknowledgedBy = acknowledgedBy;

    logger.info(
      { alertId, acknowledgedBy, notes },
      'Alert acknowledged'
    );

    return alert;
  }

  // ===========================================================================
  // CHANNEL DELIVERY METHODS
  // ===========================================================================

  private async deliverToChannel(
    alert: StallAlert,
    channel: AlertChannel
  ): Promise<boolean> {
    switch (channel) {
      case 'WEBHOOK':
        return this.deliverViaWebhook(alert);
      case 'EMAIL':
        return this.deliverViaEmail(alert);
      case 'SLACK':
        return this.deliverViaSlack(alert);
      case 'SALESFORCE_TASK':
        return this.deliverViaSalesforceTask(alert);
      default:
        logger.warn({ channel }, 'Unknown delivery channel');
        return false;
    }
  }

  private async deliverViaWebhook(alert: StallAlert): Promise<boolean> {
    if (!this.config.webhookUrl) {
      logger.debug('Webhook URL not configured, skipping');
      return false;
    }

    try {
      const payload = this.buildWebhookPayload(alert);

      // In production, actually POST to webhook
      // For now, log the payload
      logger.info(
        { webhookUrl: this.config.webhookUrl, alertId: alert.id },
        'Would deliver to webhook'
      );
      logger.debug({ payload }, 'Webhook payload');

      // Stub: Return true as if delivered
      return true;
    } catch (error) {
      logger.error({ error, alertId: alert.id }, 'Webhook delivery failed');
      return false;
    }
  }

  private async deliverViaEmail(alert: StallAlert): Promise<boolean> {
    // Stub implementation
    logger.info(
      { alertId: alert.id, recipients: alert.recipients.map((r) => r.email) },
      'Would deliver alert via email'
    );

    // In production, integrate with email service
    // For now, just log
    return true;
  }

  private async deliverViaSlack(alert: StallAlert): Promise<boolean> {
    // Stub implementation
    logger.info(
      { alertId: alert.id, channelId: this.config.slackChannelId },
      'Would deliver alert via Slack'
    );

    // In production, integrate with Slack API
    // For now, just log
    return true;
  }

  private async deliverViaSalesforceTask(alert: StallAlert): Promise<boolean> {
    // Stub implementation
    logger.info(
      { alertId: alert.id, dealId: alert.dealId },
      'Would create Salesforce task'
    );

    // In production, integrate with Salesforce API
    // For now, just log
    return true;
  }

  // ===========================================================================
  // BATCH OPERATIONS
  // ===========================================================================

  /**
   * Generate and deliver alerts for multiple stall statuses
   */
  async processStallStatuses(statuses: StallStatus[]): Promise<{
    generated: number;
    delivered: number;
    skipped: number;
  }> {
    let generated = 0;
    let delivered = 0;
    let skipped = 0;

    for (const status of statuses) {
      const alert = await this.generateAlert(status);

      if (alert) {
        generated++;
        const wasDelivered = await this.deliverAlert(alert.id);
        if (wasDelivered) {
          delivered++;
        }
      } else {
        skipped++;
      }
    }

    logger.info({ generated, delivered, skipped }, 'Batch alert processing complete');

    return { generated, delivered, skipped };
  }

  /**
   * Get pending alerts (unacknowledged, not expired)
   */
  getPendingAlerts(filters: {
    dealId?: string;
    repId?: string;
    priority?: AlertPriority;
  } = {}): StallAlert[] {
    const now = new Date();

    let alerts = Array.from(this.alerts.values())
      .filter((alert) => !alert.acknowledged && alert.expiresAt > now);

    if (filters.dealId) {
      alerts = alerts.filter((a) => a.dealId === filters.dealId);
    }
    if (filters.repId) {
      alerts = alerts.filter((a) =>
        a.recipients.some((r) => r.id === filters.repId)
      );
    }
    if (filters.priority) {
      alerts = alerts.filter((a) => a.priority === filters.priority);
    }

    // Sort by priority and creation time
    const priorityOrder: AlertPriority[] = ['URGENT', 'HIGH', 'MEDIUM', 'LOW'];
    alerts.sort((a, b) => {
      const priorityDiff =
        priorityOrder.indexOf(a.priority) - priorityOrder.indexOf(b.priority);
      if (priorityDiff !== 0) return priorityDiff;
      return b.createdAt.getTime() - a.createdAt.getTime();
    });

    return alerts;
  }

  /**
   * Get alert by ID
   */
  getAlert(alertId: string): StallAlert | undefined {
    return this.alerts.get(alertId);
  }

  /**
   * Get alerts for a deal
   */
  getAlertsForDeal(dealId: string): StallAlert[] {
    const alertIds = this.alertsByDeal.get(dealId) || [];
    return alertIds
      .map((id) => this.alerts.get(id))
      .filter((alert): alert is StallAlert => alert !== undefined);
  }

  // ===========================================================================
  // HELPER METHODS
  // ===========================================================================

  private mapSeverityToPriority(severity: StallSeverity): AlertPriority {
    switch (severity) {
      case 'CRITICAL':
        return 'URGENT';
      case 'HIGH':
        return 'HIGH';
      case 'MEDIUM':
        return 'MEDIUM';
      case 'LOW':
      default:
        return 'LOW';
    }
  }

  private determineRecipientType(
    status: StallStatus,
    priority: AlertPriority
  ): AlertRecipientType {
    // Always alert both on critical/urgent
    if (priority === 'URGENT' && this.config.escalateToBothOnCritical) {
      return 'BOTH';
    }

    // High priority also alerts manager
    if (priority === 'HIGH' && status.managerId) {
      return 'BOTH';
    }

    return 'REP';
  }

  private buildRecipients(
    status: StallStatus,
    recipientType: AlertRecipientType
  ): StallAlert['recipients'] {
    const recipients: StallAlert['recipients'] = [];

    if (recipientType === 'REP' || recipientType === 'BOTH') {
      recipients.push({
        id: status.ownerRepId,
        name: status.ownerRepName,
        email: `${status.ownerRepId}@company.com`, // Stub - should lookup actual email
        type: 'REP',
      });
    }

    if ((recipientType === 'MANAGER' || recipientType === 'BOTH') && status.managerId) {
      recipients.push({
        id: status.managerId,
        name: status.managerName || 'Manager',
        email: `${status.managerId}@company.com`, // Stub - should lookup actual email
        type: 'MANAGER',
      });
    }

    return recipients;
  }

  private buildAlertContext(status: StallStatus): AlertContext {
    // Get the top phrase from signals
    let topPhrase = 'deal stall detected';
    let signalSource = 'recent interaction';

    if (status.signals.length > 0) {
      const latestSignal = status.signals.reduce((latest, s) =>
        s.sourceTimestamp > latest.sourceTimestamp ? s : latest
      );

      if (latestSignal.phraseMatches.length > 0) {
        topPhrase = latestSignal.phraseMatches[0].matchedText;
      }

      signalSource = latestSignal.source === 'CALL_TRANSCRIPT'
        ? 'a recent call'
        : latestSignal.source === 'EMAIL'
        ? 'an email'
        : 'recent interaction';
    }

    return {
      topPhrase,
      signalSource,
      daysSinceEngagement: status.daysSinceLastPositiveEngagement,
    };
  }

  private getHighestConfidence(status: StallStatus): number {
    if (status.signals.length === 0) return 0;

    return Math.max(...status.signals.map((s) => s.baseConfidence));
  }

  private buildActionUrl(status: StallStatus): string | null {
    // Generate deep link to Salesforce or CRM
    // This would be configurable based on CRM integration
    if (status.dealId) {
      return `https://salesforce.com/lightning/r/Opportunity/${status.dealId}/view`;
    }
    return null;
  }

  private buildWebhookPayload(alert: StallAlert): object {
    return {
      event: 'stall_alert',
      timestamp: new Date().toISOString(),
      alert: {
        id: alert.id,
        priority: alert.priority,
        title: alert.title,
        summary: alert.summary,
        detectedPhrase: alert.detectedPhrase,
        confidenceScore: alert.confidenceScore,
        recommendedAction: alert.recommendedAction,
        actionUrl: alert.actionUrl,
      },
      deal: {
        id: alert.dealId,
        accountId: alert.accountId,
        accountName: alert.accountName,
        stage: alert.stallStatus.dealStage,
        value: alert.stallStatus.dealValue,
        ownerRepId: alert.stallStatus.ownerRepId,
        ownerRepName: alert.stallStatus.ownerRepName,
      },
      timing: {
        hoursSinceStallSignal: alert.timeSinceStallSignal,
        daysSincePositiveEngagement: alert.timeSinceLastPositiveEngagement,
      },
      recipients: alert.recipients,
    };
  }

  // ===========================================================================
  // DATA MANAGEMENT
  // ===========================================================================

  /**
   * Clear expired alerts
   */
  cleanupExpiredAlerts(): number {
    const now = new Date();
    let cleaned = 0;

    for (const [alertId, alert] of this.alerts.entries()) {
      if (alert.expiresAt < now) {
        this.alerts.delete(alertId);

        // Clean up deal -> alert mapping
        const dealAlerts = this.alertsByDeal.get(alert.dealId);
        if (dealAlerts) {
          const filtered = dealAlerts.filter((id) => id !== alertId);
          if (filtered.length > 0) {
            this.alertsByDeal.set(alert.dealId, filtered);
          } else {
            this.alertsByDeal.delete(alert.dealId);
          }
        }

        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info({ cleaned }, 'Expired alerts cleaned up');
    }

    return cleaned;
  }

  /**
   * Clear all data (for testing)
   */
  clearAll(): void {
    this.alerts.clear();
    this.alertsByDeal.clear();
    logger.info('All alert data cleared');
  }
}
