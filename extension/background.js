// =============================================================================
// LIVE CALL BRIEF - BACKGROUND SERVICE WORKER
// Handles API calls and caching for the extension
// =============================================================================

const API_BASE_URL = 'http://localhost:3000/api';
const REQUEST_TIMEOUT_MS = 10000; // 10 second timeout

// In-memory cache for quick access (supplements server-side caching)
const briefCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes local cache

// =============================================================================
// API FUNCTIONS
// =============================================================================

/**
 * Fetch a brief from the API
 * @param {Object} params - Search parameters
 * @param {string} params.propertyName - Property name to search
 * @param {string} [params.city] - City filter
 * @param {string} [params.state] - State filter
 * @param {boolean} [params.forceRefresh] - Force bypass cache
 * @returns {Promise<Object>} Brief response
 */
async function fetchBrief({ propertyName, city, state, forceRefresh = false }) {
  const startTime = performance.now();

  // Check local cache first (unless force refresh)
  const cacheKey = generateCacheKey(propertyName, city, state);
  if (!forceRefresh && briefCache.has(cacheKey)) {
    const cached = briefCache.get(cacheKey);
    if (Date.now() - cached.timestamp < CACHE_TTL_MS) {
      console.log('[LiveCallBrief] Returning local cached brief');
      return {
        ...cached.data,
        fromLocalCache: true,
        localCacheAge: Date.now() - cached.timestamp
      };
    }
    // Cache expired, remove it
    briefCache.delete(cacheKey);
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const response = await fetch(`${API_BASE_URL}/brief`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        propertyName,
        city,
        state,
        forceRefresh
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    const totalTime = performance.now() - startTime;

    console.log(`[LiveCallBrief] Brief fetched in ${totalTime.toFixed(0)}ms`);

    // Update local cache
    briefCache.set(cacheKey, {
      data,
      timestamp: Date.now()
    });

    return {
      ...data,
      clientFetchTimeMs: totalTime,
      fromLocalCache: false
    };

  } catch (error) {
    const totalTime = performance.now() - startTime;
    console.error('[LiveCallBrief] API Error:', error.message);

    if (error.name === 'AbortError') {
      throw new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }

    throw error;
  }
}

/**
 * Check API health
 * @returns {Promise<Object>} Health status
 */
async function checkHealth() {
  try {
    const response = await fetch(`${API_BASE_URL}/health`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      }
    });

    if (!response.ok) {
      return { healthy: false, error: `HTTP ${response.status}` };
    }

    const data = await response.json();
    return { healthy: data.status === 'healthy', ...data };

  } catch (error) {
    return { healthy: false, error: error.message };
  }
}

/**
 * Generate cache key from search parameters
 */
function generateCacheKey(propertyName, city, state) {
  return `${propertyName?.toLowerCase().trim()}|${city?.toLowerCase().trim() || ''}|${state?.toLowerCase().trim() || ''}`;
}

// =============================================================================
// MESSAGE HANDLERS
// =============================================================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[LiveCallBrief] Message received:', request.action);

  switch (request.action) {
    case 'fetchBrief':
      fetchBrief(request.params)
        .then(result => sendResponse({ success: true, data: result }))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true; // Keep message channel open for async response

    case 'checkHealth':
      checkHealth()
        .then(result => sendResponse(result))
        .catch(error => sendResponse({ healthy: false, error: error.message }));
      return true;

    case 'clearLocalCache':
      briefCache.clear();
      sendResponse({ success: true, message: 'Local cache cleared' });
      return false;

    case 'getCacheStats':
      sendResponse({
        localCacheSize: briefCache.size,
        cacheTTLMs: CACHE_TTL_MS
      });
      return false;

    default:
      sendResponse({ error: 'Unknown action' });
      return false;
  }
});

// =============================================================================
// EXTENSION LIFECYCLE
// =============================================================================

chrome.runtime.onInstalled.addListener((details) => {
  console.log('[LiveCallBrief] Extension installed:', details.reason);

  // Set default settings
  chrome.storage.local.set({
    apiBaseUrl: API_BASE_URL,
    defaultCollapsed: false,
    lastUsed: Date.now()
  });
});

chrome.runtime.onStartup.addListener(() => {
  console.log('[LiveCallBrief] Extension started');
});

// Log any errors
self.addEventListener('error', (event) => {
  console.error('[LiveCallBrief] Service worker error:', event.error);
});

console.log('[LiveCallBrief] Background service worker initialized');
