#!/usr/bin/env node
'use strict';

/* Behavioral check for the redesigned Race Times modal:
   - Grand Prix selector lists only live-and-future weekends (finished are gone)
   - defaults to the current weekend, else the next upcoming one
   - rows: date badge / session name / start time
   - "My time" / "Track time" segmented toggle switches the zone (and persists)
   Clock is frozen at 2026-10-01T12:00Z: rounds 1–15 are finished, R16 (Oct 2–4)
   is the next weekend — deterministic regardless of when the test runs. */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const siteDir = process.env.SITE_DIR || path.resolve(__dirname, '..', '..', 'netlifyf1');
const runtimeErrors = [];
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
window.matchMedia = query => ({ matches: false, media: query, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, onchange: null });
window.requestIdleCallback = cb => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 0);
window.scrollTo = () => {};
window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
window.EventSource = class { addEventListener() {} close() {} };
if (!window.crypto || !window.crypto.randomUUID) {
  Object.defineProperty(window, 'crypto', { configurable: true, value: { randomUUID: () => 'test-uuid' } });
}
const emptyJson = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
window.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/api/stream/sources')) return emptyJson({ sources: [], disabled: [], updatedAt: 0 });
  if (u.includes('driverstandings')) return emptyJson({ MRData: { StandingsTable: { StandingsLists: [{ DriverStandings: [] }] } } });
  return emptyJson({});
};
Object.defineProperty(window.navigator, 'userActivation', { configurable: true, value: { hasBeenActive: false } });
window.Date.now = () => Date.parse('2026-10-01T12:00:00Z');
window.addEventListener('error', event => runtimeErrors.push(String(event.error || event.message)));

(async () => {
  let bootError = null;
  try {
    window.eval(fs.readFileSync(path.join(siteDir, 'app.js'), 'utf8'));
  } catch (error) {
    bootError = error;
  }
  await new Promise(resolve => setTimeout(resolve, 300));

  const $ = id => window.document.getElementById(id);
  const checks = [];
  const check = (label, condition, detail = '') => checks.push({ label, pass: Boolean(condition), detail });
  const click = el => el && el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

  check('app.js boots without throwing', !bootError, bootError && `${bootError.message}\n${bootError.stack}`);

  click($('raceTimesBtn'));
  await new Promise(resolve => setTimeout(resolve, 20));

  const overlay = $('raceTimesOverlay');
  const sel = $('raceTimesGp');
  check('modal opens from the Race Times button', overlay && overlay.classList.contains('open'));
  check('Grand Prix selector exists and is enabled', sel && !sel.disabled);

  const values = [...sel.options].map(o => o.value);
  check('finished rounds are not selectable', !values.includes('australia') && !values.includes('azerbaijan'), values.join(','));
  check('all 8 remaining weekends are listed', values.length === 8, `${values.length} options: ${values.join(',')}`);
  check('defaults to the next upcoming weekend (R16)', sel.value === 'bahrain', sel.value);

  let rows = [...$('raceTimesList').querySelectorAll('.rt-row')];
  check('one row per session (5 for the weekend)', rows.length === 5, String(rows.length));
  check('row shows the session name in the middle', rows[0] && rows[0].querySelector('.rt-name').textContent === 'Practice 1',
    rows[0] && rows[0].querySelector('.rt-name').textContent);
  check('date badge shows day + month', rows[0] && /^\d{2}$/.test(rows[0].querySelector('.rt-day').textContent) &&
    /^[A-Z]{3}$/.test(rows[0].querySelector('.rt-mon').textContent),
    rows[0] && rows[0].querySelector('.rt-date').textContent);
  check('time renders as HH:MM on the right', rows.every(r => /^\d{2}:\d{2}$/.test(r.querySelector('.rt-time').textContent)));

  check('My time is the default mode', $('raceTimesMode').querySelector('[data-time-mode="my"]').classList.contains('active'));
  check('note reports local timezone in My time', $('raceTimesTimezone').textContent.includes('local timezone'),
    $('raceTimesTimezone').textContent);

  // ── Track time: circuit zone for the selected weekend (R16 venue = Sepang).
  click($('raceTimesMode').querySelector('[data-time-mode="track"]'));
  check('Track time toggles the segment state',
    $('raceTimesMode').querySelector('[data-time-mode="track"]').classList.contains('active') &&
    !$('raceTimesMode').querySelector('[data-time-mode="my"]').classList.contains('active'));
  check('note reports the circuit timezone', $('raceTimesTimezone').textContent.includes('Asia/Kuala_Lumpur'),
    $('raceTimesTimezone').textContent);
  rows = [...$('raceTimesList').querySelectorAll('.rt-row')];
  check('rows still render in Track time', rows.length === 5 && rows.every(r => /^\d{2}:\d{2}$/.test(r.querySelector('.rt-time').textContent)));
  check('mode choice persists', window.localStorage.getItem('freef1_race_times_mode') === 'track');

  // ── Switching weekends: Abu Dhabi.
  sel.value = 'abudhabi';
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  check('switching GP re-renders the rows', $('raceTimesList').querySelectorAll('.rt-row').length === 5);
  check('note follows the selected circuit', $('raceTimesTimezone').textContent.includes('Asia/Dubai'),
    $('raceTimesTimezone').textContent);

  check('no runtime errors overall', runtimeErrors.length === 0, runtimeErrors.join(' | '));

  let failed = 0;
  for (const c of checks) {
    if (!c.pass) failed++;
    console.log(` ${c.pass ? ' ok ' : 'FAIL'}   ${c.label}${c.pass ? '' : '  →  ' + c.detail}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
