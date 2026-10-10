#!/usr/bin/env node
'use strict';

/* Integration check for the presence model. Boots the real server as a child
   process like smoke-test.js.

   The model under test — one number, one browser, no addresses:

   - a browser is one count, no matter how many tabs of it heartbeat
   - crawler/scanner page hits must NOT create dashboard users or move the count
   - identity is the browser id and nothing else: a signed token keeps working
     from a different address (that is the point — a phone that changes cell
     must not be re-minted mid-session), and it never carries an address
   - the count follows the truth in both directions: hidden tabs stop beating
     and the server drops them at its window, with the drop PUSHED over SSE by
     a deadline timer — not discovered at the next visitor's arrival
   - the leave beacon (pagehide/sendBeacon) takes a closed browser out of the
     count immediately, and a beat right after it puts them back
   - no address ever reaches a client: not in the heartbeat answer, not in
     /api/visitors/active, not in the dashboard snapshot, nowhere
   - the country still reaches the dashboard row for a viewer the server can
     locate, and an address that cannot be located is never sent to the outside
     provider

   Every guard here has been negative-tested: break the behaviour it describes
   and this file fails. */

const assert = require('assert');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
// Fixed credentials for the spawned server: the admin snapshot check below logs
// in with them, so they must not drift with the caller's environment (`npm run
// check` exports its own ADMIN_USER/ADMIN_PASS, which this harness ignores).
const TEST_ADMIN_USER = 'admin';
const TEST_ADMIN_PASS = 'admin';
const port = 34600 + Math.floor(Math.random() * 90);
const siteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freef1-presence-site-'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freef1-presence-data-'));
fs.writeFileSync(path.join(siteDir, 'index.html'), '<!doctype html><title>FreeF1 Presence</title><h1>OK</h1>');

/* A stand-in for the geo provider (ipwho.is in production). It answers for any
   address and records which addresses it was asked about, so the harness can
   prove two things: a public viewer's country reaches the dashboard row, and an
   address that cannot be located is never sent to the provider at all. */
const geoAsked = [];
const geoStub = http.createServer((req, res) => {
  const ip = decodeURIComponent(((req.url || '/').split('?')[0].split('/').filter(Boolean)[0]) || '');
  geoAsked.push(ip);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: 'success', country: 'South Africa', city: 'Pretoria', countryCode: 'ZA', query: ip }));
});
const geoPort = 34700 + Math.floor(Math.random() * 90);
geoStub.listen(geoPort, '127.0.0.1');

// Shortened here so the expiry checks do not add thirty seconds to every suite
// run; the shipped default is asserted from source further down.
const TEST_TTL_MS = 2500;

const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    // The stub provider is local, so the geo path is exercised hermetically. Set
    // explicitly: the suite is invoked with GEO_ENABLED=false, and inheriting
    // that would make these checks depend on how the caller ran the suite.
    GEO_ENABLED: 'true',
    GEO_API: `http://127.0.0.1:${geoPort}`,
    // One hop: the local socket is the proxy, exactly as Render's router is in
    // production, so X-Forwarded-For is what decides the client address.
    TRUST_PROXY_HOPS: '1',
    PRESENCE_TTL_MS: String(TEST_TTL_MS),
    // Shortened for speed; the shipped 18s default is asserted from source.
    PRESENCE_LEAVE_GRACE_MS: '300',
    DEV_DIR: siteDir,
    ADMIN_DIR: path.join(root, 'admin'),
    ADMIN_USER: TEST_ADMIN_USER,
    ADMIN_PASS: TEST_ADMIN_PASS,
    ADMIN_SECRET: 'presence-test-secret',
    VISITOR_SECRET: 'presence-visitor-secret',
    DATA_DIR: dataDir,
    UPSTASH_REDIS_REST_URL: '',
    UPSTASH_REDIS_REST_TOKEN: '',
    NODE_ENV: 'test'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d; });
child.stderr.on('data', (d) => { serverLog += d; });

const base = `http://127.0.0.1:${port}`;
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const get = (p, headers = {}) => fetch(base + p, { headers });

async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await get('/api/visitors/token?userId=probe', { 'X-User-Id': 'user_probe' });
      if (r.status < 500) return;
    } catch (_) {}
    await new Promise(res => setTimeout(res, 100));
  }
  throw new Error('server did not become ready:\n' + serverLog);
}

const tokenCache = new Map();

async function tokenFor(userId, extraHeaders = {}) {
  if (tokenCache.has(userId)) return tokenCache.get(userId);
  const tokenRes = await get('/api/visitors/token', { 'X-User-Id': userId, 'User-Agent': CHROME_UA, ...extraHeaders });
  assert.equal(tokenRes.status, 200, `token failed: ${tokenRes.status}`);
  const { token } = await tokenRes.json();
  tokenCache.set(userId, token);
  return token;
}

/* A heartbeat exactly as the site now sends it: identity in the headers, the
   page in the query, and no tab-state flags at all. `extraHeaders` lets a call
   present a different address via X-Forwarded-For. */
async function beatAs(userId, extraHeaders = {}) {
  const token = await tokenFor(userId);
  const hb = await get(`/api/visitors/heartbeat?page=%2F&x=${Math.random()}`, {
    'X-User-Id': userId,
    'X-Visitor-Token': token,
    'User-Agent': CHROME_UA,
    ...extraHeaders
  });
  assert.equal(hb.status, 200, `heartbeat failed: ${hb.status}`);
  return hb.json();
}

/* /api/visitors/active and /api/events are behind the default-deny site-ticket
   gate; mint one the way the site does (allowed Origin) and reuse it. */
const SITE_ORIGIN = 'https://freef1.netlify.app';
let siteTicketCache = '';
async function siteTicket() {
  if (siteTicketCache) return siteTicketCache;
  const r = await fetch(`${base}/api/site/ticket`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: SITE_ORIGIN, Referer: SITE_ORIGIN + '/', 'User-Agent': CHROME_UA },
    body: '{}'
  });
  const { ticket } = await r.json();
  assert.ok(ticket, `site ticket refused: ${r.status}`);
  siteTicketCache = ticket;
  return ticket;
}

const liveCount = async () => (await (await get('/api/visitors/active', { 'X-Site-Ticket': await siteTicket() })).json()).active;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* Reads the server's own SSE stream. Everything the site and the dashboard know
   about presence arrives here, so this is the only honest way to test "it
   updates immediately". */
function openPresenceStream() {
  const controller = new AbortController();
  const events = [];
  const ready = (async () => {
    const res = await fetch(`${base}/api/events?ticket=${encodeURIComponent(await siteTicket())}`, {
      headers: { Accept: 'text/event-stream', 'User-Agent': CHROME_UA },
      signal: controller.signal
    });
    assert.equal(res.status, 200, `SSE connect failed: ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const name = /^event:\s*(.+)$/m.exec(raw);
            const data = /^data:\s*(.+)$/m.exec(raw);
            if (name && data) {
              try { events.push({ event: name[1].trim(), data: JSON.parse(data[1]) }); } catch (_) {}
            }
          }
        }
      } catch (_) {}
    })();
  })();
  return {
    ready,
    events,
    presence: () => events.filter(e => e.event === 'presence').map(e => e.data),
    async waitFor(predicate, timeoutMs = 3000) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const hit = [...events].reverse().find(predicate);
        if (hit) return hit;
        await sleep(25);
      }
      return null;
    },
    close: () => controller.abort()
  };
}

(async () => {
  const checks = [];
  const check = (label, condition, detail = '') => checks.push({ label, pass: Boolean(condition), detail });

  try {
    await waitReady();

    // Noise that used to show up as "users" on the live dashboard.
    await get('/', { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' });
    await get('/', { 'User-Agent': 'python-requests/2.31.0' });
    await get('/wp-admin', { 'User-Agent': 'curl/8.4.0' });
    await get('/', { 'User-Agent': 'Mozilla/5.0 (compatible; AhrefsBot/7.0)' });
    await get('/', { 'User-Agent': 'StatusCake_Pagespeed_Indev' });
    // A plain page hit with a real-looking browser UA but no heartbeat
    // (e.g. a prefetch) must not count either.
    await get('/', { 'User-Agent': CHROME_UA });
    check('bot noise and page hits never create a viewer', await liveCount() === 0, `active=${await liveCount()}`);

    // ── arrival: one browser is one count ────────────────────────────────
    const first = await beatAs('user_ttl_a');
    check('first verified browser counts as exactly one', first.active === 1, JSON.stringify(first));
    const second = await beatAs('user_ttl_b');
    check('second browser makes two', second.active === 2, JSON.stringify(second));
    const again = await beatAs('user_ttl_a');
    check('the same browser beating again (another tab, a page change) is still one', again.active === 2, JSON.stringify(again));

    // ── the count must arrive live, not on a poll ────────────────────────
    const stream = openPresenceStream();
    await stream.ready;

    const carol = await beatAs('user_ttl_c');
    check('the heartbeat answer is one number and a timestamp', 
      Object.keys(carol).sort().join(',') === 'active,at', JSON.stringify(carol));
    const pushed = await stream.waitFor(e => e.event === 'presence' && e.data.active === 3, 2500);
    check('an SSE presence event is pushed the moment a browser arrives', Boolean(pushed),
      'no presence event with active=3 arrived: ' + JSON.stringify(stream.events.slice(-3)));

    // ── the drop is pushed by a deadline timer, with no traffic at all ───
    // Nothing heartbeats from here on: the count must fall to zero on its own,
    // and the event must arrive without another visitor triggering it.
    const dropPush = await stream.waitFor(e => e.event === 'presence' && e.data.active === 0, TEST_TTL_MS + 3000);
    check('a quiet site still pushes the drop the moment the window expires', Boolean(dropPush),
      JSON.stringify(stream.events.slice(-4)));
    check('and the count really is zero afterwards', await liveCount() === 0, `active=${await liveCount()}`);
    const cameBack = await beatAs('user_ttl_c');
    check('a browser that beats again after expiring is counted again', cameBack.active === 1, JSON.stringify(cameBack));

    // ── identity is the browser, never the address ───────────────────────
    /* Mint the token while presenting one public address, then use it from a
       different one. The old model bound the token to the address and answered
       403 here, forcing a re-mint mid-session — the bug behind the flapping
       counts on mobile. */
    await fetch(`${base}/api/visitors/leave?uid=user_ttl_c&token=${encodeURIComponent(await tokenFor('user_ttl_c'))}`, { method: 'POST' });
    await sleep(450);   // past the test grace (300ms)
    check('a goodbye with no heartbeat after it takes the browser out at the grace deadline',
      await liveCount() === 0, `active=${await liveCount()}`);
    const ipA = { 'X-Forwarded-For': '41.90.172.99' };
    const ipB = { 'X-Forwarded-For': '196.25.10.7' };
    const roamToken = await tokenFor('user_roam', ipA);
    const roamBeat = await fetch(`${base}/api/visitors/heartbeat?page=%2F`, {
      headers: { 'X-User-Id': 'user_roam', 'X-Visitor-Token': roamToken, 'User-Agent': CHROME_UA, ...ipB }
    });
    check('a token minted at one address keeps working from another (no re-mint loop)',
      roamBeat.status === 200, `status=${roamBeat.status}`);
    check('the roamer is one browser, counted once', (await roamBeat.json()).active === 1, JSON.stringify(await liveCount()));
    // …and the token itself carries no address to bind to.
    const payloadJson = Buffer.from(roamToken.split('.')[0], 'base64url').toString('utf8');
    const payloadKeys = Object.keys(JSON.parse(payloadJson)).sort().join(',');
    check('the signed token payload is id + exp only — no address inside',
      payloadKeys === 'exp,id' && !/ip/i.test(payloadJson), payloadJson);
    // A token authorises exactly its own id, nothing else.
    const otherId = await fetch(`${base}/api/visitors/heartbeat?page=%2F`, {
      headers: { 'X-User-Id': 'user_someone_else', 'X-Visitor-Token': roamToken, 'User-Agent': CHROME_UA }
    });
    check('a token is refused for any id but its own', otherId.status === 403, `status=${otherId.status}`);

    // ── the leave beacon: immediate, and recoverable ─────────────────────
    const roamTokenNow = roamToken;   // tokenFor cache holds the same value
    const badLeave = await fetch(`${base}/api/visitors/leave?uid=user_roam&token=not-a-real-token`, { method: 'POST' });
    check('a forged leave token is refused', badLeave.status === 403, `status=${badLeave.status}`);
    const noUid = await fetch(`${base}/api/visitors/leave`, { method: 'POST' });
    check('a leave call with no identity is refused', noUid.status === 400, `status=${noUid.status}`);
    const beforeLeave = await liveCount();
    check('the roamer is the only live browser before the goodbye', beforeLeave === 1, `active=${beforeLeave}`);
    const leave = await fetch(`${base}/api/visitors/leave?uid=user_roam&token=${encodeURIComponent(roamTokenNow)}`, { method: 'POST' });
    check('the leave beacon is accepted with the signed query-string token', leave.status === 204, `status=${leave.status}`);
    check('a goodbye does not erase a browser another tab may still be using',
      await liveCount() === beforeLeave, `${beforeLeave} -> ${await liveCount()}`);
    const navBack = await beatAs('user_roam');
    check('a beat right after a navigation beacon counts again (bfcache restore)', navBack.active === beforeLeave, JSON.stringify(navBack));
    // Now let a goodbye stand with no heartbeat to clear it: the browser leaves
    // at the grace deadline, pushed by the deadline timer.
    await fetch(`${base}/api/visitors/leave?uid=user_roam&token=${encodeURIComponent(roamTokenNow)}`, { method: 'POST' });
    await sleep(450);
    check('a browser whose last tab closed leaves the count at the grace deadline',
      await liveCount() === beforeLeave - 1, `${beforeLeave} -> ${await liveCount()}`);
    const leavePush = await stream.waitFor(e => e.event === 'presence' && e.data.active === beforeLeave - 1, 3000);
    check('the departure is pushed, not discovered at the next poll', Boolean(leavePush),
      JSON.stringify(stream.events.slice(-3)));
    const rejoin = await beatAs('user_roam');
    check('beating again after the goodbye restores the browser', rejoin.active === beforeLeave, JSON.stringify(rejoin));

    // ── the payloads carry no address, and say so by shape ───────────────
    const activePayload = await (await get('/api/visitors/active', { 'X-Site-Ticket': await siteTicket() })).json();
    check('/api/visitors/active is exactly { active, at }',
      Object.keys(activePayload).sort().join(',') === 'active,at', JSON.stringify(activePayload));
    check('no address text anywhere in the public payloads',
      !/ip/i.test(JSON.stringify(activePayload)) && !/(\d{1,3}\.){3}\d{1,3}/.test(JSON.stringify(activePayload)),
      JSON.stringify(activePayload));

    // ── the dashboard snapshot: rows, countries, and nothing else ────────
    const login = await fetch(`${base}/admin/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: TEST_ADMIN_USER, password: TEST_ADMIN_PASS })
    });
    // The admin session is a signed pair (value + signature): both cookies have
    // to travel back, or every admin API call answers 401.
    const setCookies = login.headers.getSetCookie ? login.headers.getSetCookie() : [login.headers.get('set-cookie') || ''];
    const cookie = setCookies.map(c => String(c).split(';')[0]).filter(Boolean).join('; ');
    check('dashboard login for the snapshot check succeeded', login.status === 200, `status=${login.status}`);

    // A locatable viewer and an unlocatable one, arriving together so both are
    // inside the window when the snapshot is taken.
    await beatAs('user_public', ipA);
    await beatAs('user_private', { 'X-Forwarded-For': '10.194.16.7' });
    await sleep(350);   // the geo lookup is asynchronous and lands as its own update
    const snapshot = await (await fetch(`${base}/admin/api/visitors`, { headers: { cookie } })).json();
    const snapshotJson = JSON.stringify(snapshot);
    const publicRow = snapshot.visitors.find(v => v.id === 'user_public');
    const privateRow = snapshot.visitors.find(v => v.id === 'user_private');

    check('the snapshot count and the rows are the same population',
      snapshot.liveCount === snapshot.visitors.length && snapshot.visitors.every(v => v.live === true),
      `liveCount=${snapshot.liveCount}, rows=${snapshot.visitors.length}`);
    const rowKeys = snapshot.visitors.length ? Object.keys(snapshot.visitors[0]).sort().join(',') : '';
    check('a row carries no address and no tab-state flags — only who, when and where',
      rowKeys === 'browser,city,connectedAt,country,countryCode,deviceType,id,lastSeen,live,liveUntil,os,page,source'.split(',').sort().join(','),
      rowKeys);
    check('the whole snapshot contains no IP address',
      !/(\d{1,3}\.){3}\d{1,3}/.test(snapshotJson) && !/"ip/i.test(snapshotJson),
      'an address-shaped string is somewhere in the snapshot');
    check('the boolean and the deadline agree with each other',
      snapshot.visitors.every(v => v.live === (v.liveUntil > snapshot.server.now)),
      JSON.stringify(snapshot.visitors.slice(0, 2).map(v => ({ live: v.live, liveUntil: v.liveUntil }))));
    check('the geo provider is asked about a public viewer and their country lands in the row',
      geoAsked.includes('41.90.172.99') && publicRow && publicRow.country === 'South Africa' && publicRow.city === 'Pretoria',
      JSON.stringify({ asked: geoAsked, row: publicRow && { country: publicRow.country, city: publicRow.city } }));
    check('an address that cannot be located is never sent to the provider',
      !geoAsked.includes('10.194.16.7'), geoAsked.join(','));
    check('an unlocatable viewer still gets a row — identity does not depend on location',
      Boolean(privateRow) && privateRow.country === null && privateRow.live === true,
      JSON.stringify(privateRow && { country: privateRow.country, live: privateRow.live }));

    stream.close();

    // ── the shipped constants (test overrides are for speed only) ────────
    const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    const ttlDefault = /PRESENCE_TTL_MS\s*=\s*Number\(process\.env\.PRESENCE_TTL_MS\s*\|\|\s*([0-9_]+)\)/.exec(serverSource);
    const ttlMs = ttlDefault ? Number(ttlDefault[1].replace(/_/g, '')) : 0;
    check('the shipped window is sized for two-minute heartbeats (test override is 2.5s)',
      ttlMs === 270000,
      ttlDefault ? ttlDefault[1] : 'constant not found');
    const siteRoot = process.env.SITE_DIR || '/home/user/netlifyf1';
    const siteSource = fs.readFileSync(path.join(siteRoot, 'app.js'), 'utf8');
    const directBeat = /const INTERVAL = (\d+);/.exec(siteSource);
    const runtimePath = path.join(siteRoot, 'runtime-config.js');
    const runtimeBeat = fs.existsSync(runtimePath)
      ? /heartbeatMs:\s*(\d+)/.exec(fs.readFileSync(runtimePath, 'utf8'))
      : null;
    const beatMs = Number((runtimeBeat || directBeat || [0, 0])[1]);
    check('two of the site\'s beat intervals fit in the presence window',
      beatMs > 0 && beatMs * 2 <= ttlMs,
      beatMs ? `${beatMs}ms` : 'beat interval not found');
    const graceDefault = /PRESENCE_LEAVE_GRACE_MS\s*=\s*Number\(process\.env\.PRESENCE_LEAVE_GRACE_MS\s*\|\|\s*([0-9_]+)\)/.exec(serverSource);
    const graceMs = graceDefault ? Number(graceDefault[1].replace(/_/g, '')) : 0;
    check('the goodbye grace exceeds one beat but stays below the presence window',
      graceMs > beatMs && graceMs < ttlMs,
      `grace=${graceMs}, beat=${beatMs}, ttl=${ttlMs}`);

    /* ── budgets are per viewer, not per address ──────────────────────────
       Two viewers behind one address used to share one budget, so the
       neighbours' heartbeats started being refused. Thirty-two beats from one
       address, split across two identities, must all be served. */
    const pairTokens = [];
    for (const id of ['user_rateA', 'user_rateB']) pairTokens.push([id, await tokenFor(id)]);
    const pairStatuses = [];
    for (let i = 0; i < 16; i++) {
      for (const [id, token] of pairTokens) {
        const r = await fetch(`${base}/api/visitors/heartbeat?page=%2F`, {
          headers: { 'X-User-Id': id, 'X-Visitor-Token': token, 'User-Agent': CHROME_UA }
        });
        pairStatuses.push(r.status);
      }
    }
    check('viewers sharing one address are not starved by a shared budget',
      pairStatuses.every(st => st === 200),
      `${pairStatuses.filter(st => st === 200).length}/${pairStatuses.length} accepted: ${[...new Set(pairStatuses)].join(',')}`);

    /* …and one viewer still cannot hammer the endpoint: the budget just moved
       from the address to the verified identity. */
    const floodId = 'user_flood';
    const floodToken = await tokenFor(floodId);
    const floodStatuses = [];
    for (let i = 0; i < 26; i++) {
      const r = await fetch(`${base}/api/visitors/heartbeat?page=%2F`, {
        headers: { 'X-User-Id': floodId, 'X-Visitor-Token': floodToken, 'User-Agent': CHROME_UA }
      });
      floodStatuses.push(r.status);
    }
    const floodMax = Number((/HEARTBEAT_RATE_LIMIT_MAX\s*=\s*Number\(process\.env\.HEARTBEAT_RATE_LIMIT_MAX\s*\|\|\s*([0-9_]+)\)/.exec(serverSource) || [])[1] || 0);
    check('one viewer\'s own burst budget still applies',
      floodStatuses.filter(st => st === 200).length === floodMax &&
      floodStatuses[floodMax] === 429 && floodStatuses.slice(floodMax + 1).every(st => st === 429),
      `limit=${floodMax}, accepted=${floodStatuses.filter(st => st === 200).length}, last=${floodStatuses[floodStatuses.length - 1]}`);

    /* A forged token must not burn anybody's budget (it is refused before the
       budget is charged), so the real viewer's next beat still works. */
    const realId = 'user_budget_owner';
    const realToken = await tokenFor(realId);
    for (let i = 0; i < 5; i++) {
      await fetch(`${base}/api/visitors/heartbeat?page=%2F`, {
        headers: { 'X-User-Id': realId, 'X-Visitor-Token': 'not-a-real-token', 'User-Agent': CHROME_UA }
      });
    }
    const afterForged = await fetch(`${base}/api/visitors/heartbeat?page=%2F`, {
      headers: { 'X-User-Id': realId, 'X-Visitor-Token': realToken, 'User-Agent': CHROME_UA }
    });
    check('a forged token cannot spend the real viewer\'s budget', afterForged.status === 200,
      `status=${afterForged.status} after 5 forged attempts`);
  } catch (error) {
    check('presence scenario ran', false, error.stack || String(error));
  } finally {
    child.kill('SIGTERM');
    geoStub.close();
  }

  let failed = 0;
  for (const c of checks) {
    if (!c.pass) failed++;
    console.log(` ${c.pass ? ' ok ' : 'FAIL'}   ${c.label}${c.pass ? '' : '  →  ' + c.detail}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
