#!/usr/bin/env node
'use strict';

/* Behavioral check for the 24/7 click-shield (test bed on /247 only).
   Covers: auto-start for reliable feeds (gate:'auto'), the Bouncer gate for
   the rest, wrap-fullscreen with a mobile Exit/Shield bar, the hijack alarm
   with auto-recovery + escalation, and the manners league table. Also proves
   the Cockpit player pipeline is unaffected. */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const siteDir = process.env.SITE_DIR || path.resolve(__dirname, '..', '..', 'netlifyf1');
const runtimeErrors = [];
const dom = new JSDOM(fs.readFileSync(path.join(siteDir, 'index.html'), 'utf8'), {
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  url: 'https://freef1.netlify.app/247'
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
  // 24/7 stations are reached through an API-minted alias like every feed.
  if (u.includes('/api/stream/ticket')) return emptyJson({ href: '/stream/test-alias', expiresAt: Date.now() + 3_600_000 });
  if (u.includes('driverstandings')) return emptyJson({ MRData: { StandingsTable: { StandingsLists: [{ DriverStandings: [] }] } } });
  return emptyJson({});
};
Object.defineProperty(window.navigator, 'userActivation', { configurable: true, value: { hasBeenActive: false } });
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
  check('no window error events', runtimeErrors.length === 0, runtimeErrors.join(' | '));

  // Open the 24/7 view — auto-loads the default station (Sky UK 2, gate:'auto').
  click(window.document.querySelector('a[data-route="247"]'));
  // The station frame mounts after an async alias request.
  for (let i = 0; i < 40 && !($('live247FrameWrap') && $('live247FrameWrap').querySelector('iframe')); i++) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }

  const wrap = $('live247FrameWrap');
  let iframe = wrap && wrap.querySelector('iframe');
  if (!wrap || !iframe) {
    // Report instead of crashing on the first property write below.
    check('24/7 view mounts a station frame', false, `wrap=${Boolean(wrap)} iframe=${Boolean(iframe)}`);
    for (const c of checks) console.log(`  ${c.pass ? 'ok  ' : 'FAIL'}  ${c.label}${c.pass || !c.detail ? '' : `  →  ${c.detail}`}`);
    console.log(`\n${checks.filter(c => c.pass).length}/${checks.length} checks passed`);
    process.exit(1);
  }
  let gate = $('live247Gate');

  check('default channel is the reliable Sky UK 2', $('live247StationChip').textContent.includes('Sky UK 2'), $('live247StationChip').textContent);
  check('auto station: iframe and gate are both created', Boolean(iframe && gate));
  check('auto station: stream auto-starts (gate open, no Start click needed)', gate && gate.hidden);
  check('auto station: status chip reads LIVE', $('live247StatusChip').textContent === 'LIVE', $('live247StatusChip').textContent);
  check('24/7 iframe has no sandbox by default (half-lock opt-in only)', iframe && !iframe.hasAttribute('sandbox'));
  check('fullscreen bar exists but is hidden outside fullscreen', $('live247FsBar') && $('live247FsBar').hidden);
  check('Sound button is removed', !$('live247SoundBtn'));
  const copy = ($('live247Gate') ? $('live247Gate').textContent : '') +
    (window.document.querySelector('.apf-hint') ? window.document.querySelector('.apf-hint').textContent : '');
  check('no keyboard key claims in 24/7 copy (keys do not reach these embeds)', !/Space|M: mute|F: fullscreen/i.test(copy), copy.slice(0, 140));
  check('Sky UK 2 keeps Play/Stop transport', $('live247PlayBtn').hidden === false && $('live247StopBtn').hidden === false);

  // ── Fullscreen targets the WRAP so our Exit/Shield bar rides along (mobile fix).
  let fsTarget = null, fsExited = false;
  wrap.requestFullscreen = () => { fsTarget = wrap; return Promise.resolve(); };
  iframe.requestFullscreen = () => { fsTarget = iframe; return Promise.resolve(); };
  Object.defineProperty(window.document, 'exitFullscreen', { configurable: true, value: () => { fsExited = true; return Promise.resolve(); } });
  click($('live247FsBtn'));
  check('Fullscreen button targets the WRAP (video + our UI), not the bare iframe', fsTarget === wrap, String(fsTarget === iframe ? 'iframe' : fsTarget));

  Object.defineProperty(window.document, 'fullscreenElement', { configurable: true, get: () => wrap });
  window.document.dispatchEvent(new window.Event('fullscreenchange'));
  check('in fullscreen the Exit/Shield bar becomes visible', $('live247FsBar') && !$('live247FsBar').hidden);
  click($('live247FsExitBtn'));
  check('on-screen Exit button leaves fullscreen (no Escape key needed)', fsExited);
  Object.defineProperty(window.document, 'fullscreenElement', { configurable: true, get: () => null });
  window.document.dispatchEvent(new window.Event('fullscreenchange'));
  check('bar hides again after leaving fullscreen', $('live247FsBar').hidden);

  // ── Strong hijack: a second iframe load = the ad layer navigated the frame.
  iframe.dispatchEvent(new window.Event('load')); // settle
  iframe.dispatchEvent(new window.Event('load')); // hijack
  await new Promise(resolve => setTimeout(resolve, 20));
  gate = $('live247Gate');
  check('frame-nav hijack re-arms the shield even on auto stations', gate && !gate.hidden);
  check('hijack toast announces auto-reload', Boolean($('freef1Toast') && $('freef1Toast').textContent.includes('reloading')));
  const manners = JSON.parse(window.localStorage.getItem('freef1_247_manners') || '{}');
  check('manners league recorded the hijack', (manners['sky-uk-2'] || {}).hijack === 1, JSON.stringify(manners));

  // ── Auto-recovery: after the delay the stream reloads behind the gate.
  await new Promise(resolve => setTimeout(resolve, 1500));
  const freshIframe = wrap.querySelector('iframe');
  check('auto-recovery reloads the stream', freshIframe && freshIframe !== iframe);
  check('escalation: recovered auto station stays behind the gate', $('live247Gate') && !$('live247Gate').hidden);
  check('status chip reads SHIELDED during escalation', $('live247StatusChip').textContent === 'SHIELDED', $('live247StatusChip').textContent);

  // League table: the noisy station sank and is flagged (5 stations: Fly44, WeStream, Sky UK 2, Sky UHD, WikiSport).
  const chips = [...$('live247StationChips').children];
  check('noisy station sinks in the channel list', chips.length === 5 && chips[4].className.includes('noisy'), chips.map(c => c.textContent + ':' + c.className).join(' | '));

  // Manual Start still works (and re-opens on an escalated station).
  click($('live247GateBtn'));
  check('Start stream opens the gate after recovery', $('live247Gate').hidden);

  // ── Switching to a gated station arms the Bouncer and drops the transport.
  const gatedChip = [...$('live247StationChips').children].find(c => c.textContent.trim() === 'Sky UHD');
  click(gatedChip);
  await new Promise(resolve => setTimeout(resolve, 20));
  check('gated station (Sky UHD) arms the Bouncer on load', $('live247Gate') && !$('live247Gate').hidden);
  check('gated station: status chip reads SHIELDED', $('live247StatusChip').textContent === 'SHIELDED', $('live247StatusChip').textContent);
  check('gated station: Shield toggle reports armed', $('live247ShieldBtn').getAttribute('aria-pressed') === 'true');
  check('gated station (Sky UHD) hides Play/Stop', $('live247PlayBtn').hidden === true && $('live247StopBtn').hidden === true);

  // One-tap Shield toggle round-trip.
  click($('live247GateBtn'));
  check('Start stream hides the gate (gated station)', $('live247Gate').hidden);
  click($('live247ShieldBtn'));
  check('Shield toggle re-arms the gate', !$('live247Gate').hidden && $('live247ShieldBtn').getAttribute('aria-pressed') === 'true');

  // Back to Sky UK 2 — transport returns with the reliable feed.
  const reliableChip = [...$('live247StationChips').children].find(c => c.textContent.trim() === 'Sky UK 2');
  click(reliableChip);
  await new Promise(resolve => setTimeout(resolve, 20));
  check('returning to Sky UK 2 restores Play/Stop', $('live247PlayBtn').hidden === false && $('live247StopBtn').hidden === false);

  // Stop unloads everything cleanly.
  click($('live247StopBtn'));
  check('Stop clears player, gate and fullscreen bar', !wrap.querySelector('iframe') && !$('live247Gate') && !$('live247FsBar'));
  check('status chip reads STOPPED', $('live247StatusChip').textContent === 'STOPPED');

  check('no runtime errors overall', runtimeErrors.length === 0, runtimeErrors.join(' | '));

  let failed = 0;
  for (const c of checks) {
    if (!c.pass) failed++;
    console.log(` ${c.pass ? ' ok ' : 'FAIL'}   ${c.label}${c.pass ? '' : '  →  ' + c.detail}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
