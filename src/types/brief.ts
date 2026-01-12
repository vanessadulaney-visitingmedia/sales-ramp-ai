import { z } from 'zod';

// =============================================================================
// PROPERTY SCOPE (from OTA scraping via Firecrawl)
// =============================================================================

export const PropertyScopeSchema = z.object({
  name: z.string(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  roomCount: z.number().nullable(),
  amenities: z.array(z.string()).default([]),
  ratingScore: z.number().nullable(),
  reviewCount: z.number().nullable(),
  priceRange: z.string().nullable(),
  propertyType: z.string().nullable(), // Hotel, Resort, B&B, etc.
  source: z.string(), // Which OTA the data came from
  sourceUrl: z.string().nullable(),
  scrapedAt: z.date(),
});

export type PropertyScope = z.infer<typeof PropertyScopeSchema>;

// =============================================================================
// COMPETITOR / ADJACENCY DATA (from Salesforce)
// =============================================================================

export const CompetitorSchema = z.object({
  accountId: z.string(),
  accountName: z.string(),
  shippingCity: z.string().nullable(),
  shippingState: z.string().nullable(),
  isActiveCustomer: z.boolean(),
  parentAccountName: z.string().nullable(),
  managementCompany: z.string().nullable(),
  brandAffiliation: z.string().nullable(),
  contractValue: z.number().nullable(),
  productUsed: z.string().nullable(),
});

export type Competitor = z.infer<typeof CompetitorSchema>;

export const AdjacencyDataSchema = z.object({
  localCompetitors: z.array(CompetitorSchema).max(2), // 2 local competitors using platform
  adjacencyCustomers: z.array(CompetitorSchema).max(2), // Same brand or management company
});

export type AdjacencyData = z.infer<typeof AdjacencyDataSchema>;

// =============================================================================
// PARENT ACCOUNT NOTES (from Salesforce)
// =============================================================================

export const ParentNotesSchema = z.object({
  parentAccountId: z.string().nullable(),
  parentAccountName: z.string().nullable(),
  sellingNotes: z.string().nullable(),
  lastUpdated: z.date().nullable(),
});

export type ParentNotes = z.infer<typeof ParentNotesSchema>;

// =============================================================================
// CONTACT INFO (LinkedIn search links - MVP)
// =============================================================================

export const ContactLinksSchema = z.object({
  dosmSearchUrl: z.string().nullable(), // Director of Sales & Marketing
  gmSearchUrl: z.string().nullable(), // General Manager
  propertyName: z.string(),
});

export type ContactLinks = z.infer<typeof ContactLinksSchema>;

// =============================================================================
// RECENT ARTICLES (from web scraping via Firecrawl)
// =============================================================================

export const ArticleSchema = z.object({
  title: z.string(),
  url: z.string(),
  source: z.string(), // Publication name
  publishedDate: z.date().nullable(),
  snippet: z.string().nullable(),
  scrapedAt: z.date(),
});

export type Article = z.infer<typeof ArticleSchema>;

// =============================================================================
// COMPLETE LIVE CALL BRIEF
// =============================================================================

export const LiveCallBriefSchema = z.object({
  id: z.string(),
  propertyId: z.string().nullable(),
  propertyName: z.string(),

  // Core brief data
  propertyScope: PropertyScopeSchema.nullable(),
  adjacencyData: AdjacencyDataSchema.nullable(),
  parentNotes: ParentNotesSchema.nullable(),
  contactLinks: ContactLinksSchema.nullable(),
  recentArticles: z.array(ArticleSchema).default([]),

  // Metadata
  generatedAt: z.date(),
  cachedAt: z.date().nullable(),
  cacheExpiresAt: z.date().nullable(),
  generationTimeMs: z.number(),

  // Data quality indicators
  dataQuality: z.object({
    hasPropertyScope: z.boolean(),
    hasLocalCompetitors: z.boolean(),
    hasAdjacencyCustomers: z.boolean(),
    hasParentNotes: z.boolean(),
    hasContactLinks: z.boolean(),
    hasRecentArticles: z.boolean(),
    completenessScore: z.number().min(0).max(100),
  }),
});

export type LiveCallBrief = z.infer<typeof LiveCallBriefSchema>;

// =============================================================================
// API REQUEST/RESPONSE TYPES
// =============================================================================

export const BriefRequestSchema = z.object({
  propertyName: z.string().min(1),
  propertyId: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  forceRefresh: z.boolean().default(false),
});

export type BriefRequest = z.infer<typeof BriefRequestSchema>;

export const BriefResponseSchema = z.object({
  success: z.boolean(),
  brief: LiveCallBriefSchema.nullable(),
  error: z.string().nullable(),
  fromCache: z.boolean(),
  generationTimeMs: z.number(),
});

export type BriefResponse = z.infer<typeof BriefResponseSchema>;
