/* ═══════════════════════════════════════════════════════════
   FreeF1 Admin Dashboard — JavaScript
   Auth · SSE · Visitor Table · Stream Controls
   ═══════════════════════════════════════════════════════════ */

'use strict';

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const API_BASE   = '/admin/api';
const SSE_URL    = `${API_BASE}/events`;
const REFRESH_MS = 15000; // fallback only; live updates normally arrive over SSE

// ─────────────────────────────────────────────
// DOM REFS
// ─────────────────────────────────────────────
const $ = id => document.getElementById(id);

const authScreen     = $('authScreen');
const appEl          = $('app');
const loginForm      = $('loginForm');
const usernameInput  = $('username');
const passwordInput  = $('password');
const authError      = $('authError');
const loginBtn       = $('loginBtn');
const logoutBtn      = $('logoutBtn');
const navStatus      = $('navStatus');
const onlineCountEl  = $('onlineCount');
const uniqueCountEl  = $('uniqueCount');
const overrideCountEl = $('overrideCount');
const overrideSubEl   = $('overrideSub');
const maintenanceCountEl = $('maintenanceCount');
const maintenanceSubEl = $('maintenanceSub');
const maintenanceStatCard = $('maintenanceStatCard');
const maintenancePanel = $('maintenancePanel');
const maintenanceBadge = $('maintenanceBadge');
const maintenanceStatus = $('maintenanceStatus');
const maintenanceStatusTitle = $('maintenanceStatusTitle');
const maintenanceStatusText = $('maintenanceStatusText');
const maintenanceMessage = $('maintenanceMessage');
const maintenanceEta = $('maintenanceEta');
const maintenanceSaveBtn = $('maintenanceSaveBtn');
const maintenanceToggleBtn = $('maintenanceToggleBtn');
const maintenanceNote = $('maintenanceNote');
const serverTimeEl    = $('serverTime');
const serverDateEl    = $('serverDate');
const tableBadge      = $('tableBadge');
const visitorTableBody = $('visitorTableBody');
const visitorEmpty   = $('visitorEmpty');
const streamStatusEl = $('streamStatus');
const streamTypeLabel = $('streamTypeLabel');
const streamStartedLabel = $('streamStartedLabel');
const streamUrlInput = $('streamUrlInput');
const playOverrideBtn   = $('playOverrideBtn');
const stopOverrideBtn   = $('stopOverrideBtn');
const normalStreamBtn   = $('normalStreamBtn');
const streamPreview     = $('streamPreview');
const serverTimeLabel   = $('serverTimeLabel');
const sysUptime         = $('sysUptime');
const sysVisitorStore   = $('sysVisitorStore');
const sysUniqueStore    = $('sysUniqueStore');
const sysNewsStore      = $('sysNewsStore');
const sysSourceStore    = $('sysSourceStore');
const sysOverrideStore  = $('sysOverrideStore');
const overrideConflict  = $('overrideConflict');
const sourceList        = $('sourceList');
const sourcesBadge      = $('sourcesBadge');
const sourcesStore      = $('sourcesStore');
const sourcesRefreshBtn = $('sourcesRefreshBtn');
const sysAnalyticsStore = $('sysAnalyticsStore');
const sysOverrideStatus = $('sysOverrideStatus');
const sysMaintenanceStatus = $('sysMaintenanceStatus');
const sysNodeEnv        = $('sysNodeEnv');
const sysSessionActive  = $('sysSessionActive');
const sseStatus         = $('sseStatus');
const streamBadge       = $('streamBadge');
const toastContainer    = $('toastContainer');
const connBarFill       = $('connBarFill');
const newsForm          = $('newsForm');
const newsIdInput       = $('newsId');
const newsTitleInput    = $('newsTitle');
const newsTagInput      = $('newsTag');
const newsBodyInput     = $('newsBody');
const newsPublishedInput = $('newsPublished');
const newsSaveBtn       = $('newsSaveBtn');
const newsCancelBtn     = $('newsCancelBtn');
const newsBadge         = $('newsBadge');
const adminNewsList     = $('adminNewsList');

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
let isAdmin      = false;
let sse          = null;
let sseConnected = false;
let reconnectTimer = null;
let reconnectDelay = 1500;
let lastSseMessageAt = 0;
let currentStats = null;
let overrideActive = false;
let maintenanceActive = false;
let maintenanceStateKnown = false;
let previewUrl = '';
let savedOverrideInput = '';
let newsItems = [];
let feedSources = [];
let disabledSources = new Set();
let sourceSaveInFlight = false;
/* Server clock offset. The dashboard runs in the viewer's timezone while the
   service runs on UTC, so "Server Time" is rendered from the server's own
   timestamp instead of the browser clock. */
let serverClockOffsetMs = 0;
let serverTimeZone = 'UTC';
let serverTimeFormatter = null;
let serverDateFormatter = null;

// ─────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────
async function checkAuthStatus() {
  try {
    const r = await fetch(`${API_BASE}/status`);
    const d = await r.json();
    if (d.authenticated) {
      showDashboard();
    } else {
      showLogin();
    }
  } catch (_) {
    showLogin();
  }
}

function showLogin() {
  isAdmin = false;
  authScreen.classList.remove('hidden');
  appEl.classList.remove('open');
  clearTimeout(visitorRenderTimer);
  visitorRenderTimer = null;
  visitorRenderPending = false;
  visitorIndex = new Map();
  if (sse) { sse.close(); sse = null; sseConnected = false; }
  if (typeof Analytics !== 'undefined') Analytics.stop();
}

function showDashboard() {
  isAdmin = true;
  authScreen.classList.add('hidden');
  appEl.classList.add('open');
  connectSSE();
  pollStats();
  loadMaintenanceStatus();
  loadNews();
  loadSources();
  if (typeof Analytics !== 'undefined') Analytics.start();
}

async function handleLogin(e) {
  e.preventDefault();
  const username = usernameInput.value.trim();
  const password = passwordInput.value;
  if (!username || !password) { showAuthError('Enter both username and password.'); return; }

  loginBtn.disabled = true;
  loginBtn.textContent = 'Authenticating…';
  authError.classList.remove('visible');

  try {
    const r = await fetch(`${API_BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const d = await r.json();
    if (d.success) {
      showToast('Welcome back, admin.', 'success');
      showDashboard();
      usernameInput.value = '';
      passwordInput.value = '';
    } else {
      showAuthError(d.error || 'Invalid credentials.');
    }
  } catch (_) {
    showAuthError('Network error. Please try again.');
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = 'Sign In';
  }
}

async function handleLogout() {
  try { await fetch(`${API_BASE}/logout`, { method: 'POST' }); } catch (_) {}
  showToast('Logged out successfully.', 'info');
  showLogin();
}

function showAuthError(msg) {
  authError.textContent = msg;
  authError.classList.add('visible');
}

loginForm.addEventListener('submit', handleLogin);
logoutBtn.addEventListener('click', handleLogout);

// ─────────────────────────────────────────────
// SSE CONNECTION
// ─────────────────────────────────────────────
function readSseEvent(event) {
  lastSseMessageAt = Date.now();
  try { return JSON.parse(event.data); } catch (_) { return null; }
}

function connectSSE() {
  if (sseConnected) return;
  if (sse) { sse.close(); sse = null; }

  sse = new EventSource(SSE_URL);

  sse.addEventListener('open', () => {
    sseConnected = true;
    reconnectDelay = 1500;
    lastSseMessageAt = Date.now();
    clearTimeout(reconnectTimer);
    updateConnectionBar(true);
  });

  sse.addEventListener('init', e => {
    const data = readSseEvent(e);
    if (data) handleStatsUpdate(data);
  });

  sse.addEventListener('stats', e => {
    const data = readSseEvent(e);
    if (data) handleStatsUpdate(data);
  });

  sse.addEventListener('visitor_update', e => {
    const data = readSseEvent(e);
    if (data) handleVisitorUpdate(data.type, data.visitor);
  });

  sse.addEventListener('stream_update', e => {
    const data = readSseEvent(e);
    if (data) handleStreamStatusUpdate(data);
  });

  sse.addEventListener('stream_override', e => {
    const data = readSseEvent(e);
    if (data) handleStreamOverrideUpdate(data);
  });

  sse.addEventListener('maintenance_update', e => {
    const data = readSseEvent(e);
    if (data) handleMaintenanceUpdate(data);
  });

  sse.addEventListener('news_update', e => {
    const data = readSseEvent(e);
    if (data) handleNewsUpdate(data);
  });

  sse.addEventListener('sources_update', e => {
    const data = readSseEvent(e);
    if (!data) return;
    if (Array.isArray(data.sources) && data.sources.length) feedSources = data.sources;
    disabledSources = new Set((Array.isArray(data.disabled) ? data.disabled : []).map(String));
    renderSources();
  });

  sse.addEventListener('error', () => {
    sseConnected = false;
    updateConnectionBar(false);
    sse?.close();sse = null;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => { if (isAdmin && !document.hidden) connectSSE(); }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  });
}

function updateConnectionBar(connected) {
  if (connBarFill) {
    connBarFill.style.width = connected ? '100%' : '0%';
    connBarFill.classList.toggle('disconnected', !connected);
  }
  if (navStatus) navStatus.textContent = connected ? 'CONNECTED' : 'RECONNECTING…';
  if (sseStatus) {
    sseStatus.textContent = connected ? 'Connected' : 'Reconnecting…';
    sseStatus.style.color = connected ? 'var(--green)' : 'var(--amber)';
  }
}

// ─────────────────────────────────────────────
// STATS HANDLERS
// ─────────────────────────────────────────────
function handleStatsUpdate(data) {
  currentStats = data;
  syncServerClock(data?.server);
  // A full snapshot supersedes any queued incremental repaint.
  visitorIndex = indexVisitors(data.visitors);
  visitorRenderPending = false;
  updateStatCards(data);
  updateVisitorTable(data);
  updateStreamStatus(data.override);
  updateMaintenanceStatus(data.maintenance);
  updateSystemInfo(data);
}

/* ── Server clock ──────────────────────────────────────────
   The stats payload carries the server's own `now` and IANA timezone. The
   offset is re-derived on every snapshot so a drifting browser clock can
   never make "Server Time" lie, and the value is formatted in the server's
   zone (UTC on Render) rather than the viewer's. */
function syncServerClock(server) {
  const serverNow = Number(server?.now);
  if (Number.isFinite(serverNow) && serverNow > 0) serverClockOffsetMs = serverNow - Date.now();
  const timeZone = server?.timezone || 'UTC';
  if (timeZone !== serverTimeZone || !serverTimeFormatter) {
    serverTimeZone = timeZone;
    try {
      serverTimeFormatter = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone });
      serverDateFormatter = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: '2-digit', month: 'short', timeZone });
    } catch (_) {
      // Unknown/legacy timeZone value — fall back to the viewer's zone.
      serverTimeZone = 'UTC';
      serverTimeFormatter = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
      serverDateFormatter = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: '2-digit', month: 'short' });
    }
    if (serverTimeLabel) serverTimeLabel.textContent = `Server Time · ${serverTimeZone}`;
  }
}

function renderServerClock() {
  const now = new Date(Date.now() + serverClockOffsetMs);
  if (serverTimeEl) serverTimeEl.textContent = serverTimeFormatter.format(now);
  if (serverDateEl) serverDateEl.textContent = serverDateFormatter.format(now);
}

function updateStatCards(data) {
  const online = data.onlineCount ?? 0;
  if (onlineCountEl) onlineCountEl.textContent = String(online);
  if (uniqueCountEl) uniqueCountEl.textContent = String(data.totalUnique ?? 0);

  const override = data.override || { active: false };
  if (overrideCountEl) {
    overrideCountEl.textContent = override.active ? 'ON' : 'OFF';
    overrideCountEl.classList.toggle('green', !override.active);
    overrideCountEl.classList.toggle('red', !!override.active);
  }
  if (overrideSubEl) {
    overrideSubEl.textContent = override.active
      ? `${(override.type || 'custom').toUpperCase()} · ${formatTimeAgo(override.startedAt)}`
      : 'No override active';
  }
  if (tableBadge) tableBadge.textContent = `● ${online} Live`;

  renderServerClock();
}

function updateStreamStatus(override) {
  if (!streamStatusEl) return;
  if (override?.active) {
    streamStatusEl.className = 'stream-status active-override';
    streamStatusEl.innerHTML = `
      <div class="status-indicator override"></div>
      <div class="status-text">
        <strong style="color:#ff6b62">Stream Override Active</strong>
        <small>${escapeHtml(override.type || 'custom').toUpperCase()} · Started ${formatTimeAgo(override.startedAt)}</small>
      </div>
      <div class="time-ago">LIVE</div>`;
    if (streamTypeLabel) streamTypeLabel.textContent = `TYPE: ${(override.type || 'custom').toUpperCase()}`;
    if (streamStartedLabel) streamStartedLabel.textContent = `STARTED: ${formatTimeAgo(override.startedAt)}`;
    rememberOverrideInput(override);
    updateStreamButtons(true, true);
    if (streamBadge) {
      streamBadge.textContent = 'Override';
      streamBadge.className = 'panel-badge live';
    }
    overrideActive = true;
    if (override.url && previewUrl !== override.url) renderStreamPreview(override.url, override.type);
  } else {
    streamStatusEl.className = 'stream-status active-normal';
    streamStatusEl.innerHTML = `
      <div class="status-indicator online"></div>
      <div class="status-text">
        <strong style="color:var(--green)">Normal Stream</strong>
        <small>Default site feed is active · No override in effect</small>
      </div>
      <div class="time-ago">● LIVE</div>`;
    if (streamTypeLabel) streamTypeLabel.textContent = 'TYPE: NORMAL';
    if (streamStartedLabel) streamStartedLabel.textContent = 'STARTED: —';
    rememberOverrideInput(override);
    const hasSaved = Boolean(savedOverrideInput || override?.playbackUrl || override?.input);
    if (streamBadge) {
      streamBadge.textContent = 'Normal';
      streamBadge.className = 'panel-badge normal';
    }
    overrideActive = false;
    updateStreamButtons(false, hasSaved);
    if (previewUrl) clearStreamPreview();
  }
  syncOverrideConflict();
}

function updateMaintenanceStatus(maintenance) {
  const state = maintenance || { active: false, message: "We'll be back before the race." };
  maintenanceActive = Boolean(state.active);
  maintenanceStateKnown = true;

  if (maintenanceCountEl) {
    maintenanceCountEl.textContent = maintenanceActive ? 'PIT' : 'LIVE';
    maintenanceCountEl.classList.toggle('red', maintenanceActive);
    maintenanceCountEl.classList.toggle('green', !maintenanceActive);
  }
  if (maintenanceSubEl) {
    maintenanceSubEl.textContent = maintenanceActive
      ? `Active ${formatTimeAgo(state.startedAt)}`
      : 'Public site is available';
  }
  maintenanceStatCard?.classList.toggle('maintenance-active', maintenanceActive);
  maintenancePanel?.classList.toggle('mode-active', maintenanceActive);

  if (maintenanceBadge) {
    maintenanceBadge.textContent = maintenanceActive ? 'Maintenance' : 'Live';
    maintenanceBadge.className = `panel-badge ${maintenanceActive ? 'live' : 'normal'}`;
  }
  if (maintenanceStatus) {
    maintenanceStatus.classList.toggle('is-live', !maintenanceActive);
    maintenanceStatus.classList.toggle('is-active', maintenanceActive);
  }
  if (maintenanceStatusTitle) maintenanceStatusTitle.textContent = maintenanceActive ? 'Pit Lane Closed' : 'Public Site Live';
  if (maintenanceStatusText) {
    maintenanceStatusText.textContent = maintenanceActive
      ? 'Visitors are seeing the dedicated pit-stop maintenance page.'
      : 'Visitors can access the full APEX experience.';
  }
  if (maintenanceMessage && document.activeElement !== maintenanceMessage) {
    maintenanceMessage.value = state.message || "We'll be back before the race.";
  }
  if (maintenanceEta && document.activeElement !== maintenanceEta) {
    maintenanceEta.value = state.eta || 'Before lights out';
  }
  if (maintenanceToggleBtn) {
    maintenanceToggleBtn.disabled = false;
    if (maintenanceSaveBtn) maintenanceSaveBtn.disabled = false;
    maintenanceToggleBtn.classList.toggle('is-active', maintenanceActive);
    maintenanceToggleBtn.setAttribute('aria-pressed', String(maintenanceActive));
    maintenanceToggleBtn.textContent = maintenanceActive ? 'Return Website to Live' : 'Enable Maintenance Mode';
  }
  if (maintenanceNote) {
    maintenanceNote.textContent = maintenanceActive
      ? 'The pit-stop page is live. Returning to Live releases every connected visitor automatically.'
      : 'Activation is instant. Open visitors will be sent to the pit-stop page automatically.';
  }
}

function updateStreamButtons(active, hasSaved = false) {
  if (playOverrideBtn)  playOverrideBtn.disabled = active;
  if (stopOverrideBtn)  stopOverrideBtn.disabled = !active;
  if (normalStreamBtn)  normalStreamBtn.disabled = !active && !hasSaved;
}

function rememberOverrideInput(override) {
  if (!override || !Object.prototype.hasOwnProperty.call(override, 'input')) return;
  savedOverrideInput = override.input || '';
  if (!streamUrlInput || document.activeElement === streamUrlInput) return;
  streamUrlInput.value = savedOverrideInput;
}

function syncOverrideConflict() {
  if (!overrideConflict) return;
  overrideConflict.hidden = !(overrideActive && maintenanceActive);
}

const STORE_COLORS = { UPSTASH: 'var(--green)', FILE: 'var(--amber)' };
const storeColor = store => STORE_COLORS[String(store || '').toUpperCase()] || '#ff6b62';

function updateSystemInfo(data) {
  const uptimeMs = data?.server?.uptimeMs ?? (data?.server?.startedAt ? Date.now() - data.server.startedAt : 0);
  if (sysUptime) sysUptime.textContent = formatDuration(uptimeMs);
  if (sysVisitorStore) {
    const active = data?.activeSessions ?? data?.visitors?.length ?? 0;
    sysVisitorStore.textContent = `${active} active / ${data?.totalUnique ?? '—'} unique`;
  }
  const renderStore = (element, value) => {
    if (!element) return;
    const store = String(value || 'unknown').toUpperCase();
    element.textContent = store;
    element.style.color = storeColor(store);
  };
  renderStore(sysUniqueStore, data?.server?.uniqueVisitorStore);
  renderStore(sysNewsStore, data?.server?.newsStore);
  renderStore(sysAnalyticsStore, data?.server?.analyticsStore);
  renderStore(sysSourceStore, data?.server?.sourceStore);
  renderStore(sysOverrideStore, data?.server?.overrideStore);
  if (sysOverrideStatus) {
    sysOverrideStatus.textContent = data?.override?.active ? 'OVERRIDE' : 'NORMAL';
    sysOverrideStatus.style.color = data?.override?.active ? '#ff6b62' : 'var(--green)';
  }
  if (sysMaintenanceStatus) {
    const active = Boolean(data?.maintenance?.active);
    sysMaintenanceStatus.textContent = active ? 'MAINTENANCE' : 'LIVE';
    sysMaintenanceStatus.style.color = active ? '#ff6b62' : 'var(--green)';
  }
  if (sysSessionActive) sysSessionActive.textContent = isAdmin ? 'Yes' : 'No';
  if (sysNodeEnv) {
    const env = String(data?.server?.nodeEnv || 'production').toUpperCase();
    sysNodeEnv.textContent = env;
    sysNodeEnv.style.color = env === 'PRODUCTION' ? 'var(--green)' : 'var(--amber)';
  }
}

// ─────────────────────────────────────────────
// NEWS MANAGEMENT
// ─────────────────────────────────────────────
function newsFromPayload(data) {
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.news) ? data.news : [];
}

function formatNewsDate(timestamp) {
  const date = new Date(Number(timestamp));
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function handleNewsUpdate(data) {
  newsItems = newsFromPayload(data);
  renderNewsAdmin();
}

function renderNewsAdmin() {
  if (!adminNewsList) return;
  const publishedCount = newsItems.filter(item => item.published).length;
  if (newsBadge) {
    newsBadge.textContent = `${publishedCount} Published`;
    newsBadge.className = `panel-badge ${publishedCount ? 'normal' : 'live'}`;
  }

  if (!newsItems.length) {
    adminNewsList.innerHTML = '<div class="empty-state">No news updates yet.</div>';
    return;
  }

  adminNewsList.innerHTML = newsItems.map(item => `
    <article class="admin-news-item">
      <div class="admin-news-item-head">
        <span class="admin-news-tag">${escapeHtml(item.tag || 'Race Control')}</span>
        <span class="admin-news-state ${item.published ? '' : 'draft'}">${item.published ? 'Published' : 'Draft'}</span>
      </div>
      <h3>${escapeHtml(item.title)}</h3>
      <p>${escapeHtml(item.body)}</p>
      <div class="admin-news-item-foot">
        <span class="admin-news-date">${escapeHtml(formatNewsDate(item.createdAt))}</span>
        <div class="admin-news-actions">
          <button class="news-action" type="button" data-news-action="toggle" data-news-id="${escapeHtml(item.id)}">${item.published ? 'Unpublish' : 'Publish'}</button>
          <button class="news-action" type="button" data-news-action="edit" data-news-id="${escapeHtml(item.id)}">Edit</button>
          <button class="news-action delete" type="button" data-news-action="delete" data-news-id="${escapeHtml(item.id)}">Delete</button>
        </div>
      </div>
    </article>`).join('');
}

async function loadNews(notifyOnError = false) {
  if (!adminNewsList) return false;
  try {
    const response = await fetch(`${API_BASE}/news`, { cache: 'no-store', headers: { Accept: 'application/json' } });
    if (response.status === 401) {
      showLogin();
      return false;
    }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'News endpoint is unavailable.');
    handleNewsUpdate(data);
    return true;
  } catch (error) {
    adminNewsList.innerHTML = '<div class="empty-state">Could not load news updates.</div>';
    if (notifyOnError) showToast(error.message || 'Could not load news updates.', 'error');
    return false;
  }
}

function resetNewsForm() {
  if (!newsForm) return;
  newsIdInput.value = '';
  newsTitleInput.value = '';
  newsTagInput.value = 'Race Control';
  newsBodyInput.value = '';
  newsPublishedInput.checked = true;
  newsSaveBtn.textContent = 'Publish Update';
  newsCancelBtn.hidden = true;
}

function editNews(item) {
  if (!item || !newsForm) return;
  newsIdInput.value = item.id || '';
  newsTitleInput.value = item.title || '';
  newsTagInput.value = item.tag || 'Race Control';
  newsBodyInput.value = item.body || '';
  newsPublishedInput.checked = item.published !== false;
  newsSaveBtn.textContent = 'Save Changes';
  newsCancelBtn.hidden = false;
  newsTitleInput.focus();
}

async function saveNews(event) {
  event.preventDefault();
  const title = newsTitleInput.value.trim();
  const body = newsBodyInput.value.trim();
  if (!title || !body) {
    showToast('Add a headline and update first.', 'error');
    return;
  }

  const id = newsIdInput.value.trim();
  const method = id ? 'PATCH' : 'POST';
  const endpoint = id ? `${API_BASE}/news/${encodeURIComponent(id)}` : `${API_BASE}/news`;
  newsSaveBtn.disabled = true;
  newsCancelBtn.disabled = true;
  newsSaveBtn.textContent = id ? 'Saving…' : 'Publishing…';

  try {
    const response = await fetch(endpoint, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ title, body, tag: newsTagInput.value.trim(), published: newsPublishedInput.checked })
    });
    if (response.status === 401) {
      showLogin();
      return;
    }
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.error || 'News update failed.');
    showToast(id ? 'News update saved.' : 'News update published.', 'success');
    if (!data.durable) showToast('Saved in memory only. Configure Upstash to keep news after a server restart.', 'warning');
    resetNewsForm();
    await loadNews();
  } catch (error) {
    showToast(error.message || 'Network error saving news.', 'error');
    newsSaveBtn.textContent = id ? 'Save Changes' : 'Publish Update';
  } finally {
    newsSaveBtn.disabled = false;
    newsCancelBtn.disabled = false;
  }
}

async function toggleNewsPublished(item) {
  if (!item) return;
  try {
    const response = await fetch(`${API_BASE}/news/${encodeURIComponent(item.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ published: !item.published })
    });
    if (response.status === 401) {
      showLogin();
      return;
    }
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.error || 'Could not change publication status.');
    showToast(item.published ? 'News update unpublished.' : 'News update published.', item.published ? 'info' : 'success');
    await loadNews();
  } catch (error) {
    showToast(error.message || 'Network error changing publication status.', 'error');
  }
}

async function deleteNews(item) {
  if (!item || !window.confirm(`Delete “${item.title}”?`)) return;
  try {
    const response = await fetch(`${API_BASE}/news/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
    if (response.status === 401) {
      showLogin();
      return;
    }
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.error || 'Could not delete news update.');
    if (newsIdInput.value === item.id) resetNewsForm();
    showToast('News update deleted.', 'success');
    await loadNews();
  } catch (error) {
    showToast(error.message || 'Network error deleting news.', 'error');
  }
}

newsForm?.addEventListener('submit', saveNews);
newsCancelBtn?.addEventListener('click', resetNewsForm);
adminNewsList?.addEventListener('click', event => {
  const button = event.target.closest('[data-news-action]');
  if (!button) return;
  const item = newsItems.find(entry => entry.id === button.dataset.newsId);
  if (button.dataset.newsAction === 'edit') editNews(item);
  if (button.dataset.newsAction === 'toggle') toggleNewsPublished(item);
  if (button.dataset.newsAction === 'delete') deleteNews(item);
});

// ─────────────────────────────────────────────
// FEED SOURCES
// ─────────────────────────────────────────────
function renderSources() {
  if (!sourceList) return;
  const enabled = feedSources.filter(source => !disabledSources.has(source.id)).length;
  if (sourcesBadge) {
    sourcesBadge.textContent = `${enabled}/${feedSources.length} Enabled`;
    sourcesBadge.className = `panel-badge ${enabled ? 'normal' : 'live'}`;
  }
  if (!feedSources.length) {
    sourceList.innerHTML = '<div class="empty-state">No feed sources reported by the server.</div>';
    return;
  }
  sourceList.replaceChildren(...feedSources.map(source => {
    const disabled = disabledSources.has(source.id);
    const row = document.createElement('div');
    row.className = 'source-row' + (disabled ? ' is-off' : '');
    const name = document.createElement('span');
    name.className = 'source-name';
    name.textContent = source.label;
    const id = document.createElement('span');
    id.className = 'source-id mono';
    id.textContent = source.id;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'source-switch' + (disabled ? '' : ' on');
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', String(!disabled));
    toggle.setAttribute('aria-label', `${disabled ? 'Enable' : 'Disable'} ${source.label}`);
    toggle.dataset.sourceId = source.id;
    toggle.innerHTML = '<i></i>';
    const state = document.createElement('span');
    state.className = 'source-state';
    state.textContent = disabled ? 'Hidden' : 'Live';
    row.append(name, id, state, toggle);
    return row;
  }));
}

async function loadSources(notifyOnError = false) {
  if (!sourceList) return false;
  try {
    const response = await fetch(`${API_BASE}/stream/sources`, { cache: 'no-store', headers: { Accept: 'application/json' } });
    if (response.status === 401) { showLogin(); return false; }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Feed source endpoint is unavailable.');
    feedSources = Array.isArray(data.sources) ? data.sources : [];
    disabledSources = new Set((Array.isArray(data.disabled) ? data.disabled : []).map(String));
    if (sourcesStore) {
      const durable = Boolean(data.durable);
      sourcesStore.textContent = durable ? 'STORE: DURABLE' : 'STORE: MEMORY ONLY';
      sourcesStore.style.color = durable ? 'var(--green)' : '#ff6b62';
    }
    renderSources();
    return true;
  } catch (error) {
    sourceList.innerHTML = '<div class="empty-state">Could not load feed sources.</div>';
    if (notifyOnError) showToast(error.message || 'Could not load feed sources.', 'error');
    return false;
  }
}

/* One toggle = one save, because during a race you want it applied now.
   The switch is optimistic and rolls back if the server rejects the change. */
async function toggleSource(sourceId) {
  if (sourceSaveInFlight || !feedSources.length) return;
  const next = new Set(disabledSources);
  const wasDisabled = next.has(sourceId);
  if (wasDisabled) next.delete(sourceId); else next.add(sourceId);

  sourceSaveInFlight = true;
  disabledSources = next;
  renderSources();
  try {
    const response = await fetch(`${API_BASE}/stream/sources`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: [...next] })
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      showLogin();
      throw new Error('Session expired. Sign in again.');
    }
    if (!response.ok || !data.success) throw new Error(data.error || 'Feed source update failed.');
    disabledSources = new Set((Array.isArray(data.disabled) ? data.disabled : []).map(String));
    renderSources();
    if (!data.durable) showToast('Saved in memory only. Configure Upstash to keep this after a server restart.', 'warning');
  } catch (error) {
    // Roll back to the server-confirmed state.
    if (wasDisabled) next.add(sourceId); else next.delete(sourceId);
    disabledSources = next;
    renderSources();
    showToast(error.message || 'Could not update the feed source.', 'error');
  } finally {
    sourceSaveInFlight = false;
  }
}

sourceList?.addEventListener('click', event => {
  const button = event.target.closest('.source-switch');
  if (button) toggleSource(button.dataset.sourceId);
});
sourcesRefreshBtn?.addEventListener('click', () => loadSources(true));

// ─────────────────────────────────────────────
// VISITOR TABLE
// ─────────────────────────────────────────────
function updateVisitorTable(data) {
  if (!visitorTableBody || !data?.visitors) return;
  const now = Date.now();
  const visitors = [...data.visitors].sort((a, b) => (b.lastSeen - a.lastSeen));
  if (!visitors.length) { renderEmptyVisitors(); return; }

  const existingRows = new Map();
  visitorTableBody.querySelectorAll('tr[data-key]').forEach(row => existingRows.set(row.dataset.key, row));
  const orderedRows = [];

  visitors.forEach(visitor => {
    const key = String(visitor.id || visitor.ip || visitor.lastSeen);
    const online = now - (visitor.lastSeen || 0) <= ONLINE_WINDOW_MS;
    const flag = visitor.countryCode ? getFlag(visitor.countryCode) : '🌐';
    const country = visitor.country || visitor.countryCode || 'Unknown';
    const place = visitor.city ? `${visitor.city}, ${country}` : country;
    const device = String(visitor.deviceType || '—');
    const deviceSlug = /^(mobile|tablet|desktop)$/i.test(device) ? device.toLowerCase() : 'unknown';
    const signature = JSON.stringify([visitor.ip, place, visitor.countryCode, visitor.browser, visitor.os, device, visitor.page, online]);
    let row = existingRows.get(key);
    if (!row) {
      row = document.createElement('tr');
      row.dataset.key = key;
      row.className = 'fade-in';
    }
    row.dataset.online = online ? '1' : '0';
    if (row.dataset.signature !== signature) {
      row.dataset.signature = signature;
      row.innerHTML = `
        <td class="ip" data-label="IP Address">${escapeHtml(visitor.ip || key)}</td>
        <td class="country" data-label="Location"><span class="flag">${flag}</span>${escapeHtml(place)}</td>
        <td data-label="Browser">${escapeHtml(visitor.browser || '—')}</td>
        <td data-label="OS">${escapeHtml(visitor.os || '—')}</td>
        <td class="device-${deviceSlug}" data-label="Device">${escapeHtml(device)}</td>
        <td class="page-cell" data-label="Page" title="${escapeHtml(visitor.page || '/')}">${escapeHtml(visitor.page || '/')}</td>
        <td class="status-cell" data-label="Status"><span class="pill-sm status-pill ${online ? 'pill-online' : 'pill-offline'}"><span class="${online ? 'dot-online' : 'dot-offline'}"></span>${online ? 'Online' : 'Offline'}</span></td>
        <td class="timestamp-cell" data-label="Last Seen">${formatTimeAgo(visitor.lastSeen)}</td>`;
    } else {
      const timeCell = row.querySelector('.timestamp-cell');
      if (timeCell) timeCell.textContent = formatTimeAgo(visitor.lastSeen);
    }
    orderedRows.push(row);
  });

  const fragment = document.createDocumentFragment();
  orderedRows.forEach(row => fragment.appendChild(row));
  visitorTableBody.replaceChildren(fragment);
}

function renderEmptyVisitors() {
  visitorTableBody.innerHTML = `
    <tr id="visitorEmpty">
      <td colspan="8"><div class="empty-state">Waiting for visitor data…</div></td>
    </tr>`;
}

function refreshVisitorTimes() {
  if (!visitorTableBody || !currentStats?.visitors?.length) return;
  const now = Date.now();
  const visitors = new Map(currentStats.visitors.map(visitor => [String(visitor.id || visitor.ip || visitor.lastSeen), visitor]));
  let online = 0;
  visitorTableBody.querySelectorAll('tr[data-key]').forEach(row => {
    const visitor = visitors.get(row.dataset.key);
    if (!visitor) return;
    const cell = row.querySelector('.timestamp-cell');
    if (cell) cell.textContent = formatTimeAgo(visitor.lastSeen);
    const isOnline = now - (visitor.lastSeen || 0) <= ONLINE_WINDOW_MS;
    if (isOnline) online++;
    if (row.dataset.online === (isOnline ? '1' : '0')) return;
    row.dataset.online = isOnline ? '1' : '0';
    const status = row.querySelector('.status-cell');
    if (status) {
      status.innerHTML = `<span class="pill-sm status-pill ${isOnline ? 'pill-online' : 'pill-offline'}"><span class="${isOnline ? 'dot-online' : 'dot-offline'}"></span>${isOnline ? 'Online' : 'Offline'}</span>`;
    }
  });
  if (onlineCountEl) onlineCountEl.textContent = String(online);
  if (tableBadge) tableBadge.textContent = `● ${online} Live`;
  currentStats.onlineCount = online;
}

/* Visitor rows are mutated in place and the table is repainted at most once
   per coalesce window. Every visitor heartbeat broadcasts an SSE event, so
   repainting synchronously meant one full sort + re-render per heartbeat per
   viewer — hundreds of DOM rebuilds a minute on a busy race weekend. */
let visitorIndex = new Map();
let visitorRenderTimer = null;
let visitorRenderPending = false;
const VISITOR_RENDER_COALESCE_MS = 250;
// Matches the server's HEARTBEAT_TIMEOUT default (60s) for the online pill.
const ONLINE_WINDOW_MS = 60_000;

function indexVisitors(visitors) {
  const index = new Map();
  for (const visitor of visitors || []) index.set(String(visitor.id || visitor.ip), visitor);
  return index;
}

function scheduleVisitorRender() {
  if (!isAdmin || document.hidden) return;
  visitorRenderPending = true;
  if (visitorRenderTimer) return;
  // A timer (not rAF) so a hidden tab still settles before it is revealed.
  visitorRenderTimer = setTimeout(() => {
    visitorRenderTimer = null;
    if (!visitorRenderPending || !currentStats) return;
    visitorRenderPending = false;
    updateStatCards(currentStats);
    updateVisitorTable(currentStats);
  }, VISITOR_RENDER_COALESCE_MS);
}

function handleVisitorUpdate(type, visitor) {
  if (!visitor || !currentStats) return;
  if (!Array.isArray(currentStats.visitors)) currentStats.visitors = [];
  const key = String(visitor.id || visitor.ip);
  const existing = visitorIndex.get(key);

  if (type === 'offline') {
    if (existing) {
      const idx = currentStats.visitors.indexOf(existing);
      if (idx >= 0) currentStats.visitors.splice(idx, 1);
      visitorIndex.delete(key);
    }
  } else if (existing) {
    Object.assign(existing, visitor);
  } else {
    currentStats.visitors.unshift(visitor);
    visitorIndex.set(key, visitor);
  }

  const now = Date.now();
  currentStats.onlineCount = currentStats.visitors.filter(v => now - (v.lastSeen || 0) <= ONLINE_WINDOW_MS).length;
  currentStats.activeSessions = currentStats.visitors.length;
  // totalUnique is an all-time counter owned by the server — never derive it
  // from the number of rows currently on screen.
  scheduleVisitorRender();
}

function handleStreamStatusUpdate(data) {
  if (currentStats) currentStats.override = data;
  updateStreamStatus(data);
  if (currentStats) updateStatCards(currentStats);
}

function handleStreamOverrideUpdate(data) {
  const changed = Boolean(data.active) !== overrideActive || (data.url || '') !== previewUrl;
  handleStreamStatusUpdate(data);
  if (!changed) return;
  if (data.active) showToast('Stream override activated.', 'warning');
  else if (data.input) showToast('Override stopped. The URL is still saved.', 'success');
  else showToast('Returned to the normal feed. Saved URL cleared.', 'success');
}

function handleMaintenanceUpdate(data) {
  const wasKnown = maintenanceStateKnown;
  const changed = wasKnown && Boolean(data?.active) !== maintenanceActive;
  if (currentStats) currentStats.maintenance = data;
  updateMaintenanceStatus(data);
  if (currentStats) updateSystemInfo(currentStats);
  if (changed) {
    showToast(
      data.active ? 'Maintenance mode enabled — the public site is now in the pits.' : 'Public website released — APEX is live again.',
      data.active ? 'warning' : 'success'
    );
  }
}

// ─────────────────────────────────────────────
// WEBSITE MODE CONTROL
// ─────────────────────────────────────────────
async function loadMaintenanceStatus(notifyOnError = false) {
  if (!maintenanceToggleBtn) return false;
  maintenanceToggleBtn.disabled = true;
  if (maintenanceSaveBtn) maintenanceSaveBtn.disabled = true;
  maintenanceToggleBtn.textContent = 'Checking Website Mode…';

  try {
    const response = await fetch(`${API_BASE}/maintenance`, {
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    });
    if (response.status === 401) {
      showLogin();
      return false;
    }
    const data = await response.json();
    if (!response.ok || !data.maintenance) throw new Error(data.error || 'Website mode endpoint is unavailable.');
    if (currentStats) currentStats.maintenance = data.maintenance;
    updateMaintenanceStatus(data.maintenance);
    return true;
  } catch (error) {
    maintenanceStateKnown = false;
    maintenanceToggleBtn.disabled = false;
    if (maintenanceSaveBtn) maintenanceSaveBtn.disabled = true;
    maintenanceToggleBtn.classList.remove('is-active');
    maintenanceToggleBtn.textContent = 'Retry Website Mode';
    if (maintenanceNote) maintenanceNote.textContent = 'Could not verify the current website mode. Click Retry instead of using an unconfirmed state.';
    if (notifyOnError) showToast(error.message || 'Could not load website mode.', 'error');
    return false;
  }
}

async function toggleMaintenanceMode() {
  if (!maintenanceToggleBtn) return;
  if (!maintenanceStateKnown && !(await loadMaintenanceStatus(true))) return;
  const nextActive = !maintenanceActive;
  const message = maintenanceMessage?.value.trim() || "We'll be back before the race.";
  const eta = maintenanceEta?.value.trim() || 'Before lights out';

  if (nextActive && !window.confirm('Enable maintenance mode now? Every public visitor will be moved to the pit-stop page.')) return;

  maintenanceToggleBtn.disabled = true;
  maintenanceToggleBtn.textContent = nextActive ? 'Sending Site to the Pits…' : 'Releasing Website…';

  try {
    const response = await fetch(`${API_BASE}/maintenance`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: nextActive, message, eta })
    });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.error || 'Maintenance update failed.');

    if (currentStats) currentStats.maintenance = data.maintenance;
    updateMaintenanceStatus(data.maintenance);
    if (!data.durable) {
      showToast('Mode changed, but permanent storage is unavailable. Configure Upstash before restarting Render.', 'warning');
    } else {
      showToast(nextActive ? 'Maintenance mode is live.' : 'The public website is live again.', nextActive ? 'warning' : 'success');
    }
  } catch (error) {
    showToast(error.message || 'Network error changing website mode.', 'error');
    updateMaintenanceStatus({
      active: maintenanceActive,
      message: maintenanceMessage?.value || "We'll be back before the race."
    });
  }
}

/* Push the message + pit-board ETA live WITHOUT flipping the mode: the
   server keeps startedAt when 'active' is unchanged, and the SSE broadcast
   updates every open maintenance page instantly. */
async function saveMaintenanceDetails() {
  if (!maintenanceSaveBtn) return;
  if (!maintenanceStateKnown && !(await loadMaintenanceStatus(true))) return;
  const message = maintenanceMessage?.value.trim() || "We'll be back before the race.";
  const eta = maintenanceEta?.value.trim() || 'Before lights out';

  maintenanceSaveBtn.disabled = true;
  maintenanceSaveBtn.textContent = 'Updating Pit Board…';
  try {
    const response = await fetch(`${API_BASE}/maintenance`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: maintenanceActive, message, eta })
    });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.error || 'Pit board update failed.');
    if (currentStats) currentStats.maintenance = data.maintenance;
    updateMaintenanceStatus(data.maintenance);
    showToast(maintenanceActive
      ? 'Pit board updated — live on the maintenance page.'
      : 'Details saved. They will show when maintenance mode is enabled.', 'success');
  } catch (error) {
    showToast(error.message || 'Could not update the pit board.', 'error');
    updateMaintenanceStatus({
      active: maintenanceActive,
      message: maintenanceMessage?.value || "We'll be back before the race.",
      eta: maintenanceEta?.value || 'Before lights out'
    });
  } finally {
    maintenanceSaveBtn.textContent = 'Update Pit Board';
  }
}

maintenanceSaveBtn?.addEventListener('click', saveMaintenanceDetails);
maintenanceToggleBtn?.addEventListener('click', toggleMaintenanceMode);

// ─────────────────────────────────────────────
// STREAM CONTROLS
// ─────────────────────────────────────────────
function applyOverridePayload(data) {
  if (!data) return false;
  const changed = Boolean(data.active) !== overrideActive || (data.url || '') !== previewUrl || (data.input || '') !== savedOverrideInput;
  handleStreamStatusUpdate(data);
  return changed;
}

async function postStreamAction(path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body || {})
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    showLogin();
    throw new Error('Session expired. Sign in again.');
  }
  if (!response.ok || !data.success) throw new Error(data.error || 'Stream update failed.');
  return data;
}

function noteOverrideResult(data, changed, activeMessage, idleMessage) {
  if (changed) showToast(data.override?.active ? activeMessage : idleMessage, data.override?.active ? 'warning' : 'success');
  if (data.durable === false) showToast('Saved in memory only. Configure Upstash to keep the override after a restart.', 'warning');
}

async function activateStreamOverride() {
  const url = streamUrlInput.value.trim();
  if (!url) { showToast('Enter a stream URL first.', 'error'); return; }
  if (!isValidUrl(url)) { showToast('Please enter a valid URL.', 'error'); return; }

  playOverrideBtn.disabled = true;
  playOverrideBtn.textContent = 'Activating…';

  try {
    const data = await postStreamAction('/stream/override', { url });
    const changed = applyOverridePayload(data.override);
    noteOverrideResult(data, changed, 'Stream override activated.', 'Stream override updated.');
  } catch (error) {
    showToast(error.message || 'Network error activating override.', 'error');
  } finally {
    playOverrideBtn.textContent = '▶ Play Override';
    updateStreamButtons(overrideActive, Boolean(savedOverrideInput));
  }
}

async function stopStreamOverride() {
  stopOverrideBtn.disabled = true;
  stopOverrideBtn.textContent = 'Stopping…';
  try {
    const data = await postStreamAction('/stream/stop');
    const changed = applyOverridePayload(data.override);
    noteOverrideResult(data, changed, 'Stream override activated.', 'Override stopped. The URL is still saved.');
  } catch (error) {
    showToast(error.message || 'Network error stopping override.', 'error');
  } finally {
    stopOverrideBtn.textContent = '■ Stop Override';
    updateStreamButtons(overrideActive, Boolean(savedOverrideInput));
  }
}

async function returnToNormalStream() {
  normalStreamBtn.disabled = true;
  normalStreamBtn.textContent = 'Restoring…';
  try {
    const data = await postStreamAction('/stream/normal');
    const changed = applyOverridePayload(data.override);
    noteOverrideResult(data, changed, 'Stream override activated.', 'Returned to the normal feed. Saved URL cleared.');
  } catch (error) {
    showToast(error.message || 'Network error restoring stream.', 'error');
  } finally {
    normalStreamBtn.textContent = '↩ Return to Normal';
    updateStreamButtons(overrideActive, Boolean(savedOverrideInput));
  }
}

const VIDEO_MIME = { mp4: 'video/mp4', webm: 'video/webm' };

function renderStreamPreview(url, type) {
  if (!streamPreview || !url || previewUrl === url) return;
  previewUrl = url;
  const mime = VIDEO_MIME[type];
  if (mime) {
    streamPreview.innerHTML = `<video controls autoplay playsinline preload="metadata" style="width:100%;height:100%;border-radius:var(--radius-sm)"><source src="${escapeHtml(url)}" type="${mime}"></video>`;
    return;
  }
  if (type === 'youtube' || type === 'embed' || type) {
    // No `sandbox` attribute here on purpose: the embeds' ad layer probes
    // window.open() on first click and, when it returns null (sandboxed
    // without allow-popups), its bid server answers showSbxMsg and the
    // preview is buried under a "Notice for webmaster: remove Sandbox from
    // iframe" overlay. The preview is admin-authenticated and cross-origin
    // isolation already shields the panel from the framed page.
    streamPreview.innerHTML = `<iframe src="${escapeHtml(url)}" allow="autoplay; fullscreen" allowFullScreen referrerpolicy="no-referrer"></iframe>`;
  }
}

function clearStreamPreview() {
  if (!streamPreview) return;
  previewUrl = '';
  streamPreview.innerHTML = `
    <div class="placeholder">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <polygon points="5 3 19 12 5 21 5 3" fill="currentColor" opacity=".3"/>
      </svg>
      <div>No override active</div>
      <div style="font-size:.65rem;margin-top:4px">Normal feed broadcasting</div>
    </div>`;
}

playOverrideBtn?.addEventListener('click', activateStreamOverride);
stopOverrideBtn?.addEventListener('click', stopStreamOverride);
normalStreamBtn?.addEventListener('click', returnToNormalStream);

// ─────────────────────────────────────────────
// POLL FALLBACK (in case SSE stalls)
// ─────────────────────────────────────────────
async function pollStats(force = false) {
  if (!isAdmin || document.hidden) return;
  if (!force && sseConnected && Date.now() - lastSseMessageAt < 60000) return;
  try {
    const response = await fetch(`${API_BASE}/visitors`, { cache: 'no-store' });
    if (response.status === 401) { showLogin(); return; }
    if (!response.ok) return;
    handleStatsUpdate(await response.json());
    lastSseMessageAt = Date.now();
  } catch (_) { /* EventSource/retry UI already reports connectivity. */ }
}

setInterval(pollStats, REFRESH_MS);

// ─────────────────────────────────────────────
// UPTIME CLOCK
// ─────────────────────────────────────────────
setInterval(() => {
  if (!isAdmin || document.hidden) return;
  renderServerClock();
  if (currentStats?.server?.startedAt && sysUptime) sysUptime.textContent = formatDuration(Date.now() - currentStats.server.startedAt);
  refreshVisitorTimes();
}, 1000);

// ─────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor((ms || 0) / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days) return `${days}d ${hours}h ${minutes}m`;
  if (hours) return `${hours}h ${minutes}m ${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function formatTimeAgo(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 0) return 'Just now';
  const s = Math.floor(diff / 1000);
  if (s < 5)   return 'Just now';
  if (s < 60)  return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m}m ${s % 60}s ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

function getFlag(cc) {
  if (!cc || cc.length !== 2) return '🌐';
  const code = cc.toUpperCase().replace(/[^A-Z]/g, '');
  if (!code) return '🌐';
  return code
    .split('')
    .map(c => String.fromCodePoint(0x1F1E6 - 65 + c.charCodeAt(0)))
    .join('');
}

function isValidUrl(str) {
  try {
    const url = new URL(str);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

// ─────────────────────────────────────────────
// TOAST NOTIFICATIONS
// ─────────────────────────────────────────────
function showToast(message, type = 'info') {
  if (!toastContainer) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  const now = new Date();
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  toast.innerHTML = `
    <div class="toast-dot ${type}"></div>
    <div class="toast-msg">${escapeHtml(message)}</div>
    <div class="toast-time">${time}</div>`;
  toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('removing');
    setTimeout(() => toast.remove(), 300);
  }, 4500);
}

// ─────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────
window.__adminUnauth = () => { if (isAdmin) showLogin(); };
checkAuthStatus();
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && isAdmin) {
    if (!sseConnected) connectSSE();
    pollStats(true);
  }
}, { passive: true });
addEventListener('pagehide', () => { sse?.close(); }, { once: true });
