#!/usr/bin/env node
'use strict';

/* Headless smoke test for the admin dashboard.
   Loads admin/index.html in jsdom, runs charts.js + analytics.js + admin.js
   against it, and drives the handlers with a realistic server snapshot.
   Catches the class of bug where admin.js queries an element id that the
   markup never defines (silently dead UI) and any runtime throw on the
   hot paths (SSE events, render coalescing, analytics render). */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const adminDir = path.join(root, 'admin');

const errors = [];

const dom = new JSDOM(fs.readFileSync(path.join(adminDir, 'index.html'), 'utf8'), {
  runScripts: 'outside-only',
  url: 'http://127.0.0.1:3000/admin'
});
const { window } = dom;

// Minimal browser surfaces the dashboard touches but jsdom does not implement.
window.matchMedia = window.matchMedia || (query => ({ matches: false, media: query, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
window.requestIdleCallback = cb => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 0);
window.EventSource = class EventSource {
  constructor(url) { this.url = url; this.listeners = new Map(); EventSource.instances.push(this); }
  addEventListener(type, handler) { (this.listeners.get(type) || this.listeners.set(type, []).get(type)).push(handler); }
  close() { this.closed = true; }
  emit(type, data) { for (const handler of this.listeners.get(type) || []) handler({ data: JSON.stringify(data) }); }
};
window.EventSource.instances = [];

// jsdom's addEventListener Map usage above needs the array to exist first.
const realAdd = window.EventSource.prototype.addEventListener;
window.EventSource.prototype.addEventListener = function (type, handler) {
  if (!this.listeners.has(type)) this.listeners.set(type, []);
  realAdd.call(this, type, handler);
};

if (process.env.FREEF1_DEBUG === '1') window.__FREEF1_DEBUG__ = true;
window.console = console; // surface dashboard logs in the Node console

// jsdom reports a prerender document, which would make the dashboard treat
// itself as hidden and skip every render path. Pretend the tab is visible.
Object.defineProperty(window.document, 'hidden', { configurable: true, get: () => false });
Object.defineProperty(window.document, 'visibilityState', { configurable: true, get: () => 'visible' });

const fetchCalls = [];
const sourcePosts = [];
const FEED_SOURCES = [
  { id: 'sky-uk-2', label: 'Sky UK 2' }, { id: 'sky-uk-3', label: 'Sky UK 3' },
  { id: 'f1tv', label: 'F1TV' }, { id: 'appletv', label: 'AppleTV' },
  { id: 'sky-uk', label: 'Sky UK' }, { id: 'streame', label: 'Streame' },
  { id: 'f1tv-alt', label: 'F1TV Alt' }, { id: 'dazn', label: 'DAZN' },
  { id: 'sky-sports-f1', label: 'Sky Sports F1' }, { id: 'wikisport', label: 'WikiSport' }
];
const snapshot = buildSnapshot();
const analyticsPayload = buildAnalytics();

window.fetch = async (url, options = {}) => {
  fetchCalls.push(String(url));
  const pathname = String(url).split('?')[0];
  const query = String(url).includes('?') ? String(url).split('?')[1] : '';
  if (pathname.endsWith('/admin/api/status')) return json({ authenticated: true, loginAt: Date.now() });
  if (pathname.endsWith('/admin/api/analytics')) return json(analyticsPayload);
  if (pathname.endsWith('/admin/api/news')) return json({ news: [], durable: true });
  if (pathname.endsWith('/admin/api/stream/sources')) {
    if (String(options.method || 'GET').toUpperCase() === 'POST') {
      const body = JSON.parse(options.body || '{}');
      sourcePosts.push(body.disabled || []);
      return json({ success: true, sources: FEED_SOURCES, disabled: body.disabled || [], updatedAt: Date.now(), durable: true });
    }
    return json({ sources: FEED_SOURCES, disabled: ['sky-uk-2'], updatedAt: Date.now(), durable: true });
  }
  if (pathname.endsWith('/admin/api/maintenance')) return json({ maintenance: snapshot.maintenance, durable: true });
  if (pathname.endsWith('/admin/api/visitors')) return json(snapshot);
  return json({ error: 'unexpected ' + url }, 404);
};

function json(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

function buildSnapshot() {
  const now = Date.now();
  const visitors = Array.from({ length: 12 }, (_, i) => ({
    id: `user_${i}`,
    ip: `41.180.${i}.${10 + i}`,
    country: i % 2 ? 'South Africa' : 'United Kingdom',
    city: i % 2 ? 'Pretoria' : 'London',
    countryCode: i % 2 ? 'ZA' : 'GB',
    browser: 'Chrome 141',
    os: i % 3 ? 'Windows 11' : 'macOS 15.3',
    deviceType: i % 4 ? 'Desktop' : 'Mobile',
    page: i % 3 ? '/' : '/news',
    connectedAt: now - (i + 1) * 60_000,
    lastSeen: now - i * 7_000,
    online: true,
    source: 'heartbeat'
  }));
  return {
    onlineCount: visitors.length,
    activeSessions: visitors.length,
    totalUnique: 4821,
    visitors,
    override: { active: false },
    maintenance: { active: false, message: "We'll be back before the race.", eta: 'Before lights out', startedAt: null, updatedAt: null },
    server: {
      startedAt: now - 3 * 86_400_000 - 4 * 3_600_000,
      uptimeMs: 3 * 86_400_000 + 4 * 3_600_000,
      now,
      timezone: 'UTC',
      nodeEnv: 'production',
      uniqueVisitorStore: 'upstash',
      maintenanceStore: 'upstash',
      newsStore: 'upstash',
      analyticsStore: 'upstash'
    }
  };
}

function buildAnalytics() {
  const now = Date.now();
  const hour = Math.floor(now / 3_600_000) * 3_600_000;
  const bucket = i => ({
    t: hour - i * 3_600_000,
    sessions: 8 + (i % 5), ended: 6 + (i % 4), durationMs: (6 + (i % 4)) * 400_000,
    durHist: [2, 3, 2, 1, 1, 0], newVisitors: 5 + (i % 3), returning: 3 + (i % 2),
    pageViews: 20 + i, peakOnline: 9 + (i % 7), onlineSum: 480, onlineSamples: 60,
    device: { Desktop: 6, Mobile: 4 }, browser: { Chrome: 8, Safari: 2 },
    os: { Windows: 5, macOS: 3, Android: 2 }, country: { ZA: 5, GB: 3, US: 2 },
    pages: { '/': 9, '/news': 2 }, source: { F1TV: 6, 'Sky UK': 2 }, team: { ferrari: 3, mclaren: 2 },
    fullscreen: 2, nostream: 1, streamReady: 7, streamReadyMs: 22_400, streamTimeout: 1
  });
  const hourly = Array.from({ length: 168 }, (_, i) => bucket(i));
  return {
    generatedAt: now,
    since: now - 40 * 86_400_000,
    range: '7d',
    retention: { hourlyHours: 336, dailyDays: 90, liveMinutes: 1440 },
    store: 'upstash',
    serverStartedAt: now - 86_400_000,
    current: { online: 12, openSessions: 4, openSessionMs: 900_000 },
    live: Array.from({ length: 240 }, (_, i) => [hour - (240 - i) * 60_000, (i % 17) + 1]),
    hourly,
    daily: [{ d: '2026-09-12', t: hour, ...bucket(0) }],
    previous: bucket(200),
    overview: {
      heatmap: Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => ((d * 7 + h) % 11) + 0.5)),
      busiest: Array.from({ length: 8 }, (_, i) => ({
        t: hour - i * 3_600_000, peakOnline: 30 - i, onlineSum: 480, onlineSamples: 60,
        sessions: 12 - i, ended: 9, durationMs: 3_600_000, country: ['ZA', 'GB', 'US']
      }))
    }
  };
}

/* Run the three dashboard scripts in document order. They are concatenated
   into one script because top-level `const` in an indirect eval lands in a
   throwaway lexical scope — separate evals would not see `Charts`/`Analytics`,
   whereas real <script> tags share the global lexical scope. */
const dashboardSource = ['charts.js', 'analytics.js', 'admin.js']
  .map(file => `/* ${file} */\n${fs.readFileSync(path.join(adminDir, file), 'utf8')}`)
  .join('\n;\n');
try {
  window.eval(dashboardSource);
} catch (error) {
  errors.push(`dashboard scripts threw on load: ${error.message}\n${error.stack}`);
}

(async () => {
  await new Promise(resolve => setTimeout(resolve, 400));

  const $ = id => window.document.getElementById(id);
  const checks = [];
  const check = (label, condition, detail = '') => {
    checks.push({ label, pass: Boolean(condition), detail });
  };

  // 1. Every id admin.js/analytics.js queries must exist in the markup.
  const referencedIds = collectReferencedIds();
  const missing = referencedIds.filter(id => !$(id));
  check('all referenced element ids exist in index.html', missing.length === 0, missing.join(', '));

  // 2. Dashboard actually opened and rendered.
  check('dashboard is visible after auth', $('app').classList.contains('open'));
  check('visitor rows rendered', $('visitorTableBody').querySelectorAll('tr[data-key]').length === 12,
    `${$('visitorTableBody').querySelectorAll('tr[data-key]').length} rows`);
  check('online count rendered', $('onlineCount').textContent === '12', $('onlineCount').textContent);
  check('unique count is the server total (not the row count)', $('uniqueCount').textContent === '4821', $('uniqueCount').textContent);

  // 3. Server clock is server-derived, not the browser clock.
  const serverTime = $('serverTime').textContent;
  check('server time rendered', /^\d{2}:\d{2}:\d{2}$/.test(serverTime), serverTime);
  check('server time label carries the timezone', /UTC/.test($('serverTimeLabel').textContent), $('serverTimeLabel').textContent);
  const utcHour = Number(serverTime.slice(0, 2));
  const localHour = new Date().getUTCHours() === utcHour;
  check('server clock matches UTC, not the local clock', localHour, `${serverTime} vs UTC hour ${new Date().getUTCHours()}`);

  // 4. System panel is fully populated.
  check('environment row populated', $('sysNodeEnv').textContent === 'PRODUCTION', $('sysNodeEnv').textContent);
  check('unique store row populated', $('sysUniqueStore').textContent === 'UPSTASH', $('sysUniqueStore').textContent);
  check('visitor counts row populated', /12 active \/ 4821 unique/.test($('sysVisitorStore').textContent), $('sysVisitorStore').textContent);

  // 5. Analytics rendered from the range-scoped payload.
  check('analytics requested the selected range', fetchCalls.some(u => u.includes('/admin/api/analytics?range=7d')), fetchCalls.join(' '));
  check('analytics render produced no error', $('analyticsError').hidden, $('analyticsError').textContent);
  // 168 hourly buckets of (8 + i % 5) sessions = 1677.
  check('sessions KPI rendered', $('kSessionsVal').textContent === '1,677', $('kSessionsVal').textContent);
  check('concurrent-viewer chart drawn', $('chartLive').querySelector('svg'));
  check('heat-map drawn', $('chartHeat').querySelector('svg'));
  check('busiest-hours table drawn', $('busiestBody').querySelectorAll('tr').length === 8, `${$('busiestBody').querySelectorAll('tr').length} rows`);
  check('player-health tiles drawn', $('playerHealth').querySelectorAll('.health-item').length === 8);
  check('range buttons reflect the active range', $('analyticsRange').querySelector('[data-range="7d"]').classList.contains('active'));

  // 5b. Read/write batching. jsdom has no layout engine, so instead of timing
  //     forced reflows we assert the structural invariant: every clientWidth
  //     read in a render pass must happen BEFORE the first chart container is
  //     mutated. If a chart measured itself after clearing its subtree, reads
  //     would still be arriving after the first mutation.
  let layoutReads = 0;
  let readsAtFirstMutation = -1;
  const nativeClientWidth = Object.getOwnPropertyDescriptor(window.Element.prototype, 'clientWidth');
  Object.defineProperty(window.Element.prototype, 'clientWidth', {
    configurable: true,
    get() { layoutReads++; return nativeClientWidth.get.call(this); }
  });
  // Synchronous write probe: record the read count at the very first DOM write
  // of the pass. (A MutationObserver only fires after the pass, which would
  // make this check pass vacuously.)
  const nativeHTML = Object.getOwnPropertyDescriptor(window.Element.prototype, 'innerHTML');
  Object.defineProperty(window.Element.prototype, 'innerHTML', {
    configurable: true,
    get() { return nativeHTML.get.call(this); },
    set(value) {
      if (readsAtFirstMutation < 0) readsAtFirstMutation = layoutReads;
      nativeHTML.set.call(this, value);
    }
  });

  layoutReads = 0;
  readsAtFirstMutation = -1;
  // Analytics.render() is module-private; a resize triggers the same path.
  window.dispatchEvent(new window.Event('resize'));
  await new Promise(resolve => setTimeout(resolve, 400));
  Object.defineProperty(window.Element.prototype, 'innerHTML', nativeHTML);
  Object.defineProperty(window.Element.prototype, 'clientWidth', nativeClientWidth);

  const chartBodies = window.document.querySelectorAll('#analytics .chart-body').length;
  check('render pass read every chart container', layoutReads >= chartBodies, `${layoutReads} reads / ${chartBodies} containers`);
  check('all layout reads precede the first DOM write', readsAtFirstMutation === layoutReads,
    `${readsAtFirstMutation} reads before first mutation, ${layoutReads} total`);

  // 6. Visitor updates coalesce instead of repainting per event.
  const es = window.EventSource.instances[0];
  check('admin SSE connected', Boolean(es));
  es.emit('open', {});
  await new Promise(resolve => setTimeout(resolve, 50));
  check('connection bar filled after SSE open', $('connBarFill').style.width === '100%', $('connBarFill').style.width);
  const paintBefore = $('visitorTableBody').querySelectorAll('tr[data-key]').length;
  for (let i = 0; i < 40; i++) {
    es.emit('visitor_update', { type: 'heartbeat', visitor: { ...snapshot.visitors[0], id: `burst_${i}` } });
  }
  const immediate = $('visitorTableBody').querySelectorAll('tr[data-key]').length;
  check('40 heartbeats do not repaint synchronously', immediate === paintBefore, `${paintBefore} -> ${immediate}`);
  await new Promise(resolve => setTimeout(resolve, 500));
  const settled = $('visitorTableBody').querySelectorAll('tr[data-key]').length;
  check('coalesced repaint applies the queued visitors', settled === paintBefore + 40, `${paintBefore} -> ${settled}`);
  check('totalUnique untouched by visitor churn', $('uniqueCount').textContent === '4821', $('uniqueCount').textContent);

  // 7. Offline + override + maintenance events do not throw.
  es.emit('visitor_update', { type: 'offline', visitor: { id: 'burst_0' } });
  es.emit('stream_override', { active: true, url: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', type: 'youtube', startedAt: Date.now() });
  es.emit('maintenance_update', { active: true, message: 'Pit lane closed', eta: '14:30 SAST', startedAt: Date.now() });
  es.emit('news_update', { news: [{ id: 'news_1', title: 'Test', body: 'Body', tag: 'Race Control', published: true, createdAt: Date.now(), updatedAt: Date.now() }] });
  await new Promise(resolve => setTimeout(resolve, 400));
  check('override applied', $('overrideCount').textContent === 'ON' && $('streamPreview').querySelector('iframe'), $('overrideCount').textContent);
  check('maintenance applied', $('maintenanceCount').textContent === 'PIT', $('maintenanceCount').textContent);
  check('news rendered', $('adminNewsList').querySelectorAll('.admin-news-item').length === 1);

  // 8. Feed sources: server-owned availability with per-source toggles.
  const rows = () => [...$('sourceList').querySelectorAll('.source-row')];
  const rowFor = id => rows().find(r => r.querySelector('.source-id').textContent === id);
  check('feed source list rendered', rows().length === 10, `${rows().length} rows`);
  check('feed sources fetched on load', fetchCalls.some(u => u.includes('/admin/api/stream/sources')), fetchCalls.join(' '));
  check('disabled feed is marked off', rowFor('sky-uk-2').classList.contains('is-off') && rowFor('sky-uk-2').querySelector('.source-state').textContent === 'Hidden');
  check('enabled feed is marked live', !rowFor('f1tv').classList.contains('is-off') && rowFor('f1tv').querySelector('.source-state').textContent === 'Live');
  check('badge counts the enabled feeds', $('sourcesBadge').textContent === '9/10 Enabled', $('sourcesBadge').textContent);
  check('durable store is reported', $('sourcesStore').textContent.includes('DURABLE'), $('sourcesStore').textContent);

  rowFor('f1tv').querySelector('.source-switch').click();
  await new Promise(resolve => setTimeout(resolve, 250));
  check('toggling a feed posts the new disabled set',
    JSON.stringify(sourcePosts[0]) === JSON.stringify(['sky-uk-2', 'f1tv']), JSON.stringify(sourcePosts));
  check('toggled feed turns off', rowFor('f1tv').classList.contains('is-off'));
  check('badge updates after the toggle', $('sourcesBadge').textContent === '8/10 Enabled', $('sourcesBadge').textContent);

  rowFor('sky-uk-2').querySelector('.source-switch').click();
  await new Promise(resolve => setTimeout(resolve, 250));
  check('toggling a feed back on posts the reduced set',
    JSON.stringify(sourcePosts[1]) === JSON.stringify(['f1tv']), JSON.stringify(sourcePosts));
  check('re-enabled feed turns live', !rowFor('sky-uk-2').classList.contains('is-off'));

  es.emit('sources_update', { sources: FEED_SOURCES, disabled: ['dazn'] });
  await new Promise(resolve => setTimeout(resolve, 200));
  check('live sources_update re-renders the panel',
    rowFor('dazn').classList.contains('is-off') && $('sourcesBadge').textContent === '9/10 Enabled', $('sourcesBadge').textContent);

  // Report.
  let failed = 0;
  for (const { label, pass, detail } of checks) {
    if (!pass) failed++;
    console.log(`${pass ? '  ok  ' : ' FAIL '} ${label}${detail && !pass ? ` — ${detail}` : ''}`);
  }
  for (const error of errors) console.log(` FAIL  runtime: ${error}`);
  console.log(`\n${checks.length - failed}/${checks.length} checks passed${errors.length ? `, ${errors.length} runtime errors` : ''}`);
  process.exit(failed || errors.length ? 1 : 0);

  function collectReferencedIds() {
    const ids = new Set();
    for (const file of ['admin.js', 'analytics.js']) {
      const source = fs.readFileSync(path.join(adminDir, file), 'utf8');
      for (const match of source.matchAll(/\$\(['"]([^'"]+)['"]\)/g)) ids.add(match[1]);
      for (const match of source.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)) ids.add(match[1]);
    }
    // `visitorEmpty` is re-created by renderEmptyVisitors() on every clear, so
    // the reference captured at load time is intentionally disposable.
    ids.delete('visitorEmpty');
    return [...ids];
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
