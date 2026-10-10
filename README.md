# FreeF1 service

Express API, admin dashboard, analytics, stream-target redirects, and optional
Discord companion for `freef1.netlify.app`.

The public website is a separate repository: `doggomc/netlifyf1`. This checkout
contains the tested cross-repository patch at
[`patches/netlifyf1-scale.patch`](patches/netlifyf1-scale.patch).

## Architecture

`server.js` is the composition root and route registry. Reusable functions are
split by responsibility:

| Module | Responsibility |
| --- | --- |
| `lib/durable-store.js` | Redis/Valkey and legacy Upstash transports |
| `lib/client-ip.js` | Proxy-safe client address resolution |
| `lib/origin-policy.js` | CORS/origin/Netlify-preview policy |
| `lib/site-paths.js` | Static-site/admin directory discovery |
| `lib/stream-catalog.js` | Feed IDs and target validation |
| `lib/stream-url.js` | Safe override URL classification |
| `lib/tickets.js` | Signed stream and site tickets |
| `lib/user-agent.js` | Browser/OS/device classification |
| `lib/discord-link.js` | Discord account-link state |

Stateful services (presence, analytics, news, maintenance, stream controls) stay
in the composition root because they share live maps and SSE broadcasts. Route
handlers are grouped by public/admin concern rather than placed one function per
file; a file per tiny callback would increase coupling without creating a usable
module boundary.

## Run

```bash
npm ci
npm start
```

Local development can use JSON files in `DATA_DIR`. Production requires a
remote durable store and strong secrets; see [RENDER.md](RENDER.md).

## Test

```bash
SITE_DIR=/path/to/netlifyf1 npm run check
```

The gate covers syntax, module contracts, target parity, integration routes,
presence, browser behavior, maintenance fit, security, CSP, admin DOM, and the
permanent relay shutdown. Run the heavier local capacity regression separately:

```bash
npm run check:load # defaults to 1,000 SSE clients + signed heartbeats
```

## Deployment

- Render: deploy [`render.yaml`](render.yaml); for manual setup import
  [`render.env.example`](render.env.example) after filling its blank secrets.
- Netlify: apply [`patches/netlifyf1-scale.patch`](patches/netlifyf1-scale.patch)
  in the `netlifyf1` checkout and deploy it.
- Durable state: set `REDIS_URL`; use `npm run migrate:redis -- --apply` to move
  an existing Upstash database.

Self-hosted HLS relays are retired. `/relay/*` and `/vendor/hls.min.js` return
`410 Gone`, and the API will not issue a ticket for either former relay ID.
