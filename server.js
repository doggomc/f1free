'use strict';

const crypto = require('crypto');
const compression = require('compression');
const express = require('express');
const cookieSession = require('cookie-session');
const fs = require('fs');
const path = require('path');
const { createDurableStore } = require('./lib/durable-store.js');
const { createClientIpResolver } = require('./lib/client-ip.js');
const { createTicketService, safeEqual } = require('./lib/tickets.js');
const { parseUserAgent } = require('./lib/user-agent.js');
const { classifyStreamUrl } = require('./lib/stream-url.js');
const {
  RETIRED_RELAY_IDS: RETIRED_RELAY_SOURCE_IDS,
  SOURCES: FEED_SOURCES,
  SOURCE_IDS: FEED_SOURCE_IDS,
  validTargetUrl
} = require('./lib/stream-catalog.js');
const {
  findIndex: findIndexHtml,
  resolveDirectory: resolveDir,
  resolveSiteDirectory: resolveSiteDir
} = require('./lib/site-paths.js');
const {
  createOriginPolicy,
  hostnameFromUrl,
  isLocalOrigin,
  normalizeOrigin,
  parseOrigins
} = require('./lib/origin-policy.js');

const app = express();

app.disable('x-powered-by');
// Dynamic API responses are no-store; validators only add bytes. Static
// middleware below enables its own ETags where browser revalidation helps.
app.disable('etag');

/* ── Client IP trust ──────────────────────────────────────────────
   proxy-addr walks the X-Forwarded-For chain backwards from the socket and
   returns the closest address that is NOT a trusted hop. With the hop count
   matched to the real deployment (Render's router = 1 hop; +1 more if this
   ever sits behind Cloudflare) that address is the one the edge appended, so
   a client cannot forge it by sending its own X-Forwarded-For,
   CF-Connecting-IP, True-Client-IP or X-Real-IP header.

   `true` (the previous value) trusted every hop, which made every per-IP
   limit in this file — including the admin login guard — bypassable with a
   single request header. Set TRUST_PROXY_HOPS only to match real
   infrastructure: too low over-blocks (every viewer shares a proxy address),
   too high re-opens the forgery. */
const TRUST_PROXY_HOPS = Math.max(0, Math.min(4,
  Number.parseInt(process.env.TRUST_PROXY_HOPS || (process.env.NODE_ENV === 'production' ? '1' : '0'), 10) || 0));
app.set('trust proxy', TRUST_PROXY_HOPS);

const SERVER_STARTED_AT = Date.now();
const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'freef1-admin-secret-change-me';
const VISITOR_SECRET = process.env.VISITOR_SECRET || 'doggomc';
const AUTHORIZED_DOMAIN = process.env.AUTHORIZED_DOMAIN || 'freef1.netlify.app';
const AUTHORIZED_HOSTNAME = String(AUTHORIZED_DOMAIN).replace(/^https?:\/\//i, '').split('/')[0].split(':')[0].toLowerCase();
const ALLOWED_ORIGINS = parseOrigins(process.env.ALLOWED_ORIGIN || 'https://freef1.netlify.app');

// Durable mutable state. A standard Redis connection is preferred; the adapter
// keeps the application independent from any one compatible provider.
const UNIQUE_VISITOR_BASELINE = Math.max(0, Number.parseInt(process.env.UNIQUE_VISITOR_BASELINE || '0', 10) || 0);
const UNIQUE_VISITOR_REDIS_KEY = process.env.UNIQUE_VISITOR_REDIS_KEY || 'freef1:unique-visitors:v1';
const MAINTENANCE_REDIS_KEY = process.env.MAINTENANCE_REDIS_KEY || 'freef1:maintenance:v1';
const NEWS_REDIS_KEY = process.env.NEWS_REDIS_KEY || 'freef1:news:v1';
const NEWS_MAX_ITEMS = Math.max(1, Math.min(100, Number.parseInt(process.env.NEWS_MAX_ITEMS || '50', 10) || 50));
// Keep visitor hashes independent from the admin cookie key so rotating
// ADMIN_SECRET does not reset the unique-visitor identity space.
const UNIQUE_VISITOR_HASH_SECRET = process.env.UNIQUE_VISITOR_HASH_SECRET || VISITOR_SECRET;
/* A standard Redis/Valkey URL is the preferred durable store. It avoids the
   request-per-command ceiling of REST-only databases and works with Redis
   Cloud's free database as well as any future compatible provider. Upstash is
   retained as a migration fallback: REDIS_URL wins whenever both are set. */
const REDIS_URL = String(process.env.REDIS_URL || '').trim();
const UPSTASH_REDIS_REST_URL = String(process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const UPSTASH_REDIS_REST_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || '');
const durableStore = createDurableStore({
  redisUrl: REDIS_URL,
  upstashUrl: UPSTASH_REDIS_REST_URL,
  upstashToken: UPSTASH_REDIS_REST_TOKEN,
  timeoutMs: process.env.REDIS_TIMEOUT_MS,
  logger: message => console.warn(message)
});
const UNIQUE_VISITOR_REMOTE_ENABLED = durableStore.enabled;
const REMOTE_STORE_LABEL = durableStore.provider === 'redis' ? 'Redis' : 'Upstash Redis';
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const NEWS_FILE = path.join(DATA_DIR, 'news.json');
const MAINTENANCE_FILE = path.join(DATA_DIR, 'maintenance.json');
const UNIQUE_VISITORS_FILE = path.join(DATA_DIR, 'unique-visitors.json');
const ANALYTICS_FILE = path.join(DATA_DIR, 'analytics.json');
const ANALYTICS_REDIS_KEY = process.env.ANALYTICS_REDIS_KEY || 'freef1:analytics:v1';
const SOURCE_CONFIG_FILE = path.join(DATA_DIR, 'stream-sources.json');
const SOURCE_REDIS_KEY = process.env.SOURCE_REDIS_KEY || 'freef1:stream-sources:v1';
const STREAM_TARGETS_REDIS_KEY = process.env.STREAM_TARGETS_REDIS_KEY || 'freef1:stream-targets:v1';
const OVERRIDE_FILE = path.join(DATA_DIR, 'stream-override.json');
const OVERRIDE_REDIS_KEY = process.env.OVERRIDE_REDIS_KEY || 'freef1:stream-override:v1';
const EXPERIMENTAL_FILE = path.join(DATA_DIR, 'experimental.json');
const EXPERIMENTAL_REDIS_KEY = process.env.EXPERIMENTAL_REDIS_KEY || 'freef1:experimental:v1';
const STREAM_WINDOW_FILE = path.join(DATA_DIR, 'stream-window.json');
const STREAM_WINDOW_REDIS_KEY = process.env.STREAM_WINDOW_REDIS_KEY || 'freef1:stream-window:v1';

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
// Query keys the public site actually sends (session_key/meeting_key/year
// selectors). Anything else is refused at the proxy boundary.
const OPENF1_QUERY_KEYS = new Set([
  'session_key', 'meeting_key', 'driver_number', 'year',
  'country_name', 'location', 'session_name', 'date_start', 'date_end'
]);
const OPENF1_TTL_MS = { sessions: 60_000, meetings: 60_000, drivers: 3_600_000, team_radio: 10_000, race_control: 10_000 };
const OPENF1_SNAPSHOT_TTL_S = 7 * 86_400;
const OPENF1_SNAPSHOT_MAX_BYTES = 1_500_000;
/* Cache keys are derived from client-chosen query strings, so every cache here
   is capped and evicts least-recently-used. Without a cap a caller can mint
   unbounded keys (and, for snapshots, unbounded Redis keys) just by varying
   session_key/meeting_key. */
const OPENF1_CACHE_MAX = Math.max(50, Number.parseInt(process.env.OPENF1_CACHE_MAX || '400', 10) || 400);
const OPENF1_SNAPSHOT_MAX = Math.max(50, Number.parseInt(process.env.OPENF1_SNAPSHOT_MAX || '400', 10) || 400);
const OPENF1_SNAPSHOT_WRITES_PER_DAY = Math.max(50, Number.parseInt(process.env.OPENF1_SNAPSHOT_WRITES_PER_DAY || '2000', 10) || 2000);
const CAREER_CACHE_MAX = Math.max(20, Number.parseInt(process.env.CAREER_CACHE_MAX || '200', 10) || 200);

function cacheSetCapped(map, key, value, max) {
  if (map.has(key)) map.delete(key); // re-insert so Map order stays least-recently-used
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
  return value;
}

const openf1Cache = new Map();     // url -> { data, at }
const openf1Snapshots = new Map(); // url -> { data, at } last-known-good per URL
const openf1Inflight = new Map();  // url -> Promise (request coalescing)
let openf1SnapshotWriteDay = new Date().toISOString().slice(0, 10);
let openf1SnapshotWritesToday = 0;
let openf1SnapshotWriteCapLogged = false;
// Reported to the admin dashboard so it can render a true server clock.
const SERVER_TIMEZONE = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) { return 'UTC'; }
})();
const PRODUCTION_MODE = process.env.NODE_ENV === 'production' || process.env.REQUIRE_PRODUCTION_SECRETS === '1';
const { getRequestOrigin, isAllowedOrigin, isAuthorizedHostname, isSameOriginRequest } = createOriginPolicy({
  authorizedHostname: AUTHORIZED_HOSTNAME,
  allowedOrigins: ALLOWED_ORIGINS,
  production: PRODUCTION_MODE
});
/* A one-word password with a per-IP lockout is still guessable offline of the
   limiter; refuse short or copy-pasted placeholder secrets in production. */
const ADMIN_PASS_MIN_LENGTH = Math.max(8, Number.parseInt(process.env.ADMIN_PASS_MIN_LENGTH || '12', 10) || 12);
const looksLikePlaceholder = value => /(?:change[-_ ]?me|replace|generate|your[-_ ]|example|placeholder)/i
  .test(String(value || ''));
const strongSecretMissing = (value, minimum = 32) =>
  !value || String(value).length < minimum || looksLikePlaceholder(value);
const insecureProductionConfig = [
  !process.env.ADMIN_USER || /^(?:admin|change[-_ ]?me)$/i.test(process.env.ADMIN_USER) ? 'ADMIN_USER' : null,
  !process.env.ADMIN_PASS || process.env.ADMIN_PASS === 'admin' || looksLikePlaceholder(process.env.ADMIN_PASS)
    ? 'ADMIN_PASS' : null,
  process.env.ADMIN_PASS && process.env.ADMIN_PASS.length < ADMIN_PASS_MIN_LENGTH
    ? `ADMIN_PASS (shorter than ${ADMIN_PASS_MIN_LENGTH} characters)` : null,
  strongSecretMissing(process.env.ADMIN_SECRET) ? 'ADMIN_SECRET (minimum 32 random characters)' : null,
  strongSecretMissing(process.env.VISITOR_SECRET) ? 'VISITOR_SECRET (minimum 32 random characters)' : null,
  strongSecretMissing(process.env.UNIQUE_VISITOR_HASH_SECRET)
    ? 'UNIQUE_VISITOR_HASH_SECRET (minimum 32 random characters)' : null,
  strongSecretMissing(process.env.SELFCHECK_TOKEN, 24)
    ? 'SELFCHECK_TOKEN (minimum 24 random characters)' : null,
  // Analytics, news, unique visitors and maintenance live on the instance disk
  // without a remote store — Render wipes that disk on every rebuild.
  !durableStore.enabled ? 'REDIS_URL (or legacy UPSTASH_REDIS_REST_URL/TOKEN)' : null
].filter(Boolean);
if (PRODUCTION_MODE && insecureProductionConfig.length) {
  throw new Error(`Refusing to start with insecure production configuration: ${insecureProductionConfig.join(', ')}.`);
}

// Site root — set DEV_DIR to the folder containing your index.html
// Render example: DEV_DIR=/opt/render/project/Development-FreeF1
const DEV_DIR = resolveSiteDir(process.env.DEV_DIR, [
  path.join(__dirname, '..', 'Development - FreeF1'),
  path.join(__dirname, 'Development - FreeF1'),
  path.join(__dirname, '..', '..', 'Development - FreeF1'),
  path.join(process.cwd(), 'Development - FreeF1'),
  path.join(process.cwd(), '..', 'Development - FreeF1'),
  path.join('/opt', 'render', 'project', 'Development - FreeF1'),
  path.join('/opt', 'render', 'project', 'development-freef1'),
  path.join('/opt', 'render', 'project', 'site'),
  path.join(process.cwd(), 'public'),
  path.join(process.cwd(), 'site')
]);

const ADMIN_DIR = resolveDir(process.env.ADMIN_DIR, [
  path.join(__dirname, 'admin'),
  path.join(process.cwd(), 'admin'),
  path.join('/opt', 'render', 'project', 'admin')
]);

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
// Geo responses are reused and concurrent lookups for one IP are deduplicated.
const geoCache = new Map();
const pendingGeoLookups = new Map();
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
// The durable store keeps updates available after a Render restart.
const newsItems = [];
let newsStoreReady = false;
let newsInitPromise = Promise.resolve(false);

/* ── Feed sources (public player) ──────────────────────────
   Provider-hosted embeds are redirects: Render only issues a tiny signed alias
   and never carries video or HLS playlists. The two former self-hosted HLS
   relays are retired permanently to protect the 5 GB monthly egress budget. */
const relayDisabledMessage = 'Self-hosted relays are permanently disabled to protect service bandwidth.';
const sourceConfig = { disabled: new Set(), updatedAt: null };
let sourceStoreReady = false;
let sourceInitPromise = Promise.resolve(false);
let streamTargetsInitPromise = Promise.resolve(0);

// SSE clients for admin dashboard
const sseClients = new Set();
// SSE clients for public site (stream override only)
const publicSseClients = new Set();

// One shared timer scales better than allocating a timer per connected SSE client.
// Twenty-five seconds stays below common proxy idle timeouts while cutting
// keepalive egress by 40% compared with the old 15-second cadence.
const SSE_HEARTBEAT_MS = Math.max(10_000, Number(process.env.SSE_HEARTBEAT_MS || 25_000));
const sseHeartbeatTimer = setInterval(() => {
  const heartbeat = ': heartbeat\n\n';
  writeSSE(sseClients, heartbeat);
  writeSSE(publicSseClients, heartbeat);
  reconcilePublicSseCounts();
}, SSE_HEARTBEAT_MS);
sseHeartbeatTimer.unref?.();

// Heartbeat / cleanup settings
// Analytics and public presence must use the same freshness horizon. Falling
// back to the old 60-second value would mark every two-minute client stale
// halfway between valid heartbeats.
const HEARTBEAT_TIMEOUT = Number(
  process.env.HEARTBEAT_TIMEOUT_MS || process.env.PRESENCE_TTL_MS || 270_000
);

/* Presence, as opposed to "did this browser ever send a heartbeat".
   WATCHING is a viewer: their tab is visible, the player is on screen and
   their heartbeat is fresh. A background tab, a paused player or a closed
   browser is not a viewer — the old model could not tell those apart and
   reported everyone who had ever loaded the page within the last minute.
   ON SITE is the looser "tab open somewhere" context count; its window has to
   exceed the hidden-tab heartbeat cadence (45s) or a backgrounded tab would
   flicker in and out of it.
   LEAVE grace exists because a reload closes the page before the new one
   starts: without it every refresh would flash the viewer out and back in. */
// The scaled client beats every two minutes. A 270-second window tolerates one
// delayed or lost request without multiplying Render traffic. Deliberate exits
// use a beacon and take effect after the shared-browser grace below, so this
// longer silence window is only the fallback for tabs that vanish unexpectedly.
const PRESENCE_TTL_MS = Number(process.env.PRESENCE_TTL_MS || 270_000);
/* Stream targets stay server-managed so the frontend can deploy independently
   and targets can be rotated through STREAM_TARGETS_JSON. A signed alias limits
   when the browser may initiate a redirect; it is authorization, not secrecy —
   the provider URL is necessarily visible to the browser after redirect. */
const STREAM_TICKETS_ENABLED = process.env.STREAM_TICKETS !== 'false';
const OVERRIDE_SOURCE_ID = 'override';
/* One permission per browser session, minted only from the site itself (same
   gate as a stream ticket) and presented on API calls that cost this server
   something — upstream quota, the feed list, live data. This blocks accidental
   cross-origin use and casual hotlinking; it is not a substitute for secrets or
   a user-authenticated authorization boundary. */
const SITE_TICKETS_ENABLED = process.env.SITE_TICKETS !== 'false';
const SITE_TICKET_TTL_MS = Number(process.env.SITE_TICKET_TTL_MS || 6 * 60 * 60 * 1000);
const SITE_TICKET_RATE_MAX = Number(process.env.SITE_TICKET_RATE_MAX || 60);
/* Paths where the site-ticket gate does not apply, in two groups:
   — bootstrap: the page cannot hold a ticket yet, so gating these would strand
     it. /api/site/status is how it learns it is in maintenance at all;
     /api/auth/verify is the boot-time domain check.
   — already gated by something stronger or equal: /api/stream/ticket and
     /api/visitors/token are themselves permissions (origin gate + per-address
     budget), and the presence trio verifies a signed visitor token, which can
     only be minted the same way a site ticket can. Asking for a second
     credential of identical strength would be ceremony, not security.
   /api/events IS gated, but reads the ticket from ?ticket= because an
   EventSource cannot set headers. */
const SITE_TICKET_FREE_PATHS = new Set([
  '/api/site/status',
  '/api/site/ticket',
  '/api/auth/verify',
  '/api/stream/ticket',
  '/api/visitors/token',
  '/api/visitors/heartbeat',
  '/api/visitors/event',
  '/api/visitors/leave'
]);
const STREAM_TICKET_TTL_MS = Number(process.env.STREAM_TICKET_TTL_MS || 60 * 60 * 1000);
const STREAM_TICKET_RATE_MAX = Number(process.env.STREAM_TICKET_RATE_MAX || 120);
const ticketService = createTicketService({
  secret: VISITOR_SECRET,
  // Retired ids remain verifiable only so old aliases receive a useful 410.
  allowedSourceIds: new Set([...FEED_SOURCE_IDS, ...RETIRED_RELAY_SOURCE_IDS]),
  overrideSourceId: OVERRIDE_SOURCE_ID
});
const DISCORD_CODE_RATE_MAX = Number(process.env.DISCORD_CODE_RATE_MAX || 20);
/* Shown in the link dialog so a visitor who is not in the server yet has
   somewhere to go. Only ever rendered as an <a href>, so a bad value is a
   dead link, not an injection risk — but it is still restricted to discord
   hosts so a mistyped env var cannot point members somewhere hostile. */
const DISCORD_INVITE_URL = (() => {
  const raw = String(process.env.DISCORD_INVITE || 'https://discord.gg/KYXHCAzhN4').trim();
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return 'https://discord.gg/KYXHCAzhN4';
    if (u.hostname !== 'discord.gg' && u.hostname !== 'discord.com' &&
        !u.hostname.endsWith('.discord.com')) return 'https://discord.gg/KYXHCAzhN4';
    return u.toString();
  } catch (_) { return 'https://discord.gg/KYXHCAzhN4'; }
})();
/* The leave beacon fires per TAB, and a browser can have several. Closing one
   of two tabs must not drop the browser, so a goodbye only ends the count if
   no heartbeat follows it — and the grace is deliberately longer than the
   site's beat interval, so the surviving tab's next beat clears it first. A
   browser whose LAST tab closed is out of the count at this mark. */
const PRESENCE_LEAVE_GRACE_MS = Number(process.env.PRESENCE_LEAVE_GRACE_MS || 125_000);
const CLEANUP_INTERVAL = Number(process.env.CLEANUP_INTERVAL_MS || 30_000);
const VISITOR_TOKEN_TTL_MS = Number(process.env.VISITOR_TOKEN_TTL_MS || 24 * 60 * 60 * 1000);
const VISITOR_RATE_LIMIT_WINDOW_MS = Number(process.env.VISITOR_RATE_LIMIT_WINDOW_MS || 60_000);
const VISITOR_RATE_LIMIT_MAX = Number(process.env.VISITOR_RATE_LIMIT_MAX || 30);

/* Heartbeats and viewer events are per VIEWER, not per address. A household, an
   office, a campus or a mobile carrier puts many viewers behind one IP. The
   identity is signed and verified before its own budget is charged. The
   per-IP ceilings below stay as a flood backstop, set far above any plausible
   number of viewers inside one network. Identity MINTING (`/token`) stays
   keyed by address, because that is the budget an attacker would farm. */
const HEARTBEAT_RATE_LIMIT_MAX = Number(process.env.HEARTBEAT_RATE_LIMIT_MAX || 20);
const HEARTBEAT_IP_RATE_LIMIT_MAX = Number(process.env.HEARTBEAT_IP_RATE_LIMIT_MAX || 600);
const EVENT_RATE_LIMIT_MAX = Number(process.env.EVENT_RATE_LIMIT_MAX || 30);
const EVENT_IP_RATE_LIMIT_MAX = Number(process.env.EVENT_IP_RATE_LIMIT_MAX || 600);
const GEO_ENABLED = process.env.GEO_ENABLED !== 'false';
const GEO_API = String(process.env.GEO_API || 'https://ipwho.is').replace(/\/+$/, '');

/* ── Admission budgets ────────────────────────────────────────────
   A rate limit alone still lets one host mint a brand-new visitor identity
   every window, and every new identity is a permanent addition to the
   all-time unique total. This budget caps new identities per IP per hour:
   the visitor still appears live in the dashboard and still counts in
   analytics, they just cannot join the permanent total more than this many
   times in an hour. Real viewers keep working (one identity per person per
   site), and a viewer whose first heartbeat landed over budget is picked up
   on a later heartbeat once the window rolls.

   The default is deliberately generous: mobile carriers put thousands of
   viewers behind one address, and a race weekend must not read as abuse. It
   still stops a script, which mints identities thousands of times an hour,
   and the first-party origin gate is the primary defence. */
const NEW_IDENTITY_BUDGET_PER_IP_HOUR = Math.max(1,
  Number.parseInt(process.env.NEW_IDENTITY_BUDGET_PER_IP_HOUR || '60', 10) || 60);
const NEW_IDENTITY_BUDGET_WINDOW_MS = 60 * 60 * 1000;
// Log-only tripwire: if the whole instance ever mints more than this in an
// hour, something is wrong even if every individual IP stayed inside budget.
const NEW_IDENTITY_ALERT_PER_HOUR = Math.max(10,
  Number.parseInt(process.env.NEW_IDENTITY_ALERT_PER_HOUR || '600', 10) || 600);

/* Public SSE is a long-lived socket per viewer. The global cap alone let one
   host hold the whole pool open and starve every other viewer of the
   override/maintenance/news pushes, so there is a per-IP cap as well. */
const PUBLIC_SSE_MAX = Math.max(20, Math.min(2_000,
  Number.parseInt(process.env.PUBLIC_SSE_MAX || '1200', 10) || 1200));
const PUBLIC_SSE_MAX_PER_IP = Math.max(1, Math.min(64,
  Number.parseInt(process.env.PUBLIC_SSE_MAX_PER_IP || '32', 10) || 32));

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

/* Keep this byte-equivalent to netlifyf1/_headers; scripts/csp-check.js fails
   on drift. The backend uses it only when serving the static site locally. */
function buildCsp() {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    // Mirrors netlifyf1/_headers: typefaces are served from this origin, so no
    // external font host is allowed. Keep the two policies in step — this one
    // governs local/preview serving of the site, that one governs Netlify.
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: https://media.formula1.com https://cdn.discordapp.com",
    "connect-src 'self' https://freef1.onrender.com https://api.jolpi.ca",
    // The app frames its own signed redirect first, then the HTTPS provider.
    "frame-src 'self' https:",
    "frame-ancestors 'self'",
    // data: is required by the iOS wake-lock fallback, which loops a 1px
    // silent data:video/mp4 to keep the screen on where Wake Lock is missing.
    "media-src 'self' data: https:",
    "form-action 'self'"
  ].join('; ');
}

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const isApi = req.path.startsWith('/api/') || req.path.startsWith('/admin/api/');
  const isProbe = req.path === '/healthz' || req.path === '/readyz' || req.path === '/selfcheck';
  /* Document policies do nothing on JSON/SSE responses. Omitting those large
     headers from high-frequency heartbeats saves meaningful Render egress at
     1,000 viewers; health probes keep a deny-all policy for defense in depth. */
  if (isProbe) {
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  } else if (!isApi && !req.path.startsWith('/relay/')) {
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    res.setHeader('Content-Security-Policy', buildCsp());
  }
  if (PRODUCTION_MODE) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (isApi || isProbe) res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use((req, res, next) => {
  const origin = normalizeOrigin(req.headers.origin || '');
  res.setHeader('Vary', 'Origin');

  if (origin && !isAllowedOrigin(req, origin)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);

  // These negotiation headers are useful on preflight responses only. Sending
  // them on every 60-byte heartbeat used more egress than the JSON body.
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Visitor-Token, X-User-Id, X-Site-Ticket');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    return res.sendStatus(204);
  }
  // Only account-link endpoints use a cross-origin cookie.
  if (req.path.startsWith('/api/discord/')) {
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  next();
});

app.use(express.json({ limit: '64kb' }));

/* Default-deny on the API. Everything under /api needs the browser's site ticket
   unless it is on the bootstrap allowlist above, so an endpoint added later is
   gated by default rather than left open by omission. Reads that used to answer
   an origin-less script now answer it with 403 — the hole the stream work
   exposed. */
app.use('/api', (req, res, next) => {
  if (!SITE_TICKETS_ENABLED) return next();
  const path = (req.originalUrl || '').split('?')[0];
  if (SITE_TICKET_FREE_PATHS.has(path)) return next();
  const supplied = req.headers['x-site-ticket'] || (path === '/api/events' ? req.query.ticket : '');
  if (!ticketService.verifySite(supplied)) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'This endpoint needs a site ticket. The site asks for one at /api/site/ticket.'
    });
  }
  // The answer depends on the ticket, so a shared cache must key on it rather
  // than hand a permitted response to the next caller.
  res.setHeader('Vary', `${res.getHeader('Vary') || 'Origin'}, X-Site-Ticket`);
  next();
});

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
  // Presence changes (online/offline/watching) are pushed straight away; a
  // plain heartbeat only refreshes times, so it is left to the coalescer.
  if (type === 'online' || type === 'offline') broadcastPresence();
}

// ─────────────────────────────────────────────
// GEO LOOKUP (async, fire-and-forget)
// ─────────────────────────────────────────────

/* Can this address be located at all? One predicate, used by the geo lookup and
   by the dashboard label, so the two can never disagree about which addresses
   are worth asking about. */
function isPublicIp(ip) {
  if (!ip || ip === 'unknown') return false;
  if (ip === '127.0.0.1' || ip === '::1') return false;
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(ip)) return false;
  if (/^(fc00:|fd00:|fe80:)/i.test(ip)) return false;
  return true;
}

function pruneGeoCache() {
  const now = Date.now();
  for (const [ip, cached] of geoCache) if (cached.expiresAt <= now) geoCache.delete(ip);
  while (geoCache.size > 5000) geoCache.delete(geoCache.keys().next().value);
}

/* Two counters and no addresses: if a production deploy resolves nothing but
   private addresses (a proxy chain whose hop count does not match), every
   country comes back empty and there is no obvious symptom. This says so, at
   most once per window, in the server log only. */
let geoPrivateSkips = 0;
let geoPublicLookups = 0;
/* Reported ONCE per process. It was once per 5-minute window, which meant a
   mis-set hop count nagged forever — and the advice cannot change without a
   redeploy anyway, so repeating it adds noise, not information. The counters
   keep running so a later /admin check can still see the real state. */
let geoNoticeLogged = false;
setInterval(() => {
  if (GEO_ENABLED && !geoNoticeLogged && geoPrivateSkips >= 5 && geoPublicLookups === 0) {
    geoNoticeLogged = true;
    console.warn('[Geo] Every visitor is arriving on a private address, so no '
      + 'country can be resolved. Set TRUST_PROXY_HOPS to the number of proxies '
      + 'in front of this service (Render is normally 1) — then client IPs, '
      + 'rate limits and per-IP budgets all work. This is logged once per start.');
  }
  geoPrivateSkips = 0;
  geoPublicLookups = 0;
}, 300_000).unref?.();

async function lookupGeo(ip) {
  if (!GEO_ENABLED || typeof fetch !== 'function') return null;
  if (!isPublicIp(ip)) { geoPrivateSkips++; return null; }
  geoPublicLookups++;
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

/* The shipped copy is read directly, unlike DATA_DIR files: it is an input to
   boot, not runtime state, and it is exactly what makes a fresh deploy play. */
function readShippedJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn(`[Stream] Could not read ${filePath}. ${error?.message || error}`);
    return null;
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

/* ─────────────────────────────────────────────────────────────────────────────
   Discord account linking — see lib/discord-link.js. No current stream source
   depends on this subsystem; it remains available for community identity and
   can be unused without affecting playback.
   ───────────────────────────────────────────────────────────────────────────── */
/* The store is built before the bot is, so the announcer is reached through a
   mutable sink the bot fills in once it has a connected client. Until then
   events are simply dropped — a link made seconds after boot must not fail
   just because Discord has not finished connecting. */
let linkEventSink = null;
const discordLink = require('./lib/discord-link.js').createStore({
  readLocalJson,
  writeLocalJson,
  storeCommand: UNIQUE_VISITOR_REMOTE_ENABLED ? storeRequest : null,
  redisKey: 'freef1:discordlink:v1',
  fileKey: path.join(DATA_DIR, 'discord-link.json'),
  secret: process.env.DISCORD_LINK_SECRET || ADMIN_SECRET,
  log: (...a) => console.log('[DiscordLink]', ...a),
  onLinkEvent: (event) => {
    const sink = linkEventSink;
    if (!sink) return;
    Promise.resolve(sink(event)).catch((error) => {
      console.log('[DiscordLink] announcement failed:', error && error.message);
    });
  },
});

/* SameSite=None is only sent over https, and a browser drops it otherwise, so
   the flag follows the real protocol rather than NODE_ENV: behind Render's TLS
   proxy the socket is plain http even though the visitor is on https, and
   getting this wrong silently locks every player page out. */
function isSecureRequest(req) {
  if (req.secure) return true;
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return forwarded === 'https';
}

async function hasDiscordAccess(req) {
  return discordLink.checkRequest(req);
}

function dataStoreStatus(remoteEnabled, remoteReady) {
  if (remoteEnabled) {
    const provider = durableStore.provider === 'redis' ? 'redis' : 'upstash';
    return remoteReady ? provider : `${provider}-connecting`;
  }
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

/* Kept under its old internal name to avoid churning every store consumer.
   The adapter uses REDIS_URL first and only falls back to Upstash REST while an
   existing deployment is being migrated. */
async function storeRequest(commands) {
  return durableStore.command(commands);
}

async function syncUniqueVisitorCount() {
  if (!UNIQUE_VISITOR_REMOTE_ENABLED) return false;
  try {
    const payload = await storeRequest(['SCARD', UNIQUE_VISITOR_REDIS_KEY]);
    const count = Number(payload?.result);
    if (!Number.isFinite(count) || count < 0) throw new Error('Redis returned an invalid visitor count');
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
      const payload = await storeRequest([
        ['SADD', UNIQUE_VISITOR_REDIS_KEY, hash],
        ['SCARD', UNIQUE_VISITOR_REDIS_KEY]
      ]);
      const added = Number(payload?.[0]?.result) === 1;
      const count = Number(payload?.[1]?.result);
      if (!Number.isFinite(count) || count < 0) throw new Error('Redis returned an invalid visitor count');

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
    const { found, value: stored } = await readStoreJson(MAINTENANCE_REDIS_KEY);
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
    const payload = await storeRequest([
      'SET',
      MAINTENANCE_REDIS_KEY,
      JSON.stringify(publicMaintenanceState())
    ]);
    if (payload?.result !== 'OK') throw new Error('Redis did not confirm the maintenance update');
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

/* Reads a JSON blob out of the durable store. A value that will not parse must not be
   allowed to strand a store in the "connecting" state forever — the old code
   threw on JSON.parse, flipped the store's ready flag off, and never retried,
   so one bad blob meant news (or maintenance, or the feed list) stayed dead
   until someone happened to write to it again. Instead: quarantine the bad
   value under a timestamped key so it can be inspected by hand, report
   `found: false`, and let the caller fall back to defaults — the next save
   then repairs the store naturally. */
async function readStoreJson(key) {
  const payload = await storeRequest(['GET', key]);
  const raw = payload?.result;
  if (raw === null || raw === undefined || raw === '') return { found: false, value: undefined };
  try {
    return { found: true, value: JSON.parse(raw) };
  } catch (error) {
    const quarantineKey = `${key}:corrupt:${Date.now()}`;
    storeRequest(['RENAME', key, quarantineKey]).catch(() => {});
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
    const { found, value: stored } = await readStoreJson(NEWS_REDIS_KEY);
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
    const payload = await storeRequest(['SET', NEWS_REDIS_KEY, JSON.stringify(newsItems)]);
    if (payload?.result !== 'OK') throw new Error('Redis did not confirm the news update');
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

/* Exactly what the admin set. This is what is persisted and what the admin
   panel reads and writes back, so the kill switch below can never leak into
   saved state. */
function storedSourceConfig() {
  return {
    sources: FEED_SOURCES.map(source => ({ id: source.id, label: source.label })),
    disabled: [...sourceConfig.disabled],
    updatedAt: sourceConfig.updatedAt
  };
}

function publicSourceConfig() {
  /* The current Netlify bundle still knows the old ids, so explicitly report
     them disabled until that bundle no longer lists them. They cannot be
     re-enabled by environment variable or from the admin panel. */
  const disabled = new Set([...sourceConfig.disabled, ...RETIRED_RELAY_SOURCE_IDS]);
  return {
    sources: FEED_SOURCES.map(source => ({ id: source.id, label: source.label })),
    disabled: [...disabled],
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
    const { found, value: state } = await readStoreJson(SOURCE_REDIS_KEY);
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
    const saved = writeLocalJson(SOURCE_CONFIG_FILE, storedSourceConfig());
    sourceStoreReady = saved;
    return saved;
  }
  try {
    const payload = await storeRequest(['SET', SOURCE_REDIS_KEY, JSON.stringify(storedSourceConfig())]);
    if (payload?.result !== 'OK') throw new Error('Redis did not confirm the source update');
    sourceStoreReady = true;
    return true;
  } catch (error) {
    warnUniqueStore(error);
    sourceStoreReady = false;
    return false;
  }
}

function broadcastSourceConfig() {
  // Admin sees (and writes back) what it set; visitors see the effective list.
  const stored = storedSourceConfig();
  broadcastSSE('sources_update', stored);
  broadcastPublicSSE('sources_update', publicSourceConfig());
  scheduleStatsBroadcast(0);
  return stored;
}

// ─────────────────────────────────────────────
// STREAM TARGETS & PLAY TICKETS
// ─────────────────────────────────────────────
/* A target is where a source actually plays. Two shapes:
     { url }                          a fixed page/stream URL
     { url, params: ['season', …] }   a template with {season}, {eventSlug},
                                      {sessionSlug}, {eastSlug}, {streamNum}
   The client never sees either. It asks for a ticket; the ticket is signed,
   expires, names one source, and is redeemed here — where the real URL is
   resolved server-side and the browser is redirected to it. */
const STREAM_TARGETS_FILE = path.join(DATA_DIR, 'stream-targets.json');
/* The same addresses also ship beside server.js, so they reach a deploy whose
   DATA_DIR has never held them. */
const SHIPPED_STREAM_TARGETS_FILE = path.resolve(__dirname, 'data', 'stream-targets.json');
let streamTargets = new Map();
let streamTargetsReady = false;
let streamTargetsSource = 'none';

function applyStreamTargets(raw) {
  const next = new Map();
  if (raw && typeof raw === 'object') {
    for (const [id, entry] of Object.entries(raw)) {
      const key = String(id || '').trim().slice(0, 40);
      if (!FEED_SOURCE_IDS.has(key)) continue;
      const url = entry && typeof entry === 'object' ? entry.url : entry;
      if (!validTargetUrl(url, { allowLoopback: process.env.NODE_ENV !== 'production' })) continue;
      next.set(key, { url: String(url) });
    }
  }
  streamTargets = next;
  streamTargetsReady = true;
  return streamTargets.size;
}

/* Load order: the env var, then the durable store, then files. A tier that
   exists but yields nothing does not end the search — a leftover empty variable
   or stored value must not leave every feed dead while the shipped file sits
   right there. Reads never log URLs. */
async function syncStreamTargets() {
  streamTargetsSource = 'none';
  if (process.env.STREAM_TARGETS_JSON) {
    try {
      const parsed = JSON.parse(process.env.STREAM_TARGETS_JSON);
      const n = applyStreamTargets(parsed);
      if (n > 0) {
        streamTargetsSource = 'env';
        console.log(`[Stream] ${n} playable target(s) from STREAM_TARGETS_JSON`);
        return n;
      }
      console.warn('[Stream] STREAM_TARGETS_JSON holds no usable target — falling through to the file.');
    } catch (error) {
      console.error('[Stream] STREAM_TARGETS_JSON is not valid JSON:', error.message);
    }
  }
  if (UNIQUE_VISITOR_REMOTE_ENABLED) {
    try {
      const { found, value: stored } = await readStoreJson(STREAM_TARGETS_REDIS_KEY);
      if (found) {
        const n = applyStreamTargets(stored);
        if (n > 0) {
          streamTargetsSource = 'storage';
          console.log(`[Stream] ${n} playable target(s) loaded from storage`);
          return n;
        }
        console.warn('[Stream] Stored targets hold no usable target — falling through to the file.');
      }
    } catch (_) {}
  }
  /* Files last, so nothing on the host has to be configured for a fresh deploy
     to play: DATA_DIR first (a rotation written there is the operator's latest
     word), the copy that ships with the repo second. */
  const fileTiers = [
    [STREAM_TARGETS_FILE, 'file', 'DATA_DIR'],
    [SHIPPED_STREAM_TARGETS_FILE, 'shipped', 'repo']
  ];
  for (const [filePath, source, where] of fileTiers) {
    const stored = readShippedJson(filePath);
    const n = applyStreamTargets(stored);
    if (n > 0) {
      streamTargetsSource = source;
      console.log(`[Stream] ${n} playable target(s) loaded from ${path.basename(filePath)} (${where})`);
      return n;
    }
  }
  console.warn(`[Stream] No playable targets — the site will show feeds as unavailable. Expected ${path.basename(SHIPPED_STREAM_TARGETS_FILE)} to ship beside server.js.`);
  return 0;
}

async function persistStreamTargets() {
  const plain = {};
  for (const [id, entry] of streamTargets) plain[id] = { url: entry.url };
  if (UNIQUE_VISITOR_REMOTE_ENABLED) {
    try {
      const payload = await storeRequest(['SET', STREAM_TARGETS_REDIS_KEY, JSON.stringify(plain)]);
      if (payload?.result === 'OK') return true;
    } catch (_) {}
  }
  return writeLocalJson(STREAM_TARGETS_FILE, plain);
}

/* What the dashboard may see: which feeds are playable, and the target's host
   so the operator can tell one provider from another — never the full URL. */
function maskedStreamTargets() {
  const out = {};
  for (const source of FEED_SOURCES) {
    const entry = streamTargets.get(source.id);
    out[source.id] = {
      label: source.label,
      configured: Boolean(entry),
      host: entry ? (() => { try { return new URL(entry.url.replace(/\{[a-z]+\}/gi, 'x')).hostname; } catch (_) { return null; } })() : null
    };
  }
  return { targets: out, updatedAt: Date.now() };
}

/* Substitution is the only place client input touches a URL, so it is strict:
   every placeholder is validated by shape, and anything that could carry a
   host, a scheme or a path is rejected outright. */
function renderStreamTarget(sourceId, params = {}) {
  const entry = streamTargets.get(sourceId);
  if (!entry) return null;
  // A supplied season must be a real four-digit year; only a missing one falls
  // back to the current season.
  const rawSeason = params.season === undefined || params.season === null ? '' : String(params.season).trim();
  if (rawSeason !== '' && !/^\d{4}$/.test(rawSeason)) return null;
  const values = {
    season: rawSeason || String(new Date().getFullYear()),
    eventSlug: String(params.eventSlug || ''),
    sessionSlug: String(params.sessionSlug || ''),
    eastSlug: String(params.eastSlug || ''),
    streamNum: String(Number(params.streamNum) || '')
  };
  if (!/^\d{4}$/.test(values.season)) return null;
  for (const key of ['eventSlug', 'sessionSlug', 'eastSlug']) {
    if (values[key] && !/^[a-z0-9-]{1,60}$/i.test(values[key])) return null;
  }
  if (values.streamNum && !/^\d{1,2}$/.test(values.streamNum)) return null;
  const url = entry.url.replace(/\{([a-zA-Z]+)\}/g, (match, name) => {
    const value = values[name];
    return value === undefined || value === '' ? match : value;
  });
  // An unsubstituted placeholder means the client did not supply what the
  // template needs: refuse rather than send the browser to a literal "{slug}".
  if (/\{[a-zA-Z]+\}/.test(url) || !validTargetUrl(url, { allowLoopback: process.env.NODE_ENV !== 'production' })) return null;
  return url;
}

/* A ticket is minted only for a request that came from the site itself in a
   browser: an authorized Origin or Referer must be present. This is the gate
   that makes a scripted harvest of the source list cost a real browser. */
function isBrowserSiteRequest(req) {
  const origin = normalizeOrigin(req.headers.origin || '');
  const referer = normalizeOrigin(req.headers.referer || req.headers.referrer || '');
  if (!origin && !referer) return false;
  return isAuthorizedSiteRequest(req);
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
/* Visitors get the badge and the element type. The address is the operator's
   own feed target and stays here — the browser asks for an alias instead. */
function publicOverrideState() {
  return {
    active: Boolean(streamOverride.active && streamOverride.url),
    type: streamOverride.active && streamOverride.url ? streamOverride.type : null,
    startedAt: streamOverride.active && streamOverride.url ? (streamOverride.startedAt || null) : null
  };
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
  const classified = input ? classifyStreamUrl(input, { rejectPrivateHosts: PRODUCTION_MODE }) : { type: null, embedUrl: null };
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
    const { found, value: stored } = await readStoreJson(OVERRIDE_REDIS_KEY);
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
    const payload = await storeRequest(['SET', OVERRIDE_REDIS_KEY, JSON.stringify(record)]);
    if (payload?.result !== 'OK') throw new Error('Redis did not confirm the stream override');
    overrideStoreReady = true;
    return true;
  } catch (error) {
    warnUniqueStore(error);
    overrideStoreReady = false;
    return false;
  }
}

// ─────────────────────────────────────────────
// EXPERIMENTAL FEATURES (TRACK MAP, ETC.)
// ─────────────────────────────────────────────
const experimentalState = {
  enabled: false,
  updatedAt: Date.now()
};
let experimentalStoreReady = false;
let experimentalInitPromise = Promise.resolve(false);

function publicExperimentalState() {
  return {
    enabled: Boolean(experimentalState.enabled),
    updatedAt: experimentalState.updatedAt
  };
}

function applyExperimentalState(state) {
  experimentalState.enabled = state?.enabled !== undefined ? Boolean(state.enabled) : false;
  experimentalState.updatedAt = Number(state?.updatedAt) || Date.now();
  return publicExperimentalState();
}

async function syncExperimentalState() {
  if (!UNIQUE_VISITOR_REMOTE_ENABLED) {
    const stored = readLocalJson(EXPERIMENTAL_FILE);
    if (stored) applyExperimentalState(stored);
    experimentalStoreReady = fileStoreReady;
    return fileStoreReady;
  }
  try {
    const { found, value: stored } = await readStoreJson(EXPERIMENTAL_REDIS_KEY);
    if (found) applyExperimentalState(stored);
    experimentalStoreReady = true;
    return true;
  } catch (error) {
    warnUniqueStore(error);
    experimentalStoreReady = false;
    return false;
  }
}

async function persistExperimentalState() {
  if (!UNIQUE_VISITOR_REMOTE_ENABLED) {
    const saved = writeLocalJson(EXPERIMENTAL_FILE, publicExperimentalState());
    experimentalStoreReady = saved;
    return saved;
  }
  try {
    const payload = await storeRequest([
      'SET',
      EXPERIMENTAL_REDIS_KEY,
      JSON.stringify(publicExperimentalState())
    ]);
    if (payload?.result !== 'OK') throw new Error('Redis did not confirm experimental update');
    experimentalStoreReady = true;
    return true;
  } catch (error) {
    warnUniqueStore(error);
    experimentalStoreReady = false;
    return false;
  }
}

// ─────────────────────────────────────────────
// STREAM WINDOW OVERRIDE (force streams live)
// ─────────────────────────────────────────────
const streamWindowState = {
  active: false,
  reason: '',
  startedAt: null,
  updatedAt: null
};
let streamWindowStoreReady = false;
let streamWindowInitPromise = Promise.resolve(false);

function publicStreamWindowState() {
  return {
    active: Boolean(streamWindowState.active),
    reason: String(streamWindowState.reason || '').slice(0, 120),
    startedAt: streamWindowState.startedAt || null,
    updatedAt: streamWindowState.updatedAt || null
  };
}

function applyStreamWindowState(state) {
  const active = Boolean(state?.active);
  streamWindowState.active = active;
  streamWindowState.reason = String(state?.reason || '').trim().slice(0, 120);
  streamWindowState.startedAt = active ? (Number(state?.startedAt) || Date.now()) : null;
  streamWindowState.updatedAt = Number(state?.updatedAt) || Date.now();
  return publicStreamWindowState();
}

async function syncStreamWindowState() {
  if (!UNIQUE_VISITOR_REMOTE_ENABLED) {
    const stored = readLocalJson(STREAM_WINDOW_FILE);
    if (stored) applyStreamWindowState(stored);
    streamWindowStoreReady = fileStoreReady;
    return fileStoreReady;
  }
  try {
    const { found, value: stored } = await readStoreJson(STREAM_WINDOW_REDIS_KEY);
    if (found) applyStreamWindowState(stored);
    streamWindowStoreReady = true;
    return true;
  } catch (error) {
    warnUniqueStore(error);
    streamWindowStoreReady = false;
    return false;
  }
}

async function persistStreamWindowState() {
  if (!UNIQUE_VISITOR_REMOTE_ENABLED) {
    const saved = writeLocalJson(STREAM_WINDOW_FILE, publicStreamWindowState());
    streamWindowStoreReady = saved;
    return saved;
  }
  try {
    const payload = await storeRequest(['SET', STREAM_WINDOW_REDIS_KEY, JSON.stringify(publicStreamWindowState())]);
    if (payload?.result !== 'OK') throw new Error('Redis did not confirm stream window update');
    streamWindowStoreReady = true;
    return true;
  } catch (error) {
    warnUniqueStore(error);
    streamWindowStoreReady = false;
    return false;
  }
}

function broadcastStreamWindowState() {
  const state = publicStreamWindowState();
  broadcastSSE('stream_window_update', state);
  broadcastPublicSSE('stream_window_update', state);
  scheduleStatsBroadcast(0);
  return state;
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
  streamTargetsInitPromise = syncStreamTargets();
  overrideInitPromise = syncOverrideState();
  experimentalInitPromise = syncExperimentalState();
  streamWindowInitPromise = syncStreamWindowState();
} else {
  loadLocalUniqueVisitors();
  maintenanceInitPromise = syncMaintenanceState();
  newsInitPromise = syncNewsStore();
  sourceInitPromise = syncSourceConfig();
  streamTargetsInitPromise = syncStreamTargets();
  overrideInitPromise = syncOverrideState();
  experimentalInitPromise = syncExperimentalState();
  streamWindowInitPromise = syncStreamWindowState();
  if (UPSTASH_REDIS_REST_URL || UPSTASH_REDIS_REST_TOKEN) {
    console.warn('[Visitors] Both Upstash variables are required for remote persistence; using local JSON storage instead.');
  } else if (fileStoreReady) {
    console.log(`[Storage] Using local JSON persistence at ${DATA_DIR}. Configure REDIS_URL or a persistent disk for deploy-safe storage.`);
  } else {
    console.warn('[Storage] Local JSON storage is unavailable; mutable state will remain in memory.');
  }
}

/* A store that failed its boot-time sync used to stay "connecting" forever —
   one transient durable-store blip during startup left news (or maintenance, or the
   feed-source list) dead until someone happened to write to it again. Retry
   the failures on a slow timer until every store reports ready. */
const STORE_RESYNC_INTERVAL_MS = 60_000;
let storeResyncTimer = null;

function pendingStoreSyncs() {
  return [
    { name: 'maintenance', isReady: () => maintenanceStoreReady, sync: syncMaintenanceState },
    { name: 'news', isReady: () => newsStoreReady, sync: syncNewsStore },
    { name: 'sources', isReady: () => sourceStoreReady, sync: syncSourceConfig },
    { name: 'override', isReady: () => overrideStoreReady, sync: syncOverrideState },
    { name: 'experimental', isReady: () => experimentalStoreReady, sync: syncExperimentalState },
    { name: 'stream-window', isReady: () => streamWindowStoreReady, sync: syncStreamWindowState }
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

/* Render puts Cloudflare in front of the service and overwrites
   CF-Connecting-IP. Trust that header only through Render's private socket;
   other deployments keep it off unless explicitly configured. */
const CLIENT_IP_HEADER = (() => {
  const raw = String(process.env.CLIENT_IP_HEADER ?? (process.env.RENDER === 'true' ? 'cf-connecting-ip' : 'off'))
    .trim().toLowerCase();
  return ['', 'off', 'none', '0', 'false'].includes(raw) ? '' : raw;
})();
const getClientIp = createClientIpResolver({ headerName: CLIENT_IP_HEADER });

function normalizeVisitorId(value) {
  return String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9_.:@-]/g, '')
    .slice(0, 128);
}

/* The identity is the browser, and only the browser. A token is signed with the
   installation secret and carries just the id and an expiry — never an address.
   Binding tokens to an address made a phone that changed cell, or a viewer
   behind a rotating proxy, fail verification mid-session (403 -> re-mint), and
   it made two people behind one address indistinguishable. What a token
   authorises is unchanged: "this heartbeat comes from the browser that claimed
   this id". */
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

function consumeVisitorRateLimit(key, max = VISITOR_RATE_LIMIT_MAX) {
  const now = Date.now();
  const current = visitorRateLimits.get(key);
  if (!current || current.resetAt <= now) {
    visitorRateLimits.set(key, { count: 1, resetAt: now + VISITOR_RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (current.count >= max) return false;
  current.count++;
  return true;
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

/* ── First-party gate for visitor endpoints ───────────────────────
   The public site calls the API cross-origin, so a real viewer's browser
   always sends an Origin (and, with Referrer-Policy strict-origin-when-
   cross-origin, a Referer) that this deployment trusts. A script that mints
   visitor tokens to fabricate presence has no trusted origin — that is
   exactly the shape this refuses. Requests with no origin at all are only
   allowed off-production (local dev, the test harness, internal probes), or
   when they provably came from this same host. */
function isAuthorizedSiteRequest(req) {
  const origin = normalizeOrigin(req.headers.origin || '');
  const referer = normalizeOrigin(req.headers.referer || req.headers.referrer || '');
  const source = origin || referer;
  if (source) return isAllowedOrigin(req, source);
  // No Origin and no Referer. Browsers always send one for a cross-origin
  // fetch, so this is either a non-browser caller or a deployment that serves
  // the site from this very host (same-origin fetches omit Origin). Accept the
  // latter only when the request really arrived on the site's own hostname —
  // deriving "same origin" from the request's own Host header would accept any
  // direct API call, which is the hole this gate exists to close.
  if (!PRODUCTION_MODE) return true;
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  return isAuthorizedHostname(host) || host === 'localhost' || host === '127.0.0.1';
}

function rejectUnauthorizedSiteRequest(res) {
  return res.status(403).json({
    error: 'Forbidden',
    message: `Visitor endpoints are available to ${AUTHORIZED_DOMAIN} only.`
  });
}

/* ── New-identity budget (see NEW_IDENTITY_BUDGET_PER_IP_HOUR) ──── */
const newIdentityWindows = new Map(); // ip -> { count, resetAt }
let newIdentityBlockedCount = 0;
const newIdentityWarnedIps = new Set();

function consumeNewIdentityBudget(ip) {
  const now = Date.now();
  const state = newIdentityWindows.get(ip);
  if (!state || state.resetAt <= now) {
    newIdentityWindows.set(ip, { count: 1, resetAt: now + NEW_IDENTITY_BUDGET_WINDOW_MS });
    return true;
  }
  if (state.count >= NEW_IDENTITY_BUDGET_PER_IP_HOUR) {
    newIdentityBlockedCount++;
    /* One line per address, ever. Throttling it to once a minute still filled
       the log during a race, and a shared egress address (a mobile carrier, a
       university, an office) hits this constantly by design — it is the budget
       working, not a fault. The running total stays available to /admin. */
    if (!newIdentityWarnedIps.has(ip)) {
      newIdentityWarnedIps.add(ip);
      if (newIdentityWarnedIps.size <= 3) {
        console.warn(`[Visitors] New-identity budget reached for ${ip}; further `
          + 'identities stay live but are not added to the all-time total '
          + '(expected for shared/carrier egress addresses).');
      } else if (newIdentityWarnedIps.size === 4) {
        console.warn('[Visitors] New-identity budget reached for further '
          + 'addresses too — suppressing the rest, they are normal for shared egress.');
      }
    }
    return false;
  }
  state.count++;
  return true;
}

function pruneNewIdentityWindows(now = Date.now()) {
  for (const [ip, state] of newIdentityWindows) if (state.resetAt <= now) newIdentityWindows.delete(ip);
}

function getNewIdentityStatus() {
  return {
    budgetPerHour: NEW_IDENTITY_BUDGET_PER_IP_HOUR,
    blockedThisProcess: newIdentityBlockedCount,
    trackedAddresses: newIdentityWindows.size
  };
}

/* Crawlers, scanners, link-preview bots and uptime monitors hammer public
   hosts every minute. They are not viewers: never create presence entries,
   geo lookups or unique-visitor counts for them. */
const BOT_UA_RE = /(bot|crawl|spider|slurp|bingpreview|preview|monitor|uptime|pingdom|statuscake|lighthouse|headless|phantom|puppeteer|playwright|python-requests|python-urllib|curl|wget|go-http|okhttp|axios|feedparser|scrap|scanner|masscan|nmap|zgrab|semrush|ahrefs|mj12|dotbot|applebot|facebookexternalhit|twitterbot|discordbot|telegrambot|whatsapp|slackbot|linkedinbot|embedly|outbrain|pinterest|vkshare|redditbot|ia_archiver)/i;

function isBotUserAgent(ua) {
  return !ua || BOT_UA_RE.test(String(ua));
}

/* One row per browser. `key` is the id the site generates once and keeps in
   localStorage, so every tab of one browser lands on the same row and counts
   once. The address is used for exactly two things — the geo lookup and the
   per-address rate limits — and is never stored on the row, never sent to a
   client, and never part of an identity. */
function upsertVisitor(key, req, options = {}) {
  const now = Date.now();
  const ip = getClientIp(req);
  const ua = req.headers['user-agent'] || '';
  const { browser, os, deviceType } = parseUserAgent(ua);
  const page = options.page || req.path || '/';

  let entry = activeUsers.get(key);
  const isNew = !entry;

  if (!entry) {
    entry = {
      id: key,
      country: null,
      city: null,
      countryCode: null,
      browser,
      os,
      deviceType,
      page,
      connectedAt: now,
      lastSeen: now,
      source: options.source || 'page'
    };
    activeUsers.set(key, entry);

    // lookupGeo() itself refuses anything that cannot be located (private,
    // loopback, link-local), so there is one place that decides this.
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
    entry.browser = browser || entry.browser;
    entry.os = os || entry.os;
    entry.deviceType = deviceType || entry.deviceType;
    entry.page = options.keepExistingPage ? (entry.page || page) : page;
    entry.lastSeen = now;
    // Any heartbeat from this browser cancels a goodbye: the beacon that fired
    // belonged to a tab that closed, and this one is still open.
    entry.leftAt = null;
    entry.source = options.source || entry.source || 'page';
  }

  return { entry, isNew };
}

// Applied to site-serving routes only (not admin, APIs, health checks, or assets).
function visitorTracking(req, res, next) {
  if (
    req.path.startsWith('/admin') ||
    req.path.startsWith('/api/') ||
    req.path.startsWith('/stream/') ||
    req.path === '/healthz' ||
    req.path === '/favicon.ico' ||
    isStaticAssetPath(req.path)
  ) {
    return next();
  }

  const key = getVisitorRouteKey(req);
  if (isBotUserAgent(req.headers['user-agent'])) return next();
  const { entry, isNew } = upsertVisitor(key, req, {
    page: req.originalUrl || req.path || '/',
    source: 'page'
  });

  // Unique visitors are counted on heartbeat only — the site is a JS app, so
  // a "visit" means the app actually booted in a browser. Page-only hits are
  // crawlers and monitors; counting them fabricated users in every total.
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
const SITE_PAGES = new Set(['/', '/news', '/info', '/discord', '/performance', '/track', '/audio', '/247']);
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
  const online = countLiveUsers();
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
  const online = countLiveUsers(now);
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
// the minute sampler is the sole source of changes (keeps durable-store writes low).
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
      const payload = await storeRequest(['HGETALL', ANALYTICS_REDIS_KEY]);
      const result = payload?.result;
      // Redis adapters can return {field:value} object or [field,value,…] flat array depending on REST version
      if (Array.isArray(result)) {
        for (let i = 0; i + 1 < result.length; i += 2) hydrateAnalyticsField(String(result[i]), result[i + 1]);
      } else if (result && typeof result === 'object') {
        for (const [field, raw] of Object.entries(result)) hydrateAnalyticsField(String(field), raw);
      } else if (result == null) {
        // key missing — fresh install, keep empty but mark ready
      } else {
        // Unexpected shape — log for diagnostics but don't fail hydration
        console.warn('[Analytics] Unexpected HGETALL result shape:', typeof result, Array.isArray(result) ? 'array' : result);
      }
      analyticsStoreReady = true;
    }
  } catch (error) {
    warnUniqueStore(error);
    analyticsStoreReady = false;
  } finally {
    pruneAnalytics();
    analyticsHydrated = true;
    // Diagnostic — helps confirm Redis hydration after a rebuild (Render wipes disk)
    if (UNIQUE_VISITOR_REMOTE_ENABLED) {
      console.log(`[Analytics] hydrated daily=${analytics.daily.size} hourly=${analytics.hourly.size} live=${analytics.live.length} since=${analytics.since ? new Date(analytics.since).toISOString() : '—'} store=${analyticsStoreReady ? 'redis' : 'memory'}`);
    }
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
      if (commands.length) await storeRequest(commands);
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
    current: { online: countLiveUsers(now), openSessions, openSessionMs },
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
  for (const [key, state] of visitorRateLimits) if (state.resetAt <= now) visitorRateLimits.delete(key);
  pruneNewIdentityWindows(now);
  for (const [key, state] of loginGuard) if (!state.lockedUntil && state.resetAt <= now) loginGuard.delete(key);
  let removed = 0;
  for (const [id, visitor] of activeUsers) {
    if (now - visitor.lastSeen > PRESENCE_TTL_MS) {
      recordSessionEnd(visitor);
      broadcastSSE('visitor_update', { type: 'offline', visitor: sanitizeVisitor(visitor) });
      activeUsers.delete(id);
      removed++;
    }
  }
  if (removed) { scheduleStatsBroadcast(); broadcastPresence(true); }
  reconcilePublicSseCounts();
}

setInterval(cleanupInactiveVisitors, CLEANUP_INTERVAL).unref?.();

/* The shape the dashboard sees. Note what is absent: no address, ever. The row
   carries what a person reading the table needs — who (browser / OS / device /
   page), how recently (lastSeen), the exact moment they stop counting, and the
   country when the server could locate them. */
function sanitizeVisitor(v) {
  const now = Date.now();
  const lastSeen = Number(v.lastSeen || v.connectedAt || now);
  // "On the site" is one decision with one deadline. A verified browser session
  // whose heartbeat is fresh is live; the deadline is the same instant the
  // count loses them, so a row can never linger past the number it belongs to.
  // A goodbye moves that moment to leftAt + grace (whichever is sooner).
  const staleAt = lastSeen + PRESENCE_TTL_MS;
  const goneAt = v.leftAt ? v.leftAt + PRESENCE_LEAVE_GRACE_MS : Infinity;
  const liveUntil = v.analyticsStarted && now - lastSeen <= PRESENCE_TTL_MS &&
    !(v.leftAt && now - v.leftAt > PRESENCE_LEAVE_GRACE_MS)
    ? Math.min(staleAt, goneAt) : 0;
  return {
    id: v.id,
    country: v.country,
    city: v.city,
    countryCode: v.countryCode,
    browser: v.browser,
    os: v.os,
    deviceType: v.deviceType,
    page: v.page,
    connectedAt: v.connectedAt,
    lastSeen,
    live: Boolean(liveUntil),
    liveUntil,
    source: v.source
  };
}

/* People on the site right now. One browser is one count: the site heartbeats
   every two minutes while visible and stops when hidden, so freshness is the rule. */
function countLiveUsers(now = Date.now()) {
  let count = 0;
  for (const visitor of activeUsers.values()) {
    if (!visitor.analyticsStarted) continue;
    if (now - visitor.lastSeen > PRESENCE_TTL_MS) continue;
    if (visitor.leftAt && now - visitor.leftAt > PRESENCE_LEAVE_GRACE_MS) continue;
    count++;
  }
  return count;
}

/* The count is pushed, not polled. Changes are coalesced to at most one message
   per PRESENCE_BROADCAST_MS so a burst (a flurry of tabs opening) cannot turn
   into a message storm. Zero is always sent straight away: "nobody is on the
   site" must never be delayed by a throttle. */
const PRESENCE_BROADCAST_MS = Number(process.env.PRESENCE_BROADCAST_MS || 900);
let presenceBroadcastTimer = null;
let lastPresenceSentAt = 0;
let lastPresencePayload = '';

/* The public payload is deliberately tiny: one number and its timestamp. */
function presencePayload(now = Date.now()) {
  return { active: countLiveUsers(now), at: now };
}

/* The number has an expiry attached: a heartbeat stops counting its browser
   after PRESENCE_TTL_MS. Without a clock the count only changed when somebody
   else happened to beat — on a quiet site a closed tab sat in the count until
   the next visitor arrived. This arms one timer for the earliest deadline among
   the current visitors, so the drop is pushed the moment it is true, no matter
   how quiet the site is. */
let presenceTickTimer = null;
function schedulePresenceTick() {
  if (presenceTickTimer) { clearTimeout(presenceTickTimer); presenceTickTimer = null; }
  const now = Date.now();
  let next = null;
  for (const visitor of activeUsers.values()) {
    if (!visitor.analyticsStarted) continue;
    let deadline = visitor.lastSeen + PRESENCE_TTL_MS;
    if (visitor.leftAt) deadline = Math.min(deadline, visitor.leftAt + PRESENCE_LEAVE_GRACE_MS);
    if (deadline > now && (next === null || deadline < next)) next = deadline;
  }
  if (next === null) return;
  presenceTickTimer = setTimeout(() => {
    presenceTickTimer = null;
    broadcastPresence(true);
  }, Math.max(20, next - now + 30));
  presenceTickTimer.unref?.();
}

function broadcastPresence(force = false) {
  // Whatever the outcome below, the next expiry is armed from the state now.
  schedulePresenceTick();
  const payload = presencePayload();
  // Compare the numbers only: `at` changes on every call, so comparing the
  // whole payload would make the "nothing changed, stay quiet" check useless.
  const encoded = String(payload.active);
  const settled = lastPresenceSentAt && Date.now() - lastPresenceSentAt < PRESENCE_BROADCAST_MS;
  if (!force && encoded === lastPresencePayload) return;
  if (!force && settled && payload.active !== 0) {
    if (presenceBroadcastTimer) return;
    presenceBroadcastTimer = setTimeout(() => {
      presenceBroadcastTimer = null;
      broadcastPresence(true);
    }, PRESENCE_BROADCAST_MS - (Date.now() - lastPresenceSentAt));
    presenceBroadcastTimer.unref?.();
    return;
  }
  lastPresenceSentAt = Date.now();
  lastPresencePayload = encoded;
  // The public site only ever receives counts, never identities.
  broadcastPublicSSE('presence', payload);
  broadcastSSE('presence', payload);
}

function getStats() {
  const now = Date.now();
  let liveCount = 0;
  const visitors = [];

  for (const visitor of activeUsers.values()) {
    // The live dashboard lists real viewers only: entries without a heartbeat
    // are crawler/monitor noise and were the "fake users" bug.
    if (!visitor.analyticsStarted) continue;
    const sanitized = sanitizeVisitor(visitor);
    // Rows and the headline share one predicate and one deadline, so the table
    // can never show more people than the number above it.
    if (!sanitized.live) continue;
    liveCount++;
    visitors.push(sanitized);
  }

  visitors.sort((a, b) => b.lastSeen - a.lastSeen);

  return {
    // One number: browsers on the site right now.
    liveCount,
    totalUnique: getTotalUniqueVisitors(),
    // Surfaced so an operator can see identity inflation being refused rather
    // than discovering it as an unexplained jump in the permanent total.
    identityGuard: getNewIdentityStatus(),
    visitors,
    override: adminOverrideState(),
    maintenance: publicMaintenanceState(),
    sources: storedSourceConfig(),
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
      analyticsStore: dataStoreStatus(UNIQUE_VISITOR_REMOTE_ENABLED, analyticsStoreReady),
      experimentalStore: dataStoreStatus(UNIQUE_VISITOR_REMOTE_ENABLED, experimentalStoreReady)
    }
  };
}

// ─────────────────────────────────────────────
// STATIC FILES — Main site
// ─────────────────────────────────────────────

const SITE_INDEX_PATH = findIndexHtml(DEV_DIR);
const SITE_INDEX_EXISTS = Boolean(SITE_INDEX_PATH && fs.existsSync(SITE_INDEX_PATH));
const SITE_STATIC_DIR = SITE_INDEX_PATH ? path.dirname(SITE_INDEX_PATH) : null;
const SITE_STATIC_SAFE = Boolean(
  SITE_STATIC_DIR &&
  path.resolve(SITE_STATIC_DIR) !== path.resolve(__dirname)
);
const MAINTENANCE_PAGE_PATH = SITE_INDEX_PATH
  ? path.join(path.dirname(SITE_INDEX_PATH), 'maintenance.html')
  : path.join(DEV_DIR || '', 'maintenance.html');

console.log(`[Config] DEV_DIR   = ${DEV_DIR}`);
console.log(`[Config] ADMIN_DIR = ${ADMIN_DIR}`);
console.log(`[Config] DEV_DIR exists: ${Boolean(DEV_DIR && fs.existsSync(DEV_DIR))}`);
console.log(`[Config] ADMIN_DIR exists: ${fs.existsSync(ADMIN_DIR)}`);
console.log(`[Config] Static site dir: ${SITE_STATIC_SAFE ? SITE_STATIC_DIR : '(not served from this process)'}`);
console.log(`[Config] Allowed origins: ${ALLOWED_ORIGINS.join(', ') || '(same-origin/local only)'}`);

function isSensitivePublicPath(requestPath) {
  const n = String(requestPath || '').split('?')[0].toLowerCase();
  if (n.startsWith('/admin') || n.startsWith('/api/') || n === '/healthz') return false;
  if (n === '/data' || n.startsWith('/data/')) return true;
  if (n === '/bot' || n.startsWith('/bot/')) return true;
  if (n === '/scripts' || n.startsWith('/scripts/')) return true;
  if (n === '/server.js' || n === '/package.json' || n === '/package-lock.json') return true;
  if (n === '/.gitignore' || n === '/.env' || n.startsWith('/.env')) return true;
  if (n.includes('/.git')) return true;
  return false;
}

app.use((req, res, next) => {
  if (isSensitivePublicPath(req.path)) return res.status(404).json({ error: 'Not found' });
  next();
});

// Intercept the explicit index path before static middleware so maintenance
// mode cannot be bypassed when this server is also serving the public site.
app.get('/index.html', sendSiteIndex);

if (SITE_STATIC_SAFE) {
  app.use(express.static(SITE_STATIC_DIR, {
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
}

/* Self-hosted HLS relays are retired. Keep the old paths explicit so a stale
   client gets a small deterministic response instead of the SPA fallback. */
app.get(['/vendor/hls.min.js', '/relay/:channel/m3u8'], (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.status(410).type('text/plain').send(relayDisabledMessage);
});

/* ── self-check ────────────────────────────────────────────────────────────
   /healthz only proves the process is up, which is useless when the streams
   are down but the server is fine — the situation that actually happens. This
   checks the things that break, and for each failing one says what to do.

   Kept off /healthz so Render's own probe stays fast: this one reaches out to
   the upstream providers, which is exactly what you want on demand and exactly
   what you do not want on a 30-second readiness poll. */
const withTimeout = (promise, ms, fallback) => Promise.race([
  Promise.resolve(promise).catch((e) => ({ __error: e && e.message })),
  new Promise((r) => setTimeout(() => r({ __timeout: true }), ms)),
]).then((v) => (v === undefined ? fallback : v));

/* Deliberately NOT under /api: that prefix is default-deny and needs a site
   ticket, which is precisely what you cannot get when the site is the thing
   that is broken. Protected by its own shared secret instead.

   Set SELFCHECK_TOKEN on the service and bookmark
   https://<host>/selfcheck?token=<that value>. If the variable is unset the
   endpoint stays open, which is fine locally and worth avoiding in production. */
const SELFCHECK_TOKEN = String(process.env.SELFCHECK_TOKEN || '').trim();

app.get('/selfcheck', async (req, res) => {
  if (SELFCHECK_TOKEN && req.query.token !== SELFCHECK_TOKEN) {
    return res.status(404).send('Not found');
  }
  const checks = [];
  /* `warn` marks a deliberate, operator-chosen state that is not a fault. It
     still shows on the page but does not fail the run — otherwise flipping a
     switch on purpose would leave this page permanently red and the real
     outages would stop standing out. */
  const add = (name, ok, detail, fix, warn) => {
    const c = { name, ok: !!ok, detail: String(detail || ''), fix: fix || '' };
    if (warn) c.warn = true;
    checks.push(c);
  };

  // 1. Discord is optional. It is an error only when configured but not ready.
  const botConfigured = Boolean(process.env.DISCORD_BOT_TOKEN);
  let botOk = !botConfigured;
  let botDetail = botConfigured ? 'configured but not connected' : 'optional bot disabled';
  try {
    if (botConfigured && discordBot && discordBot.client) {
      const ready = typeof discordBot.client.isReady === 'function' && discordBot.client.isReady();
      botOk = ready;
      botDetail = ready ? 'connected' : 'client created but not connected';
    }
  } catch (e) { botOk = false; botDetail = 'error: ' + (e && e.message); }
  add('discordBot', botOk, botDetail, botOk ? '' :
    'Check DISCORD_BOT_TOKEN, DISCORD_OWNER_ID and DISCORD_GUILD_ID are all set. '
    + 'If the log says "Used disallowed intents", leave DISCORD_GUILD_MEMBERS_INTENT unset '
    + 'and enable Server Members Intent in the portal before setting it to 1.');

  // 2. Announcements are required only when the bot itself is enabled.
  const announcementsOk = !botConfigured || Boolean(linkEventSink);
  add('linkAnnouncements', announcementsOk,
    linkEventSink ? 'wired to the bot' : 'optional bot disabled',
    announcementsOk ? '' : 'The configured bot did not expose announceLink; check its startup log.');

  // 3. link store readable? A lookup for an id that cannot exist still proves
  //    the store loads and answers, which is the thing that breaks.
  try {
    const probe = await withTimeout(discordLink.isUserLinked('selfcheck-probe'), 3000, null);
    add('linkStore', probe !== null && probe !== undefined,
      'store answers (durable store: ' + (UNIQUE_VISITOR_REMOTE_ENABLED ? durableStore.provider : 'no') + ')',
      (probe === null || probe === undefined)
        ? 'Link store did not answer within 3s. Check the Redis URL and network.' : '');
  } catch (e) {
    add('linkStore', false, 'unreadable: ' + (e && e.message), 'Check the durable-store environment variables.');
  }

  // 4. Prove the configured durable transport itself can answer.
  if (UNIQUE_VISITOR_REMOTE_ENABLED) {
    const pong = await withTimeout(storeRequest(['PING']), 3000, null);
    const durableOk = String(pong?.result || '').toUpperCase() === 'PONG';
    add('durableStore', durableOk,
      durableOk ? `${durableStore.provider} answered PONG` : 'configured store did not answer PING within 3s',
      durableOk ? '' : 'Check REDIS_URL, TLS mode, credentials and provider network access.');
  } else {
    add('durableStore', !PRODUCTION_MODE, 'local file/memory only',
      PRODUCTION_MODE ? 'Set REDIS_URL to a durable Redis/Valkey database.' : '');
  }

  // 5. Every advertised source must have a valid redirect target.
  await withTimeout(streamTargetsInitPromise, 3000, null);
  const missingTargets = [...FEED_SOURCE_IDS].filter(id => !streamTargets.has(id));
  add('streamTargets', missingTargets.length === 0,
    missingTargets.length ? `missing: ${missingTargets.join(', ')}` : `${streamTargets.size} valid target(s) loaded`,
    missingTargets.length ? 'Set STREAM_TARGETS_JSON or repair data/stream-targets.json.' : '');

  // 6. Relays are intentionally absent: this must never turn into an
  // upstream probe or a media path on the bandwidth-limited service.
  add('selfHostedRelays', true,
    'retired — provider-hosted redirects only; no playlists or media cross Render', '');

  // 7. Community linking is optional and never gates playback.
  add('discordLinking', true,
    botConfigured ? 'bot configured; profile linking available' : 'optional bot is not configured', '');

  const ok = checks.every((c) => c.ok);
  const warnings = checks.filter((c) => c.warn).length;
  res.setHeader('Cache-Control', 'no-store');
  res.status(ok ? 200 : 503).json({ ok, warnings, checkedAt: Date.now(), checks });
});

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

/* Render uses readiness, not bare process liveness. A bad Redis credential must
   fail the deploy instead of producing a green service that silently loses
   mutable state on its ephemeral filesystem. */
app.get('/readyz', (req, res) => {
  const stores = {
    uniqueVisitors: uniqueVisitorStoreReady,
    maintenance: maintenanceStoreReady,
    news: newsStoreReady,
    sources: sourceStoreReady,
    override: overrideStoreReady,
    experimental: experimentalStoreReady,
    streamWindow: streamWindowStoreReady,
    analytics: analyticsStoreReady
  };
  const durableReady = UNIQUE_VISITOR_REMOTE_ENABLED && Object.values(stores).every(Boolean);
  const targetsReady = [...FEED_SOURCE_IDS].every(id => streamTargets.has(id));
  const ok = targetsReady && (PRODUCTION_MODE ? durableReady : (durableReady || fileStoreReady));
  res.status(ok ? 200 : 503).json({
    ok,
    durableProvider: durableStore.provider,
    durableReady,
    targetsReady,
    stores
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
    const site = String(process.env.SITE_URL || `https://${AUTHORIZED_HOSTNAME}`).replace(/\/+$/, '');
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(302, `${site}/`);
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
  // Tokens are only ever minted for the site itself; see isAuthorizedSiteRequest.
  if (!isAuthorizedSiteRequest(req)) return rejectUnauthorizedSiteRequest(res);
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
    // A heartbeat mutates presence, so it carries the same first-party gate as
    // the token mint that authorised it.
    if (!isAuthorizedSiteRequest(req)) return rejectUnauthorizedSiteRequest(res);

    const ip = getClientIp(req);
    // Token first: only a verified identity is charged a budget, so a forged
    // token cannot burn somebody else's. The address is not part of the token —
    // identity is the browser.
    if (!verifyVisitorToken(req.headers['x-visitor-token'], suppliedUserId)) {
      return res.status(403).json({ error: 'Invalid or expired visitor token' });
    }
    if (!consumeVisitorRateLimit(`heartbeat:${suppliedUserId}`, HEARTBEAT_RATE_LIMIT_MAX) ||
        !consumeVisitorRateLimit(`heartbeat-ip:${ip}`, HEARTBEAT_IP_RATE_LIMIT_MAX)) {
      res.setHeader('Retry-After', String(Math.ceil(VISITOR_RATE_LIMIT_WINDOW_MS / 1000)));
      return res.status(429).json({ error: 'Too many heartbeat requests. Try again later.' });
    }

    // Presence rows are keyed by the browser's own id and nothing else, so
    // every tab of one browser is one row and one count.
    const key = suppliedUserId;
    const headerPage = normalizeSitePage(req.query.page);
    const { entry, isNew } = upsertVisitor(key, req, {
      page: headerPage || pageFromReferer(req, activeUsers.get(key)?.page || '/'),
      source: 'heartbeat',
      keepExistingPage: !headerPage && !req.headers.referer
    });
    // Analytics: a heartbeat means a real browser running the site, so this is
    // where a session starts counting (page-only hits from crawlers are not).
    recordSessionStart(entry);
    // The permanent total only takes identities that fit inside the per-IP
    // budget; an over-budget identity still counts as a live viewer.
    const withinIdentityBudget = consumeNewIdentityBudget(ip);
    const isGloballyNew = withinIdentityBudget ? await trackUniqueVisitor(key) : false;
    recordVisitorKind(entry, isGloballyNew);

    // Heartbeats update one row in real time; full stats are serialized only
    // for a new live session or a newly confirmed permanent visitor.
    broadcastVisitorChange(isNew ? 'online' : 'heartbeat', entry, isNew || isGloballyNew);
    broadcastPresence();
    // Scaled clients already receive presence over SSE and request a header-only
    // acknowledgement. Keep JSON as the default for older clients and tooling.
    if (req.query.minimal === '1') return res.status(204).end();
    res.json(presencePayload());
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
  if (!isAuthorizedSiteRequest(req)) return rejectUnauthorizedSiteRequest(res);
  const eventIp = getClientIp(req);
  if (!verifyVisitorToken(req.headers['x-visitor-token'], suppliedUserId)) {
    return res.status(403).json({ error: 'Invalid or expired visitor token' });
  }
  if (!consumeVisitorRateLimit(`event:${suppliedUserId}`, EVENT_RATE_LIMIT_MAX) ||
      !consumeVisitorRateLimit(`event-ip:${eventIp}`, EVENT_IP_RATE_LIMIT_MAX)) {
    res.setHeader('Retry-After', String(Math.ceil(VISITOR_RATE_LIMIT_WINDOW_MS / 1000)));
    return res.status(429).json({ error: 'Too many events. Try again later.' });
  }
  const type = typeof req.body?.type === 'string' ? req.body.type.slice(0, 24) : '';
  // Signed id only — same rule as the heartbeat. The old IP fallback could
  // attribute one user's activity to a stranger on the same NAT.
  const entry = activeUsers.get(suppliedUserId);
  if (!recordViewerEvent(type, req.body?.value, entry)) return res.status(400).json({ error: 'Unknown event' });
  res.status(204).end();
});

/* Goodbye signal. Fired by navigator.sendBeacon on pagehide — the one moment a
   browser is willing to deliver a request while the page is being torn down.
   sendBeacon cannot set headers, so the identity travels in the query string
   here; it is the same signed, 24h token the header path uses, and the only
   thing it authorises is taking this one identity out of the count. */
app.post('/api/visitors/leave', (req, res) => {
  if (!isAuthorizedSiteRequest(req)) return rejectUnauthorizedSiteRequest(res);
  const userId = normalizeVisitorId(req.query.uid || req.headers['x-user-id']);
  const token = String(req.query.token || req.headers['x-visitor-token'] || '');
  if (!userId) return res.status(400).json({ error: 'Missing user ID' });
  if (!verifyVisitorToken(token, userId)) return res.status(403).json({ error: 'Invalid or expired visitor token' });
  /* A goodbye marks the browser, it does not erase it: another tab of the same
     browser may still be open and will clear the mark with its next beat. If
     none comes, the browser leaves the count at the grace deadline. */
  const entry = activeUsers.get(userId);
  if (entry) {
    entry.leftAt = Date.now();
    broadcastVisitorChange('update', entry, false);
    broadcastPresence(true);
  }
  res.status(204).end();
});

app.get('/api/visitors/active', (req, res) => {
  if (!consumeVisitorRateLimit(`active:${getClientIp(req)}`)) {
    res.setHeader('Retry-After', String(Math.ceil(VISITOR_RATE_LIMIT_WINDOW_MS / 1000)));
    return res.status(429).json({ error: 'Too many requests. Try again later.' });
  }
  // Same shape as the heartbeat response, so nothing ever has to guess what
  // `active` means: watching is the headline, online is the wider number.
  res.json(presencePayload());
});

// ─────────────────────────────────────────────
// PUBLIC — Site/stream status & SSE (no auth needed)
// ─────────────────────────────────────────────

/* Counts and a tier name only — no address ever leaves the server. */
function publicStreamTargetsState() {
  return { targets: streamTargets.size, source: streamTargetsSource };
}

app.get('/api/site/status', async (req, res, next) => {
  try {
    await Promise.all([maintenanceInitPromise, streamWindowInitPromise, streamTargetsInitPromise]);
    res.json({
      maintenance: publicMaintenanceState(),
      streamWindow: publicStreamWindowState(),
      // How many feeds can actually play, so an outage is one curl away.
      stream: publicStreamTargetsState()
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/stream/window', async (req, res, next) => {
  try {
    await streamWindowInitPromise;
    res.setHeader('Cache-Control', 'no-store');
    res.json(publicStreamWindowState());
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
    // ids, labels and which ones are switched off. Never a URL: see the stream
    // targets section for why.
    res.json(publicSourceConfig());
  } catch (error) {
    next(error);
  }
});

/* The browser's only way to reach a stream. It has to come from the site, in a
   browser (Origin or Referer present and authorized), and it has to name a
   source that has a target configured. What it gets back is an alias on this
   origin that expires — not the destination. */
/* ─────────────────────────────────────────────────────────────────────────────
   Discord link API. These ride the ordinary site ticket, so a script cannot
   mint codes without first loading the page like a browser.
   ───────────────────────────────────────────────────────────────────────────── */
app.post('/api/discord/link-code', async (req, res, next) => {
  try {
    const ip = getClientIp(req);
    if (!consumeVisitorRateLimit(`discord-code:${ip}`, DISCORD_CODE_RATE_MAX)) {
      res.setHeader('Retry-After', String(Math.ceil(VISITOR_RATE_LIMIT_WINDOW_MS / 1000)));
      return res.status(429).json({ error: 'Too many codes requested. Try again in a little while.' });
    }
    const result = await discordLink.createCode();
    if (result.error) return res.status(503).json({ error: result.error });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ code: result.code, expiresAt: result.expiresAt, ttlMs: discordLink.CODE_TTL_MS, inviteUrl: DISCORD_INVITE_URL });
  } catch (error) { next(error); }
});

app.get('/api/discord/link-status', async (req, res, next) => {
  try {
    const code = String(req.query.code || '').slice(0, 16);
    if (!code) return res.status(400).json({ error: 'Missing code.' });
    const status = await discordLink.status(code);
    res.setHeader('Cache-Control', 'no-store');
    res.json(status);
  } catch (error) { next(error); }
});

app.post('/api/discord/link-confirm', async (req, res, next) => {
  try {
    const body = req.body || {};
    const result = await discordLink.confirm(String(body.code || '').slice(0, 16), body.yes === true);
    res.setHeader('Cache-Control', 'no-store');
    if (result.error) return res.status(400).json({ error: result.error });
    if (!result.ok) return res.json({ ok: false, reason: result.reason });
    /* SameSite=None so the cookie also rides the cross-site /stream/<ticket>
       iframe request — 'strict' would leave the player page locked out. */
    res.setHeader('Set-Cookie', discordLink.cookieValue(result.token, { secure: isSecureRequest(req) }));
    res.json({ ok: true, profile: result.profile });
  } catch (error) { next(error); }
});

app.get('/api/discord/me', async (req, res, next) => {
  try {
    const access = await hasDiscordAccess(req);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ linked: access.linked, profile: access.profile || null, reason: access.reason || null });
  } catch (error) { next(error); }
});

/* Only forgets this browser's cookie. `/unlink` in Discord removes the account
   row itself, so every linked browser observes the change. */
app.post('/api/discord/unlink', async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Set-Cookie', discordLink.clearedCookie({ secure: isSecureRequest(req) }));
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.post('/api/stream/ticket', async (req, res, next) => {
  try {
    await Promise.all([sourceInitPromise, streamTargetsInitPromise]);
    if (!STREAM_TICKETS_ENABLED) return res.status(503).json({ error: 'Stream tickets are disabled.' });
    if (!isBrowserSiteRequest(req)) {
      return res.status(403).json({ error: 'Stream tickets are only issued to the site itself.' });
    }
    const ip = getClientIp(req);
    if (!consumeVisitorRateLimit(`stream-ticket:${ip}`, STREAM_TICKET_RATE_MAX)) {
      res.setHeader('Retry-After', String(Math.ceil(VISITOR_RATE_LIMIT_WINDOW_MS / 1000)));
      return res.status(429).json({ error: 'Too many stream tickets. Try again later.' });
    }
    const body = req.body || {};
    const sourceId = String(body.sourceId || '').trim().slice(0, 40);
    if (RETIRED_RELAY_SOURCE_IDS.has(sourceId)) {
      return res.status(410).json({ error: relayDisabledMessage });
    }
    if (!FEED_SOURCE_IDS.has(sourceId) && sourceId !== OVERRIDE_SOURCE_ID) {
      return res.status(400).json({ error: 'Unknown source id.' });
    }
    if (sourceId === OVERRIDE_SOURCE_ID) {
      await overrideInitPromise;
      if (!streamOverride.active || !streamOverride.url) {
        return res.status(503).json({ error: 'No stream override is active.' });
      }
    } else {
      if (!streamTargets.has(sourceId)) return res.status(503).json({ error: 'That source has no configured target.' });
      // The template params are validated in renderStreamTarget; rendering here
      // too means a client that sends nonsense gets a clear refusal instead of an
      // alias that fails at play time.
      if (!renderStreamTarget(sourceId, body.params || {})) {
        return res.status(400).json({ error: 'Missing or invalid parameters for that source.' });
      }
    }
    const ticket = ticketService.createStream(sourceId, STREAM_TICKET_TTL_MS);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ href: `/stream/${ticket}`, expiresAt: Date.now() + STREAM_TICKET_TTL_MS });
  } catch (error) {
    next(error);
  }
});

/* The permission itself. Minted only for a request that came from the site in a
   browser (authorized Origin/Referer), budgeted per address, worthless anywhere
   else — the stream ticket's shape, applied to the rest of the API. */
app.post('/api/site/ticket', async (req, res, next) => {
  try {
    if (!SITE_TICKETS_ENABLED) return res.status(503).json({ error: 'Site tickets are disabled.' });
    if (!isBrowserSiteRequest(req)) {
      return res.status(403).json({ error: 'Site tickets are only issued to the site itself.' });
    }
    const ip = getClientIp(req);
    if (!consumeVisitorRateLimit(`site-ticket:${ip}`, SITE_TICKET_RATE_MAX)) {
      res.setHeader('Retry-After', String(Math.ceil(VISITOR_RATE_LIMIT_WINDOW_MS / 1000)));
      return res.status(429).json({ error: 'Too many site tickets. Try again later.' });
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ticket: ticketService.createSite(SITE_TICKET_TTL_MS), expiresAt: Date.now() + SITE_TICKET_TTL_MS });
  } catch (error) {
    next(error);
  }
});

/* Redeem an alias. The destination is resolved from the SERVER-side map at this
   moment, which is what makes rotation instant: change or remove a target and
   every alias already in the wild points at the new place (or stops working). */
app.get('/stream/:ticket', async (req, res, next) => {
  try {
    if (!STREAM_TICKETS_ENABLED) return res.status(503).send('Stream tickets are disabled.');
    const decoded = ticketService.verifyStream(req.params.ticket);
    if (!decoded) return res.status(403).send('Invalid stream ticket.');
    if (decoded.exp && Date.now() > decoded.exp) return res.status(410).send('This stream ticket has expired — reload the page.');
    await Promise.all([sourceInitPromise, streamTargetsInitPromise, overrideInitPromise]);
    if (RETIRED_RELAY_SOURCE_IDS.has(decoded.sourceId)) {
      return res.status(410).type('text/plain').send(relayDisabledMessage);
    }
    const url = decoded.sourceId === OVERRIDE_SOURCE_ID
      ? (streamOverride.active && streamOverride.url ? streamOverride.url : null)
      : renderStreamTarget(decoded.sourceId, req.query || {});
    if (!url) return res.status(503).send('That source is not available right now.');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // 302: the browser then loads the feed from the provider; our origin is
    // never the stream host, and the alias itself is worth nothing elsewhere.
    res.redirect(302, url);
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
    const payload = await storeRequest(['GET', openf1SnapshotKey(url)]);
    const raw = payload && payload.result;
    if (typeof raw !== 'string') return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.data)) return null;
    cacheSetCapped(openf1Snapshots, url, parsed, OPENF1_SNAPSHOT_MAX);
    return parsed;
  } catch (error) {
    return null;
  }
}

function openf1SnapshotSave(url, data) {
  const snapshot = { data, at: Date.now() };
  cacheSetCapped(openf1Snapshots, url, snapshot, OPENF1_SNAPSHOT_MAX);
  if (!UNIQUE_VISITOR_REMOTE_ENABLED) return;
  const raw = JSON.stringify(snapshot);
  if (raw.length > OPENF1_SNAPSHOT_MAX_BYTES) return;

  // Durable snapshots are a convenience (survive a restart), not a source of
  // truth: cap the daily writes so a caller varying query strings cannot grow
  // the Redis keyspace without limit.
  const today = new Date().toISOString().slice(0, 10);
  if (today !== openf1SnapshotWriteDay) {
    openf1SnapshotWriteDay = today;
    openf1SnapshotWritesToday = 0;
    openf1SnapshotWriteCapLogged = false;
  }
  if (openf1SnapshotWritesToday >= OPENF1_SNAPSHOT_WRITES_PER_DAY) {
    if (!openf1SnapshotWriteCapLogged) {
      openf1SnapshotWriteCapLogged = true;
      console.warn(`[OpenF1] Daily snapshot write budget (${OPENF1_SNAPSHOT_WRITES_PER_DAY}) reached; serving from memory until tomorrow.`);
    }
    return;
  }
  openf1SnapshotWritesToday++;
  storeRequest(['SET', openf1SnapshotKey(url), raw, 'EX', OPENF1_SNAPSHOT_TTL_S]).catch(() => {});
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
      if (response && (response.ok || response.status === 404)) {
        if (response.status === 404) {
          cacheSetCapped(openf1Cache, url, { data: [], at: Date.now() }, OPENF1_CACHE_MAX);
          return { data: [], stale: false };
        }
        try {
          const data = await response.json();
          const cleanData = data && data.detail === 'No results found.' ? [] : (Array.isArray(data) ? data : []);
          cacheSetCapped(openf1Cache, url, { data: cleanData, at: Date.now() }, OPENF1_CACHE_MAX);
          openf1SnapshotSave(url, cleanData);
          return { data: cleanData, stale: false };
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
  // The query string is a fixed vocabulary: known keys, short values, and
  // numeric identifiers. Values feed cache keys, so free-form strings would
  // let one caller mint unlimited entries.
  const numericKeys = new Set(['session_key', 'meeting_key', 'driver_number', 'year']);
  for (const [key, value] of new URLSearchParams(query)) {
    if (!OPENF1_QUERY_KEYS.has(key) || String(value).length > 120) {
      return res.status(400).json({ error: 'Invalid query' });
    }
    if (numericKeys.has(key) && !/^\d{1,9}$/.test(String(value))) {
      return res.status(400).json({ error: 'Invalid query' });
    }
  }
  const url = `${OPENF1_UPSTREAM}/${openf1Path}${query ? `?${query}` : ''}`;
  try {
    const { data, stale } = await openf1Resolve(url, openf1Path);
    if (openf1Path === 'drivers' || openf1Path === 'meetings') {
      res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    } else if (openf1Path === 'sessions') {
      res.setHeader('Cache-Control', 'public, max-age=15, stale-while-revalidate=60');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=5, stale-while-revalidate=15');
    }
    if (stale) res.setHeader('X-OpenF1-Stale', '1');
    return res.json(data);
  } catch (error) {
    const code = error.code === 'live' || error.code === 'rate' ? error.code : 'upstream';
    return res.status(503).json({ code, error: error.message });
  }
});

// ── Live Timing & Leaderboard (Real-time Pit-Wall Feed) ──
let liveTimingCache = { data: null, at: 0 };
const ESPN_F1_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/racing/f1/scoreboard';

async function fetchLiveTiming() {
  const now = Date.now();
  if (liveTimingCache.data && now - liveTimingCache.at < 5000) {
    return liveTimingCache.data;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(ESPN_F1_SCOREBOARD, {
      headers: { accept: 'application/json' },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`Scoreboard responded with ${res.status}`);
    const json = await res.json();
    const event = json.events?.[0];
    const comp = event?.competitions?.[0];
    const status = comp?.status?.type?.detail || event?.status?.type?.description || 'Off Track';
    const totalLaps = comp?.totalLaps || 0;
    const currentLap = comp?.status?.period || 0;
    const competitors = (comp?.competitors || []).map((c) => ({
      position: c.order || 0,
      name: c.athlete?.displayName || '',
      shortName: c.athlete?.shortName || '',
      flag: c.athlete?.flag?.href || '',
      status: c.status?.type?.description || ''
    }));
    const payload = {
      event: event?.name || '',
      status,
      currentLap,
      totalLaps,
      competitors,
      updatedAt: now
    };
    liveTimingCache = { data: payload, at: now };
    return payload;
  } catch (err) {
    if (liveTimingCache.data) return liveTimingCache.data;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

app.get('/api/live/timing', async (req, res) => {
  if (!consumeVisitorRateLimit(`timing:${getClientIp(req)}`)) {
    res.setHeader('Retry-After', '10');
    return res.status(429).json({ error: 'Too many requests. Try again later.' });
  }
  try {
    const data = await fetchLiveTiming();
    res.setHeader('Cache-Control', 'public, max-age=5');
    return res.json(data);
  } catch (err) {
    return res.status(503).json({ error: 'Live timing temporarily unavailable' });
  }
});

// ── Career data proxy — aggregates Jolpi/Ergast for a driver (10-13 upstream calls → 1 client call).
// Client direct hits to api.jolpi.ca are slow from the browser (CORS + large offsets). Render caches
// the computed career for 12h and coallesces concurrent requests, so second opener is <50ms.
const JOLPI_UPSTREAM = String(process.env.JOLPI_API || 'https://api.jolpi.ca/ergast/f1').replace(/\/+$/, '');
const CAREER_TTL_MS = 12 * 60 * 60 * 1000;
const TITLE_TTL_MS = 24 * 60 * 60 * 1000;
const careerCache = new Map(); // driverId -> { data, at }
const careerInflight = new Map(); // driverId -> Promise
const titleChampionCache = new Map(); // year -> { champ, at }

/* ── Jolpica upstream budget ──────────────────────────────────────
   One cold career request fans out into 2-13 upstream calls, and the free
   Jolpica API is rate-limited per IP — i.e. shared by every viewer of this
   service. A global token bucket keeps one caller (or one burst) from
   exhausting the quota for everybody; requests over budget fail fast and the
   cached/section fallbacks in the client still render. */
const JOLPI_MAX_PER_MINUTE = Math.max(10, Number.parseInt(process.env.JOLPI_MAX_PER_MINUTE || '120', 10) || 120);
let jolpiWindowStart = Date.now();
let jolpiWindowCount = 0;

function takeJolpiBudget() {
  const now = Date.now();
  if (now - jolpiWindowStart >= 60_000) {
    jolpiWindowStart = now;
    jolpiWindowCount = 0;
  }
  if (jolpiWindowCount >= JOLPI_MAX_PER_MINUTE) return false;
  jolpiWindowCount++;
  return true;
}

async function jolpiGet(path) {
  if (!takeJolpiBudget()) throw new Error('Jolpica request budget exhausted');
  const url = `${JOLPI_UPSTREAM}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal });
    if (!res.ok) throw new Error(`Jolpi ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}
function fmtPtsServer(n){
  const v = Math.round(Number(n)*10)/10;
  return Number.isInteger(v) ? String(v|0) : String(v);
}
async function computeCareer(driverId){
  // mirror client fetchAllResults + seasons/poles/titles but on the server with more parallelism
  const first = await jolpiGet(`/drivers/${driverId}/results/?limit=100&offset=0`).catch(()=>null);
  const rows = first?.MRData?.RaceTable?.Races || [];
  const total = Number(first?.MRData?.total || rows.length);
  if (!rows.length) return null;
  if (total > rows.length) {
    const offs = [];
    for(let off=rows.length; off<total; off+=100) offs.push(off);
    const pages = await Promise.all(offs.map(off => jolpiGet(`/drivers/${driverId}/results/?limit=100&offset=${off}`).catch(()=>null)));
    for(const pg of pages){
      const batch = pg?.MRData?.RaceTable?.Races || [];
      if(!batch.length) return null;
      rows.push(...batch);
    }
  }
  const [polesDoc, seasonsDoc] = await Promise.all([
    jolpiGet(`/drivers/${driverId}/qualifying/1/?limit=1`).catch(()=>null),
    jolpiGet(`/drivers/${driverId}/seasons/?limit=100`).catch(()=>null)
  ]);
  if (!polesDoc) return null;
  let wins=0, podiums=0, points=0, seasonPodiums=0;
  const winSeasons = new Set(), allSeasons = new Set();
  const SITE_SEASON_SRV = 2026;
  for(const r of rows){
    allSeasons.add(r.season);
    const res = r.Results?.[0];
    if(!res) continue;
    points += parseFloat(res.points)||0;
    const pos = res.position;
    if(pos==='1'){ wins++; podiums++; winSeasons.add(r.season); }
    else if(pos==='2'||pos==='3') podiums++;
    if(String(r.season)===String(SITE_SEASON_SRV) && (pos==='1'||pos==='2'||pos==='3')) seasonPodiums++;
  }
  const seasonRows = seasonsDoc?.MRData?.SeasonTable?.Seasons || [];
  const years = seasonRows.length ? seasonRows.map(s=>s.season) : [...allSeasons].sort();
  const span = years.length>1 ? `${years[0]}–${years[years.length-1]}` : (years[0]||String(SITE_SEASON_SRV));
  // titles — check each win season once, cached
  let titles = 0;
  const winArr = [...winSeasons];
  // filter out current incomplete season (same as client)
  const lastRace = null; // be permissive server side — only filter current year if you add schedule check
  const titleYears = winArr; // keep all; client filters 2026 only if season incomplete — harmless to check extra
  if(titleYears.length){
    const champs = await Promise.all(titleYears.map(async y=>{
      const cached = titleChampionCache.get(String(y));
      if(cached && Date.now()-cached.at < TITLE_TTL_MS) return cached.champ;
      try{
        const d = await jolpiGet(`/${y}/driverstandings/1/?limit=1`);
        const champ = d?.MRData?.StandingsTable?.StandingsLists?.[0]?.DriverStandings?.[0]?.Driver?.driverId || null;
        cacheSetCapped(titleChampionCache, String(y), { champ, at: Date.now() }, CAREER_CACHE_MAX);
        return champ;
      }catch(_){ return null; }
    }));
    if(champs.includes(null)) return null;
    titles = champs.filter(c=>c===driverId).length;
  }
  return {
    races: rows.length, wins, podiums, seasonPodiums,
    points: fmtPtsServer(points),
    poles: Number(polesDoc?.MRData?.total||0),
    seasons: years.length || allSeasons.size,
    span, titles
  };
}
app.get('/api/career/:driverId', async (req, res) => {
  const driverId = String(req.params.driverId||'').toLowerCase().replace(/[^a-z0-9_]/g,'').slice(0,40);
  if(!driverId) return res.status(400).json({ error: 'driverId required' });
  if(!consumeVisitorRateLimit(`career:${getClientIp(req)}`)){
    res.setHeader('Retry-After','10');
    return res.status(429).json({ error: 'Too many requests' });
  }
  const now = Date.now();
  const cached = careerCache.get(driverId);
  if(cached && now - cached.at < CAREER_TTL_MS){
    res.setHeader('Cache-Control','public, max-age=300, stale-while-revalidate=600');
    res.setHeader('X-Cache','HIT');
    return res.json({ career: cached.data, cached: true });
  }
  if(careerInflight.has(driverId)) {
    try{ const data = await careerInflight.get(driverId); res.setHeader('X-Cache','COALESCED'); return res.json({ career: data, cached: false }); }catch(e){ /* fall through */ }
  }
  const job = computeCareer(driverId);
  careerInflight.set(driverId, job);
  try{
    const data = await job;
    if(!data) return res.status(503).json({ error: 'Career unavailable' });
    cacheSetCapped(careerCache, driverId, { data, at: Date.now() }, CAREER_CACHE_MAX);
    res.setHeader('Cache-Control','public, max-age=300, stale-while-revalidate=600');
    res.setHeader('X-Cache','MISS');
    return res.json({ career: data, cached: false });
  }catch(err){
    return res.status(503).json({ error: 'Upstream failure' });
  }finally{ careerInflight.delete(driverId); }
});

// Public audio-only feed for the experimental Audio page.
// Direct m3u8 / AAC / MP3 URL — never a video embed page.
app.get('/api/audio-feed', (req, res) => {
  const url = String(process.env.AUDIO_FEED_URL || process.env.FREEF1_AUDIO_URL || '').trim();
  res.setHeader('Cache-Control', 'public, max-age=15, stale-while-revalidate=45');
  return res.json({ url, available: Boolean(url) });
});

// Public endpoint for experimental features toggle state
app.get('/api/experimental', async (req, res, next) => {
  try {
    await experimentalInitPromise;
    res.setHeader('Cache-Control', 'public, max-age=5, stale-while-revalidate=15');
    return res.json(publicExperimentalState());
  } catch (error) {
    next(error);
  }
});

// Public SSE endpoint — sends public stream, maintenance and news updates (no visitor data)

/* Per-IP accounting for the long-lived public sockets, so one host cannot hold
   the whole pool open. Counts are released on close and swept on the heartbeat
   timer if a socket died without a close event. */
const publicSseByIp = new Map(); // ip -> count

function registerPublicSse(req, res) {
  const ip = getClientIp(req);
  const current = publicSseByIp.get(ip) || 0;
  if (current >= PUBLIC_SSE_MAX_PER_IP) return null;
  publicSseByIp.set(ip, current + 1);
  res.__sseIp = ip;
  return ip;
}

function releasePublicSse(ip) {
  if (!ip) return;
  const current = publicSseByIp.get(ip) || 0;
  if (current <= 1) publicSseByIp.delete(ip);
  else publicSseByIp.set(ip, current - 1);
}

/* The heartbeat write drops sockets that died without a close event, so the
   ledger is rebuilt from the live set whenever the two disagree. */
function reconcilePublicSseCounts() {
  let counted = 0;
  for (const count of publicSseByIp.values()) counted += count;
  if (counted === publicSseClients.size) return;
  publicSseByIp.clear();
  for (const client of publicSseClients) {
    const ip = client.__sseIp;
    if (!ip) continue;
    publicSseByIp.set(ip, (publicSseByIp.get(ip) || 0) + 1);
  }
}

app.get('/api/events', async (req, res, next) => {
  try {
    if (publicSseClients.size >= PUBLIC_SSE_MAX) {
      res.setHeader('Retry-After', '15');
      return res.status(503).json({ error: 'Too many live connections' });
    }
    const sseIp = registerPublicSse(req, res);
    if (!sseIp) {
      res.setHeader('Retry-After', '15');
      return res.status(429).json({ error: 'Too many live connections from this address' });
    }
    await Promise.all([maintenanceInitPromise, newsInitPromise, overrideInitPromise, experimentalInitPromise, streamWindowInitPromise]);
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
    res.write(`event: stream_window_update\ndata: ${JSON.stringify(publicStreamWindowState())}\n\n`);
    // Live count on connect, then pushed on every change.
    res.write(`event: presence\ndata: ${JSON.stringify(presencePayload())}\n\n`);
    res.write(`event: maintenance_update\ndata: ${JSON.stringify(publicMaintenanceState())}\n\n`);
    res.write(`event: news_update\ndata: ${JSON.stringify({ news: getPublicNewsItems() })}\n\n`);
    res.write(`event: experimental_update\ndata: ${JSON.stringify(publicExperimentalState())}\n\n`);

    req.on('close', () => {
      publicSseClients.delete(res);
      releasePublicSse(sseIp);
    });
  } catch (error) {
    next(error);
  }
});

// ─────────────────────────────────────────────
// ADMIN — STATIC FILES & AUTHENTICATION
// ─────────────────────────────────────────────

app.use('/admin', (req, res, next) => {
  if (isAdminIpAllowed(getClientIp(req))) return next();
  return res.status(404).json({ error: 'Not found' });
});

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

/* ── Admin login guard ────────────────────────────────────────────
   Three layers, because one shared password with no lockout is the single
   most attractive target on the service:

     1. per (IP + username) — 5 failures, then exponential lockout
        (15m, 30m, 1h … capped at LOGIN_MAX_LOCK_MS).
     2. per username — catches a distributed guesser rotating addresses;
        a wider allowance so a shared office NAT cannot lock the owner out.
     3. persisted best-effort to the durable store, so redeploying the
        service cannot clear an attacker's progress.

   Layer 1 only means anything because getClientIp() no longer reads
   client-supplied identity headers. */
const LOGIN_MAX_FAILURES = Math.max(1, Number.parseInt(process.env.LOGIN_MAX_FAILURES || '5', 10) || 5);
const LOGIN_BASE_LOCK_MS = Math.max(10_000, Number.parseInt(process.env.LOGIN_BASE_LOCK_MS || String(15 * 60_000), 10) || 15 * 60_000);
const LOGIN_MAX_LOCK_MS = Math.max(LOGIN_BASE_LOCK_MS, Number.parseInt(process.env.LOGIN_MAX_LOCK_MS || String(6 * 3_600_000), 10) || 6 * 3_600_000);
const LOGIN_USER_FAILURE_MULTIPLIER = Math.max(2, Number.parseInt(process.env.LOGIN_USER_FAILURE_MULTIPLIER || '4', 10) || 4);
const LOGIN_GUARD_REDIS_KEY = process.env.LOGIN_GUARD_REDIS_KEY || 'freef1:login-guard:v1';
const LOGIN_GUARD_FILE = path.join(DATA_DIR, 'login-guard.json');

const loginGuard = new Map(); // key -> { failures, lockedUntil, strikes, resetAt }
let loginGuardDirty = false;
let loginGuardPersistTimer = null;

function loginGuardKey(scope, value) {
  return `${scope}:${String(value || '').toLowerCase()}`;
}

function loginGuardEntry(key, now = Date.now()) {
  let entry = loginGuard.get(key);
  if (!entry) {
    entry = { failures: 0, lockedUntil: 0, strikes: 0, resetAt: now + LOGIN_BASE_LOCK_MS };
    loginGuard.set(key, entry);
  }
  return entry;
}

function loginLockRemaining(key, now = Date.now()) {
  const entry = loginGuard.get(key);
  if (!entry || !entry.lockedUntil || entry.lockedUntil <= now) return 0;
  return entry.lockedUntil - now;
}

function registerLoginFailure(scope, value, threshold) {
  const now = Date.now();
  const key = loginGuardKey(scope, value);
  const entry = loginGuardEntry(key, now);
  if (entry.resetAt <= now) { entry.failures = 0; entry.resetAt = now + LOGIN_BASE_LOCK_MS; }
  entry.failures++;
  if (entry.failures >= threshold) {
    entry.strikes++;
    entry.lockedUntil = now + Math.min(LOGIN_MAX_LOCK_MS, LOGIN_BASE_LOCK_MS * Math.pow(2, entry.strikes - 1));
    entry.failures = 0;
    entry.resetAt = entry.lockedUntil;
    console.warn(`[Security] Admin login locked for ${Math.round((entry.lockedUntil - now) / 1000)}s (${key}).`);
    // A lockout is the one state worth writing through immediately: it has to
    // outlive a redeploy, and the process could be recycled at any moment.
    loginGuardDirty = true;
    persistLoginGuard().catch(() => {});
    return entry;
  }
  loginGuardDirty = true;
  scheduleLoginGuardPersist();
  return entry;
}

function clearLoginFailures(scope, value) {
  const key = loginGuardKey(scope, value);
  if (loginGuard.delete(key)) {
    loginGuardDirty = true;
    scheduleLoginGuardPersist();
  }
}

function serializeLoginGuard() {
  const now = Date.now();
  const out = {};
  for (const [key, entry] of loginGuard) {
    if (entry.lockedUntil && entry.lockedUntil > now) out[key] = { lockedUntil: entry.lockedUntil, strikes: entry.strikes };
  }
  return out;
}

/* Persistence keeps a redeploy from resetting an attacker's lockout. Failures
   are swallowed: the in-memory guard must never be able to break login. */
async function persistLoginGuard() {
  loginGuardDirty = false;
  const payload = serializeLoginGuard();
  try {
    if (UNIQUE_VISITOR_REMOTE_ENABLED) {
      await storeRequest(['SET', LOGIN_GUARD_REDIS_KEY, JSON.stringify(payload), 'EX', 86_400]);
    } else {
      writeLocalJson(LOGIN_GUARD_FILE, payload);
    }
  } catch (_) { /* best effort */ }
}

function scheduleLoginGuardPersist() {
  if (loginGuardPersistTimer) return;
  loginGuardPersistTimer = setTimeout(() => {
    loginGuardPersistTimer = null;
    if (loginGuardDirty) persistLoginGuard().catch(() => {});
  }, 2_000);
  loginGuardPersistTimer.unref?.();
}

async function loadLoginGuard() {
  try {
    let stored = null;
    if (UNIQUE_VISITOR_REMOTE_ENABLED) {
      const payload = await storeRequest(['GET', LOGIN_GUARD_REDIS_KEY]);
      if (typeof payload?.result === 'string') stored = JSON.parse(payload.result);
    } else {
      stored = readLocalJson(LOGIN_GUARD_FILE);
    }
    if (!stored || typeof stored !== 'object') return false;
    const now = Date.now();
    for (const [key, entry] of Object.entries(stored)) {
      const lockedUntil = Number(entry?.lockedUntil);
      if (!Number.isFinite(lockedUntil) || lockedUntil <= now) continue;
      loginGuard.set(key, { failures: 0, lockedUntil, strikes: Number(entry?.strikes) || 1, resetAt: lockedUntil });
    }
    return true;
  } catch (_) {
    return false;
  }
}

function checkLoginLimit(req, res, next) {
  const now = Date.now();
  const ip = getClientIp(req);
  const username = String((req.body || {}).username || '').slice(0, 64);
  const ipKey = loginGuardKey('ip', `${ip}|${username}`);
  const userKey = loginGuardKey('user', username);

  const ipLock = loginLockRemaining(ipKey, now);
  const userLock = loginLockRemaining(userKey, now);
  const retryAfterMs = Math.max(ipLock, userLock);
  if (retryAfterMs > 0) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
    return res.status(429).json({ success: false, error: 'Too many login attempts. Try again later.' });
  }

  req.loginKeys = { ipKey, userKey, username };
  next();
}

app.use('/admin/api', sessionMiddleware);
app.post('/admin/api/login', checkLoginLimit, (req, res) => {
  const { username, password } = req.body || {};
  const keys = req.loginKeys || { ipKey: loginGuardKey('ip', getClientIp(req)), userKey: loginGuardKey('user', '') };
  if (safeEqual(username, ADMIN_USER) && safeEqual(password, ADMIN_PASS)) {
    clearLoginFailures('ip', `${getClientIp(req)}|${username}`);
    clearLoginFailures('user', username);
    req.session.isAdmin = true;
    req.session.loginAt = Date.now();
    return res.json({ success: true });
  }
  // Password comparison is a plain string compare; keep the failure path cheap
  // and non-revealing (no timing signal about which field was wrong).
  const ipEntry = registerLoginFailure('ip', `${getClientIp(req)}|${username}`, LOGIN_MAX_FAILURES);
  const userEntry = registerLoginFailure('user', username, LOGIN_MAX_FAILURES * LOGIN_USER_FAILURE_MULTIPLIER);
  const lockedFor = Math.max(ipEntry.lockedUntil - Date.now(), userEntry.lockedUntil - Date.now(), 0);
  if (lockedFor > 0) res.setHeader('Retry-After', String(Math.max(1, Math.ceil(lockedFor / 1000))));
  res.status(401).json({ success: false, error: 'Invalid credentials' });
});

/* Optional network allowlist for the whole dashboard (ADMIN_IP_ALLOWLIST=
   "41.13.0.0/16,102.132.7.9"). Empty = open, which is the documented default. */
const ADMIN_IP_ALLOWLIST = String(process.env.ADMIN_IP_ALLOWLIST || '')
  .split(',')
  .map(entry => entry.trim())
  .filter(Boolean);

function ipInCidr(ip, cidr) {
  const [range, bitsRaw] = cidr.split('/');
  const bits = Number.parseInt(bitsRaw, 10);
  const toInt = value => {
    const parts = value.split('.');
    if (parts.length !== 4) return null;
    let out = 0;
    for (const part of parts) {
      const n = Number(part);
      if (!Number.isInteger(n) || n < 0 || n > 255) return null;
      out = (out << 8) | n;
    }
    return out >>> 0;
  };
  const target = toInt(ip);
  const base = toInt(range);
  if (target === null || base === null || !Number.isFinite(bits)) return false;
  const mask = bits <= 0 ? 0 : (bits >= 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0);
  return (target & mask) === (base & mask);
}

function isAdminIpAllowed(ip) {
  if (!ADMIN_IP_ALLOWLIST.length) return true;
  return ADMIN_IP_ALLOWLIST.some(entry =>
    entry.includes('/') ? ipInCidr(ip, entry) : entry === ip);
}

function requireAdminOrigin(req, res, next) {
  if (!['POST', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const source = normalizeOrigin(req.headers.origin || req.headers.referer || '');
  if (PRODUCTION_MODE && !source) return res.status(403).json({ error: 'Missing request origin' });
  if (source && !isAllowedOrigin(req, source)) return res.status(403).json({ error: 'Forbidden' });
  next();
}

app.use('/admin/api', requireAdminOrigin, (req, res, next) => {
  if (req.path === '/admin/api/login') return next();
  if (!req.session || !req.session.isAdmin) return res.status(401).json({ error: 'Not authenticated' });
  req.session.lastSeen = Date.now();
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

app.get('/admin/api/experimental', async (req, res, next) => {
  try {
    await experimentalInitPromise;
    res.json({ success: true, experimental: publicExperimentalState(), durable: experimentalStoreReady });
  } catch (error) {
    next(error);
  }
});

app.post('/admin/api/experimental', async (req, res, next) => {
  try {
    await experimentalInitPromise;
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'The enabled field must be true or false.' });
    }

    applyExperimentalState({ enabled, updatedAt: Date.now() });
    const durable = await persistExperimentalState();
    const state = publicExperimentalState();
    broadcastSSE('experimental_update', state);
    broadcastPublicSSE('experimental_update', state);
    scheduleStatsBroadcast(0);

    res.json({ success: true, experimental: state, durable });
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

    const { type, embedUrl } = classifyStreamUrl(input, { rejectPrivateHosts: PRODUCTION_MODE });
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
    res.json({ ...storedSourceConfig(), durable: sourceStoreReady });
  } catch (error) {
    next(error);
  }
});

app.get('/admin/api/stream/window', async (req, res, next) => {
  try {
    await streamWindowInitPromise;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ streamWindow: publicStreamWindowState(), durable: streamWindowStoreReady });
  } catch (error) {
    next(error);
  }
});

app.post('/admin/api/stream/window', async (req, res, next) => {
  try {
    await streamWindowInitPromise;
    const { active, reason } = req.body || {};
    if (typeof active !== 'boolean') {
      return res.status(400).json({ error: 'The active field must be true or false.' });
    }
    const prevActive = streamWindowState.active;
    applyStreamWindowState({
      active,
      reason: active ? String(reason || '').trim().slice(0, 120) : '',
      startedAt: active ? (prevActive && streamWindowState.startedAt ? streamWindowState.startedAt : Date.now()) : null,
      updatedAt: Date.now()
    });
    const durable = await persistStreamWindowState();
    const state = broadcastStreamWindowState();
    res.json({ success: true, streamWindow: state, durable });
  } catch (error) {
    next(error);
  }
});

/* Playable targets, masked. The dashboard can see which feeds are playable and
   which provider host each points at — never the full URL, so a screenshot or a
   copied panel cannot leak the list. */
app.get('/admin/api/stream/targets', async (req, res, next) => {
  try {
    await streamTargetsInitPromise;
    res.setHeader('Cache-Control', 'no-store');
    res.json(maskedStreamTargets());
  } catch (error) {
    next(error);
  }
});

/* Rotation. Body: { targets: { "<sourceId>": "<url>" | null } }. Setting a URL
   replaces it for every future play AND every alias already handed out (the
   destination is resolved at redemption, not stored in the ticket), so a list
   that leaked can be killed by changing the target once. null removes it. */
app.post('/admin/api/stream/targets', async (req, res, next) => {
  try {
    await streamTargetsInitPromise;
    const body = req.body || {};
    const updates = body.targets;
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      return res.status(400).json({ error: 'Body must be { targets: { sourceId: url | null } }.' });
    }
    const next = {};
    for (const [id, entry] of streamTargets) next[id] = { url: entry.url };
    for (const [rawId, rawUrl] of Object.entries(updates)) {
      const id = String(rawId || '').trim().slice(0, 40);
      if (!FEED_SOURCE_IDS.has(id)) return res.status(400).json({ error: `Unknown source id: ${id}` });
      if (rawUrl === null) { delete next[id]; continue; }
      const url = String(rawUrl || '').trim();
      if (!validTargetUrl(url, { allowLoopback: process.env.NODE_ENV !== 'production' })) {
        return res.status(400).json({ error: `Target for ${id} must be an https URL (http is allowed for loopback in development).` });
      }
      next[id] = { url };
    }
    applyStreamTargets(next);
    const durable = await persistStreamTargets();
    res.json({ success: true, ...maskedStreamTargets(), durable });
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
    await Promise.all([overrideInitPromise, newsInitPromise, sourceInitPromise, maintenanceInitPromise, experimentalInitPromise, streamWindowInitPromise]);
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
  res.write(`event: stream_window_update\ndata: ${JSON.stringify(publicStreamWindowState())}\n\n`);
  res.write(`event: news_update\ndata: ${JSON.stringify({ news: getAdminNewsItems(), durable: newsStoreIsDurable() })}\n\n`);
  res.write(`event: sources_update\ndata: ${JSON.stringify(storedSourceConfig())}\n\n`);
  res.write(`event: experimental_update\ndata: ${JSON.stringify(publicExperimentalState())}\n\n`);

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
      discordInvite: DISCORD_INVITE_URL,
      ownerId: process.env.DISCORD_OWNER_ID || '',
      readLocalJson,
      writeLocalJson,
      storeCommand: UNIQUE_VISITOR_REMOTE_ENABLED ? storeRequest : null,
      storeProvider: REMOTE_STORE_LABEL,
      redisKey: 'freef1:discordbot:v1',
      fileKey: path.join(DATA_DIR, 'discord-bot.json'),
      // Lets /link and /unlink act on the same link table the API reads.
      discordLink,
      log: (...a) => console.log('[Bot]', ...a),
    });
    /* Now there is a client, hand the store its announcer so link and unlink
       events reach #links. Logged because it is the one piece of the chain
       with no other symptom when it is missing: links still work, the channel
       just stays silent. */
    if (discordBot && typeof discordBot.announceLink === 'function') {
      linkEventSink = discordBot.announceLink;
      console.log('[DiscordLink] announcement channel wired to the bot');
    } else {
      console.log('[DiscordLink] bot has no announceLink — #links will stay silent');
    }
  } catch (error) {
    console.error('[Bot] failed to start:', error.message);
  }
} else {
  console.log('[Bot] Discord bot disabled (DISCORD_BOT_TOKEN not set)');
}

// Restore any persisted login lockout before the first request can be served,
// so redeploying does not hand a guesser a clean slate.
loadLoginGuard().catch(() => {});

const server = app.listen(PORT, () => {
  console.log(`[Server] Running on http://localhost:${PORT}`);
  console.log(`[Server] Trusted proxy hops: ${TRUST_PROXY_HOPS}${TRUST_PROXY_HOPS === 0 ? ' (no proxy: socket address is the client)' : ''}`);
  console.log(`[Server] Client IP header: ${CLIENT_IP_HEADER || 'off (X-Forwarded-For only)'}`);
  console.log(`[Main]  Site:  http://localhost:${PORT}/  (${DEV_DIR})`);
  console.log(`[Admin] Panel: http://localhost:${PORT}/admin  (${ADMIN_DIR})`);
  console.log(`[Visitors] Unique store: ${UNIQUE_VISITOR_REMOTE_ENABLED ? `${REMOTE_STORE_LABEL} (durable)` : 'local file/memory (ephemeral on Render)'}`);
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
  if (!process.env.UNIQUE_VISITOR_HASH_SECRET) {
    console.warn('[Visitors] UNIQUE_VISITOR_HASH_SECRET is not set, so visitor hashes fall back to VISITOR_SECRET — rotating it will reset the all-time unique total. Set an independent value.');
  }
  if (ADMIN_IP_ALLOWLIST.length) {
    console.log(`[Security] Admin dashboard restricted to ${ADMIN_IP_ALLOWLIST.length} address range(s).`);
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
  if (storeResyncTimer) clearInterval(storeResyncTimer);
  if (loginGuardPersistTimer) clearTimeout(loginGuardPersistTimer);
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
  // Login lockouts must survive the restart a redeploy performs.
  const guardFlush = loginGuardDirty ? persistLoginGuard().catch(() => false) : Promise.resolve();
  server.close(async () => {
    await Promise.allSettled([...pendingUniqueWrites.values(), finalFlush, botFlush, guardFlush]);
    try { await durableStore.close(); } catch (_) {}
    try { discordBot?.stop?.(); } catch (_) {}
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
