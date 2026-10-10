#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDurableStore, normalizeCommand } = require('../lib/durable-store.js');
const { createClientIpResolver, isPrivateIp, normalizeIp } = require('../lib/client-ip.js');
const { createOriginPolicy, normalizeOrigin, parseOrigins } = require('../lib/origin-policy.js');
const { findIndex, resolveSiteDirectory } = require('../lib/site-paths.js');
const { validateTargetMap } = require('../lib/stream-catalog.js');
const { classifyStreamUrl } = require('../lib/stream-url.js');
const { createTicketService } = require('../lib/tickets.js');
const { parseUserAgent } = require('../lib/user-agent.js');

let passed = 0;
const pending = [];
function check(label, fn) {
  fn();
  passed++;
  console.log(`  ok    ${label}`);
}
function checkAsync(label, fn) {
  pending.push(Promise.resolve().then(fn).then(() => {
    passed++;
    console.log(`  ok    ${label}`);
  }));
}

check('durable-store commands reject an empty command', () => {
  assert.throws(() => normalizeCommand([]), /non-empty/);
  assert.deepEqual(normalizeCommand(['SET', 'key', 4]), ['SET', 'key', '4']);
});

checkAsync('standard Redis transport connects, commands, pipelines and closes', async () => {
  const fake = {
    isReady: false,
    isOpen: false,
    on() { return this; },
    async connect() { this.isOpen = true; this.isReady = true; },
    async sendCommand(command) { return command.join(':'); },
    multi() {
      const commands = [];
      return {
        addCommand(command) { commands.push(command); return this; },
        async exec() { return commands.map(command => command.join(':')); }
      };
    },
    async close() { this.isReady = false; this.isOpen = false; },
    destroy() { this.isReady = false; this.isOpen = false; }
  };
  const store = createDurableStore({
    redisUrl: 'rediss://unit.test:6380',
    createRedisClient: () => fake,
    timeoutMs: 500
  });
  assert.equal(store.provider, 'redis');
  assert.deepEqual(await store.command(['GET', 'key']), { result: 'GET:key' });
  assert.deepEqual(await store.command([['SET', 'key', 'value'], ['GET', 'key']]),
    [{ result: 'SET:key:value' }, { result: 'GET:key' }]);
  await store.close();
  assert.equal(fake.isOpen, false);
});

check('client IP resolver trusts an edge header only behind a private socket', () => {
  const resolve = createClientIpResolver({ headerName: 'cf-connecting-ip' });
  assert.equal(resolve({
    socket: { remoteAddress: '10.0.0.2' },
    headers: { 'cf-connecting-ip': '203.0.113.8' },
    ip: '10.0.0.2'
  }), '203.0.113.8');
  assert.equal(resolve({
    socket: { remoteAddress: '8.8.8.8' },
    headers: { 'cf-connecting-ip': '203.0.113.9' },
    ip: '8.8.8.8'
  }), '8.8.8.8');
  assert.equal(isPrivateIp('192.168.4.2'), true);
  assert.equal(normalizeIp('::ffff:41.1.2.3'), '41.1.2.3');
});

check('origin normalization removes paths and duplicate values', () => {
  assert.equal(normalizeOrigin('https://example.com/path'), 'https://example.com');
  assert.deepEqual(parseOrigins('https://a.example/, https://b.example/x'),
    ['https://a.example', 'https://b.example']);
});

check('origin policy accepts only the configured Netlify site and its previews', () => {
  const policy = createOriginPolicy({
    authorizedHostname: 'freef1.netlify.app',
    allowedOrigins: ['https://freef1.netlify.app'],
    production: true
  });
  const req = { headers: { host: 'api.example' }, protocol: 'https' };
  assert.equal(policy.isAllowedOrigin(req, 'https://freef1.netlify.app'), true);
  assert.equal(policy.isAllowedOrigin(req, 'https://deploy-preview-7--freef1.netlify.app'), true);
  assert.equal(policy.isAllowedOrigin(req, 'https://freef1.netlify.app.evil.test'), false);
});

check('site-path resolver finds a nested deploy directory', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'freef1-paths-'));
  try {
    const nested = path.join(scratch, 'publish');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, 'index.html'), 'ok');
    assert.equal(resolveSiteDirectory('', [scratch]), scratch);
    assert.equal(findIndex(scratch), path.join(nested, 'index.html'));
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

check('stream catalog validates ids, HTTPS and template fields', () => {
  const good = validateTargetMap({ f1tv: 'https://video.example/{season}/{eventSlug}' });
  assert.equal(good.errors.length, 0);
  assert.ok(good.targets.has('f1tv'));
  const bad = validateTargetMap({ unknown: 'https://example.test', f1tv: 'http://example.test/{oops}' });
  assert.equal(bad.targets.size, 0);
  assert.equal(bad.errors.length, 2);
});

check('stream URL classifier rejects private production targets', () => {
  assert.deepEqual(classifyStreamUrl('http://127.0.0.1/video', { rejectPrivateHosts: true }),
    { type: null, embedUrl: null });
  assert.equal(classifyStreamUrl('https://youtu.be/dQw4w9WgXcQ').type, 'youtube');
  assert.equal(classifyStreamUrl('https://cdn.example/video.mp4').type, 'mp4');
});

check('ticket kinds cannot be substituted or tampered with', () => {
  let now = 1_000;
  const service = createTicketService({
    secret: 'unit-test-secret',
    allowedSourceIds: new Set(['sky']),
    now: () => now,
    randomBytes: size => Buffer.alloc(size, 7)
  });
  const stream = service.createStream('sky', 100);
  assert.equal(service.verifyStream(stream).sourceId, 'sky');
  assert.equal(service.verifySite(stream), null);
  assert.equal(service.verifyStream(stream.slice(0, -1) + 'x'), null);
  now = 1_101;
  assert.equal(service.verifyStream(stream).expired, true);
});

check('user-agent parser distinguishes mobile Safari and desktop Chrome', () => {
  assert.equal(parseUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1').deviceType, 'Mobile');
  assert.match(parseUserAgent('Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0.0.0 Safari/537.36').browser, /^Chrome/);
});

Promise.all(pending)
  .then(() => console.log(`\n${passed}/${passed} module checks passed`))
  .catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
