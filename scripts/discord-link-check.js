#! /usr/bin/env node
'use strict';

/* Exercises the whole link lifecycle the way the site and the bot drive it:
   mint a code, let the bot claim it, poll from the site, confirm, then revoke
   and prove every browser loses access. Run: npm run check:discord          */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { createStore, CODE_TTL_MS } = require('../lib/discord-link.js');

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then((ok) => { results.push({ name, ok: ok === true, detail: ok === true ? '' : String(ok) }); })
    .catch((error) => { results.push({ name, ok: false, detail: error.message }); });
}

function tmpStore(overrides = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dl-')), 'link.json');
  return createStore({
    fileKey: file,
    secret: 'test-secret-for-checks-only',
    log: () => {},
    now: overrides.now || (() => Date.now()),
    ...overrides,
  });
}

const USER = { id: '123456789012345678', username: 'doggomc', globalName: 'Doggo', avatar: 'https://cdn.example/a.png', guildId: '999' };

function req(cookie) { return { headers: { cookie } }; }

(async () => {
  /* ── 1. the happy path: code -> claim -> confirm -> cookie ─────────────── */
  let store;
  let code;
  await check('createCode returns a 5-character code', async () => {
    store = tmpStore();
    const out = await store.createCode();
    code = out.code;
    if (!/^[A-HJ-NP-Z2-9]{5}$/.test(code)) return `bad shape: ${code}`;
    if (!out.expiresAt) return 'no expiry';
    return true;
  });

  await check('codes are unique across many draws', async () => {
    const seen = new Set();
    for (let i = 0; i < 300; i += 1) seen.add((await store.createCode()).code);
    return seen.size === 300 || `${seen.size}/300 unique`;
  });

  await check('a fresh code is pending', async () => {
    const st = await store.status(code);
    return st.state === 'pending' || st.state;
  });

  await check('claiming an unknown code is refused', async () => {
    const r = await store.claimCode('ZZZZZ', USER);
    return r.error ? true : 'accepted a code that was never issued';
  });

  await check('confirming before any claim is refused', async () => {
    const r = await store.confirm(code, true);
    return r.error ? true : 'confirmed an unclaimed code';
  });

  await check('the bot can claim the code', async () => {
    const r = await store.claimCode(code, USER);
    return r.ok === true || JSON.stringify(r);
  });

  await check('claiming is case- and space-insensitive', async () => {
    const s2 = tmpStore();
    const c = (await s2.createCode()).code;
    const r = await s2.claimCode(`  ${c.toLowerCase()} `, USER);
    return r.ok === true || JSON.stringify(r);
  });

  await check('status reports the claim with the profile', async () => {
    const st = await store.status(code);
    if (st.state !== 'claimed') return st.state;
    if (st.profile.id !== USER.id) return 'wrong profile';
    if (st.profile.globalName !== USER.globalName) return 'wrong name';
    return true;
  });

  await check('a second claim of the same code is refused', async () => {
    const r = await store.claimCode(code, { ...USER, id: '111111111111111111' });
    return r.error ? true : 'allowed the code to be stolen mid-flow';
  });

  let token;
  await check('confirming issues a cookie token', async () => {
    const r = await store.confirm(code, true);
    if (!r.ok) return JSON.stringify(r);
    token = r.token;
    return typeof token === 'string' && token.includes('.');
  });

  await check('the code cannot be reused after confirming', async () => {
    const st = await store.status(code);
    return st.state === 'unknown' || st.state;
  });

  await check('that cookie passes the request check', async () => {
    const access = await store.checkRequest(req(`freef1.link=${encodeURIComponent(token)}`));
    if (!access.linked) return access.reason;
    return access.profile.id === USER.id || 'wrong user';
  });

  await check('the cookie travels alongside other cookies', async () => {
    const access = await store.checkRequest(req(`a=1; freef1.link=${encodeURIComponent(token)}; b=2`));
    return access.linked === true || access.reason;
  });

  /* ── 2. the server-side gate this feeds ────────────────────────────────── */
  await check('no cookie means no access', async () => {
    const access = await store.checkRequest(req('a=1'));
    return access.linked === false && access.reason === 'no-link';
  });

  await check('a tampered cookie is rejected', async () => {
    const access = await store.checkRequest(req(`freef1.link=${encodeURIComponent(token.slice(0, -3) + 'AAA')}`));
    return access.linked === false && access.reason === 'bad-link';
  });

  await check('a cookie signed with the wrong secret is rejected', async () => {
    const forged = createStore({ secret: 'a-different-secret' });
    const mine = tmpStore();
    const c = (await mine.createCode()).code;
    await mine.claimCode(c, USER);
    const { token: t } = await mine.confirm(c, true);
    const payload = await forged.readToken(t);
    return payload === null || 'forged token verified';
  });

  /* ── 3. /unlink revokes every browser at once ──────────────────────────── */
  await check('revoke reports the account was linked', async () => {
    const r = await store.revoke(USER.id);
    return r.wasLinked === true || JSON.stringify(r);
  });

  await check('after /unlink the same cookie is refused', async () => {
    const access = await store.checkRequest(req(`freef1.link=${encodeURIComponent(token)}`));
    return access.linked === false && access.reason === 'revoked';
  });

  await check('revoke is idempotent', async () => {
    const r = await store.revoke(USER.id);
    return r.wasLinked === false || JSON.stringify(r);
  });

  await check('a second browser holding the same account also loses access', async () => {
    // Same Discord account linked from a different browser: its own token,
    // issued by that browser's own confirm, must die with the account too.
    const c2 = (await store.createCode()).code;
    await store.claimCode(c2, USER);
    const r2 = await store.confirm(c2, true);
    const before = await store.checkRequest(req(`freef1.link=${encodeURIComponent(r2.token)}`));
    await store.revoke(USER.id);
    const after = await store.checkRequest(req(`freef1.link=${encodeURIComponent(r2.token)}`));
    return (before.linked === true && after.linked === false) || `before=${before.linked} after=${after.linked}`;
  });

  await check('unlinking kills a code that was mid-flight', async () => {
    const c3 = (await store.createCode()).code;
    await store.claimCode(c3, { ...USER, id: '222222222222222222' });
    await store.revoke('222222222222222222');
    const st = await store.status(c3);
    return st.state === 'unknown' || st.state;
  });

  /* ── 4. expiry ─────────────────────────────────────────────────────────── */
  await check('a code expires after the 30-minute window', async () => {
    let t = 1_000_000_000_000;
    const s = tmpStore({ now: () => t });
    const c = (await s.createCode()).code;
    t += CODE_TTL_MS - 1000;
    const mid = await s.status(c);
    t += 2000;
    const late = await s.status(c);
    return (mid.state === 'pending' && late.state === 'expired') || `mid=${mid.state} late=${late.state}`;
  });

  await check('claiming an expired code is refused', async () => {
    let t = 1_000_000_000_000;
    const s = tmpStore({ now: () => t });
    const c = (await s.createCode()).code;
    t += CODE_TTL_MS + 1000;
    const r = await s.claimCode(c, USER);
    return r.error ? true : 'claimed an expired code';
  });

  /* ── 5. declining, and bad input ───────────────────────────────────────── */
  await check('declining clears the code', async () => {
    const s = tmpStore();
    const c = (await s.createCode()).code;
    await s.claimCode(c, USER);
    const r = await s.confirm(c, false);
    if (r.ok !== false) return JSON.stringify(r);
    return (await s.status(c)).state === 'unknown';
  });

  await check('a profile without a snowflake id is refused', async () => {
    const s = tmpStore();
    const c = (await s.createCode()).code;
    const r = await s.claimCode(c, { id: 'not-a-snowflake', username: 'x' });
    return r.error ? true : 'accepted a malformed id';
  });

  await check('the cookie is HttpOnly, Path=/ and SameSite=None when secure', async () => {
    const v = store.cookieValue(token, { secure: true });
    const ok = v.includes('HttpOnly') && v.includes('Path=/') && v.includes('SameSite=None') && v.includes('Secure');
    return ok || v;
  });

  await check('clearing the cookie expires it immediately', async () => {
    const v = store.clearedCookie({ secure: true });
    return (v.includes('Max-Age=0') && v.includes('freef1.link=;')) || v;
  });

  /* ── 6. it survives a restart ──────────────────────────────────────────── */
  await check('a link survives a process restart (durable store)', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dl-')), 'link.json');
    const first = createStore({ fileKey: file, secret: 's', log: () => {}, writeLocalJson: (f, v) => { fs.writeFileSync(f, JSON.stringify(v)); return true; }, readLocalJson: (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null) });
    const c = (await first.createCode()).code;
    await first.claimCode(c, USER);
    const { token: t } = await first.confirm(c, true);
    await first.flush();

    const second = createStore({ fileKey: file, secret: 's', log: () => {}, readLocalJson: (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null) });
    const access = await second.checkRequest(req(`freef1.link=${encodeURIComponent(t)}`));
    return access.linked === true || access.reason;
  });

  /* ── report ────────────────────────────────────────────────────────────── */
  const passed = results.filter((r) => r.ok).length;
  console.log('');
  for (const r of results) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  -> ${r.detail}` : ''}`);
  }
  console.log(`\n  ${passed}/${results.length} discord-link checks passed\n`);
  process.exit(passed === results.length ? 0 : 1);
})();
