#!/usr/bin/env node
'use strict';

/* Integration check for the abuse-resistance layer. Every assertion here maps
   to a hole that existed in production:

   1. Client-set identity headers (CF-Connecting-IP / X-Forwarded-For /
      X-Real-IP / True-Client-IP) must not change the caller's rate-limit
      bucket. They used to: rotating one header turned a 30/min limit into
      unlimited requests, which also made the admin login limiter decorative.
   2. /api/visitors/* must refuse callers that are not the site. A script with
      no trusted Origin could mint a signed token for any identity and then
      fabricate presence rows and permanent unique visitors.
   3. New identities per IP per hour are budgeted, so the all-time unique
      total cannot be inflated in a loop.
   4. /api/events (public SSE) is capped per IP, so one host cannot hold the
      whole pool open and starve every other viewer of stream updates.
   5. Admin login locks out after LOGIN_MAX_FAILURES, keeps counting despite
      forged headers, and the lockout survives a restart (a redeploy must not
      hand a guesser a clean slate).
   6. An optional ADMIN_IP_ALLOWLIST hides the dashboard entirely.

   Boots the real server as a child process, like smoke-test.js. */

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const TRUSTED_ORIGIN = 'https://freef1.netlify.app';

const skipped = [];

/* A non-internal IPv4 address, used to make "a call from the internet" look
   different from localhost (which this server treats as self-hosted). */
function primaryExternalIpv4() {
  const interfaces = os.networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return null;
}

let portCursor = 36100 + Math.floor(Math.random() * 60);
function nextPort() {
  portCursor += 1 + Math.floor(Math.random() * 3);
  return portCursor;
}

function startServer(env = {}) {
  const port = nextPort();
  const dataDir = env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'freef1-security-data-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      ADMIN_DIR: path.join(root, 'admin'),
      GEO_API: 'http://127.0.0.1:9',
      GEO_ENABLED: 'false',
      UPSTASH_REDIS_REST_URL: '',
      UPSTASH_REDIS_REST_TOKEN: '',
      ALLOWED_ORIGIN: TRUSTED_ORIGIN,
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  // A leftover listener from an interrupted run used to fail this whole script
  // with EADDRINUSE somewhere in the middle of the checks. Boot cases here, so
  // a port that is already taken means "try the next one", not "crashed".
  child.on('exit', (code) => {
    if (code && /EADDRINUSE/.test(log)) {
      console.warn(`port ${port} was already in use — trying another`);
      const retry = startServer(env);
      Object.assign(serverHandle, retry);
      log = retry.log();
    }
  });
  const base = `http://127.0.0.1:${port}`;
  const serverHandle = {
    child,
    port,
    dataDir,
    base,
    log: () => log,
    get: (p, headers) => fetch(base + p, { headers }),
    post: (p, body, headers) => fetch(base + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(headers || {}) },
      body: JSON.stringify(body)
    })
  };
  return serverHandle;
}

async function waitForServer(server) {
  for (let i = 0; i < 150; i++) {
    try {
      const res = await server.get('/healthz');
      if (res.ok) return;
    } catch (_) { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`server never came up:\n${server.log()}`);
}

async function readCount(server) {
  const res = await server.get('/api/visitors/active');
  const payload = await res.json();
  return payload.active;
}

async function main() {
  const checks = [];
  const check = (label, condition, detail = '') => {
    checks.push({ label, pass: Boolean(condition), detail });
  };

  /* ── 1 + 2. Rate limits ignore forged identity headers; the visitor
     endpoints only serve the site itself. ── */
  const visitor = startServer();
  await waitForServer(visitor);
  try {
    let accepted = 0;
    for (let i = 0; i < 40; i++) {
      const res = await visitor.get(`/api/visitors/token?userId=control${i}`, { Origin: TRUSTED_ORIGIN });
      if (res.status === 200) accepted++;
    }
    check('visitor token limit still admits the normal burst', accepted === 30, `accepted=${accepted}`);

    // Same endpoint, same budget, but every request claims a different client
    // address. Before the fix this returned 40/40.
    let spoofAccepted = 0;
    for (let i = 0; i < 40; i++) {
      const res = await visitor.get(`/api/visitors/token?userId=spoof${i}`, {
        Origin: TRUSTED_ORIGIN,
        'CF-Connecting-IP': `203.0.113.${i + 1}`,
        'X-Forwarded-For': `198.51.100.${i + 1}`,
        'X-Real-IP': `192.0.2.${i + 1}`,
        'True-Client-IP': `203.0.113.${200 + i}`
      });
      if (res.status === 200) spoofAccepted++;
    }
    check('forged identity headers cannot buy extra requests', spoofAccepted === 0, `accepted=${spoofAccepted}`);

    // A forged header must not fabricate a presence row either.
    const before = await readCount(visitor);
    for (let i = 0; i < 10; i++) {
      const tokenRes = await visitor.get(`/api/visitors/token?userId=ghost${i}`, {
        Origin: TRUSTED_ORIGIN, 'CF-Connecting-IP': `203.0.113.${100 + i}`
      });
      if (!tokenRes.ok) continue;
      const { token } = await tokenRes.json();
      await fetch(`${visitor.base}/api/visitors/heartbeat`, {
        headers: {
          Origin: TRUSTED_ORIGIN,
          'X-User-Id': `ghost${i}`,
          'X-Visitor-Token': token,
          'CF-Connecting-IP': `203.0.113.${100 + i}`
        }
      });
    }
    const after = await readCount(visitor);
    check('spoofed identities do not inflate the live count', after - before <= 30, `${before} -> ${after}`);
  } catch (error) {
    check('visitor abuse scenario ran', false, error.stack || String(error));
  } finally {
    visitor.child.kill('SIGTERM');
  }

  /* ── 2b. The per-address ceiling still exists, only now it is a flood
     backstop above the per-identity budgets rather than the budget itself. ── */
  const flood = startServer({ HEARTBEAT_IP_RATE_LIMIT_MAX: '5' });
  await waitForServer(flood);
  try {
    const tokenRes = await flood.get('/api/visitors/token?userId=flooder', { Origin: TRUSTED_ORIGIN });
    const { token } = await tokenRes.json();
    const statuses = [];
    for (let i = 0; i < 8; i++) {
      const res = await fetch(`${flood.base}/api/visitors/heartbeat`, {
        headers: { Origin: TRUSTED_ORIGIN, 'X-User-Id': 'flooder', 'X-Visitor-Token': token }
      });
      statuses.push(res.status);
    }
    check('a flood from one address still hits the address ceiling',
      statuses.filter(st => st === 200).length === 5 && statuses.slice(5).every(st => st === 429),
      statuses.join(','));
  } catch (error) {
    check('address-ceiling scenario ran', false, error.stack || String(error));
  } finally {
    flood.child.kill('SIGTERM');
  }

  /* ── 3. New-identity budget bounds the permanent total. ── */
  const budget = startServer({ NEW_IDENTITY_BUDGET_PER_IP_HOUR: '5' });
  await waitForServer(budget);
  try {
    const headers = { Origin: TRUSTED_ORIGIN };
    for (let i = 0; i < 12; i++) {
      const tokenRes = await budget.get(`/api/visitors/token?userId=identity${i}`, headers);
      if (!tokenRes.ok) break;
      const { token } = await tokenRes.json();
      const beat = await fetch(`${budget.base}/api/visitors/heartbeat`, {
        headers: { ...headers, 'X-User-Id': `identity${i}`, 'X-Visitor-Token': token }
      });
      assert.strictEqual(beat.status, 200, `heartbeat ${i} should be served: ${beat.status}`);
    }
    const file = path.join(budget.dataDir, 'unique-visitors.json');
    const persisted = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
    check('new-identity budget caps the permanent total', persisted.length === 5, `persisted=${persisted.length}`);
  } catch (error) {
    check('identity budget scenario ran', false, error.stack || String(error));
  } finally {
    budget.child.kill('SIGTERM');
  }

  /* ── 4. Public SSE pool is capped per IP. ── */
  const sse = startServer({ PUBLIC_SSE_MAX_PER_IP: '2' });
  await waitForServer(sse);
  try {
    // Bodies stay open on purpose: closing one releases the server-side slot
    // and the next connection would legitimately be admitted.
    const controller = new AbortController();
    const statuses = [];
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${sse.base}/api/events`, { signal: controller.signal });
      statuses.push(res.status);
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    controller.abort();
    await new Promise(resolve => setTimeout(resolve, 150));
    check('public SSE refuses a third socket from one address', statuses[0] === 200 && statuses[1] === 200 && statuses[2] === 429,
      `statuses=${statuses.join(',')}`);
  } catch (error) {
    check('SSE cap scenario ran', false, error.stack || String(error));
  } finally {
    sse.child.kill('SIGTERM');
  }

  /* ── 5. Admin login lockout: counted, forged-header proof, restart-proof. ── */
  const login = startServer({ ADMIN_USER: 'doggo', ADMIN_PASS: 'Un-guessable-Passphrase-9' });
  await waitForServer(login);
  const loginDir = login.dataDir;
  const loginPort = login.port;
  try {
    let accepted = 0, blocked = 0;
    for (let i = 0; i < 30; i++) {
      const res = await login.post('/admin/api/login', { username: 'doggo', password: `wrong-${i}` }, {
        origin: login.base,
        'CF-Connecting-IP': `203.0.113.${i + 1}`,
        'X-Forwarded-For': `198.51.100.${i + 1}`
      });
      if (res.status === 401) accepted++;
      else if (res.status === 429) blocked++;
    }
    check('admin login locks out after the failure budget', accepted === 5 && blocked === 25, `401=${accepted} 429=${blocked}`);

    const retryAfter = await login.post('/admin/api/login', { username: 'doggo', password: 'wrong-again' }, { origin: login.base });
    check('locked-out login answers with Retry-After', retryAfter.status === 429 && Number(retryAfter.headers.get('retry-after')) > 0,
      `status=${retryAfter.status} retry-after=${retryAfter.headers.get('retry-after')}`);

    // A correct password must NOT be usable while the lockout stands.
    const correct = await login.post('/admin/api/login', { username: 'doggo', password: 'Un-guessable-Passphrase-9' }, { origin: login.base });
    check('lockout also refuses the correct password', correct.status === 429, `status=${correct.status}`);
  } catch (error) {
    check('login lockout scenario ran', false, error.stack || String(error));
  } finally {
    login.child.kill('SIGTERM');
  }

  await new Promise(resolve => setTimeout(resolve, 700));
  // Restart on the original port so the check owns it end to end.
  const restarted = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(loginPort),
      DATA_DIR: loginDir,
      GEO_ENABLED: 'false',
      GEO_API: 'http://127.0.0.1:9',
      ADMIN_USER: 'doggo',
      ADMIN_PASS: 'Un-guessable-Passphrase-9',
      UPSTASH_REDIS_REST_URL: '',
      UPSTASH_REDIS_REST_TOKEN: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    for (let i = 0; i < 150; i++) {
      try { if ((await fetch(`http://127.0.0.1:${loginPort}/healthz`)).ok) break; } catch (_) { /* waiting */ }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    const res = await fetch(`http://127.0.0.1:${loginPort}/admin/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${loginPort}` },
      body: JSON.stringify({ username: 'doggo', password: 'still-wrong' })
    });
    check('login lockout survives a restart', res.status === 429, `status=${res.status}`);
  } catch (error) {
    check('lockout persistence scenario ran', false, error.stack || String(error));
  } finally {
    restarted.kill('SIGKILL');
  }

  /* ── 6. Production origin gate on the visitor endpoints. ── */
  const externalIp = primaryExternalIpv4();
  const prod = startServer({
    NODE_ENV: 'production',
    ADMIN_USER: 'doggo',
    ADMIN_PASS: 'Un-guessable-Passphrase-9',
    ADMIN_SECRET: 'a'.repeat(64),
    VISITOR_SECRET: 'b'.repeat(32),
    UPSTASH_REDIS_REST_URL: 'https://example.invalid',
    UPSTASH_REDIS_REST_TOKEN: 'token'
  });
  await waitForServer(prod);
  try {
    // A direct call to the API host (the shape of every scraping/farming
    // script) — the request must not look like a same-origin site call.
    const directBase = `http://${externalIp || '127.0.0.1'}:${prod.port}`;
    const noOrigin = externalIp
      ? await fetch(`${directBase}/api/visitors/token?userId=noorigin`)
      : null;
    const foreign = await prod.get('/api/visitors/token?userId=foreign', { Origin: 'https://evil.example' });
    const trusted = await prod.get('/api/visitors/token?userId=trusted', { Origin: TRUSTED_ORIGIN });
    const preview = await prod.get('/api/visitors/token?userId=preview', { Origin: 'https://deploy-preview-7--freef1.netlify.app' });
    if (noOrigin) {
      check('visitor token mint refuses an origin-less caller', noOrigin.status === 403,
        `host=${directBase} status=${noOrigin.status}`);
    } else {
      skipped.push('visitor token mint refuses an origin-less caller (no external interface to probe)');
    }
    check('visitor token mint refuses a foreign origin', foreign.status === 403, `status=${foreign.status}`);
    check('visitor token mint serves the site', trusted.status === 200, `status=${trusted.status}`);
    check('visitor token mint serves Netlify deploy previews', preview.status === 200, `status=${preview.status}`);

    const heartbeat = await fetch(`${prod.base}/api/visitors/heartbeat`, {
      headers: { 'X-User-Id': 'noorigin', 'X-Visitor-Token': 'payload.signature' }
    });
    check('heartbeat refuses an origin-less caller', heartbeat.status === 403, `status=${heartbeat.status}`);
  } catch (error) {
    check('origin gate scenario ran', false, error.stack || String(error));
  } finally {
    prod.child.kill('SIGTERM');
  }

  /* ── 7. Optional admin IP allowlist. ── */
  const restricted = startServer({ ADMIN_IP_ALLOWLIST: '203.0.113.7' });
  await waitForServer(restricted);
  try {
    const res = await restricted.get('/admin');
    check('ADMIN_IP_ALLOWLIST hides the dashboard', res.status === 404, `status=${res.status}`);
  } catch (error) {
    check('admin allowlist scenario ran', false, error.stack || String(error));
  } finally {
    restricted.child.kill('SIGTERM');
  }

  let failed = 0;
  for (const c of checks) {
    if (!c.pass) failed++;
    console.log(` ${c.pass ? ' ok ' : 'FAIL'}   ${c.label}${c.pass ? '' : '  →  ' + c.detail}`);
  }
  for (const label of skipped) console.log(` skip   ${label}`);
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch(error => {
  console.error('security check crashed:', error);
  process.exit(1);
});
