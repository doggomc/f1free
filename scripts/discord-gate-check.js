/* Verifies the Discord wall against a running server, end to end.
 *
 *   node scripts/discord-gate-check.js [baseUrl]
 *
 * The server must be started with DISCORD_LINK_SECRET set to the same value
 * this script signs with (or ADMIN_SECRET, if that is what it fell back to).
 * It seeds nothing and mutates nothing: it mints its own link cookie rather
 * than depending on a claim, so it is safe to point at a live server. */

const crypto = require('crypto');

const BASE = (process.argv[2] || process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const SECRET = process.env.DISCORD_LINK_SECRET || process.env.ADMIN_SECRET || 'freef1-admin-secret-change-me';
const ORIGIN = process.env.ALLOWED_ORIGIN ? process.env.ALLOWED_ORIGIN.split(',')[0].trim() : new URL(BASE).origin;
const RELAY = 'cdnlivetv-f1';

const b64u = (b) => Buffer.from(b).toString('base64url');
const linkCookie = (uid) => {
  const p = b64u(JSON.stringify({ uid: String(uid), iat: 1 }));
  return `${p}.${b64u(crypto.createHmac('sha256', SECRET).update(p).digest())}`;
};

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -> ' + detail : ''}`);
};

async function siteTicket() {
  const r = await fetch(`${BASE}/api/site/ticket`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Referer: ORIGIN + '/' },
    body: '{}',
  });
  const j = await r.json().catch(() => ({}));
  return j.ticket || '';
}

async function api(path, { ticket, cookie, method = 'GET', body } = {}) {
  const headers = { Origin: ORIGIN, Referer: ORIGIN + '/' };
  if (ticket) headers['X-Site-Ticket'] = ticket;
  if (cookie) headers['Cookie'] = `freef1.link=${cookie}`;
  if (body) headers['Content-Type'] = 'application/json';
  return fetch(BASE + path, { method, headers, body, redirect: 'manual' });
}

(async () => {
  console.log(`discord gate — ${BASE}\n`);
  const ticket = await siteTicket();
  if (!ticket) {
    console.log('FAIL  could not mint a site ticket — is the server up, and is\n' +
                `      ${ORIGIN} an allowed origin?`);
    process.exit(1);
  }

  const unlinked = null;
  const linked = linkCookie('123456789012345678');

  // ---- unlinked ----------------------------------------------------------
  const meNone = await api('/api/discord/me', { ticket });
  check('unlinked: /api/discord/me reports unlinked',
    meNone.status === 200 && (await meNone.json()).linked === false,
    `status=${meNone.status}`);

  const tNone = await api('/api/stream/ticket', { ticket, method: 'POST',
    body: JSON.stringify({ sourceId: RELAY }) });
  check(`unlinked: ticket for ${RELAY} is refused`,
    tNone.status === 403 && (await tNone.json().catch(() => ({}))).error === 'discord-required',
    `status=${tNone.status}`);

  const forgery = linked.slice(0, -3) + 'AAA';
  const meForged = await api('/api/discord/me', { ticket, cookie: forgery });
  check('a tampered link cookie is ignored',
    (await meForged.json()).linked === false, `status=${meForged.status}`);

  const relayNone = await api('/relay/cdnlivetv/m3u8', { cookie: unlinked });
  check('unlinked: the playlist itself is refused',
    relayNone.status === 403, `status=${relayNone.status}`);

  // ---- linked ------------------------------------------------------------
  const meOk = await api('/api/discord/me', { ticket, cookie: linked });
  check('linked: /api/discord/me reports the account',
    meOk.status === 200 && (await meOk.json()).linked === true, `status=${meOk.status}`);

  const tOk = await api('/api/stream/ticket', { ticket, cookie: linked, method: 'POST',
    body: JSON.stringify({ sourceId: RELAY }) });
  const tj = await tOk.json().catch(() => ({}));
  check(`linked: ticket for ${RELAY} is issued`,
    tOk.status === 200 && typeof tj.href === 'string' && tj.href.startsWith('/stream/'),
    `status=${tOk.status}`);

  if (tj.href) {
    const player = await api(tj.href, { cookie: linked });
    check('linked: the player page is served',
      player.status === 200 && (await player.text()).includes('hls.js') !== null,
      `status=${player.status}`);

    /* The player page is framed cross-site, and iOS/Safari block third-party
       cookies there, so access rides in the SIGNED TICKET (its `u` claim)
       rather than the cookie. Replaying the page without the cookie is
       therefore meant to work — asserting 403 here would be asserting the
       bug. What must be refused is a ticket that is not ours. */
    const replay = await api(tj.href, { cookie: null });
    check('the player page still plays without the cookie (uid is in the ticket)',
      replay.status === 200, `status=${replay.status}`);

    const forged = await api(tj.href.replace(/\/stream\/.+$/, '/stream/' + b64u(JSON.stringify({ u: '123456789012345678', sourceId: RELAY, exp: Date.now() + 60000 }))));
    check('a forged player-page ticket is refused',
      forged.status === 403, `status=${forged.status}`);

    const expired = await api(tj.href.replace(/\/stream\/.+$/, '/stream/' + tj.href.split('/stream/')[1]));
    check('the real player-page ticket is accepted',
      expired.status === 200, `status=${expired.status}`);

    const gone = await api('/stream/not-a-real-ticket');
    check('a malformed player-page ticket is refused',
      gone.status === 403, `status=${gone.status}`);
  }

  const relayOk = await api('/relay/cdnlivetv/m3u8', { cookie: linked });
  check('linked: the playlist is served',
    relayOk.status === 200, `status=${relayOk.status}`);

  // ---- a non-gated source must be untouched ------------------------------
  const tFree = await api('/api/stream/ticket', { ticket, method: 'POST',
    body: JSON.stringify({ sourceId: 'sky-sports-f1' }) });
  const jf = await tFree.json().catch(() => ({}));
  check('a non-gated source still needs no Discord link',
    tFree.status === 200 && typeof jf.href === 'string', `status=${tFree.status}`);

  console.log(`\n  ${pass}/${pass + fail} HTTP gate checks passed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('gate check crashed:', e.message); process.exit(1); });
