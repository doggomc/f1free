'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   cdnlivetv relay — resolves a cdnlivetv channel to a playable HLS playlist.

   WHY THIS EXISTS
   ---------------
   cdnlivetv hands out playlists that are signed and die after ~4 hours, so no
   extracted link can be permanent. It does, however, mint a brand new token on
   every request, for free, forever. So the permanent thing is not a link — it is
   a resolver that hands out a fresh one. That is what this module is.

   HOW THE EXTRACTION WORKS
   ------------------------
   GET /api/v1/channels/player/?name=…&code=… returns HTML, not JSON. The stream
   URL is rebuilt at runtime by one expression whose variable names are
   re-randomised on every single request:

       var xQ7pLm = aBc('aHR0cHM') + aBc('Og') + aBc('Ly8') + … ;
                    https          :            //

   Each literal is URL-safe base64. Concatenating the decoded pieces gives:

       https://cdnlivetv.tv/secure/api/v1/<channelId>/playlist.m3u8?token=<b64>

   The token decodes to  <channelId>:<expiryEpochMs>:<domain>:<salt>.<hmac>.
   It is HMAC-signed with a secret we do not have: pushing the expiry out,
   blanking the signature or swapping the domain all come back
   "403 Invalid token signature". So it cannot be forged — only re-minted.

   WHAT WE DO WITH IT
   ------------------
   Cache one token per channel and refresh it shortly before it expires, then
   serve the playlist with the relative /stream-segment/… paths rewritten to
   absolute https://cdnlivetv.tv/… urls. The player fetches the ~2KB playlist
   from us and the ~10MB/s of video straight from cdnlivetv, so this relay never
   carries the stream itself.
   ────────────────────────────────────────────────────────────────────────── */

const PLAYER_API = 'https://cdnlivetv.tv/api/v1/channels/player/';
const CDN_ORIGIN = 'https://cdnlivetv.tv';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DEFAULT_TIMEOUT_MS = 15_000;
// Re-mint this many seconds before the token actually expires.
const TOKEN_SAFETY_MARGIN_MS = 300_000;
// Never trust a cached token for longer than this, whatever it claims.
const CACHE_TTL_CAP_MS = 3_600_000;

/* ── decoding ─────────────────────────────────────────────────────────────── */

function b64urlDecode(str) {
  let s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}

function extractStreamUrl(html) {
  const literals = Object.create(null);
  const litRe = /var\s+([A-Za-z0-9_$]+)\s*=\s*'([^']*)'/g;
  let m;
  while ((m = litRe.exec(html)) !== null) literals[m[1]] = m[2];

  // Primary path: evaluate the runtime concatenation expression. There may be
  // several `x(y)+x(y)` shapes on the page; take the one that builds a playlist.
  const exprRe = /var\s+[A-Za-z0-9_$]+\s*=\s*((?:[A-Za-z0-9_$]+\([A-Za-z0-9_$]+\)\s*\+\s*)+[A-Za-z0-9_$]+\([A-Za-z0-9_$]+\))\s*;/g;
  while ((m = exprRe.exec(html)) !== null) {
    try {
      const parts = [];
      const callRe = /([A-Za-z0-9_$]+)\(([A-Za-z0-9_$]+)\)/g;
      let call;
      while ((call = callRe.exec(m[1])) !== null) {
        const value = literals[call[2]];
        if (typeof value !== 'string') throw new Error('unknown literal ' + call[2]);
        parts.push(b64urlDecode(value));
      }
      const url = parts.join('');
      if (url.includes('playlist.m3u8') && url.includes('token=')) return url;
    } catch (_) { /* try the next expression */ }
  }

  // Fallback: assemble from the decoded pieces by role.
  const pieces = Object.values(literals)
    .map((v) => { try { return b64urlDecode(v); } catch (_) { return null; } })
    .filter(Boolean);
  const token = pieces.find((p) => p.includes('token='));
  const channelId = (html.match(/var\s+_CH\s*=\s*'([^']+)'/) || [])[1] ||
                    pieces.find((p) => /^[0-9a-f]{24}$/.test(p));
  if (token && channelId) return `${CDN_ORIGIN}/secure/api/v1/${channelId}/playlist.m3u8${token}`;

  return null;
}

function decodeToken(token) {
  const raw = b64urlDecode(token);
  const [channel, expMs, domain, signature] = raw.split(':');
  const info = { raw, channel, domain, signature };
  if (expMs && /^\d+$/.test(expMs)) {
    info.expiresAt = Number(expMs);
    info.ttlMs = Number(expMs) - Date.now();
  }
  return info;
}

/* ── http ─────────────────────────────────────────────────────────────────── */

async function fetchText(url, { timeout = DEFAULT_TIMEOUT_MS, headers = {} } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: '*/*', ...headers },
    signal: AbortSignal.timeout(timeout),
    redirect: 'follow'
  });
  const body = await res.text();
  return { status: res.status, body, headers: res.headers };
}

/* ── token cache ──────────────────────────────────────────────────────────── */

const cache = new Map();   // "name|code" -> { url, expiresAt, channelId }
const inflight = new Map();

function cacheKey(name, code) { return `${String(name).toLowerCase()}|${String(code).toLowerCase()}`; }

async function mint(name, code) {
  const query = new URLSearchParams({ name, code, user: 'cdnlivetv', plan: 'free' });
  const { status, body } = await fetchText(`${PLAYER_API}?${query}`);
  if (status !== 200) {
    const err = new Error(`cdnlivetv player page returned HTTP ${status}`);
    err.status = status;
    throw err;
  }
  const url = extractStreamUrl(body);
  if (!url) {
    const err = new Error('could not locate the stream url in the player page');
    err.status = 502;
    throw err;
  }
  const token = new URL(url).searchParams.get('token');
  const info = decodeToken(token || '');
  return {
    url,
    channelId: info.channel || null,
    expiresAt: Math.min(
      info.expiresAt || (Date.now() + CACHE_TTL_CAP_MS),
      Date.now() + CACHE_TTL_CAP_MS
    )
  };
}

/* One mint per channel at a time: a burst of viewers must not stampede
   cdnlivetv, and a slow refresh must not block a different channel. */
async function getStreamUrl(name, code, { force = false } = {}) {
  const key = cacheKey(name, code);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && !force && (hit.expiresAt - now) > TOKEN_SAFETY_MARGIN_MS) return hit;

  if (!inflight.has(key)) {
    inflight.set(key, mint(name, code)
      .then((fresh) => { cache.set(key, fresh); return fresh; })
      .finally(() => inflight.delete(key)));
  }
  return inflight.get(key);
}

/* ── playlist ─────────────────────────────────────────────────────────────── */

/* Segments are ~10s, so a playlist stays fresh for a couple of seconds. Two
   viewers asking at once used to trigger two upstream fetches; now they share
   one, and anyone arriving inside the window is served instantly instead of
   waiting on cdnlivetv. */
const PLAYLIST_TTL_MS = 2_000;
const playlistCache = new Map();     // key -> { playlist, channelId, expiresAt, storedAt }
const playlistInflight = new Map();  // key -> Promise (dedupes concurrent misses)

async function getPlaylist(name, code) {
  const key = cacheKey(name, code);
  const hit = playlistCache.get(key);
  if (hit && Date.now() < hit.storedAt + PLAYLIST_TTL_MS) {
    return { playlist: hit.playlist, channelId: hit.channelId, expiresAt: hit.expiresAt, cached: true };
  }
  if (!playlistInflight.has(key)) {
    playlistInflight.set(key,
      fetchPlaylist(name, code)
        .then((fresh) => {
          playlistCache.set(key, { ...fresh, storedAt: Date.now() });
          return fresh;
        })
        .finally(() => playlistInflight.delete(key)));
  }
  return playlistInflight.get(key);
}

/* Fetches the live playlist and rewrites the relative segment paths to absolute
   urls. Without this a player would resolve /stream-segment/… against OUR
   origin, where no such route exists. */
async function fetchPlaylist(name, code) {
  let entry = await getStreamUrl(name, code);
  let { status, body } = await fetchText(entry.url, { timeout: 10_000 });
  if (status === 401 || status === 403) {
    // Rejected: mint a new token once, then give up rather than loop.
    entry = await getStreamUrl(name, code, { force: true });
    ({ status, body } = await fetchText(entry.url, { timeout: 10_000 }));
  }
  if (status !== 200) {
    const err = new Error(`cdnlivetv playlist returned HTTP ${status}`);
    err.status = status;
    throw err;
  }
  const rewritten = body
    .split('\n')
    .map((line) => (line.startsWith('/') ? CDN_ORIGIN + line : line))
    .join('\n');
  return {
    playlist: rewritten,
    channelId: entry.channelId,
    expiresAt: entry.expiresAt
  };
}

/* ── diagnostics ──────────────────────────────────────────────────────────── */

async function selftest(name = 'sky sports f1', code = 'gb') {
  const report = { ok: false, channel: name, code, steps: {} };
  const t = () => Date.now();

  let started = t();
  try {
    const query = new URLSearchParams({ name, code, user: 'cdnlivetv', plan: 'free' });
    const res = await fetchText(`${PLAYER_API}?${query}`);
    report.steps.playerPage = { http: res.status, ms: t() - started };
    if (res.status !== 200) { report.error = 'player page unreachable from this host'; return report; }

    started = t();
    const url = extractStreamUrl(res.body);
    if (!url) { report.error = 'could not extract the stream url (page layout changed)'; return report; }
    const info = decodeToken(new URL(url).searchParams.get('token') || '');
    report.steps.token = {
      ms: t() - started, channelId: info.channel,
      ttlSeconds: info.ttlMs ? Math.round(info.ttlMs / 1000) : null,
      domain: info.domain
    };

    started = t();
    const { playlist } = await getPlaylist(name, code);
    const segments = playlist.split('\n').filter((l) => l.startsWith('http') && l.includes('/stream-segment/'));
    report.steps.playlist = { ms: t() - started, segments: segments.length };
    if (!segments.length) { report.error = 'no segments in playlist'; return report; }

    started = t();
    const seg = await fetch(segments[0], {
      headers: { 'User-Agent': UA, Range: 'bytes=0-65535' },
      signal: AbortSignal.timeout(20_000)
    });
    const buf = Buffer.from(await seg.arrayBuffer());
    report.steps.segment = {
      http: seg.status, ms: t() - started, bytes: buf.length,
      firstByte: buf.length ? buf.subarray(0, 1).toString('hex') : null,
      mpegTs: buf.length ? buf[0] === 0x47 : false
    };
    report.ok = Boolean(report.steps.segment.mpegTs);
    if (!report.ok) report.error = 'segment did not look like MPEG-TS';
  } catch (error) {
    report.error = error.message;
  }
  return report;
}

/* Lets the diagnostic show whether the cache is actually absorbing requests. */
function cacheStats() {
  return { playlists: playlistCache.size, inflight: playlistInflight.size, ttlMs: PLAYLIST_TTL_MS };
}

module.exports = {
  PLAYER_API,
  CDN_ORIGIN,
  extractStreamUrl,
  decodeToken,
  getStreamUrl,
  getPlaylist,
  cacheStats,
  selftest
};
