#!/usr/bin/env node
'use strict';

/* Regression check for the Netlify preview auth bug:
   deploy-preview-<n>--freef1.netlify.app showed the "Unauthorized Access"
   overlay because both the client host check and the server verify call
   were exact-match only. Preview hosts of the same Netlify site are now
   first-party. This also proves foreign hosts are STILL locked out. */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const siteDir = process.env.SITE_DIR || path.resolve(__dirname, '..', '..', 'netlifyf1');

function boot(url) {
  const runtimeErrors = [];
  const requested = [];
  const dom = new JSDOM(fs.readFileSync(path.join(siteDir, 'index.html'), 'utf8'), {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url
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
  window.fetch = async (u) => {
    requested.push(String(u));
    const s = String(u);
    if (s.includes('/api/auth/verify')) return emptyJson({ authorized: false, error: 'Unauthorized' });
    if (s.includes('/api/stream/sources')) return emptyJson({ sources: [], disabled: [], updatedAt: 0 });
    if (s.includes('driverstandings')) return emptyJson({ MRData: { StandingsTable: { StandingsLists: [{ DriverStandings: [] }] } } });
    return emptyJson({});
  };
  Object.defineProperty(window.navigator, 'userActivation', { configurable: true, value: { hasBeenActive: false } });
  window.addEventListener('error', e => runtimeErrors.push(String(e.error || e.message)));
  return { window, requested, runtimeErrors, run: () => window.eval(fs.readFileSync(path.join(siteDir, 'app.js'), 'utf8')) };
}

(async () => {
  const checks = [];
  const check = (label, condition, detail = '') => checks.push({ label, pass: Boolean(condition), detail });

  // ── Case 1: Netlify deploy preview of the official site → must pass silently.
  {
    const env = boot('https://deploy-preview-2--freef1.netlify.app/');
    let bootError = null;
    try { env.run(); } catch (e) { bootError = e; }
    await new Promise(r => setTimeout(r, 250));
    check('preview host: app boots', !bootError, bootError && bootError.message);
    check('preview host: no runtime errors', env.runtimeErrors.length === 0, env.runtimeErrors.join(' | '));
    check('preview host: auth overlay never opens',
      !env.window.document.getElementById('authOverlay') ||
      !env.window.document.getElementById('authOverlay').classList.contains('open'));
    check('preview host: verify endpoint is not even called (host is first-party)',
      !env.requested.some(u => u.includes('/api/auth/verify')), env.requested.join(' '));
  }

  // ── Case 2: Netlify branch deploy of the official site → same trust.
  {
    const env = boot('https://feature-x--freef1.netlify.app/');
    try { env.run(); } catch (e) { /* captured below via overlay state */ }
    await new Promise(r => setTimeout(r, 250));
    const overlay = env.window.document.getElementById('authOverlay');
    check('branch deploy host: auth overlay never opens', !overlay || !overlay.classList.contains('open'));
  }

  // ── Case 3: foreign host → the lock must still hold.
  {
    const env = boot('https://evil.example.com/');
    try { env.run(); } catch (e) { /* ignore */ }
    await new Promise(r => setTimeout(r, 250));
    const overlay = env.window.document.getElementById('authOverlay');
    check('foreign host: verify endpoint IS consulted',
      env.requested.some(u => u.includes('/api/auth/verify')), env.requested.join(' '));
    check('foreign host: unauthorized overlay is shown',
      overlay && overlay.classList.contains('open'));
    check('foreign host: overlay shows the error reason',
      overlay && /Unauthorized/i.test(overlay.textContent));
  }

  let failed = 0;
  for (const c of checks) {
    if (!c.pass) failed++;
    console.log(` ${c.pass ? ' ok ' : 'FAIL'}   ${c.label}${c.pass ? '' : '  →  ' + c.detail}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
