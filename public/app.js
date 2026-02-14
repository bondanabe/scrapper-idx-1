// ── State ────────────────────────────────────────────────────────────

const state = {
  // Companies tab
  companies: [],
  companiesTotal: 0,
  companiesPage: 1,
  companiesLimit: 50,
  searchQuery: '',
  sectorFilter: '',
  sectors: [],
  selected: new Set(),

  // Scrape tab
  scrapeState: 'idle',
  scrapeLog: [],
  scrapeProgress: { completed: 0, total: 0 },

  // Data viewer
  viewerSymbol: '',
  viewerFrom: '',
  viewerTo: '',
  prices: [],
  pricesTotal: 0,
  pricesOffset: 0,
};

// ── DOM refs ─────────────────────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const els = {
  authStatus: $('#auth-status'),
  searchInput: $('#search-input'),
  sectorFilter: $('#sector-filter'),
  selectAll: $('#select-all'),
  selectedCount: $('#selected-count'),
  companiesBody: $('#companies-body'),
  pagination: $('#pagination'),
  btnScrapeSelected: $('#btn-scrape-selected'),
  btnScrapeAll: $('#btn-scrape-all'),
  scrapeState: $('#scrape-state'),
  scrapeSummary: $('#scrape-summary'),
  progressBar: $('#progress-bar'),
  progressText: $('#progress-text'),
  scrapeLog: $('#scrape-log'),
  viewerSymbol: $('#viewer-symbol'),
  viewerFrom: $('#viewer-from'),
  viewerTo: $('#viewer-to'),
  btnLoadData: $('#btn-load-data'),
  pricesBody: $('#prices-body'),
  pricesInfo: $('#prices-info'),
  btnLoadMore: $('#btn-load-more'),
};

// ── Tab switching ────────────────────────────────────────────────────

$$('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.tab').forEach(b => b.classList.remove('active'));
    $$('.tab-content').forEach(s => s.classList.remove('active'));
    btn.classList.add('active');
    $(`#tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ── Auth status ──────────────────────────────────────────────────────

async function checkAuth() {
  try {
    const res = await fetch('/api/auth/status');
    const data = await res.json();
    if (data.allValid) {
      els.authStatus.textContent = `Cookies OK (${data.validCount})`;
      els.authStatus.className = 'auth-badge ok';
    } else if (data.hasCookies) {
      els.authStatus.textContent = 'Cookies Expired';
      els.authStatus.className = 'auth-badge expired';
    } else {
      els.authStatus.textContent = 'No Cookies';
      els.authStatus.className = 'auth-badge expired';
    }
  } catch {
    els.authStatus.textContent = 'Error';
    els.authStatus.className = 'auth-badge expired';
  }
}

// ── Companies ────────────────────────────────────────────────────────

async function fetchCompanies() {
  const params = new URLSearchParams({
    page: state.companiesPage,
    limit: state.companiesLimit,
  });
  if (state.searchQuery) params.set('search', state.searchQuery);
  if (state.sectorFilter) params.set('sector', state.sectorFilter);

  try {
    const res = await fetch(`/api/companies?${params}`);
    const data = await res.json();
    state.companies = data.data;
    state.companiesTotal = data.total;
    renderCompanies();
    renderPagination();
  } catch (err) {
    els.companiesBody.innerHTML = `<tr><td colspan="5" class="empty-state">Failed to load companies: ${err.message}</td></tr>`;
  }
}

async function fetchSectors() {
  try {
    const res = await fetch('/api/companies/sectors');
    const data = await res.json();
    state.sectors = data.sectors;
    els.sectorFilter.innerHTML = '<option value="">All Sectors</option>';
    data.sectors.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      els.sectorFilter.appendChild(opt);
    });
  } catch { /* ignore */ }
}

function renderCompanies() {
  if (state.companies.length === 0) {
    els.companiesBody.innerHTML = '<tr><td colspan="5" class="empty-state">No companies found</td></tr>';
    return;
  }

  els.companiesBody.innerHTML = state.companies.map(c => `
    <tr>
      <td><input type="checkbox" class="row-check" data-symbol="${c.symbol}" ${state.selected.has(c.symbol) ? 'checked' : ''} /></td>
      <td class="ticker-cell">${c.symbol}</td>
      <td>${c.name || ''}</td>
      <td>${c.sector || ''}</td>
      <td>${c.subsector || ''}</td>
    </tr>
  `).join('');

  // Checkbox handlers
  els.companiesBody.querySelectorAll('.row-check').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) {
        state.selected.add(cb.dataset.symbol);
      } else {
        state.selected.delete(cb.dataset.symbol);
      }
      updateSelectedCount();
    });
  });

  // Update select-all checkbox state
  const allChecked = state.companies.every(c => state.selected.has(c.symbol));
  els.selectAll.checked = allChecked && state.companies.length > 0;

  updateSelectedCount();
}

function renderPagination() {
  const totalPages = Math.ceil(state.companiesTotal / state.companiesLimit);
  if (totalPages <= 1) {
    els.pagination.innerHTML = '';
    return;
  }

  let html = '';
  html += `<button ${state.companiesPage <= 1 ? 'disabled' : ''} data-page="${state.companiesPage - 1}">&lt;</button>`;

  const start = Math.max(1, state.companiesPage - 2);
  const end = Math.min(totalPages, state.companiesPage + 2);

  if (start > 1) {
    html += `<button data-page="1">1</button>`;
    if (start > 2) html += `<span style="padding:0 4px">...</span>`;
  }

  for (let p = start; p <= end; p++) {
    html += `<button data-page="${p}" class="${p === state.companiesPage ? 'active' : ''}">${p}</button>`;
  }

  if (end < totalPages) {
    if (end < totalPages - 1) html += `<span style="padding:0 4px">...</span>`;
    html += `<button data-page="${totalPages}">${totalPages}</button>`;
  }

  html += `<button ${state.companiesPage >= totalPages ? 'disabled' : ''} data-page="${state.companiesPage + 1}">&gt;</button>`;

  els.pagination.innerHTML = html;
  els.pagination.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = parseInt(btn.dataset.page);
      if (!isNaN(page) && page !== state.companiesPage) {
        state.companiesPage = page;
        fetchCompanies();
      }
    });
  });
}

function updateSelectedCount() {
  const count = state.selected.size;
  els.selectedCount.textContent = `${count} selected`;
  els.btnScrapeSelected.textContent = `Scrape Selected (${count})`;
  els.btnScrapeSelected.disabled = count === 0;
}

// Select all handler
els.selectAll.addEventListener('change', () => {
  state.companies.forEach(c => {
    if (els.selectAll.checked) {
      state.selected.add(c.symbol);
    } else {
      state.selected.delete(c.symbol);
    }
  });
  renderCompanies();
});

// Search with debounce
let searchTimeout;
els.searchInput.addEventListener('input', () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    state.searchQuery = els.searchInput.value.trim();
    state.companiesPage = 1;
    fetchCompanies();
  }, 300);
});

// Sector filter
els.sectorFilter.addEventListener('change', () => {
  state.sectorFilter = els.sectorFilter.value;
  state.companiesPage = 1;
  fetchCompanies();
});

// ── Scraping ─────────────────────────────────────────────────────────

async function startScrape(symbols) {
  try {
    const res = await fetch('/api/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols }),
    });
    const data = await res.json();

    if (res.status === 409) {
      addLogEntry(`Scraping already running: ${data.currentSymbol || 'starting...'}`, 'error');
      return;
    }

    if (!res.ok) {
      addLogEntry(`Failed to start: ${data.error}`, 'error');
      return;
    }

    // Switch to scrape tab
    $$('.tab').forEach(b => b.classList.remove('active'));
    $$('.tab-content').forEach(s => s.classList.remove('active'));
    $$('.tab')[1].classList.add('active');
    $('#tab-scrape').classList.add('active');

    state.scrapeLog = [];
    els.scrapeLog.innerHTML = '';
    addLogEntry(`Started scraping ${data.total} symbols: ${data.symbols.join(', ')}`);
  } catch (err) {
    addLogEntry(`Network error: ${err.message}`, 'error');
  }
}

els.btnScrapeSelected.addEventListener('click', () => {
  if (state.selected.size === 0) return;
  startScrape([...state.selected]);
});

els.btnScrapeAll.addEventListener('click', () => {
  startScrape(['*']);
});

function addLogEntry(message, level = '') {
  const now = new Date();
  const ts = now.toLocaleTimeString('en-GB');
  const entry = document.createElement('div');
  entry.className = `log-entry ${level}`;
  entry.innerHTML = `<span class="timestamp">[${ts}]</span> ${escapeHtml(message)}`;
  els.scrapeLog.appendChild(entry);
  els.scrapeLog.parentElement.scrollTop = els.scrapeLog.parentElement.scrollHeight;
}

function updateScrapeUI(data) {
  els.scrapeState.textContent = capitalize(data.state || state.scrapeState);

  if (data.completed !== undefined && data.total) {
    const pct = Math.round((data.completed / data.total) * 100);
    els.progressBar.style.width = `${pct}%`;
    els.progressText.textContent = `${data.completed} / ${data.total} (${pct}%)`;
    state.scrapeProgress = { completed: data.completed, total: data.total };
  }
}

// ── SSE ──────────────────────────────────────────────────────────────

function connectSSE() {
  const source = new EventSource('/api/scrape/progress');

  source.addEventListener('status', (e) => {
    const data = JSON.parse(e.data);
    state.scrapeState = data.state;
    updateScrapeUI(data);
    if (data.message && data.state === 'running') {
      addLogEntry(data.message);
    }
  });

  source.addEventListener('symbol-done', (e) => {
    const data = JSON.parse(e.data);
    updateScrapeUI(data);
    addLogEntry(`${data.symbol}: ${data.rows} row(s) saved`, 'success');
  });

  source.addEventListener('symbol-error', (e) => {
    const data = JSON.parse(e.data);
    updateScrapeUI(data);
    addLogEntry(`${data.symbol}: FAILED - ${data.error}`, 'error');
  });

  source.addEventListener('done', (e) => {
    const data = JSON.parse(e.data);
    state.scrapeState = 'idle';
    els.scrapeState.textContent = 'Completed';
    const secs = (data.elapsed / 1000).toFixed(1);
    const failedMsg = data.failed.length > 0 ? ` | Failed: ${data.failed.join(', ')}` : '';
    addLogEntry(`Done in ${secs}s. ${data.totalInserted} rows saved.${failedMsg}`, 'success');

    els.progressBar.style.width = '100%';
    els.progressText.textContent = `${state.scrapeProgress.total} / ${state.scrapeProgress.total} (100%)`;
  });

  source.addEventListener('error', (e) => {
    try {
      const data = JSON.parse(e.data);
      state.scrapeState = 'error';
      els.scrapeState.textContent = 'Error';
      addLogEntry(`ERROR: ${data.message}`, 'error');
    } catch {
      // SSE connection error — browser will auto-reconnect
    }
  });
}

// ── Data Viewer ──────────────────────────────────────────────────────

async function loadViewerSymbols() {
  try {
    // Fetch all tickers for the dropdown
    const res = await fetch('/api/companies?limit=100&page=1');
    const data = await res.json();
    const totalPages = Math.ceil(data.total / 100);

    let allSymbols = data.data.map(c => c.symbol);

    // Fetch remaining pages if needed
    for (let p = 2; p <= totalPages; p++) {
      const res2 = await fetch(`/api/companies?limit=100&page=${p}`);
      const data2 = await res2.json();
      allSymbols = allSymbols.concat(data2.data.map(c => c.symbol));
    }

    allSymbols.sort();
    els.viewerSymbol.innerHTML = '<option value="">Select Symbol</option>';
    allSymbols.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      els.viewerSymbol.appendChild(opt);
    });
  } catch { /* ignore */ }
}

async function fetchPrices(append = false) {
  const symbol = els.viewerSymbol.value;
  if (!symbol) return;

  state.viewerSymbol = symbol;
  state.viewerFrom = els.viewerFrom.value;
  state.viewerTo = els.viewerTo.value;

  const params = new URLSearchParams({
    symbol,
    limit: 100,
    order: 'desc',
  });
  if (state.viewerFrom) params.set('from', state.viewerFrom);
  if (state.viewerTo) params.set('to', state.viewerTo);

  try {
    const res = await fetch(`/api/prices?${params}`);
    const data = await res.json();

    if (append) {
      state.prices = state.prices.concat(data.data);
    } else {
      state.prices = data.data;
      state.pricesTotal = data.total;
    }

    renderPrices();
  } catch (err) {
    els.pricesBody.innerHTML = `<tr><td colspan="6" class="empty-state">Failed to load: ${err.message}</td></tr>`;
  }
}

function renderPrices() {
  if (state.prices.length === 0) {
    els.pricesBody.innerHTML = '<tr><td colspan="6" class="empty-state">No data found</td></tr>';
    els.pricesInfo.textContent = '';
    els.btnLoadMore.style.display = 'none';
    return;
  }

  els.pricesBody.innerHTML = state.prices.map(r => `
    <tr>
      <td>${r.date}</td>
      <td>${formatNumber(r.open)}</td>
      <td>${formatNumber(r.high)}</td>
      <td>${formatNumber(r.low)}</td>
      <td>${formatNumber(r.close)}</td>
      <td>${formatVolume(r.volume)}</td>
    </tr>
  `).join('');

  els.pricesInfo.textContent = `Showing ${state.prices.length} of ${state.pricesTotal} records`;
  els.btnLoadMore.style.display = state.prices.length < state.pricesTotal ? 'block' : 'none';
}

els.btnLoadData.addEventListener('click', () => fetchPrices(false));
els.btnLoadMore.addEventListener('click', () => fetchPrices(true));

// ── Helpers ──────────────────────────────────────────────────────────

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function formatNumber(n) {
  if (n == null) return '-';
  return Number(n).toLocaleString('id-ID');
}

function formatVolume(n) {
  if (n == null) return '-';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toLocaleString('id-ID');
}

// ── Init ─────────────────────────────────────────────────────────────

checkAuth();
fetchSectors();
fetchCompanies();
loadViewerSymbols();
connectSSE();
