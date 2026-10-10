#!/usr/bin/env node
'use strict';

/* Headless smoke test for the public site (netlifyf1).
   Loads index.html + app.js in jsdom and asserts the app boots, renders the
   schedule/grid scaffolding, wires the router and never throws. Catches the
   class of bug where a DOM id or API the script relies on is missing. */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const siteDir = process.env.SITE_DIR || path.resolve(__dirname, '..', '..', 'netlifyf1');
const indexPath = path.join(siteDir, 'index.html');
if (!fs.existsSync(indexPath)) {
  console.error(`Site not found at ${indexPath}. Set SITE_DIR.`);
  process.exit(1);
}

const runtimeErrors = [];
const dom = new JSDOM(fs.readFileSync(indexPath, 'utf8'), {
  runScripts: 'outside-only',
  pretendToBeVisual: true, // provides requestAnimationFrame
  url: 'https://freef1.netlify.app/'
});
const { window } = dom;

// jsdom does not execute the inline <script> that releases the loading gate,
// so release it here to mirror what a browser does ~1.4s after boot.
window.document.documentElement.classList.remove('site-checking');
Object.defineProperty(window.document, 'hidden', { configurable: true, get: () => false });
Object.defineProperty(window.document, 'visibilityState', { configurable: true, get: () => 'visible' });
window.console = console;
window.matchMedia = query => ({ matches: false, media: query, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, onchange: null });
window.requestIdleCallback = cb => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 0);
window.scrollTo = () => {};
window.IntersectionObserver = class {
  constructor(cb) { this.cb = cb; }
  observe() {} unobserve() {} disconnect() {}
};
window.EventSource = class {
  constructor(url) { this.url = url; this.listeners = new Map(); }
  addEventListener(type, handler) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(handler); }
  close() {}
};
if (!window.crypto || !window.crypto.randomUUID) {
  Object.defineProperty(window, 'crypto', { configurable: true, value: { randomUUID: () => 'test-uuid-' + Math.random().toString(36).slice(2) } });
}

// Freeze clock to a session window so live stream player tests are deterministic
window.Date.now = () => Date.parse("2026-09-24T08:35:00Z");

const requested = [];

/* The production CSP (netlifyf1/_headers) is enforced here. A host that is not
   on this list is refused the way a browser refuses it: a thrown TypeError.
   That is how the direct api.openf1.org calls (blocked in production, and
   never reachable anyway — OpenF1 sends no CORS headers) were found; a stub
   that answers any URL containing "openf1" cannot see that class of bug. */
const CSP_HOSTS = new Set(['self', 'freef1.onrender.com', 'f1free.onrender.com', 'api.jolpi.ca']);
const blockedByCsp = [];

const emptyJson = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const heartbeatUrls = [];
const leaveCalls = [];
window.fetch = async (url, options) => {
  requested.push(String(url));
  const u = String(url);
  if (!u.startsWith('data:') && !u.startsWith('blob:')) {
    let host = 'self';
    try { host = new URL(u, 'https://freef1.netlify.app/').hostname; } catch (_) { host = 'self'; }
    if (!CSP_HOSTS.has(host)) {
      blockedByCsp.push(u);
      throw new TypeError(`Failed to fetch (blocked by Content-Security-Policy connect-src: ${host})`);
    }
  }
  if (u.includes('/api/auth/verify')) return emptyJson({ authorized: true, domain: 'freef1.netlify.app' });
  if (u.includes('/api/visitors/token')) return emptyJson({ token: 'tok.test', expiresAt: Date.now() + 3_600_000 });
  // One number, and the badge must show exactly it.
  if (u.includes('/api/visitors/heartbeat')) {
    heartbeatUrls.push(u);
    return emptyJson({ active: 9, at: Date.now() });
  }
  if (u.includes('/api/visitors/leave')) { leaveCalls.push(u); return { ok: true, status: 204, json: async () => ({}), text: async () => '' }; }
  if (u.includes('/api/site/status')) return emptyJson({ maintenance: { active: false } });
  if (u.includes('/api/stream/status')) return emptyJson({ active: false });
  if (u.includes('/api/experimental')) return emptyJson({ enabled: true, updatedAt: Date.now() });
  if (u.includes('/api/live/timing')) return emptyJson({ status: 'Live', currentLap: 14, totalLaps: 51, competitors: [] });
  // Admin dashboard has switched off the first-choice feed (sky-uk-2) and DAZN.
  if (u.includes('/api/stream/sources')) return emptyJson({
    sources: [
      { id: 'sky-uk-2', label: 'Sky UK 2' },
      { id: 'sky-uk', label: 'Sky UHD' },
      { id: 'f1tv', label: 'F1TV' },
      { id: 'sky-sports-f1', label: 'Sky Sports F1' },
      { id: 'appletv', label: 'AppleTV' },
      { id: 'dazn', label: 'DAZN' },
      { id: 'wikisport', label: 'WikiSport' }
    ],
    disabled: ['sky-uk-2', 'dazn'],
    updatedAt: Date.now()
  });
  if (u.includes('/api/news')) return emptyJson({ news: [] });
  if (u.includes('driverstandings')) return emptyJson({ MRData: { StandingsTable: { StandingsLists: [{ DriverStandings: [
    { position: '1', points: '100', wins: '3', Driver: { driverId: 'norris', givenName: 'Lando', familyName: 'Norris', permanentNumber: '1' }, Constructors: [{ name: 'McLaren' }] }
  ] }] } } });
  if (u.includes('openf1')) {
    // Mirrors the live payload shape: the app matches a round's race date to a
    // meeting's date_start, so hand it the two meetings that bracket the frozen
    // clock (2026-09-24T08:35Z): Baku (round 15, raced 26 Sep) and Monza.
    if (u.includes('/meetings')) return emptyJson([
      { meeting_key: 1293, meeting_name: 'Italian Grand Prix', date_start: '2026-09-04T11:30:00+00:00' },
      { meeting_key: 1295, meeting_name: 'Azerbaijan Grand Prix', date_start: '2026-09-24T08:00:00+00:00' }
    ]);
    if (u.includes('race_control')) return emptyJson([
      { date: '2026-09-24T08:20:00Z', category: 'SafetyCar', message: 'SAFETY CAR DEPLOYED', flag: null, lap_number: 12 },
      { date: '2026-09-24T08:24:00Z', category: 'Flag', message: 'TRACK CLEAR', flag: 'GREEN', lap_number: 14 }
    ]);
    return emptyJson([]);
  }
  return emptyJson({});
};

/* The beacon fired on pagehide is a navigator.sendBeacon call (the only request
   a browser reliably delivers while the page is being torn down). jsdom has no
   implementation, so capture the calls — the checks below prove it happens
   exactly once per page, with the identity in the query string. */
const beacons = [];
if (typeof window.navigator.sendBeacon !== 'function') {
  Object.defineProperty(window.navigator, 'sendBeacon', {
    configurable: true,
    value: (url) => { beacons.push(String(url)); return true; }
  });
}

/* EventSource: jsdom has none, so the live-count path used to be untestable here.
   A stub that records listeners lets the harness fire a real `presence` event at
   the app and assert the badge follows it — the same thing the server pushes. */
const sseInstances = [];
const FakeEventSource = class {
  constructor(url) {
    this.url = String(url);
    this.listeners = new Map();
    this.readyState = 1;
    sseInstances.push(this);
  }
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(fn);
  }
  removeEventListener(name, fn) {
    const list = this.listeners.get(name) || [];
    const i = list.indexOf(fn);
    if (i !== -1) list.splice(i, 1);
  }
  close() { this.readyState = 2; }
  emit(name, data) {
    for (const fn of this.listeners.get(name) || []) fn({ data: JSON.stringify(data), type: name });
  }
};
window.EventSource = FakeEventSource;

// Stand in for a page the viewer has not interacted with yet: every modern
// browser blocks autoplay with sound in that state.
Object.defineProperty(window.navigator, 'userActivation', { configurable: true, value: { hasBeenActive: false } });

window.addEventListener('error', event => runtimeErrors.push(String(event.error || event.message)));

(async () => {
  let bootError = null;
  try {
    // Top-level `const` in eval'd code stays in that eval's own scope, so
    // append the probe to the same source string to reach sources/disabledSources.
    // index.html loads round-meeting.js before app.js; mirror that order so the
    // harness exercises the same code path as a browser.
    window.eval(fs.readFileSync(path.join(siteDir, 'round-meeting.js'), 'utf8'));
    window.eval(fs.readFileSync(path.join(siteDir, 'app.js'), 'utf8') + `
;window.__feedState = () => JSON.stringify({
  order: sources.map(s => s.label),
  ids: sources.map(s => s.id),
  disabled: [...disabledSources]
});
;window.__teams = () => teams.map(t => ({ id: t.id, name: t.name, color: t.color, text: t.text }));
;window.schedule = schedule;
;window.isStreamAvailable = isStreamAvailable;
;window.getCurrentLiveSession = getCurrentLiveSession;
;window.applyStreamWindow = applyStreamWindow;
;window.load = load;
;window.store = store;
;window.__setSession = (evSlug, sessSlug) => {
  const ev = schedule.find(e => e.slug === evSlug);
  const sess = ev && ev.sessions.find(x => x.slug === sessSlug);
  if (!sess) return null;
  currentEvent = ev; currentSession = sess;
  return sess.slug;
};`);
  } catch (error) {
    bootError = error;
  }

  await new Promise(resolve => setTimeout(resolve, 500));
  const $ = id => window.document.getElementById(id);
  const checks = [];
  const check = (label, condition, detail = '') => checks.push({ label, pass: Boolean(condition), detail });

  check('app.js boots without throwing', !bootError, bootError && `${bootError.message}\n${bootError.stack}`);
  check('no window error events', runtimeErrors.length === 0, runtimeErrors.join(' | '));

  check('site gate released', !window.document.documentElement.classList.contains('site-checking'));
  check('event selector populated', $('eventSelect').querySelectorAll('option').length === 23,
    `${$('eventSelect').querySelectorAll('option').length} options`);
  check('session selector populated', $('sessionSelect').querySelectorAll('option').length > 0);
  check('feed source chips rendered', $('links').children.length > 0, `${$('links').children.length} chips`);
  check('ticker rendered', $('tickerTrack').children.length > 0);
  // The placeholder text is "Next: --:--:--"; once populated it reads
  // "<Grand Prix> <Session> · HH:MM:SS", or "Lights out!"/"No upcoming session".
  check('countdown rendered', /·|--:--:--|Lights out|No upcoming/.test($('countdown').textContent), $('countdown').textContent);
  // "Normal Stream" while a session is live, otherwise the no-live-session copy.
  check('override pill reflects live/no-live state', ['Normal Stream', 'No Live Session'].includes($('overridePill').textContent), $('overridePill').textContent);
  check('visitor heartbeat started', requested.some(u => u.includes('/api/visitors/token')), requested.join(' '));
  check('stream loader visible on boot', !$('loader').classList.contains('hidden'));

  // Feed sources: order + server-controlled availability
  check('feed source config is fetched', requested.some(u => u.includes('/api/stream/sources')), requested.join(' '));
  // app.js is loaded via window.eval, so its top-level const bindings live in
  // lexical scope rather than on window — read them back through eval.
  // If the boot threw, the probe never got defined: report that instead of
  // dying with "window.__feedState is not a function", which buried the real
  // error in a crash rather than a failed check.
  if (typeof window.__feedState !== 'function') {
    check('boot failure is reported instead of crashing the harness', false,
      `app.js did not finish loading: ${bootError ? bootError.message : 'no error captured'}`);
    const failed = checks.filter(c => !c.pass).length;
    for (const c of checks) console.log(`  ${c.pass ? 'ok  ' : 'FAIL'}  ${c.label}${c.pass || !c.detail ? '' : `  →  ${c.detail}`}`);
    console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
    process.exit(1);
  }
  const feedState = JSON.parse(window.__feedState());
  check('source order starts Sky Sports F1 → WeStream F1 → Sky UK 2 → Sky UHD → F1TV → AppleTV',
    ['Sky Sports F1', 'WeStream F1', 'Sky UK 2', 'Sky UHD', 'F1TV', 'AppleTV']
      .every((label, i) => feedState.order[i] === label),
    feedState.order.join(', '));
  check('every source carries a stable id', feedState.ids.every(id => typeof id === 'string' && id.length > 0),
    feedState.ids.join(', '));
  check('disabled set applied from the server',
    feedState.disabled.length === 2 && feedState.disabled.includes('sky-uk-2') && feedState.disabled.includes('dazn'),
    feedState.disabled.join(', '));
  check('two chips hidden for the two disabled feeds', $('links').children.length === 6,
    `${$('links').children.length} chips`);
  check('disabled feed labels are absent from the chips', (() => {
    const labels = [...$('links').children].map(c => c.textContent);
    return !labels.includes('Sky UK 2') && !labels.includes('DAZN');
  })(), [...$('links').children].map(c => c.textContent).join(', '));
  check('selection falls back off a disabled first feed',
    $('links').querySelector('.chip.active')?.textContent === 'Sky Sports F1',
    $('links').querySelector('.chip.active')?.textContent);

  // Structural integrity. A stray closing tag once closed #player early, which
  // ended the home view prematurely and left the championship grid and the
  // stage buttons outside it — so they stayed on screen when routing to
  // News/Info/Discord. Assert the containment the router depends on.
  const viewIds = ['viewHome', 'viewNews', 'viewInfo', 'viewDiscord', 'viewPerformance', 'view247'];
  check('all main views exist', viewIds.every(id => $(id)), viewIds.filter(id => !$(id)).join(', '));
  check('all four views are siblings',
    new Set(viewIds.map(id => $(id).parentElement)).size === 1,
    viewIds.map(id => `${id}<${$(id).parentElement?.tagName}>`).join(' '));
  check('championship grid lives inside the home view',
    $('viewHome').contains($('grid')) && $('viewHome').contains($('driverGrid')),
    `grid in home: ${$('viewHome').contains($('grid'))}`);
  check('stage action buttons live inside the home view', (() => {
    const btn = window.document.querySelector('.stage-actions #championshipBtn');
    return Boolean(btn) && $('viewHome').contains(btn);
  })());
  check('stream-start affordance is inside the player',
    $('player').contains($('streamStart')), `player children: ${$('player').children.length}`);
  check('player is inside the stage and the stage is inside the home view',
    $('player').parentElement?.classList.contains('stage') && $('viewHome').contains($('player')));
  check('hiding the home view hides the grid with it',
    !$('viewNews').contains($('grid')) && !$('viewInfo').contains($('grid')) && !$('viewDiscord').contains($('grid')));

  // Cross-browser playback. The providers' anti-sandbox detectors blank the
  // player when a sandbox attribute is present, so it must never come back.
  const probeFrame = window.makeStreamIframe('https://example.test/embed', undefined);
  const allowAttr = probeFrame.getAttribute('allow') || '';
  check('stream iframe carries no sandbox attribute', !probeFrame.hasAttribute('sandbox'),
    `sandbox="${probeFrame.getAttribute('sandbox')}"`);
  check('stream iframe grants autoplay and fullscreen',
    /\bautoplay\b/.test(allowAttr) && /\bfullscreen\b/.test(allowAttr), allowAttr);
  check('stream iframe delegates permissions to nested player frames',
    /autoplay \*/.test(allowAttr) && /fullscreen \*/.test(allowAttr), allowAttr);
  check('stream iframe allows encrypted media', /encrypted-media/.test(allowAttr), allowAttr);
  check('autoplay is reported as blocked before any interaction', window.pageHasActivation() === false);
  check('start affordance is offered only when playback is blocked', (() => {
    const el = $('streamStart');
    window.updateStreamStartAffordance(false); const offWhenNoFeed = el.hidden;
    window.updateStreamStartAffordance(true); const onWhenFeedIsUp = !el.hidden;
    return offWhenNoFeed && onWhenFeedIsUp;
  })());
  check('start button reloads the feed under a user gesture', (() => {
    const framesBefore = $('player').querySelectorAll('iframe').length;
    $('streamStartBtn').click();
    return $('player').querySelectorAll('iframe').length >= framesBefore &&
      $('loaderText').textContent === 'Establishing feed…' && $('streamStart').hidden;
  })(), `${$('loaderText').textContent} / hidden=${$('streamStart').hidden}`);
  check('video override sets inline playback attributes', (() => {
    const v = window.document.createElement('video');
    v.controls = true; v.autoplay = true; v.playsInline = true;
    v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', '');
    return v.playsInline === true && v.hasAttribute('webkit-playsinline');
  })());

  // Livery contrast. White text on a light livery (Haas #E6E6E6) was
  // invisible; every accent must now keep its ink above the 4.5:1 AA floor.
  const expandHex = hex => { const h = hex.slice(1); return h.length === 3 ? h.split('').map(x => x + x).join('') : h; };
  const lumOf = hex => { const n = parseInt(expandHex(hex), 16); return window.relLuminance((n >> 16) & 255, (n >> 8) & 255, n & 255); };
  const inks = window.__teams().map(t => {
    const ink = window.inkOn(t.color);
    return { name: t.name, color: t.color, ink, ratio: window.contrastRatio(lumOf(t.color), lumOf(ink)) };
  });
  const worst = inks.reduce((w, r) => (r.ratio < w.ratio ? r : w));
  check('every livery keeps its ink at 4.5:1 contrast or better', worst.ratio >= 4.5,
    `worst: ${worst.name} ${worst.color} -> ${worst.ink} at ${worst.ratio.toFixed(2)}:1`);
  check('Haas flips to dark ink on its white livery', window.inkOn('#E6E6E6') === '#000', window.inkOn('#E6E6E6'));
  check('Ferrari keeps white ink on its red livery', window.inkOn('#DC0000') === '#fff', window.inkOn('#DC0000'));
  check('light secondary liveries also flip to dark ink',
    window.inkOn('#B4A07A') === '#000' && window.inkOn('#6692FF') === '#000',
    `${window.inkOn('#B4A07A')} / ${window.inkOn('#6692FF')}`);
  // The hand-picked `text` values are not authoritative — they pick white for
  // Alpine, which is only 3.77:1. The computed choice must be at least as good.
  check('computed ink is never worse than the hand-picked text value',
    inks.every(({ name, color, ratio }) => {
      const t = window.__teams().find(x => x.name === name);
      const handPicked = t.text === '#000' ? '#000' : '#fff';
      return ratio >= window.contrastRatio(lumOf(color), lumOf(handPicked)) - 1e-9;
    }), inks.map(i => `${i.name}:${i.ink}@${i.ratio.toFixed(2)}`).join(' '));
  check('applying the Haas livery sets a dark --team-ink', (() => {
    window.applyTeamTheme('haas');
    const ink = window.document.documentElement.style.getPropertyValue('--team-ink').trim();
    const team = window.document.documentElement.style.getPropertyValue('--team').trim();
    window.applyTeamTheme('default');
    return ink === '#000' && team === '#E6E6E6';
  })());

  // Router: /news, /info, /discord views
  const click = el => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  click(window.document.querySelector('.nav-links a[data-route="news"]'));
  await new Promise(resolve => setTimeout(resolve, 400));
  check('router opens the news view', !$('viewNews').hidden && $('viewHome').hidden);
  click(window.document.querySelector('.nav-links a[data-route="info"]'));
  await new Promise(resolve => setTimeout(resolve, 400));
  check('router opens the info view', !$('viewInfo').hidden && $('viewNews').hidden);
  click(window.document.querySelector('.nav-links a[data-route="discord"]'));
  await new Promise(resolve => setTimeout(resolve, 400));
  check('router opens the discord view', !$('viewDiscord').hidden && $('viewInfo').hidden);

  const perfLink = window.document.querySelector('a[data-route="performance"]') || window.document.querySelector('a[data-route="track"]');
  if (perfLink) {
    click(perfLink);
    await new Promise(resolve => setTimeout(resolve, 400));
    check('router opens the performance view', !$('viewPerformance').hidden && $('viewDiscord').hidden);
    check('performance timing tower exists', Boolean($('perfTimingTower')), 'perfTimingTower missing');
    check('performance race control feed exists', Boolean($('perfRcFeed')), 'perfRcFeed missing');
    // Wait for the race-control fetch to settle, then assert it rendered rows
    // through the proxy rather than being silently blocked by the CSP.
    for (let i = 0; i < 20 && !$('perfRcFeed').querySelector('li, .rc-item, article'); i++) {
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    check('the round-meeting resolver is loaded and exported',
      typeof window.FreeF1RoundMeeting?.resolveMeetingKeyByDate === 'function', 'window.FreeF1RoundMeeting missing');
    check('race control is requested with the meeting matched to the round',
      requested.some(u => u.includes('race_control') && u.includes('meeting_key=1295')),
      `race_control requests: ${requested.filter(u => u.includes('race_control')).join(', ') || 'none'}`);
    check('all openf1 traffic stays inside the CSP allowlist',
      requested.filter(u => u.includes('openf1')).every(u => !u.includes('api.openf1.org')),
      requested.filter(u => u.includes('api.openf1.org')).join(', '));
    check('race control wire renders rows from the OpenF1 proxy',
      $('perfRcFeed').textContent.includes('SAFETY CAR DEPLOYED') || Boolean($('perfRcFeed').querySelector('li, .rc-item, article')),
      `content: ${$('perfRcFeed').textContent.trim().slice(0, 80)}`);
    check('no request leaves the CSP allowlist', blockedByCsp.length === 0,
      [...new Set(blockedByCsp)].join(' '));
  }

  const live247Link = window.document.querySelector('a[data-route="247"]');
  if (live247Link) {
    click(live247Link);
    await new Promise(resolve => setTimeout(resolve, 400));
    check('router opens the 24/7 view', !$('view247').hidden && $('viewPerformance').hidden);
    check('24/7 player wrap exists', Boolean($('live247FrameWrap')), 'live247FrameWrap missing');
    check('24/7 controls exist', Boolean($('live247PlayBtn') && $('live247StopBtn') && $('live247FsBtn')));
  }

  /* ── Force Live ────────────────────────────────────────────────────────
     Reported bug: the dashboard said FORCED LIVE while the player showed its
     "setting up the feed" placeholder with no iframe at all. Cause: the
     availability rule still required the session to have started, so a race
     weekend days away — exactly what the site shows between rounds — could
     never play. Reproduced here by putting a not-yet-started session on
     screen, which is what pickDefault() does before a race weekend. */
  {
    const future = (() => {
      for (const ev of window.schedule) {
        for (const sess of ev.sessions) {
          if (Date.parse(sess.start) - Date.now() > 3_600_000) return { ev, sess };
        }
      }
      return null;
    })();

    if (!future) {
      check('schedule contains a session that has not started yet', false, 'none found');
    } else {
      const onScreen = window.__setSession(future.ev.slug, future.sess.slug);
      check('a not-yet-started session can be put on screen for the test', onScreen === future.sess.slug);

      window.__FORCE_LIVE__ = false;
      window.applyStreamWindow({ active: false, reason: '', startedAt: null });
      window.load();
      await new Promise(resolve => setTimeout(resolve, 60));
      const withoutForce = Boolean(window.document.querySelector('#player iframe, #player video'));

      window.__FORCE_LIVE__ = true;
      window.applyStreamWindow({ active: true, reason: 'test', startedAt: Date.now() });
      window.load();
      await new Promise(resolve => setTimeout(resolve, 80));
      const withForce = Boolean(window.document.querySelector('#player iframe, #player video'));
      const liveNow = window.getCurrentLiveSession();

      check('a session that has not started stays off air without Force Live', withoutForce === false);
      check('Force Live puts the session on screen on air', withForce === true,
        `no player element for ${future.ev.slug}/${future.sess.slug}`);
      check('the live-session scan agrees with the player while forced',
        Boolean(liveNow && liveNow.session && liveNow.session.slug === future.sess.slug),
        `getCurrentLiveSession() → ${liveNow && liveNow.session && liveNow.session.slug}`);

      window.__FORCE_LIVE__ = false;
      window.applyStreamWindow({ active: false, reason: '', startedAt: null });
      // hand the on-screen session back to the harness's own live session
      const back = window.getCurrentLiveSession();
      if (back) window.__setSession(back.event.slug, back.session.slug);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }

  /* ── Visitor identity must survive a reload when localStorage is blocked ── */
  {
    const stubbed = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    const realLocal = window.localStorage, realSession = window.sessionStorage;
    Object.defineProperty(window, 'localStorage', { configurable: true, value: stubbed });
    try {
      window.store.set('probe_key', 'probe_value');
      const viaSession = window.store.get('probe_key');
      Object.defineProperty(window, 'sessionStorage', { configurable: true, value: stubbed });
      window.store.set('probe_key2', 'memory_value');
      const viaMemory = window.store.get('probe_key2');
      check('a blocked localStorage falls back instead of losing every key',
        viaSession === 'probe_value' && viaMemory === 'memory_value',
        `sessionStorage tier: ${viaSession}, memory tier: ${viaMemory}`);
    } finally {
      Object.defineProperty(window, 'localStorage', { configurable: true, value: realLocal });
      Object.defineProperty(window, 'sessionStorage', { configurable: true, value: realSession });
      delete window.store._m.probe_key; delete window.store._m.probe_key2;
    }
  }

  /* ── Presence: what the visitor counter counts, and how fast it moves ──
     One number: browsers on the site right now. These run against the real
     app.js in jsdom, so they fail if the client goes back to sending tab-state
     flags, or if the badge ever shows anything but the server's count. */
  {
    check('the heartbeat carries no tab-state flags — the count is one number',
      heartbeatUrls.length > 0 && heartbeatUrls.every(u => !/[?&](visible|watching|online)=/.test(u)),
      heartbeatUrls.slice(-2).join(' '));
    const badge = $('visitorCount');
    check('the badge shows the server count',
      badge && badge.textContent === '9',
      `badge=${badge && badge.textContent} (heartbeat payload said active=9)`);
    check('the badge tooltip says the same thing as the badge',
      /9 on site now/.test($('visitorCounter').getAttribute('title') || ''),
      $('visitorCounter').getAttribute('title') || '(no title)');

    // Hiding the tab stops the heartbeat: the server drops the browser at its
    // window, so the count follows the truth instead of a flag.
    const beforeHide = heartbeatUrls.length;
    Object.defineProperty(window.document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(window.document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    await new Promise(resolve => setTimeout(resolve, 120));
    check('hiding the tab stops the heartbeat', heartbeatUrls.length === beforeHide,
      heartbeatUrls.slice(beforeHide).join(' ') || 'no heartbeat was sent after the tab hid');

    // …and coming back beats immediately, so the number recovers at once.
    const beforeShow = heartbeatUrls.length;
    Object.defineProperty(window.document, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(window.document, 'visibilityState', { configurable: true, get: () => 'visible' });
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    await new Promise(resolve => setTimeout(resolve, 120));
    check('coming back beats immediately', heartbeatUrls.length > beforeShow,
      heartbeatUrls.slice(beforeShow).join(' ') || 'no heartbeat was sent after the tab returned');

    // The live path: the server pushes the count, the badge follows without
    // waiting for the next heartbeat.
    const sse = sseInstances.find(i => i.listeners.has('presence'));
    check('the client subscribes to the live presence event', Boolean(sse),
      sseInstances.length ? sseInstances.map(i => `${i.url}:${[...i.listeners.keys()].join(',')}`).join(' | ') : 'no EventSource was opened');
    if (sse) {
      sse.emit('presence', { active: 5, at: Date.now() });
      check('a pushed presence event updates the badge at once', badge.textContent === '5',
        `badge=${badge.textContent}`);
      check('the pushed event refreshes the tooltip too',
        /5 on site now/.test($('visitorCounter').getAttribute('title') || ''),
        $('visitorCounter').getAttribute('title') || '(no title)');
    }

    // Leaving: one beacon on pagehide — a closed tab must leave the count now.
    window.dispatchEvent(new window.Event('pagehide'));
    window.dispatchEvent(new window.Event('pagehide'));
    const leaveUrls = beacons.filter(u => u.includes('/api/visitors/leave'));
    check('closing the tab sends the goodbye beacon exactly once', leaveUrls.length === 1,
      `${leaveUrls.length} beacons: ${leaveUrls.join(' ')}`);
    check('the goodbye beacon carries the signed token in the query string',
      leaveUrls.length === 1 && /uid=/.test(leaveUrls[0]) && /token=tok\.test/.test(leaveUrls[0]),
      leaveUrls[0] || '(none)');

    // Back/forward cache: the page comes back alive, so the next goodbye counts.
    window.dispatchEvent(Object.assign(new window.Event('pageshow'), { persisted: true }));
    await new Promise(resolve => setTimeout(resolve, 30));
    window.dispatchEvent(new window.Event('pagehide'));
    check('a page restored from the bfcache can say goodbye again',
      beacons.filter(u => u.includes('/api/visitors/leave')).length === 2,
      `${beacons.filter(u => u.includes('/api/visitors/leave')).length} beacons`);
  }

  // escapeHtml hardening
  check('escapeHtml escapes quotes', (() => {
    const probe = window.document.createElement('div');
    probe.innerHTML = `<span title='x'>y</span>`;
    return typeof window.escapeHtml === 'function' ? window.escapeHtml(`'"><b>`) === '&#39;&quot;&gt;&lt;b&gt;' : null;
  })());

  let failed = 0;
  for (const { label, pass, detail } of checks) {
    if (!pass) failed++;
    console.log(`${pass ? '  ok  ' : ' FAIL '} ${label}${detail && !pass ? ` — ${detail}` : ''}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(error => { console.error(error); process.exit(1); });
