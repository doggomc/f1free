#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freef1-no-relays-'));
const port = 35_100 + Math.floor(Math.random() * 500);
const origin = 'https://freef1.netlify.app';
const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    DATA_DIR: dataDir,
    ADMIN_DIR: path.join(root, 'admin'),
    ADMIN_SECRET: 'relay-disabled-admin-secret',
    VISITOR_SECRET: 'relay-disabled-visitor-secret',
    GEO_ENABLED: 'false',
    REDIS_URL: '',
    UPSTASH_REDIS_REST_URL: '',
    UPSTASH_REDIS_REST_TOKEN: '',
    // This former switch must not bring the relays back.
    RELAYS_ENABLED: '1'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });
const base = `http://127.0.0.1:${port}`;

async function ready() {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) return; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start:\n${output}`);
}

async function siteTicket() {
  const response = await fetch(`${base}/api/site/ticket`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: origin, Referer: `${origin}/` },
    body: '{}'
  });
  return (await response.json()).ticket;
}

(async () => {
  try {
    await ready();
    const ticket = await siteTicket();
    const sourcesResponse = await fetch(`${base}/api/stream/sources`, {
      headers: { Origin: origin, 'X-Site-Ticket': ticket }
    });
    const sources = await sourcesResponse.json();
    for (const id of ['cdnlivetv-f1', 'strmfree-f1']) {
      assert.ok(sources.disabled.includes(id), `${id} must stay disabled`);
      assert.ok(!sources.sources.some(source => source.id === id), `${id} must not be advertised`);
      const response = await fetch(`${base}/api/stream/ticket`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Origin: origin,
          Referer: `${origin}/`,
          'X-Site-Ticket': ticket
        },
        body: JSON.stringify({ sourceId: id })
      });
      assert.equal(response.status, 410, `${id} ticket should be gone`);
    }
    for (const route of ['/relay/cdnlivetv/m3u8', '/relay/strmfree/m3u8', '/vendor/hls.min.js']) {
      const response = await fetch(base + route);
      assert.equal(response.status, 410, `${route} should be gone`);
      assert.ok(Number(response.headers.get('content-length') || 0) < 256, `${route} response should stay tiny`);
    }
    console.log('Relay-disabled checks passed');
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => {
  child.kill('SIGTERM');
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
