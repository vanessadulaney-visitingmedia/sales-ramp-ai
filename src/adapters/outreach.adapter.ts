import axios, { AxiosInstance, AxiosError } from 'axios';
import {
  OutreachConfig,
  OutreachProspect,
  OutreachUpdatePayload,
  OutreachUpdateResult,
  OutreachStage,
  OutreachDisposition,
} from '../types/crm-automation.js';
import { logger } from '../utils/logger.js';

// =============================================================================
// OUTREACH ADAPTER
// Handles all Outreach API interactions for CRM automation
// =============================================================================

const OUTREACH_API_BASE = 'https://api.outreach.io/api/v2';

interface OutreachTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  created_at: number;
}

interface OutreachApiError {
  errors?: Array<{
    id: string;
    title: string;
    detail: string;
    status: string;
  }>;
}

// Map internal stages to Outreach stage IDs
// These IDs should be configured based on the actual Outreach instance
const STAGE_ID_MAP: Record<OutreachStage, number> = {
  NEW: 1,
  ATTEMPTED: 2,
  WORKING: 3,
  QUALIFIED: 4,
  DEMO_SCHEDULED: 5,
  PROPOSAL: 6,
  NEGOTIATION: 7,
  CLOSED_WON: 8,
  CLOSED_LOST: 9,
  NURTURE: 10,
};

export class OutreachAdapter {
  private config: OutreachConfig;
  private client: AxiosInstance;
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private tokenExpiresAt: number = 0;

  constructor(config: OutreachConfig) {
    this.config = config;
    this.accessToken = config.accessToken || null;
    this.refreshToken = config.refreshToken || null;

    this.client = axios.create({
      baseURL: OUTREACH_API_BASE,
      headers: {
        'Content-Type': 'application/vnd.api+json',
        Accept: 'application/vnd.api+json',
      },
    });

    // Add auth interceptor
    this.client.interceptors.request.use(async (config) => {
      const token = await this.getValidAccessToken();
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
      return config;
    });

    // Add response interceptor for error handling
    this.client.interceptors.response.use(
      (response) => response,
      async (error: AxiosError<OutreachApiError>) => {
        if (error.response?.status === 401 && this.refreshToken) {
          // Token expired, try to refresh
          await this.refreshAccessToken();
          // Retry the request
          const config = error.config;
          if (config) {
            config.headers.Authorization = `Bearer ${this.accessToken}`;
            return this.client.request(config);
          }
        }
        throw error;
      }
    );

    logger.info('OutreachAdapter initialized');
  }

  // ===========================================================================
  // AUTHENTICATION
  // ===========================================================================

  /**
   * Generate OAuth2 authorization URL
   */
  getAuthorizationUrl(state?: string): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      scope: 'prospects.all calls.all stages.all',
    });

    if (state) {
      params.append('state', state);
    }

    return `https://api.outreach.io/oauth/authorize?${params.toString()}`;
  }

  /**
   * Exchange authorization code for access token
   */
  async exchangeCodeForToken(code: string): Promise<boolean> {
    try {
      const response = await axios.post<OutreachTokenResponse>(
        'https://api.outreach.io/oauth/token',
        {
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          redirect_uri: this.config.redirectUri,
          grant_type: 'authorization_code',
          code,
        },
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      this.accessToken = response.data.access_token;
      this.refreshToken = response.data.refresh_token;
      this.tokenExpiresAt = Date.now() + response.data.expires_in * 1000;

      logger.info('Outreach OAuth tokens obtained');
      return true;
    } catch (error) {
      logger.error({ error }, 'Failed to exchange code for token');
      return false;
    }
  }

  /**
   * Refresh the access token
   */
  async refreshAccessToken(): Promise<boolean> {
    if (!this.refreshToken) {
      logger.warn('No refresh token available');
      return false;
    }

    try {
      const response = await axios.post<OutreachTokenResponse>(
        'https://api.outreach.io/oauth/token',
        {
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          grant_type: 'refresh_token',
          refresh_token: this.refreshToken,
        },
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      this.accessToken = response.data.access_token;
      this.refreshToken = response.data.refresh_token;
      this.tokenExpiresAt = Date.now() + response.data.expires_in * 1000;

      logger.info('Outreach access token refreshed');
      return true;
    } catch (error) {
      logger.error({ error }, 'Failed to refresh access token');
      this.accessToken = null;
      this.refreshToken = null;
      return false;
    }
  }

  /**
   * Get a valid access token, refreshing if necessary
   */
  private async getValidAccessToken(): Promise<string | null> {
    if (!this.accessToken) {
      return null;
    }

    // Refresh if token expires in less than 5 minutes
    if (this.tokenExpiresAt && Date.now() > this.tokenExpiresAt - 300000) {
      await this.refreshAccessToken();
    }

    return this.accessToken;
  }

  /**
   * Set tokens directly (for stored tokens)
   */
  setTokens(accessToken: string, refreshToken: string, expiresAt?: number): void {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.tokenExpiresAt = expiresAt || Date.now() + 3600000; // Default 1 hour
    logger.info('Outreach tokens set');
  }

  /**
   * Check if adapter is authenticated
   */
  isAuthenticated(): boolean {
    return !!this.accessToken;
  }

  // ===========================================================================
  // PROSPECT OPERATIONS
  // ===========================================================================

  /**
   * Find prospect by email
   */
  async findProspectByEmail(email: string): Promise<OutreachProspect | null> {
    try {
      const response = await this.client.get('/prospects', {
        params: {
          'filter[email]': email,
        },
      });

      const prospects = response.data.data;
      if (!prospects || prospects.length === 0) {
        logger.debug({ email }, 'No prospect found');
        return null;
      }

      const prospect = prospects[0];
      return this.mapApiProspect(prospect);
    } catch (error) {
      logger.error({ error, email }, 'Failed to find prospect by email');
      throw error;
    }
  }

  /**
   * Find prospect by ID
   */
  async getProspectById(prospectId: number): Promise<OutreachProspect | null> {
    try {
      const response = await this.client.get(`/prospects/${prospectId}`);
      return this.mapApiProspect(response.data.data);
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      logger.error({ error, prospectId }, 'Failed to get prospect by ID');
      throw error;
    }
  }

  /**
   * Update prospect stage
   */
  async updateProspectStage(
    prospectId: number,
    stage: OutreachStage
  ): Promise<OutreachUpdateResult> {
    const stageId = STAGE_ID_MAP[stage];

    try {
      // Get current prospect state for audit
      const currentProspect = await this.getProspectById(prospectId);
      const previousStage = currentProspect?.stage;

      const response = await this.client.patch(`/prospects/${prospectId}`, {
        data: {
          type: 'prospect',
          id: prospectId,
          relationships: {
            stage: {
              data: {
                type: 'stage',
                id: stageId,
              },
            },
          },
        },
      });

      logger.info(
        { prospectId, previousStage, newStage: stage },
        'Prospect stage updated'
      );

      return {
        success: true,
        prospectId,
        previousStage,
        newStage: stage,
        updatedAt: new Date(),
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error, prospectId, stage }, 'Failed to update prospect stage');

      return {
        success: false,
        prospectId,
        updatedAt: new Date(),
        error: errorMessage,
      };
    }
  }

  /**
   * Full prospect update with stage, custom fields, and notes
   */
  async updateProspect(payload: OutreachUpdatePayload): Promise<OutreachUpdateResult> {
    const { prospectId, stage, customFields, note, taskDescription } = payload;

    try {
      // Get current state for audit
      const currentProspect = await this.getProspectById(prospectId);
      const previousStage = currentProspect?.stage;

      // Build update payload
      const updateData: Record<string, unknown> = {
        type: 'prospect',
        id: prospectId,
        attributes: {},
        relationships: {},
      };

      // Add stage if provided
      if (stage) {
        const stageId = STAGE_ID_MAP[stage];
        (updateData.relationships as Record<string, unknown>).stage = {
          data: {
            type: 'stage',
            id: stageId,
          },
        };
      }

      // Add custom fields if provided
      if (customFields) {
        (updateData.attributes as Record<string, unknown>).custom = customFields;
      }

      // Update prospect
      await this.client.patch(`/prospects/${prospectId}`, {
        data: updateData,
      });

      // Add note if provided
      if (note) {
        await this.addNote(prospectId, note);
      }

      // Create task if provided
      if (taskDescription) {
        await this.createTask(prospectId, taskDescription);
      }

      logger.info(
        { prospectId, previousStage, newStage: stage },
        'Prospect updated'
      );

      return {
        success: true,
        prospectId,
        previousStage,
        newStage: stage,
        updatedAt: new Date(),
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error, prospectId }, 'Failed to update prospect');

      return {
        success: false,
        prospectId,
        updatedAt: new Date(),
        error: errorMessage,
      };
    }
  }

  // ===========================================================================
  // NOTES & TASKS
  // ===========================================================================

  /**
   * Add a note to a prospect
   */
  async addNote(prospectId: number, content: string): Promise<boolean> {
    try {
      await this.client.post('/notes', {
        data: {
          type: 'note',
          attributes: {
            bodyText: content,
          },
          relationships: {
            prospect: {
              data: {
                type: 'prospect',
                id: prospectId,
              },
            },
          },
        },
      });

      logger.debug({ prospectId }, 'Note added to prospect');
      return true;
    } catch (error) {
      logger.error({ error, prospectId }, 'Failed to add note');
      return false;
    }
  }

  /**
   * Create a task for a prospect
   */
  async createTask(
    prospectId: number,
    taskDescription: string,
    dueDate?: Date
  ): Promise<boolean> {
    try {
      const attributes: Record<string, unknown> = {
        subject: taskDescription,
        taskType: 'call',
      };

      if (dueDate) {
        attributes.dueAt = dueDate.toISOString();
      }

      await this.client.post('/tasks', {
        data: {
          type: 'task',
          attributes,
          relationships: {
            prospects: {
              data: [
                {
                  type: 'prospect',
                  id: prospectId,
                },
              ],
            },
          },
        },
      });

      logger.debug({ prospectId, taskDescription }, 'Task created for prospect');
      return true;
    } catch (error) {
      logger.error({ error, prospectId }, 'Failed to create task');
      return false;
    }
  }

  // ===========================================================================
  // CALL LOGGING
  // ===========================================================================

  /**
   * Log a call activity
   */
  async logCall(
    prospectId: number,
    callData: {
      direction: 'inbound' | 'outbound';
      outcome: string;
      duration: number;
      notes?: string;
      externalVendor?: string;
      externalCallId?: string;
    }
  ): Promise<boolean> {
    try {
      const attributes: Record<string, unknown> = {
        direction: callData.direction,
        outcome: callData.outcome,
        talkingDuration: callData.duration,
        state: 'completed',
      };

      if (callData.notes) {
        attributes.note = callData.notes;
      }

      if (callData.externalVendor) {
        attributes.externalVendor = callData.externalVendor;
      }

      if (callData.externalCallId) {
        attributes.voipProviderCallId = callData.externalCallId;
      }

      await this.client.post('/calls', {
        data: {
          type: 'call',
          attributes,
          relationships: {
            prospect: {
              data: {
                type: 'prospect',
                id: prospectId,
              },
            },
          },
        },
      });

      logger.info({ prospectId, outcome: callData.outcome }, 'Call logged');
      return true;
    } catch (error) {
      logger.error({ error, prospectId }, 'Failed to log call');
      return false;
    }
  }

  // ===========================================================================
  // STAGES
  // ===========================================================================

  /**
   * Get all available stages
   */
  async getStages(): Promise<Array<{ id: number; name: string }>> {
    try {
      const response = await this.client.get('/stages');
      return response.data.data.map(
        (stage: { id: number; attributes: { name: string } }) => ({
          id: stage.id,
          name: stage.attributes.name,
        })
      );
    } catch (error) {
      logger.error({ error }, 'Failed to get stages');
      throw error;
    }
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  /**
   * Map Outreach API response to internal prospect type
   */
  private mapApiProspect(data: {
    id: number;
    attributes: {
      emails?: string[];
      firstName?: string;
      lastName?: string;
      title?: string;
      company?: string;
      custom?: Record<string, unknown>;
    };
    relationships?: {
      stage?: {
        data?: {
          id: number;
        };
      };
      owner?: {
        data?: {
          id: number;
        };
      };
    };
  }): OutreachProspect {
    const stageId = data.relationships?.stage?.data?.id;
    const stageName = stageId
      ? (Object.entries(STAGE_ID_MAP).find(
          ([, id]) => id === stageId
        )?.[0] as OutreachStage)
      : undefined;

    return {
      id: data.id,
      email: data.attributes.emails?.[0],
      firstName: data.attributes.firstName,
      lastName: data.attributes.lastName,
      title: data.attributes.title,
      company: data.attributes.company,
      stage: stageName,
      owner: data.relationships?.owner?.data
        ? { id: data.relationships.owner.data.id, email: '' }
        : undefined,
      customFields: data.attributes.custom,
    };
  }

  /**
   * Map call outcome to Outreach disposition
   */
  getOutreachDisposition(disposition: OutreachDisposition): string {
    const dispositionMap: Record<OutreachDisposition, string> = {
      NO_ANSWER: 'No Answer',
      LEFT_VOICEMAIL: 'Left Voicemail',
      WRONG_NUMBER: 'Wrong Number',
      GATEKEEPER_BLOCK: 'Gatekeeper Block',
      NOT_INTERESTED: 'Not Interested',
      CONNECTED: 'Connected',
      DEMO_SCHEDULED: 'Demo Scheduled',
      MEETING_SCHEDULED: 'Meeting Scheduled',
      SENT_INFO: 'Sent Info',
      CALLBACK_SCHEDULED: 'Callback Scheduled',
      FOLLOW_UP: 'Follow Up',
    };

    return dispositionMap[disposition] || disposition;
  }
}
