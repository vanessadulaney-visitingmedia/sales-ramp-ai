// =============================================================================
// LIVE CALL BRIEF - POPUP SCRIPT
// Main UI logic for the Chrome extension popup
// =============================================================================

// DOM Elements
const elements = {
  // Status
  connectionStatus: document.getElementById('connectionStatus'),

  // Form
  searchForm: document.getElementById('searchForm'),
  propertyName: document.getElementById('propertyName'),
  city: document.getElementById('city'),
  state: document.getElementById('state'),
  searchBtn: document.getElementById('searchBtn'),
  refreshBtn: document.getElementById('refreshBtn'),

  // States
  loadingState: document.getElementById('loadingState'),
  errorState: document.getElementById('errorState'),
  errorMessage: document.getElementById('errorMessage'),
  retryBtn: document.getElementById('retryBtn'),
  resultsContainer: document.getElementById('resultsContainer'),

  // Quality Indicator
  qualityScore: document.getElementById('qualityScore'),
  qualityFill: document.getElementById('qualityFill'),
  qualityBadges: document.getElementById('qualityBadges'),

  // Metadata
  metaProperty: document.getElementById('metaProperty'),
  metaGenerated: document.getElementById('metaGenerated'),
  metaCache: document.getElementById('metaCache'),

  // Sections
  sections: document.getElementById('sections'),

  // Section Status badges
  propertyScopeStatus: document.getElementById('propertyScopeStatus'),
  competitorsStatus: document.getElementById('competitorsStatus'),
  adjacencyStatus: document.getElementById('adjacencyStatus'),
  parentNotesStatus: document.getElementById('parentNotesStatus'),
  linkedinStatus: document.getElementById('linkedinStatus'),
  articlesStatus: document.getElementById('articlesStatus'),

  // Section Content
  propertyScopeContent: document.getElementById('propertyScopeContent'),
  competitorsContent: document.getElementById('competitorsContent'),
  adjacencyContent: document.getElementById('adjacencyContent'),
  parentNotesContent: document.getElementById('parentNotesContent'),
  linkedinContent: document.getElementById('linkedinContent'),
  articlesContent: document.getElementById('articlesContent'),

  // Performance
  perfGenTime: document.getElementById('perfGenTime'),
  perfFetchTime: document.getElementById('perfFetchTime'),

  // Toast
  toast: document.getElementById('toast'),
  toastMessage: document.getElementById('toastMessage'),
};

// State
let currentBrief = null;
let lastSearchParams = null;

// =============================================================================
// INITIALIZATION
// =============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  console.log('[LiveCallBrief] Popup initialized');

  // Check API connection
  await checkConnection();

  // Load last search from storage
  const stored = await chrome.storage.local.get(['lastSearch']);
  if (stored.lastSearch) {
    elements.propertyName.value = stored.lastSearch.propertyName || '';
    elements.city.value = stored.lastSearch.city || '';
    elements.state.value = stored.lastSearch.state || '';
  }

  // Setup event listeners
  setupEventListeners();

  // Setup section toggles
  setupSectionToggles();
});

function setupEventListeners() {
  // Search form
  elements.searchForm.addEventListener('submit', handleSearch);

  // Retry button
  elements.retryBtn.addEventListener('click', () => {
    if (lastSearchParams) {
      performSearch(lastSearchParams);
    }
  });

  // Refresh button
  elements.refreshBtn.addEventListener('click', () => {
    if (lastSearchParams) {
      performSearch({ ...lastSearchParams, forceRefresh: true });
    }
  });

  // State input - uppercase
  elements.state.addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase();
  });
}

function setupSectionToggles() {
  const sectionHeaders = document.querySelectorAll('.section-header');

  sectionHeaders.forEach(header => {
    header.addEventListener('click', () => {
      const section = header.closest('.section');
      section.classList.toggle('expanded');
    });
  });
}

// =============================================================================
// API COMMUNICATION
// =============================================================================

async function checkConnection() {
  elements.connectionStatus.textContent = 'Checking...';
  elements.connectionStatus.className = 'status-badge status-checking';

  try {
    const response = await chrome.runtime.sendMessage({ action: 'checkHealth' });

    if (response.healthy) {
      elements.connectionStatus.textContent = 'Connected';
      elements.connectionStatus.className = 'status-badge status-connected';
    } else {
      elements.connectionStatus.textContent = 'Disconnected';
      elements.connectionStatus.className = 'status-badge status-disconnected';
    }
  } catch (error) {
    console.error('[LiveCallBrief] Connection check failed:', error);
    elements.connectionStatus.textContent = 'Disconnected';
    elements.connectionStatus.className = 'status-badge status-disconnected';
  }
}

async function handleSearch(e) {
  e.preventDefault();

  const params = {
    propertyName: elements.propertyName.value.trim(),
    city: elements.city.value.trim() || undefined,
    state: elements.state.value.trim() || undefined,
    forceRefresh: false
  };

  if (!params.propertyName) {
    showToast('Please enter a property name');
    return;
  }

  // Save search params
  lastSearchParams = params;
  await chrome.storage.local.set({ lastSearch: params });

  performSearch(params);
}

async function performSearch(params) {
  console.log('[LiveCallBrief] Searching:', params);

  // Show loading state
  showState('loading');
  setButtonLoading(true);

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'fetchBrief',
      params
    });

    if (response.success && response.data.success) {
      currentBrief = response.data.brief;
      renderBrief(response.data);
      showState('results');
      elements.refreshBtn.disabled = false;
    } else {
      throw new Error(response.error || response.data?.error || 'Failed to fetch brief');
    }

  } catch (error) {
    console.error('[LiveCallBrief] Search failed:', error);
    elements.errorMessage.textContent = error.message;
    showState('error');
  } finally {
    setButtonLoading(false);
  }
}

// =============================================================================
// RENDERING
// =============================================================================

function renderBrief(data) {
  const brief = data.brief;

  // Render quality indicator
  renderQualityIndicator(brief.dataQuality);

  // Render metadata
  renderMetadata(brief, data);

  // Render each section
  renderPropertyScope(brief.propertyScope);
  renderCompetitors(brief.adjacencyData?.localCompetitors);
  renderAdjacency(brief.adjacencyData?.adjacencyCustomers);
  renderParentNotes(brief.parentNotes);
  renderLinkedIn(brief.contactLinks);
  renderArticles(brief.recentArticles);

  // Render performance info
  renderPerformance(brief, data);

  // Expand sections that have data by default
  expandSectionsWithData(brief.dataQuality);
}

function renderQualityIndicator(quality) {
  const score = quality.completenessScore;

  // Score display
  elements.qualityScore.textContent = `${score}%`;

  // Progress bar
  elements.qualityFill.style.width = `${score}%`;
  elements.qualityFill.className = 'quality-fill';
  if (score >= 70) {
    elements.qualityFill.classList.add('quality-high');
  } else if (score >= 40) {
    elements.qualityFill.classList.add('quality-medium');
  } else {
    elements.qualityFill.classList.add('quality-low');
  }

  // Badges
  const badges = [
    { key: 'hasPropertyScope', label: 'Scope' },
    { key: 'hasLocalCompetitors', label: 'Competitors' },
    { key: 'hasAdjacencyCustomers', label: 'Adjacency' },
    { key: 'hasParentNotes', label: 'Notes' },
    { key: 'hasContactLinks', label: 'LinkedIn' },
    { key: 'hasRecentArticles', label: 'Articles' },
  ];

  elements.qualityBadges.innerHTML = badges.map(badge => `
    <span class="quality-badge ${quality[badge.key] ? 'has-data' : 'missing-data'}">
      ${badge.label}
    </span>
  `).join('');
}

function renderMetadata(brief, data) {
  elements.metaProperty.textContent = brief.propertyName;

  const generatedAt = new Date(brief.generatedAt);
  elements.metaGenerated.textContent = `Generated: ${formatTime(generatedAt)}`;

  if (data.fromCache) {
    elements.metaCache.textContent = 'Cached';
    elements.metaCache.style.color = 'var(--success)';
  } else {
    elements.metaCache.textContent = 'Fresh';
    elements.metaCache.style.color = 'var(--info)';
  }
}

function renderPropertyScope(scope) {
  if (!scope) {
    elements.propertyScopeStatus.textContent = 'Not found';
    elements.propertyScopeStatus.className = 'section-status not-found';
    elements.propertyScopeContent.innerHTML = renderNotFound('Property scope data not available');
    return;
  }

  elements.propertyScopeStatus.textContent = 'Found';
  elements.propertyScopeStatus.className = 'section-status has-data';

  elements.propertyScopeContent.innerHTML = `
    <div class="property-details">
      <div class="detail-item">
        <div class="detail-label">Type</div>
        <div class="detail-value ${!scope.propertyType ? 'not-available' : ''}">${scope.propertyType || 'N/A'}</div>
      </div>
      <div class="detail-item">
        <div class="detail-label">Rooms</div>
        <div class="detail-value ${!scope.roomCount ? 'not-available' : ''}">${scope.roomCount || 'N/A'}</div>
      </div>
      <div class="detail-item">
        <div class="detail-label">Rating</div>
        <div class="detail-value ${!scope.ratingScore ? 'not-available' : ''}">
          ${scope.ratingScore ? `${scope.ratingScore.toFixed(1)} (${scope.reviewCount} reviews)` : 'N/A'}
        </div>
      </div>
      <div class="detail-item">
        <div class="detail-label">Price Range</div>
        <div class="detail-value ${!scope.priceRange ? 'not-available' : ''}">${scope.priceRange || 'N/A'}</div>
      </div>
      <div class="detail-item full-width">
        <div class="detail-label">Address</div>
        <div class="detail-value ${!scope.address ? 'not-available' : ''}">${formatAddress(scope)}</div>
      </div>
      ${scope.amenities.length > 0 ? `
        <div class="detail-item full-width">
          <div class="detail-label">Amenities</div>
          <div class="detail-value">${scope.amenities.slice(0, 5).join(', ')}${scope.amenities.length > 5 ? '...' : ''}</div>
        </div>
      ` : ''}
      <div class="detail-item full-width">
        <div class="detail-label">Source</div>
        <div class="detail-value">
          ${scope.sourceUrl ? `<a href="${scope.sourceUrl}" target="_blank">${scope.source}</a>` : scope.source}
        </div>
      </div>
    </div>
  `;
}

function renderCompetitors(competitors) {
  if (!competitors || competitors.length === 0) {
    elements.competitorsStatus.textContent = 'Not found';
    elements.competitorsStatus.className = 'section-status not-found';
    elements.competitorsContent.innerHTML = renderNotFound('No local competitors found');
    return;
  }

  elements.competitorsStatus.textContent = `${competitors.length} found`;
  elements.competitorsStatus.className = 'section-status has-data';

  elements.competitorsContent.innerHTML = competitors.map(comp => `
    <div class="customer-card">
      <div class="customer-name">
        ${comp.accountName}
        ${comp.isActiveCustomer ? '<span class="customer-badge">Active Customer</span>' : ''}
      </div>
      <div class="customer-details">
        ${comp.shippingCity ? `<span>${comp.shippingCity}, ${comp.shippingState}</span>` : ''}
        ${comp.brandAffiliation ? `<span>Brand: ${comp.brandAffiliation}</span>` : ''}
        ${comp.productUsed ? `<span>Product: ${comp.productUsed}</span>` : ''}
      </div>
    </div>
  `).join('');
}

function renderAdjacency(customers) {
  if (!customers || customers.length === 0) {
    elements.adjacencyStatus.textContent = 'Not found';
    elements.adjacencyStatus.className = 'section-status not-found';
    elements.adjacencyContent.innerHTML = renderNotFound('No adjacency customers found (same brand or management company)');
    return;
  }

  elements.adjacencyStatus.textContent = `${customers.length} found`;
  elements.adjacencyStatus.className = 'section-status has-data';

  elements.adjacencyContent.innerHTML = customers.map(cust => `
    <div class="customer-card">
      <div class="customer-name">
        ${cust.accountName}
        ${cust.isActiveCustomer ? '<span class="customer-badge">Active Customer</span>' : ''}
      </div>
      <div class="customer-details">
        ${cust.shippingCity ? `<span>${cust.shippingCity}, ${cust.shippingState}</span>` : ''}
        ${cust.managementCompany ? `<span>Mgmt: ${cust.managementCompany}</span>` : ''}
        ${cust.brandAffiliation ? `<span>Brand: ${cust.brandAffiliation}</span>` : ''}
        ${cust.contractValue ? `<span>Value: $${cust.contractValue.toLocaleString()}</span>` : ''}
      </div>
    </div>
  `).join('');
}

function renderParentNotes(notes) {
  if (!notes || !notes.sellingNotes) {
    elements.parentNotesStatus.textContent = 'Not found';
    elements.parentNotesStatus.className = 'section-status not-found';
    elements.parentNotesContent.innerHTML = renderNotFound('No parent selling notes available');
    return;
  }

  elements.parentNotesStatus.textContent = 'Found';
  elements.parentNotesStatus.className = 'section-status has-data';

  elements.parentNotesContent.innerHTML = `
    <div class="notes-content">${escapeHtml(notes.sellingNotes)}</div>
    ${notes.parentAccountName ? `
      <div class="notes-meta">
        Parent: ${notes.parentAccountName}
        ${notes.lastUpdated ? ` | Updated: ${formatDate(new Date(notes.lastUpdated))}` : ''}
      </div>
    ` : ''}
  `;
}

function renderLinkedIn(links) {
  if (!links || (!links.dosmSearchUrl && !links.gmSearchUrl)) {
    elements.linkedinStatus.textContent = 'Not found';
    elements.linkedinStatus.className = 'section-status not-found';
    elements.linkedinContent.innerHTML = renderNotFound('No LinkedIn search links generated');
    return;
  }

  elements.linkedinStatus.textContent = 'Available';
  elements.linkedinStatus.className = 'section-status has-data';

  elements.linkedinContent.innerHTML = `
    <div class="linkedin-links">
      ${links.dosmSearchUrl ? `
        <div class="linkedin-link-row">
          <span class="linkedin-label">DOSM (Dir. of Sales & Marketing)</span>
          <a href="${links.dosmSearchUrl}" target="_blank" class="linkedin-btn">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M0 1.146C0 .513.526 0 1.175 0h13.65C15.474 0 16 .513 16 1.146v13.708c0 .633-.526 1.146-1.175 1.146H1.175C.526 16 0 15.487 0 14.854V1.146z"/>
            </svg>
            Search
          </a>
          <button class="copy-btn" data-url="${escapeHtml(links.dosmSearchUrl)}" title="Copy URL">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1v-1z"/>
              <path d="M9.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5h3zm-3-1A1.5 1.5 0 0 0 5 1.5v1A1.5 1.5 0 0 0 6.5 4h3A1.5 1.5 0 0 0 11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3z"/>
            </svg>
          </button>
        </div>
      ` : ''}
      ${links.gmSearchUrl ? `
        <div class="linkedin-link-row">
          <span class="linkedin-label">GM (General Manager)</span>
          <a href="${links.gmSearchUrl}" target="_blank" class="linkedin-btn">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M0 1.146C0 .513.526 0 1.175 0h13.65C15.474 0 16 .513 16 1.146v13.708c0 .633-.526 1.146-1.175 1.146H1.175C.526 16 0 15.487 0 14.854V1.146z"/>
            </svg>
            Search
          </a>
          <button class="copy-btn" data-url="${escapeHtml(links.gmSearchUrl)}" title="Copy URL">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1v-1z"/>
              <path d="M9.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5h3zm-3-1A1.5 1.5 0 0 0 5 1.5v1A1.5 1.5 0 0 0 6.5 4h3A1.5 1.5 0 0 0 11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3z"/>
            </svg>
          </button>
        </div>
      ` : ''}
    </div>
  `;

  // Add copy button listeners
  elements.linkedinContent.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const url = btn.dataset.url;
      await copyToClipboard(url);
      btn.classList.add('copied');
      showToast('URL copied to clipboard');
      setTimeout(() => btn.classList.remove('copied'), 2000);
    });
  });
}

function renderArticles(articles) {
  if (!articles || articles.length === 0) {
    elements.articlesStatus.textContent = 'Not found';
    elements.articlesStatus.className = 'section-status not-found';
    elements.articlesContent.innerHTML = renderNotFound('No recent articles found (last 90 days)');
    return;
  }

  elements.articlesStatus.textContent = `${articles.length} found`;
  elements.articlesStatus.className = 'section-status has-data';

  elements.articlesContent.innerHTML = `
    <div class="articles-list">
      ${articles.slice(0, 5).map(article => `
        <div class="article-card">
          <div class="article-title">
            <a href="${article.url}" target="_blank">${escapeHtml(article.title)}</a>
          </div>
          <div class="article-meta">
            <span>${article.source}</span>
            ${article.publishedDate ? `<span>${formatDate(new Date(article.publishedDate))}</span>` : ''}
          </div>
          ${article.snippet ? `
            <div class="article-snippet">${escapeHtml(truncate(article.snippet, 120))}</div>
          ` : ''}
        </div>
      `).join('')}
    </div>
  `;
}

function renderPerformance(brief, data) {
  elements.perfGenTime.textContent = `Gen: ${brief.generationTimeMs}ms`;

  if (data.clientFetchTimeMs) {
    elements.perfFetchTime.textContent = `Fetch: ${Math.round(data.clientFetchTimeMs)}ms`;
  }
}

function renderNotFound(message) {
  return `
    <div class="not-found-message">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
        <path d="M7.002 11a1 1 0 1 1 2 0 1 1 0 0 1-2 0zM7.1 4.995a.905.905 0 1 1 1.8 0l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 4.995z"/>
      </svg>
      ${message}
    </div>
  `;
}

function expandSectionsWithData(quality) {
  // Expand first section with data, or property scope by default
  const sectionMap = [
    { id: 'propertyScopeSection', hasData: quality.hasPropertyScope },
    { id: 'competitorsSection', hasData: quality.hasLocalCompetitors },
    { id: 'adjacencySection', hasData: quality.hasAdjacencyCustomers },
    { id: 'parentNotesSection', hasData: quality.hasParentNotes },
    { id: 'linkedinSection', hasData: quality.hasContactLinks },
    { id: 'articlesSection', hasData: quality.hasRecentArticles },
  ];

  // Collapse all first
  sectionMap.forEach(s => {
    document.getElementById(s.id).classList.remove('expanded');
  });

  // Expand first with data, or first section
  const firstWithData = sectionMap.find(s => s.hasData);
  const toExpand = firstWithData || sectionMap[0];
  document.getElementById(toExpand.id).classList.add('expanded');
}

// =============================================================================
// UI HELPERS
// =============================================================================

function showState(state) {
  elements.loadingState.classList.add('hidden');
  elements.errorState.classList.add('hidden');
  elements.resultsContainer.classList.add('hidden');

  switch (state) {
    case 'loading':
      elements.loadingState.classList.remove('hidden');
      break;
    case 'error':
      elements.errorState.classList.remove('hidden');
      break;
    case 'results':
      elements.resultsContainer.classList.remove('hidden');
      break;
  }
}

function setButtonLoading(loading) {
  const btnText = elements.searchBtn.querySelector('.btn-text');
  const btnLoading = elements.searchBtn.querySelector('.btn-loading');

  if (loading) {
    elements.searchBtn.disabled = true;
    btnText.classList.add('hidden');
    btnLoading.classList.remove('hidden');
  } else {
    elements.searchBtn.disabled = false;
    btnText.classList.remove('hidden');
    btnLoading.classList.add('hidden');
  }
}

function showToast(message, duration = 3000) {
  elements.toastMessage.textContent = message;
  elements.toast.classList.remove('hidden');
  elements.toast.classList.add('visible');

  setTimeout(() => {
    elements.toast.classList.remove('visible');
    setTimeout(() => {
      elements.toast.classList.add('hidden');
    }, 200);
  }, duration);
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    console.error('Failed to copy:', error);
    return false;
  }
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

function formatAddress(scope) {
  const parts = [scope.address, scope.city, scope.state].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'N/A';
}

function formatTime(date) {
  const now = new Date();
  const diff = now - date;

  if (diff < 60000) {
    return 'Just now';
  } else if (diff < 3600000) {
    const mins = Math.floor(diff / 60000);
    return `${mins}m ago`;
  } else if (diff < 86400000) {
    const hours = Math.floor(diff / 3600000);
    return `${hours}h ago`;
  } else {
    return formatDate(date);
  }
}

function formatDate(date) {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined
  });
}

function truncate(str, length) {
  if (!str || str.length <= length) return str;
  return str.substring(0, length).trim() + '...';
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
