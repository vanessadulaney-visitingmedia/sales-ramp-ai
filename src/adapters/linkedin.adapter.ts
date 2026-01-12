import { ContactLinks } from '../types/brief.js';
import { logger } from '../utils/logger.js';

// =============================================================================
// LINKEDIN ADAPTER
// MVP: Generates LinkedIn search URLs (no scraping)
// =============================================================================

export class LinkedInAdapter {
  constructor() {
    logger.info('LinkedInAdapter initialized (MVP - search links only)');
  }

  /**
   * Generate LinkedIn search URLs for key contacts at a property
   * MVP approach: No scraping, just provide search links
   */
  generateContactLinks(propertyName: string, city?: string): ContactLinks {
    logger.info({ propertyName, city }, 'Generating LinkedIn search links');

    const locationClause = city ? ` ${city}` : '';

    // DOSM = Director of Sales and Marketing
    const dosmSearchUrl = this.buildLinkedInSearchUrl(
      `"Director of Sales" OR "Director of Sales and Marketing" "${propertyName}"${locationClause}`
    );

    // GM = General Manager
    const gmSearchUrl = this.buildLinkedInSearchUrl(
      `"General Manager" "${propertyName}"${locationClause}`
    );

    return {
      propertyName,
      dosmSearchUrl,
      gmSearchUrl,
    };
  }

  /**
   * Generate LinkedIn search URL for any role
   */
  generateRoleSearchUrl(role: string, propertyName: string, city?: string): string {
    const locationClause = city ? ` ${city}` : '';
    return this.buildLinkedInSearchUrl(`"${role}" "${propertyName}"${locationClause}`);
  }

  /**
   * Generate LinkedIn company search URL
   */
  generateCompanySearchUrl(companyName: string): string {
    return `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(companyName)}`;
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  private buildLinkedInSearchUrl(query: string): string {
    return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(query)}`;
  }
}
