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
  url: 'http://127.0.0.1:3000/admin',
  pretendToBeVisual: true // provides requestAnimationFrame, used by tab switches
});
const { window } = dom;

// Minimal browser surfaces the dashboard touches but jsdom does not implement.
window.matchMedia = window.matchMedia || (query => ({ matches: false, media: query, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
window.Element.prototype.scrollIntoView = window.Element.prototype.scrollIntoView || function scrollIntoView() {};
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
  { id: 'sky-uk-2', label: 'Sky UK 2' },
  { id: 'sky-uk', label: 'Sky UHD' },
  { id: 'f1tv', label: 'F1TV' },
  { id: 'sky-sports-f1', label: 'Sky Sports F1' },
  { id: 'appletv', label: 'AppleTV' },
  { id: 'dazn', label: 'DAZN' },
  { id: 'wikisport', label: 'WikiSport' }
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
  if (pathname.endsWith('/admin/api/experimental')) {
    if (String(options.method || 'GET').toUpperCase() === 'POST') {
      const body = JSON.parse(options.body || '{}');
      return json({ success: true, experimental: { enabled: Boolean(body.enabled), updatedAt: Date.now() }, durable: true });
    }
    return json({ success: true, experimental: { enabled: true, updatedAt: Date.now() }, durable: true });
  }
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
  /* Eleven sessions, exactly as the server sends them: one row per live
     browser, each with the moment it stops counting (`liveUntil`). Expired
     browsers are not in the payload at all — the server drops them from the
     count and the rows together — so a table that shows more rows than the
     headline has gone back to inventing people. Two rows have no country
     (the server could not locate them) and must render as a dash. */
  const visitors = Array.from({ length: 11 }, (_, i) => ({
    id: `user_${i}`,
    // Country only, and only when the server could locate the visitor: rows 0-1
    // come back empty, like the live dashboard shows them.
    country: i < 2 ? null : (i % 2 ? 'South Africa' : 'United Kingdom'),
    city: i < 2 ? null : (i % 2 ? 'Pretoria' : 'London'),
    countryCode: i < 2 ? null : (i % 2 ? 'ZA' : 'GB'),
    // The server sends the moment a browser stops counting, not just a boolean:
    // the dashboard ages rows between polls and must expire them at the same
    // instant the count does. Generous here so a row cannot age out mid-test.
    live: true,
    liveUntil: now + 60 * 60_000,
    browser: 'Chrome 141',
    os: i % 3 ? 'Windows 11' : 'macOS 15.3',
    deviceType: i % 4 ? 'Desktop' : 'Mobile',
    page: i % 3 ? '/' : '/news',
    connectedAt: now - (i + 1) * 60_000,
    lastSeen: now - (i % 5) * 7_000,
    source: 'heartbeat'
  }));
  return {
    liveCount: visitors.length,
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
  .join('\n;\n')
  // The dashboard's own once-a-second pass, reachable from the harness. Waiting
  // for the real timer made these checks depend on how busy the machine is;
  // calling it proves the same thing without the race.
  + `\n;window.__tick = () => { refreshVisitorTimes(); };`;
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

  /* The sessions table is lazy: it stays empty until the operator opens the
     gate, so the dashboard is not rebuilding hundreds of rows for a panel
     nobody is looking at. Assert that state, then open it and assert the rows
     — the previous version of this check asserted rows straight from the
     initial snapshot and went red the moment the gate landed. */
  const click = el => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  check('sessions table idles until the gate is opened',
    $('visitorTableBody').querySelectorAll('tr[data-key]').length === 0 && $('openSessionsLabel').textContent === 'View Active Sessions',
    `${$('visitorTableBody').querySelectorAll('tr[data-key]').length} rows, label "${$('openSessionsLabel').textContent}"`);
  click($('openSessionsBtn'));
  await new Promise(resolve => setTimeout(resolve, 400));
  check('opening the gate renders the visitor rows', $('visitorTableBody').querySelectorAll('tr[data-key]').length === 11,
    `${$('visitorTableBody').querySelectorAll('tr[data-key]').length} rows`);
  /* One number, straight from the payload. */
  check('the headline shows the server count', $('onlineCount').textContent === '11',
    `headline=${$('onlineCount').textContent} (payload said liveCount=11)`);
  check('the caption says what the number counts',
    $('onlineBreakdown').textContent === 'browsers on the site', $('onlineBreakdown').textContent);
  const statuses = [...$('visitorTableBody').querySelectorAll('tr[data-key] .status-cell')].map(cell => cell.textContent.trim());
  const countOf = label => statuses.filter(t => t === label).length;
  check('every live row says On site', countOf('On site') === 11 && countOf('Gone') === 0,
    JSON.stringify(statuses));
  check('rows and the headline agree — no row contradicts the number above it',
    countOf('On site') === Number($('onlineCount').textContent),
    `${countOf('On site')} rows vs headline ${$('onlineCount').textContent}`);
  // The dashboard's own stylesheet must define the states it uses.
  const adminCss = require('fs').readFileSync(path.join(__dirname, '..', 'admin', 'admin.css'), 'utf8');
  check('the row states have real styling (pill + dot)',
    /\.pill-online\{/.test(adminCss) && /\.dot-online\{/.test(adminCss) &&
    /\.pill-offline\{/.test(adminCss) && /\.dot-offline\{/.test(adminCss),
    'pill/dot classes missing from admin.css');
  check('the table badge shows the same number', $('tableBadge').textContent === '● 11 on site',
    $('tableBadge').textContent);
  check('the sessions pill shows the same number', $('sessionsCountPill').textContent === '11 live',
    $('sessionsCountPill').textContent);
  check('the sessions caption shows the same number',
    /^11 on site · 11 total/.test($('sessionsHint').textContent), $('sessionsHint').textContent);
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
  check('visitor counts row shows on site and unique',
    /^11 on site \/ 4821 unique$/.test($('sysVisitorStore').textContent), $('sysVisitorStore').textContent);

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
  /* The count is pushed, not polled: the server sends a `presence` event the
     moment somebody arrives or leaves. Emitting one here proves the badge
     follows it without waiting for a refresh. */
  {
    const es0 = window.EventSource.instances[0];
    const before = $('onlineCount').textContent;
    es0.emit('presence', { active: 9, at: Date.now() });
    check('a pushed presence event moves the headline immediately',
      $('onlineCount').textContent === '9' && before !== '9',
      `before=${before} after=${$('onlineCount').textContent}`);
    check('the pushed event updates the table badge',
      $('tableBadge').textContent === '● 9 on site', $('tableBadge').textContent);
    // The push is the freshest truth there is. If the 1s ticker recomputes the
    // count from the snapshot it is still holding (which the push deliberately
    // does not touch), it silently undoes the live update a second later.
    window.__tick();
    check('the ticker does not undo a pushed count',
      $('onlineCount').textContent === '9' && $('tableBadge').textContent === '● 9 on site',
      `${$('onlineCount').textContent} / ${$('tableBadge').textContent} after a ticker pass`);
    // …and the poll that follows still wins, so the pushed number is never stale
    es0.emit('stats', snapshot);
    check('the periodic stats refresh re-asserts the server numbers',
      $('onlineCount').textContent === '11',
      `headline=${$('onlineCount').textContent}`);
  }

  const es = window.EventSource.instances[0];

  /* The screenshot bug, one model later: a row must never keep saying "On
     site" after its deadline, because the dashboard trusted a `live: true`
     from the last poll instead of the moment the server said it expires. Two
     cases: a deadline that has already passed when the payload arrives (the
     stale snapshot), and a deadline that passes while the dashboard is aging
     rows between polls (the screenshot). */
  {
    const now = Date.now();
    const base = { ...snapshot.visitors[0], lastSeen: now - 45_000 };
    const expired = { ...base, id: 'stale_expired', live: false, liveUntil: now - 55_000 };
    const aging = { ...base, id: 'stale_aging', lastSeen: now - 5_000, live: true, liveUntil: now + 900 };
    const payload = { ...snapshot, liveCount: 2, visitors: [expired, aging],
      server: { ...snapshot.server, now: Date.now() } };

    es.emit('stats', payload);
    const pills = () => [...$('visitorTableBody').querySelectorAll('tr[data-key] .status-cell')].map(c => c.textContent.trim());
    check('a payload whose deadline has already passed renders as Gone',
      pills().includes('Gone'), JSON.stringify(pills()));
    // The second row is still inside its window at this instant, so this proves
    // the flip below is the deadline expiring and not a render that never
    // marked the row as live in the first place.
    check('a row still inside its window says On site at this instant',
      pills().filter(t => t === 'On site').length === 1, JSON.stringify(pills()));
    check('the headline keeps the payload number instead of the table\'s own count',
      $('onlineCount').textContent === '2', $('onlineCount').textContent);
    check('the badge keeps the payload number too', $('tableBadge').textContent === '● 2 on site',
      $('tableBadge').textContent);

    // The row is still inside its window; age past it and run the dashboard's
    // own once-a-second pass, which is what flips it in production.
    await new Promise(resolve => setTimeout(resolve, 1000));
    window.__tick();
    check('a row whose deadline passes between polls stops saying On site',
      pills().filter(t => t === 'On site').length === 0, JSON.stringify(pills()));
    check('and the count it belongs to did not drift while that happened',
      $('onlineCount').textContent === '2' && $('tableBadge').textContent === '● 2 on site',
      `${$('onlineCount').textContent} / ${$('tableBadge').textContent}`);

    es.emit('stats', snapshot);
    es.emit('presence', { active: 11, at: Date.now() });
  }

  /* Rows on screen are not the population. The table is paginated and
     searchable, so "how many rows are watching" is routinely a different number
     from "how many people are watching" — the headline and badge must stay the
     server's numbers while the operator has filtered the list down. This is
     also what makes the two count-derived-from-rows bugs visible: with no
     filter the rows happen to agree, which is exactly how they hid. */
  {
    const search = $('sessionsSearch');
    search.value = 'user_3';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 400));
    const shown = $('visitorTableBody').querySelectorAll('tr[data-key]').length;
    check('the search narrows the table to one row for this check', shown === 1,
      `${shown} rows visible for "user_3"`);
    es.emit('stats', snapshot);                       // liveCount: 11, one row on screen
    check('the headline stays the server count while the table is filtered',
      $('onlineCount').textContent === '11', $('onlineCount').textContent);
    check('the badge stays the server count while the table is filtered',
      $('tableBadge').textContent === '● 11 on site', $('tableBadge').textContent);
    window.__tick();
    check('the ticker does not re-derive the count from the filtered rows',
      $('onlineCount').textContent === '11' && $('tableBadge').textContent === '● 11 on site',
      `${$('onlineCount').textContent} / ${$('tableBadge').textContent}`);
    search.value = '';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 300));
    es.emit('stats', snapshot);
  }

  /* No address, anywhere, ever. The payload cannot carry one and the table has
     no column and no cell for one — this asserts the whole rendered dashboard,
     not just the table body. */
  {
    const rows = [...$('visitorTableBody').querySelectorAll('tr[data-key]')];
    check('the table has no IP column',
      ![...$('visitorTableBody').closest('table').querySelectorAll('th')].some(th => /ip|address/i.test(th.textContent)),
      [...$('visitorTableBody').closest('table').querySelectorAll('th')].map(th => th.textContent).join(' | '));
    check('no cell anywhere in the table renders an IP address',
      !rows.some(r => /(\d{1,3}\.){3}\d{1,3}/.test(r.textContent)),
      rows.slice(0, 3).map(r => r.textContent.trim().slice(0, 60)).join(' || '));
    check('the whole dashboard DOM contains no address and no "private network" label',
      !/(\d{1,3}\.){3}\d{1,3}/.test(window.document.body.textContent) && !/private network/i.test(window.document.body.textContent),
      'an address or the old private-network label is somewhere on the page');
    check('a viewer the server could not locate shows a dash, not a guess',
      [...$('visitorTableBody').querySelectorAll('tr[data-key] .country')].filter(c => c.textContent.trim().endsWith('—')).length === 2,
      [...$('visitorTableBody').querySelectorAll('tr[data-key] .country')].slice(0, 4).map(c => JSON.stringify(c.textContent.trim())).join(' | '));
    check('a located viewer shows city and country',
      [...$('visitorTableBody').querySelectorAll('tr[data-key] .country')].some(c => /Pretoria, South Africa/.test(c.textContent)),
      [...$('visitorTableBody').querySelectorAll('tr[data-key] .country')].slice(0, 4).map(c => c.textContent.trim()).join(' | '));
  }

  check('admin SSE connected', Boolean(es));
  es.emit('open', {});
  await new Promise(resolve => setTimeout(resolve, 50));
  check('connection bar filled after SSE open', $('connBarFill').style.width === '100%', $('connBarFill').style.width);
  // The gate is open from check 2, so visitor_update bursts are painted here.
  const paintBefore = $('visitorTableBody').querySelectorAll('tr[data-key]').length;
  for (let i = 0; i < 40; i++) {
    es.emit('visitor_update', { type: 'heartbeat', visitor: { ...snapshot.visitors[0], id: `burst_${i}` } });
  }
  const immediate = $('visitorTableBody').querySelectorAll('tr[data-key]').length;
  check('40 heartbeats do not repaint synchronously', immediate === paintBefore, `${paintBefore} -> ${immediate}`);
  await new Promise(resolve => setTimeout(resolve, 500));
  const settled = $('visitorTableBody').querySelectorAll('tr[data-key]').length;
  // The table paginates 50 per page, so the page is filled rather than grown
  // without limit — the queued visitors are still all counted.
  const pageSize = 50;
  check('coalesced repaint applies the queued visitors',
    settled === Math.min(pageSize, paintBefore + 40), `${paintBefore} -> ${settled}`);
  check('queued visitors are counted past the first page',
    new RegExp(`of ${paintBefore + 40} sessions`).test($('sessionsMeta').textContent), $('sessionsMeta').textContent);
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
  check('feed source list rendered', rows().length === 7, `${rows().length} rows`);
  check('feed sources fetched on load', fetchCalls.some(u => u.includes('/admin/api/stream/sources')), fetchCalls.join(' '));
  check('disabled feed is marked off', rowFor('sky-uk-2').classList.contains('is-off') && rowFor('sky-uk-2').querySelector('.source-state').textContent === 'Hidden');
  check('enabled feed is marked live', !rowFor('f1tv').classList.contains('is-off') && rowFor('f1tv').querySelector('.source-state').textContent === 'Live');
  check('badge counts the enabled feeds', $('sourcesBadge').textContent === '6/7 Enabled', $('sourcesBadge').textContent);
  check('durable store is reported', $('sourcesStore').textContent.includes('DURABLE'), $('sourcesStore').textContent);

  rowFor('f1tv').querySelector('.source-switch').click();
  await new Promise(resolve => setTimeout(resolve, 250));
  check('toggling a feed posts the new disabled set',
    JSON.stringify(sourcePosts[0]) === JSON.stringify(['sky-uk-2', 'f1tv']), JSON.stringify(sourcePosts));
  check('toggled feed turns off', rowFor('f1tv').classList.contains('is-off'));
  check('badge updates after the toggle', $('sourcesBadge').textContent === '5/7 Enabled', $('sourcesBadge').textContent);

  rowFor('sky-uk-2').querySelector('.source-switch').click();
  await new Promise(resolve => setTimeout(resolve, 250));
  check('toggling a feed back on posts the reduced set',
    JSON.stringify(sourcePosts[1]) === JSON.stringify(['f1tv']), JSON.stringify(sourcePosts));
  check('re-enabled feed turns live', !rowFor('sky-uk-2').classList.contains('is-off'));

  es.emit('sources_update', { sources: FEED_SOURCES, disabled: ['sky-sports-f1'] });
  await new Promise(resolve => setTimeout(resolve, 200));
  check('live sources_update re-renders the panel',
    rowFor('sky-sports-f1').classList.contains('is-off') && $('sourcesBadge').textContent === '6/7 Enabled', $('sourcesBadge').textContent);

  // 9. Experimental toggle: enable/disable experimental section
  check('experimental panel rendered', Boolean($('panel-experimental')));
  check('experimental toggle initial state is on', $('experimentalToggle').classList.contains('on'));
  $('experimentalToggle').click();
  await new Promise(resolve => setTimeout(resolve, 200));
  check('experimental toggle switches off', !$('experimentalToggle').classList.contains('on') && $('experimentalBadge').textContent === 'Disabled');

  es.emit('experimental_update', { enabled: true });
  await new Promise(resolve => setTimeout(resolve, 150));
  check('live experimental_update re-enables the panel', $('experimentalToggle').classList.contains('on') && $('experimentalBadge').textContent === 'Enabled');

  // Report.
  /* ── The dashboard reuses the site's sticky nav. The class that turns it
     opaque on scroll was styled in admin.css but never applied by any script,
     so page content scrolled straight through the bar. ── */
  {
    const nav = window.document.getElementById('adminNav');
    const scrolled = (y) => {
      Object.defineProperty(window, 'scrollY', { configurable: true, value: y });
      window.dispatchEvent(new window.Event('scroll'));
    };
    scrolled(0);
    await new Promise(resolve => setTimeout(resolve, 60));
    const atTop = nav.classList.contains('stuck');
    scrolled(400);
    await new Promise(resolve => setTimeout(resolve, 60));
    const onScroll = nav.classList.contains('stuck');
    check('the admin nav stays transparent at the top of the page', atTop === false);
    check('the admin nav gets .stuck once the page scrolls', onScroll === true,
      'nav never receives the class its stylesheet styles');
    scrolled(0);
    await new Promise(resolve => setTimeout(resolve, 60));
    check('the admin nav returns to transparent at the top', nav.classList.contains('stuck') === false);
  }

  /* ── The sessions panel header has to fit a phone. Its width used to be a
     style attribute on the search input, which no media query can override. ── */
  {
    const search = window.document.getElementById('sessionsSearch');
    const tools = window.document.querySelector('.panel-head-tools');
    const css = fs.readFileSync(path.join(adminDir, 'admin.css'), 'utf8');
    check('the sessions search input carries no hard-coded inline width',
      Boolean(search) && !(search.getAttribute('style') || '').includes('width'),
      `style attribute: ${search && search.getAttribute('style')}`);
    check('the panel head controls sit in a wrapper the stylesheet can reflow',
      Boolean(tools) && tools.contains(search));
    check('the stylesheet wraps the panel head on narrow screens',
      /@media\(max-width:640px\)[^}]*\{[\s\S]*\.panel-head\{flex-wrap:wrap/.test(css),
      'no 640px rule wrapping .panel-head');
    /* The site sets .btn{width:100%} at 640px (hero calls to action). The admin
       inherits it, so without an override the panel-header controls stretch —
       the sessions ✕ was measured at 316px wide on a 390px screen. */
    check('a full-width .btn rule still exists at the phone breakpoint',
      /\.btn\s*\{[^}]*width:\s*100%/.test(css),
      'site-parity .btn rule missing — panel-head override may now be unnecessary or misplaced');
    check('panel-head buttons keep their natural size on phones',
      /@media\(max-width:\s*640px\)[\s\S]{0,1500}?\.panel-head\s+\.btn\s*\{[^}]*width:\s*auto/.test(css),
      'no .panel-head .btn{width:auto} override at 640px: icon buttons stretch');
  }

  /* ── Opening the sessions panel scrolls it into view. Two things must hold:
     the scroll waits for the tab swap (scrolling during it landed the header
     above the viewport), and the stylesheet reserves room for the fixed nav. ── */
  {
    const js = fs.readFileSync(path.join(adminDir, 'admin.js'), 'utf8');
    const css = fs.readFileSync(path.join(adminDir, 'admin.css'), 'utf8');
    check('the sessions scroll happens after the tab swap',
      /setTimeout\(\(\) => target\?*\.scrollIntoView[^)]*\), 300 \+ 40\)/.test(js) || /scrollIntoView[\s\S]{0,80}300 \+ 40/.test(js),
      'the scroll fires while the view swap is still animating');
    check('the sessions scroll aims at the section, not the bare panel',
      /querySelector\('\.sessions-intro'\)/.test(js),
      'scrolling the panel itself parks its header under the fixed nav');
    check('the panel reserves room for the fixed nav when scrolled to',
      /#sessionsPanel[\s\S]{0,120}scroll-margin-top/.test(css),
      'no scroll-margin-top on #sessionsPanel');
  }

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
