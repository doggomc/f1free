#!/usr/bin/env node
'use strict';

/* Production-mode integration check for the official node-redis transport.
   A tiny in-process RESP2 server implements only the commands FreeF1 uses at
   startup. This validates the real TCP client, command envelopes, hydration,
   readiness, and authenticated self-check without external credentials. */

const assert = require('assert');
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

const root = path.join(__dirname, '..');
const origin = 'https://freef1.netlify.app';
const selfcheckToken = 's'.repeat(32);

function encode(value) {
  if (value === null) return '$-1\r\n';
  if (Array.isArray(value)) return `*${value.length}\r\n${value.map(encode).join('')}`;
  if (Number.isInteger(value)) return `:${value}\r\n`;
  return `$${Buffer.byteLength(String(value))}\r\n${String(value)}\r\n`;
}

function parseOne(buffer, offset = 0) {
  if (offset >= buffer.length) return null;
  const type = buffer[offset];
  const lineEnd = buffer.indexOf('\r\n', offset + 1);
  if (lineEnd < 0) return null;
  const header = buffer.subarray(offset + 1, lineEnd).toString();
  let cursor = lineEnd + 2;
  if (type === 42) { // array
    const length = Number(header);
    const value = [];
    for (let i = 0; i < length; i++) {
      const item = parseOne(buffer, cursor);
      if (!item) return null;
      value.push(item.value);
      cursor = item.offset;
    }
    return { value, offset: cursor };
  }
  if (type === 36) { // bulk string
    const length = Number(header);
    if (length < 0) return { value: null, offset: cursor };
    if (buffer.length < cursor + length + 2) return null;
    return { value: buffer.subarray(cursor, cursor + length).toString(), offset: cursor + length + 2 };
  }
  if (type === 43 || type === 58) return { value: type === 58 ? Number(header) : header, offset: cursor };
  throw new Error(`Unsupported RESP byte ${type}`);
}

function responseFor(parts) {
  const command = String(parts?.[0] || '').toUpperCase();
  if (command === 'HELLO') {
    return '%7\r\n'
      + `${encode('server')}${encode('redis')}`
      + `${encode('version')}${encode('7.2.0')}`
      + `${encode('proto')}:3\r\n`
      + `${encode('id')}:1\r\n`
      + `${encode('mode')}${encode('standalone')}`
      + `${encode('role')}${encode('master')}`
      + `${encode('modules')}*0\r\n`;
  }
  if (command === 'PING') return '+PONG\r\n';
  if (command === 'GET') return '$-1\r\n';
  if (command === 'SCARD') return ':0\r\n';
  if (command === 'HGETALL' || command === 'SMEMBERS' || command === 'KEYS') return '*0\r\n';
  if (command === 'TYPE') return '+none\r\n';
  if (command === 'TTL') return ':-1\r\n';
  if (['SET', 'RENAME', 'CLIENT', 'SELECT', 'AUTH'].includes(command)) return '+OK\r\n';
  if (['DEL', 'SADD', 'HSET', 'EXPIRE'].includes(command)) return ':1\r\n';
  if (command === 'QUIT') return '+OK\r\n';
  return `-ERR unsupported test command ${command}\r\n`;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function waitForReady(base, child, logs) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}\n${logs.join('')}`);
    try {
      const response = await fetch(`${base}/readyz`);
      if (response.ok) return response.json();
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`readiness timed out\n${logs.join('')}`);
}

(async () => {
  let commands = 0;
  const redisServer = net.createServer(socket => {
    socket.on('error', () => {});
    let input = Buffer.alloc(0);
    let transaction = null;
    socket.on('data', chunk => {
      input = Buffer.concat([input, chunk]);
      try {
        while (input.length) {
          const parsed = parseOne(input);
          if (!parsed) break;
          input = input.subarray(parsed.offset);
          const parts = parsed.value;
          const command = String(parts?.[0] || '').toUpperCase();
          commands++;
          if (command === 'MULTI') {
            transaction = [];
            socket.write('+OK\r\n');
          } else if (command === 'EXEC') {
            const replies = (transaction || []).map(item => responseFor(item));
            transaction = null;
            socket.write(`*${replies.length}\r\n${replies.join('')}`);
          } else if (transaction) {
            transaction.push(parts);
            socket.write('+QUEUED\r\n');
          } else {
            socket.write(responseFor(parts));
          }
        }
      } catch (error) {
        socket.destroy(error);
      }
    });
  });

  let child = null;
  const logs = [];
  try {
    const redisPort = await listen(redisServer);
    const probe = net.createServer();
    const appPort = await listen(probe);
    await new Promise(resolve => probe.close(resolve));
    const base = `http://127.0.0.1:${appPort}`;

    child = spawn(process.execPath, ['server.js'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(appPort),
        ADMIN_USER: 'deployment-owner',
        ADMIN_PASS: 'Strong-production-password-42',
        ADMIN_SECRET: 'a'.repeat(64),
        VISITOR_SECRET: 'b'.repeat(64),
        UNIQUE_VISITOR_HASH_SECRET: 'c'.repeat(64),
        SELFCHECK_TOKEN: selfcheckToken,
        REDIS_URL: `redis://127.0.0.1:${redisPort}`,
        UPSTASH_REDIS_REST_URL: '',
        UPSTASH_REDIS_REST_TOKEN: '',
        AUTHORIZED_DOMAIN: 'freef1.netlify.app',
        ALLOWED_ORIGIN: origin,
        GEO_ENABLED: 'false',
        DISCORD_BOT_TOKEN: ''
      }
    });
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', chunk => logs.push(chunk));
    }

    const ready = await waitForReady(base, child, logs);
    assert.equal(ready.ok, true);
    assert.equal(ready.durableProvider, 'redis');
    assert.equal(ready.durableReady, true);
    assert.equal(ready.targetsReady, true);
    assert.ok(Object.values(ready.stores).every(Boolean));

    const health = await (await fetch(`${base}/healthz`)).json();
    for (const key of ['uniqueVisitorStore', 'maintenanceStore', 'newsStore', 'sourceStore', 'overrideStore']) {
      assert.equal(health[key], 'redis', `${key}=${health[key]}`);
    }

    const hidden = await fetch(`${base}/selfcheck`);
    assert.equal(hidden.status, 404);
    const selfcheck = await fetch(`${base}/selfcheck?token=${selfcheckToken}`);
    const selfcheckText = await selfcheck.text();
    assert.equal(selfcheck.status, 200, selfcheckText);
    const report = JSON.parse(selfcheckText);
    assert.equal(report.ok, true);
    assert.ok(report.checks.some(check => check.name === 'durableStore' && check.ok));
    assert.ok(report.checks.some(check => check.name === 'streamTargets' && check.ok));
    assert.ok(commands >= 10, `expected startup hydration commands, got ${commands}`);

    console.log(`Redis production integration passed (${commands} RESP commands)`);
  } finally {
    if (child && child.exitCode === null) child.kill('SIGTERM');
    if (child) await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); resolve(); }, 5_000))
    ]);
    await new Promise(resolve => redisServer.close(resolve));
  }
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
