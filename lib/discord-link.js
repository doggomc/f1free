'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   Discord account linking for the gated relay source.

   A browser proves it belongs to a Discord account like this:

     1. the site asks for a code        -> createCode()      -> "9AH7G"
     2. the user runs /link 9AH7G in a #link channel
     3. the bot hands us the author     -> claimCode()       -> profile attached
     4. the site polls and shows it     -> status()          -> "is this you?"
     5. the user confirms               -> confirm(yes)      -> signed cookie

   The cookie says "this browser is Discord user X". The accounts table says
   whether Discord user X is still linked. /unlink deletes the row, so every
   browser holding a cookie for X loses access at once — which is the point:
   the entitlement lives on the Discord account, not on the browser. That is
   also why the same account can be linked from any number of browsers.

   Nothing here is a security boundary on its own; it is a speed bump that
   costs a would-be scraper a Discord account per stream.
   ───────────────────────────────────────────────────────────────────────────── */

const crypto = require('crypto');

/* No I, O, 0 or 1 — these get read off a phone screen and typed by hand. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;
const CODE_TTL_MS = 30 * 60 * 1000;          // 30 minutes, per the product decision
const CODE_MAX_ATTEMPTS = 40;                // give up rather than spin forever
const MAX_PENDING_CODES = 5000;              // bound a flooding attempt
const LINK_COOKIE = 'freef1.link';
const LINK_COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;   // 1 year; revoked by /unlink, not by time

function randomCode() {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return out;
}

function safeProfile(input) {
  if (!input || typeof input !== 'object') return null;
  const id = String(input.id || '').trim();
  if (!/^\d{5,25}$/.test(id)) return null;             // Discord snowflakes only
  return {
    id,
    username: String(input.username || '').slice(0, 64),
    globalName: String(input.globalName || input.displayName || '').slice(0, 64),
    avatar: String(input.avatar || '').slice(0, 256),
    guildId: String(input.guildId || '').slice(0, 32),
  };
}

/* Deterministic, keyed, and constant-time-ish: the cookie is a bearer token. */
function sign(payloadObj, secret) {
  const body = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function unsign(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const cut = token.lastIndexOf('.');
  const body = token.slice(0, cut);
  const mac = token.slice(cut + 1);
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
}

function emptyState() {
  return { codes: {}, linked: {}, updatedAt: Date.now() };
}

function createStore(options = {}) {
  const {
    readLocalJson = () => null,
    writeLocalJson = () => false,
    upstash = null,
    redisKey = 'freef1:discordlink:v1',
    fileKey = '',
    secret = 'insecure-default-secret',
    log = () => {},
    now = () => Date.now(),
  } = options;

  let state = emptyState();
  let saveChain = Promise.resolve();
  let loaded = false;

  /* The store is read once and then held in memory. Revocation by the bot
     mutates this very object (it runs in-process), so that is instant — but a
     change made anywhere else would never be seen, and a viewer would keep
     access to an account that was unlinked out of band.

     So re-read on a short TTL. Two guards: never while a write is still in
     flight, because replacing `state` mid-save would drop mutations that have
     not reached the store yet (a freshly minted code, an unflushed confirm);
     and never more often than the TTL, so this stays one cheap read. */
  const STATE_REFRESH_MS = 10_000;
  let loadedAt = 0;
  let writesInFlight = 0;

  async function load() {
    if (loaded && writesInFlight === 0 && (now() - loadedAt) < STATE_REFRESH_MS) return;
    loaded = true;
    loadedAt = now();
    try {
      if (upstash) {
        const payload = await upstash(['GET', redisKey]);
        const raw = payload && payload.result;
        if (raw) {
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (parsed && typeof parsed === 'object') state = Object.assign(emptyState(), parsed);
          return;
        }
      }
    } catch (error) {
      log('remote load failed, falling back to file:', error.message);
    }
    if (fileKey) {
      const parsed = readLocalJson(fileKey);
      if (parsed && typeof parsed === 'object') state = Object.assign(emptyState(), parsed);
    }
  }

  function save() {
    state.updatedAt = now();
    const snapshot = JSON.stringify(state);
    writesInFlight++;
    saveChain = saveChain.then(async () => {
      if (upstash) {
        try {
          await upstash(['SET', redisKey, snapshot]);
          return;
        } catch (error) {
          log('remote save failed, falling back to file:', error.message);
        }
      }
      if (fileKey) writeLocalJson(fileKey, state);
    }).catch((error) => log('save failed:', error.message))
      .finally(() => { writesInFlight = Math.max(0, writesInFlight - 1); });
    return saveChain;
  }

  function prune() {
    const t = now();
    let changed = false;
    for (const [code, entry] of Object.entries(state.codes)) {
      if (entry.expiresAt && entry.expiresAt < t) { delete state.codes[code]; changed = true; }
    }
    const codes = Object.keys(state.codes);
    if (codes.length > MAX_PENDING_CODES) {
      // Drop the oldest first so a flood cannot evict a code that is in use.
      const ordered = codes
        .map((c) => state.codes[c])
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      for (let i = 0; i < ordered.length - MAX_PENDING_CODES; i += 1) {
        delete state.codes[ordered[i].code];
        changed = true;
      }
    }
    return changed;
  }

  /* ── step 1: the browser asks for a code ───────────────────────────────── */
  async function createCode() {
    await load();
    prune();
    let code = null;
    for (let i = 0; i < CODE_MAX_ATTEMPTS; i += 1) {
      const candidate = randomCode();
      if (!state.codes[candidate]) { code = candidate; break; }
    }
    if (!code) return { error: 'Could not allocate a code. Try again.' };
    const createdAt = now();
    state.codes[code] = { code, createdAt, expiresAt: createdAt + CODE_TTL_MS, state: 'pending', discord: null };
    await save();
    return { code, expiresAt: state.codes[code].expiresAt };
  }

  /* ── step 3: the bot reports who typed it ──────────────────────────────── */
  async function claimCode(code, rawProfile) {
    await load();
    const key = String(code || '').trim().toUpperCase();
    const entry = state.codes[key];
    if (!entry) return { error: 'That code is not recognised. Check it and try again.' };
    if (entry.expiresAt && entry.expiresAt < now()) {
      delete state.codes[key];
      await save();
      return { error: 'That code has expired. Generate a new one on the site.' };
    }
    if (entry.state === 'confirmed') return { error: 'That code has already been used.' };
    const profile = safeProfile(rawProfile);
    if (!profile) return { error: 'Could not read your Discord account details.' };
    /* Once a member has claimed a code it is theirs alone. Without this a
       second member typing the same code — visible in an ephemeral reply but
       not private — could take over the link mid-confirmation. Re-running
       your own code is harmless and stays allowed. */
    if (entry.state === 'claimed' && entry.discord && entry.discord.id !== profile.id) {
      return { error: 'That code has already been claimed by someone else.' };
    }
    entry.state = 'claimed';
    entry.discord = profile;
    entry.claimedAt = now();
    await save();
    return { ok: true, code: key, profile };
  }

  /* ── step 4: the site polls ────────────────────────────────────────────── */
  async function status(code) {
    await load();
    const key = String(code || '').trim().toUpperCase();
    const entry = state.codes[key];
    if (!entry) return { state: 'unknown' };
    if (entry.expiresAt && entry.expiresAt < now()) return { state: 'expired' };
    return { state: entry.state, profile: entry.discord || null, expiresAt: entry.expiresAt };
  }

  /* ── step 5: the user says yes ─────────────────────────────────────────── */
  async function confirm(code, yes) {
    await load();
    const key = String(code || '').trim().toUpperCase();
    const entry = state.codes[key];
    if (!entry) return { error: 'That code is no longer valid.' };
    if (!yes) {
      delete state.codes[key];
      await save();
      return { ok: false, reason: 'declined' };
    }
    if (entry.state !== 'claimed' || !entry.discord) return { error: 'That code has not been linked in Discord yet.' };
    const profile = entry.discord;
    state.linked[profile.id] = { ...profile, linkedAt: now() };
    delete state.codes[key];
    await save();
    return { ok: true, profile, token: sign({ uid: profile.id, iat: now() }, secret) };
  }

  /* ── /unlink ──────────────────────────────────────────────────────────── */
  async function revoke(userId) {
    await load();
    const id = String(userId || '').trim();
    const had = Boolean(state.linked[id]);
    if (had) delete state.linked[id];
    // Drop any in-flight codes belonging to that account as well.
    for (const [code, entry] of Object.entries(state.codes)) {
      if (entry.discord && entry.discord.id === id) delete state.codes[code];
    }
    await save();
    return { ok: true, wasLinked: had };
  }

  async function isUserLinked(userId) {
    await load();
    return Boolean(state.linked[String(userId || '').trim()]);
  }

  async function linkedProfile(userId) {
    await load();
    return state.linked[String(userId || '').trim()] || null;
  }

  /* ── cookie ───────────────────────────────────────────────────────────── */
  function readToken(token) {
    const payload = unsign(token, secret);
    if (!payload || !payload.uid) return null;
    return payload;
  }

  function cookieValue(token, { secure }) {
    // SameSite=None is what lets the cookie ride along on both the cross-site
    // iframe request for /stream/<ticket> and the XHR from the Netlify site.
    const attrs = [
      `${LINK_COOKIE}=${token}`,
      'Path=/',
      'HttpOnly',
      `Max-Age=${LINK_COOKIE_MAX_AGE_S}`,
      secure ? 'Secure' : '',
      secure ? 'SameSite=None' : 'SameSite=Lax',
    ].filter(Boolean);
    return attrs.join('; ');
  }

  function clearedCookie({ secure }) {
    return [
      `${LINK_COOKIE}=`,
      'Path=/',
      'HttpOnly',
      'Max-Age=0',
      secure ? 'Secure' : '',
      secure ? 'SameSite=None' : 'SameSite=Lax',
    ].filter(Boolean).join('; ');
  }

  function parseCookies(header) {
    const out = {};
    if (!header) return out;
    for (const part of String(header).split(';')) {
      const idx = part.indexOf('=');
      if (idx < 1) continue;
      const name = part.slice(0, idx).trim();
      if (name === LINK_COOKIE) out[LINK_COOKIE] = decodeURIComponent(part.slice(idx + 1).trim());
    }
    return out;
  }

  /* The single question everything else asks: may this browser play the
     gated source? True only when the cookie is authentic AND the account it
     names is still in the table — so /unlink revokes every browser at once. */
  async function checkRequest(req) {
    await load();
    const token = parseCookies(req && req.headers && req.headers.cookie)[LINK_COOKIE];
    if (!token) return { linked: false, reason: 'no-link' };
    const payload = readToken(token);
    if (!payload) return { linked: false, reason: 'bad-link' };
    const profile = state.linked[payload.uid];
    if (!profile) return { linked: false, reason: 'revoked' };
    return { linked: true, profile, userId: payload.uid };
  }

  /* Same check as checkRequest, but for a uid that arrived inside a ticket
     this server signed rather than in a cookie. The player is framed
     cross-site, and iOS/Safari block third-party cookies there, so the cookie
     frequently never reaches it — a signed ticket always does. The store is
     still consulted on every call, so /unlink revokes at once. */
  async function checkUid(uid) {
    await load();
    const key = String(uid || '').trim();
    if (!key) return { linked: false, reason: 'no-link' };
    const profile = state.linked[key];
    if (!profile) return { linked: false, reason: 'revoked' };
    return { linked: true, profile, userId: key };
  }

  return {
    CODE_TTL_MS,
    checkUid,
    LINK_COOKIE,
    createCode, claimCode, status, confirm, revoke,
    isUserLinked, linkedProfile, checkRequest,
    cookieValue, clearedCookie, readToken,
    flush: () => saveChain,
    _state: () => state,
  };
}

module.exports = { createStore, CODE_TTL_MS, LINK_COOKIE, CODE_LENGTH, sign, unsign };
