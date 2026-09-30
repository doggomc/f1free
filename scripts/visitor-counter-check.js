#!/usr/bin/env node
'use strict';

/* Client-side visitor counter check:
   - the count paints instantly from the cached value (no "--" while the API
     cold-starts)
   - a cached visitor token is reused (no token round trip before the count)
   - fresh counts are cached for the next visit */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const siteDir = process.env.SITE_DIR || path.resolve(__dirname, '..', '..', 'netlifyf1');

function boot({ seed = {} } = {}) {
  const runtimeErrors = [];
  const requested = [];
  const dom = new JSDOM(fs.readFileSync(path.join(siteDir, 'index.html'), 'utf8'), {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'https://freef1.netlify.app/'
  });
  const { window } = dom;
  window.document.documentElement.classList.remove('site-checking');
  Object.defineProperty(window.document, 'hidden', { configurable: true, get: () => false });
  Object.defineProperty(window.document, 'visibilityState', { configurable: true, get: () => 'visible' });
  window.console = console;
  window.matchMedia = q => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, onchange: null });
  window.requestIdleCallback = cb => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 0);
  window.scrollTo = () => {};
  window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.EventSource = class { addEventListener() {} close() {} };
  if (!window.crypto || !window.crypto.randomUUID) {
    Object.defineProperty(window, 'crypto', { configurable: true, value: { randomUUID: () => 'test-uuid' } });
  }
  const emptyJson = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  window.fetch = async (url) => {
    requested.push(String(url));
    const u = String(url);
    if (u.includes('/api/visitors/token')) return emptyJson({ token: 'tok.fresh', expiresAt: Date.now() + 3600e3 });
    if (u.includes('/api/visitors/heartbeat')) return emptyJson({ active: 3 });
    if (u.includes('/api/stream/sources')) return emptyJson({ sources: [], disabled: [], updatedAt: 0 });
    if (u.includes('driverstandings')) return emptyJson({ MRData: { StandingsTable: { StandingsLists: [{ DriverStandings: [] }] } } });
    return emptyJson({});
  };
  Object.defineProperty(window.navigator, 'userActivation', { configurable: true, value: { hasBeenActive: false } });
  for (const [key, value] of Object.entries(seed)) window.localStorage.setItem(key, value);
  window.addEventListener('error', e => runtimeErrors.push(String(e.error || e.message)));
  return { window, requested, runtimeErrors, run: () => window.eval(fs.readFileSync(path.join(siteDir, 'app.js'), 'utf8')) };
}

(async () => {
  const checks = [];
  const check = (label, condition, detail = '') => checks.push({ label, pass: Boolean(condition), detail });

  // ── Returning visitor: cached count + cached token.
  {
    const env = boot({ seed: {
      freef1_user_id: 'user_cached',
      freef1_active_count: '42',
      freef1_visitor_token: JSON.stringify({ token: 'tok.cached', expiresAt: Date.now() + 3600e3 })
    } });
    let bootError = null;
    try { env.run(); } catch (e) { bootError = e; }
    const countEl = () => env.window.document.getElementById('visitorCount');
    check('returning visitor: app boots', !bootError, bootError && bootError.message);
    check('count paints instantly from cache (before any network settles)', countEl().textContent === '42', countEl().textContent);
    await new Promise(r => setTimeout(r, 120));
    check('cached token is reused (no token round trip)',
      !env.requested.some(u => u.includes('/api/visitors/token')), env.requested.join(' '));
    check('heartbeat still runs', env.requested.some(u => u.includes('/api/visitors/heartbeat')));
    check('fresh count replaces the cache paint', countEl().textContent === '3', countEl().textContent);
    check('fresh count is cached for the next visit', env.window.localStorage.getItem('freef1_active_count') === '3');
    check('no runtime errors', env.runtimeErrors.length === 0, env.runtimeErrors.join(' | '));
  }

  // ── First visit: no cache — token + heartbeat, count appears after response.
  {
    const env = boot();
    try { env.run(); } catch (e) { /* captured below */ }
    const countEl = () => env.window.document.getElementById('visitorCount');
    check('first visit: placeholder before data arrives', countEl().textContent === '--', countEl().textContent);
    await new Promise(r => setTimeout(r, 120));
    check('first visit: token then heartbeat', env.requested.some(u => u.includes('/api/visitors/token')) &&
      env.requested.some(u => u.includes('/api/visitors/heartbeat')));
    check('first visit: count shows after the response', countEl().textContent === '3', countEl().textContent);
  }

  let failed = 0;
  for (const c of checks) {
    if (!c.pass) failed++;
    console.log(` ${c.pass ? ' ok ' : 'FAIL'}   ${c.label}${c.pass ? '' : '  →  ' + c.detail}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
