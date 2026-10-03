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
| `UPSTASH_REDIS_REST_URL` | Upstash REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash REST token |

Create the Redis DB: [Upstash](https://console.upstash.com/) → Redis → Create → copy **REST URL** and **REST TOKEN**.

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
| `PUBLIC_SSE_MAX` | Default `400` |

Generate hex secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Run that three times for `ADMIN_SECRET`, `VISITOR_SECRET`, `UNIQUE_VISITOR_HASH_SECRET`.
