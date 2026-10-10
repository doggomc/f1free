# Audience Analytics

Aggregated, anonymous usage statistics for the admin dashboard
(`/admin` → "Audience · Analytics" section under the existing panels).

## What is stored

Only counters. No IP addresses, visitor IDs, user-agent strings or timestamps of
individual visits are ever written.

| Granularity | Retention | Content |
| --- | --- | --- |
| Per minute | 24 hours | concurrent viewers (`live` series) |
| Per hour | 14 days | one bucket per hour (see fields below) |
| Per day | 90 days | one bucket per UTC day |

Bucket fields: `sessions, ended, durationMs, durHist[6], newVisitors, returning,
pageViews, peakOnline, onlineSum, onlineSamples, device{}, browser{}, os{},
country{}, pages{}, source{}, team{}, fullscreen, nostream, streamReady,
streamReadyMs, streamTimeout`. Breakdown maps are capped (e.g. 24 browsers,
250 countries); overflow goes to `Other`. Browsers/OS are stored as families
("Chrome", "Android"), not versions.

## Where it is stored

Same rule as news and maintenance state:

* Upstash configured → Redis hash `freef1:analytics:v1`
  (`ANALYTICS_REDIS_KEY` to change). Fields: `h:<hourIndex>`, `d:<YYYY-MM-DD>`,
  `live`, `meta`. Roughly 40 KB at full retention.
* Otherwise → `data/analytics.json` (lost on Render redeploys without a disk).

Writes are batched: every minute while sessions/events are changing, every
5 minutes when only the minute sampler is running, and once more on `SIGTERM`.

## How a session is measured

* A session **starts** on the first `/api/visitors/heartbeat` from a browser
  (plain page hits from crawlers never count).
* It **ends** when no heartbeat arrives for `HEARTBEAT_TIMEOUT_MS` (60 s);
  duration = last heartbeat − first heartbeat. Open sessions are shown
  separately as "open now" and are not in the averages until they close.
* "New" vs "returning" uses the existing unique-visitor set (first time the
  hashed visitor key is seen anywhere → new).
* Country is attributed when the existing geo lookup resolves; geo is
  looked up per IP exactly as before and is not stored per session.

## Viewer events

The public site sends small fire-and-forget beacons to
`POST /api/visitors/event` (same signed visitor token and per-IP rate limit
as the heartbeat; the body is reduced to whitelisted counters):

| `type` | `value` | Counted as |
| --- | --- | --- |
| `view` | `/`, `/news`, `/info` | page view (anything else → `/other`) |
| `source` | feed label, e.g. `F1TV` | feed source picked (user clicks only) |
| `team` | livery id, e.g. `mclaren` | livery picked |
| `fullscreen` | — | player entered fullscreen |
| `stream_ready` | ms from load to first paint | player load OK (+ time) |
| `stream_timeout` | — | player did not load within 5 s |
| `nostream` | — | "no stream right now" card shown |

The heartbeat carries the current path as `?page=` so the active-sessions
table and the Pages chart agree.

## Endpoints

* `GET /admin/api/analytics` (admin session) → full snapshot for the dashboard
* `POST /api/visitors/event` (visitor token) → `204`, `400` unknown type,
  `403` bad token, `429` rate-limited

## Environment variables (all optional)

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANALYTICS_REDIS_KEY` | `freef1:analytics:v1` | Redis hash name |
| `ANALYTICS_HOURLY_RETENTION_HOURS` | `336` (14 d) | hourly bucket retention |
| `ANALYTICS_DAILY_RETENTION_DAYS` | `90` | daily bucket retention |
| `ANALYTICS_FLUSH_MS` | `60000` | flush cadence while active |
| `ANALYTICS_IDLE_FLUSH_MS` | `300000` | flush cadence while idle |

## Files

* `server.js` — "AUDIENCE ANALYTICS" block (collection, storage, snapshot) and
  the two routes above
* `admin/charts.js` — dependency-free SVG chart primitives (CSP `script-src 'self'` safe)
* `admin/analytics.js` — data folding per range, KPIs, CSV export, auto-refresh
* `admin/index.html` / `admin/admin.css` — the section markup and styles

## Privacy policy note

The public Privacy Policy currently describes "short-lived operational
telemetry". With this feature, aggregated anonymous counters are retained for
up to 90 days; the policy wording should be updated to say so.
