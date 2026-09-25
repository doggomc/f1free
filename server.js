'use strict';

const crypto = require('crypto');
const compression = require('compression');
const express = require('express');
const cookieSession = require('cookie-session');
const fs = require('fs');
const path = require('path');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

const SERVER_STARTED_AT = Date.now();
const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'freef1-admin-secret-change-me';
const VISITOR_SECRET = process.env.VISITOR_SECRET || 'doggomc';
const AUTHORIZED_DOMAIN = process.env.AUTHORIZED_DOMAIN || 'freef1.netlify.app';
const AUTHORIZED_HOSTNAME = String(AUTHORIZED_DOMAIN).replace(/^https?:\/\//i, '').split('/')[0].split(':')[0].toLowerCase();
const ALLOWED_ORIGINS = parseOrigins(process.env.ALLOWED_ORIGIN || 'https://freef1.netlify.app');

// Durable unique-visitor storage. Upstash's REST API is intentionally used
// directly so this stays dependency-free and works on every Render plan.
const UNIQUE_VISITOR_BASELINE = Math.max(0, Number.parseInt(process.env.UNIQUE_VISITOR_BASELINE || '0', 10) || 0);
const UNIQUE_VISITOR_REDIS_KEY = process.env.UNIQUE_VISITOR_REDIS_KEY || 'freef1:unique-visitors:v1';
const MAINTENANCE_REDIS_KEY = process.env.MAINTENANCE_REDIS_KEY || 'freef1:maintenance:v1';
const NEWS_REDIS_KEY = process.env.NEWS_REDIS_KEY || 'freef1:news:v1';
const NEWS_MAX_ITEMS = Math.max(1, Math.min(100, Number.parseInt(process.env.NEWS_MAX_ITEMS || '50', 10) || 50));
// Keep visitor hashes independent from the admin cookie key so rotating
// ADMIN_SECRET does not reset the unique-visitor identity space.
const UNIQUE_VISITOR_HASH_SECRET = process.env.UNIQUE_VISITOR_HASH_SECRET || VISITOR_SECRET;
const UPSTASH_REDIS_REST_URL = String(process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const UPSTASH_REDIS_REST_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || '');
const UNIQUE_VISITOR_REMOTE_ENABLED = Boolean(UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN);
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const NEWS_FILE = path.join(DATA_DIR, 'news.json');
const MAINTENANCE_FILE = path.join(DATA_DIR, 'maintenance.json');
const UNIQUE_VISITORS_FILE = path.join(DATA_DIR, 'unique-visitors.json');
const ANALYTICS_FILE = path.join(DATA_DIR, 'analytics.json');
const ANALYTICS_REDIS_KEY = process.env.ANALYTICS_REDIS_KEY || 'freef1:analytics:v1';
const SOURCE_CONFIG_FILE = path.join(DATA_DIR, 'stream-sources.json');
const SOURCE_REDIS_KEY = process.env.SOURCE_REDIS_KEY || 'freef1:stream-sources:v1';
const OVERRIDE_FILE = path.join(DATA_DIR, 'stream-override.json');
const OVERRIDE_REDIS_KEY = process.env.OVERRIDE_REDIS_KEY || 'freef1:stream-override:v1';

// ── OpenF1 proxy (see /api/openf1/:path) ──
// OpenF1 locks the free tier with a CORS-less 401 while a session is live, which
// browsers surface as an opaque "Failed to fetch". Proxying server-side removes
// CORS from the picture, collapses every visitor onto one cached upstream call
// (the free tier rate-limits per IP), and lets us serve last-known-good
// snapshots through lock windows.
const OPENF1_UPSTREAM = String(process.env.OPENF1_API || 'https://api.openf1.org/v1').replace(/\/+$/, '');
const OPENF1_API_KEY = process.env.OPENF1_API_KEY || '';
const OPENF1_TTL_MS_OVERRIDE = Math.max(0, Number.parseInt(process.env.OPENF1_TTL_MS || '0', 10) || 0);
const OPENF1_PATHS = new Set(['sessions', 'meetings', 'drivers', 'team_radio', 'race_control']);
const OPENF1_TTL_MS = { sessions: 600_000, meetings: 600_000, drivers: 6 * 3_600_000, team_radio: 300_000, race_control: 300_000 };
const OPENF1_SNAPSHOT_TTL_S = 7 * 86_400;
const OPENF1_SNAPSHOT_MAX_BYTES = 1_500_000;
const openf1Cache = new Map();     // url -> { data, at }
const openf1Snapshots = new Map(); // url -> { data, at } last-known-good per URL
const openf1Inflight = new Map();  // url -> Promise (request coalescing)
// Reported to the admin dashboard so it can render a true server clock.
const SERVER_TIMEZONE = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) { return 'UTC'; }
})();
const PRODUCTION_MODE = process.env.NODE_ENV === 'production' || process.env.REQUIRE_PRODUCTION_SECRETS === '1';
const insecureProductionConfig = [
  !process.env.ADMIN_USER ? 'ADMIN_USER' : null,
  !process.env.ADMIN_PASS || process.env.ADMIN_PASS === 'admin' ? 'ADMIN_PASS' : null,
  !process.env.ADMIN_SECRET || process.env.ADMIN_SECRET === 'freef1-admin-secret-change-me' ? 'ADMIN_SECRET' : null,
  !process.env.VISITOR_SECRET || process.env.VISITOR_SECRET === 'doggomc' ? 'VISITOR_SECRET' : null
].filter(Boolean);
if (PRODUCTION_MODE && insecureProductionConfig.length) {
  throw new Error(`Refusing to start with insecure production configuration: ${insecureProductionConfig.join(', ')}.`);
}

// Site root — set DEV_DIR to the folder containing your index.html
// Render example: DEV_DIR=/opt/render/project/Development-FreeF1
const DEV_DIR = resolveDir(process.env.DEV_DIR, [
  path.join(__dirname, '..', 'Development - FreeF1'),
  path.join(__dirname, 'Development - FreeF1'),
  path.join(__dirname, '..', '..', 'Development - FreeF1'),
  path.join(process.cwd(), 'Development - FreeF1'),
  path.join(process.cwd(), '..', 'Development - FreeF1'),
  path.join('/opt', 'render', 'project', 'Development - FreeF1'),
  path.join('/opt', 'render', 'project', 'development-freef1'),
  path.join('/opt', 'render', 'project', 'site'),
  path.join(process.cwd(), 'public'),
  path.join(process.cwd(), 'site'),
  process.cwd()
]);

const ADMIN_DIR = resolveDir(process.env.ADMIN_DIR, [
  path.join(__dirname, 'admin'),
  path.join(process.cwd(), 'admin'),
  path.join('/opt', 'render', 'project', 'admin')
]);

function resolveDir(envValue, candidates) {
  if (envValue && fs.existsSync(envValue)) return envValue;
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return envValue || candidates[0];
}

function findIndexHtml(dir) {
  if (!dir) return null;

  const direct = path.join(dir, 'index.html');
  if (fs.existsSync(direct)) return direct;

  // Search one level deep for any index.html. This keeps deploys working even
  // when the static site is wrapped in one extra folder by the host/build step.
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const nested = path.join(dir, entry.name, 'index.html');
        if (fs.existsSync(nested)) return nested;
      }
    }
  } catch (_) {
    // The caller reports the final missing path in the HTTP response.
  }

  return direct;
}

function parseOrigins(value) {
  return String(value || '')
    .split(',')
    .map(origin => normalizeOrigin(origin.trim()))
    .filter(Boolean);
}

function normalizeOrigin(value) {
  if (!value) return '';
  try {
    return new URL(value).origin.replace(/\/$/, '');
  } catch (_) {
    return String(value).replace(/\/$/, '');
  }
}

function hostnameFromUrl(value) {
  if (!value) return '';
  try { return new URL(value).hostname.toLowerCase(); } catch (_) { return ''; }
}

function isAuthorizedHostname(value) {
  const hostname = String(value || '').split(':')[0].toLowerCase();
  return hostname === AUTHORIZED_HOSTNAME;
}

function getRequestOrigin(req) {
  const origin = normalizeOrigin(req.headers.origin || '');
  if (origin) return origin;

  const host = req.headers.host;
  if (!host) return '';
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  return `${proto}://${host}`;
}

function isLocalOrigin(origin) {
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch (_) {
    return false;
  }
}

function isPreviewOrigin(origin) {
  try { return new URL(origin).hostname.endsWith('.e2b.app'); } catch (_) { return false; }
}

function isSameOriginRequest(req, origin) {
  if (!origin || !req.headers.host) return false;
  const host = req.headers.host;
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocolCandidates = new Set([req.protocol || 'http', 'http', 'https']);
  if (forwardedProto) protocolCandidates.add(forwardedProto);
  return [...protocolCandidates].some(proto => normalizeOrigin(`${proto}://${host}`) === origin);
}

function isAllowedOrigin(req, origin) {
  if (!origin) return true;
  return (
    ALLOWED_ORIGINS.includes(origin) ||
    isSameOriginRequest(req, origin) ||
    isLocalOrigin(origin) ||
    isPreviewOrigin(origin)
  );
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// ─────────────────────────────────────────────
// DATA STORES
// ─────────────────────────────────────────────

// visitorKey -> { id, ip, country, city, browser, os, deviceType, page, connectedAt, lastSeen, online, source }
const activeUsers = new Map();
// Only keyed hashes are retained for unique counting; raw browser IDs/IPs are
// never sent to the durable store.
const visitorKeysSeen = new Set();
const persistedVisitorHashes = new Set();
const pendingUniqueWrites = new Map();
let persistentUniqueCount = 0;
let uniqueVisitorStoreReady = false;
let lastUniqueStoreWarningAt = 0;
// O(1) IP lookups avoid scanning every active visitor on each heartbeat.
const visitorKeyByIp = new Map();
// Geo responses are reused and concurrent lookups for one IP are deduplicated.
const geoCache = new Map();
const pendingGeoLookups = new Map();
const loginAttempts = new Map();
const visitorRateLimits = new Map();
let fileStoreReady = false;
const GEO_CACHE_TTL = Number(process.env.GEO_CACHE_TTL_MS || 6 * 60 * 60 * 1000);

// Stream override. `input` is the URL the admin typed; `url` is the playback
// URL viewers actually receive. Both are persisted so a redeploy does not
// drop a live override or forget the URL that was entered.
const streamOverride = {
  active: false,
  input: null,
  url: null,
  type: null, // 'youtube' | 'mp4' | 'webm' | 'embed' | null
  startedAt: null,
  updatedAt: null
};
let overrideStoreReady = false;
let overrideInitPromise = Promise.resolve(false);

const DEFAULT_MAINTENANCE_MESSAGE = "We'll be back before the race.";
const DEFAULT_MAINTENANCE_ETA = 'Before lights out';
const maintenanceMode = {
  active: false,
  message: DEFAULT_MAINTENANCE_MESSAGE,
  eta: DEFAULT_MAINTENANCE_ETA,
  startedAt: null,
  updatedAt: null
};
let maintenanceStoreReady = false;
let maintenanceInitPromise = Promise.resolve(false);

// Small, admin-managed public news feed. The array is the fast local snapshot;
// Upstash keeps updates available after a Render restart when configured.
const newsItems = [];
let newsStoreReady = false;
let newsInitPromise = Promise.resolve(false);

/* ── Feed sources (public player) ──────────────────────────
   `id` values must match the `sources` array in the public site's app.js —
   that array owns the URLs/suffixes and stays the offline fallback. The
   server only owns which feeds are switched on, so an admin can pull a dead
   provider mid-session without redeploying Netlify. */
const FEED_SOURCES = [
  { id: 'sky-uk-2', label: 'Sky UK 2' },
  { id: 'sky-uk', label: 'Sky UK' },
  { id: 'f1tv', label: 'F1TV' },
  { id: 'sky-sports-f1', label: 'Sky Sports F1' },
  { id: 'appletv', label: 'AppleTV' },
  { id: 'dazn', label: 'DAZN' },
  { id: 'wikisport', label: 'WikiSport' }
];
const FEED_SOURCE_IDS = new Set(FEED_SOURCES.map(source => source.id));
const sourceConfig = { disabled: new Set(), updatedAt: null };
let sourceStoreReady = false;
let sourceInitPromise = Promise.resolve(false);

// SSE clients for admin dashboard
const sseClients = new Set();
// SSE clients for public site (stream override only)
const publicSseClients = new Set();

// One shared timer scales better than allocating a timer per connected SSE client.
const sseHeartbeatTimer = setInterval(() => {
  const heartbeat = ': heartbeat\n\n';
  writeSSE(sseClients, heartbeat);
  writeSSE(publicSseClients, heartbeat);
}, 15_000);
sseHeartbeatTimer.unref?.();

// Heartbeat / cleanup settings
const HEARTBEAT_TIMEOUT = Number(process.env.HEARTBEAT_TIMEOUT_MS || 60_000);
const CLEANUP_INTERVAL = Number(process.env.CLEANUP_INTERVAL_MS || 30_000);
const VISITOR_TOKEN_TTL_MS = Number(process.env.VISITOR_TOKEN_TTL_MS || 24 * 60 * 60 * 1000);
const VISITOR_RATE_LIMIT_WINDOW_MS = Number(process.env.VISITOR_RATE_LIMIT_WINDOW_MS || 60_000);
const VISITOR_RATE_LIMIT_MAX = Number(process.env.VISITOR_RATE_LIMIT_MAX || 30);
const GEO_ENABLED = process.env.GEO_ENABLED !== 'false';
const GEO_API = String(process.env.GEO_API || 'https://ipwho.is').replace(/\/+$/, '');

// ─────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────

app.use(compression({
  threshold: 1024,
  filter(req, res) {
    // Streaming responses must never be buffered by a compressor.
    if (req.path.endsWith('/events') || String(req.headers.accept || '').includes('text/event-stream')) return false;
    return compression.filter(req, res);
  }
}));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: https://media.formula1.com",
    "connect-src 'self' https://f1free.onrender.com https://api.jolpi.ca",
    'frame-src https:',
    "media-src 'self' https:",
    "form-action 'self'"
  ].join('; '));
  if (PRODUCTION_MODE) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (req.path.startsWith('/api/') || req.path.startsWith('/admin/api/') || req.path === '/healthz') {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});

app.use((req, res, next) => {
  const origin = normalizeOrigin(req.headers.origin || '');

  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Visitor-Token, X-User-Id');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (origin && !isAllowedOrigin(req, origin)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (ALLOWED_ORIGINS[0]) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS[0]);
  }

  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '64kb' }));

// Stateless, signed admin sessions avoid a server-side session database. The
// stable ADMIN_SECRET lets one admin session work across Render instances and restarts.
const sessionMiddleware = cookieSession({
  name: 'freef1.sid',
  keys: [ADMIN_SECRET],
  httpOnly: true,
  sameSite: 'strict',
  secure: PRODUCTION_MODE,
  maxAge: 24 * 60 * 60 * 1000 // 24 hours
});

// ─────────────────────────────────────────────
// UTILITY — User-Agent Parsing
// ─────────────────────────────────────────────

function parseUA(ua) {
  if (!ua) return { browser: 'Unknown', os: 'Unknown', deviceType: 'Desktop' };
  const lower = ua.toLowerCase();

  const osMatch =
    /windows nt (\d+\.?\d*)/.exec(lower) ? { os: 'Windows ' + RegExp.$1 } :
    /mac os x (\d+[._]\d+[._]?\d*)/.exec(lower) ? { os: 'macOS ' + RegExp.$1.replace(/_/g, '.') } :
    /iphone os (\d+[._]\d+)/.exec(lower) ? { os: 'iOS ' + RegExp.$1.replace(/_/g, '.') } :
    /ipad.*os (\d+[._]\d+)/.exec(lower) ? { os: 'iPadOS ' + RegExp.$1.replace(/_/g, '.') } :
    /android (\d+(?:[./]\d+)?)/.exec(lower) ? { os: 'Android ' + RegExp.$1.replace(/\//, '.') } :
    /cros/.test(lower) ? { os: 'ChromeOS' } :
    /linux/.test(lower) ? { os: 'Linux' } :
    { os: 'Unknown' };

  const browserMatch =
    /edg\/(\d+[\.\d]*)/.exec(lower) ? { browser: 'Edge ' + RegExp.$1.split('.')[0] } :
    /opr\/(\d+[\.\d]*)/.exec(lower) ? { browser: 'Opera ' + RegExp.$1.split('.')[0] } :
    /samsungbrowser\/(\d+)/.exec(lower) ? { browser: 'Samsung ' + RegExp.$1 } :
    /firefox\/(\d+[\.\d]*)/.exec(lower) ? { browser: 'Firefox ' + RegExp.$1.split('.')[0] } :
    /chrome\/(\d+[\.\d]*)/.exec(lower) && !/edg|opr/.test(lower) ? { browser: 'Chrome ' + RegExp.$1.split('.')[0] } :
    /safari\/(\d+[\.\d]*)/.exec(lower) && !/chrome/.test(lower) ? { browser: 'Safari ' + RegExp.$1.split('.')[0] } :
    /micromessenger\/(\d+)/.exec(lower) ? { browser: 'WeChat ' + RegExp.$1 } :
    /instagram/.test(lower) ? { browser: 'Instagram' } :
    /tiktok/.test(lower) ? { browser: 'TikTok' } :
    { browser: 'Unknown' };

  const deviceType =
    /tablet|ipad|playbook|silk|(android(?!.*mobile))/.test(lower) ? 'Tablet' :
    /mobile|android|iphone|ipod|blackberry|mini|windows\s+phone|silk/.test(lower) ? 'Mobile' :
    'Desktop';

  return { ...osMatch, ...browserMatch, deviceType };
}

// ─────────────────────────────────────────────
// UTILITY — Stream URL Classification
// ─────────────────────────────────────────────

function getYouTubeId(parsedUrl) {
  const host = parsedUrl.hostname.replace(/^www\./, '').toLowerCase();
  if (host === 'youtu.be') return parsedUrl.pathname.split('/').filter(Boolean)[0] || null;
  if (host !== 'youtube.com' && host !== 'youtube-nocookie.com' && host !== 'm.youtube.com') return null;

  if (parsedUrl.pathname === '/watch') return parsedUrl.searchParams.get('v');

  const parts = parsedUrl.pathname.split('/').filter(Boolean);
  if (['embed', 'shorts', 'live'].includes(parts[0])) return parts[1] || null;

  return null;
}

function classifyStreamURL(url) {
  if (!url) return { type: null, embedUrl: null };
  const trimmed = url.trim();

  let parsedUrl;
  try {
    parsedUrl = new URL(trimmed);
  } catch (_) {
    return { type: null, embedUrl: null };
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return { type: null, embedUrl: null };
  }

  const youtubeId = getYouTubeId(parsedUrl);
  if (youtubeId && /^[A-Za-z0-9_-]{6,}$/.test(youtubeId)) {
    return {
      type: 'youtube',
      embedUrl: `https://www.youtube-nocookie.com/embed/${youtubeId}?autoplay=1&rel=0&modestbranding=1`
    };
  }

  const pathAndQuery = parsedUrl.pathname + parsedUrl.search;
  if (/\.webm(\?.*)?$/i.test(pathAndQuery)) return { type: 'webm', embedUrl: parsedUrl.href };
  if (/\.mp4(\?.*)?$/i.test(pathAndQuery)) return { type: 'mp4', embedUrl: parsedUrl.href };

  // Generic HTTP(S) embed fallback.
  return { type: 'embed', embedUrl: parsedUrl.href };
}

// ─────────────────────────────────────────────
// UTILITY — SSE Broadcast
// ─────────────────────────────────────────────

function writeSSE(clients, payload) {
  for (const res of clients) {
    if (res.destroyed || res.writableEnded) { clients.delete(res); continue; }
    try { res.write(payload); } catch (_) { clients.delete(res); }
  }
}

function broadcastSSE(event, data) {
  if (!sseClients.size) return;
  writeSSE(sseClients, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcastPublicSSE(event, data) {
  if (!publicSseClients.size) return;
  writeSSE(publicSseClients, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcastNewsUpdate() {
  // Admin keeps drafts. The public site must never receive them.
  broadcastSSE('news_update', { news: getAdminNewsItems(), durable: newsStoreIsDurable() });
  broadcastPublicSSE('news_update', { news: getPublicNewsItems() });
}

let statsBroadcastTimer = null;
function scheduleStatsBroadcast(delay = 80) {
  if (!sseClients.size || statsBroadcastTimer) return;
  statsBroadcastTimer = setTimeout(() => {
    statsBroadcastTimer = null;
    broadcastSSE('stats', getStats());
  }, delay);
  statsBroadcastTimer.unref?.();
}

function broadcastVisitorChange(type, visitor, includeStats = true) {
  broadcastSSE('visitor_update', { type, visitor: sanitizeVisitor(visitor) });
  if (includeStats) scheduleStatsBroadcast();
}

// ─────────────────────────────────────────────
// GEO LOOKUP (async, fire-and-forget)
// ─────────────────────────────────────────────

function isPublicIp(ip) {
  if (!ip || ip === 'unknown') return false;
  if (ip === '127.0.0.1' || ip === '::1') return false;
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) return false;
  if (/^(fc00:|fd00:|fe80:)/i.test(ip)) return false;
  return true;
}

function pruneGeoCache() {
  const now = Date.now();
  for (const [ip, cached] of geoCache) if (cached.expiresAt <= now) geoCache.delete(ip);
  while (geoCache.size > 5000) geoCache.delete(geoCache.keys().next().value);
}

async function lookupGeo(ip) {
  if (!GEO_ENABLED || !isPublicIp(ip) || typeof fetch !== 'function') return null;
  const cached = geoCache.get(ip);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (pendingGeoLookups.has(ip)) return pendingGeoLookups.get(ip);

  const lookup = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    timeout.unref?.();
    try {
      const isIpWho = GEO_API.includes('ipwho.is');
      const endpoint = isIpWho
        ? `${GEO_API}/${encodeURIComponent(ip)}`
        : `${GEO_API}/${encodeURIComponent(ip)}?fields=status,city,country,countryCode,lat,lon,query&timeout=3000`;
      const res = await fetch(endpoint, { signal: controller.signal });
      if (!res.ok) return null;
      const data = await res.json();
      if (isIpWho ? data.success === false : data.status !== 'success') return null;
      const normalized = {
        ...data,
        countryCode: data.countryCode || data.country_code || null
      };
      geoCache.set(ip, { value: normalized, expiresAt: Date.now() + GEO_CACHE_TTL });
      if (geoCache.size > 5000) pruneGeoCache();
      return normalized;
    } catch (_) {
      return null;
    } finally {
      clearTimeout(timeout);
      pendingGeoLookups.delete(ip);
    }
  })();

  pendingGeoLookups.set(ip, lookup);
  return lookup;
}

// ─────────────────────────────────────────────
// SIMPLE LOCAL JSON STORAGE
// ─────────────────────────────────────────────

function initializeFileStore() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.accessSync(DATA_DIR, fs.constants.R_OK | fs.constants.W_OK);
    fileStoreReady = true;
  } catch (error) {
    fileStoreReady = false;
    console.warn(`[Storage] Local JSON storage unavailable at ${DATA_DIR}. ${error?.message || error}`);
  }
}

function readLocalJson(filePath) {
  if (!fileStoreReady || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.warn(`[Storage] Could not read ${filePath}. ${error?.message || error}`);
    return null;
  }
}

function writeLocalJson(filePath, value) {
  if (!fileStoreReady) return false;
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
    return true;
  } catch (error) {
    try { fs.rmSync(temporaryPath, { force: true }); } catch (_) {}
    console.warn(`[Storage] Could not write ${filePath}. ${error?.message || error}`);
    return false;
  }
}

function dataStoreStatus(remoteEnabled, remoteReady) {
  if (remoteEnabled) return remoteReady ? 'upstash' : 'upstash-connecting';
  return fileStoreReady ? 'file' : 'memory';
}

initializeFileStore();

// ─────────────────────────────────────────────
// DURABLE UNIQUE-VISITOR COUNT
// ─────────────────────────────────────────────

function hashVisitorKey(key) {
  return crypto
    .createHmac('sha256', UNIQUE_VISITOR_HASH_SECRET)
    .update(String(key || 'unknown'))
    .digest('hex');
}

function warnUniqueStore(error) {
  const now = Date.now();
  if (now - lastUniqueStoreWarningAt < 60_000) return;
  lastUniqueStoreWarningAt = now;
  console.warn(`[Visitors] Durable store unavailable; keeping the last confirmed total. ${error?.message || error}`);
}

async function upstashRequest(commands) {
  if (!UNIQUE_VISITOR_REMOTE_ENABLED) throw new Error('Upstash is not configured');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  timeout.unref?.();

  try {
    const isPipeline = Array.isArray(commands[0]);
    const response = await fetch(`${UPSTASH_REDIS_REST_URL}${isPipeline ? '/pipeline' : ''}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(commands),
      cache: 'no-store',
      signal: controller.signal
    });

    if (!response.ok) throw new Error(`Upstash HTTP ${response.status}`);
    const payload = await response.json();
    if (payload?.error) throw new Error(payload.error);
    if (Array.isArray(payload)) {
      const failed = payload.find(item => item?.error);
      if (failed) throw new Error(failed.error);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function syncUniqueVisitorCount() {
  if (!UNIQUE_VISITOR_REMOTE_ENABLED) return false;
  try {
    const payload = await upstashRequest(['SCARD', UNIQUE_VISITOR_REDIS_KEY]);
    const count = Number(payload?.result);
    if (!Number.isFinite(count) || count < 0) throw new Error('Upstash returned an invalid visitor count');
    persistentUniqueCount = count;
    uniqueVisitorStoreReady = true;
    scheduleStatsBroadcast();
    return true;
  } catch (error) {
    warnUniqueStore(error);
    return false;
  }
}

function loadLocalUniqueVisitors() {
  const stored = readLocalJson(UNIQUE_VISITORS_FILE);
  if (!Array.isArray(stored)) return false;
  stored
    .filter(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/i.test(hash))
    .forEach(hash => visitorKeysSeen.add(hash));
  return true;
}

function persistLocalUniqueVisitors() {
  return writeLocalJson(UNIQUE_VISITORS_FILE, [...visitorKeysSeen].sort());
}

async function trackUniqueVisitor(key) {
  const hash = hashVisitorKey(key);
  const firstSeenThisProcess = !visitorKeysSeen.has(hash);
  visitorKeysSeen.add(hash);

  if (!UNIQUE_VISITOR_REMOTE_ENABLED) {
    if (firstSeenThisProcess) persistLocalUniqueVisitors();
    return firstSeenThisProcess;
  }
  if (persistedVisitorHashes.has(hash)) return false;
  if (pendingUniqueWrites.has(hash)) return pendingUniqueWrites.get(hash);

  const write = (async () => {
    try {
      // SADD is atomic: two simultaneous requests for one browser can never
      // increment the permanent total twice. SCARD returns the authoritative
      // count after the write, including visitors recorded by another process.
      const payload = await upstashRequest([
        ['SADD', UNIQUE_VISITOR_REDIS_KEY, hash],
        ['SCARD', UNIQUE_VISITOR_REDIS_KEY]
      ]);
      const added = Number(payload?.[0]?.result) === 1;
      const count = Number(payload?.[1]?.result);
      if (!Number.isFinite(count) || count < 0) throw new Error('Upstash returned an invalid visitor count');

      persistedVisitorHashes.add(hash);
      persistentUniqueCount = count;
      uniqueVisitorStoreReady = true;
      if (added) scheduleStatsBroadcast();
      return added;
    } catch (error) {
      warnUniqueStore(error);
      return false;
    } finally {
      pendingUniqueWrites.delete(hash);
    }
  })();

  pendingUniqueWrites.set(hash, write);
  return write;
}

function getTotalUniqueVisitors() {
  if (UNIQUE_VISITOR_REMOTE_ENABLED) {
    return UNIQUE_VISITOR_BASELINE + persistentUniqueCount;
  }
  return UNIQUE_VISITOR_BASELINE + visitorKeysSeen.size;
}

function normalizeMaintenanceMessage(value) {
  const message = String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  return message || DEFAULT_MAINTENANCE_MESSAGE;
}

/* "Estimated return" pit-board label on the maintenance page. Free text but
   short by nature: control chars stripped, whitespace collapsed, 60 chars. */
function normalizeMaintenanceEta(value) {
  const eta = String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return eta || DEFAULT_MAINTENANCE_ETA;
}

function publicMaintenanceState() {
  return {
    active: Boolean(maintenanceMode.active),
    message: normalizeMaintenanceMessage(maintenanceMode.message),
    eta: normalizeMaintenanceEta(maintenanceMode.eta),
    startedAt: maintenanceMode.startedAt || null,
    updatedAt: maintenanceMode.updatedAt || null
  };
}

function applyMaintenanceState(state) {
  const active = Boolean(state?.active);
  maintenanceMode.active = active;
  maintenanceMode.message = normalizeMaintenanceMessage(state?.message);
  /* Omitted eta = keep the current board (older cached admin clients POST
     without the field; wiping it on every toggle would be a nasty surprise).
     An explicit empty string resets to the default. */
  maintenanceMode.eta = state?.eta === undefined
    ? maintenanceMode.eta
    : normalizeMaintenanceEta(state?.eta);
  maintenanceMode.startedAt = active ? (Number(state?.startedAt) || Date.now()) : null;
  maintenanceMode.updatedAt = Number(state?.updatedAt) || Date.now();
  return publicMaintenanceState();
}

async function syncMaintenanceState() {
  if (!UNIQUE_VISITOR_REMOTE_ENABLED) {
    const stored = readLocalJson(MAINTENANCE_FILE);
    if (stored) applyMaintenanceState(stored);
    maintenanceStoreReady = fileStoreReady;
    return fileStoreReady;
  }

  try {
    const { found, value: stored } = await readUpstashJson(MAINTENANCE_REDIS_KEY);
    if (found) applyMaintenanceState(stored);
    maintenanceStoreReady = true;
    scheduleStatsBroadcast();
    return true;
  } catch (error) {
    warnUniqueStore(error);
    maintenanceStoreReady = false;
    return false;
  }
}

async function persistMaintenanceState() {
  if (!UNIQUE_VISITOR_REMOTE_ENABLED) {
    const saved = writeLocalJson(MAINTENANCE_FILE, publicMaintenanceState());
    maintenanceStoreReady = saved;
    return saved;
  }
  try {
    const payload = await upstashRequest([
      'SET',
      MAINTENANCE_REDIS_KEY,
      JSON.stringify(publicMaintenanceState())
    ]);
    if (payload?.result !== 'OK') throw new Error('Upstash did not confirm the maintenance update');
    maintenanceStoreReady = true;
    return true;
  } catch (error) {
    warnUniqueStore(error);
    maintenanceStoreReady = false;
    return false;
  }
}

function cleanNewsText(value, maxLength, preserveLineBreaks = false) {
  let text = String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u001F\u007F]/g, character => character === '\n' ? '\n' : ' ');
  if (preserveLineBreaks) {
    text = text.split('\n').map(line => line.replace(/[ \t]+/g, ' ').trim()).join('\n');
  } else {
    text = text.replace(/\s+/g, ' ');
  }
  return text.trim().slice(0, maxLength).trim();
}

function createNewsId() {
  return `news_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function normalizeNewsRecord(raw = {}, existing = null) {
  const now = Date.now();
  const source = raw || {};
  const id = existing?.id || cleanNewsText(source.id, 80).replace(/[^A-Za-z0-9_-]/g, '') || createNewsId();
  const createdAt = Number(existing?.createdAt || source.createdAt);
  const updatedAt = Number(source.updatedAt || existing?.updatedAt);
  return {
    id,
    title: cleanNewsText(source.title, 100),
    body: cleanNewsText(source.body, 600, true),
    tag: cleanNewsText(source.tag, 32) || 'Race Control',
    published: source.published !== false,
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : now,
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : now
  };
}

function newsForResponse(item) {
  return {
    id: item.id,
    title: item.title,
    body: item.body,
    tag: item.tag,
    published: Boolean(item.published),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}

function sortNewsItems() {
  newsItems.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
}

function getPublicNewsItems() {
  return newsItems
    .filter(item => item.published && item.title && item.body)
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
    .map(newsForResponse);
}

function getAdminNewsItems() {
  return newsItems
    .slice()
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
    .map(newsForResponse);
}

function newsInputError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function createNewsRecord(input = {}) {
  const item = normalizeNewsRecord(input);
  if (!item.title) throw newsInputError('A news title is required.');
  if (!item.body) throw newsInputError('A news update is required.');
  newsItems.unshift(item);
  sortNewsItems();
  newsItems.splice(NEWS_MAX_ITEMS);
  return item;
}

function updateNewsRecord(id, input = {}) {
  const index = newsItems.findIndex(item => item.id === id);
  if (index < 0) return null;
  const item = normalizeNewsRecord({ ...newsItems[index], ...input, updatedAt: Date.now() }, newsItems[index]);
  if (!item.title) throw newsInputError('A news title is required.');
  if (!item.body) throw newsInputError('A news update is required.');
  newsItems[index] = item;
  sortNewsItems();
  return item;
}

function deleteNewsRecord(id) {
  const index = newsItems.findIndex(item => item.id === id);
  if (index < 0) return false;
  newsItems.splice(index, 1);
  return true;
}

/* Reads a JSON blob out of Upstash. A value that will not parse must not be
   allowed to strand a store in the "connecting" state forever — the old code
   threw on JSON.parse, flipped the store's ready flag off, and never retried,
   so one bad blob meant news (or maintenance, or the feed list) stayed dead
   until someone happened to write to it again. Instead: quarantine the bad
   value under a timestamped key so it can be inspected by hand, report
   `found: false`, and let the caller fall back to defaults — the next save
   then repairs the store naturally. */
async function readUpstashJson(key) {
  const payload = await upstashRequest(['GET', key]);
  const raw = payload?.result;
  if (raw === null || raw === undefined || raw === '') return { found: false, value: undefined };
  try {
    return { found: true, value: JSON.parse(raw) };
  } catch (error) {
    const quarantineKey = `${key}:corrupt:${Date.now()}`;
    upstashRequest(['RENAME', key, quarantineKey]).catch(() => {});
    console.warn(`[Storage] ${key} held an unparseable value (${error.message}); quarantined as ${quarantineKey}.`);
    return { found: false, value: undefined, corrupt: true };
  }
}

async function syncNewsStore() {
  if (!UNIQUE_VISITOR_REMOTE_ENABLED) {
    const stored = readLocalJson(NEWS_FILE);
    const restored = Array.isArray(stored)
      ? stored.map(item => normalizeNewsRecord(item)).filter(item => item.title && item.body).slice(0, NEWS_MAX_ITEMS)
      : [];
    newsItems.splice(0, newsItems.length, ...restored);
    sortNewsItems();
    newsStoreReady = fileStoreReady;
    return fileStoreReady;
  }

  try {
    const { found, value: stored } = await readUpstashJson(NEWS_REDIS_KEY);
    if (found) {
      const restored = Array.isArray(stored)
        ? stored.map(item => normalizeNewsRecord(item)).filter(item => item.title && item.body).slice(0, NEWS_MAX_ITEMS)
        : [];
      newsItems.splice(0, newsItems.length, ...restored);
      sortNewsItems();
    }
    newsStoreReady = true;
    return true;
  } catch (error) {
    warnUniqueStore(error);
    newsStoreReady = false;
    return false;
  }
}

async function persistNewsStore() {
  if (!UNIQUE_VISITOR_REMOTE_ENABLED) {
    const saved = writeLocalJson(NEWS_FILE, newsItems);
    newsStoreReady = saved;
    return saved;
  }
  try {
    const payload = await upstashRequest(['SET', NEWS_REDIS_KEY, JSON.stringify(newsItems)]);
    if (payload?.result !== 'OK') throw new Error('Upstash did not confirm the news update');
    newsStoreReady = true;
    return true;
  } catch (error) {
    warnUniqueStore(error);
    newsStoreReady = false;
    return false;
  }
}

function newsStoreIsDurable() {
  return newsStoreReady;
}

// ─────────────────────────────────────────────
// FEED SOURCE AVAILABILITY
// ─────────────────────────────────────────────

function publicSourceConfig() {
  return {
    sources: FEED_SOURCES.map(source => ({ id: source.id, label: source.label })),
    disabled: [...sourceConfig.disabled],
    updatedAt: sourceConfig.updatedAt
  };
}

function applySourceConfig(state) {
  const disabled = new Set();
  if (Array.isArray(state?.disabled)) {
    for (const id of state.disabled) {
      const key = String(id || '').trim().slice(0, 40);
      if (FEED_SOURCE_IDS.has(key)) disabled.add(key);
    }
  }
  sourceConfig.disabled = disabled;
  sourceConfig.updatedAt = Number(state?.updatedAt) || Date.now();
  return publicSourceConfig();
}

async function syncSourceConfig() {
  if (!UNIQUE_VISITOR_REMOTE_ENABLED) {
    const stored = readLocalJson(SOURCE_CONFIG_FILE);
    if (stored) applySourceConfig(stored);
    sourceStoreReady = fileStoreReady;
    return fileStoreReady;
  }
  try {
    const { found, value: state } = await readUpstashJson(SOURCE_REDIS_KEY);
    if (found) applySourceConfig(state);
    sourceStoreReady = true;
    return true;
  } catch (error) {
    warnUniqueStore(error);
    sourceStoreReady = false;
    return false;
  }
}

async function persistSourceConfig() {
  if (!UNIQUE_VISITOR_REMOTE_ENABLED) {
    const saved = writeLocalJson(SOURCE_CONFIG_FILE, publicSourceConfig());
    sourceStoreReady = saved;
    return saved;
  }
  try {
    const payload = await upstashRequest(['SET', SOURCE_REDIS_KEY, JSON.stringify(publicSourceConfig())]);
    if (payload?.result !== 'OK') throw new Error('Upstash did not confirm the source update');
    sourceStoreReady = true;
    return true;
  } catch (error) {
    warnUniqueStore(error);
    sourceStoreReady = false;
    return false;
  }
}

function broadcastSourceConfig() {
  const payload = publicSourceConfig();
  broadcastSSE('sources_update', payload);
  broadcastPublicSSE('sources_update', payload);
  scheduleStatsBroadcast(0);
  return payload;
}

// ─────────────────────────────────────────────
// STREAM OVERRIDE PERSISTENCE
// ─────────────────────────────────────────────

function storedOverrideState() {
  return {
    active: Boolean(streamOverride.active),
    input: streamOverride.input || null,
    url: streamOverride.url || null,
    type: streamOverride.type || null,
    startedAt: streamOverride.startedAt || null,
    updatedAt: streamOverride.updatedAt || null
  };
}

/* Viewers only ever see a live playback URL. A stopped override keeps its
   URL in the admin panel, but the public payload must not keep playing it. */
function publicOverrideState() {
  return streamOverride.active && streamOverride.url ? {
    active: true,
    url: streamOverride.url,
    type: streamOverride.type,
    startedAt: streamOverride.startedAt || null
  } : { active: false, url: null, type: null, startedAt: null };
}

function adminOverrideState() {
  return {
    active: Boolean(streamOverride.active),
    url: streamOverride.active ? streamOverride.url : null,
    playbackUrl: streamOverride.url || null,
    input: streamOverride.input || null,
    type: streamOverride.type || null,
    startedAt: streamOverride.startedAt || null,
    updatedAt: streamOverride.updatedAt || null,
    durable: overrideStoreReady
  };
}

function applyOverrideState(state = {}) {
  const input = String(state.input || '').trim().slice(0, 2000);
  const classified = input ? classifyStreamURL(input) : { type: null, embedUrl: null };
  const playback = classified.embedUrl || String(state.url || '').trim() || null;
  const active = Boolean(state.active) && Boolean(playback);
  streamOverride.input = input || null;
  streamOverride.url = playback;
  streamOverride.type = classified.type || state.type || null;
  streamOverride.active = active;
  streamOverride.startedAt = active ? (Number(state.startedAt) || Date.now()) : null;
  streamOverride.updatedAt = Number(state.updatedAt) || null;
  return adminOverrideState();
}

function broadcastOverride() {
  const admin = adminOverrideState();
  const pub = publicOverrideState();
  broadcastSSE('stream_override', admin);
  broadcastSSE('stream_update', admin);
  broadcastPublicSSE('stream_override', pub);
  broadcastPublicSSE('stream_update', pub);
  scheduleStatsBroadcast(0);
  return admin;
}

async function syncOverrideState() {
  const applyFound = stored => {
    if (!stored) return false;
    applyOverrideState(stored);
    broadcastPublicSSE('stream_override', publicOverrideState());
    broadcastPublicSSE('stream_update', publicOverrideState());
    scheduleStatsBroadcast();
    return true;
  };
  if (!UNIQUE_VISITOR_REMOTE_ENABLED) {
    applyFound(readLocalJson(OVERRIDE_FILE));
    overrideStoreReady = fileStoreReady;
    return fileStoreReady;
  }
  try {
    const { found, value: stored } = await readUpstashJson(OVERRIDE_REDIS_KEY);
    if (found) applyFound(stored);
    overrideStoreReady = true;
    return true;
  } catch (error) {
    warnUniqueStore(error);
    overrideStoreReady = false;
    return false;
  }
}

async function persistOverrideState() {
  const record = storedOverrideState();
  if (!UNIQUE_VISITOR_REMOTE_ENABLED) {
    const saved = writeLocalJson(OVERRIDE_FILE, record);
    overrideStoreReady = saved;
    return saved;
  }
  try {
    const payload = await upstashRequest(['SET', OVERRIDE_REDIS_KEY, JSON.stringify(record)]);
    if (payload?.result !== 'OK') throw new Error('Upstash did not confirm the stream override');
    overrideStoreReady = true;
    return true;
  } catch (error) {
    warnUniqueStore(error);
    overrideStoreReady = false;
    return false;
  }
}

// Keep the local snapshot in sync if the service is ever scaled beyond one
// process. This is a single lightweight request every five minutes.
const uniqueVisitorSyncTimer = UNIQUE_VISITOR_REMOTE_ENABLED
  ? setInterval(syncUniqueVisitorCount, 5 * 60 * 1000)
  : null;
uniqueVisitorSyncTimer?.unref?.();
if (UNIQUE_VISITOR_REMOTE_ENABLED) {
  syncUniqueVisitorCount();
  maintenanceInitPromise = syncMaintenanceState();
  newsInitPromise = syncNewsStore();
  sourceInitPromise = syncSourceConfig();
  overrideInitPromise = syncOverrideState();
} else {
  loadLocalUniqueVisitors();
  maintenanceInitPromise = syncMaintenanceState();
  newsInitPromise = syncNewsStore();
  sourceInitPromise = syncSourceConfig();
  overrideInitPromise = syncOverrideState();
  if (UPSTASH_REDIS_REST_URL || UPSTASH_REDIS_REST_TOKEN) {
    console.warn('[Visitors] Both Upstash variables are required for remote persistence; using local JSON storage instead.');
  } else if (fileStoreReady) {
    console.log(`[Storage] Using local JSON persistence at ${DATA_DIR}. Configure Upstash or a persistent disk for deploy-safe storage.`);
  } else {
    console.warn('[Storage] Local JSON storage is unavailable; mutable state will remain in memory.');
  }
}

/* A store that failed its boot-time sync used to stay "connecting" forever —
   one transient Upstash blip during startup left news (or maintenance, or the
   feed-source list) dead until someone happened to write to it again. Retry
   the failures on a slow timer until every store reports ready. */
const STORE_RESYNC_INTERVAL_MS = 60_000;
let storeResyncTimer = null;

function pendingStoreSyncs() {
  return [
    { name: 'maintenance', isReady: () => maintenanceStoreReady, sync: syncMaintenanceState },
    { name: 'news', isReady: () => newsStoreReady, sync: syncNewsStore },
    { name: 'sources', isReady: () => sourceStoreReady, sync: syncSourceConfig },
    { name: 'override', isReady: () => overrideStoreReady, sync: syncOverrideState }
  ];
}

async function resyncPendingStores() {
  if (!UNIQUE_VISITOR_REMOTE_ENABLED) return;
  for (const store of pendingStoreSyncs()) {
    if (store.isReady()) continue;
    try {
      if (await store.sync()) {
        console.log(`[Storage] ${store.name} store reconnected.`);
        broadcastSourceConfig();
      }
    } catch (error) {
      // sync* already logs through warnUniqueStore; swallow to keep the timer alive.
    }
  }
}

function startStoreResyncTimer() {
  if (storeResyncTimer || !UNIQUE_VISITOR_REMOTE_ENABLED) return;
  storeResyncTimer = setInterval(resyncPendingStores, STORE_RESYNC_INTERVAL_MS);
  storeResyncTimer?.unref?.();
}

startStoreResyncTimer();


// ─────────────────────────────────────────────
// VISITOR TRACKING
// ─────────────────────────────────────────────

function getClientIp(req) {
  const raw = String(req.headers['x-forwarded-for'] || req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown')
    .split(',')[0]
    .trim();
  if (raw === '::1') return '127.0.0.1';
  return raw.replace(/^::ffff:/, '') || 'unknown';
}

function normalizeVisitorId(value) {
  return String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9_.:@-]/g, '')
    .slice(0, 128);
}

function createVisitorToken(userId) {
  const payload = Buffer.from(JSON.stringify({
    id: userId,
    exp: Date.now() + VISITOR_TOKEN_TTL_MS
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', VISITOR_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyVisitorToken(token, userId) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return false;
  const [payload, signature] = parts;
  const expected = crypto.createHmac('sha256', VISITOR_SECRET).update(payload).digest('base64url');
  if (!safeEqual(signature, expected)) return false;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return normalizeVisitorId(decoded.id) === userId && Number(decoded.exp) > Date.now();
  } catch (_) {
    return false;
  }
}

function consumeVisitorRateLimit(key) {
  const now = Date.now();
  const current = visitorRateLimits.get(key);
  if (!current || current.resetAt <= now) {
    visitorRateLimits.set(key, { count: 1, resetAt: now + VISITOR_RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (current.count >= VISITOR_RATE_LIMIT_MAX) return false;
  current.count++;
  return true;
}

function findVisitorKeyByIp(ip) {
  const key = visitorKeyByIp.get(ip);
  if (key && activeUsers.has(key)) return key;
  if (key) visitorKeyByIp.delete(ip);
  return null;
}

function pageFromReferer(req, fallback = '/') {
  const referer = req.headers.referer || req.headers.referrer || '';
  if (!referer) return fallback;
  try {
    const parsed = new URL(referer);
    return parsed.pathname + parsed.search;
  } catch (_) {
    return fallback;
  }
}

function isStaticAssetPath(requestPath) {
  return /\.(?:css|js|mjs|map|png|jpe?g|gif|webp|svg|ico|avif|bmp|webmanifest|json|txt|xml|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|ogg|m4a)$/i.test(requestPath);
}

function getVisitorRouteKey(req) {
  const ip = getClientIp(req);
  const suppliedId = normalizeVisitorId(req.headers['x-user-id']);
  return suppliedId || ip;
}

function upsertVisitor(key, req, options = {}) {
  const now = Date.now();
  const ip = getClientIp(req);
  const ua = req.headers['user-agent'] || '';
  const { browser, os, deviceType } = parseUA(ua);
  const page = options.page || req.path || '/';

  let entry = activeUsers.get(key);
  const isNew = !entry;

  if (!entry) {
    entry = {
      id: key,
      ip,
      country: null,
      city: null,
      countryCode: null,
      browser,
      os,
      deviceType,
      page,
      connectedAt: now,
      lastSeen: now,
      online: true,
      source: options.source || 'page'
    };
    activeUsers.set(key, entry);
    if (ip && ip !== 'unknown') visitorKeyByIp.set(ip, key);

    lookupGeo(ip).then(geo => {
      if (!geo || !activeUsers.has(key)) return;
      const current = activeUsers.get(key);
      current.country = geo.country || null;
      current.city = geo.city || null;
      current.countryCode = geo.countryCode || null;
      recordSessionGeo(current);
      broadcastVisitorChange('geo', current, false);
    });
  } else {
    entry.ip = entry.ip || ip;
    entry.browser = browser || entry.browser;
    entry.os = os || entry.os;
    entry.deviceType = deviceType || entry.deviceType;
    entry.page = options.keepExistingPage ? (entry.page || page) : page;
    entry.lastSeen = now;
    entry.online = true;
    entry.source = options.source || entry.source || 'page';
    if (entry.ip && entry.ip !== 'unknown') visitorKeyByIp.set(entry.ip, key);
  }

  return { entry, isNew };
}

// Applied to site-serving routes only (not admin, APIs, health checks, or assets).
function visitorTracking(req, res, next) {
  if (
    req.path.startsWith('/admin') ||
    req.path.startsWith('/api/') ||
    req.path === '/healthz' ||
    req.path === '/favicon.ico' ||
    isStaticAssetPath(req.path)
  ) {
    return next();
  }

  const key = getVisitorRouteKey(req);
  const { entry, isNew } = upsertVisitor(key, req, {
    page: req.originalUrl || req.path || '/',
    source: 'page'
  });

  // Never hold up page delivery for remote analytics storage.
  trackUniqueVisitor(key).catch(warnUniqueStore);
  broadcastVisitorChange(isNew ? 'online' : 'update', entry, isNew);
  next();
}

app.use(visitorTracking);


// ─────────────────────────────────────────────
// AUDIENCE ANALYTICS
// Aggregated, anonymous counters only: no IPs, no visitor IDs, no raw
// user agents. Hourly buckets are kept for 14 days, daily buckets for 90,
// plus a one-minute concurrent-viewer series for the last 24 hours.
// ─────────────────────────────────────────────

const ANALYTICS_HOURLY_RETENTION_HOURS = Number(process.env.ANALYTICS_HOURLY_RETENTION_HOURS || 14 * 24);
const ANALYTICS_DAILY_RETENTION_DAYS = Number(process.env.ANALYTICS_DAILY_RETENTION_DAYS || 90);
const ANALYTICS_LIVE_POINTS = 24 * 60;
const ANALYTICS_FLUSH_MS = Number(process.env.ANALYTICS_FLUSH_MS || 60_000);
const ANALYTICS_SAMPLE_MS = 60_000;
const ANALYTICS_MAP_CAP = { device: 8, browser: 24, os: 16, country: 250, pages: 8, source: 16, team: 16 };
const SITE_PAGES = new Set(['/', '/news', '/info']);
const DURATION_BINS_MS = [60_000, 5 * 60_000, 15 * 60_000, 45 * 60_000, 120 * 60_000]; // <1m, 1–5m, 5–15m, 15–45m, 45m–2h, 2h+

const analytics = { hourly: new Map(), daily: new Map(), live: [], since: null };
const analyticsDirty = { hourly: new Set(), daily: new Set(), removed: new Set(), live: false, meta: false, significant: false };
const ANALYTICS_IDLE_FLUSH_MS = Number(process.env.ANALYTICS_IDLE_FLUSH_MS || 5 * 60_000);
let analyticsSampling = false;
let lastAnalyticsFlushAt = Date.now();
let analyticsStoreReady = false;
let analyticsHydrated = false;
let analyticsFlushInFlight = null;
let analyticsInitPromise = null;

function newAnalyticsBucket() {
  return {
    sessions: 0, ended: 0, durationMs: 0, durHist: [0, 0, 0, 0, 0, 0],
    newVisitors: 0, returning: 0, pageViews: 0,
    peakOnline: 0, onlineSum: 0, onlineSamples: 0,
    device: {}, browser: {}, os: {}, country: {}, pages: {}, source: {}, team: {},
    fullscreen: 0, nostream: 0, streamReady: 0, streamReadyMs: 0, streamTimeout: 0, streamBlocked: 0, streamHijack: 0
  };
}

const analyticsHourKey = ts => Math.floor(ts / 3_600_000);
const analyticsDayKey = ts => new Date(ts).toISOString().slice(0, 10);

function analyticsHourCutoff(now = Date.now()) { return analyticsHourKey(now) - ANALYTICS_HOURLY_RETENTION_HOURS; }
function analyticsDayCutoff(now = Date.now()) { return analyticsDayKey(now - ANALYTICS_DAILY_RETENTION_DAYS * 86_400_000); }

// Apply a mutation to the hourly and daily bucket that own `ts`.
function mutateAnalytics(ts, fn) {
  const now = Date.now();
  const stamp = Number.isFinite(ts) ? Math.min(ts, now) : now;
  const hk = analyticsHourKey(stamp);
  if (hk > analyticsHourCutoff(now)) {
    let bucket = analytics.hourly.get(hk);
    if (!bucket) analytics.hourly.set(hk, bucket = newAnalyticsBucket());
    fn(bucket);
    analyticsDirty.hourly.add(hk);
  }
  const dk = analyticsDayKey(stamp);
  if (dk >= analyticsDayCutoff(now)) {
    let bucket = analytics.daily.get(dk);
    if (!bucket) analytics.daily.set(dk, bucket = newAnalyticsBucket());
    fn(bucket);
    analyticsDirty.daily.add(dk);
  }
  if (!analytics.since) { analytics.since = stamp; analyticsDirty.meta = true; }
  if (!analyticsSampling) analyticsDirty.significant = true;
}

function incCounter(map, rawKey, cap) {
  let key = String(rawKey || 'Unknown').trim().slice(0, 32) || 'Unknown';
  if (!(key in map) && Object.keys(map).length >= cap) key = 'Other';
  map[key] = (map[key] || 0) + 1;
}

function browserFamily(browser) { return String(browser || 'Unknown').replace(/\s+[\d.]+$/, ''); }
function osFamily(os) { return String(os || 'Unknown').split(' ')[0] || 'Unknown'; }
function durationBin(ms) {
  let bin = 0;
  while (bin < DURATION_BINS_MS.length && ms >= DURATION_BINS_MS[bin]) bin++;
  return bin;
}

function normalizeSitePage(value) {
  if (typeof value !== 'string' || !value) return null;
  let page = value.trim().slice(0, 64);
  const query = page.indexOf('?');
  if (query >= 0) page = page.slice(0, query);
  if (!page.startsWith('/')) return null;
  if (page.length > 1 && page.endsWith('/')) page = page.slice(0, -1);
  return SITE_PAGES.has(page) ? page : '/other';
}

function recordSessionStart(entry) {
  if (!entry || entry.analyticsStarted) return;
  entry.analyticsStarted = true;
  const online = countOnlineUsers();
  const page = normalizeSitePage(entry.page) || '/other';
  const hasGeo = Boolean(entry.countryCode);
  if (hasGeo) entry.analyticsGeo = true;
  mutateAnalytics(entry.connectedAt, bucket => {
    bucket.sessions++;
    bucket.pageViews++;
    incCounter(bucket.device, entry.deviceType, ANALYTICS_MAP_CAP.device);
    incCounter(bucket.browser, browserFamily(entry.browser), ANALYTICS_MAP_CAP.browser);
    incCounter(bucket.os, osFamily(entry.os), ANALYTICS_MAP_CAP.os);
    incCounter(bucket.pages, page, ANALYTICS_MAP_CAP.pages);
    if (hasGeo) incCounter(bucket.country, entry.countryCode, ANALYTICS_MAP_CAP.country);
    if (online > bucket.peakOnline) bucket.peakOnline = online;
  });
}

function recordSessionGeo(entry) {
  if (!entry?.analyticsStarted || entry.analyticsGeo || !entry.countryCode) return;
  entry.analyticsGeo = true;
  mutateAnalytics(entry.connectedAt, bucket => incCounter(bucket.country, entry.countryCode, ANALYTICS_MAP_CAP.country));
}

function recordVisitorKind(entry, isGloballyNew) {
  if (!entry?.analyticsStarted || entry.analyticsKind) return;
  entry.analyticsKind = true;
  mutateAnalytics(entry.connectedAt, bucket => { if (isGloballyNew) bucket.newVisitors++; else bucket.returning++; });
}

function recordSessionEnd(entry, endedAt = entry?.lastSeen) {
  if (!entry?.analyticsStarted || entry.analyticsEnded) return;
  entry.analyticsEnded = true;
  const duration = Math.max(0, Number(endedAt || Date.now()) - Number(entry.connectedAt || endedAt));
  mutateAnalytics(entry.connectedAt, bucket => {
    bucket.ended++;
    bucket.durationMs += duration;
    bucket.durHist[durationBin(duration)]++;
  });
}

function recordViewerEvent(type, value, entry) {
  const now = Date.now();
  switch (type) {
    case 'view': {
      const page = normalizeSitePage(value);
      if (!page) return false;
      if (entry) entry.page = page;
      mutateAnalytics(now, bucket => { bucket.pageViews++; incCounter(bucket.pages, page, ANALYTICS_MAP_CAP.pages); });
      return true;
    }
    case 'source': {
      const label = String(value || '').replace(/[^\w .+-]/g, '').trim().slice(0, 24);
      if (!label) return false;
      mutateAnalytics(now, bucket => incCounter(bucket.source, label, ANALYTICS_MAP_CAP.source));
      return true;
    }
    case 'team': {
      const slug = String(value || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
      if (!slug) return false;
      mutateAnalytics(now, bucket => incCounter(bucket.team, slug, ANALYTICS_MAP_CAP.team));
      return true;
    }
    case 'fullscreen': mutateAnalytics(now, bucket => { bucket.fullscreen++; }); return true;
    case 'nostream': mutateAnalytics(now, bucket => { bucket.nostream++; }); return true;
    case 'stream_timeout': mutateAnalytics(now, bucket => { bucket.streamTimeout++; }); return true;
    // No feed source committed a document on this device (network-level block).
    case 'stream_blocked': mutateAnalytics(now, bucket => { bucket.streamBlocked++; }); return true;
    // Embed ad layer tab-swapped the player frame away from the stream.
    case 'stream_hijack': mutateAnalytics(now, bucket => { bucket.streamHijack++; }); return true;
    case 'stream_ready': {
      const ms = Number(value);
      if (!Number.isFinite(ms) || ms < 0) return false;
      const clamped = Math.min(Math.round(ms), 60_000);
      mutateAnalytics(now, bucket => { bucket.streamReady++; bucket.streamReadyMs += clamped; });
      return true;
    }
    default:
      return false;
  }
}

// One sample per minute: the concurrent-viewer curve and per-bucket averages/peaks.
function sampleAnalytics() {
  const now = Date.now();
  const minute = Math.floor(now / 60_000) * 60_000;
  const online = countOnlineUsers(now);
  const last = analytics.live[analytics.live.length - 1];
  if (last && last[0] === minute) last[1] = Math.max(last[1], online);
  else analytics.live.push([minute, online]);
  if (analytics.live.length > ANALYTICS_LIVE_POINTS) analytics.live.splice(0, analytics.live.length - ANALYTICS_LIVE_POINTS);
  analyticsDirty.live = true;
  analyticsSampling = true;
  try {
    mutateAnalytics(now, bucket => {
      bucket.onlineSum += online;
      bucket.onlineSamples++;
      if (online > bucket.peakOnline) bucket.peakOnline = online;
    });
  } finally {
    analyticsSampling = false;
  }
  pruneAnalytics(now);
}

// Write every minute while something is happening; only every few minutes when
// the minute sampler is the sole source of changes (keeps Upstash usage low).
function flushAnalyticsIfDue() {
  if (!analyticsIsDirty()) return;
  if (analyticsDirty.significant || Date.now() - lastAnalyticsFlushAt >= ANALYTICS_IDLE_FLUSH_MS) flushAnalytics().catch(() => {});
}

function pruneAnalytics(now = Date.now()) {
  const hourCutoff = analyticsHourCutoff(now);
  for (const key of analytics.hourly.keys()) {
    if (key <= hourCutoff) { analytics.hourly.delete(key); analyticsDirty.hourly.delete(key); analyticsDirty.removed.add(`h:${key}`); }
  }
  const dayCutoff = analyticsDayCutoff(now);
  for (const key of analytics.daily.keys()) {
    if (key < dayCutoff) { analytics.daily.delete(key); analyticsDirty.daily.delete(key); analyticsDirty.removed.add(`d:${key}`); }
  }
  const liveCutoff = now - ANALYTICS_LIVE_POINTS * 60_000;
  while (analytics.live.length && analytics.live[0][0] < liveCutoff) { analytics.live.shift(); analyticsDirty.live = true; }
}

// Drop zero counters so idle hours serialize to a few bytes.
function compactAnalyticsBucket(bucket) {
  const out = {};
  for (const [key, value] of Object.entries(bucket)) {
    if (Array.isArray(value)) { if (value.some(Boolean)) out[key] = value; }
    else if (value && typeof value === 'object') { if (Object.keys(value).length) out[key] = value; }
    else if (value) out[key] = value;
  }
  return out;
}

function mergeAnalyticsBucket(target, stored) {
  if (!stored || typeof stored !== 'object') return target;
  for (const key of Object.keys(target)) {
    const value = stored[key];
    if (value == null) continue;
    if (Array.isArray(target[key])) {
      target[key] = target[key].map((current, index) => current + (Number(value[index]) || 0));
    } else if (typeof target[key] === 'object') {
      for (const [name, count] of Object.entries(value)) {
        const n = Number(count) || 0;
        if (n > 0) target[key][String(name).slice(0, 32)] = (target[key][name] || 0) + n;
      }
    } else if (key === 'peakOnline') {
      target.peakOnline = Math.max(target.peakOnline, Number(value) || 0);
    } else {
      target[key] += Math.max(0, Number(value) || 0);
    }
  }
  return target;
}

function hydrateAnalyticsBucket(map, key, stored) {
  const merged = mergeAnalyticsBucket(map.get(key) || newAnalyticsBucket(), stored);
  map.set(key, merged);
}

function hydrateAnalyticsLive(stored) {
  if (!Array.isArray(stored)) return;
  const byMinute = new Map(analytics.live);
  for (const point of stored) {
    if (!Array.isArray(point)) continue;
    const minute = Number(point[0]), count = Number(point[1]);
    if (!Number.isFinite(minute) || !Number.isFinite(count)) continue;
    byMinute.set(minute, Math.max(byMinute.get(minute) || 0, count));
  }
  analytics.live = [...byMinute.entries()].sort((a, b) => a[0] - b[0]).slice(-ANALYTICS_LIVE_POINTS);
}

function hydrateAnalyticsField(field, raw) {
  let value;
  try { value = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { return; }
  if (field === 'live') return hydrateAnalyticsLive(value);
  if (field === 'meta') {
    const since = Number(value?.since);
    if (Number.isFinite(since) && since > 0) analytics.since = analytics.since ? Math.min(analytics.since, since) : since;
    return;
  }
  if (field.startsWith('h:')) {
    const key = Number(field.slice(2));
    if (Number.isFinite(key)) hydrateAnalyticsBucket(analytics.hourly, key, value);
  } else if (field.startsWith('d:')) {
    const key = field.slice(2);
    if (/^\d{4}-\d{2}-\d{2}$/.test(key)) hydrateAnalyticsBucket(analytics.daily, key, value);
  }
}

async function syncAnalyticsStore() {
  try {
    if (!UNIQUE_VISITOR_REMOTE_ENABLED) {
      const stored = readLocalJson(ANALYTICS_FILE);
      if (stored && typeof stored === 'object') {
        for (const [key, bucket] of Object.entries(stored.hourly || {})) hydrateAnalyticsField(`h:${key}`, bucket);
        for (const [key, bucket] of Object.entries(stored.daily || {})) hydrateAnalyticsField(`d:${key}`, bucket);
        hydrateAnalyticsField('live', stored.live);
        hydrateAnalyticsField('meta', { since: stored.since });
      }
      analyticsStoreReady = fileStoreReady;
    } else {
      const payload = await upstashRequest(['HGETALL', ANALYTICS_REDIS_KEY]);
      const flat = Array.isArray(payload?.result) ? payload.result : [];
      for (let i = 0; i + 1 < flat.length; i += 2) hydrateAnalyticsField(String(flat[i]), flat[i + 1]);
      analyticsStoreReady = true;
    }
  } catch (error) {
    warnUniqueStore(error);
    analyticsStoreReady = false;
  } finally {
    pruneAnalytics();
    analyticsHydrated = true;
  }
  return analyticsStoreReady;
}

function analyticsIsDirty() {
  return analyticsDirty.live || analyticsDirty.meta || analyticsDirty.hourly.size > 0 || analyticsDirty.daily.size > 0 || analyticsDirty.removed.size > 0;
}

function flushAnalytics(force = false) {
  // A write in progress may not contain the latest counters: run again after it.
  if (analyticsFlushInFlight) return analyticsFlushInFlight.then(() => flushAnalytics(force));
  if (!analyticsHydrated) return Promise.resolve(false);
  if (!force && !analyticsIsDirty()) return Promise.resolve(true);

  const hourly = [...analyticsDirty.hourly], daily = [...analyticsDirty.daily], removed = [...analyticsDirty.removed];
  const writeLive = analyticsDirty.live || force, writeMeta = analyticsDirty.meta || force;
  analyticsDirty.hourly.clear(); analyticsDirty.daily.clear(); analyticsDirty.removed.clear();
  analyticsDirty.live = false; analyticsDirty.meta = false; analyticsDirty.significant = false;
  lastAnalyticsFlushAt = Date.now();

  const restoreDirty = () => {
    hourly.forEach(key => analyticsDirty.hourly.add(key));
    daily.forEach(key => analyticsDirty.daily.add(key));
    removed.forEach(key => analyticsDirty.removed.add(key));
    if (writeLive) analyticsDirty.live = true;
    if (writeMeta) analyticsDirty.meta = true;
  };

  // The local-file branch has no await, so the IIFE settles synchronously and a
  // `finally` inside it would clear the marker *before* the assignment below.
  const run = (async () => {
    try {
      if (!UNIQUE_VISITOR_REMOTE_ENABLED) {
        const snapshot = {
          version: 1,
          since: analytics.since,
          savedAt: Date.now(),
          live: analytics.live,
          hourly: Object.fromEntries([...analytics.hourly].map(([key, bucket]) => [key, compactAnalyticsBucket(bucket)])),
          daily: Object.fromEntries([...analytics.daily].map(([key, bucket]) => [key, compactAnalyticsBucket(bucket)]))
        };
        const saved = writeLocalJson(ANALYTICS_FILE, snapshot);
        analyticsStoreReady = saved;
        if (!saved) restoreDirty();
        return saved;
      }

      const fields = [];
      for (const key of hourly) { const bucket = analytics.hourly.get(key); if (bucket) fields.push(`h:${key}`, JSON.stringify(compactAnalyticsBucket(bucket))); }
      for (const key of daily) { const bucket = analytics.daily.get(key); if (bucket) fields.push(`d:${key}`, JSON.stringify(compactAnalyticsBucket(bucket))); }
      if (writeLive) fields.push('live', JSON.stringify(analytics.live));
      if (writeMeta) fields.push('meta', JSON.stringify({ version: 1, since: analytics.since, savedAt: Date.now() }));
      const commands = [];
      for (let i = 0; i < fields.length; i += 120) commands.push(['HSET', ANALYTICS_REDIS_KEY, ...fields.slice(i, i + 120)]);
      if (removed.length) commands.push(['HDEL', ANALYTICS_REDIS_KEY, ...removed]);
      if (commands.length) await upstashRequest(commands);
      analyticsStoreReady = true;
      return true;
    } catch (error) {
      warnUniqueStore(error);
      analyticsStoreReady = false;
      restoreDirty();
      return false;
    }
  })();
  analyticsFlushInFlight = run;
  run.finally(() => { if (analyticsFlushInFlight === run) analyticsFlushInFlight = null; });
  return run;
}

/* ── Audience analytics: range shapes (shared with admin/analytics.js) ──
   Hourly buckets are the expensive part of the payload (up to 336 of them),
   so the dashboard asks for the window it is actually drawing instead of the
   whole retention period, and the server pre-aggregates the two views that
   legitimately need everything (the weekday x hour heat-map and the busiest
   hours table). */
const ANALYTICS_RANGES = {
  '24h': { hours: 24, granularity: 'hour' },
  '7d': { hours: 7 * 24, granularity: 'hour' },
  '14d': { hours: 14 * 24, granularity: 'hour' },
  '30d': { days: 30, granularity: 'day' },
  '90d': { days: 90, granularity: 'day' }
};
const ANALYTICS_DEFAULT_RANGE = '7d';

function analyticsHourStart(ts) { return analyticsHourKey(ts) * 3_600_000; }

/* Sum every bucket in [startHour, endHour] (inclusive hour keys) into one
   aggregate. Reuses the hydration merge so the shapes can never drift. */
function aggregateHourlyRange(startHourKey, endHourKey) {
  const total = mergeAnalyticsBucket(newAnalyticsBucket(), null);
  for (const [key, bucket] of analytics.hourly) {
    if (key < startHourKey || key > endHourKey) continue;
    mergeAnalyticsBucket(total, compactAnalyticsBucket(bucket));
  }
  return compactAnalyticsBucket(total);
}

function aggregateDailyRange(startDayKey, endDayKey) {
  const total = mergeAnalyticsBucket(newAnalyticsBucket(), null);
  for (const [key, bucket] of analytics.daily) {
    if (key < startDayKey || key > endDayKey) continue;
    mergeAnalyticsBucket(total, compactAnalyticsBucket(bucket));
  }
  return compactAnalyticsBucket(total);
}

/* Weekday x hour average concurrent viewers, plus the busiest hours table.
   Both are computed from the full hourly retention exactly once per request
   so the browser never has to download 336 buckets to draw them. */
const WEEKDAY_INDEX = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

function safeTimeZone(value) {
  const zone = String(value || '').trim().slice(0, 64);
  if (!zone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0);
    return zone;
  } catch (_) {
    return 'UTC';
  }
}

/* Hour and weekday in an explicit zone. `Date#getHours()` is the server
   process zone (UTC on Render), which made the heat map two hours early for
   an admin in Johannesburg while the caption claimed local time. */
function zonedHourParts(ts, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23'
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(ts)).map(part => [part.type, part.value]));
  let hour = Number(parts.hour);
  if (!Number.isFinite(hour) || hour === 24) hour = 0;
  return { day: WEEKDAY_INDEX[parts.weekday] ?? 0, hour };
}

function analyticsOverview(timeZone = 'UTC') {
  const sums = Array.from({ length: 7 }, () => Array(24).fill(0));
  const counts = Array.from({ length: 7 }, () => Array(24).fill(0));
  const busiest = [];

  for (const [key, bucket] of analytics.hourly) {
    const { day, hour } = zonedHourParts(key * 3_600_000, timeZone);
    sums[day][hour] += bucket.onlineSamples ? bucket.onlineSum / bucket.onlineSamples : 0;
    counts[day][hour]++;
    if ((bucket.peakOnline || 0) > 0) {
      busiest.push({
        t: key * 3_600_000,
        peakOnline: bucket.peakOnline || 0,
        onlineSum: bucket.onlineSum || 0,
        onlineSamples: bucket.onlineSamples || 0,
        sessions: bucket.sessions || 0,
        ended: bucket.ended || 0,
        durationMs: bucket.durationMs || 0,
        country: Object.entries(bucket.country || {})
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([code]) => code)
      });
    }
  }

  busiest.sort((a, b) => (b.peakOnline - a.peakOnline) || (b.sessions - a.sessions));
  return {
    heatmap: sums.map((row, day) => row.map((value, hour) => (counts[day][hour] ? value / counts[day][hour] : 0))),
    busiest: busiest.slice(0, 8)
  };
}

function getAnalyticsSnapshot(rangeKey = null, timeZone = 'UTC') {
  const now = Date.now();
  let openSessions = 0, openSessionMs = 0;
  for (const visitor of activeUsers.values()) {
    if (!visitor.analyticsStarted || now - visitor.lastSeen > HEARTBEAT_TIMEOUT) continue;
    openSessions++;
    openSessionMs += now - visitor.connectedAt;
  }

  const spec = ANALYTICS_RANGES[rangeKey] || null;
  let hourly = [...analytics.hourly].sort((a, b) => a[0] - b[0]);
  let daily = [...analytics.daily].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  let previous = null;

  if (spec) {
    if (spec.granularity === 'hour') {
      const end = analyticsHourKey(now);
      const start = end - (spec.hours - 1);
      // The previous window is aggregated server-side so the client can keep
      // drawing deltas without downloading twice as many buckets.
      previous = aggregateHourlyRange(start - spec.hours, start - 1);
      hourly = hourly.filter(([key]) => key >= start && key <= end);
      // Daily buckets are still handy for the range label/CSV continuity but
      // only the ones that overlap the window can matter.
      daily = daily.slice(-Math.max(1, Math.ceil(spec.hours / 24) + 1));
    } else {
      const dayKey = ts => analyticsDayKey(ts);
      const endDay = dayKey(now);
      const startDay = dayKey(now - (spec.days - 1) * 86_400_000);
      const prevEnd = dayKey(now - spec.days * 86_400_000);
      const prevStart = dayKey(now - (spec.days * 2 - 1) * 86_400_000);
      previous = aggregateDailyRange(prevStart, prevEnd);
      daily = daily.filter(([key]) => key >= startDay && key <= endDay);
      hourly = [];
    }
  }

  return {
    generatedAt: now,
    since: analytics.since,
    range: spec ? rangeKey : 'all',
    retention: { hourlyHours: ANALYTICS_HOURLY_RETENTION_HOURS, dailyDays: ANALYTICS_DAILY_RETENTION_DAYS, liveMinutes: ANALYTICS_LIVE_POINTS },
    store: dataStoreStatus(UNIQUE_VISITOR_REMOTE_ENABLED, analyticsStoreReady),
    serverStartedAt: SERVER_STARTED_AT,
    current: { online: countOnlineUsers(now), openSessions, openSessionMs },
    live: analytics.live,
    hourly: hourly.map(([key, bucket]) => ({ t: key * 3_600_000, ...compactAnalyticsBucket(bucket) })),
    daily: daily.map(([key, bucket]) => ({ d: key, t: Date.parse(`${key}T00:00:00Z`), ...compactAnalyticsBucket(bucket) })),
    // Only sent for a range-scoped request: everything that needs the whole
    // retention period, pre-aggregated.
    timezone: timeZone,
    previous: spec ? previous : null,
    overview: spec ? analyticsOverview(timeZone) : null
  };
}

analyticsInitPromise = syncAnalyticsStore();
const analyticsSampleTimer = setInterval(sampleAnalytics, ANALYTICS_SAMPLE_MS);
analyticsSampleTimer.unref?.();
const analyticsFlushTimer = setInterval(flushAnalyticsIfDue, ANALYTICS_FLUSH_MS);
analyticsFlushTimer.unref?.();
analyticsInitPromise.then(() => sampleAnalytics());

// ─────────────────────────────────────────────
// CLEANUP LOOP
// ─────────────────────────────────────────────

function cleanupInactiveVisitors() {
  const now = Date.now();
  for (const [key, state] of loginAttempts) if (state.resetAt <= now) loginAttempts.delete(key);
  for (const [key, state] of visitorRateLimits) if (state.resetAt <= now) visitorRateLimits.delete(key);
  let removed = 0;
  for (const [id, visitor] of activeUsers) {
    if (now - visitor.lastSeen > HEARTBEAT_TIMEOUT) {
      visitor.online = false;
      recordSessionEnd(visitor);
      broadcastSSE('visitor_update', { type: 'offline', visitor: sanitizeVisitor(visitor) });
      activeUsers.delete(id);
      if (visitorKeyByIp.get(visitor.ip) === id) visitorKeyByIp.delete(visitor.ip);
      removed++;
    }
  }
  if (removed) scheduleStatsBroadcast();
}

setInterval(cleanupInactiveVisitors, CLEANUP_INTERVAL).unref?.();

function sanitizeVisitor(v) {
  const now = Date.now();
  const lastSeen = Number(v.lastSeen || v.connectedAt || now);
  return {
    id: v.id,
    ip: v.ip,
    country: v.country,
    city: v.city,
    countryCode: v.countryCode,
    browser: v.browser,
    os: v.os,
    deviceType: v.deviceType,
    page: v.page,
    connectedAt: v.connectedAt,
    lastSeen,
    online: now - lastSeen <= HEARTBEAT_TIMEOUT,
    source: v.source
  };
}

function countOnlineUsers(now = Date.now()) {
  let count = 0;
  for (const visitor of activeUsers.values()) if (now - visitor.lastSeen <= HEARTBEAT_TIMEOUT) count++;
  return count;
}

function getStats() {
  const now = Date.now();
  let onlineCount = 0;
  const visitors = [];

  for (const visitor of activeUsers.values()) {
    const sanitized = sanitizeVisitor(visitor);
    if (sanitized.online) onlineCount++;
    visitors.push(sanitized);
  }

  visitors.sort((a, b) => b.lastSeen - a.lastSeen);

  return {
    onlineCount,
    activeSessions: activeUsers.size,
    totalUnique: getTotalUniqueVisitors(),
    visitors,
    override: adminOverrideState(),
    maintenance: publicMaintenanceState(),
    sources: publicSourceConfig(),
    server: {
      startedAt: SERVER_STARTED_AT,
      uptimeMs: now - SERVER_STARTED_AT,
      // Authoritative server clock: the dashboard sits in the viewer's
      // timezone while the service runs on UTC, so "Server Time" must not be
      // rendered from the browser's Date.
      now,
      timezone: SERVER_TIMEZONE,
      nodeEnv: process.env.NODE_ENV || 'development',
      uniqueVisitorStore: dataStoreStatus(UNIQUE_VISITOR_REMOTE_ENABLED, uniqueVisitorStoreReady),
      maintenanceStore: dataStoreStatus(UNIQUE_VISITOR_REMOTE_ENABLED, maintenanceStoreReady),
      newsStore: dataStoreStatus(UNIQUE_VISITOR_REMOTE_ENABLED, newsStoreReady),
      sourceStore: dataStoreStatus(UNIQUE_VISITOR_REMOTE_ENABLED, sourceStoreReady),
      overrideStore: dataStoreStatus(UNIQUE_VISITOR_REMOTE_ENABLED, overrideStoreReady),
      analyticsStore: dataStoreStatus(UNIQUE_VISITOR_REMOTE_ENABLED, analyticsStoreReady)
    }
  };
}

// ─────────────────────────────────────────────
// STATIC FILES — Main site
// ─────────────────────────────────────────────

const SITE_INDEX_PATH = findIndexHtml(DEV_DIR);
const SITE_INDEX_EXISTS = Boolean(SITE_INDEX_PATH && fs.existsSync(SITE_INDEX_PATH));
const MAINTENANCE_PAGE_PATH = SITE_INDEX_PATH
  ? path.join(path.dirname(SITE_INDEX_PATH), 'maintenance.html')
  : path.join(DEV_DIR, 'maintenance.html');

console.log(`[Config] DEV_DIR   = ${DEV_DIR}`);
console.log(`[Config] ADMIN_DIR = ${ADMIN_DIR}`);
console.log(`[Config] DEV_DIR exists: ${fs.existsSync(DEV_DIR)}`);
console.log(`[Config] ADMIN_DIR exists: ${fs.existsSync(ADMIN_DIR)}`);
console.log(`[Config] Allowed origins: ${ALLOWED_ORIGINS.join(', ') || '(same-origin/local only)'}`);

// Intercept the explicit index path before static middleware so maintenance
// mode cannot be bypassed when this server is also serving the public site.
app.get('/index.html', sendSiteIndex);

app.use(express.static(DEV_DIR, {
  index: false,
  fallthrough: true,
  etag: true,
  lastModified: true,
  maxAge: process.env.NODE_ENV === 'production' ? '7d' : 0,
  setHeaders(res, filePath) {
    if (/\.html?$/i.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    else if (/\.(?:css|m?js)$/i.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
    else if (filePath.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=2592000');
  }
}));

app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    uptimeMs: Date.now() - SERVER_STARTED_AT,
    uniqueVisitorStore: dataStoreStatus(UNIQUE_VISITOR_REMOTE_ENABLED, uniqueVisitorStoreReady),
    maintenanceStore: dataStoreStatus(UNIQUE_VISITOR_REMOTE_ENABLED, maintenanceStoreReady),
    newsStore: dataStoreStatus(UNIQUE_VISITOR_REMOTE_ENABLED, newsStoreReady),
    sourceStore: dataStoreStatus(UNIQUE_VISITOR_REMOTE_ENABLED, sourceStoreReady),
    overrideStore: dataStoreStatus(UNIQUE_VISITOR_REMOTE_ENABLED, overrideStoreReady)
  });
});

async function sendSiteIndex(req, res, next) {
  try {
    await maintenanceInitPromise;
    if (maintenanceMode.active && fs.existsSync(MAINTENANCE_PAGE_PATH)) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Retry-After', '600');
      return res.status(503).sendFile(MAINTENANCE_PAGE_PATH);
    }
  } catch (error) {
    return next(error);
  }

  if (!SITE_INDEX_EXISTS) {
    return res.status(404).send(
      `<h1>404 — Site not found</h1>
       <p>index.html not found under: ${escapeServerHtml(DEV_DIR)}</p>
       <p>Resolved path: ${escapeServerHtml(SITE_INDEX_PATH || '(none)')}</p>
       <p>Set the <strong>DEV_DIR</strong> environment variable on Render to the folder containing your index.html.</p>`
    );
  }
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  res.sendFile(SITE_INDEX_PATH);
}

app.get('/', sendSiteIndex);

// Auth verification (existing public endpoint, with same-origin/local support)
app.get('/api/auth/verify', (req, res) => {
  const origin = normalizeOrigin(req.headers.origin || '');
  const referer = normalizeOrigin(req.headers.referer || '');
  const requestOrigin = getRequestOrigin(req);
  const sourceOrigin = origin || referer;
  const isAuthorized =
    isAuthorizedHostname(req.hostname) ||
    isAuthorizedHostname(hostnameFromUrl(origin)) ||
    isAuthorizedHostname(hostnameFromUrl(referer)) ||
    isLocalOrigin(requestOrigin) ||
    isLocalOrigin(sourceOrigin) ||
    Boolean(sourceOrigin && (ALLOWED_ORIGINS.includes(sourceOrigin) || isSameOriginRequest(req, sourceOrigin)));

  if (isAuthorized) return res.json({ authorized: true, domain: AUTHORIZED_DOMAIN });
  res.status(403).json({ authorized: false, error: 'Unauthorized', message: 'Access only from ' + AUTHORIZED_DOMAIN });
});

// The public site receives a short-lived, user-bound token instead of exposing
// the visitor signing secret in browser JavaScript.
app.get('/api/visitors/token', (req, res) => {
  const userId = normalizeVisitorId(req.headers['x-user-id'] || req.query.userId);
  if (!userId) return res.status(400).json({ error: 'Missing user ID' });
  if (!consumeVisitorRateLimit(`token:${getClientIp(req)}`)) {
    res.setHeader('Retry-After', String(Math.ceil(VISITOR_RATE_LIMIT_WINDOW_MS / 1000)));
    return res.status(429).json({ error: 'Too many token requests. Try again later.' });
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json({ token: createVisitorToken(userId), expiresAt: Date.now() + VISITOR_TOKEN_TTL_MS });
});

// Visitor heartbeat used by the public site. It updates the same object shape
// as page tracking instead of corrupting the admin visitor map with raw numbers.
app.get('/api/visitors/heartbeat', async (req, res, next) => {
  try {
    const suppliedUserId = normalizeVisitorId(req.headers['x-user-id']);
    if (!suppliedUserId) return res.status(400).json({ error: 'Missing user ID' });

    const ip = getClientIp(req);
    if (!consumeVisitorRateLimit(`heartbeat:${ip}`)) {
      res.setHeader('Retry-After', String(Math.ceil(VISITOR_RATE_LIMIT_WINDOW_MS / 1000)));
      return res.status(429).json({ error: 'Too many heartbeat requests. Try again later.' });
    }
    if (!verifyVisitorToken(req.headers['x-visitor-token'], suppliedUserId)) {
      return res.status(403).json({ error: 'Invalid or expired visitor token' });
    }

    const existingIpKey = findVisitorKeyByIp(ip);
    const key = activeUsers.has(suppliedUserId) ? suppliedUserId : (existingIpKey || suppliedUserId);
    const headerPage = normalizeSitePage(req.query.page);
    const { entry, isNew } = upsertVisitor(key, req, {
      page: headerPage || pageFromReferer(req, activeUsers.get(key)?.page || '/'),
      source: 'heartbeat',
      keepExistingPage: !headerPage && !req.headers.referer
    });
    // Analytics: a heartbeat means a real browser running the site, so this is
    // where a session starts counting (page-only hits from crawlers are not).
    recordSessionStart(entry);
    const isGloballyNew = await trackUniqueVisitor(key);
    recordVisitorKind(entry, isGloballyNew);

    // Heartbeats update one row in real time; full stats are serialized only
    // for a new live session or a newly confirmed permanent visitor.
    broadcastVisitorChange(isNew ? 'online' : 'heartbeat', entry, isNew || isGloballyNew);
    res.json({ active: countOnlineUsers() });
  } catch (error) {
    next(error);
  }
});

// Viewer events from the public site (feed picked, page opened, fullscreen,
// stream ready/timeout, no-stream impression, livery picked). Same token and
// rate limit as the heartbeat; the payload is reduced to whitelisted counters.
app.post('/api/visitors/event', (req, res) => {
  const suppliedUserId = normalizeVisitorId(req.headers['x-user-id']);
  if (!suppliedUserId) return res.status(400).json({ error: 'Missing user ID' });
  if (!consumeVisitorRateLimit(`event:${getClientIp(req)}`)) {
    res.setHeader('Retry-After', String(Math.ceil(VISITOR_RATE_LIMIT_WINDOW_MS / 1000)));
    return res.status(429).json({ error: 'Too many events. Try again later.' });
  }
  if (!verifyVisitorToken(req.headers['x-visitor-token'], suppliedUserId)) {
    return res.status(403).json({ error: 'Invalid or expired visitor token' });
  }
  const type = typeof req.body?.type === 'string' ? req.body.type.slice(0, 24) : '';
  const entry = activeUsers.get(suppliedUserId) || activeUsers.get(findVisitorKeyByIp(getClientIp(req)) || '');
  if (!recordViewerEvent(type, req.body?.value, entry)) return res.status(400).json({ error: 'Unknown event' });
  res.status(204).end();
});

app.get('/api/visitors/active', (req, res) => {
  if (!consumeVisitorRateLimit(`active:${getClientIp(req)}`)) {
    res.setHeader('Retry-After', String(Math.ceil(VISITOR_RATE_LIMIT_WINDOW_MS / 1000)));
    return res.status(429).json({ error: 'Too many requests. Try again later.' });
  }
  res.json({ active: countOnlineUsers() });
});

// ─────────────────────────────────────────────
// PUBLIC — Site/stream status & SSE (no auth needed)
// ─────────────────────────────────────────────

app.get('/api/site/status', async (req, res, next) => {
  try {
    await maintenanceInitPromise;
    res.json({ maintenance: publicMaintenanceState() });
  } catch (error) {
    next(error);
  }
});

// Public news feed — unpublished drafts never leave the server.
app.get('/api/news', async (req, res, next) => {
  try {
    await newsInitPromise;
    res.json({ news: getPublicNewsItems() });
  } catch (error) {
    next(error);
  }
});

// Public endpoint for the Netlify site to poll stream status
app.get('/api/stream/status', async (req, res, next) => {
  try {
    await overrideInitPromise;
    res.setHeader('Cache-Control', 'no-store');
    res.json(publicOverrideState());
  } catch (error) {
    next(error);
  }
});

// Feed availability for the public player. No auth: it only ever reveals
// which of the site's own sources are switched on.
app.get('/api/stream/sources', async (req, res, next) => {
  try {
    await sourceInitPromise;
    res.setHeader('Cache-Control', 'no-store');
    res.json(publicSourceConfig());
  } catch (error) {
    next(error);
  }
});

// ─────────────────────────────────────────────
// PUBLIC — OpenF1 proxy (CORS-safe, cached, snapshot-protected)
// ─────────────────────────────────────────────

function openf1Ttl(openf1Path) { return OPENF1_TTL_MS_OVERRIDE || OPENF1_TTL_MS[openf1Path] || 60_000; }
function openf1SnapshotKey(url) { return `freef1:openf1:snap:${crypto.createHash('sha1').update(url).digest('hex')}`; }

async function openf1SnapshotLoad(url) {
  const local = openf1Snapshots.get(url);
  if (local) return local;
  if (!UNIQUE_VISITOR_REMOTE_ENABLED) return null;
  try {
    const payload = await upstashRequest(['GET', openf1SnapshotKey(url)]);
    const raw = payload && payload.result;
    if (typeof raw !== 'string') return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.data)) return null;
    openf1Snapshots.set(url, parsed);
    return parsed;
  } catch (error) {
    return null;
  }
}

function openf1SnapshotSave(url, data) {
  const snapshot = { data, at: Date.now() };
  openf1Snapshots.set(url, snapshot);
  if (!UNIQUE_VISITOR_REMOTE_ENABLED) return;
  const raw = JSON.stringify(snapshot);
  if (raw.length > OPENF1_SNAPSHOT_MAX_BYTES) return;
  upstashRequest(['SET', openf1SnapshotKey(url), raw, 'EX', OPENF1_SNAPSHOT_TTL_S]).catch(() => {});
}

async function openf1FetchUpstream(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);
  timeout.unref?.();
  try {
    const headers = { accept: 'application/json' };
    if (OPENF1_API_KEY) headers.authorization = `Bearer ${OPENF1_API_KEY}`;
    return await fetch(url, { headers, cache: 'no-store', signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function openf1Resolve(url, openf1Path) {
  const hit = openf1Cache.get(url);
  if (hit && Date.now() - hit.at < openf1Ttl(openf1Path)) return { data: hit.data, stale: false };
  let pending = openf1Inflight.get(url);
  if (!pending) {
    pending = (async () => {
      let response = null;
      try { response = await openf1FetchUpstream(url); } catch (_) { response = null; }
      if (response && response.ok) {
        try {
          const data = await response.json();
          openf1Cache.set(url, { data, at: Date.now() });
          openf1SnapshotSave(url, data);
          return { data, stale: false };
        } catch (error) {
          const parseError = new Error('OpenF1 returned unreadable JSON');
          parseError.code = 'upstream';
          throw parseError;
        }
      }
      const status = response ? response.status : 0;
      response && response.body && typeof response.body.cancel === 'function' && response.body.cancel().catch(() => {});
      const locked = status === 401 || status === 403;
      const snapshot = await openf1SnapshotLoad(url);
      if (snapshot) return { data: snapshot.data, stale: true };
      const error = new Error(locked
        ? 'OpenF1 free tier locked while a live session is in progress'
        : status === 429 ? 'OpenF1 rate limit hit' : 'OpenF1 upstream unreachable');
      error.code = locked ? 'live' : status === 429 ? 'rate' : 'upstream';
      throw error;
    })();
    openf1Inflight.set(url, pending);
    const clear = () => openf1Inflight.delete(url);
    pending.then(clear, clear);
  }
  return pending;
}

app.get('/api/openf1/:path', async (req, res) => {
  const openf1Path = req.params.path;
  if (!OPENF1_PATHS.has(openf1Path)) return res.status(404).json({ error: 'Unknown OpenF1 endpoint' });
  if (!consumeVisitorRateLimit(`openf1:${getClientIp(req)}`)) {
    res.setHeader('Retry-After', '30');
    return res.status(429).json({ error: 'Too many requests. Try again later.' });
  }
  const query = String(req.originalUrl).split('?')[1] || '';
  if (query.length > 512) return res.status(400).json({ error: 'Query string too long' });
  for (const [key, value] of new URLSearchParams(query)) {
    if (!/^[a-z_]+$/.test(key) || String(value).length > 120) return res.status(400).json({ error: 'Invalid query' });
  }
  const url = `${OPENF1_UPSTREAM}/${openf1Path}${query ? `?${query}` : ''}`;
  try {
    const { data, stale } = await openf1Resolve(url, openf1Path);
    res.setHeader('Cache-Control', 'no-store');
    if (stale) res.setHeader('X-OpenF1-Stale', '1');
    return res.json(data);
  } catch (error) {
    const code = error.code === 'live' || error.code === 'rate' ? error.code : 'upstream';
    return res.status(503).json({ code, error: error.message });
  }
});

// Public SSE endpoint — sends public stream, maintenance and news updates (no visitor data)
app.get('/api/events', async (req, res, next) => {
  try {
    await Promise.all([maintenanceInitPromise, newsInitPromise, overrideInitPromise]);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    publicSseClients.add(res);

    // Send initial stream and site state.
    const initPayload = JSON.stringify(publicOverrideState());

    res.write(`event: stream_override\ndata: ${initPayload}\n\n`);
    res.write(`event: stream_update\ndata: ${initPayload}\n\n`);
    res.write(`event: maintenance_update\ndata: ${JSON.stringify(publicMaintenanceState())}\n\n`);
    res.write(`event: news_update\ndata: ${JSON.stringify({ news: getPublicNewsItems() })}\n\n`);

    req.on('close', () => {
      publicSseClients.delete(res);
    });
  } catch (error) {
    next(error);
  }
});

// ─────────────────────────────────────────────
// ADMIN — STATIC FILES & AUTHENTICATION
// ─────────────────────────────────────────────

app.use('/admin', express.static(ADMIN_DIR, {
  index: false,
  fallthrough: true,
  etag: true,
  maxAge: 0,
  setHeaders(res) {
    // The dashboard HTML, CSS and JS are deployed together and must never get
    // out of sync. Revalidate every admin asset instead of running stale JS
    // against newer controls.
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  }
}));

function checkLoginLimit(req, res, next) {
  const key = getClientIp(req);
  const now = Date.now();
  let state = loginAttempts.get(key);
  if (!state || state.resetAt <= now) state = { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (state.count >= 10) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((state.resetAt - now) / 1000))));
    return res.status(429).json({ success: false, error: 'Too many login attempts. Try again later.' });
  }
  req.loginLimitKey = key;
  req.loginLimitState = state;
  next();
}

app.use('/admin/api/login', sessionMiddleware);
app.post('/admin/api/login', checkLoginLimit, (req, res) => {
  const { username, password } = req.body || {};
  if (safeEqual(username, ADMIN_USER) && safeEqual(password, ADMIN_PASS)) {
    loginAttempts.delete(req.loginLimitKey);
    req.session.isAdmin = true;
    req.session.loginAt = Date.now();
    return res.json({ success: true });
  }
  req.loginLimitState.count++;
  loginAttempts.set(req.loginLimitKey, req.loginLimitState);
  res.status(401).json({ success: false, error: 'Invalid credentials' });
});

function requireAdminOrigin(req, res, next) {
  if (!['POST', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const source = normalizeOrigin(req.headers.origin || req.headers.referer || '');
  if (PRODUCTION_MODE && !source) return res.status(403).json({ error: 'Missing request origin' });
  if (source && !isAllowedOrigin(req, source)) return res.status(403).json({ error: 'Forbidden' });
  next();
}

app.use('/admin/api/*', sessionMiddleware, requireAdminOrigin, (req, res, next) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: 'Not authenticated' });
  next();
});

app.post('/admin/api/logout', (req, res) => {
  req.session = null;
  res.json({ success: true });
});

app.get('/admin/api/status', (req, res) => {
  res.json({ authenticated: !!req.session.isAdmin, loginAt: req.session.loginAt || null });
});

// ─────────────────────────────────────────────
// ADMIN — API ENDPOINTS
// ─────────────────────────────────────────────

app.get('/admin/api/visitors', async (req, res, next) => {
  try {
    await Promise.all([overrideInitPromise, maintenanceInitPromise, sourceInitPromise]);
    res.setHeader('Cache-Control', 'no-store');
    res.json(getStats());
  } catch (error) {
    next(error);
  }
});

app.get('/admin/api/analytics', async (req, res) => {
  await analyticsInitPromise;
  const requested = String(req.query.range || '').toLowerCase();
  const rangeKey = requested in ANALYTICS_RANGES ? requested : ANALYTICS_DEFAULT_RANGE;
  const timeZone = safeTimeZone(req.query.tz);
  res.setHeader('Cache-Control', 'no-store');
  res.json(getAnalyticsSnapshot(rangeKey, timeZone));
});

app.get('/admin/api/stream/status', async (req, res, next) => {
  try {
    await overrideInitPromise;
    res.setHeader('Cache-Control', 'no-store');
    res.json(adminOverrideState());
  } catch (error) {
    next(error);
  }
});

app.get('/admin/api/maintenance', async (req, res, next) => {
  try {
    await maintenanceInitPromise;
    res.json({ maintenance: publicMaintenanceState(), durable: maintenanceStoreReady });
  } catch (error) {
    next(error);
  }
});

app.post('/admin/api/maintenance', async (req, res, next) => {
  try {
    await maintenanceInitPromise;
    const { active, message, eta } = req.body || {};
    if (typeof active !== 'boolean') {
      return res.status(400).json({ error: 'The active field must be true or false.' });
    }

    applyMaintenanceState({
      active,
      message,
      eta,
      startedAt: active
        ? (maintenanceMode.active && maintenanceMode.startedAt ? maintenanceMode.startedAt : Date.now())
        : null,
      updatedAt: Date.now()
    });

    const durable = await persistMaintenanceState();
    const state = publicMaintenanceState();
    broadcastSSE('maintenance_update', state);
    broadcastPublicSSE('maintenance_update', state);
    scheduleStatsBroadcast(0);

    res.json({ success: true, maintenance: state, durable });
  } catch (error) {
    next(error);
  }
});

app.get('/admin/api/news', async (req, res, next) => {
  try {
    await newsInitPromise;
    res.json({ news: getAdminNewsItems(), durable: newsStoreIsDurable() });
  } catch (error) {
    next(error);
  }
});

app.post('/admin/api/news', async (req, res, next) => {
  try {
    await newsInitPromise;
    const item = createNewsRecord(req.body || {});
    const durable = await persistNewsStore();
    broadcastNewsUpdate();
    res.status(201).json({ success: true, news: newsForResponse(item), durable });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    next(error);
  }
});

app.patch('/admin/api/news/:id', async (req, res, next) => {
  try {
    await newsInitPromise;
    const item = updateNewsRecord(req.params.id, req.body || {});
    if (!item) return res.status(404).json({ error: 'News item not found.' });
    const durable = await persistNewsStore();
    broadcastNewsUpdate();
    res.json({ success: true, news: newsForResponse(item), durable });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    next(error);
  }
});

app.delete('/admin/api/news/:id', async (req, res, next) => {
  try {
    await newsInitPromise;
    if (!deleteNewsRecord(req.params.id)) return res.status(404).json({ error: 'News item not found.' });
    const durable = await persistNewsStore();
    broadcastNewsUpdate();
    res.json({ success: true, durable });
  } catch (error) {
    next(error);
  }
});

app.post('/admin/api/stream/override', async (req, res, next) => {
  try {
    await overrideInitPromise;
    const input = String((req.body || {}).url || '').trim().slice(0, 2000);
    if (!input) return res.status(400).json({ error: 'Stream URL is required' });

    const { type, embedUrl } = classifyStreamURL(input);
    if (!embedUrl) return res.status(400).json({ error: 'Unsupported URL format' });

    streamOverride.active = true;
    streamOverride.input = input;
    streamOverride.url = embedUrl;
    streamOverride.type = type;
    streamOverride.startedAt = Date.now();
    streamOverride.updatedAt = Date.now();

    const durable = await persistOverrideState();
    const override = broadcastOverride();
    res.json({ success: true, override, durable });
  } catch (error) {
    next(error);
  }
});

/* Stop takes viewers back to the site feed but keeps the typed URL so it can
   be played again. Return to Normal clears that URL as well. */
async function settleOverride(clear) {
  await overrideInitPromise;
  if (clear) {
    streamOverride.input = null;
    streamOverride.url = null;
    streamOverride.type = null;
  }
  streamOverride.active = false;
  streamOverride.startedAt = null;
  streamOverride.updatedAt = Date.now();
  const durable = await persistOverrideState();
  const override = broadcastOverride();
  return { success: true, override, durable };
}

app.post('/admin/api/stream/stop', async (req, res, next) => {
  try {
    res.json(await settleOverride(false));
  } catch (error) {
    next(error);
  }
});

app.post('/admin/api/stream/normal', async (req, res, next) => {
  try {
    res.json(await settleOverride(true));
  } catch (error) {
    next(error);
  }
});

app.get('/admin/api/stream/sources', async (req, res, next) => {
  try {
    await sourceInitPromise;
    res.json({ ...publicSourceConfig(), durable: sourceStoreReady });
  } catch (error) {
    next(error);
  }
});

/* Body: { disabled: ["dazn", "wikisport"] }. Unknown ids are ignored rather
   than rejected, so a site deploy that renames a feed cannot break the panel —
   the site simply keeps showing whatever it knows about. */
app.post('/admin/api/stream/sources', async (req, res, next) => {
  try {
    await sourceInitPromise;
    const body = req.body || {};
    if (body.disabled !== undefined && !Array.isArray(body.disabled)) {
      return res.status(400).json({ error: 'The disabled field must be an array of source ids.' });
    }
    const wanted = (body.disabled || []).map(id => String(id || '').trim().slice(0, 40));
    const unknown = wanted.filter(id => !FEED_SOURCE_IDS.has(id));
    if (unknown.length) {
      return res.status(400).json({ error: `Unknown source id(s): ${unknown.join(', ')}` });
    }
    applySourceConfig({ disabled: wanted, updatedAt: Date.now() });
    const durable = await persistSourceConfig();
    const config = broadcastSourceConfig();
    res.json({ success: true, ...config, durable });
  } catch (error) {
    next(error);
  }
});

// ─────────────────────────────────────────────
// ADMIN — SSE ENDPOINT
// ─────────────────────────────────────────────

app.get('/admin/api/events', async (req, res, next) => {
  if (!req.session.isAdmin) {
    res.status(401).write('data: {"error":"Not authenticated"}\n\n');
    return res.end();
  }

  try {
    await Promise.all([overrideInitPromise, newsInitPromise, sourceInitPromise, maintenanceInitPromise]);
  } catch (error) {
    return next(error);
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  sseClients.add(res);

  // Send initial snapshot
  const payload = `event: init\ndata: ${JSON.stringify(getStats())}\n\n`;
  res.write(payload);
  res.write(`event: news_update\ndata: ${JSON.stringify({ news: getAdminNewsItems(), durable: newsStoreIsDurable() })}\n\n`);
  res.write(`event: sources_update\ndata: ${JSON.stringify(publicSourceConfig())}\n\n`);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// ─────────────────────────────────────────────
// ADMIN — SPA FALLBACK
// ─────────────────────────────────────────────

function sendAdminIndex(req, res) {
  const adminIndex = path.join(ADMIN_DIR, 'index.html');
  if (!fs.existsSync(adminIndex)) {
    return res.status(404).send(`<h1>404</h1><p>admin/index.html not found at: ${escapeServerHtml(adminIndex)}</p>`);
  }
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  res.sendFile(adminIndex);
}

app.get(['/admin', '/admin/', '/admin/login'], sendAdminIndex);

// Main-site SPA fallback for deep links. API/admin routes are defined above and
// static assets have already had a chance to resolve through express.static().
app.get(/^\/(?!admin(?:\/|$)|api(?:\/|$)|healthz$).*/, (req, res, next) => {
  if (req.method !== 'GET' || isStaticAssetPath(req.path)) return next();
  sendSiteIndex(req, res);
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error('[Error]', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error' });
});

function escapeServerHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─────────────────────────────────────────────
// SERVER STARTUP
// ─────────────────────────────────────────────

/* ── Discord companion bot (optional, owner-operated) ────────────────
   Boots only when DISCORD_BOT_TOKEN is set. Runs in-process so it can
   reuse the durable stores; crash-isolated — a bot failure can never
   take the site API down with it. See bot/README.md. */
let discordBot = null;
if (process.env.DISCORD_BOT_TOKEN) {
  try {
    discordBot = require('./bot/discord-bot.js').start({
      token: process.env.DISCORD_BOT_TOKEN,
      guildId: process.env.DISCORD_GUILD_ID || '',
      siteUrl: process.env.SITE_URL || 'https://freef1.netlify.app',
      discordInvite: 'https://discord.gg/KYXHCAzhN4',
      readLocalJson,
      writeLocalJson,
      upstash: UNIQUE_VISITOR_REMOTE_ENABLED ? upstashRequest : null,
      redisKey: 'freef1:discordbot:v1',
      fileKey: path.join(DATA_DIR, 'discord-bot.json'),
      // Default audio source for /watchparty start. Discord bots can relay
      // audio into a voice channel, never video — see bot/STREAMING.md.
      audioUrl: String(process.env.APEX_AUDIO_URL || '').trim(),
      log: (...a) => console.log('[Bot]', ...a),
    });
  } catch (error) {
    console.error('[Bot] failed to start:', error.message);
  }
} else {
  console.log('[Bot] Discord bot disabled (DISCORD_BOT_TOKEN not set)');
}

const server = app.listen(PORT, () => {
  console.log(`[Server] Running on http://localhost:${PORT}`);
  console.log(`[Main]  Site:  http://localhost:${PORT}/  (${DEV_DIR})`);
  console.log(`[Admin] Panel: http://localhost:${PORT}/admin  (${ADMIN_DIR})`);
  console.log(`[Admin] User:  ${ADMIN_USER}`);
  console.log(`[Visitors] Unique store: ${UNIQUE_VISITOR_REMOTE_ENABLED ? 'Upstash Redis (durable)' : 'memory (resets on restart)'}`);
  if (UNIQUE_VISITOR_BASELINE) console.log(`[Visitors] Restored baseline: ${UNIQUE_VISITOR_BASELINE}`);

  if (ADMIN_USER === 'admin' && ADMIN_PASS === 'admin') {
    console.warn('[Security] ADMIN_USER/ADMIN_PASS are still the defaults. Set strong values in production.');
  }
  if (ADMIN_SECRET === 'freef1-admin-secret-change-me') {
    console.warn('[Security] ADMIN_SECRET is still the default. Set a long random value in production.');
  }
  if (VISITOR_SECRET === 'doggomc') {
    console.warn('[Security] VISITOR_SECRET is still the default. Set a private value in production.');
  }
});

// Keep reverse-proxy connections reusable without letting stale sockets linger.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 30_000;

function shutdown(signal) {
  console.log(`[Server] ${signal} received; shutting down gracefully.`);
  clearInterval(sseHeartbeatTimer);
  if (uniqueVisitorSyncTimer) clearInterval(uniqueVisitorSyncTimer);
  clearTimeout(statsBroadcastTimer);
  writeSSE(sseClients, 'event: shutdown\ndata: {}\n\n');
  writeSSE(publicSseClients, 'event: shutdown\ndata: {}\n\n');
  for (const response of [...sseClients, ...publicSseClients]) response.end();
  clearInterval(analyticsSampleTimer);
  clearInterval(analyticsFlushTimer);
  for (const visitor of activeUsers.values()) recordSessionEnd(visitor);
  const finalFlush = flushAnalytics(true).catch(() => false);
  // Bot store writes are already immediate; this waits for the last one
  // so a redeploy cannot drop sent-markers and double-post an alert.
  const botFlush = discordBot?.flush?.().catch(() => false) || Promise.resolve();
  server.close(async () => {
    await Promise.allSettled([...pendingUniqueWrites.values(), finalFlush, botFlush]);
    try { discordBot?.stop?.(); } catch (_) {}
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
