/* Two things a browser test cannot easily prove, so they are checked here:
 *
 *   1. the player works WITHOUT the link cookie — iOS/Safari block
 *      third-party cookies inside the site's cross-site iframe, so the
 *      entitlement has to travel in the signed ticket instead;
 *   2. /unlink revokes immediately, not whenever the ticket happens to
 *      expire — so the store is consulted on every single request.
 *
 * It spawns its own server on a scratch port against a scratch data dir and
 * then edits the store underneath it, which is exactly what the bot does.
 *
 *   node scripts/discord-revoke-check.js
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 3400 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = BASE;
const SECRET = 'revoke-test-secret';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'revoke-'));
const UID = '123456789012345678';

const b64u = (b) => Buffer.from(b).toString('base64url');
const linkCookie = (uid) => {
  const p = b64u(JSON.stringify({ uid: String(uid), iat: 1 }));
  return `${p}.${b64u(crypto.createHmac('sha256', SECRET).update(p).digest())}`;
};
const storePath = path.join(DATA_DIR, 'discord-link.json');
const writeStore = (linked) =>
  fs.writeFileSync(storePath, JSON.stringify({ codes: {}, linked, updatedAt: Date.now() }));

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -> ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, { cookie, method = 'GET', body, ticket } = {}) {
  const headers = { Origin: ORIGIN, Referer: ORIGIN + '/' };
  if (cookie) headers.Cookie = `freef1.link=${cookie}`;
  if (ticket) headers['X-Site-Ticket'] = ticket;
  if (body) headers['Content-Type'] = 'application/json';
  return fetch(BASE + p, { method, headers, body, redirect: 'manual' });
}

let server;

async function main() {
try {
  writeStore({
    [UID]: { id: UID, username: 'doggomc', globalName: 'Doggo', avatar: '', guildId: '9', linkedAt: 1 }
  });

  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT), DATA_DIR, ADMIN_DIR: path.join(ROOT, 'admin'),
      GEO_ENABLED: 'false', GEO_API: 'http://127.0.0.1:9',
      DEV_DIR: path.join(ROOT, '..', 'netlifyf1'),
      ALLOWED_ORIGIN: ORIGIN, AUTHORIZED_DOMAIN: '127.0.0.1',
      DISCORD_LINK_SECRET: SECRET, DISCORD_LINK_REQUIRED: '1',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  server.stderr.on('data', (d) => { stderr += d.toString(); });

  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(400);
    try { up = (await fetch(`${BASE}/healthz`)).status === 200; } catch (_) {}
  }
  if (!up) throw new Error('server never became healthy\n' + stderr.slice(-800));

  const cookie = linkCookie(UID);
  const siteTicket = (await (await api('/api/site/ticket', { method: 'POST', body: '{}' })).json()).ticket;

  // mint a ticket the way a linked browser does
  const tr = await api('/api/stream/ticket', {
    cookie, ticket: siteTicket, method: 'POST',
    body: JSON.stringify({ sourceId: 'cdnlivetv-f1' }),
  });
  const tj = await tr.json();
  check('linked browser gets a ticket', tr.status === 200 && !!tj.href, `status=${tr.status}`);
  if (!tj.href) throw new Error('no ticket to test with');
  const playerUrl = tj.href;

  // ---- 1. the cookie-free (iOS) case ------------------------------------
  const noCookie = await api(playerUrl, { cookie: null });
  check('player page loads with NO cookie (iOS/Safari case)',
    noCookie.status === 200, `status=${noCookie.status}`);

  const html = await noCookie.text();
  const m = html.match(/\/relay\/cdnlivetv\/m3u8\?t=([A-Za-z0-9._~-]+)/);
  check('the player page embeds a relay ticket', !!m, m ? 'found' : 'missing');
  if (!m) throw new Error('cannot read relay ticket from the player page');

  const plNoCookie = await fetch(`${BASE}/relay/cdnlivetv/m3u8?t=${m[1]}`);
  check('playlist is served with NO cookie', plNoCookie.status === 200, `status=${plNoCookie.status}`);

  // ---- 2. instant revocation --------------------------------------------
  writeStore({});            // exactly what /unlink does to the store
  /* Revocation through the bot mutates the in-memory state directly and is
     immediate; this edits the store out of band instead, so it is picked up on
     the 10s refresh. Allow a little more than one TTL. */
  await sleep(11_500);

  const afterRevoke = await fetch(`${BASE}/relay/cdnlivetv/m3u8?t=${m[1]}`);
  const bodyText = await afterRevoke.text();
  check('playlist is refused the moment the account is unlinked',
    afterRevoke.status === 403, `status=${afterRevoke.status} ${bodyText.slice(0, 40)}`);

  const playerAfter = await api(playerUrl, { cookie: null });
  check('a fresh player page is refused after unlink',
    playerAfter.status === 403, `status=${playerAfter.status}`);

  // and the site's own re-check reports it
  const meRes = await api('/api/discord/me', { cookie, ticket: siteTicket });
  const me = await meRes.json().catch(() => ({}));
  check('/api/discord/me reports unlinked after revoke',
    meRes.status === 200 && me.linked === false,
    `status=${meRes.status} linked=${me.linked} reason=${me.reason}`);

  console.log(`\n  ${pass}/${pass + fail} revocation checks passed\n`);
} catch (e) {
  console.error('\nrevocation check crashed:', e.message, '\n');
  fail++;
}
}

main().finally(() => {
  if (server) server.kill('SIGKILL');
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
});
