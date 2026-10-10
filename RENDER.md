# Render deployment

`render.yaml` is the production definition. It is tuned for one 512 MB Render
web service and a small monthly egress allowance:

- one Node process with a 384 MB old-space ceiling;
- production-only dependencies (`npm ci --omit=dev --omit=optional`);
- no ffmpeg/native voice packages;
- no HLS/media relay routes (the retired routes return a tiny `410`);
- provider-hosted stream targets are redirects, so media never crosses Render;
- 1,200 public SSE connections by default, capped at 2,000;
- geolocation is off by default in the Blueprint;
- `/readyz` is the Render readiness check; `/healthz` remains a lightweight
  process-liveness endpoint.

## 1. Create the service

Use **New → Blueprint** in Render and select this repository. The Blueprint
asks for values marked `sync: false`.

Required values:

| Key | Value |
| --- | --- |
| `ADMIN_USER` | A non-default admin name |
| `ADMIN_PASS` | A random password of at least 12 characters |
| `REDIS_URL` | A TLS Redis/Valkey connection URL (recommended: a free Redis Cloud database) |

The Blueprint generates `ADMIN_SECRET`, `VISITOR_SECRET`,
`UNIQUE_VISITOR_HASH_SECRET`, and `SELFCHECK_TOKEN`. Do not rotate
`UNIQUE_VISITOR_HASH_SECRET`: it defines the anonymous all-time visitor hashes.
Production refuses blank, short, default, or obvious placeholder secrets.

If configuring the service manually instead of using the Blueprint, copy
[`render.env.example`](render.env.example), fill its blank values, and import it
through **Render → Environment → Add from .env**. Generate each secret separately:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Do not set `PORT` or `RENDER`; Render supplies both.

The production process refuses to start if the admin secrets or durable store
are missing. Render's filesystem is ephemeral, so silently falling back to a
local JSON file would lose analytics, settings, and visitor totals on deploy.

### Existing Upstash deployment

The application now prefers the provider-neutral `REDIS_URL`. The legacy
Upstash REST variables still work during migration; `REDIS_URL` wins if both are
present.

Inventory the old database without writing anything:

```bash
UPSTASH_REDIS_REST_URL='https://…' \
UPSTASH_REDIS_REST_TOKEN='…' \
REDIS_URL='rediss://…' \
npm run migrate:redis
```

Then copy all `freef1:*` strings, sets, hashes, and expirations:

```bash
UPSTASH_REDIS_REST_URL='https://…' \
UPSTASH_REDIS_REST_TOKEN='…' \
REDIS_URL='rediss://…' \
npm run migrate:redis -- --apply
```

Deploy with only `REDIS_URL`. Keep the old database until `/readyz` returns
`200`, `/healthz` reports `"redis"` for all stores, and the admin analytics are
present.

## 2. Environment details

The Blueprint supplies the normal values:

| Key | Blueprint value |
| --- | --- |
| `NODE_ENV` | `production` |
| `NODE_OPTIONS` | `--max-old-space-size=384` |
| `TRUST_PROXY_HOPS` | `1` (Render's router) |
| `CLIENT_IP_HEADER` | `cf-connecting-ip` |
| `AUTHORIZED_DOMAIN` | `freef1.netlify.app` |
| `ALLOWED_ORIGIN` | `https://freef1.netlify.app` |
| `SITE_URL` | `https://freef1.netlify.app` |
| `PUBLIC_SSE_MAX` | `1200` |
| `PUBLIC_SSE_MAX_PER_IP` | `32` |
| `SSE_HEARTBEAT_MS` | `25000` |
| `PRESENCE_TTL_MS` / `HEARTBEAT_TIMEOUT_MS` | `270000` / `270000` |
| `PRESENCE_LEAVE_GRACE_MS` | `125000` |
| `STREAM_TICKETS` / `SITE_TICKETS` | `true` / `true` |
| `GEO_ENABLED` | `false` |

Set `TRUST_PROXY_HOPS=2` only if another reverse proxy is placed in front of
Render. Setting it higher than the real proxy count makes client-address rate
limits forgeable; setting it lower makes viewers share the router's address.

Useful optional values:

| Key | Purpose |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Enables the companion bot |
| `DISCORD_GUILD_ID` / `DISCORD_OWNER_ID` | Bot scope and owner commands |
| `DISCORD_INVITE` | Public invite URL |
| `OPENF1_API_KEY` | Raises upstream OpenF1 limits |
| `ADMIN_IP_ALLOWLIST` | Comma-separated exact IPv4/CIDR admin allowlist |
| `STREAM_TARGETS_JSON` | Overrides the shipped provider redirect targets |
| `STREAM_TICKETS=false` | Emergency playback kill switch |
| `SITE_TICKETS=false` | Emergency API-gate escape hatch |

Do not set `DEV_DIR` in production. The public site belongs on Netlify; serving
its assets from Render would spend the limited Render bandwidth.

## 3. Deploy the matching Netlify client

This checkout cannot commit to the separate `doggomc/netlifyf1` repository, so
its tested client change is provided as an apply-ready patch:

```bash
cd /path/to/netlifyf1
git apply /path/to/f1free/patches/netlifyf1-scale.patch
git diff --check
```

The patch:

- removes the retired `cdnlivetv-f1` and `strmfree-f1` buttons;
- moves capacity values into `runtime-config.js`;
- changes visible-tab presence from 15 seconds to 120 seconds;
- requests a bodyless `204` heartbeat acknowledgement because SSE carries counts;
- changes fallback polling from 30 seconds to 120 seconds (SSE remains live);
- gives versioned JS/CSS/assets immutable browser caching;
- adds a zero-build `netlify.toml`.

The server's 270-second presence window tolerates one lost two-minute heartbeat.
The 125-second shared-browser leave grace lets another tab send its next beat;
a page's final leave beacon still removes it without waiting for the full
presence window.

Deploy order: **Render first, Netlify second**. The backend already reports the
old relay IDs disabled, so an older cached client cannot reactivate them.

## Capacity model

At 1,000 visible browsers:

- two-minute heartbeats average about 8.3 requests/second instead of about 67;
- successful heartbeat responses have no body; the SSE connection carries counts;
- one SSE socket per browser replaces six 30-second polling loops;
- one shared 25-second SSE keepalive timer avoids 1,000 per-client timers;
- only small JSON/SSE/ticket responses cross Render;
- static HTML, JS, CSS, fonts, and images are served by Netlify's CDN;
- stream media is fetched from the configured provider after a `302` redirect.

At the deliberately pessimistic assumption of 1,000 SSE connections open all
month, the 13-byte keepalive payload is about 1.35 GB/month before transport
framing; normal usage is lower because 1,000 is a peak, not a permanent floor.
Bodyless heartbeats leave most of the 5 GB allowance for framing, headers, state
changes, and deploy traffic. Monitor Render's measured outbound bandwidth: no
application estimate can include provider-specific proxy framing exactly.

The API strips document-only headers from high-frequency responses and sends
CORS negotiation headers only on preflights. This reduces recurring egress
without weakening document CSP.

The final local 1,000-client simulation (`npm run check:load`) opened all SSE
sockets in 0.96 s, completed 1,000 signed heartbeats in 1.15 s, and measured
133.2 MiB RSS (68.5 MiB baseline, +64.7 MiB). Treat this as a repeatable
capacity regression check, not a substitute for Render's production metrics.

## Verification

Run the full cross-repository gate before deploying:

```bash
SITE_DIR=/path/to/netlifyf1 npm ci
SITE_DIR=/path/to/netlifyf1 npm run check
```

After deployment:

```bash
curl -fsS https://freef1.onrender.com/healthz
curl -fsS https://freef1.onrender.com/readyz
curl -fsS "https://freef1.onrender.com/selfcheck?token=$SELFCHECK_TOKEN"
```

`/readyz` must return HTTP 200 with `durableReady` and `targetsReady` both true.
`/healthz` must report `redis`, not `redis-connecting`, `file`, or `memory`.
The self-check verifies Redis and the target catalog, confirms that self-hosted
relays are retired, and intentionally does not proxy or probe media.
