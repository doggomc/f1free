#!/usr/bin/env node
'use strict';

/* Is the strmfree mirror healthy right now?
 *
 *   node scripts/strmfree-check.js [key] [quality]
 *
 * The working configuration is narrower than it looks, so this checks the
 * exact properties it depends on — if any of them regress, the source will
 * silently stop rendering video and this is the quickest way to see why:
 *
 *   1. the embed page yields a token table (and must be fetched WITHOUT a
 *      referer, or their edge serves a challenge page instead);
 *   2. the /live/ playlist is served — it, unlike the segments, insists on a
 *      referer on one of their hosts, which is fine because this server makes
 *      that request rather than the browser;
 *   3. /live/ segments are served to OUR referer. This is the load-bearing
 *      one. /live-cdn/ also exists and returns absolute urls, but that host
 *      hotlink-protects: it 403s every referer but its own, and a page cannot
 *      spoof its referer, so a player framed from the site would get 403 on
 *      all of them and sit at readyState 0 forever. /live/ has no such check.
 */

const https = require('https');
const { URL } = require('url');
const relay = require('../lib/strmfree-relay.js');

const KEY = process.argv[2] || 'skyf1';
const QUALITY = process.argv[3] || '1080p';
const OUR_REFERERS = [
  process.env.SITE_URL || 'https://freef1.netlify.app',
  'https://f1free.onrender.com',
];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -> ' + detail : ''}`);
};

function probe(url, referer, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (_) { return resolve({ status: 0, ts: false }); }
    const headers = { 'user-agent': UA, accept: '*/*' };
    if (referer) headers.referer = referer;
    const req = https.request(u, { method: 'GET', headers, timeout: timeoutMs }, (res) => {
      let first = null;
      res.on('data', (c) => { if (first === null) first = c.slice(0, 1); });
      res.on('end', () => resolve({ status: res.statusCode, ts: first && first[0] === 0x47 }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, ts: false }); });
    req.on('error', () => resolve({ status: 0, ts: false }));
    req.end();
  });
}

async function main() {
  console.log(`strmfree relay — ${KEY} @ ${QUALITY}\n`);

  let segs = [];
  try {
    const { playlist } = await relay.getPlaylist(KEY, QUALITY);
    segs = playlist.split('\n').map((l) => l.trim()).filter((l) => l && l.charAt(0) !== '#');
    check('playlist is served', playlist.startsWith('#EXTM3U'), `${segs.length} segments`);
    check('segments were rewritten to absolute urls',
      segs.length > 0 && segs.every((s) => /^https:\/\//.test(s)), segs[0] || 'none');
    check('segments carry the signed token',
      segs.length > 0 && segs.every((s) => s.includes('_t=') && s.includes('_e=') && s.includes('_n=')));
    check('segments point at the origin, not the hotlink-protected CDN',
      segs.length > 0 && segs.every((s) => s.startsWith('https://strmfree.st/')),
      (segs[0] || '').slice(0, 52));
  } catch (error) {
    console.log(`FAIL  playlist: ${error.message}`);
    console.log('\n  Could not get a playlist. Their edge challenges bursts — retry\n'
      + '  in a few minutes before assuming anything is broken.\n');
    process.exit(1);
  }
  if (!segs.length) { console.log('\n  no segments to probe\n'); process.exit(1); }

  // Probe a recent-but-not-newest segment: the newest may still be being written.
  const url = segs[Math.max(0, segs.length - 3)];
  console.log('');
  console.log('  does the segment actually reach our players?');
  for (const ref of OUR_REFERERS) {
    const r = await probe(url, ref);
    check(`served to ${ref.replace('https://', '')}`,
      r.status === 200 && r.ts, `HTTP ${r.status}${r.status === 403 ? ' (hotlink blocked)' : ''}`);
  }

  console.log('');
  console.log(`  ${pass}/${pass + fail} strmfree checks passed`);
  if (fail) {
    console.log('\n  If segments 403, the origin has started referer-checking like the\n'
      + '  CDN already does, and this source can no longer be relayed without\n'
      + '  proxying media — delist it from FEED_SOURCES and netlifyf1/app.js.');
  }
  console.log('');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('strmfree check crashed:', e.message); process.exit(1); });
