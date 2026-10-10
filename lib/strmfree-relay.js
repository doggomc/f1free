'use strict';

/* strmfree.st relay — second relay source, same shape as cdnlivetv.
 *
 *   /embed/racing/{key}   →  scrape the signed playlist tokens (rotating)
 *   /get-stream-key/{key} →  which segment CDN is in use
 *   /live-cdn/{variant}/index.m3u8?_t&_e&_n  →  the live playlist
 *
 * Two things make this different from cdnlivetv:
 *
 * 1. The tokens are minted per page load and bound to each other — editing any
 *    one of _t/_e/_n returns 403 — so they cannot be constructed here. The
 *    embed page has to be scraped, and the result cached until it nears
 *    expiry rather than re-scraped per viewer.
 * 2. /live-cdn/ already returns ABSOLUTE segment urls on a separate host, so
 *    nothing needs rewriting and only the ~1KB playlist crosses this server.
 *
 * Segments are named .js but are MPEG-TS. Leave the extension alone.
 */

const https = require('https');
const { URL } = require('url');

const ORIGIN = 'https://strmfree.st';
const DEFAULT_CDN = 'https://cdn1.streamfree.top';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/* Refresh the token this long before it expires, so a viewer never lands on
   the far side of an expired one mid-playlist. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
/* A live playlist moves every ~5.8s; two seconds is plenty of sharing while
   keeping the viewer very close to the live edge. */
const PLAYLIST_TTL_MS = 2_000;

const TIMEOUT_MS = 10_000;

/* ── token cache ─────────────────────────────────────────────────────────── */
let tokenCache = null;      // { key, quality, variant, t, e, n, expiresAt, cdn }
let tokenInflight = null;

/* ── playlist cache (shared by concurrent viewers) ───────────────────────── */
let playlistCache = null;   // { at, body }
let playlistInflight = null;

function fetchText(url, { timeoutMs = TIMEOUT_MS, referer = null } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (_) { return reject(new Error('bad url')); }
    if (u.protocol !== 'https:') return reject(new Error('refusing non-https url'));
    const req = https.request(
      u,
      {
        method: 'GET',
        headers: {
          'user-agent': UA,
          accept: '*/*',
          'accept-language': 'en-US,en;q=0.9',
          /* Referer is opt-in per call, and deliberately absent by default:
             sending strmfree.st as its own referer on the EMBED page trips
             their bot check, which answers 200 with a challenge page instead
             of the real one so the token table is simply missing. The
             playlist, by contrast, is refused unless the referer is one of
             theirs — so that call passes one. */
          ...(referer ? { referer } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        // A redirect is followed once; anything else that is not 200 is an error.
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, u).toString();
          return fetchText(next, { timeoutMs }).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

/* Pull the rotating tokens out of the embed page. The page is server-rendered
   and the values sit in plain `const` declarations, so this is a targeted read
   of three of them rather than anything clever. */
function parseEmbed(html, key, wantedQuality) {
  const q = html.match(/const\s+QUALITY\s*=\s*'([^']*)'/);
  const suffix = html.match(/const\s+SOURCE_SUFFIX\s*=\s*'([^']*)'/);
  const tokens = html.match(/const\s+_0x\s*=\s*(\{[\s\S]*?\})\s*;/);

  if (!tokens) throw new Error('no token table on the embed page');

  let table;
  try {
    // The table is JSON apart from single-quoted nothing: parse it directly.
    table = JSON.parse(tokens[1]);
  } catch (_) {
    throw new Error('token table is not valid JSON');
  }

  const pageQuality = (q && q[1]) || '';
  const quality = wantedQuality && table[wantedQuality] ? wantedQuality : pageQuality;
  const entry = table[quality];
  if (!entry || !entry._t || !entry._e || !entry._n) {
    throw new Error(`no token for quality ${quality || '(none)'}`);
  }

  const sfx = (suffix && suffix[1]) || '';
  return {
    quality,
    variant: `${key}${quality}${sfx}`,
    t: String(entry._t),
    e: Number(entry._e),
    n: String(entry._n),
  };
}

async function refreshToken(key, quality) {
  const [html, keyJson] = await Promise.all([
    fetchText(`${ORIGIN}/embed/racing/${encodeURIComponent(key)}`),
    fetchText(`${ORIGIN}/get-stream-key/${encodeURIComponent(key)}`).catch(() => null),
  ]);

  const parsed = parseEmbed(html, key, quality);

  let cdn = DEFAULT_CDN;
  if (keyJson) {
    try {
      const d = JSON.parse(keyJson);
      if (d && typeof d.server_domain === 'string' && /^https:\/\//.test(d.server_domain)) {
        cdn = d.server_domain.replace(/\/+$/, '');
      }
    } catch (_) { /* keep the default */ }
  }

  return {
    key,
    ...parsed,
    cdn,
    expiresAt: Number.isFinite(parsed.e) && parsed.e > 0 ? parsed.e * 1000 : 0,
  };
}

/* One scrape per expiry window, shared by every viewer asking at once. */
async function getToken(key, quality) {
  const usable = tokenCache
    && tokenCache.key === key
    && (!quality || tokenCache.quality === quality)
    && (!tokenCache.expiresAt || Date.now() < tokenCache.expiresAt - TOKEN_REFRESH_MARGIN_MS);

  if (usable) return tokenCache;
  if (tokenInflight) return tokenInflight;

  tokenInflight = refreshToken(key, quality)
    .then((fresh) => { tokenCache = fresh; return fresh; })
    .finally(() => { tokenInflight = null; });
  return tokenInflight;
}

/* Turn the origin playlist's relative segment names into absolute,
   token-bearing urls.

   Why the ORIGIN playlist and not /live-cdn/: /live-cdn/ hands back absolute
   urls on cdn1.streamfree.top, and that host hotlink-protects — it serves
   only to a referer on one of their own domains, so a player framed from our
   site gets 403 on every segment and never renders a frame. The origin's
   /live/ segments are served to ANY referer (and to none), so rewriting these
   ourselves keeps media off our bandwidth and actually plays.

   The playlist itself does need their referer, but that request is made here,
   server-side, so supplying it costs nothing. */
function absolutise(body, variant, qs) {
  return body.split('\n').map((line) => {
    const t = line.trim();
    if (!t || t.charAt(0) === '#') return line;        // tags pass through
    if (/^https?:\/\//i.test(t)) return line;           // already absolute
    const sep = t.indexOf('?') === -1 ? '?' : '&';
    return `${ORIGIN}/live/${encodeURIComponent(variant)}/${t}${sep}${qs}`;
  }).join('\n');
}

function playlistUrl(tok) {
  return `${ORIGIN}/live/${encodeURIComponent(tok.variant)}/index.m3u8`
    + `?_t=${encodeURIComponent(tok.t)}&_e=${tok.e}&_n=${encodeURIComponent(tok.n)}`;
}

async function fetchPlaylist(key, quality) {
  let tok = await getToken(key, quality);
  let body;
  try {
    body = await fetchText(playlistUrl(tok), { referer: ORIGIN + '/' });
  } catch (error) {
    /* A refused playlist almost always means the token we are holding died
       early. Drop it and try once with a fresh one before giving up. */
    tokenCache = null;
    tok = await getToken(key, quality);
    body = await fetchText(playlistUrl(tok), { referer: ORIGIN + '/' });
  }

  if (!body || body.indexOf('#EXTM3U') !== 0) throw new Error('not a playlist');
  return absolutise(body, tok.variant,
    `_t=${encodeURIComponent(tok.t)}&_e=${tok.e}&_n=${encodeURIComponent(tok.n)}`);
}

/* Concurrent viewers share one upstream fetch. */
async function getPlaylist(key = 'skyf1', quality = null) {
  const now = Date.now();
  if (playlistCache && now - playlistCache.at < PLAYLIST_TTL_MS) {
    return { playlist: playlistCache.body, cached: true };
  }
  if (!playlistInflight) {
    playlistInflight = fetchPlaylist(key, quality)
      .then((body) => {
        playlistCache = { at: Date.now(), body };
        return body;
      })
      .finally(() => { playlistInflight = null; });
  }
  const playlist = await playlistInflight;
  return { playlist, cached: false };
}

function cacheStats() {
  return {
    playlists: playlistCache ? 1 : 0,
    inflight: playlistInflight ? 1 : 0,
    tokens: tokenCache ? 1 : 0,
    tokenExpiresAt: tokenCache ? tokenCache.expiresAt : 0,
    ttlMs: PLAYLIST_TTL_MS,
  };
}

/* Where segments actually come from — needed for the player page's
   connect-src. /live/ serves them from the origin itself, so that is the host
   to allow; the CDN host is only ever used by /live-cdn/, which we avoid
   because it hotlink-protects. */
function cdnOrigin() {
  return ORIGIN;
}

module.exports = {
  ORIGIN,
  CDN_ORIGIN: DEFAULT_CDN,
  getPlaylist,
  cacheStats,
  cdnOrigin,
  _reset: () => { tokenCache = null; tokenInflight = null; playlistCache = null; playlistInflight = null; },
};
