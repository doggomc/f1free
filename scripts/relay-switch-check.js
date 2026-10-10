/* The relay kill switch (RELAYS_ENABLED) end to end, across a restart.
 *
 *   node scripts/relay-switch-check.js
 *
 * Proves that with relays OFF (the default):
 *   - visitors see both relay feeds as disabled, so the site hides their buttons
 *   - the relay playlist and ticket answer 503 and touch no upstream
 *   - the admin panel still sees exactly what the admin set
 *   - an admin toggle never saves the relay feeds as disabled
 * and that after a restart with RELAYS_ENABLED=1 the relay feeds come straight
 * back, with the admin's own toggle preserved.
 *
 * Spawns its own servers on scratch ports against a scratch data dir. */
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-switch-'));
const SITE_ORIGIN = 'https://freef1.netlify.app';
const RELAYS = ['cdnlivetv-f1', 'strmfree-f1'];

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -> ' + detail : ''}`);
};

function boot(extraEnv) {
  const port = 35100 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port), DATA_DIR, ADMIN_DIR: path.join(ROOT, 'admin'),
      ADMIN_USER: 'admin', ADMIN_PASS: 'admin', ADMIN_SECRET: 'relay-switch-secret',
      VISITOR_SECRET: 'relay-switch-visitor', GEO_ENABLED: 'false', GEO_API: 'http://127.0.0.1:9',
      UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '', NODE_ENV: 'test',
      ALLOWED_ORIGIN: SITE_ORIGIN, DISCORD_LINK_REQUIRED: '0',
      RELAYS_ENABLED: '', ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  return { child, base: `http://127.0.0.1:${port}`, port, log: () => log };
}

async function ready(srv) {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(srv.base + '/healthz')).ok) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start:\n' + srv.log());
}

async function stop(srv) {
  srv.child.kill('SIGTERM');
  await new Promise((r) => srv.child.once('exit', r));
}

async function siteTicket(srv) {
  const r = await fetch(`${srv.base}/api/site/ticket`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: SITE_ORIGIN, Referer: SITE_ORIGIN + '/' },
    body: '{}',
  });
  return (await r.json()).ticket;
}

async function publicSources(srv) {
  const r = await fetch(`${srv.base}/api/stream/sources`, {
    headers: { Origin: SITE_ORIGIN, 'X-Site-Ticket': await siteTicket(srv) },
  });
  return r.json();
}

async function adminLogin(srv) {
  const r = await fetch(`${srv.base}/admin/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: srv.base },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  assert.equal(r.status, 200, `admin login: ${r.status}`);
  return r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

(async () => {
  console.log('relay switch check\n');
  let srv = boot({});
  try {
    await ready(srv);
    // ── relays OFF (default: variable absent) ──────────────────────────────
    const pub = await publicSources(srv);
    check('OFF: visitors see both relay feeds as disabled',
      RELAYS.every((id) => pub.disabled.includes(id)), pub.disabled.join(', '));

    const t = await siteTicket(srv);
    const tk = await fetch(`${srv.base}/api/stream/ticket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: SITE_ORIGIN, Referer: SITE_ORIGIN + '/', 'X-Site-Ticket': t },
      body: JSON.stringify({ sourceId: 'strmfree-f1' }),
    });
    check('OFF: relay stream ticket answers 503', tk.status === 503, `status=${tk.status}`);
    const pl = await fetch(`${srv.base}/relay/strmfree/m3u8`);
    check('OFF: relay playlist answers 503', pl.status === 503, `status=${pl.status}`);

    const cookie = await adminLogin(srv);
    const adm = await (await fetch(`${srv.base}/admin/api/stream/sources`, { headers: { cookie, origin: srv.base } })).json();
    check('OFF: admin panel sees only what the admin set (no relay ids forced in)',
      Array.isArray(adm.disabled) && RELAYS.every((id) => !adm.disabled.includes(id)), JSON.stringify(adm.disabled));

    // Admin switches DAZN off. Exactly what the panel sends: the full list.
    const post = await fetch(`${srv.base}/admin/api/stream/sources`, {
      method: 'POST',
      headers: { cookie, origin: srv.base, 'content-type': 'application/json' },
      body: JSON.stringify({ disabled: [...adm.disabled, 'dazn'] }),
    });
    const postBody = await post.json();
    check('OFF: admin toggle succeeds', post.status === 200 && postBody.success === true, `status=${post.status}`);
    check('OFF: admin toggle reply does not echo relay ids back to the panel',
      RELAYS.every((id) => !postBody.disabled.includes(id)), JSON.stringify(postBody.disabled));

    const saved = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'stream-sources.json'), 'utf8'));
    check('OFF: saved config holds the admin toggle and NOT the relay ids',
      saved.disabled.includes('dazn') && RELAYS.every((id) => !saved.disabled.includes(id)), JSON.stringify(saved.disabled));

    const pub2 = await publicSources(srv);
    check('OFF: visitors see DAZN + both relays disabled',
      ['dazn', ...RELAYS].every((id) => pub2.disabled.includes(id)), pub2.disabled.join(', '));
    await stop(srv);

    // ── restart with relays ON ─────────────────────────────────────────────
    srv = boot({ RELAYS_ENABLED: '1' });
    await ready(srv);
    const pub3 = await publicSources(srv);
    check('ON after restart: relay feeds are back for visitors',
      RELAYS.every((id) => !pub3.disabled.includes(id)), pub3.disabled.join(', ') || '(none disabled)');
    check("ON after restart: the admin's DAZN toggle survived", pub3.disabled.includes('dazn'), pub3.disabled.join(', '));
    const pl2 = await fetch(`${srv.base}/relay/strmfree/m3u8`);
    check('ON: relay playlist is no longer the 503 kill switch', pl2.status !== 503, `status=${pl2.status}`);
  } catch (error) {
    check('relay switch scenario ran', false, error.stack || String(error));
  } finally {
    try { await stop(srv); } catch (_) {}
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(`\n  ${pass}/${pass + fail} relay-switch checks passed`);
  process.exit(fail ? 1 : 0);
})();
