# FreeF1 Discord companion

The optional bot runs in-process with the Express service and starts only when
`DISCORD_BOT_TOKEN` is set. It does **not** join voice channels or relay audio or
video; those paths were retired with the self-hosted stream relays.

## Setup

1. Create a Discord application and bot.
2. Invite it with the `bot` and `applications.commands` scopes.
3. Grant View Channels, Send Messages, Embed Links, Manage Roles, Add Reactions,
   and Manage Expressions if `/emojis` should upload number emoji.
4. Set:

| Environment key | Purpose |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Bot token |
| `DISCORD_OWNER_ID` | User allowed to run owner commands |
| `DISCORD_GUILD_ID` | Optional instant guild-scoped command registration |
| `SITE_URL` | Defaults to `https://freef1.netlify.app` |
| `DISCORD_INVITE` | Public invite shown by the site |
| `DISCORD_GUILD_MEMBERS_INTENT=1` | Optional automatic unlink when a member leaves; also enable the intent in the Developer Portal |

The bot uses the application's configured durable store through the server. Its
state includes role mappings, panel message IDs, sent-alert markers, settings,
and Discord links.

## Commands

| Command | Access | Purpose |
| --- | --- | --- |
| `/rolemenu` | owner | Post the driver role panel |
| `/alertsmenu` | owner | Post stream-alert opt-in controls |
| `/config view|set` | owner | Inspect or change channels, roles, and alert lead time |
| `/status` | owner | Show the next/live session, bindings, panels, roles, and store |
| `/live` | owner | Test a session alert embed |
| `/emojis` | owner | Upload missing number emoji |
| `/website` | everyone | Show the FreeF1 site link |
| `/link <code>` | everyone, in `#link`/`#links` | Link Discord community identity to a browser code |
| `/unlink` | everyone, in `#link`/`#links` | Revoke that link |

## Reliability

- Commands register once the client is ready.
- Session alert markers are persisted immediately to avoid duplicate posts.
- Link announcement failures never break linking.
- The privileged Guild Members intent is opt-in; the bot continues without it.
- A bot login/startup failure is isolated from the Express service.
- Shutdown flushes bot state before the Redis connection closes.
