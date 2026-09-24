# Streaming the race into Discord — what is actually possible

**Short version:** a Discord bot **cannot** stream video into a voice channel. That
is a hard platform limitation, not a missing library. It **can** stream *audio*,
and it can drive a *Discord Activity* (an official in-app web app) that plays
video. Those are the two legitimate routes, and this repo now implements the
audio one.

---

## 1. The hard constraint: bots cannot Go Live

Discord's "Go Live / screen share" is a **client** feature. There is no API
endpoint for it, and bot tokens are blocked from sending video on the voice
gateway.

- Discord staff have stated they will not support video sending for bots; the
  long-running feature request in the API docs repo is closed
  ([discord/discord-api-docs #3234][gh-3234]).
- The `Video` / `STREAM` permission bit exists on the OAuth screen purely for
  completeness — granting it to a bot changes nothing
  ([same discussion][gh-3234]).
- Discord's own help centre documents Go Live purely as a user action
  ("Join a voice channel → tap the Screen streaming icon")
  ([Discord Support: Go Live and Screen Share][discord-golive]).

### The tempting workaround, and why not to ship it

There *is* working reverse-engineered video code —
[`@dank074/discord-video-stream`][dank074] can push a Go Live or webcam feed via
RTP/RTX. Its own README answers the key question:

> **Does this library work with bot tokens?**
> No, Discord blocks video from bots which is why this library uses a selfbot
> library as peer dependency. You must use a user token.

Using a user token to automate an account ("self-bot" / "user bot") breaches
Discord's Terms of Service, and the account gets disabled
([r/Discord_Bots discussion][reddit-bots], [r/discordapp thread][reddit-app]).
For a public community server this is an unacceptable risk — you would be
betting the owner's account and the server on it. **Not recommended.**

---

## 2. Route A — audio relay into a voice channel ✅ implemented here

Fully supported, no ToS risk, no privileged intents. This is exactly what every
music bot does.

**How it works**

```
race audio URL (HTTP / HLS / m3u8 / MP3)
        │
        ▼
   ffmpeg  ──► 48 kHz stereo Opus
        │
        ▼
 @discordjs/voice  ──►  voice gateway  ──►  everyone in the channel hears it
```

**Requirements** (all optional dependencies, already added to `package.json`)

| Package | Why |
| --- | --- |
| `@discordjs/voice` | voice connection + audio player |
| `@discordjs/opus` | Opus encoder/decoder |
| `ffmpeg-static` | transcodes any source to Opus (or install ffmpeg on PATH) |

**Intents:** add `GatewayIntentBits.GuildVoiceStates` — **not** a privileged
intent, so no verification is needed. The bot should be invited with the
`Connect` and `Speak` permissions.

**What the race-day experience looks like**

1. Members join the *Race Control* voice channel — they hear live commentary.
2. The scheduler / `/live` embeds keep posting the **Watch on APEX** button, so
   video stays on the site where it belongs (and where the ad-layer containment
   in `app.js` is already handling tab-swap hijacks).
3. Audio in Discord, picture on the site. Nobody has to fight a video
   permission that does not exist.

**Choosing an audio source** — needs a *direct* audio URL, not an `<iframe>`
page. Good options:

- **OpenF1 team radio.** The `team_radio` endpoint returns `recording_url`
  MP3s, and this server already proxies OpenF1 at `/api/openf1/team_radio`
  (cached, rate-limit-safe, snapshot-protected). Ideal for a
  "pit-wall" listening party.
- **A commentary / radio stream** you have rights to relay.
- **Anything ffmpeg can open**, passed straight to the command.

Set a default with `APEX_AUDIO_URL`, or pass one per command.

**Commands added**

```
/watchparty start [channel:<voice>] [audio:<url>]   owner only
/watchparty stop                                    owner only
/watchparty status                                  owner only
```

State is persisted (file locally / Upstash in production), so a redeploy
mid-session resumes the relay automatically.

**Verification:** `npm run relay` generates a local tone, serves it over HTTP,
runs the relay's exact ffmpeg argument list and asserts the output is decodable
48 kHz stereo Opus at valid Opus packet boundaries. It skips itself when the
optional packages are absent.

**Caveats**

- One relay per guild; relays are per-process (fine on a single Render
  instance, needs coordination if you ever scale out).
- Re-encoding costs CPU while people are in the channel. On Render's
  free/Starter tiers, expect ~5–10 % of a vCPU for a single 96 kbps Opus
  stream. An empty room pauses the player; ffmpeg blocks on the full pipe
  and that cost drops to ~0 until someone rejoins.
- Discord rate-limits voice connection churn. A source that ends (every
  chequered flag) is retried up to 5 times, backing off 2 s × attempt.
  The budget is persisted, so a redeploy mid-retry cannot reset it and
  loop. After that it gives up, forgets the saved relay, and you re-run
  `/watchparty start`.

---

## 3. Route B — a Discord Activity with video (the only official video path)

Discord **Activities** are embedded web apps launched from inside a voice
channel. They are the mechanism behind the built-in *Watch Together*, and a
**custom** Activity can play whatever you can render in a browser — including an
HLS stream via `hls.js`.

- Activities run in an iframe inside the Discord client; you build them with the
  **Embedded App SDK** and register the app as an Activity in the Developer
  Portal ([Discord Activities overview][activities-guide]).
- The built-in YouTube *Watch Together* needs **Server Boost level 1** and can
  only be *hosted* from desktop or browser — mobile can join but not start
  ([Watch Together notes][watch-together], [Fandom][fandom-wt]).

**Pros:** synchronised video *inside* Discord; no ToS problem; you control the
player.

**Cons:** real work — OAuth2 + SDK integration, an externally hosted iframe app
(another deployment to keep alive), app review/approval for distribution, and
mobile support is limited. Also worth being honest about the DMCA posture: your
own Terms already state the site does not host or broadcast anything and only
links to third-party embeds. Rendering an HLS feed inside an Activity is *you*
distributing the picture, not just linking to it — a materially different legal
position from what the site does today.

**Verdict:** the right call if you want video in Discord and are willing to own
another app. Say the word and it can be scaffolded.

---

## 4. Route C — link embeds + scheduled alerts (what the bot already did)

Not "streaming", but it is what actually gets people to a race:

- `STARTING SOON` embed (amber) at the configured lead time, with a role ping.
- The same message **edits itself** into `LIVE NOW` (green) at lights-out,
  then into `ENDED` (red) at the chequered flag — one message, no channel
  spam, deduped through the durable store.
- `/website`, `/live`, `/config`, `/status`. Supporter roles and stream
  alerts are button toggles; already-posted reaction panels still work.

Keep this. It is the highest value-per-byte feature in the bot.

---

## 5. Recommendation

| Goal | Do this |
| --- | --- |
| Get race audio into the server now | **Route A** — implemented, `npm i` the optional deps, set `APEX_AUDIO_URL`, `/watchparty start` |
| Video *inside* Discord | **Route B** — a custom Activity; larger build, and review your DMCA posture first |
| Video where it already works | **Route C** — keep the embeds; the site's player is the video surface |
| Anything involving a user token | **Don't.** ToS violation, account ban risk |

---

### Sources

- [Discord API Docs discussion #3234 — "Bots to use Go Live" (staff: not supported)][gh-3234]
- [Discord Support — Go Live and Screen Share (user-only flow)][discord-golive]
- [`@dank074/discord-video-stream` — "Does this library work with bot tokens? No."][dank074]
- [r/Discord_Bots — bots cannot use Go Live][reddit-bots]
- [r/discordapp — API doesn't support bots streaming video; only audio][reddit-app]
- [Discord Activities / Watch Together overview][activities-guide]
- [Watch Together requirements (Boost level 1, desktop-only hosting)][watch-together]
- [Watch Together reference][fandom-wt]

[gh-3234]: https://github.com/discord/discord-api-docs/discussions/3234
[discord-golive]: https://support.discord.com/hc/en-us/articles/360040816151-Go-Live-and-Screen-Share
[dank074]: https://github.com/Discord-RE/Discord-video-stream
[reddit-bots]: https://www.reddit.com/r/Discord_Bots/comments/evbcaz/is_it_possible_to_have_a_bot_livestream_in_a/
[reddit-app]: https://www.reddit.com/r/discordapp/comments/lat15p/discord_bot_api/
[activities-guide]: https://wisechecker.com/discord-activities-watch-party-streams/
[watch-together]: https://wisechecker.com/discord-watch-together-activity/
[fandom-wt]: https://discord.fandom.com/wiki/Watch_Together
