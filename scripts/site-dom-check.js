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
});`);
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
