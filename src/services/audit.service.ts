import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import {
  AuditEntry,
  AuditAction,
  AuditConfig,
  OutreachStage,
  StageMappingResult,
} from '../types/crm-automation.js';
import { logger } from '../utils/logger.js';

// =============================================================================
// AUDIT SERVICE
// Logs all automated CRM changes for compliance, debugging, and rollback
// =============================================================================

interface AuditStats {
  totalEntries: number;
  entriesByAction: Record<string, number>;
  entriesByAutomated: { automated: number; manual: number };
  rollbackCount: number;
  errorCount: number;
  oldestEntry: Date | null;
  newestEntry: Date | null;
}

interface RollbackResult {
  success: boolean;
  auditId: string;
  originalAuditId: string;
  message: string;
  previousValue?: unknown;
  restoredValue?: unknown;
}

export class AuditService {
  private config: AuditConfig;
  private entries: Map<string, AuditEntry> = new Map();
  private entriesByCallId: Map<string, string[]> = new Map(); // callId -> auditIds
  private entriesByProspectId: Map<number, string[]> = new Map(); // prospectId -> auditIds
  private logFilePath: string | null = null;

  constructor(config?: Partial<AuditConfig>) {
    this.config = {
      retentionDays: config?.retentionDays ?? 90,
      enableRollback: config?.enableRollback ?? true,
      logToFile: config?.logToFile ?? false,
      logFilePath: config?.logFilePath,
    };

    if (this.config.logToFile && this.config.logFilePath) {
      this.logFilePath = this.config.logFilePath;
    }

    logger.info('AuditService initialized');
  }

  // ===========================================================================
  // AUDIT LOGGING
  // ===========================================================================

  /**
   * Log a stage change
   */
  async logStageChange(params: {
    callId: string;
    prospectId: number;
    previousStage: OutreachStage | undefined;
    newStage: OutreachStage;
    confidence: number;
    automated: boolean;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const entry: AuditEntry = {
      id: uuidv4(),
      timestamp: new Date(),
      callId: params.callId,
      prospectId: params.prospectId,
      action: 'STAGE_CHANGE',
      previousValue: params.previousStage,
      newValue: params.newStage,
      confidence: params.confidence,
      automated: params.automated,
      metadata: params.metadata,
    };

    return this.addEntry(entry);
  }

  /**
   * Log a disposition being set
   */
  async logDispositionSet(params: {
    callId: string;
    prospectId: number;
    disposition: string;
    automated: boolean;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const entry: AuditEntry = {
      id: uuidv4(),
      timestamp: new Date(),
      callId: params.callId,
      prospectId: params.prospectId,
      action: 'DISPOSITION_SET',
      newValue: params.disposition,
      automated: params.automated,
      metadata: params.metadata,
    };

    return this.addEntry(entry);
  }

  /**
   * Log a note being added
   */
  async logNoteAdded(params: {
    callId: string;
    prospectId: number;
    noteContent: string;
    automated: boolean;
  }): Promise<string> {
    const entry: AuditEntry = {
      id: uuidv4(),
      timestamp: new Date(),
      callId: params.callId,
      prospectId: params.prospectId,
      action: 'NOTE_ADDED',
      newValue: params.noteContent.substring(0, 500), // Truncate for storage
      automated: params.automated,
    };

    return this.addEntry(entry);
  }

  /**
   * Log a task being created
   */
  async logTaskCreated(params: {
    callId: string;
    prospectId: number;
    taskDescription: string;
    automated: boolean;
  }): Promise<string> {
    const entry: AuditEntry = {
      id: uuidv4(),
      timestamp: new Date(),
      callId: params.callId,
      prospectId: params.prospectId,
      action: 'TASK_CREATED',
      newValue: params.taskDescription,
      automated: params.automated,
    };

    return this.addEntry(entry);
  }

  /**
   * Log a flag being set
   */
  async logFlagSet(params: {
    callId: string;
    prospectId?: number;
    flag: string;
    reason: string;
  }): Promise<string> {
    const entry: AuditEntry = {
      id: uuidv4(),
      timestamp: new Date(),
      callId: params.callId,
      prospectId: params.prospectId,
      action: 'FLAG_SET',
      newValue: params.flag,
      automated: true,
      metadata: { reason: params.reason },
    };

    return this.addEntry(entry);
  }

  /**
   * Log that confirmation is required
   */
  async logConfirmationRequired(params: {
    callId: string;
    prospectId?: number;
    suggestedStage: OutreachStage;
    confidence: number;
    reasoning: string;
  }): Promise<string> {
    const entry: AuditEntry = {
      id: uuidv4(),
      timestamp: new Date(),
      callId: params.callId,
      prospectId: params.prospectId,
      action: 'CONFIRMATION_REQUIRED',
      newValue: params.suggestedStage,
      confidence: params.confidence,
      automated: true,
      metadata: { reasoning: params.reasoning },
    };

    return this.addEntry(entry);
  }

  /**
   * Log an error
   */
  async logError(params: {
    callId: string;
    prospectId?: number;
    error: string;
    context?: Record<string, unknown>;
  }): Promise<string> {
    const entry: AuditEntry = {
      id: uuidv4(),
      timestamp: new Date(),
      callId: params.callId,
      prospectId: params.prospectId,
      action: 'ERROR',
      newValue: params.error,
      automated: true,
      metadata: params.context,
    };

    return this.addEntry(entry);
  }

  /**
   * Log the complete result of a stage mapping
   */
  async logStageMappingResult(params: {
    callId: string;
    prospectId: number;
    previousStage?: OutreachStage;
    result: StageMappingResult;
    autoUpdated: boolean;
  }): Promise<string[]> {
    const auditIds: string[] = [];

    // Log the stage change
    const stageAuditId = await this.logStageChange({
      callId: params.callId,
      prospectId: params.prospectId,
      previousStage: params.previousStage,
      newStage: params.result.newStage,
      confidence: params.result.confidence,
      automated: params.autoUpdated,
      metadata: {
        reasoning: params.result.reasoning,
        flags: params.result.flags,
        suggestedTasks: params.result.suggestedTasks,
      },
    });
    auditIds.push(stageAuditId);

    // Log disposition if set
    if (params.result.disposition) {
      const dispositionAuditId = await this.logDispositionSet({
        callId: params.callId,
        prospectId: params.prospectId,
        disposition: params.result.disposition,
        automated: params.autoUpdated,
      });
      auditIds.push(dispositionAuditId);
    }

    // Log any flags
    for (const flag of params.result.flags) {
      const flagAuditId = await this.logFlagSet({
        callId: params.callId,
        prospectId: params.prospectId,
        flag,
        reason: params.result.reasoning,
      });
      auditIds.push(flagAuditId);
    }

    // Log confirmation requirement if needed
    if (params.result.requiresConfirmation && !params.autoUpdated) {
      const confirmAuditId = await this.logConfirmationRequired({
        callId: params.callId,
        prospectId: params.prospectId,
        suggestedStage: params.result.newStage,
        confidence: params.result.confidence,
        reasoning: params.result.reasoning,
      });
      auditIds.push(confirmAuditId);
    }

    return auditIds;
  }

  // ===========================================================================
  // ROLLBACK CAPABILITY
  // ===========================================================================

  /**
   * Rollback a specific audit entry
   */
  async rollback(auditId: string, confirmedBy: string): Promise<RollbackResult> {
    if (!this.config.enableRollback) {
      return {
        success: false,
        auditId: '',
        originalAuditId: auditId,
        message: 'Rollback is disabled in configuration',
      };
    }

    const originalEntry = this.entries.get(auditId);
    if (!originalEntry) {
      return {
        success: false,
        auditId: '',
        originalAuditId: auditId,
        message: 'Audit entry not found',
      };
    }

    // Only certain actions can be rolled back
    if (!['STAGE_CHANGE', 'DISPOSITION_SET'].includes(originalEntry.action)) {
      return {
        success: false,
        auditId: '',
        originalAuditId: auditId,
        message: `Cannot rollback action type: ${originalEntry.action}`,
      };
    }

    // Create rollback entry
    const rollbackEntry: AuditEntry = {
      id: uuidv4(),
      timestamp: new Date(),
      callId: originalEntry.callId,
      prospectId: originalEntry.prospectId,
      action: 'ROLLBACK',
      previousValue: originalEntry.newValue,
      newValue: originalEntry.previousValue,
      automated: false,
      confirmedBy,
      rollbackOf: auditId,
    };

    await this.addEntry(rollbackEntry);

    logger.info(
      {
        originalAuditId: auditId,
        rollbackAuditId: rollbackEntry.id,
        confirmedBy,
      },
      'Rollback recorded'
    );

    return {
      success: true,
      auditId: rollbackEntry.id,
      originalAuditId: auditId,
      message: 'Rollback recorded successfully',
      previousValue: originalEntry.newValue,
      restoredValue: originalEntry.previousValue,
    };
  }

  /**
   * Get rollback history for an entry
   */
  getRollbackHistory(auditId: string): AuditEntry[] {
    const history: AuditEntry[] = [];

    for (const entry of this.entries.values()) {
      if (entry.rollbackOf === auditId || entry.id === auditId) {
        history.push(entry);
      }
    }

    return history.sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
    );
  }

  // ===========================================================================
  // ENTRY MANAGEMENT
  // ===========================================================================

  /**
   * Add an entry to the audit log
   */
  private async addEntry(entry: AuditEntry): Promise<string> {
    this.entries.set(entry.id, entry);

    // Index by call ID
    const callEntries = this.entriesByCallId.get(entry.callId) || [];
    callEntries.push(entry.id);
    this.entriesByCallId.set(entry.callId, callEntries);

    // Index by prospect ID
    if (entry.prospectId) {
      const prospectEntries =
        this.entriesByProspectId.get(entry.prospectId) || [];
      prospectEntries.push(entry.id);
      this.entriesByProspectId.set(entry.prospectId, prospectEntries);
    }

    // Log to file if enabled
    if (this.logFilePath) {
      await this.appendToFile(entry);
    }

    logger.debug(
      { auditId: entry.id, action: entry.action, callId: entry.callId },
      'Audit entry recorded'
    );

    return entry.id;
  }

  /**
   * Append entry to file
   */
  private async appendToFile(entry: AuditEntry): Promise<void> {
    if (!this.logFilePath) return;

    try {
      const line = JSON.stringify(entry) + '\n';
      await fs.appendFile(this.logFilePath, line, 'utf-8');
    } catch (error) {
      logger.warn({ error, auditId: entry.id }, 'Failed to write audit entry to file');
    }
  }

  // ===========================================================================
  // RETRIEVAL
  // ===========================================================================

  /**
   * Get audit entry by ID
   */
  getEntry(auditId: string): AuditEntry | null {
    return this.entries.get(auditId) || null;
  }

  /**
   * Get all entries for a call
   */
  getEntriesForCall(callId: string): AuditEntry[] {
    const entryIds = this.entriesByCallId.get(callId) || [];
    return entryIds
      .map((id) => this.entries.get(id))
      .filter((e): e is AuditEntry => e !== undefined)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  /**
   * Get all entries for a prospect
   */
  getEntriesForProspect(prospectId: number): AuditEntry[] {
    const entryIds = this.entriesByProspectId.get(prospectId) || [];
    return entryIds
      .map((id) => this.entries.get(id))
      .filter((e): e is AuditEntry => e !== undefined)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  /**
   * Get entries by action type
   */
  getEntriesByAction(action: AuditAction): AuditEntry[] {
    return Array.from(this.entries.values())
      .filter((e) => e.action === action)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }

  /**
   * Get entries within a time range
   */
  getEntriesInRange(startDate: Date, endDate: Date): AuditEntry[] {
    return Array.from(this.entries.values())
      .filter(
        (e) => e.timestamp >= startDate && e.timestamp <= endDate
      )
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }

  /**
   * Get recent entries
   */
  getRecentEntries(limit: number = 100): AuditEntry[] {
    return Array.from(this.entries.values())
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }

  /**
   * Get entries pending confirmation
   */
  getPendingConfirmations(): AuditEntry[] {
    return this.getEntriesByAction('CONFIRMATION_REQUIRED');
  }

  // ===========================================================================
  // STATISTICS
  // ===========================================================================

  /**
   * Get audit statistics
   */
  getStats(): AuditStats {
    const entries = Array.from(this.entries.values());

    const entriesByAction: Record<string, number> = {};
    let automatedCount = 0;
    let manualCount = 0;
    let rollbackCount = 0;
    let errorCount = 0;
    let oldestEntry: Date | null = null;
    let newestEntry: Date | null = null;

    for (const entry of entries) {
      // Count by action
      entriesByAction[entry.action] = (entriesByAction[entry.action] || 0) + 1;

      // Count automated vs manual
      if (entry.automated) {
        automatedCount++;
      } else {
        manualCount++;
      }

      // Count rollbacks and errors
      if (entry.action === 'ROLLBACK') rollbackCount++;
      if (entry.action === 'ERROR') errorCount++;

      // Track date range
      if (!oldestEntry || entry.timestamp < oldestEntry) {
        oldestEntry = entry.timestamp;
      }
      if (!newestEntry || entry.timestamp > newestEntry) {
        newestEntry = entry.timestamp;
      }
    }

    return {
      totalEntries: entries.length,
      entriesByAction,
      entriesByAutomated: {
        automated: automatedCount,
        manual: manualCount,
      },
      rollbackCount,
      errorCount,
      oldestEntry,
      newestEntry,
    };
  }

  // ===========================================================================
  // CLEANUP
  // ===========================================================================

  /**
   * Clean up old entries based on retention policy
   */
  async cleanup(): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.config.retentionDays);

    let deletedCount = 0;

    for (const [id, entry] of this.entries) {
      if (entry.timestamp < cutoffDate) {
        this.entries.delete(id);

        // Remove from indices
        const callEntries = this.entriesByCallId.get(entry.callId);
        if (callEntries) {
          const idx = callEntries.indexOf(id);
          if (idx > -1) callEntries.splice(idx, 1);
        }

        if (entry.prospectId) {
          const prospectEntries = this.entriesByProspectId.get(entry.prospectId);
          if (prospectEntries) {
            const idx = prospectEntries.indexOf(id);
            if (idx > -1) prospectEntries.splice(idx, 1);
          }
        }

        deletedCount++;
      }
    }

    if (deletedCount > 0) {
      logger.info(
        { deletedCount, retentionDays: this.config.retentionDays },
        'Audit cleanup completed'
      );
    }

    return deletedCount;
  }

  // ===========================================================================
  // EXPORT
  // ===========================================================================

  /**
   * Export all entries as JSON
   */
  exportToJson(): string {
    const entries = Array.from(this.entries.values()).sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
    );
    return JSON.stringify(entries, null, 2);
  }

  /**
   * Export entries to file
   */
  async exportToFile(filePath: string): Promise<void> {
    const json = this.exportToJson();
    await fs.writeFile(filePath, json, 'utf-8');
    logger.info({ filePath, entryCount: this.entries.size }, 'Audit log exported');
  }

  /**
   * Import entries from file
   */
  async importFromFile(filePath: string): Promise<number> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const entries: AuditEntry[] = JSON.parse(content);

      let importedCount = 0;
      for (const entry of entries) {
        // Convert timestamp string back to Date
        entry.timestamp = new Date(entry.timestamp);
        await this.addEntry(entry);
        importedCount++;
      }

      logger.info({ filePath, importedCount }, 'Audit entries imported');
      return importedCount;
    } catch (error) {
      logger.error({ error, filePath }, 'Failed to import audit entries');
      throw error;
    }
  }
}
