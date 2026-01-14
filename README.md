# Sales Ramp AI

AI-Accelerated Sales Ramp System designed to reduce sales rep ramp time from ~11 weeks to 6-8 weeks.

## Overview

This system provides three core capabilities:

1. **Live Call Brief Builder** - Instant property intelligence during sales calls
2. **Kaia → Outreach CRM Automation** - Automatic stage updates from call transcripts
3. **Stall Detection System** - Early warning alerts for deal stalls

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Chrome Extension                          │
│                    (Live Call Brief UI)                          │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Express API Server                          │
├─────────────────┬─────────────────┬─────────────────────────────┤
│  Brief Builder  │  CRM Automation │    Stall Detection          │
│    Service      │     Service     │       Service               │
└────────┬────────┴────────┬────────┴────────┬────────────────────┘
         │                 │                 │
         ▼                 ▼                 ▼
┌────────────────┐ ┌──────────────┐ ┌──────────────────┐
│   Firecrawl    │ │    Kaia      │ │   Alert Service  │
│   (Scraping)   │ │  (Webhooks)  │ │ (Slack/Email)    │
├────────────────┤ ├──────────────┤ └──────────────────┘
│   Salesforce   │ │   Outreach   │
│   (CRM Data)   │ │   (Stages)   │
├────────────────┤ └──────────────┘
│    LinkedIn    │
│   (Contacts)   │
└────────────────┘
```

## Quick Start

### Prerequisites

- Node.js 18+
- Redis (optional, for caching)
- Firecrawl API key
- Salesforce credentials
- Outreach.io OAuth app (for CRM automation)

### Installation

```bash
# Clone the repository
git clone https://github.com/your-org/sales-ramp-ai.git
cd sales-ramp-ai

# Install dependencies
npm install

# Copy environment configuration
cp .env.example .env

# Edit .env with your credentials
vim .env

# Build the project
npm run build

# Start the server
npm start
```

### Development

```bash
# Run in development mode with hot reload
npm run dev

# Type checking
npm run typecheck

# Linting
npm run lint

# Run tests
npm run test
```

## Components

### 1. Live Call Brief Builder

Generates comprehensive property briefs by aggregating data from multiple sources:

- **Property Scope** - @kaykas/hotel-scraping-sdk (venue scraping, room counts, meeting space data, pricing calculations)
- **Local Competitors** - From Salesforce (same city, competing properties)
- **Adjacency Customers** - Existing customers in same market or same brand, from Salesforce
- **Parent Notes** - Selling notes from parent account
- **Contact Links** - LinkedIn search URLs for decision makers
- **Recent Articles** - News mentions from last 90 days

**API Endpoints:**

```bash
# Generate a brief (POST)
curl -X POST http://localhost:3000/api/brief \
  -H "Content-Type: application/json" \
  -d '{"propertyName": "Marriott Downtown", "city": "San Francisco", "state": "CA"}'

# Get cached or generate brief (GET)
curl http://localhost:3000/api/brief/Marriott%20Downtown?city=San%20Francisco&state=CA

# Force refresh
curl http://localhost:3000/api/brief/Marriott%20Downtown?refresh=true

# Invalidate cache
curl -X DELETE http://localhost:3000/api/cache/Marriott%20Downtown
```

### 2. Chrome Extension

Located in `/extension/` - provides real-time brief access during calls.

**Installation:**
1. Open Chrome → Extensions → Enable Developer Mode
2. Click "Load unpacked"
3. Select the `extension/` directory

**Features:**
- Property search popup
- Brief display with all sections
- Outreach.io page integration
- Data quality indicators

### 3. Kaia → Outreach CRM Automation

Receives call transcripts via webhook, extracts signals, and updates Outreach stages.

**Signal Types Detected (18 total):**
- Meeting scheduled, Demo requested, Pricing discussed
- Budget confirmed, Timeline established, Decision maker identified
- Competitor mentioned, Objection raised, Follow-up needed
- Contract requested, Technical requirements, Trial requested
- Referral given, Champion identified, Legal review needed
- Procurement involved, Executive sponsor, Custom integration

**Stage Mapping Rules:**

| Signal | → Stage | Confidence |
|--------|---------|------------|
| Contract requested | Negotiation | High |
| Pricing + Budget | Proposal | High |
| Demo + Technical reqs | Evaluation | Medium |
| Meeting scheduled | Discovery | Medium |

**Confidence Routing:**
- **High (>0.8)** - Auto-update stage
- **Medium (0.5-0.8)** - Flag for review
- **Low (<0.5)** - No action, logged only

**Webhook Endpoint:**
```bash
POST /api/webhooks/kaia
  Headers: X-Kaia-Signature (HMAC-SHA256)
  Body: KaiaTranscript
```

### 4. Stall Detection System

Analyzes call transcripts and emails for stall indicators.

**Stall Categories (8 types):**
- Budget constraints
- Timeline delays
- Decision maker unavailable
- Competitor evaluation
- Internal reorganization
- Procurement blockers
- Technical concerns
- Generic stalls

**Features:**
- 40+ regex patterns for phrase detection
- Time-decay scoring (recent signals weighted higher)
- Multi-channel alerts (Webhook, Email, Slack, Salesforce Task)
- Severity classification (Low/Medium/High/Critical)

**API Endpoints:**
```bash
# Analyze content for stalls
curl -X POST http://localhost:3000/api/stalls/analyze \
  -H "Content-Type: application/json" \
  -d '{"opportunityId": "opp123", "content": "We need to revisit this next quarter", "contentType": "call_transcript"}'

# Get stall status for opportunity
curl http://localhost:3000/api/stalls/opp123
```

## Data Sources

| Source | Data | Method |
|--------|------|--------|
| OTAs (Booking, Expedia, TripAdvisor) | Property scope | Firecrawl scraping |
| Google News | Recent articles (90 days) | Firecrawl scraping |
| Salesforce | Local competitors, adjacency customers, parent notes | JSForce queries |
| LinkedIn | DOSM/GM search links | URL generation |
| Kaia | Call transcripts | Webhook |

## Project Structure

```
sales-ramp-ai/
├── src/
│   ├── adapters/           # External service integrations
│   │   ├── firecrawl.adapter.ts
│   │   ├── kaia.adapter.ts
│   │   ├── linkedin.adapter.ts
│   │   ├── outreach.adapter.ts
│   │   └── salesforce.adapter.ts
│   ├── api/                # REST endpoints
│   │   ├── routes.ts       # Brief Builder routes
│   │   ├── stalls.ts       # Stall Detection routes
│   │   └── webhooks.ts     # Kaia webhook handler
│   ├── services/           # Business logic
│   │   ├── alert.service.ts
│   │   ├── audit.service.ts
│   │   ├── brief-builder.service.ts
│   │   ├── cache.service.ts
│   │   ├── stage-engine.service.ts
│   │   └── stall-detector.service.ts
│   ├── types/              # TypeScript types & Zod schemas
│   │   ├── brief.ts
│   │   ├── crm-automation.ts
│   │   └── stall.ts
│   ├── jobs/               # Background jobs
│   │   └── nightly-cache.job.ts
│   ├── utils/
│   │   └── logger.ts
│   └── index.ts            # Application entry point
├── extension/              # Chrome Extension
│   ├── manifest.json
│   ├── background.js
│   ├── popup.html/js/css
│   ├── content.js/css
│   └── icons/
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

## Environment Variables

See `.env.example` for all configuration options.

### Required Services

| Service | Purpose | Sign Up |
|---------|---------|---------|
| Firecrawl | Web scraping | https://firecrawl.dev |
| Salesforce | CRM data | Your org |
| Outreach.io | Sales engagement | https://developers.outreach.io |
| Kaia | Call transcripts | Your Kaia admin |

### Optional Services

| Service | Purpose |
|---------|---------|
| Redis | Brief caching |
| Slack | Alert notifications |
| SMTP | Email alerts |

## Nightly Cache Job

Pre-generate briefs for assigned territories:

```bash
# Run once (for testing)
npm run build && node dist/jobs/nightly-cache.job.js once

# Run as scheduled job (2 AM daily)
npm run build && node dist/jobs/nightly-cache.job.js
```

## Deployment

### Docker

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist/ ./dist/
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

### Health Check

```
GET /health
Returns: { status: "ok", timestamp: "..." }
```

## Contributing

1. Create a feature branch
2. Make changes with tests
3. Run `npm run typecheck && npm run lint && npm run test`
4. Submit PR for review

## Status

- [x] Brief Builder Service (Firecrawl + Salesforce + LinkedIn)
- [x] Chrome Extension (Live Call Brief UI)
- [x] Kaia → Outreach CRM Automation
- [x] Stall Detection System

## License

Proprietary - Internal Use Only
