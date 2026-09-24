# APEX Race Control — Discord bot

Owner-operated companion bot for the APEX Discord server. Runs **in-process**
with the f1free Express server; does nothing unless `DISCORD_BOT_TOKEN` is set.
All commands except `/website` are hard-gated to the owner id
(`915483308522086460`) and refuse everyone else ephemerally.

Everything you configure with commands is **durable**: panels, channel
bindings, the alerts role, the audio URL, the soon-alert lead time, emoji ids
and the sent-alert history persist through restarts and redeploys (local JSON
in `DATA_DIR` / Upstash `freef1:discordbot:v1` in prod — same dual store the
maintenance mode uses). Writes are immediate, and the server flushes the store
on SIGTERM/SIGINT before exit, so a redeploy cannot drop a sent-marker and
double-post an alert.

---

## Setup (once)

1. **Discord Developer Portal** → New Application → Bot → copy the token.
   - Privileged intents: **none** needed. Leave all three switches off.
     `GuildVoiceStates` (used to pause the audio relay in an empty room) is
     not a privileged intent.
2. **Invite the bot** to the server with this URL (replace `CLIENT_ID`):

   ```
   https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot%20applications.commands&permissions=1345408064
   ```

   Permissions = Manage Roles · Manage Emojis · View Channels · Send Messages ·
   Embed Links · Add Reactions · Read Message History · Connect · Speak.
   Connect and Speak are only for `/watchparty`. Add Reactions is only so
   already-posted legacy reaction panels keep working.
3. **Role hierarchy:** drag the bot's role **above every role it manages**
   (all 22 grid roles + Stream Alerts). Discord refuses to assign roles above
   the bot's top role — this is the #1 "button did nothing" cause.
4. **Grid roles** must already exist, named exactly `NN | CODE`
   (example: `16 | LEC`). `/rolemenu` will not invent them.
5. **Env vars** (Render → service → Environment):

   | Var | Value |
   |---|---|
   | `DISCORD_BOT_TOKEN` | bot token |
   | `DISCORD_GUILD_ID` | your server id (guild-scoped commands = instant; omit for global, ~1h propagation) |
   | `SITE_URL` | optional, defaults to `https://freef1.netlify.app` |
   | `APEX_AUDIO_URL` | optional default race-audio URL for `/watchparty start` (overridable with `/config set audio_url:`) |

6. Restart the service. Log shows `[Bot] connected as …` and
   `commands registered (guild-scoped)`.

## Commands

| Command | Who | What it does |
|---|---|---|
| `/emojis` | owner | uploads the 22 white number emojis + the red alert dot (also auto-runs when panels are posted) |
| `/rolemenu` | owner | posts **one** compact grid embed plus 22 driver buttons (5 per row, team order). Clicking toggles that `NN \| CODE` role. Re-running deletes the previous panel, including a legacy two-part reaction panel |
| `/alertsmenu [channel] [role]` | owner | posts the alerts opt-in panel (one toggle button) where you run it; `channel:` picks where session alerts get posted (defaults to this channel); creates **Stream Alerts** if you don't pass a role |
| `/config view` | owner | alerts channel, alerts role, soon lead time, audio URL, panel links |
| `/config set` | owner | change any of `alerts_channel`, `alerts_role`, `audio_url`, `soon_minutes` (1–120) without re-posting panels |
| `/status` | owner | one glance: live/next session, bindings, panels, mapped roles, relay, store backend |
| `/live [round] [session] [state]` | owner | test-fires an alert embed (`state:` `soon` / `live` / `ended`, default `live`) into the alerts channel. A wrong round or slug errors with the valid slugs — it does not silently post a different session |
| `/watchparty start\|stop\|status` | owner | relay race **audio** into a voice channel. See `bot/STREAMING.md` for why this cannot be video |
| `/website` | **everyone** | stylish link embed: Open APEX + Server invite buttons |

## Automatic session alerts

Every 15 s the scheduler walks the 2026 season (`bot/schedule-2026.json`,
kept in step with the site's `app.js` schedule):

- **T−N min** (default 10, editable with `/config set soon_minutes:`) →
  `STARTING SOON` embed, amber accent, pinging the alerts role, with a
  **Watch on APEX** button.
- **Lights out** → the *same message edits itself* into `LIVE NOW` (green).
  No second ping, no channel spam.
- **Chequered flag** → the same message edits into `ENDED` (red). End times
  are estimated per session (practice / sprint qualifying / sprint 60 min,
  qualifying 80, race 120) because the schedule only carries start times.
  A missed session is never fresh-posted as ENDED — the bot only edits a
  message it already sent.
- While a session is live the bot's activity is the Grand Prix name
  (`Watching Azerbaijan Grand Prix`). Otherwise it shows the next session
  and a countdown, and only calls `setPresence` when that text changes.
- Every send is recorded in the durable store (`azerbaijan:fp2:soon` …), so
  restarts never double-post; history prunes after 7 days.
- If the alerts channel gets deleted, the tick silently skips. Re-run
  `/alertsmenu` or `/config set alerts_channel:` to rebind.

Alert embed shape (no footer — the site link is a bold line under the fields):

```
LIVE NOW                          ← title, links to the site; amber / green / red
Azerbaijan Grand Prix
Practice 2 · <long date> · <relative>

The feed is up - grab a seat in the cockpit.

Round          Format
15 · Baku, Azerbaijan    Standard weekend

freef1.netlify.app                ← bold link
```

`ENDED` uses "Chequered flag - session complete. …". `STARTING SOON` uses
the lead-time line.

## Panels

Discord caps reactions at **20 per message**; the 2026 grid has 22 drivers,
so the grid is one embed plus buttons (`apex:grid:<number>`), not reactions.
The alerts opt-in is a single `apex:alerts` toggle button.

Legacy reaction panels already posted in a server keep working (the reaction
handlers are still there) until you re-run `/rolemenu` or `/alertsmenu`.

Number emojis exist because a button labelled `44` needs a 44 glyph — unicode
only offers single-digit keycaps. The bot uploads crisp white pixel-digit
PNGs (`bot/assets/emoji/*.png`) and uses them on the driver buttons.

## Files

| Path | Purpose |
|---|---|
| `bot/discord-bot.js` | the whole bot (store, panels, buttons, scheduler, commands) |
| `bot/voice-relay.js` | race-audio relay; pauses in an empty room; capped reconnect budget |
| `bot/schedule-2026.json` | season data, extracted from `netlifyf1/app.js` — refresh both when the calendar changes |
| `bot/assets/emoji/` | number + alert-dot PNGs uploaded on first run |
| `bot/STREAMING.md` | why the relay is audio-only, and the Activity alternative |
| `server.js` (tail) | opt-in bootstrap, crash-isolated `require`, shutdown flush |

## Ops notes

- **Crash isolation:** the bot lives behind its own try/catch and discord.js
  error handlers; a bot exception can never take the site API down, and a
  missing token prints `[Bot] Discord bot disabled` and changes nothing else.
- **Intents:** Guilds, GuildMessages, GuildMessageReactions, GuildVoiceStates
  + Message/Reaction partials (so reactions on old panels still work after a
  restart). No privileged intents → no Discord verification threshold.
- **Scheduler:** one `setInterval`, registered once. A gateway reconnect
  cannot stack a second loop.
- **Audio relay:** retries a dead source at most 5 times (backoff 2 s ×
  attempt). The attempt count is stored, so a restart cannot reset it and
  loop. After the budget it forgets the saved relay. It also pauses when
  the voice channel has no humans and resumes when someone joins.
- **Season rollover:** regenerate `schedule-2026.json` from the frontend
  schedule and redeploy. The two copies are not auto-synced.
