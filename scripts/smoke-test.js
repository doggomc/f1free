#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const port = 34567 + Math.floor(Math.random() * 1000);
const siteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freef1-site-'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freef1-data-'));
fs.writeFileSync(path.join(siteDir, 'index.html'), '<!doctype html><title>FreeF1 Smoke</title><h1>OK</h1>');
fs.writeFileSync(path.join(siteDir, 'maintenance.html'), '<!doctype html><title>FreeF1 Pit Stop</title><h1>Changing the tires</h1>');

// Mock OpenF1 upstream: flips between free-tier-open and the CORS-less 401 lock
// that the real API now returns while a session is live.
const openf1Port = 35567 + Math.floor(Math.random() * 1000);
const openf1State = { mode: 'ok' };
const openf1Mock = require('http').createServer((req, res) => {
  if (openf1State.mode === 'lock') {
    res.statusCode = 401; // deliberately no CORS headers, like the real lock
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ detail: 'Live F1 session in progress.' }));
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify([{ session_key: 1, session_name: 'Race', meeting_key: 7, location: 'Test', country_name: 'Testland', date_start: '2026-01-01T00:00:00Z', date_end: '2026-01-01T02:00:00Z' }]));
});
openf1Mock.listen(openf1Port, '127.0.0.1');

const env = {
  ...process.env,
  PORT: String(port),
  DEV_DIR: siteDir,
  ADMIN_DIR: path.join(root, 'admin'),
  ADMIN_USER: 'admin',
  ADMIN_PASS: 'admin',
  ADMIN_SECRET: 'smoke-test-secret',
  VISITOR_SECRET: 'smoke-visitor-secret',
  GEO_API: 'http://127.0.0.1:9',
  OPENF1_API: `http://127.0.0.1:${openf1Port}/v1`,
  OPENF1_TTL_MS: '1',
  DATA_DIR: dataDir,
  UPSTASH_REDIS_REST_URL: '',
  UPSTASH_REDIS_REST_TOKEN: '',
  NODE_ENV: 'test'
};

const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env,
  stdio: ['ignore', 'pipe', 'pipe']
});

let output = '';
child.stdout.on('data', chunk => { output += chunk.toString(); });
child.stderr.on('data', chunk => { output += chunk.toString(); });

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = text;
  try { body = JSON.parse(text); } catch (_) {}
  return { response, body, text };
}

async function waitForServer() {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    try {
      const { response } = await request(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch (_) {
      await sleep(150);
    }
  }
  throw new Error(`Server did not start. Output:\n${output}`);
}

(async () => {
  try {
    await waitForServer();

    const health = await request(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.response.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.response.headers.get('cache-control'), 'no-store');
    assert.equal(health.response.headers.get('x-powered-by'), null);
    assert.equal(health.response.headers.get('x-content-type-options'), 'nosniff');

    const home = await request(`http://127.0.0.1:${port}/`);
    assert.equal(home.response.status, 200);
    assert.match(home.text, /FreeF1 Smoke|OK/);
    assert.match(home.response.headers.get('cache-control') || '', /must-revalidate/);

    const compressedCss = await request(`http://127.0.0.1:${port}/admin/admin.css`, {
      headers: { 'accept-encoding': 'gzip' }
    });
    assert.equal(compressedCss.response.status, 200);
    assert.equal(compressedCss.response.headers.get('content-encoding'), 'gzip');

    const visitorToken = await request(`http://127.0.0.1:${port}/api/visitors/token`, {
      headers: { 'x-user-id': 'smoke-user' }
    });
    assert.equal(visitorToken.response.status, 200);
    assert.ok(visitorToken.body.token);

    const heartbeat = await request(`http://127.0.0.1:${port}/api/visitors/heartbeat`, {
      headers: {
        'x-visitor-token': visitorToken.body.token,
        'x-user-id': 'smoke-user',
        referer: `http://127.0.0.1:${port}/watch`
      }
    });
    assert.equal(heartbeat.response.status, 200);
    assert.equal(heartbeat.body.active, 1);

    // Player health events: known types ingest, unknown types are rejected.
    const blockedEvent = await request(`http://127.0.0.1:${port}/api/visitors/event`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-visitor-token': visitorToken.body.token,
        'x-user-id': 'smoke-user'
      },
      body: JSON.stringify({ type: 'stream_blocked' })
    });
    assert.equal(blockedEvent.response.status, 204);

    const hijackEvent = await request(`http://127.0.0.1:${port}/api/visitors/event`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-visitor-token': visitorToken.body.token,
        'x-user-id': 'smoke-user'
      },
      body: JSON.stringify({ type: 'stream_hijack' })
    });
    assert.equal(hijackEvent.response.status, 204);

    const unknownEvent = await request(`http://127.0.0.1:${port}/api/visitors/event`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-visitor-token': visitorToken.body.token,
        'x-user-id': 'smoke-user'
      },
      body: JSON.stringify({ type: 'not_a_real_event' })
    });
    assert.equal(unknownEvent.response.status, 400);

    const login = await request(`http://127.0.0.1:${port}/admin/api/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: `http://127.0.0.1:${port}`
      },
      body: JSON.stringify({ username: 'admin', password: 'admin' })
    });
    assert.equal(login.response.status, 200);
    assert.equal(login.body.success, true);

    const setCookies = login.response.headers.getSetCookie?.() || [];
    const cookie = setCookies.length
      ? setCookies.map(value => value.split(';')[0]).join('; ')
      : login.response.headers.get('set-cookie')?.split(/,(?=\s*freef1\.sid)/).map(value => value.split(';')[0]).join('; ');
    assert.ok(cookie, 'login should set a session cookie');

    const initialSiteStatus = await request(`http://127.0.0.1:${port}/api/site/status`);
    assert.equal(initialSiteStatus.response.status, 200);
    assert.equal(initialSiteStatus.body.maintenance.active, false);
    assert.equal(initialSiteStatus.body.maintenance.eta, 'Before lights out', 'default pit-board eta exposed publicly');

    const initialNews = await request(`http://127.0.0.1:${port}/api/news`);
    assert.equal(initialNews.response.status, 200);
    assert.deepEqual(initialNews.body.news, []);

    const createdNews = await request(`http://127.0.0.1:${port}/admin/api/news`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        title: 'Smoke test headline',
        body: 'The news control is working.',
        tag: 'Testing',
        published: true
      })
    });
    assert.equal(createdNews.response.status, 201);
    assert.equal(createdNews.body.success, true);
    assert.equal(createdNews.body.news.title, 'Smoke test headline');

    const publicNews = await request(`http://127.0.0.1:${port}/api/news`);
    assert.equal(publicNews.response.status, 200);
    assert.equal(publicNews.body.news.length, 1);
    assert.equal(publicNews.body.news[0].body, 'The news control is working.');

    const deletedNews = await request(`http://127.0.0.1:${port}/admin/api/news/${encodeURIComponent(createdNews.body.news.id)}`, {
      method: 'DELETE',
      headers: { cookie }
    });
    assert.equal(deletedNews.response.status, 200);
    assert.equal(deletedNews.body.success, true);

    const enableMaintenance = await request(`http://127.0.0.1:${port}/admin/api/maintenance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ active: true, message: "We'll be back before the test race.", eta: 'Before the formation lap.' })
    });
    assert.equal(enableMaintenance.response.status, 200);
    assert.equal(enableMaintenance.body.success, true);
    assert.equal(enableMaintenance.body.maintenance.active, true);
    assert.equal(enableMaintenance.body.maintenance.message, "We'll be back before the test race.");
    assert.equal(enableMaintenance.body.maintenance.eta, 'Before the formation lap.', 'eta round-trips through the admin API');

    const maintenanceHome = await request(`http://127.0.0.1:${port}/`);
    assert.equal(maintenanceHome.response.status, 503);
    assert.match(maintenanceHome.text, /Changing the tires/);
    assert.equal(maintenanceHome.response.headers.get('cache-control'), 'no-store');

    const disableMaintenance = await request(`http://127.0.0.1:${port}/admin/api/maintenance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ active: false, message: "We'll be back before the test race." })
    });
    assert.equal(disableMaintenance.response.status, 200);
    assert.equal(disableMaintenance.body.maintenance.active, false);
    assert.equal(disableMaintenance.body.maintenance.eta, 'Before the formation lap.', 'eta persists across mode changes');

    const restoredHome = await request(`http://127.0.0.1:${port}/`);
    assert.equal(restoredHome.response.status, 200);
    assert.match(restoredHome.text, /FreeF1 Smoke|OK/);

    // Restore the heartbeat page after the direct home-route maintenance checks.
    await request(`http://127.0.0.1:${port}/api/visitors/heartbeat`, {
      headers: {
        'x-visitor-token': visitorToken.body.token,
        'x-user-id': 'smoke-user',
        referer: `http://127.0.0.1:${port}/watch`
      }
    });

    const visitors = await request(`http://127.0.0.1:${port}/admin/api/visitors`, {
      headers: { cookie }
    });
    assert.equal(visitors.response.status, 200);
    assert.equal(visitors.body.onlineCount, 1);
    assert.ok(Array.isArray(visitors.body.visitors));
    assert.equal(typeof visitors.body.visitors[0], 'object');
    assert.ok(visitors.body.visitors.some(visitor => visitor.page === '/watch'));

    const override = await request(`http://127.0.0.1:${port}/admin/api/stream/override`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ url: 'https://youtu.be/dQw4w9WgXcQ?t=1' })
    });
    assert.equal(override.response.status, 200);
    assert.equal(override.body.success, true);
    assert.equal(override.body.override.type, 'youtube');
    assert.match(override.body.override.url, /youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/);

    const rejected = await request(`http://127.0.0.1:${port}/admin/api/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://freef1.netlify.app.evil.example'
      },
      body: JSON.stringify({ username: 'admin', password: 'admin' })
    });
    assert.equal(rejected.response.status, 403);

    // OpenF1 proxy — fresh upstream data passes through untouched
    const ofFresh = await request(`http://127.0.0.1:${port}/api/openf1/sessions?year=2026`);
    assert.equal(ofFresh.response.status, 200);
    assert.ok(Array.isArray(ofFresh.body));
    assert.equal(ofFresh.response.headers.get('x-openf1-stale'), null);

    // Upstream locks the free tier (CORS-less 401): proxy serves last-known-good
    openf1State.mode = 'lock';
    await sleep(10);
    const ofStale = await request(`http://127.0.0.1:${port}/api/openf1/sessions?year=2026`);
    assert.equal(ofStale.response.status, 200);
    assert.equal(ofStale.response.headers.get('x-openf1-stale'), '1');
    assert.ok(Array.isArray(ofStale.body));

    // Locked endpoint with no snapshot yet -> structured 503, never a browser CORS failure
    const ofLocked = await request(`http://127.0.0.1:${port}/api/openf1/team_radio?session_key=999`);
    assert.equal(ofLocked.response.status, 503);
    assert.equal(ofLocked.body.code, 'live');

    // Unknown upstream endpoints are rejected at the proxy
    const ofUnknown = await request(`http://127.0.0.1:${port}/api/openf1/positions`);
    assert.equal(ofUnknown.response.status, 404);
    openf1State.mode = 'ok';

    console.log('Smoke tests passed');
  } finally {
    openf1Mock.close();
    child.kill('SIGTERM');
    await sleep(100);
    fs.rmSync(siteDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(err => {
  child.kill('SIGTERM');
  console.error(output);
  console.error(err);
  process.exit(1);
});
