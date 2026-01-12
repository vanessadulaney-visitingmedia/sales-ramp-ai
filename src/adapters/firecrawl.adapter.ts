import FirecrawlApp from '@mendable/firecrawl-js';
import { PropertyScope, Article } from '../types/brief.js';
import { logger } from '../utils/logger.js';

// =============================================================================
// FIRECRAWL ADAPTER
// Handles all web scraping via Firecrawl API
// =============================================================================

export class FirecrawlAdapter {
  private client: FirecrawlApp;
  private rateLimitDelay = 1000; // 1 second between requests

  constructor(apiKey: string) {
    this.client = new FirecrawlApp({ apiKey });
    logger.info('FirecrawlAdapter initialized');
  }

  // ===========================================================================
  // PROPERTY SCOPE SCRAPING
  // ===========================================================================

  /**
   * Scrape property data from an OTA URL
   */
  async scrapePropertyFromUrl(url: string): Promise<PropertyScope | null> {
    try {
      logger.info({ url }, 'Scraping property from URL');

      const result = await this.client.scrape(url, {
        formats: ['markdown'],
      });

      if (!result || !result.markdown) {
        logger.warn({ url }, 'Failed to scrape property - no markdown content');
        return null;
      }

      // Parse property data from markdown content
      const extracted = this.parsePropertyFromMarkdown(result.markdown, url);
      return extracted;
    } catch (error) {
      logger.error({ error, url }, 'Error scraping property');
      return null;
    }
  }

  /**
   * Parse property information from markdown content
   */
  private parsePropertyFromMarkdown(markdown: string, url: string): PropertyScope | null {
    try {
      // Extract property name from first heading or title
      const nameMatch = markdown.match(/^#\s+(.+)$/m) || markdown.match(/^##\s+(.+)$/m);
      const name = nameMatch ? nameMatch[1].trim() : 'Unknown Property';

      // Extract rating (look for patterns like "4.5/5" or "8.9/10" or "★ 4.5")
      const ratingMatch = markdown.match(/(\d+\.?\d*)\s*[\/out of]*\s*(5|10)/i) ||
                          markdown.match(/★\s*(\d+\.?\d*)/);
      const ratingScore = ratingMatch ? parseFloat(ratingMatch[1]) : null;

      // Extract review count
      const reviewMatch = markdown.match(/(\d+,?\d*)\s*reviews?/i);
      const reviewCount = reviewMatch ? parseInt(reviewMatch[1].replace(',', ''), 10) : null;

      // Extract amenities (common patterns)
      const amenityPatterns = [
        /pool/i, /gym/i, /fitness/i, /spa/i, /restaurant/i, /bar/i,
        /wifi/i, /parking/i, /breakfast/i, /room service/i, /concierge/i,
        /pet[\s-]?friendly/i, /beach/i, /ocean view/i, /balcony/i
      ];
      const amenities = amenityPatterns
        .filter(pattern => pattern.test(markdown))
        .map(pattern => {
          const match = markdown.match(pattern);
          return match ? match[0] : '';
        })
        .filter(Boolean);

      // Extract price range
      const priceMatch = markdown.match(/\$(\d+)\s*[-–]\s*\$?(\d+)/);
      const priceRange = priceMatch ? `$${priceMatch[1]}-$${priceMatch[2]}` : null;

      // Extract property type
      const typePatterns = ['Hotel', 'Resort', 'Boutique Hotel', 'Inn', 'B&B', 'Motel', 'Lodge'];
      const propertyType = typePatterns.find(type =>
        markdown.toLowerCase().includes(type.toLowerCase())
      ) || null;

      // Try to extract address/location info
      const addressMatch = markdown.match(/(\d+[^,\n]+,\s*[A-Z][a-z]+[^,\n]*,\s*[A-Z]{2}\s*\d{5})/);
      const address = addressMatch ? addressMatch[1] : null;

      // Extract city/state from address or URL
      const locationMatch = markdown.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?),\s*([A-Z]{2})/);

      return {
        name,
        address,
        city: locationMatch ? locationMatch[1] : null,
        state: locationMatch ? locationMatch[2] : null,
        roomCount: null, // Hard to extract reliably
        amenities,
        ratingScore,
        reviewCount,
        priceRange,
        propertyType,
        source: this.extractDomain(url),
        sourceUrl: url,
        scrapedAt: new Date(),
      };
    } catch (error) {
      logger.error({ error }, 'Error parsing property from markdown');
      return null;
    }
  }

  /**
   * Search for a property on major OTAs and scrape the best result
   */
  async scrapePropertyScope(
    propertyName: string,
    city?: string,
    state?: string
  ): Promise<PropertyScope | null> {
    const searchQuery = [propertyName, city, state].filter(Boolean).join(' ');
    logger.info({ propertyName, city, state, searchQuery }, 'Searching for property scope');

    // Try multiple OTA sources in order of preference
    const otaSources = [
      this.buildBookingSearchUrl(searchQuery),
      this.buildTripadvisorSearchUrl(searchQuery),
      this.buildExpediaSearchUrl(searchQuery),
    ];

    for (const url of otaSources) {
      try {
        // First, search and get the property page URL
        const searchResult = await this.client.scrape(url, {
          formats: ['markdown', 'links'],
        });

        if (!searchResult) {
          continue;
        }

        // Find the first property link from search results
        const links = (searchResult.links || []) as string[];
        const propertyUrl = this.findPropertyLink(links, propertyName);

        if (propertyUrl) {
          await this.delay(this.rateLimitDelay);
          const property = await this.scrapePropertyFromUrl(propertyUrl);
          if (property) {
            return property;
          }
        }
      } catch (error) {
        logger.warn({ error, url }, 'Failed to search OTA');
        continue;
      }

      await this.delay(this.rateLimitDelay);
    }

    logger.warn({ propertyName }, 'Could not find property scope on any OTA');
    return null;
  }

  // ===========================================================================
  // RECENT ARTICLES SCRAPING
  // ===========================================================================

  /**
   * Search for recent news articles about a property
   */
  async scrapeRecentArticles(
    propertyName: string,
    city?: string,
    daysBack: number = 90
  ): Promise<Article[]> {
    const searchQuery = [propertyName, city, 'hotel news'].filter(Boolean).join(' ');
    logger.info({ propertyName, city, daysBack }, 'Searching for recent articles');

    const articles: Article[] = [];

    try {
      // Use Google News search
      const googleNewsUrl = this.buildGoogleNewsUrl(searchQuery, daysBack);

      const result = await this.client.scrape(googleNewsUrl, {
        formats: ['markdown', 'links'],
      });

      if (!result) {
        logger.warn({ searchQuery }, 'Failed to scrape Google News');
        return [];
      }

      // Extract article links from Google News results
      const allLinks = (result.links || []) as string[];
      const articleLinks = allLinks
        .filter((link: string) => this.isNewsArticleLink(link))
        .slice(0, 5); // Limit to 5 articles

      // Scrape each article for metadata
      for (const link of articleLinks) {
        await this.delay(this.rateLimitDelay);

        try {
          const articleResult = await this.client.scrape(link, {
            formats: ['markdown'],
          });

          if (articleResult && articleResult.markdown) {
            const extracted = this.parseArticleFromMarkdown(articleResult.markdown, link);
            if (extracted) {
              articles.push(extracted);
            }
          }
        } catch (error) {
          logger.warn({ error, link }, 'Failed to scrape article');
        }
      }
    } catch (error) {
      logger.error({ error, propertyName }, 'Error searching for articles');
    }

    return articles;
  }

  /**
   * Parse article metadata from markdown content
   */
  private parseArticleFromMarkdown(markdown: string, url: string): Article | null {
    try {
      // Extract title from first heading
      const titleMatch = markdown.match(/^#\s+(.+)$/m);
      const title = titleMatch ? titleMatch[1].trim() : 'Untitled Article';

      // Extract first paragraph as snippet
      const paragraphs = markdown.split('\n\n').filter(p =>
        p.trim() && !p.startsWith('#') && p.length > 50
      );
      const snippet = paragraphs[0]?.slice(0, 300) || null;

      return {
        title,
        url,
        source: this.extractDomain(url),
        publishedDate: null, // Hard to extract reliably
        snippet,
        scrapedAt: new Date(),
      };
    } catch (error) {
      logger.error({ error }, 'Error parsing article from markdown');
      return null;
    }
  }

  // ===========================================================================
  // BATCH OPERATIONS (for nightly cache jobs)
  // ===========================================================================

  /**
   * Batch scrape multiple properties
   */
  async batchScrapeProperties(
    properties: Array<{ name: string; city?: string; state?: string }>
  ): Promise<Map<string, PropertyScope | null>> {
    const results = new Map<string, PropertyScope | null>();

    logger.info({ count: properties.length }, 'Starting batch property scrape');

    for (const property of properties) {
      const key = `${property.name}|${property.city || ''}|${property.state || ''}`;

      try {
        const scope = await this.scrapePropertyScope(
          property.name,
          property.city,
          property.state
        );
        results.set(key, scope);
      } catch (error) {
        logger.error({ error, property }, 'Batch scrape failed for property');
        results.set(key, null);
      }

      // Rate limiting between batch items
      await this.delay(this.rateLimitDelay * 2);
    }

    logger.info(
      { total: properties.length, success: [...results.values()].filter(Boolean).length },
      'Batch scrape complete'
    );

    return results;
  }

  // ===========================================================================
  // HELPER METHODS
  // ===========================================================================

  private buildBookingSearchUrl(query: string): string {
    return `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(query)}`;
  }

  private buildTripadvisorSearchUrl(query: string): string {
    return `https://www.tripadvisor.com/Search?q=${encodeURIComponent(query)}`;
  }

  private buildExpediaSearchUrl(query: string): string {
    return `https://www.expedia.com/Hotel-Search?destination=${encodeURIComponent(query)}`;
  }

  private buildGoogleNewsUrl(query: string, daysBack: number): string {
    // Google News search with time filter
    const dateFilter = `when:${Math.ceil(daysBack / 30)}m`; // Convert days to months
    return `https://news.google.com/search?q=${encodeURIComponent(query)}+${dateFilter}`;
  }

  private findPropertyLink(links: string[], propertyName: string): string | null {
    const normalizedName = propertyName.toLowerCase();

    // Look for links that likely point to a property page
    const propertyPatterns = ['/hotel/', '/hotels/', '/property/', '/h/', '/Hotel_Review'];

    for (const link of links) {
      const hasPropertyPattern = propertyPatterns.some((p) => link.includes(p));
      const linkLower = link.toLowerCase();

      // Check if link contains property name words
      const nameWords = normalizedName.split(/\s+/);
      const containsNameWords = nameWords.some((word) =>
        word.length > 3 ? linkLower.includes(word) : false
      );

      if (hasPropertyPattern && containsNameWords) {
        return link;
      }
    }

    return null;
  }

  private isNewsArticleLink(link: string): boolean {
    // Filter out non-article links
    const excludePatterns = [
      'google.com',
      'facebook.com',
      'twitter.com',
      'linkedin.com',
      'youtube.com',
      '/search',
      '/tag/',
      '/category/',
    ];

    return !excludePatterns.some((p) => link.includes(p));
  }

  private extractDomain(url: string): string {
    try {
      const domain = new URL(url).hostname;
      return domain.replace('www.', '');
    } catch {
      return 'unknown';
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
