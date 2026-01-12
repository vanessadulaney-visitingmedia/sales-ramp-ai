import jsforce from 'jsforce';
import { Competitor, AdjacencyData, ParentNotes } from '../types/brief.js';
import { logger } from '../utils/logger.js';

// =============================================================================
// SALESFORCE ADAPTER
// Handles all Salesforce data queries for Brief Builder
// =============================================================================

interface SalesforceConfig {
  loginUrl: string;
  username: string;
  password: string;
  securityToken: string;
}

export class SalesforceAdapter {
  private conn: jsforce.Connection | null = null;
  private config: SalesforceConfig;

  constructor(config: SalesforceConfig) {
    this.config = config;
    logger.info('SalesforceAdapter initialized');
  }

  // ===========================================================================
  // CONNECTION MANAGEMENT
  // ===========================================================================

  async connect(): Promise<void> {
    if (this.conn) {
      return;
    }

    try {
      this.conn = new jsforce.Connection({
        loginUrl: this.config.loginUrl,
      });

      await this.conn.login(
        this.config.username,
        this.config.password + this.config.securityToken
      );

      logger.info({ instanceUrl: this.conn.instanceUrl }, 'Connected to Salesforce');
    } catch (error) {
      logger.error({ error }, 'Failed to connect to Salesforce');
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.conn) {
      await this.conn.logout();
      this.conn = null;
      logger.info('Disconnected from Salesforce');
    }
  }

  private async ensureConnected(): Promise<jsforce.Connection> {
    if (!this.conn) {
      await this.connect();
    }
    return this.conn!;
  }

  // ===========================================================================
  // LOCAL COMPETITORS (Active customers in same city)
  // ===========================================================================

  /**
   * Find up to 2 local competitors using the platform
   * Logic: Active Customer = true AND same Shipping City
   */
  async getLocalCompetitors(city: string, state?: string): Promise<Competitor[]> {
    const conn = await this.ensureConnected();

    try {
      logger.info({ city, state }, 'Querying local competitors');

      // Build SOQL query
      let whereClause = `Active_Customer__c = true AND ShippingCity = '${this.escapeSOQL(city)}'`;
      if (state) {
        whereClause += ` AND ShippingState = '${this.escapeSOQL(state)}'`;
      }

      const query = `
        SELECT
          Id,
          Name,
          ShippingCity,
          ShippingState,
          Active_Customer__c,
          Parent.Name,
          Management_Company__c,
          Brand_Affiliation__c,
          Contract_Value__c,
          Product_Used__c
        FROM Account
        WHERE ${whereClause}
        ORDER BY Contract_Value__c DESC NULLS LAST
        LIMIT 2
      `;

      const result = await conn.query<SalesforceAccount>(query);

      return result.records.map((record) => ({
        accountId: record.Id,
        accountName: record.Name,
        shippingCity: record.ShippingCity,
        shippingState: record.ShippingState,
        isActiveCustomer: record.Active_Customer__c,
        parentAccountName: record.Parent?.Name || null,
        managementCompany: record.Management_Company__c,
        brandAffiliation: record.Brand_Affiliation__c,
        contractValue: record.Contract_Value__c,
        productUsed: record.Product_Used__c,
      }));
    } catch (error) {
      logger.error({ error, city, state }, 'Failed to query local competitors');
      return [];
    }
  }

  // ===========================================================================
  // ADJACENCY CUSTOMERS (Same brand or management company)
  // ===========================================================================

  /**
   * Find up to 2 adjacency customers (same brand OR same management company)
   */
  async getAdjacencyCustomers(
    brandAffiliation?: string,
    managementCompany?: string
  ): Promise<Competitor[]> {
    const conn = await this.ensureConnected();

    try {
      logger.info({ brandAffiliation, managementCompany }, 'Querying adjacency customers');

      if (!brandAffiliation && !managementCompany) {
        return [];
      }

      // Build OR conditions for brand and management company
      const conditions: string[] = [];
      if (brandAffiliation) {
        conditions.push(`Brand_Affiliation__c = '${this.escapeSOQL(brandAffiliation)}'`);
      }
      if (managementCompany) {
        conditions.push(`Management_Company__c = '${this.escapeSOQL(managementCompany)}'`);
      }

      const whereClause = `Active_Customer__c = true AND (${conditions.join(' OR ')})`;

      const query = `
        SELECT
          Id,
          Name,
          ShippingCity,
          ShippingState,
          Active_Customer__c,
          Parent.Name,
          Management_Company__c,
          Brand_Affiliation__c,
          Contract_Value__c,
          Product_Used__c
        FROM Account
        WHERE ${whereClause}
        ORDER BY Contract_Value__c DESC NULLS LAST
        LIMIT 2
      `;

      const result = await conn.query<SalesforceAccount>(query);

      return result.records.map((record) => ({
        accountId: record.Id,
        accountName: record.Name,
        shippingCity: record.ShippingCity,
        shippingState: record.ShippingState,
        isActiveCustomer: record.Active_Customer__c,
        parentAccountName: record.Parent?.Name || null,
        managementCompany: record.Management_Company__c,
        brandAffiliation: record.Brand_Affiliation__c,
        contractValue: record.Contract_Value__c,
        productUsed: record.Product_Used__c,
      }));
    } catch (error) {
      logger.error({ error, brandAffiliation, managementCompany }, 'Failed to query adjacency customers');
      return [];
    }
  }

  // ===========================================================================
  // COMPLETE ADJACENCY DATA
  // ===========================================================================

  /**
   * Get full adjacency data (local competitors + brand/management adjacency)
   */
  async getAdjacencyData(
    city: string,
    state?: string,
    brandAffiliation?: string,
    managementCompany?: string
  ): Promise<AdjacencyData> {
    const [localCompetitors, adjacencyCustomers] = await Promise.all([
      this.getLocalCompetitors(city, state),
      this.getAdjacencyCustomers(brandAffiliation, managementCompany),
    ]);

    return {
      localCompetitors,
      adjacencyCustomers,
    };
  }

  // ===========================================================================
  // PARENT ACCOUNT NOTES
  // ===========================================================================

  /**
   * Get selling notes from parent account
   */
  async getParentNotes(accountId: string): Promise<ParentNotes> {
    const conn = await this.ensureConnected();

    try {
      logger.info({ accountId }, 'Querying parent account notes');

      const query = `
        SELECT
          Id,
          Name,
          ParentId,
          Parent.Name,
          Parent.Selling_Notes__c,
          Parent.LastModifiedDate
        FROM Account
        WHERE Id = '${this.escapeSOQL(accountId)}'
      `;

      const result = await conn.query<SalesforceAccountWithParent>(query);

      if (result.records.length === 0 || !result.records[0].Parent) {
        return {
          parentAccountId: null,
          parentAccountName: null,
          sellingNotes: null,
          lastUpdated: null,
        };
      }

      const record = result.records[0];
      const parent = record.Parent!; // We already checked Parent is not null above
      return {
        parentAccountId: record.ParentId,
        parentAccountName: parent.Name,
        sellingNotes: parent.Selling_Notes__c || null,
        lastUpdated: parent.LastModifiedDate
          ? new Date(parent.LastModifiedDate)
          : null,
      };
    } catch (error) {
      logger.error({ error, accountId }, 'Failed to query parent notes');
      return {
        parentAccountId: null,
        parentAccountName: null,
        sellingNotes: null,
        lastUpdated: null,
      };
    }
  }

  /**
   * Search for an account by property name and get parent notes
   */
  async getParentNotesByPropertyName(propertyName: string): Promise<ParentNotes> {
    const conn = await this.ensureConnected();

    try {
      logger.info({ propertyName }, 'Searching for account by property name');

      // Use LIKE for fuzzy matching
      const query = `
        SELECT
          Id,
          Name,
          ParentId,
          Parent.Name,
          Parent.Selling_Notes__c,
          Parent.LastModifiedDate
        FROM Account
        WHERE Name LIKE '%${this.escapeSOQL(propertyName)}%'
        LIMIT 1
      `;

      const result = await conn.query<SalesforceAccountWithParent>(query);

      if (result.records.length === 0) {
        return {
          parentAccountId: null,
          parentAccountName: null,
          sellingNotes: null,
          lastUpdated: null,
        };
      }

      const record = result.records[0];

      if (!record.Parent) {
        return {
          parentAccountId: null,
          parentAccountName: null,
          sellingNotes: null,
          lastUpdated: null,
        };
      }

      return {
        parentAccountId: record.ParentId,
        parentAccountName: record.Parent.Name,
        sellingNotes: record.Parent.Selling_Notes__c || null,
        lastUpdated: record.Parent.LastModifiedDate
          ? new Date(record.Parent.LastModifiedDate)
          : null,
      };
    } catch (error) {
      logger.error({ error, propertyName }, 'Failed to search for parent notes');
      return {
        parentAccountId: null,
        parentAccountName: null,
        sellingNotes: null,
        lastUpdated: null,
      };
    }
  }

  // ===========================================================================
  // BULK OPERATIONS
  // ===========================================================================

  /**
   * Get all active customers for batch brief generation
   */
  async getAllActiveCustomers(): Promise<Competitor[]> {
    const conn = await this.ensureConnected();

    try {
      logger.info('Querying all active customers');

      const query = `
        SELECT
          Id,
          Name,
          ShippingCity,
          ShippingState,
          Active_Customer__c,
          Parent.Name,
          Management_Company__c,
          Brand_Affiliation__c,
          Contract_Value__c,
          Product_Used__c
        FROM Account
        WHERE Active_Customer__c = true
        ORDER BY Name
      `;

      const result = await conn.query<SalesforceAccount>(query);

      return result.records.map((record) => ({
        accountId: record.Id,
        accountName: record.Name,
        shippingCity: record.ShippingCity,
        shippingState: record.ShippingState,
        isActiveCustomer: record.Active_Customer__c,
        parentAccountName: record.Parent?.Name || null,
        managementCompany: record.Management_Company__c,
        brandAffiliation: record.Brand_Affiliation__c,
        contractValue: record.Contract_Value__c,
        productUsed: record.Product_Used__c,
      }));
    } catch (error) {
      logger.error({ error }, 'Failed to query all active customers');
      return [];
    }
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  private escapeSOQL(value: string): string {
    // Escape single quotes for SOQL
    return value.replace(/'/g, "\\'");
  }
}

// =============================================================================
// SALESFORCE TYPES
// =============================================================================

interface SalesforceAccount {
  Id: string;
  Name: string;
  ShippingCity: string | null;
  ShippingState: string | null;
  Active_Customer__c: boolean;
  Parent?: {
    Name: string;
  } | null;
  Management_Company__c: string | null;
  Brand_Affiliation__c: string | null;
  Contract_Value__c: number | null;
  Product_Used__c: string | null;
}

interface SalesforceAccountWithParent {
  Id: string;
  Name: string;
  ShippingCity: string | null;
  ShippingState: string | null;
  Active_Customer__c: boolean;
  ParentId: string | null;
  Parent: {
    Name: string;
    Selling_Notes__c?: string;
    LastModifiedDate?: string;
  } | null;
  Management_Company__c: string | null;
  Brand_Affiliation__c: string | null;
  Contract_Value__c: number | null;
  Product_Used__c: string | null;
}
