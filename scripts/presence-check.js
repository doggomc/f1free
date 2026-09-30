#!/usr/bin/env node
'use strict';

/* Integration check for the presence model ("fake users" bug):
   - crawler/scanner page hits must NOT create dashboard users or inflate the
     public "active visitors" count
   - non-bot page hits (no heartbeat yet) must NOT count as online either —
     a viewer is a verified browser session (heartbeat)
   - every heartbeat-verified session counts exactly once
   Boots the real server as a child process like smoke-test.js. */

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const port = 34600 + Math.floor(Math.random() * 90);
const siteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freef1-presence-site-'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freef1-presence-data-'));
fs.writeFileSync(path.join(siteDir, 'index.html'), '<!doctype html><title>FreeF1 Presence</title><h1>OK</h1>');

const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    DEV_DIR: siteDir,
    ADMIN_DIR: path.join(root, 'admin'),
    ADMIN_USER: 'admin',
    ADMIN_PASS: 'admin',
    ADMIN_SECRET: 'presence-test-secret',
    VISITOR_SECRET: 'presence-visitor-secret',
    GEO_API: 'http://127.0.0.1:9',
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

async function heartbeatAs(userId, ua = CHROME_UA) {
  const tokenRes = await get('/api/visitors/token', { 'X-User-Id': userId, 'User-Agent': ua });
  assert.equal(tokenRes.status, 200, `token failed: ${tokenRes.status}`);
  const { token } = await tokenRes.json();
  const hb = await get(`/api/visitors/heartbeat?page=%2F&x=${Math.random()}`, {
    'X-User-Id': userId,
    'X-Visitor-Token': token,
    'User-Agent': ua
  });
  assert.equal(hb.status, 200, `heartbeat failed: ${hb.status}`);
  return (await hb.json()).active;
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

    const first = await heartbeatAs('user_alice');
    check('first verified session counts as exactly one user', first === 1, `active=${first}`);

    const second = await heartbeatAs('user_bob');
    check('second verified session makes two', second === 2, `active=${second}`);

    // More bot noise between/after heartbeats must not change the count.
    await get('/', { 'User-Agent': 'Mozilla/5.0 (compatible; bingbot/2.0)' });
    await get('/admin', { 'User-Agent': 'lighthouse' });
    const afterNoise = await heartbeatAs('user_alice');
    check('bot noise never inflates the count', afterNoise === 2, `active=${afterNoise}`);

    // Same user heartbeating again (page switch) is still one user.
    const again = await heartbeatAs('user_bob');
    check('repeat heartbeats do not double-count a user', again === 2, `active=${again}`);
  } catch (error) {
    check('presence scenario ran', false, error.stack || String(error));
  } finally {
    child.kill('SIGTERM');
  }

  let failed = 0;
  for (const c of checks) {
    if (!c.pass) failed++;
    console.log(` ${c.pass ? ' ok ' : 'FAIL'}   ${c.label}${c.pass ? '' : '  →  ' + c.detail}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
