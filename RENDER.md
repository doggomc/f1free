# Render environment (f1free)

Analytics, unique visitors, news and maintenance **reset on every rebuild** unless Redis is configured. Render’s disk is ephemeral.

## Required (production will refuse to boot without these)

| Key | What it is |
| --- | --- |
| `NODE_ENV` | `production` |
| `ADMIN_USER` | Admin dashboard login |
| `ADMIN_PASS` | Long random password |
| `ADMIN_SECRET` | 64 hex chars — signs the admin cookie |
| `VISITOR_SECRET` | Random string — signs visitor heartbeat tokens |
| `UNIQUE_VISITOR_HASH_SECRET` | Random string — unique-visitor identity. **Do not rotate** or the all-time count resets |
| `AUTHORIZED_DOMAIN` | `freef1.netlify.app` |
| `ALLOWED_ORIGIN` | `https://freef1.netlify.app` |
| `TRUST_PROXY_HOPS` | `1` on Render (`2` if Cloudflare sits in front) — see below |
| `UPSTASH_REDIS_REST_URL` | Upstash REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash REST token |
| `STREAM_TARGETS_JSON` | **Optional** override for where each feed plays — see below. The repo already ships the addresses in `data/stream-targets.json`, so a fresh deploy plays with no host configuration at all |
| (nothing else) | The API permission needs no configuration: `/api` is closed by default and the site mints its own ticket |

Create the Redis DB: [Upstash](https://console.upstash.com/) → Redis → Create → copy **REST URL** and **REST TOKEN**.

### The feed addresses — shipped in the repo, not in the site

The site's JavaScript is public: anything in it can be copied in one request.
So it no longer contains a single feed address. It holds ids and labels, asks
this server for a short-lived signed alias at play time (`/api/stream/ticket` →
`/stream/<ticket>`), and this server — which is where the addresses actually
live — redirects the alias to the current target. Two consequences worth
knowing:

* rotating a feed is one value in the file (or one call to
  `POST /admin/api/stream/targets`), and **every alias already handed out
  follows the new target** — a list somebody copied last week is worthless;
* a value that is missing or wrong makes that feed show as unavailable, because
  there is no longer a hardcoded fallback in the browser.

The addresses travel with the backend in `data/stream-targets.json`, which is
committed on purpose (it is the one exception to the `data/*` ignore rule).
Deploy the repo and it plays — there is nothing to configure on the host. The
override below is only for rotating an address without touching the repo.

```jsonc
STREAM_TARGETS_JSON={
  "sky-sports-f1": "https://…/embed/44.php",
  "westream":     "https://…/westreamf1.php",
  "sky-uk-2":     "https://…/shopping2/?channel_id=sky_sport_f1_uk",
  "sky-uk":       "https://…/embed/racing/skyf1",
  "f1tv":         "https://…/embed/f1/{season}/{eventSlug}/{sessionSlug}",
  "appletv":      "https://…/embed/admin/{eastSlug}/3",
  "dazn":         "https://…/embed/admin/{eastSlug}/5",
  "wikisport":    "https://…/strm/f1.php"
}
```

Values must be `https` (production refuses plain `http`; `http://127.0.0.1/…` is
accepted off production so tests can point at a stub). The placeholders —
`{season}`, `{eventSlug}`, `{sessionSlug}`, `{eastSlug}` — are filled from the
session on screen, and each one is validated by shape before it is substituted,
so a client cannot steer a redirect anywhere else. The ids are the eight above;
a build that renames one simply stops receiving a target for it.

The file is read from `DATA_DIR`, which defaults to `data/` inside the repo, so
a Render deploy picks it up as-is. One caveat comes with committing it: the
addresses are now in the repo's history, and they are exactly as private as the
repository is. If the repository is public, keep them in `STREAM_TARGETS_JSON`
instead — that variable wins over the file, so a real secret stays out of git.

Related tuning: `STREAM_TICKET_TTL_MS` (alias lifetime, default 1h),
`STREAM_TICKET_RATE_MAX` (aliases per address per hour, default `120`),
`STREAM_TICKETS=false` (refuse every alias while swapping providers).

### The API is closed by default

Everything under `/api` now needs a **site ticket**: `POST /api/site/ticket` →
`{ ticket, expiresAt }`, minted only for a request carrying the site's own
authorized `Origin`/`Referer` (a browser on the site), budgeted per address
(60/hour). The page asks once per session, keeps it, and presents it as
`X-Site-Ticket` — in `?ticket=` for `/api/events`, since an EventSource cannot
set headers. A clone or a script has no ticket, so it gets `403` instead of your
news, standings, schedule timing or feed list.

Free of the gate, on purpose:

| path | why |
| --- | --- |
| `/api/site/status` · `/api/auth/verify` | the page must be able to learn it is in maintenance *before* it can hold a ticket |
| `/api/stream/ticket` · `/api/visitors/token` | they *are* permissions (own origin gate + budget) |
| `/api/visitors/heartbeat` · `/event` · `/leave` | carry a signed visitor token, minted the same way |

**Two knobs, and one escape hatch:**

* `SITE_TICKET_TTL_MS` — how long a permission lasts (default 6h; the page
  refreshes before it expires).
* `SITE_TICKET_RATE_MAX` — mints per address per hour (default `60`).
* `SITE_TICKETS=false` — switch the whole gate off instantly, without touching
  the site. Use it if a deploy ever goes out in the wrong order (below).

### `TRUST_PROXY_HOPS` — do not skip this

Every rate limit, the admin login lockout and the unique-visitor budget key off
the client IP. The server only trusts as many proxy hops as this says, which is
what makes that IP unforgeable:

| Topology | Value |
| --- | --- |
| Render alone (current) | `1` (default in production) |
| Cloudflare → Render | `2` |
| Local dev / direct | `0` |

Get it wrong the other way — larger than reality — and `X-Forwarded-For` becomes
client-controlled again, which is exactly how the login limiter used to be
bypassable with one header. If you put a CDN in front, raise this in the same
change. Log line at boot: `[Server] Trusted proxy hops: N`.


Do **not** set `DEV_DIR` to the API repo root. Leave it unset on Render (the public site is on Netlify).

## Optional

| Key | What it is |
| --- | --- |
| `UNIQUE_VISITOR_BASELINE` | Add once if you know the old unique-visitor total |
| `DISCORD_BOT_TOKEN` | Bot token; omit to run with no bot |
| `DISCORD_GUILD_ID` | Instant slash-command register |
| `DISCORD_OWNER_ID` | Your Discord user id (bot will not start without this if the token is set) |
| `DISCORD_INVITE` | `https://discord.gg/...` |
| `SITE_URL` | `https://freef1.netlify.app` |
| `OPENF1_API_KEY` | Optional OpenF1 key |
| `FREEF1_AUDIO_URL` | Default `/watchparty` audio URL |
| `PUBLIC_SSE_MAX` | Default `400` (global); `PUBLIC_SSE_MAX_PER_IP` defaults to `4` |
| `ADMIN_IP_ALLOWLIST` | Optional: exact IPs / IPv4 CIDRs allowed to reach `/admin`. Everyone else gets a 404 |
| `ADMIN_PASS_MIN_LENGTH` | Default `12` — production refuses to boot below it |
| `LOGIN_MAX_FAILURES` / `LOGIN_BASE_LOCK_MS` / `LOGIN_MAX_LOCK_MS` | Login lockout tuning (5 failures, 15m doubling to a 6h cap) |
| `NEW_IDENTITY_BUDGET_PER_IP_HOUR` | Max new visitor identities one address adds to the all-time total per hour (default `60`) |
| `JOLPI_MAX_PER_MINUTE` | Shared upstream budget for the free Jolpica API (default `120`) |
| `OPENF1_CACHE_MAX` / `OPENF1_SNAPSHOT_MAX` / `CAREER_CACHE_MAX` | LRU cache ceilings (defaults `400` / `400` / `200`) |
| `OPENF1_SNAPSHOT_WRITES_PER_DAY` | Durable OpenF1 snapshot writes per day (default `2000`) |

Generate hex secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Run that three times for `ADMIN_SECRET`, `VISITOR_SECRET`, `UNIQUE_VISITOR_HASH_SECRET`.

Always set `UNIQUE_VISITOR_HASH_SECRET` explicitly: without it visitor hashes
fall back to `VISITOR_SECRET`, so rotating that secret resets the all-time
unique total (the boot log warns about this).

## Testing the deploy

```bash
npm run check            # full gate: syntax, unit, browser, site, admin, security, relay
npm run check:security   # abuse-resistance only (rate limits, lockout, origin gate)
```

`npm run check:site` reads `../netlifyf1` by default — set `SITE_DIR` if the
site lives elsewhere. The relay check prints `skip` when the optional voice
packages are absent, so a skip is never mistaken for a pass.
