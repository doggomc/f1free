'use strict';

/* Deterministic local capacity check for the constrained Render profile.
   It opens public SSE sockets first, then sends one signed heartbeat per
   simulated browser and reports measured RSS plus recurring request/egress
   estimates. No media or third-party provider is contacted. */

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const clients = Math.max(1, Math.min(1_200, Number.parseInt(process.env.LOAD_CLIENTS || '1000', 10) || 1000));
const origin = 'https://freef1.netlify.app';
const heartbeatMs = 120_000;
const sseHeartbeatMs = 25_000;
const secondsPerMonth = 30 * 24 * 60 * 60;
const SSE_KEEPALIVE_BYTES = Buffer.byteLength(': heartbeat\n\n');

function freePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.unref();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const { port } = socket.address();
      socket.close(error => error ? reject(error) : resolve(port));
    });
  });
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForHealth(base, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.ok) return;
    } catch (_) {}
    await delay(100);
  }
  throw new Error('server did not become healthy in 20 seconds');
}

function rssMiB(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    return match ? Number(match[1]) / 1024 : 0;
  } catch (_) {
    return 0;
  }
}

function simulatedIp(index) {
  // TEST-NET-2/3 ranges are non-routable but are public-shaped to the app.
  const block = index < 254 ? '198.51.100' : index < 508 ? '203.0.113' : '192.0.2';
  return `${block}.${(index % 254) + 1}`;
}

function openSse(base, index, byteCounter, siteTicket) {
  return new Promise((resolve, reject) => {
    const request = http.get(`${base}/api/events?ticket=${encodeURIComponent(siteTicket)}`, {
      headers: {
        Accept: 'text/event-stream',
        Origin: origin,
        'X-Forwarded-For': simulatedIp(index)
      }
    });
    const timeout = setTimeout(() => {
      request.destroy();
      reject(new Error(`SSE ${index} timed out`));
    }, 20_000);
    request.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    request.once('response', response => {
      clearTimeout(timeout);
      if (response.statusCode !== 200 || !String(response.headers['content-type']).startsWith('text/event-stream')) {
        response.resume();
        request.destroy();
        return reject(new Error(`SSE ${index} returned ${response.statusCode}`));
      }
      response.on('data', chunk => { byteCounter.value += chunk.length; });
      response.on('error', () => {});
      response.resume();
      resolve({ request, response });
    });
  });
}

async function heartbeat(base, index) {
  const headers = {
    Origin: origin,
    'X-Forwarded-For': '198.18.0.1',
    'X-User-Id': `load-browser-${index}`
  };
  const tokenResponse = await fetch(`${base}/api/visitors/token?userId=load-browser-${index}`, { headers });
  if (!tokenResponse.ok) throw new Error(`token ${index} returned ${tokenResponse.status}`);
  const token = (await tokenResponse.json()).token;
  const response = await fetch(`${base}/api/visitors/heartbeat?page=%2F&minimal=1`, {
    headers: { ...headers, 'X-Visitor-Token': token }
  });
  if (response.status !== 204) throw new Error(`heartbeat ${index} returned ${response.status}`);
}

async function inBatches(count, width, task) {
  for (let start = 0; start < count; start += width) {
    const size = Math.min(width, count - start);
    await Promise.all(Array.from({ length: size }, (_, offset) => task(start + offset)));
  }
}

async function main() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1free-load-'));
  const logs = [];
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      DATA_DIR: dataDir,
      GEO_ENABLED: 'false',
      TRUST_PROXY_HOPS: '1',
      ALLOWED_ORIGIN: origin,
      AUTHORIZED_DOMAIN: 'freef1.netlify.app',
      PUBLIC_SSE_MAX: '1200',
      VISITOR_RATE_LIMIT_MAX: String(clients + 100),
      HEARTBEAT_IP_RATE_LIMIT_MAX: String(clients + 100),
      NEW_IDENTITY_BUDGET_PER_IP_HOUR: '1',
      PRESENCE_BROADCAST_MS: '900',
      SSE_HEARTBEAT_MS: String(sseHeartbeatMs),
      REDIS_URL: '',
      UPSTASH_REDIS_REST_URL: '',
      UPSTASH_REDIS_REST_TOKEN: '',
      DISCORD_BOT_TOKEN: ''
    }
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      logs.push(...chunk.split('\n').filter(Boolean));
      if (logs.length > 80) logs.splice(0, logs.length - 80);
    });
  }

  const sockets = [];
  const sseBytes = { value: 0 };
  const startedAt = Date.now();
  try {
    await waitForHealth(base, child);
    const baselineRss = rssMiB(child.pid);
    const siteTicketResponse = await fetch(`${base}/api/site/ticket`, {
      method: 'POST',
      headers: { Origin: origin }
    });
    if (!siteTicketResponse.ok) throw new Error(`site ticket returned ${siteTicketResponse.status}`);
    const siteTicket = (await siteTicketResponse.json()).ticket;

    await inBatches(clients, 100, async index => {
      sockets.push(await openSse(base, index, sseBytes, siteTicket));
    });
    const connectedAt = Date.now();

    await inBatches(clients, 50, index => heartbeat(base, index));
    const heartbeatsAt = Date.now();
    await delay(1_000);

    const loadedRss = rssMiB(child.pid);
    const initialBytes = sseBytes.value;
    const heartbeatRps = clients / (heartbeatMs / 1000);
    const monthlyHeartbeatRequests = heartbeatRps * secondsPerMonth;
    const monthlyKeepalivePayload = clients * SSE_KEEPALIVE_BYTES * secondsPerMonth / (sseHeartbeatMs / 1000);
    const mib = bytes => bytes / 1024 / 1024;
    const gib = bytes => bytes / 1024 / 1024 / 1024;

    console.log(`\nFreeF1 ${clients}-client load check`);
    console.log(`  SSE connect time:       ${((connectedAt - startedAt) / 1000).toFixed(2)} s`);
    console.log(`  signed heartbeat time:  ${((heartbeatsAt - connectedAt) / 1000).toFixed(2)} s`);
    console.log(`  RSS baseline:           ${baselineRss.toFixed(1)} MiB`);
    console.log(`  RSS with ${clients} clients: ${loadedRss.toFixed(1)} MiB (+${(loadedRss - baselineRss).toFixed(1)} MiB)`);
    console.log(`  SSE bytes observed:     ${mib(initialBytes).toFixed(2)} MiB (initial state + presence ramp)`);
    console.log(`  steady heartbeats:      ${heartbeatRps.toFixed(2)} requests/s, bodyless 204`);
    console.log(`  heartbeat requests/mo:  ${(monthlyHeartbeatRequests / 1_000_000).toFixed(2)} million at 24/7 concurrency`);
    console.log(`  SSE keepalive payload:  ${gib(monthlyKeepalivePayload).toFixed(2)} GiB/mo at 24/7 concurrency`);
    console.log('  note: transport framing/headers and rare state events are provider-measured separately.');

    if (sockets.length !== clients) throw new Error(`only ${sockets.length}/${clients} SSE clients connected`);
    if (!loadedRss || loadedRss >= 460) throw new Error(`RSS ${loadedRss.toFixed(1)} MiB leaves too little room in 512 MiB`);
    console.log('  PASS: sockets, heartbeats, and memory stayed inside the constrained profile.');
  } finally {
    for (const socket of sockets) {
      socket.request.destroy();
      socket.response.destroy();
    }
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      delay(5_000).then(() => { if (child.exitCode === null) child.kill('SIGKILL'); })
    ]);
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (child.exitCode && child.exitCode !== 0 && logs.length) {
      console.error('\nServer log tail:\n' + logs.slice(-20).join('\n'));
    }
  }
}

main().catch(error => {
  console.error(`\nFAIL: ${error.stack || error}`);
  process.exitCode = 1;
});
