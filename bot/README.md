# APEX Race Control — Discord bot

Owner-operated companion bot for the APEX Discord server. Runs **in-process**
with the f1free Express server; does nothing unless `DISCORD_BOT_TOKEN` is set.
All commands except `/website` are hard-gated to the owner id
(`915483308522086460`) and refuse everyone else ephemerally.

Everything you configure with commands is **durable**: panels, channel
bindings, emoji ids and the sent-alert history persist through restarts and
redeploys (local JSON in `DATA_DIR` / Upstash `freef1:discordbot:v1` in prod —
same dual store the maintenance mode uses).

---

## Setup (once)

1. **Discord Developer Portal** → New Application → Bot → copy the token.
   - Privileged intents: **none** needed. Leave all three switches off.
2. **Invite the bot** to the server with this URL (replace `CLIENT_ID`):

   ```
   https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot%20applications.commands&permissions=1342262336
   ```

   Permissions = Manage Roles · Manage Emojis · View Channels · Send Messages ·
   Embed Links · Add Reactions · Read Message History.
3. **Role hierarchy:** drag the bot's role **above every role it manages**
   (all 22 grid roles + Stream Alerts). Discord refuses to assign roles above
   the bot's top role — this is the #1 "reactions do nothing" cause.
4. **Env vars** (Render → service → Environment):

   | Var | Value |
   |---|---|
   | `DISCORD_BOT_TOKEN` | bot token |
   | `DISCORD_GUILD_ID` | your server id (guild-scoped commands = instant; omit for global, ~1h propagation) |
   | `SITE_URL` | optional, defaults to `https://freef1.netlify.app` |

5. Restart the service. Log shows `[Bot] connected as …` and
   `commands registered (guild-scoped)`.

## First run, in Discord

| Command | Where | What it does |
|---|---|---|
| `/emojis` | anywhere | uploads the 22 white number emojis + the red alert dot (also auto-runs when panels are posted) |
| `/rolemenu` | a roles channel | posts the **two-part supporter panel** (GRID 1/2, GRID 2/2). Reacting with a number grants that `NN \| CODE` role; removing the reaction takes it off |
| `/alertsmenu [channel] [role]` | a roles channel | posts the alerts opt-in panel where you run it; `channel:` picks where session alerts get posted (defaults to the command channel); reaction grants the ping role (creates **Stream Alerts** if you don't pass one) |
| `/live [round] [session]` | anywhere | test-fires the LIVE embed into the configured alerts channel — the way to prove the alert pipeline end-to-end before a race weekend |
| `/website` | **everyone** | stylish link embed: Open APEX + Server invite buttons |

Re-running `/rolemenu` or `/alertsmenu` deletes the old panel messages and
rebuilds them — safe to redo after adding roles or changing channels.

## Automatic session alerts

Every 15 s the scheduler walks the 2026 season (extracted verbatim from the
site's `app.js` schedule into `bot/schedule-2026.json`):

- **T−10 min** → `STARTING SOON` embed in the alerts channel, pinging the
  alerts role, with a **Watch on APEX** button.
- **Lights out** → the *same message edits itself* into `LIVE NOW` (green
  accent) — no second ping, no channel spam.
- Every send is recorded in the durable store (`spain:fp2:soon` …), so restarts
  never double-post; history prunes after 7 days.
- If the alerts channel/role gets deleted, the tick silently skips — `/status`-style
  errors never leak into public channels. Re-run `/alertsmenu` to rebind.

## Why two driver panels

Discord caps reactions at **20 per message**; the 2026 grid has 22 drivers.
The panel ships as two linked embeds split by team block (10 + 12 reactions).

## Why custom number emojis

"React with 44" needs a 44 glyph — unicode only offers single-digit keycaps.
The bot uploads crisp white pixel-digit PNGs (`bot/assets/emoji/*.png`,
~200 bytes each, generated deterministically) plus a red dot for the alerts
panel. Message text itself uses **zero emojis** per the design rule — styling
comes from embed accents (APEX red `#E10600`, live green `#00D57E`), bold
typography and monospace number chips.

## Files

| Path | Purpose |
|---|---|
| `bot/discord-bot.js` | the whole bot (store, panels, reactions, scheduler, commands) |
| `bot/schedule-2026.json` | season data, extracted from `netlifyf1/app.js` — refresh both when the calendar changes |
| `bot/assets/emoji/` | number + alert-dot PNGs uploaded on first run |
| `server.js` (tail) | opt-in bootstrap, crash-isolated `require` |

## Ops notes

- **Crash isolation:** the bot lives behind its own try/catch and discord.js
  error handlers; a bot exception can never take the site API down, and a
  missing token prints `[Bot] Discord bot disabled` and changes nothing else.
- **Intents:** Guilds, GuildMessages, GuildMessageReactions + Message/Reaction
  partials (so reactions on old panels still work after a restart). No
  privileged intents → no Discord verification threshold.
- **Rate limits:** panel reactions are queued 300 ms apart; the scheduler edits
  one message per session instead of posting repeats — comfortably inside
  Discord's budgets.
- **Season rollover:** regenerate `schedule-2026.json` from the frontend
  schedule (one-liner in git history) and redeploy.
