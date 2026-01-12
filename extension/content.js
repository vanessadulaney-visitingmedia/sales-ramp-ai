// =============================================================================
// LIVE CALL BRIEF - CONTENT SCRIPT
// Injects brief panel into Outreach pages for inline viewing during calls
// =============================================================================

(function() {
  'use strict';

  console.log('[LiveCallBrief] Content script loaded');

  // Configuration
  const CONFIG = {
    panelId: 'live-call-brief-panel',
    toggleBtnId: 'live-call-brief-toggle',
    debounceMs: 300,
    observerThrottle: 1000
  };

  // State
  let panel = null;
  let toggleBtn = null;
  let currentPropertyName = null;
  let lastObserverRun = 0;

  // =============================================================================
  // PANEL CREATION
  // =============================================================================

  function createPanel() {
    if (document.getElementById(CONFIG.panelId)) {
      return document.getElementById(CONFIG.panelId);
    }

    panel = document.createElement('div');
    panel.id = CONFIG.panelId;
    panel.className = 'lcb-panel lcb-panel-hidden';
    panel.innerHTML = `
      <div class="lcb-panel-header">
        <span class="lcb-panel-title">Live Call Brief</span>
        <div class="lcb-panel-actions">
          <button class="lcb-btn-refresh" title="Refresh">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path fill-rule="evenodd" d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2v1z"/>
              <path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z"/>
            </svg>
          </button>
          <button class="lcb-btn-close" title="Close">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="lcb-panel-search">
        <input type="text" class="lcb-search-input" placeholder="Property name...">
        <button class="lcb-btn-search">Search</button>
      </div>
      <div class="lcb-panel-content">
        <div class="lcb-empty-state">
          <p>Search for a property or click on a prospect to load their brief.</p>
        </div>
      </div>
    `;

    document.body.appendChild(panel);

    // Event listeners
    panel.querySelector('.lcb-btn-close').addEventListener('click', hidePanel);
    panel.querySelector('.lcb-btn-refresh').addEventListener('click', refreshBrief);
    panel.querySelector('.lcb-btn-search').addEventListener('click', handleSearch);
    panel.querySelector('.lcb-search-input').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') handleSearch();
    });

    return panel;
  }

  function createToggleButton() {
    if (document.getElementById(CONFIG.toggleBtnId)) {
      return document.getElementById(CONFIG.toggleBtnId);
    }

    toggleBtn = document.createElement('button');
    toggleBtn.id = CONFIG.toggleBtnId;
    toggleBtn.className = 'lcb-toggle-btn';
    toggleBtn.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8.354 1.146a.5.5 0 0 0-.708 0l-6 6A.5.5 0 0 0 1.5 7.5v7a.5.5 0 0 0 .5.5h4.5a.5.5 0 0 0 .5-.5v-4h2v4a.5.5 0 0 0 .5.5H14a.5.5 0 0 0 .5-.5v-7a.5.5 0 0 0-.146-.354L13 5.793V2.5a.5.5 0 0 0-.5-.5h-1a.5.5 0 0 0-.5.5v1.293L8.354 1.146z"/>
      </svg>
    `;
    toggleBtn.title = 'Open Live Call Brief';
    toggleBtn.addEventListener('click', togglePanel);

    document.body.appendChild(toggleBtn);

    return toggleBtn;
  }

  // =============================================================================
  // PANEL CONTROLS
  // =============================================================================

  function showPanel() {
    if (!panel) createPanel();
    panel.classList.remove('lcb-panel-hidden');
    toggleBtn.classList.add('lcb-toggle-active');
  }

  function hidePanel() {
    if (panel) {
      panel.classList.add('lcb-panel-hidden');
      toggleBtn.classList.remove('lcb-toggle-active');
    }
  }

  function togglePanel() {
    if (panel && !panel.classList.contains('lcb-panel-hidden')) {
      hidePanel();
    } else {
      showPanel();
    }
  }

  // =============================================================================
  // BRIEF LOADING
  // =============================================================================

  function handleSearch() {
    const input = panel.querySelector('.lcb-search-input');
    const propertyName = input.value.trim();

    if (propertyName) {
      loadBrief(propertyName);
    }
  }

  function refreshBrief() {
    if (currentPropertyName) {
      loadBrief(currentPropertyName, true);
    }
  }

  async function loadBrief(propertyName, forceRefresh = false) {
    currentPropertyName = propertyName;
    showLoading();

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'fetchBrief',
        params: { propertyName, forceRefresh }
      });

      if (response.success && response.data.success) {
        renderBriefInPanel(response.data.brief);
      } else {
        showError(response.error || response.data?.error || 'Failed to load brief');
      }
    } catch (error) {
      console.error('[LiveCallBrief] Error loading brief:', error);
      showError(error.message);
    }
  }

  function showLoading() {
    const content = panel.querySelector('.lcb-panel-content');
    content.innerHTML = `
      <div class="lcb-loading">
        <div class="lcb-spinner"></div>
        <p>Loading brief...</p>
      </div>
    `;
  }

  function showError(message) {
    const content = panel.querySelector('.lcb-panel-content');
    content.innerHTML = `
      <div class="lcb-error">
        <p>${escapeHtml(message)}</p>
        <button class="lcb-btn-retry" onclick="this.closest('.lcb-panel').querySelector('.lcb-btn-refresh').click()">Retry</button>
      </div>
    `;
  }

  function renderBriefInPanel(brief) {
    const content = panel.querySelector('.lcb-panel-content');
    const quality = brief.dataQuality;

    content.innerHTML = `
      <div class="lcb-brief">
        <div class="lcb-quality-bar">
          <div class="lcb-quality-fill" style="width: ${quality.completenessScore}%"></div>
        </div>
        <div class="lcb-quality-score">${quality.completenessScore}% complete</div>

        ${brief.propertyScope ? `
          <div class="lcb-section">
            <div class="lcb-section-title">Property</div>
            <div class="lcb-section-content">
              <strong>${escapeHtml(brief.propertyScope.name)}</strong>
              ${brief.propertyScope.roomCount ? `<br>${brief.propertyScope.roomCount} rooms` : ''}
              ${brief.propertyScope.ratingScore ? `<br>Rating: ${brief.propertyScope.ratingScore}` : ''}
            </div>
          </div>
        ` : ''}

        ${brief.adjacencyData?.localCompetitors?.length > 0 ? `
          <div class="lcb-section">
            <div class="lcb-section-title">Local Competitors</div>
            <div class="lcb-section-content">
              ${brief.adjacencyData.localCompetitors.map(c => `
                <div class="lcb-item">${escapeHtml(c.accountName)}</div>
              `).join('')}
            </div>
          </div>
        ` : ''}

        ${brief.parentNotes?.sellingNotes ? `
          <div class="lcb-section">
            <div class="lcb-section-title">Selling Notes</div>
            <div class="lcb-section-content lcb-notes">
              ${escapeHtml(brief.parentNotes.sellingNotes.substring(0, 200))}${brief.parentNotes.sellingNotes.length > 200 ? '...' : ''}
            </div>
          </div>
        ` : ''}

        ${brief.contactLinks ? `
          <div class="lcb-section">
            <div class="lcb-section-title">LinkedIn</div>
            <div class="lcb-section-content">
              ${brief.contactLinks.dosmSearchUrl ? `<a href="${brief.contactLinks.dosmSearchUrl}" target="_blank" class="lcb-link">DOSM Search</a>` : ''}
              ${brief.contactLinks.gmSearchUrl ? `<a href="${brief.contactLinks.gmSearchUrl}" target="_blank" class="lcb-link">GM Search</a>` : ''}
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }

  // =============================================================================
  // OUTREACH INTEGRATION
  // =============================================================================

  function setupOutreachObserver() {
    // Look for prospect/account names on the page
    const observer = new MutationObserver(throttle(() => {
      detectProspectContext();
    }, CONFIG.observerThrottle));

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    // Initial check
    detectProspectContext();
  }

  function detectProspectContext() {
    // Common selectors for Outreach prospect/account info
    const selectors = [
      '[data-test="prospect-name"]',
      '[data-test="account-name"]',
      '.prospect-name',
      '.account-name',
      'h1[class*="prospect"]',
      'h1[class*="account"]'
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element && element.textContent.trim()) {
        const name = element.textContent.trim();
        if (name !== currentPropertyName) {
          // Update search input with detected name
          if (panel) {
            const input = panel.querySelector('.lcb-search-input');
            if (input) {
              input.value = name;
            }
          }
        }
        break;
      }
    }
  }

  // =============================================================================
  // UTILITIES
  // =============================================================================

  function throttle(func, limit) {
    let inThrottle;
    return function(...args) {
      if (!inThrottle) {
        func.apply(this, args);
        inThrottle = true;
        setTimeout(() => inThrottle = false, limit);
      }
    };
  }

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // =============================================================================
  // INITIALIZATION
  // =============================================================================

  function init() {
    // Create toggle button
    createToggleButton();

    // Setup Outreach integration
    setupOutreachObserver();

    // Listen for messages from popup/background
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === 'showBrief') {
        showPanel();
        if (request.propertyName) {
          loadBrief(request.propertyName);
        }
        sendResponse({ success: true });
      }
      return false;
    });

    console.log('[LiveCallBrief] Content script initialized');
  }

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
