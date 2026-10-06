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

Create the Redis DB: [Upstash](https://console.upstash.com/) → Redis → Create → copy **REST URL** and **REST TOKEN**.

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
