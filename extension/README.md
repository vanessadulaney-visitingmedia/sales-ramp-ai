# Live Call Brief - Chrome Extension

Chrome Extension (Manifest V3) for displaying Live Call Briefs during sales calls.

## Features

- **Property Search**: Search by property name, city, and state
- **Data Quality Indicator**: Visual completeness score showing which data sections are available
- **Collapsible Sections**:
  - Property Scope (rooms, rating, amenities, price range)
  - Local Competitors (nearby properties using the platform)
  - Adjacency Customers (same brand/management company)
  - Parent Selling Notes (from Salesforce)
  - LinkedIn Search Links (DOSM and GM searches)
  - Recent Articles (last 90 days)
- **Force Refresh**: Bypass cache when needed
- **Copy to Clipboard**: Quick copy for LinkedIn URLs
- **Outreach Integration**: Inline panel when viewing prospects

## Installation

### Development Mode

1. **Ensure the API is running**:
   ```bash
   cd /Users/jkw/Projects/sales-ramp-ai
   npm run dev
   ```

2. **Generate PNG icons** (if not already done):
   ```bash
   cd extension
   ./generate-icons.sh
   ```
   Or manually create 16x16, 32x32, 48x48, and 128x128 PNG icons.

3. **Load in Chrome**:
   - Open `chrome://extensions/`
   - Enable "Developer mode" (top right)
   - Click "Load unpacked"
   - Select the `extension` directory

### Production Build

For production distribution, you would:
1. Generate proper PNG icons
2. Optionally minify JS/CSS
3. Package as .crx or submit to Chrome Web Store

## File Structure

```
extension/
├── manifest.json          # Extension manifest (V3)
├── popup.html             # Main popup UI
├── popup.js               # Popup logic and rendering
├── styles.css             # Popup styles
├── background.js          # Service worker for API calls
├── content.js             # Outreach page injection
├── content-styles.css     # Injected panel styles
├── icons/
│   ├── icon16.svg/png
│   ├── icon32.svg/png
│   ├── icon48.svg/png
│   └── icon128.svg/png
└── README.md
```

## API Endpoints

The extension communicates with the Brief Builder Service:

- **Base URL**: `http://localhost:3000/api`
- **POST /brief**: Generate a new brief
- **GET /health**: Check API status

## Configuration

Default settings stored in `chrome.storage.local`:

| Setting | Default | Description |
|---------|---------|-------------|
| `apiBaseUrl` | `http://localhost:3000/api` | API endpoint |
| `defaultCollapsed` | `false` | Start sections collapsed |
| `lastSearch` | `null` | Last search parameters |

## Performance

Target load time: ≤3 seconds

Optimizations:
- Local in-memory cache (5 min TTL)
- Server-side Redis caching (24 hour TTL)
- Request timeout (10 seconds)
- Lazy section rendering

## Error Handling

- Network errors: Shown with retry option
- Timeout: 10 second limit with clear message
- Missing data: "Not found" per section (no inference)
- API disconnection: Status indicator in header

## Data Quality

The completeness score is calculated based on available data:
- Property Scope: 20%
- Local Competitors: 20%
- Adjacency Customers: 15%
- Parent Notes: 15%
- LinkedIn Links: 15%
- Recent Articles: 15%

## Outreach Integration

When installed, the extension adds:
- Floating toggle button (bottom-right)
- Slide-in panel with brief display
- Auto-detection of prospect names (when possible)

The content script only loads on `*.outreach.io` pages.

## Development

### Testing Locally

1. Start the API server:
   ```bash
   npm run dev
   ```

2. Load extension in Chrome developer mode

3. Click the extension icon and search for a property

### Debugging

- Popup: Right-click extension icon → "Inspect popup"
- Background: `chrome://extensions/` → "service worker" link
- Content: Open DevTools on Outreach page

### Common Issues

1. **"Disconnected" status**: Ensure API is running on port 3000
2. **CORS errors**: API should allow extension origin
3. **Icons not showing**: Convert SVGs to PNGs

## Permissions

| Permission | Usage |
|------------|-------|
| `storage` | Save search history and settings |
| `clipboardWrite` | Copy LinkedIn URLs |
| `host_permissions` | API access to localhost:3000 |

## Version History

- **1.0.0**: Initial release
  - Property search and brief display
  - Data quality indicator
  - Collapsible sections
  - Outreach integration
  - LinkedIn URL copying
