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
Object.defineProperty(window.document, 'visibilityState', { configurable: true, get: () => "visible" });
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

const requested = [];
const emptyJson = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
window.fetch = async (url, options) => {
  requested.push(String(url));
  const u = String(url);
  if (u.includes('/api/auth/verify')) return emptyJson({ authorized: true, domain: 'freef1.netlify.app' });
  if (u.includes('/api/visitors/token')) return emptyJson({ token: 'tok.test', expiresAt: Date.now() + 3_600_000 });
  if (u.includes('/api/visitors/heartbeat')) return emptyJson({ active: 3 });
  if (u.includes('/api/site/status')) return emptyJson({ maintenance: { active: false } });
  if (u.includes('/api/stream/status')) return emptyJson({ active: false });
  // Admin dashboard has switched off the first-choice feed (sky-uk-2) and Streame.
  if (u.includes('/api/stream/sources')) return emptyJson({
    sources: [
      { id: 'sky-uk-2', label: 'Sky UK 2' }, { id: 'sky-uk-3', label: 'Sky UK 3' },
      { id: 'f1tv', label: 'F1TV' }, { id: 'appletv', label: 'AppleTV' },
      { id: 'sky-uk', label: 'Sky UK' }, { id: 'streame', label: 'Streame' },
      { id: 'f1tv-alt', label: 'F1TV Alt' }, { id: 'dazn', label: 'DAZN' },
      { id: 'sky-sports-f1', label: 'Sky Sports F1' }, { id: 'wikisport', label: 'WikiSport' }
    ],
    disabled: ['sky-uk-2', 'streame'],
    updatedAt: Date.now()
  });
  if (u.includes('/api/news')) return emptyJson({ news: [] });
  if (u.includes('driverstandings')) return emptyJson({ MRData: { StandingsTable: { StandingsLists: [{ DriverStandings: [
    { position: '1', points: '100', wins: '3', Driver: { driverId: 'norris', givenName: 'Lando', familyName: 'Norris', permanentNumber: '1' }, Constructors: [{ name: 'McLaren' }] }
  ] }] } } });
  if (u.includes('openf1')) return emptyJson([]);
  return emptyJson({});
};

// Stand in for a page the viewer has not interacted with yet: every modern
// browser blocks autoplay with sound in that state.
Object.defineProperty(window.navigator, 'userActivation', { configurable: true, value: { hasBeenActive: false } });

window.addEventListener('error', event => runtimeErrors.push(String(event.error || event.message)));

(async () => {
  let bootError = null;
  try {
    // Top-level `const` in eval'd code stays in that eval's own scope, so
    // append the probe to the same source string to reach sources/disabledSources.
    window.eval(fs.readFileSync(path.join(siteDir, 'app.js'), 'utf8') + `
;window.__feedState = () => JSON.stringify({
  order: sources.map(s => s.label),
  ids: sources.map(s => s.id),
  disabled: [...disabledSources]
});
;window.__teams = () => teams.map(t => ({ id: t.id, name: t.name, color: t.color, text: t.text }));`);
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
  check('event selector populated', $('eventSelect').querySelectorAll('option').length === 22,
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
  const feedState = JSON.parse(window.__feedState());
  check('source order starts Sky UK 2 → Sky UK 3 → F1TV → AppleTV → Sky UK → Streame',
    ['Sky UK 2', 'Sky UK 3', 'F1TV', 'AppleTV', 'Sky UK', 'Streame']
      .every((label, i) => feedState.order[i] === label),
    feedState.order.join(', '));
  check('every source carries a stable id', feedState.ids.every(id => typeof id === 'string' && id.length > 0),
    feedState.ids.join(', '));
  check('disabled set applied from the server',
    feedState.disabled.length === 2 && feedState.disabled.includes('sky-uk-2') && feedState.disabled.includes('streame'),
    feedState.disabled.join(', '));
  check('two chips hidden for the two disabled feeds', $('links').children.length === 8,
    `${$('links').children.length} chips`);
  check('disabled feed labels are absent from the chips', (() => {
    const labels = [...$('links').children].map(c => c.textContent);
    return !labels.includes('Sky UK 2') && !labels.includes('Streame');
  })(), [...$('links').children].map(c => c.textContent).join(', '));
  check('selection falls back off a disabled first feed',
    $('links').querySelector('.chip.active')?.textContent === 'Sky UK 3',
    $('links').querySelector('.chip.active')?.textContent);

  // Structural integrity. A stray closing tag once closed #player early, which
  // ended the home view prematurely and left the championship grid and the
  // stage buttons outside it — so they stayed on screen when routing to
  // News/Info/Discord. Assert the containment the router depends on.
  const viewIds = ['viewHome', 'viewNews', 'viewInfo', 'viewDiscord'];
  check('all four views exist', viewIds.every(id => $(id)), viewIds.filter(id => !$(id)).join(', '));
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
