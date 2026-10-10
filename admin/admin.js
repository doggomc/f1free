/* ═══════════════════════════════════════════════════════════
   FreeF1 Admin Dashboard — JavaScript
   Auth · SSE · Visitor Table · Stream Controls
   ═══════════════════════════════════════════════════════════ */

'use strict';

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────

/* Motion preference, same contract as the public site: when the OS asks for
   reduced motion we say so in one place — html.lite-motion — which the
   stylesheet already honours, and any future JS animation can check. */
const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
if (reduceMotion) document.documentElement.classList.add('lite-motion');

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
const onlineBreakdownEl = $('onlineBreakdown');
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
const experimentalBadge = $('experimentalBadge');
const experimentalStatus = $('experimentalStatus');
const experimentalStatusTitle = $('experimentalStatusTitle');
const experimentalStatusText = $('experimentalStatusText');
const experimentalToggle = $('experimentalToggle');
const experimentalStore = $('experimentalStore');
const experimentalRefreshBtn = $('experimentalRefreshBtn');
const sysExperimentalStatus = $('sysExperimentalStatus');
const sysExperimentalStore = $('sysExperimentalStore');
// ── New: tabs & sessions gating & force-live
const tabButtons        = () => document.querySelectorAll('.admin-tab');
const tabPanels         = () => document.querySelectorAll('.tab-panel');
const tabSessionsCount  = $('tabSessionsCount');
const openSessionsBtn   = $('openSessionsBtn');
const openSessionsLabel = $('openSessionsLabel');
const sessionsCountPill = $('sessionsCountPill');
const sessionsPanel     = $('sessionsPanel');
const sessionsSearch    = $('sessionsSearch');
const closeSessionsBtn  = $('closeSessionsBtn');
const sessionsMeta      = $('sessionsMeta');
const sessionsMetaBottom= $('sessionsMetaBottom');
const sessionsPagination= $('sessionsPagination');
const sessionsPaginationBottom = $('sessionsPaginationBottom');
const sessionsHint      = $('sessionsHint');
const sessionsModal     = $('sessionsModal');
const sessionsModalBackdrop = $('sessionsModalBackdrop');
const sessionsModalClose= $('sessionsModalClose');
const forceLiveBadge    = $('forceLiveBadge');
const forceLiveStatus   = $('forceLiveStatus');
const forceLiveDot      = $('forceLiveDot');
const forceLiveTitle    = $('forceLiveTitle');
const forceLiveText     = $('forceLiveText');
const forceLiveReason   = $('forceLiveReason');
const forceLiveEnableBtn= $('forceLiveEnableBtn');
const forceLiveDisableBtn= $('forceLiveDisableBtn');
const forceLiveMeta     = $('forceLiveMeta');


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
// ── Tabs & sessions gating
let activeTab = 'race';
let sessionsGateOpen = false;
let sessionsPage = 1;
const SESSIONS_PAGE_SIZE = 50;
let sessionsSearchQuery = '';
let streamWindowState = { active:false, reason:'', startedAt:null, updatedAt:null };
let streamWindowStoreReady = false;
let forceLiveInFlight = false;


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

/* The dashboard reuses the site's sticky nav, stylesheet and all. The site adds
   `.nav.stuck` while scrolling (netlifyf1/app.js, onScroll); the admin never
   did, so the fixed bar stayed at `background: rgba(10,10,11,0)` and the page
   scrolled straight through it — on a phone the panels visibly collided with
   the brand, the LOGOUT button and the sessions toolbar. Same rule, same
   threshold, same rAF coalescing as the site. */
const navEl = document.getElementById('adminNav');
let navTicking = false;
function onScroll() {
  if (navTicking) return;
  navTicking = true;
  requestAnimationFrame(() => {
    navEl?.classList.toggle('stuck', window.scrollY > 40);
    navTicking = false;
  });
}
addEventListener('scroll', onScroll, { passive: true });
addEventListener('resize', onScroll, { passive: true });
onScroll();

function showDashboard() {
  isAdmin = true;
  authScreen.classList.add('hidden');
  appEl.classList.add('open');
  initTabs();
  connectSSE();
  pollStats();
  loadMaintenanceStatus();
  loadNews();
  loadSources();
  loadExperimental();
  loadStreamWindow();
  if (typeof Analytics !== 'undefined') Analytics.start();
  // sessions gate updates even while closed
  updateSessionsGateMeta();
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
// TABS — fade like site Discord/Info, no page reload
// ─────────────────────────────────────────────
function initTabs() {
  const buttons = document.querySelectorAll('.admin-tab');
  if (!buttons.length) return;
  const navLinks = document.getElementById('adminTabLinks');
  const toggle = document.getElementById('adminMenuToggle');
  // mobile toggle — same as site .nav-toggle
  toggle?.addEventListener('click', () => {
    const isOpen = navLinks?.classList.toggle('open');
    toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  });
  // close menu when clicking outside or selecting
  document.addEventListener('click', (e) => {
    if (!navLinks?.classList.contains('open')) return;
    if (navLinks.contains(e.target) || toggle?.contains(e.target)) return;
    navLinks.classList.remove('open');
    toggle?.setAttribute('aria-expanded', 'false');
  });
  // restore last tab — exact site view logic
  const saved = localStorage.getItem('freef1_admin_tab');
  if (saved && document.getElementById('tab-' + saved)) activeTab = saved;
  // set initial current
  document.querySelectorAll('.admin-tab').forEach(a=> {
    const on = a.dataset.tab === activeTab;
    a.classList.toggle('current', on);
    if (on) a.setAttribute('aria-selected','true'); else a.setAttribute('aria-selected','false');
  });
  // ensure only active view has is-active
  document.querySelectorAll('.view').forEach(v=>{
    if (v.id === 'tab-' + activeTab) { v.hidden=false; v.classList.add('is-active'); v.classList.remove('is-leaving'); }
    else { v.hidden=true; v.classList.remove('is-active','is-leaving'); }
  });
  buttons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const tab = btn.dataset.tab;
      if (!tab) return;
      switchTab(tab, true);
      // close mobile menu after selection
      navLinks?.classList.remove('open');
      toggle?.setAttribute('aria-expanded','false');
    });
  });
  // also footer links with data-tab
  document.querySelectorAll('[data-tab]').forEach(el=>{
    if (el.classList.contains('admin-tab')) return;
    el.addEventListener('click',(e)=>{
      e.preventDefault();
      const tab = el.getAttribute('data-tab');
      if (tab) switchTab(tab,true);
    });
  });
}
function switchTab(tab, animate) {
  if (tab === activeTab && document.getElementById('tab-' + tab)?.classList.contains('is-active')) return;
  const leaving = document.querySelector('.view.is-active');
  const entering = document.getElementById('tab-' + tab);
  if (!entering) return;
  activeTab = tab;
  localStorage.setItem('freef1_admin_tab', tab);
  // nav current — exact site .nav-links a.current behavior
  document.querySelectorAll('.admin-tab').forEach(a=> {
    const on = a.dataset.tab === tab;
    a.classList.toggle('current', on);
    a.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  // view swap — exact Discord/Info fade: is-active + is-leaving
  if (leaving && leaving !== entering) {
    leaving.classList.remove('is-active');
    leaving.classList.add('is-leaving');
    const done = () => {
      leaving.classList.remove('is-leaving');
      leaving.hidden = true;
      leaving.removeEventListener('transitionend', done);
    };
    if (animate) {
      leaving.addEventListener('transitionend', done, {once:true});
      setTimeout(done, 300);
    } else {
      leaving.classList.remove('is-leaving');
      leaving.hidden = true;
    }
  }
  entering.hidden = false;
  // force reflow then add is-active next frame — site does double rAF
  requestAnimationFrame(()=> requestAnimationFrame(()=>{
    entering.classList.add('is-active');
    entering.classList.remove('is-leaving');
    if (tab === 'analytics' && typeof Analytics !== 'undefined' && Analytics.start) {
      setTimeout(() => Analytics.refresh && Analytics.refresh(), 80);
    }
    if (tab === 'sessions' && sessionsGateOpen) scheduleVisitorRender();
  }));
}

// ─────────────────────────────────────────────
// FORCE LIVE — stream window override (no refresh)
// ─────────────────────────────────────────────
async function loadStreamWindow() {
  try {
    const r = await fetch(`${API_BASE}/stream/window`, { cache:'no-store', credentials:'same-origin' });
    if (!r.ok) throw new Error('load failed');
    const d = await r.json();
    if (d.streamWindow) {
      streamWindowState = d.streamWindow;
      streamWindowStoreReady = !!d.durable;
      renderForceLive();
    }
  } catch (_) {}
}
function renderForceLive() {
  const active = !!streamWindowState.active;
  if (forceLiveBadge) {
    forceLiveBadge.textContent = active ? 'FORCED LIVE' : 'Auto';
    forceLiveBadge.className = 'panel-badge ' + (active ? 'live' : 'normal');
  }
  if (forceLiveStatus) {
    forceLiveStatus.classList.toggle('is-forced', active);
  }
  if (forceLiveDot) {
    forceLiveDot.className = active ? 'status-indicator forced' : 'status-indicator online';
  }
  if (forceLiveTitle) {
    forceLiveTitle.textContent = active ? 'Force Live — ACTIVE' : 'Schedule Window';
    forceLiveTitle.style.color = active ? '#ff6b62' : 'var(--green)';
  }
  if (forceLiveText) {
    if (active) {
      const since = streamWindowState.startedAt ? formatTimeAgo(streamWindowState.startedAt) : 'just now';
      forceLiveText.textContent = streamWindowState.reason ? `Locked live ${since} — ${streamWindowState.reason}` : `Streams locked live ${since}. All viewers see ● LIVE until you disable.`;
    } else {
      forceLiveText.textContent = 'Streams follow the race schedule. Overtime and red-flag delays may hide the player if the window closes.';
    }
  }
  if (forceLiveMeta) {
    const store = streamWindowStoreReady ? 'durable' : 'memory';
    const when = streamWindowState.updatedAt ? new Date(streamWindowState.updatedAt).toLocaleString() : '—';
    forceLiveMeta.textContent = `STATE: ${active ? 'FORCED' : 'AUTO'} · STORE: ${store.toUpperCase()} · UPDATED: ${when}`;
  }
  const panel = document.getElementById('panel-force-live');
  if (panel) panel.classList.toggle('is-forced', active);
  if (forceLiveEnableBtn) forceLiveEnableBtn.disabled = active || forceLiveInFlight;
  if (forceLiveDisableBtn) forceLiveDisableBtn.disabled = !active || forceLiveInFlight;
  if (forceLiveReason) {
    if (active) forceLiveReason.value = streamWindowState.reason || forceLiveReason.value;
    // keep reason editable only when not forced? still editable for update
  }
  // also reflect in system panel
  const sysForce = document.getElementById('sysStreamWindow');
  if (!sysForce) {
    // create row if missing dynamically — add to system-panel
    const sysPanel = document.querySelector('.system-panel');
    if (sysPanel && !document.getElementById('sysStreamWindow')) {
      const row = document.createElement('div');
      row.className='system-item';
      row.innerHTML='<span class="sys-key">Force Live</span><span class="sys-val" id="sysStreamWindow">—</span>';
      sysPanel.appendChild(row);
    }
  }
  const sw = document.getElementById('sysStreamWindow');
  if (sw) { sw.textContent = active ? 'FORCED' : 'AUTO'; sw.style.color = active ? '#ff6b62' : 'var(--green)'; }
}
async function setForceLive(active) {
  if (forceLiveInFlight) return;
  const reason = (forceLiveReason && forceLiveReason.value || '').trim().slice(0,120);
  forceLiveInFlight = true;
  if (forceLiveEnableBtn) forceLiveEnableBtn.disabled = true;
  if (forceLiveDisableBtn) forceLiveDisableBtn.disabled = true;
  try {
    const r = await fetch(`${API_BASE}/stream/window`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ active, reason })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Request failed');
    streamWindowState = d.streamWindow || { active, reason, startedAt: Date.now(), updatedAt: Date.now() };
    streamWindowStoreReady = !!d.durable;
    renderForceLive();
    showToast(active ? 'Force Live enabled — viewers are now locked live.' : 'Force Live disabled — schedule window restored.', active ? 'warning' : 'success');
  } catch (e) {
    showToast(e.message || 'Could not update Force Live.', 'error');
  } finally {
    forceLiveInFlight = false;
    renderForceLive();
  }
}
function handleStreamWindowUpdate(data) {
  if (!data) return;
  streamWindowState = data;
  renderForceLive();
}
forceLiveEnableBtn?.addEventListener('click', () => setForceLive(true));
forceLiveDisableBtn?.addEventListener('click', () => setForceLive(false));


// ─────────────────────────────────────────────
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

  /* Live counts, pushed the moment they change — no waiting for the 15s poll. */
  sse.addEventListener('presence', e => {
    try {
      const data = JSON.parse(e.data);
      const live = data.active;
      if (!Number.isFinite(live)) return;
      if (onlineCountEl) onlineCountEl.textContent = String(live);
      if (onlineBreakdownEl) onlineBreakdownEl.textContent = live === 1 ? 'browser on the site' : 'browsers on the site';
      if (tableBadge) tableBadge.textContent = `● ${live} on site`;
      lastSseMessageAt = Date.now();
    } catch (_) {}
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

  sse.addEventListener('experimental_update', e => {
    const data = readSseEvent(e);
    if (data && typeof data.enabled === 'boolean') {
      renderExperimentalState(data.enabled);
    }
  });

  sse.addEventListener('stream_window_update', e => {
    const data = readSseEvent(e);
    if (data) handleStreamWindowUpdate(data);
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
  updateSessionsGateMeta();
  if (sessionsGateOpen) updateVisitorTable(data);
  // With the table closed there is nothing else to refresh: the stat cards were
  // just filled from the snapshot's own numbers, and this used to overwrite the
  // viewer headline with a count derived from the dashboard's local 60s window
  // — a different number from the one the server had just sent.
  else if (tableBadge) {
    tableBadge.textContent = `● ${Number.isFinite(data.liveCount) ? data.liveCount : (data.visitors || []).length} on site`;
  }
  updateStreamStatus(data.override);
  updateMaintenanceStatus(data.maintenance);
  if (data.streamWindow) handleStreamWindowUpdate(data.streamWindow);
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
  // One number: browsers on the site right now. The server owns it, and the
  // rows in the table are the same predicate with the same deadline.
  const live = Number.isFinite(data.liveCount) ? data.liveCount : (data.visitors || []).filter(v => v.live).length;
  if (onlineCountEl) onlineCountEl.textContent = String(live);
  if (onlineBreakdownEl) onlineBreakdownEl.textContent = live === 1 ? 'browser on the site' : 'browsers on the site';
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
  if (tableBadge) tableBadge.textContent = `● ${live} on site`;

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
      : 'Visitors can access the full FreeF1 experience.';
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

const STORE_COLORS = { REDIS: 'var(--green)', UPSTASH: 'var(--green)', FILE: 'var(--amber)' };
const storeColor = store => STORE_COLORS[String(store || '').toUpperCase()] || '#ff6b62';

function updateSystemInfo(data) {
  const uptimeMs = data?.server?.uptimeMs ?? (data?.server?.startedAt ? Date.now() - data.server.startedAt : 0);
  if (sysUptime) sysUptime.textContent = formatDuration(uptimeMs);
  if (sysVisitorStore) {
    const live = data?.liveCount ?? (data?.visitors || []).length;
    sysVisitorStore.textContent = `${live} on site / ${data?.totalUnique ?? '—'} unique`;
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
  renderStore(sysExperimentalStore, data?.server?.experimentalStore);
  if (sysOverrideStatus) {
    sysOverrideStatus.textContent = data?.override?.active ? 'OVERRIDE' : 'NORMAL';
    sysOverrideStatus.style.color = data?.override?.active ? '#ff6b62' : 'var(--green)';
  }
  if (sysMaintenanceStatus) {
    const active = Boolean(data?.maintenance?.active);
    sysMaintenanceStatus.textContent = active ? 'MAINTENANCE' : 'LIVE';
    sysMaintenanceStatus.style.color = active ? '#ff6b62' : 'var(--green)';
  }
  if (sysExperimentalStatus) {
    sysExperimentalStatus.textContent = experimentalEnabled ? 'ENABLED' : 'DISABLED';
    sysExperimentalStatus.style.color = experimentalEnabled ? 'var(--green)' : '#ff6b62';
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
    if (!data.durable) showToast('Saved in memory only. Configure REDIS_URL to keep news after a server restart.', 'warning');
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
    if (!data.durable) showToast('Saved in memory only. Configure REDIS_URL to keep this after a server restart.', 'warning');
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
// EXPERIMENTAL FEATURES TOGGLE
// ─────────────────────────────────────────────
let experimentalEnabled = true;
let experimentalSaveInFlight = false;

function renderExperimentalState(enabled) {
  experimentalEnabled = Boolean(enabled);
  if (experimentalBadge) {
    experimentalBadge.textContent = experimentalEnabled ? 'Enabled' : 'Disabled';
    experimentalBadge.className = `panel-badge ${experimentalEnabled ? 'normal' : 'live'}`;
  }
  if (experimentalStatus) {
    experimentalStatus.className = `maintenance-status ${experimentalEnabled ? 'is-live' : 'is-maint'}`;
  }
  if (experimentalStatusTitle) {
    experimentalStatusTitle.textContent = experimentalEnabled ? 'Experimental Section Visible' : 'Experimental Section Hidden';
  }
  if (experimentalStatusText) {
    experimentalStatusText.textContent = experimentalEnabled
      ? 'The "Experimental" section in the public footer is enabled and visible.'
      : 'The "Experimental" section in the public footer is hidden from visitors.';
  }
  if (experimentalToggle) {
    experimentalToggle.classList.toggle('on', experimentalEnabled);
    experimentalToggle.setAttribute('aria-checked', String(experimentalEnabled));
  }
  if (sysExperimentalStatus) {
    sysExperimentalStatus.textContent = experimentalEnabled ? 'ENABLED' : 'DISABLED';
    sysExperimentalStatus.style.color = experimentalEnabled ? 'var(--green)' : '#ff6b62';
  }
}

async function loadExperimental(notifyOnError = false) {
  try {
    const response = await fetch(`${API_BASE}/experimental`, { cache: 'no-store', headers: { Accept: 'application/json' } });
    if (response.status === 401) { showLogin(); return false; }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Experimental endpoint unavailable.');
    renderExperimentalState(data?.experimental?.enabled ?? true);
    if (experimentalStore) {
      const durable = Boolean(data.durable);
      experimentalStore.textContent = durable ? 'STORE: DURABLE' : 'STORE: MEMORY ONLY';
      experimentalStore.style.color = durable ? 'var(--green)' : '#ff6b62';
    }
    return true;
  } catch (error) {
    if (notifyOnError) showToast(error.message || 'Could not load experimental status.', 'error');
    return false;
  }
}

async function toggleExperimental() {
  if (experimentalSaveInFlight) return;
  const targetState = !experimentalEnabled;
  experimentalSaveInFlight = true;
  renderExperimentalState(targetState);
  try {
    const response = await fetch(`${API_BASE}/experimental`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: targetState })
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      showLogin();
      throw new Error('Session expired. Sign in again.');
    }
    if (!response.ok || !data.success) throw new Error(data.error || 'Failed to update experimental status.');
    renderExperimentalState(data?.experimental?.enabled ?? targetState);
    if (experimentalStore) {
      const durable = Boolean(data.durable);
      experimentalStore.textContent = durable ? 'STORE: DURABLE' : 'STORE: MEMORY ONLY';
      experimentalStore.style.color = durable ? 'var(--green)' : '#ff6b62';
    }
    showToast(`Experimental section ${targetState ? 'enabled' : 'disabled'}.`, 'success');
  } catch (error) {
    renderExperimentalState(!targetState);
    showToast(error.message || 'Could not toggle experimental status.', 'error');
  } finally {
    experimentalSaveInFlight = false;
  }
}

experimentalToggle?.addEventListener('click', toggleExperimental);
experimentalRefreshBtn?.addEventListener('click', () => loadExperimental(true));

// ─────────────────────────────────────────────
// VISITOR TABLE
// ─────────────────────────────────────────────
function getFilteredVisitors() {
  const all = (currentStats && currentStats.visitors) ? [...currentStats.visitors] : [];
  const q = sessionsSearchQuery.trim().toLowerCase();
  let filtered = all;
  if (q) {
    filtered = all.filter(v => {
      const hay = [v.country, v.city, v.countryCode, v.browser, v.os, v.deviceType, v.page, v.id].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }
  filtered.sort((a,b) => (b.lastSeen - a.lastSeen));
  return filtered;
}
function renderSessionsPagination(total, page, pageSize, container) {
  if (!container) return;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) { container.innerHTML = ''; return; }
  let html = '';
  const prevDis = page <= 1 ? 'disabled' : '';
  const nextDis = page >= pages ? 'disabled' : '';
  html += `<button class="page-btn" data-page="${page-1}" ${prevDis}>‹</button>`;
  // show up to 7 page buttons windowed
  let start = Math.max(1, page - 3);
  let end = Math.min(pages, start + 6);
  if (end - start < 6) start = Math.max(1, end - 6);
  if (start > 1) { html += `<button class="page-btn" data-page="1">1</button>`; if (start > 2) html += `<span style="color:var(--dim);padding:0 4px">…</span>`; }
  for (let p=start; p<=end; p++) {
    html += `<button class="page-btn ${p===page?'active':''}" data-page="${p}">${p}</button>`;
  }
  if (end < pages) { if (end < pages-1) html += `<span style="color:var(--dim);padding:0 4px">…</span>`; html += `<button class="page-btn" data-page="${pages}">${pages}</button>`; }
  html += `<button class="page-btn" data-page="${page+1}" ${nextDis}>›</button>`;
  container.innerHTML = html;
  container.querySelectorAll('.page-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = Number(btn.dataset.page);
      if (!Number.isFinite(p) || p < 1 || p > pages) return;
      sessionsPage = p;
      updateVisitorTable(currentStats);
    });
  });
}
function updateSessionsGateMeta() {
  const total = (currentStats && currentStats.visitors) ? currentStats.visitors.length : 0;
  const now = serverNow();
  // Server-owned when the payload carries it; derived from the rows (with the
  // server's own deadline) only for an older payload that does not.
  const live = Number.isFinite(currentStats?.liveCount)
    ? currentStats.liveCount
    : (currentStats?.visitors || []).filter(v => rowLive(v, now)).length;
  if (sessionsCountPill) sessionsCountPill.textContent = `${live} live`;
  if (tabSessionsCount) {
    if (total) { tabSessionsCount.textContent = String(total); tabSessionsCount.hidden = false; }
    else tabSessionsCount.hidden = true;
  }
  if (openSessionsLabel) openSessionsLabel.textContent = sessionsGateOpen ? 'Refresh Sessions' : 'View Active Sessions';
  if (sessionsHint) {
    const q = sessionsSearchQuery ? ` · filtered` : '';
    sessionsHint.textContent = total ? `${live} on site · ${total} total${q} · paginated 50 per page` : 'Nobody on the site right now';
  }
  // keep meta bars updated when open
  return { total, live };
}
function updateVisitorTable(data) {
  if (!visitorTableBody || !data) return;
  // gated: don't render if closed
  if (!sessionsGateOpen) { updateSessionsGateMeta(); return; }
  // The server's clock: `lastSeen` and the two expiry deadlines are server
  // times, and the operator's machine may be skewed or in another timezone.
  const now = serverNow();
  const filtered = getFilteredVisitors();
  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / SESSIONS_PAGE_SIZE));
  if (sessionsPage > pages) sessionsPage = pages;
  if (sessionsPage < 1) sessionsPage = 1;
  const start = (sessionsPage - 1) * SESSIONS_PAGE_SIZE;
  const slice = filtered.slice(start, start + SESSIONS_PAGE_SIZE);

  if (!filtered.length) {
    if (sessionsSearchQuery) {
      visitorTableBody.innerHTML = `<tr><td colspan="7"><div class="empty-state">No sessions match “${escapeHtml(sessionsSearchQuery)}”.</div></td></tr>`;
    } else {
      renderEmptyVisitors();
    }
    if (sessionsMeta) sessionsMeta.textContent = '0 sessions';
    if (sessionsMetaBottom) sessionsMetaBottom.textContent = '0 sessions';
    renderSessionsPagination(0, 1, SESSIONS_PAGE_SIZE, sessionsPagination);
    renderSessionsPagination(0, 1, SESSIONS_PAGE_SIZE, sessionsPaginationBottom);
    updateSessionsGateMeta();
    return;
  }

  const existingRows = new Map();
  visitorTableBody.querySelectorAll('tr[data-key]').forEach(row => existingRows.set(row.dataset.key, row));
  const orderedRows = [];
  slice.forEach(visitor => {
    const key = String(visitor.id || visitor.lastSeen);
    const st = visitorStatus(visitor, now);
    // Country only, and only when the server could locate the visitor. No
    // address is ever sent to this page, so none can leak into a screenshot.
    const country = visitor.country || visitor.countryCode || null;
    const flag = visitor.countryCode ? getFlag(visitor.countryCode) : '🌐';
    const place = country ? (visitor.city ? `${visitor.city}, ${country}` : country) : '—';
    const placeTitle = visitor.city && country ? `${visitor.city}, ${country}` : '';
    const device = String(visitor.deviceType || '—');
    const deviceSlug = /^(mobile|tablet|desktop)$/i.test(device) ? device.toLowerCase() : 'unknown';
    const signature = JSON.stringify([place, visitor.countryCode, visitor.browser, visitor.os, device, visitor.page, st.slug]);
    let row = existingRows.get(key);
    if (!row) {
      row = document.createElement('tr');
      row.dataset.key = key;
      row.className = 'fade-in';
    }
    row.dataset.status = st.slug;
    if (row.dataset.signature !== signature) {
      row.dataset.signature = signature;
      row.innerHTML = `
        <td class="country" data-label="Location"${placeTitle ? ` title="${escapeHtml(placeTitle)}"` : ''}><span class="flag">${flag}</span>${escapeHtml(place)}</td>
        <td data-label="Browser">${escapeHtml(visitor.browser || '—')}</td>
        <td data-label="OS">${escapeHtml(visitor.os || '—')}</td>
        <td class="device-${deviceSlug}" data-label="Device">${escapeHtml(device)}</td>
        <td class="page-cell" data-label="Page" title="${escapeHtml(visitor.page || '/')}">${escapeHtml(visitor.page || '/')}</td>
        <td class="status-cell" data-label="Status">${statusPillHTML(visitor, now)}</td>
        <td class="timestamp-cell" data-label="Last Seen">${formatTimeAgo(visitor.lastSeen, now)}</td>`;
    } else {
      const timeCell = row.querySelector('.timestamp-cell');
      if (timeCell) timeCell.textContent = formatTimeAgo(visitor.lastSeen, now);
    }
    orderedRows.push(row);
  });

  const fragment = document.createDocumentFragment();
  orderedRows.forEach(row => fragment.appendChild(row));
  visitorTableBody.replaceChildren(fragment);

  const rangeText = `Showing ${start+1}–${Math.min(start+slice.length, total)} of ${total} sessions · page ${sessionsPage}/${pages}`;
  if (sessionsMeta) sessionsMeta.textContent = rangeText;
  if (sessionsMetaBottom) sessionsMetaBottom.textContent = rangeText;
  renderSessionsPagination(total, sessionsPage, SESSIONS_PAGE_SIZE, sessionsPagination);
  renderSessionsPagination(total, sessionsPage, SESSIONS_PAGE_SIZE, sessionsPaginationBottom);
  // The badge stays a server-owned number (updateStatCards / the presence push).
  // Counting it from the rows here made it disagree with the headline whenever a
  // row was in the last second of its window.
  // update outer meta pill
  updateSessionsGateMeta();
}

function renderEmptyVisitors() {
  visitorTableBody.innerHTML = `
    <tr id="visitorEmpty">
      <td colspan="7"><div class="empty-state">Waiting for visitor data…</div></td>
    </tr>`;
}

/* Two states, decided by the server's own deadline: on the site, or gone. The
   deadline is the exact moment the count loses them, so the table and the
   headline above it expire together — a row can never say "On site" beside a
   number that already dropped it. */
const rowLive = (visitor, now) => Number.isFinite(visitor.liveUntil)
  ? now < visitor.liveUntil
  : (visitor.live === undefined
    ? now - (Number(visitor.lastSeen) || 0) <= LIVE_WINDOW_MS
    : Boolean(visitor.live) && now - (Number(visitor.lastSeen) || 0) <= LIVE_WINDOW_MS);

function visitorStatus(visitor, now) {
  return rowLive(visitor, now)
    ? { slug: 'online', label: 'On site' }
    : { slug: 'offline', label: 'Gone' };
}
const statusPillHTML = (visitor, now) => {
  const st = visitorStatus(visitor, now);
  return `<span class="pill-sm status-pill pill-${st.slug}"><span class="dot-${st.slug}"></span>${st.label}</span>`;
};

/* Age from the server's clock, not the browser's: `lastSeen` is server time and
   the operator may be in another timezone (or have a skewed clock), which would
   otherwise make every row look seconds or hours old. */
const serverNow = () => Date.now() + serverClockOffsetMs;

/* Runs once a second: ages the "last seen" cells and flips a row that has
   expired out of its state. It deliberately does NOT recompute the headline
   numbers — those belong to the server (the `presence` push moves them the
   moment they change, and every full snapshot re-asserts them). Deriving them
   here from a payload the dashboard happens to be holding is what let a stale
   row disagree with the badge in the same screenshot. */
function refreshVisitorTimes() {
  if (!visitorTableBody || !currentStats?.visitors?.length) return;
  if (!sessionsGateOpen) {
    updateSessionsGateMeta();
    return;
  }
  const now = serverNow();
  const visitors = new Map(currentStats.visitors.map(visitor => [String(visitor.id || visitor.lastSeen), visitor]));
  visitorTableBody.querySelectorAll('tr[data-key]').forEach(row => {
    const visitor = visitors.get(row.dataset.key);
    if (!visitor) return;
    const cell = row.querySelector('.timestamp-cell');
    if (cell) cell.textContent = formatTimeAgo(visitor.lastSeen, now);
    const st = visitorStatus(visitor, now);
    if (row.dataset.status === st.slug) return;
    row.dataset.status = st.slug;
    const status = row.querySelector('.status-cell');
    if (status) status.innerHTML = statusPillHTML(visitor, now);
  });
  // Counts and pills are left to the server-owned numbers; only the rows and
  // the time cells move here.
  updateSessionsGateMeta();
}

/* Visitor rows are mutated in place and the table is repainted at most once
   per coalesce window. Every visitor heartbeat broadcasts an SSE event, so
   repainting synchronously meant one full sort + re-render per heartbeat per
   viewer — hundreds of DOM rebuilds a minute on a busy race weekend. */
let visitorIndex = new Map();
let visitorRenderTimer = null;
let visitorRenderPending = false;
const VISITOR_RENDER_COALESCE_MS = 250;
// Fallback window for a payload that carries no deadline: the server's PRESENCE_TTL_MS.
const LIVE_WINDOW_MS = 270_000;

function indexVisitors(visitors) {
  const index = new Map();
  for (const visitor of visitors || []) index.set(String(visitor.id), visitor);
  return index;
}

function scheduleVisitorRender() {
  if (!isAdmin) return;
  visitorRenderPending = true;
  // always keep badge/meta fresh even when gate closed or tab hidden
  updateSessionsGateMeta();
  if (!sessionsGateOpen) {
    // still update stat cards lightweight
    if (currentStats) updateStatCards(currentStats);
    // debounce meta only
    if (visitorRenderTimer) return;
    visitorRenderTimer = setTimeout(() => {
      visitorRenderTimer = null;
      visitorRenderPending = false;
      if (currentStats) updateStatCards(currentStats);
      updateSessionsGateMeta();
    }, VISITOR_RENDER_COALESCE_MS);
    return;
  }
  if (visitorRenderTimer) return;
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
  const key = String(visitor.id);
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

  currentStats.activeSessions = currentStats.visitors.length;
  // liveCount is deliberately NOT recalculated from the rows here. An
  // incrementally merged row is not the whole picture, and the server owns the
  // number: the `presence` push arrives with it on every change, and the next
  // full snapshot re-asserts it.
  // totalUnique is an all-time counter owned by the server — never derive it
  // from the number of rows currently on screen.
  scheduleVisitorRender();
}

function handleStreamStatusUpdate(data) {
  if (currentStats) currentStats.override = data;
  updateStreamStatus(data);
  if (currentStats) updateStatCards(currentStats);
}

// ── Sessions gate interactions
function openSessionsGate() {
  sessionsGateOpen = true;
  sessionsPage = 1;
  if (sessionsPanel) sessionsPanel.hidden = false;
  if (sessionsPanel) sessionsPanel.classList.add('active');
  // switch to sessions tab if not already there
  if (activeTab !== 'sessions') switchTab('sessions', true);
  /* Scroll the sessions SECTION into view, once the tab swap has finished.
     Two measurements drove this shape:
       · the old 60ms timer fired while the leaving view was still animating, so
         when that view was hidden ~240ms later the document got shorter and the
         scroll landed past the panel — at 430px the panel header ended up 129px
         above the viewport;
       · aligning the panel itself puts it flush against the viewport top, which
         is where the dashboard's fixed nav lives.
     The intro block sits directly above the panel, so aiming at it leaves the
     whole header (search, live badge, close) clear of the nav, and
     scroll-margin-top does the same job for the nav on every screen. The site's
     showView() uses this same wait-out-the-swap shape. */
  const motionOk = !document.documentElement.classList.contains('lite-motion');
  const target = document.querySelector('.sessions-intro') || sessionsPanel;
  setTimeout(() => target?.scrollIntoView({ behavior: motionOk ? 'smooth' : 'instant', block: 'start' }), 300 + 40);
  // immediate render
  if (currentStats) updateVisitorTable(currentStats);
  updateSessionsGateMeta();
}
function closeSessionsGate() {
  sessionsGateOpen = false;
  if (sessionsPanel) sessionsPanel.hidden = true;
  if (sessionsPanel) sessionsPanel.classList.remove('active');
  // keep counts but free DOM
  if (visitorTableBody) visitorTableBody.replaceChildren();
  renderEmptyVisitors();
  sessionsPage = 1;
  sessionsSearchQuery = '';
  if (sessionsSearch) sessionsSearch.value = '';
  updateSessionsGateMeta();
  showToast('Sessions view closed — table will stay idle until reopened.', 'info');
}
openSessionsBtn?.addEventListener('click', openSessionsGate);
closeSessionsBtn?.addEventListener('click', closeSessionsGate);
sessionsSearch?.addEventListener('input', () => {
  sessionsSearchQuery = sessionsSearch.value || '';
  sessionsPage = 1;
  if (sessionsGateOpen && currentStats) updateVisitorTable(currentStats);
  updateSessionsGateMeta();
});
sessionsModalBackdrop?.addEventListener('click', closeSessionsGate);
sessionsModalClose?.addEventListener('click', closeSessionsGate);


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
      data.active ? 'Maintenance mode enabled — the public site is now in the pits.' : 'Public website released — FreeF1 is live again.',
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
      showToast('Mode changed, but permanent storage is unavailable. Configure REDIS_URL before restarting Render.', 'warning');
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
  if (data.durable === false) showToast('Saved in memory only. Configure REDIS_URL to keep the override after a restart.', 'warning');
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

function formatTimeAgo(ts, now = Date.now()) {
  if (!ts) return '—';
  const diff = now - ts;
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
