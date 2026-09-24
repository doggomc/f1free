'use strict';

/* ════════════════════════════════════════════════════════════════════
   APEX Race Control — Discord companion bot (owner-operated)
   ════════════════════════════════════════════════════════════════════
   Runs in-process with the f1free Express server; started only when
   DISCORD_BOT_TOKEN is set. Everything the owner configures with
   commands is persisted (file locally / Upstash in production), so
   restarts and redeploys keep panels, bindings and sent-history.

   Ownership is hard-coded to a single user id by design (spec):
   every command except /website refuses anyone else, ephemeralally.

   Feature set:
     /rolemenu    owner — posts the supporter-role panel: ONE compact
                          embed plus 22 driver buttons (5 per row, team
                          order). Clicking a button toggles that
                          driver's "NN | CODE" role. (Buttons replaced
                          the old two-part reaction panels: Discord
                          caps reactions at 20 per message and the
                          grid has 22 drivers; buttons allow 25.)
     /alertsmenu  owner — posts the stream-alerts opt-in panel with a
                          single toggle button; binds the alerts
                          channel + ping role.
     /config      owner — view or change settings at runtime: alerts
                          channel, alerts role, default audio url,
                          soon-alert lead time. Everything editable
                          without re-posting panels.
     /status      owner — one glance at bindings, panels, next
                          session, relay state and store backend.
     /live        owner — test-fires an alert embed (any state:
                          soon / live / ended) into the alerts channel.
     /emojis      owner — uploads any missing custom number emojis.
     /watchparty  owner — start/stop/status the race-AUDIO relay.
     /website     everyone — stylish link embed for the site.
     scheduler    — per session: STARTING SOON (amber) embed + role
                    ping at T-minus config; the same message edits
                    itself into LIVE NOW (green) at lights out, and
                    into ENDED (red) at the chequered flag. Deduped
                    via the durable store; presence follows along.
     presence     — while a session is live the bot's activity is the
                    Grand Prix name; otherwise a next-session
                    countdown, refreshed at most once a minute.

   Intents stay unprivileged: Guilds, GuildMessages, GuildMessageReactions
   (+ Message/Reaction partials so legacy reaction panels survive bot
   restarts), GuildVoiceStates for the audio relay's empty-room pause.
   ════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const {
  Client, GatewayIntentBits, Partials, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, REST, Routes, Events, ActivityType,
} = require('discord.js');
/* Optional voice relay. Loaded lazily so the bot still boots (and the site
   still serves) when the voice packages are not installed. See
   bot/STREAMING.md for why this is audio-only. */
const relayModule = require('./voice-relay.js');

const OWNER_ID = '915483308522086460';
const DEFAULT_SOON_MINUTES = 10;    // lead time for the "starting soon" alert
const ENDED_WINDOW_HOURS = 24;      // how long a finished session stays editable to ENDED
const TICK_MS = 15000;              // scheduler resolution
const APEX_RED = 0xE10600;
const APEX_GREEN = 0x00D57E;
const APEX_AMBER = 0xFFB020;
const ROLE_NAME_RE = /^(\d{1,2}) \| ([A-Z]{3})$/;
const SITE_LABEL = 'freef1.netlify.app';

/* Realistic session lengths (minutes) — the schedule carries start times
   only, and the ENDED state needs an end. Deliberately generous: a session
   that runs long flips to ENDED a little late, which is harmless; one that
   flips early would look broken. */
const SESSION_MIN = {
  fp1: 60, fp2: 60, fp3: 60,
  'sprint-qualifying': 60, sprint: 60,
  qualifying: 80, race: 120,
};

const SEASON = require('./schedule-2026.json');
SEASON.forEach(ev => ev.sessions.forEach(s => {
  s.ts = Date.parse(s.start);
  s.end = s.ts + (SESSION_MIN[s.slug] || 60) * 60000;
}));

/* 2026 grid in panel order — colors mirror the site's livery palette. */
const TEAMS = [
  { name: 'Ferrari',         color: 0xDC0000, drivers: [[16, 'LEC'], [44, 'HAM']] },
  { name: 'Mercedes',        color: 0x00D2BE, drivers: [[12, 'ANT'], [63, 'RUS']] },
  { name: 'Mclaren',         color: 0xFF8000, drivers: [[1, 'NOR'], [81, 'PIA']] },
  { name: 'Red Bull',        color: 0x1E41FF, drivers: [[3, 'VER'], [6, 'HAD']] },
  { name: 'Aston Martin',    color: 0x006F62, drivers: [[14, 'ALO'], [18, 'STR']] },
  { name: 'Williams',        color: 0x005AFF, drivers: [[23, 'ALB'], [55, 'SAI']] },
  { name: 'Haas',            color: 0xE6E6E6, drivers: [[31, 'OCO'], [87, 'BEA']] },
  { name: 'Audi',            color: 0xE62213, drivers: [[5, 'BOR'], [27, 'HUL']] },
  { name: 'Racing Bulls',    color: 0x6692FF, drivers: [[30, 'LAW'], [41, 'LIN']] },
  { name: 'Alpine',          color: 0xFF0080, drivers: [[10, 'GAS'], [43, 'COL']] },
  { name: 'Cadillac',        color: 0xB4A07A, drivers: [[11, 'PER'], [77, 'BOT']] },
];
const ALL_DRIVERS = TEAMS.flatMap(t => t.drivers.map(([n, c]) => ({ num: n, code: c, team: t.name, color: t.color })));

/* ───────────────────────── embed + component builders (pure, testable) ───────────────────────── */

/* One compact embed for the whole 22-car grid: a monospace team block.
   Buttons (not reactions) carry the toggles — Discord caps reactions at
   20 per message and the grid has 22 drivers. */
function driverPanelEmbed(siteUrl) {
  const width = Math.max(...TEAMS.map(t => t.name.length));
  const lines = TEAMS.map(t => {
    const drivers = t.drivers.map(([n, c]) => `${String(n).padStart(2, ' ')} ${c}`).join(' · ');
    return `${t.name.padEnd(width, ' ')}  ${drivers}`;
  }).join('\n');
  return {
    color: APEX_RED,
    title: '2026 Grid',
    description:
      `\`\`\`\n${lines}\n\`\`\`\n` +
      `Tap a driver to wear their colours. Tap again to take them off.\n\n` +
      `**[${SITE_LABEL}](${siteUrl})**`,
  };
}

function alertsPanelEmbed(siteUrl) {
  return {
    color: APEX_RED,
    description:
      `**Stream Alerts**\n\n` +
      `Get pinged when a session is starting.\n` +
      `Toggle below to opt in or out.\n\n` +
      `**[${SITE_LABEL}](${siteUrl})**`,
  };
}

/* The alert embed. Three states across a session's life:
   STARTING SOON (amber) -> LIVE NOW (green) -> ENDED (red),
   each edit happening in place on the same message. */
function sessionEmbed(ev, sess, state, siteUrl, soonMinutes = DEFAULT_SOON_MINUTES) {
  const sec = Math.floor(sess.ts / 1000);
  const live = state === 'live';
  const ended = state === 'ended';
  const line = live
    ? 'The feed is up - grab a seat in the cockpit.'
    : ended
      ? 'Chequered flag - session complete. Results and radio on the site.'
      : `Lights out in about ${soonMinutes} minutes. Settle in.`;
  return {
    color: live ? APEX_GREEN : ended ? APEX_RED : APEX_AMBER,
    title: live ? 'LIVE NOW' : ended ? 'ENDED' : 'STARTING SOON',
    url: siteUrl,
    description:
      `**${ev.name}**\n` +
      `${sess.name} · <t:${sec}:F> · <t:${sec}:R>\n\n` +
      `${line}`,
    fields: [
      { name: 'Round', value: `${ev.round} · ${ev.locality}, ${ev.country}`, inline: true },
      { name: 'Format', value: ev.sprint ? 'Sprint weekend' : 'Standard weekend', inline: true },
      // Footer text cannot be a link. A trailing field keeps the bold
      // site link under Round / Format, which is where the old footer sat.
      { name: '\u200b', value: `**[${SITE_LABEL}](${siteUrl})**` },
    ],
  };
}

function websiteEmbed(siteUrl, inviteUrl) {
  return {
    color: APEX_RED,
    title: 'APEX — the free F1 stream hub',
    description:
      'Every session of the 2026 season in one cockpit.\n' +
      'Ten stream sources with automatic fallback, live race-control\n' +
      'data, standings, news and a pit-stop-fast interface.',
    fields: [
      { name: 'Streams', value: 'F1TV, AppleTV, DAZN, Sky UK x3, Streame, WikiSport + auto-fallback', inline: false },
      { name: 'Race control', value: 'Live timing windows, radio feed, standings and results', inline: false },
      { name: 'Community', value: 'Session alerts, supporter roles and watch parties right here', inline: false },
    ],
    footer: { text: 'Independent fan project · No affiliation with Formula 1 or the FIA' },
    url: siteUrl,
  };
}

function watchRow(siteUrl, label = 'Watch on APEX') {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(siteUrl)
  );
}

function websiteRow(siteUrl, inviteUrl) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Open APEX').setURL(siteUrl),
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Server invite').setURL(inviteUrl)
  );
}

/* 22 driver buttons, team order, five per row (Discord's row cap),
   each wearing the driver's custom number emoji. 22 <= the 25-button
   message cap, which is exactly why buttons replaced reactions. */
function gridRows(st) {
  const rows = [];
  for (let i = 0; i < ALL_DRIVERS.length; i += 5) {
    const row = new ActionRowBuilder();
    for (const d of ALL_DRIVERS.slice(i, i + 5)) {
      const button = new ButtonBuilder()
        .setStyle(ButtonStyle.Secondary)
        .setLabel(d.code)
        .setCustomId(`apex:grid:${d.num}`);
      const emojiId = st.emojiIds && st.emojiIds[String(d.num)];
      if (emojiId) button.setEmoji({ id: emojiId });
      row.addComponents(button);
    }
    rows.push(row);
  }
  return rows;
}

function alertsRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Primary)
      .setLabel('Toggle Session Alerts')
      .setCustomId('apex:alerts')
  );
}

/* ───────────────────────── schedule helpers (pure) ───────────────────────── */

function nextSession(now = Date.now()) {
  let best = null;
  for (const ev of SEASON) for (const s of ev.sessions) {
    if (s.ts > now && (!best || s.ts < best.sess.ts)) best = { ev, sess: s };
  }
  return best;
}

function liveSession(now = Date.now()) {
  for (const ev of SEASON) for (const s of ev.sessions) {
    if (s.ts <= now && now < s.end) return { ev, sess: s };
  }
  return null;
}

/* 'soon' | 'live' | 'ended' | null — the whole alert lifecycle in one place. */
function sessionState(sess, now = Date.now(), soonMinutes = DEFAULT_SOON_MINUTES) {
  const dt = sess.ts - now;
  if (dt > 0) return dt <= soonMinutes * 60000 ? 'soon' : null;
  if (now < sess.end) return 'live';
  if (now < sess.end + ENDED_WINDOW_HOURS * 3600000) return 'ended';
  return null;
}

/* Strict when a slug is given (a typo must fail loudly, not silently
   post a different session); convenient when it is not. */
function findSession(round, sessionSlug, now = Date.now()) {
  const live = liveSession(now);
  const ev = round != null
    ? SEASON.find(e => e.round === Number(round))
    : (live?.ev || nextSession(now)?.ev);
  if (!ev) return null;
  if (sessionSlug) {
    const sess = ev.sessions.find(s => s.slug === sessionSlug);
    return sess ? { ev, sess } : null;
  }
  const inWindow = ev.sessions.find(s => s.ts <= now && now - s.ts < ENDED_WINDOW_HOURS * 3600000 && now < s.end);
  return inWindow ? { ev, sess: inWindow }
    : (ev.sessions.find(s => s.ts > now) || { ev, sess: ev.sessions[ev.sessions.length - 1] });
}

/* Presence text: the Grand Prix name while a session is live, otherwise a
   next-session countdown at minute granularity (so setPresence is called
   at most ~1/min, well inside Discord's limits). */
function presenceActivity(now = Date.now()) {
  const live = liveSession(now);
  if (live) return { name: live.ev.name, type: ActivityType.Watching };
  const next = nextSession(now);
  if (!next) return { name: SITE_LABEL, type: ActivityType.Watching };
  const mins = Math.max(0, Math.round((next.sess.ts - now) / 60000));
  const span = mins >= 60 ? `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m` : `${mins}m`;
  return { name: `${next.ev.name} · ${next.sess.name} in ${span}`, type: ActivityType.Watching };
}

/* ───────────────────────── bot ───────────────────────── */

function start(deps) {
  const log = deps.log || ((...a) => console.log('[Bot]', ...a));
  const EMOJI_DIR = path.join(__dirname, 'assets', 'emoji');

  /* ── durable store: file locally, Upstash in production ──
     Writes are immediate (no debounce): the sent-markers are the only
     thing standing between a redeploy and a double-posted alert, so a
     SIGTERM must never race a pending save. server.js calls flush()
     during graceful shutdown as a belt-and-braces final write. */
  let storeCache = null;
  let savePromise = null;
  const store = {
    async load() {
      if (storeCache) return storeCache;
      try {
        if (deps.upstash) {
          const r = await deps.upstash(['GET', deps.redisKey]);
          storeCache = r && r.result ? JSON.parse(r.result) : { guilds: {} };
        } else {
          storeCache = deps.readLocalJson(deps.fileKey) || { guilds: {} };
        }
      } catch (e) {
        log('store load failed, starting empty:', e.message);
        storeCache = { guilds: {} };
      }
      return storeCache;
    },
    async save() {
      // Serialized, and the payload is read when the write actually runs,
      // so two overlapping saves cannot clobber a newer one with a stale
      // snapshot.
      const write = async () => {
        try {
          if (deps.upstash) await deps.upstash(['SET', deps.redisKey, JSON.stringify(storeCache)]);
          else deps.writeLocalJson(deps.fileKey, storeCache);
        } catch (e) { log('store save failed:', e.message); }
      };
      const prev = savePromise || Promise.resolve();
      savePromise = prev.then(write, write);
      return savePromise;
    },
    flush() { return this.save(); },
    async guild(guildId) {
      const s = await this.load();
      if (!s.guilds[guildId]) {
        s.guilds[guildId] = { emojiIds: {}, driverRoles: {}, panels: {}, alerts: null, sent: {}, config: {} };
      }
      const g = s.guilds[guildId];
      if (!g.config) g.config = {};
      return g;
    },
  };
  const soonMinutesFor = st => Number(st.config && st.config.soonMinutes) || DEFAULT_SOON_MINUTES;

  /* Voice relay: joins a race-control channel and plays the race audio.
     Everything degrades gracefully when the voice packages are absent. */
  const relay = relayModule.create({
    log,
    getState: () => store.load(),
    save: () => store.save()
  });
  if (!relayModule.isAvailable()) {
    log('voice relay disabled — install @discordjs/voice @discordjs/opus ffmpeg-static to enable /watchparty');
  }

  function pauseIfEmpty(guild, channel) {
    const humans = channel.members ? channel.members.filter(m => !m.user.bot).size : 0;
    if (humans === 0) relay.setPaused(guild.id, true);
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildVoiceStates, // audio relay + empty-room pause
    ],
    partials: [Partials.Message, Partials.Reaction],
  });

  /* ── emoji management ── */
  async function ensureEmojis(guild, st) {
    const wanted = [...ALL_DRIVERS.map(d => ({ key: String(d.num), file: `n${d.num}.png` })), { key: 'live', file: 'apexlive.png' }];
    for (const w of wanted) {
      const name = w.key === 'live' ? 'apexlive' : `n${w.key}`;
      const existing = guild.emojis.cache.find(e => e.name === name);
      if (existing) { st.emojiIds[w.key] = existing.id; continue; }
      if (st.emojiIds[w.key] && guild.emojis.cache.has(st.emojiIds[w.key])) continue;
      try {
        const buf = fs.readFileSync(path.join(EMOJI_DIR, w.file));
        const created = await guild.emojis.create({ name, attachment: buf, reason: 'APEX panels' });
        st.emojiIds[w.key] = created.id;
        log(`emoji uploaded: ${created.name}`);
      } catch (e) {
        log(`emoji upload failed (${w.file}):`, e.message);
      }
    }
    await store.save();
  }

  function discoverDriverRoles(guild, st) {
    const map = {};
    for (const role of guild.roles.cache.values()) {
      const m = ROLE_NAME_RE.exec(role.name);
      if (m) map[m[1]] = role.id;
    }
    st.driverRoles = map;
    return map;
  }

  async function deleteStoredPanel(guild, st, key) {
    const old = st.panels && st.panels[key];
    if (!old) return;
    try {
      const ch = guild.channels.cache.get(old.channelId);
      const msg = await ch?.messages.fetch(old.messageId);
      await msg?.delete();
    } catch (_) { /* already gone */ }
    delete st.panels[key];
  }

  /* ── panel posting ── */
  async function postGridPanel(guild, channel, st) {
    await ensureEmojis(guild, st);
    const roles = discoverDriverRoles(guild, st);
    const missing = ALL_DRIVERS.filter(d => !roles[String(d.num)]).map(d => d.num);
    if (missing.length) throw new Error(`missing grid roles for numbers: ${missing.join(', ')}`);

    // retire previous panels (including legacy two-part reaction panels)
    for (const key of ['d1', 'd2', 'grid']) await deleteStoredPanel(guild, st, key);

    const msg = await channel.send({ embeds: [driverPanelEmbed(deps.siteUrl)], components: gridRows(st) });
    st.panels.grid = { channelId: channel.id, messageId: msg.id };
    await store.save();
  }

  async function postAlertsPanel(guild, channel, st, role, alertsChannel) {
    await ensureEmojis(guild, st);
    let target = role;
    if (!target) {
      target = guild.roles.cache.find(r => r.name === 'Stream Alerts');
      if (!target) {
        target = await guild.roles.create({ name: 'Stream Alerts', color: APEX_RED, reason: 'APEX stream alerts opt-in' });
      }
    }
    await deleteStoredPanel(guild, st, 'alerts');
    const msg = await channel.send({ embeds: [alertsPanelEmbed(deps.siteUrl)], components: [alertsRow()] });
    st.panels.alerts = { channelId: channel.id, messageId: msg.id };
    st.alerts = { channelId: (alertsChannel || channel).id, roleId: target.id };
    await store.save();
  }

  /* ── role toggling (buttons now, legacy reactions below) ── */
  async function toggleRole(member, guild, st, roleId, why) {
    const has = member.roles.cache.has(roleId);
    if (has) await member.roles.remove(roleId, why);
    else await member.roles.add(roleId, why);
    return !has; // true = granted
  }

  async function handleGridButton(interaction) {
    const num = interaction.customId.split(':')[2];
    const guild = interaction.guild;
    const st = await store.guild(guild.id);
    const roleId = st.driverRoles[num] || discoverDriverRoles(guild, st)[num];
    const driver = ALL_DRIVERS.find(d => String(d.num) === num);
    if (!driver) return interaction.reply({ content: 'Unknown driver.', ephemeral: true });
    if (!roleId) {
      return interaction.reply({
        content: `No role is mapped to number ${num} yet. Create a role named \`${num} | ${driver ? driver.code : 'CODE'}\` (or re-run /rolemenu once it exists).`,
        ephemeral: true
      });
    }
    try {
      const granted = await toggleRole(interaction.member, guild, st, roleId, 'APEX supporter role');
      await store.save();
      return interaction.reply({
        content: granted
          ? `You are now wearing ${driver.team} - ${num} ${driver.code}.`
          : `Taken off: ${driver.team} - ${num} ${driver.code}.`,
        ephemeral: true
      });
    } catch (e) {
      log('grid button role change failed:', e.message);
      return interaction.reply({
        content: 'Could not change your role. Is the bot\'s role above the grid roles in Server Settings > Roles?',
        ephemeral: true
      });
    }
  }

  async function handleAlertsButton(interaction) {
    const guild = interaction.guild;
    const st = await store.guild(guild.id);
    if (!st.alerts || !st.alerts.roleId) {
      return interaction.reply({ content: 'Alerts are not configured yet. Owner: run /alertsmenu.', ephemeral: true });
    }
    try {
      const granted = await toggleRole(interaction.member, guild, st, st.alerts.roleId, 'APEX stream alerts opt-in/out');
      await store.save();
      return interaction.reply({
        content: granted
          ? 'You will be pinged when a session is starting.'
          : 'Session alerts muted. Toggle again any time.',
        ephemeral: true
      });
    } catch (e) {
      log('alerts button role change failed:', e.message);
      return interaction.reply({
        content: 'Could not change your role. Is the bot\'s role above the alerts role in Server Settings > Roles?',
        ephemeral: true
      });
    }
  }

  /* Legacy reaction panels (two-part grid + reaction alerts) keep working
     for any server that has not re-run /rolemenu or /alertsmenu yet. */
  async function handleReaction(reaction, user, granting) {
    if (user.bot) return;
    try {
      if (reaction.partial) await reaction.fetch();
      if (reaction.message.partial) await reaction.message.fetch();
    } catch (_) { return; }
    const guild = reaction.message.guild;
    if (!guild) return;
    const st = await store.guild(guild.id);
    const msgId = reaction.message.id;

    const panelKey = Object.keys(st.panels).find(k => st.panels[k] && st.panels[k].messageId === msgId);
    if (!panelKey || panelKey === 'grid') return; // grid is button-only now

    const emojiKey = reaction.emoji.id
      ? Object.keys(st.emojiIds).find(k => st.emojiIds[k] === reaction.emoji.id)
      : null;
    if (!emojiKey) return;

    try {
      if (panelKey === 'alerts') {
        if (!st.alerts || !st.alerts.roleId) return;
        const member = await guild.members.fetch(user.id);
        if (granting) await member.roles.add(st.alerts.roleId, 'APEX stream alerts opt-in');
        else await member.roles.remove(st.alerts.roleId, 'APEX stream alerts opt-out');
        return;
      }
      const roleId = st.driverRoles[emojiKey] || discoverDriverRoles(guild, st)[emojiKey];
      if (!roleId) return;
      const member = await guild.members.fetch(user.id);
      if (granting) await member.roles.add(roleId, 'APEX supporter role');
      else await member.roles.remove(roleId, 'APEX supporter role');
    } catch (e) {
      log('reaction role failed:', e.message); // usually role hierarchy
    }
  }

  /* ── scheduler: soon -> live -> ended, edit-in-place; presence follows ── */
  let lastPresence = '';
  async function syncPresence(now) {
    const activity = presenceActivity(now);
    if (activity.name === lastPresence) return;
    lastPresence = activity.name;
    try {
      await client.user?.setPresence({ activities: [activity], status: 'online' });
    } catch (e) { log('presence update failed:', e.message); }
  }

  let tickInFlight = false;
  async function tick() {
    // A slow Discord call must not overlap the next 15s tick, or two passes
    // can both see an unsent marker and double-post the alert.
    if (tickInFlight) return;
    tickInFlight = true;
    try {
    const s = await store.load();
    const now = Date.now();
    await syncPresence(now);
    for (const guildId of Object.keys(s.guilds)) {
      const st = s.guilds[guildId];
      if (!st.sent) st.sent = {};
      if (!st.alerts || !st.alerts.channelId) continue;
      const guild = client.guilds.cache.get(guildId);
      const channel = guild && guild.channels.cache.get(st.alerts.channelId);
      if (!channel) continue;
      const soonMin = soonMinutesFor(st);

      for (const ev of SEASON) for (const sess of ev.sessions) {
        const state = sessionState(sess, now, soonMin);
        if (!state) continue;
        const base = `${ev.slug}:${sess.slug}`;
        const keySoon = `${base}:soon`;
        const keyLive = `${base}:live`;
        const keyEnded = `${base}:ended`;

        if (state === 'soon' && !st.sent[keySoon]) {
          try {
            const content = st.alerts.roleId ? `<@&${st.alerts.roleId}>` : '';
            const msg = await channel.send({
              content,
              embeds: [sessionEmbed(ev, sess, 'soon', deps.siteUrl, soonMin)],
              components: [watchRow(deps.siteUrl)],
              allowedMentions: { roles: st.alerts.roleId ? [st.alerts.roleId] : [] },
            });
            st.sent[keySoon] = { messageId: msg.id, at: now };
            log(`soon alert: ${ev.slug}/${sess.slug}`);
            await store.save();
          } catch (e) { log('soon alert failed:', e.message); }
        }

        if (state === 'live' && !st.sent[keyLive]) {
          try {
            const soonMsgId = st.sent[keySoon] && st.sent[keySoon].messageId;
            let msg = null;
            if (soonMsgId) {
              try {
                msg = await channel.messages.fetch(soonMsgId);
                await msg.edit({ embeds: [sessionEmbed(ev, sess, 'live', deps.siteUrl, soonMin)], components: [watchRow(deps.siteUrl)] });
              } catch (_) { msg = null; }
            }
            if (!msg) msg = await channel.send({ embeds: [sessionEmbed(ev, sess, 'live', deps.siteUrl, soonMin)], components: [watchRow(deps.siteUrl)] });
            st.sent[keyLive] = { messageId: msg.id, at: now };
            log(`live alert: ${ev.slug}/${sess.slug}`);
            await store.save();
          } catch (e) { log('live alert failed:', e.message); }
        }

        if (state === 'ended' && !st.sent[keyEnded]) {
          // Record first so a failed edit never retry-spams the channel.
          const existingId = (st.sent[keyLive] && st.sent[keyLive].messageId) || (st.sent[keySoon] && st.sent[keySoon].messageId);
          st.sent[keyEnded] = { messageId: existingId || 'none', at: now };
          if (existingId) {
            try {
              const msg = await channel.messages.fetch(existingId);
              await msg.edit({ embeds: [sessionEmbed(ev, sess, 'ended', deps.siteUrl, soonMin)], components: [watchRow(deps.siteUrl, 'Results on APEX')] });
              log(`ended alert: ${ev.slug}/${sess.slug}`);
            } catch (e) { log('ended edit failed (message gone?):', e.message); }
          }
          await store.save();
        }
      }

      // prune sent-history older than 7 days
      const cutoff = now - 7 * 86400000;
      let pruned = false;
      for (const k of Object.keys(st.sent)) if ((st.sent[k].at || 0) < cutoff) { delete st.sent[k]; pruned = true; }
      if (pruned) await store.save();
    }
    } finally {
      tickInFlight = false;
    }
  }

  /* ── commands ── */
  const commands = [
    { name: 'rolemenu', description: 'Owner: post the supporter-role panel (one embed, 22 driver buttons).', dm_permission: false },
    {
      name: 'alertsmenu', description: 'Owner: post the stream-alerts opt-in panel in this channel.', dm_permission: false,
      options: [
        { type: 7, name: 'channel', description: 'Where session alerts get posted (defaults to this channel)', required: false, channel_types: [0] },
        { type: 8, name: 'role', description: 'Ping role to grant (defaults to Stream Alerts)', required: false },
      ],
    },
    {
      name: 'config', description: 'Owner: view or change bot settings (editable at runtime).', dm_permission: false,
      options: [
        { name: 'view', type: 1, description: 'Show current settings, bindings and panel links' },
        {
          name: 'set', type: 1, description: 'Change one or more settings',
          options: [
            { type: 7, name: 'alerts_channel', description: 'Where session alerts get posted', required: false, channel_types: [0] },
            { type: 8, name: 'alerts_role', description: 'Role pinged by starting-soon alerts', required: false },
            { type: 3, name: 'audio_url', description: 'Default race audio for /watchparty start', required: false },
            { type: 4, name: 'soon_minutes', description: 'Lead time for STARTING SOON alerts (1-120, default 10)', required: false, min_value: 1, max_value: 120 },
          ],
        },
      ],
    },
    { name: 'status', description: 'Owner: bindings, panels, next session, relay and store at a glance.', dm_permission: false },
    {
      name: 'live', description: 'Owner: test-fire an alert embed into the alerts channel.', dm_permission: false,
      options: [
        { type: 4, name: 'round', description: 'Round number (defaults to current/next)', required: false },
        { type: 3, name: 'session', description: 'Session slug: fp1 fp2 fp3 sprint-qualifying sprint qualifying race', required: false },
        {
          type: 3, name: 'state', description: 'Which embed state to fire (default live)', required: false,
          choices: [
            { name: 'starting soon', value: 'soon' },
            { name: 'live now', value: 'live' },
            { name: 'ended', value: 'ended' },
          ],
        },
      ],
    },
    { name: 'emojis', description: 'Owner: upload any missing number emojis to this server.', dm_permission: false },
    {
      name: 'watchparty', description: 'Owner: relay the race AUDIO into a voice channel (bots cannot stream video).', dm_permission: false,
      options: [
        {
          type: 1, name: 'start', description: 'Join a voice channel and play the race audio',
          options: [
            { type: 3, name: 'audio', description: 'Audio URL (HTTP/HTTPS/HLS/m3u8/MP3). Defaults to /config audio_url, then APEX_AUDIO_URL.', required: false },
            { type: 7, name: 'channel', description: 'Voice channel to join (defaults to yours)', required: false, channel_types: [2] }
          ]
        },
        { type: 1, name: 'stop', description: 'Leave the voice channel and stop the relay' },
        { type: 1, name: 'status', description: 'Show whether the audio relay is running' }
      ]
    },
    { name: 'website', description: 'The APEX stream hub — link embed.' },
  ];

  /* ── interactions ── */
  async function onInteraction(interaction) {
    if (interaction.isButton()) {
      if (interaction.customId === 'apex:alerts') return handleAlertsButton(interaction);
      if (interaction.customId.startsWith('apex:grid:')) return handleGridButton(interaction);
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    try {
      const cmd = interaction.commandName;
      if (cmd !== 'website' && interaction.user.id !== OWNER_ID) {
        return interaction.reply({ content: 'Owner-only command.', ephemeral: true });
      }
      const guild = interaction.guild;

      if (cmd === 'website') {
        return interaction.reply({ embeds: [websiteEmbed(deps.siteUrl, deps.discordInvite)], components: [websiteRow(deps.siteUrl, deps.discordInvite)] });
      }

      const st = await store.guild(guild.id);

      if (cmd === 'emojis') {
        await interaction.deferReply({ ephemeral: true });
        await ensureEmojis(guild, st);
        return interaction.editReply({ content: `Emoji set complete: ${Object.keys(st.emojiIds).length} ids stored.` });
      }

      if (cmd === 'rolemenu') {
        await interaction.deferReply({ ephemeral: true });
        await postGridPanel(guild, interaction.channel, st);
        return interaction.editReply({ content: 'Supporter panel posted: one embed, 22 driver buttons. Clicks toggle roles.' });
      }

      if (cmd === 'alertsmenu') {
        await interaction.deferReply({ ephemeral: true });
        const alertsChannel = interaction.options.getChannel('channel') || interaction.channel;
        await postAlertsPanel(guild, interaction.channel, st, interaction.options.getRole('role'), alertsChannel);
        return interaction.editReply({ content: `Alerts panel posted in ${interaction.channel}. Session alerts will go to ${alertsChannel}.` });
      }

      if (cmd === 'config') {
        const sub = interaction.options.getSubcommand();
        if (sub === 'view') {
          const grid = st.panels.grid;
          const alerts = st.panels.alerts;
          return interaction.reply({
            ephemeral: true,
            embeds: [{
              color: APEX_RED,
              title: 'APEX bot configuration',
              fields: [
                { name: 'Alerts channel', value: st.alerts && st.alerts.channelId ? `<#${st.alerts.channelId}>` : 'not set', inline: true },
                { name: 'Alerts role', value: st.alerts && st.alerts.roleId ? `<@&${st.alerts.roleId}>` : 'not set', inline: true },
                { name: 'Soon lead time', value: `${soonMinutesFor(st)} min`, inline: true },
                { name: 'Audio url', value: (st.config.audioUrl || deps.audioUrl || 'not set').slice(0, 80), inline: false },
                { name: 'Grid panel', value: grid ? `https://discord.com/channels/${guild.id}/${grid.channelId}/${grid.messageId}` : 'not posted', inline: false },
                { name: 'Alerts panel', value: alerts ? `https://discord.com/channels/${guild.id}/${alerts.channelId}/${alerts.messageId}` : 'not posted', inline: false },
              ],
            }],
          });
        }
        // set
        const changed = [];
        const ch = interaction.options.getChannel('alerts_channel');
        const role = interaction.options.getRole('alerts_role');
        const audio = interaction.options.getString('audio_url');
        const soon = interaction.options.getInteger('soon_minutes');
        if (ch) { st.alerts = { channelId: ch.id, roleId: st.alerts ? st.alerts.roleId : null }; changed.push(`alerts channel -> ${ch}`); }
        if (role) { st.alerts = { channelId: st.alerts ? st.alerts.channelId : null, roleId: role.id }; changed.push(`alerts role -> ${role.name}`); }
        if (audio !== null) { st.config.audioUrl = audio.trim(); changed.push('audio url updated'); }
        if (soon !== null) { st.config.soonMinutes = soon; changed.push(`soon lead time -> ${soon} min`); }
        if (!changed.length) return interaction.reply({ content: 'Nothing to change - pass at least one option to /config set.', ephemeral: true });
        await store.save();
        return interaction.reply({ content: `Updated:\n- ${changed.join('\n- ')}`, ephemeral: true });
      }

      if (cmd === 'status') {
        const next = nextSession();
        const live = liveSession();
        const relayState = relay.status(guild.id);
        const grid = st.panels.grid;
        return interaction.reply({
          ephemeral: true,
          embeds: [{
            color: live ? APEX_GREEN : APEX_RED,
            title: `APEX Race Control - ${guild.name}`,
            fields: [
              { name: 'Now', value: live ? `LIVE: ${live.ev.name} · ${live.sess.name}` : (next ? `Next: ${next.ev.name} · ${next.sess.name} <t:${Math.floor(next.sess.ts / 1000)}:R>` : 'Season complete'), inline: false },
              { name: 'Alerts', value: st.alerts && st.alerts.channelId ? `<#${st.alerts.channelId}> pinging ${st.alerts.roleId ? `<@&${st.alerts.roleId}>` : 'nobody'}` : 'not configured', inline: false },
              { name: 'Panels', value: `grid: ${grid ? 'posted' : 'not posted'} · alerts: ${st.panels.alerts ? 'posted' : 'not posted'} · legacy reaction panels: ${st.panels.d1 || st.panels.d2 ? 'yes' : 'no'}`, inline: false },
              { name: 'Roles', value: `${Object.keys(st.driverRoles).length}/${ALL_DRIVERS.length} grid roles mapped · ${Object.keys(st.emojiIds).length} emojis stored`, inline: false },
              { name: 'Audio relay', value: relayState ? `${relayState.state}${relayState.paused ? ' (paused, empty room)' : ''} in <#${relayState.channelId}>` : 'not running', inline: false },
              { name: 'Store', value: deps.upstash ? 'Upstash Redis (durable)' : 'local JSON', inline: true },
              { name: 'Soon lead', value: `${soonMinutesFor(st)} min`, inline: true },
            ],
          }],
        });
      }

      if (cmd === 'watchparty') {
        const subcommand = interaction.options.getSubcommand();
        const guildId = guild.id;

        if (subcommand === 'status') {
          const current = relay.status(guildId);
          if (!current) return interaction.reply({ content: 'The audio relay is not running.', ephemeral: true });
          const seconds = Math.round((Date.now() - current.startedAt) / 1000);
          return interaction.reply({
            content: `Audio relay is **${current.state}**${current.paused ? ' (paused - empty room)' : ''} in <#${current.channelId}> for ${Math.floor(seconds / 60)}m ${seconds % 60}s.`,
            ephemeral: true
          });
        }

        if (subcommand === 'stop') {
          const stopped = relay.stop(guildId, { clearSaved: true });
          return interaction.reply({
            content: stopped ? 'Left the voice channel and stopped the relay.' : 'The relay was not running.',
            ephemeral: true
          });
        }

        // start
        if (!relayModule.isAvailable()) {
          return interaction.reply({
            content: 'Voice packages are missing. Install them and restart:\n`npm i @discordjs/voice @discordjs/opus ffmpeg-static`',
            ephemeral: true
          });
        }

        const channel = interaction.options.getChannel('channel') || interaction.member?.voice?.channel;
        if (!channel) return interaction.reply({ content: 'Join a voice channel first, or pass one with `channel:`.', ephemeral: true });
        if (!channel.joinable) return interaction.reply({ content: `I do not have permission to join ${channel}.`, ephemeral: true });
        if (!channel.speakable) return interaction.reply({ content: `I do not have permission to speak in ${channel}.`, ephemeral: true });

        const url = (interaction.options.getString('audio') || st.config.audioUrl || deps.audioUrl || '').trim();
        if (!url) {
          return interaction.reply({
            content: 'No audio source configured. Pass one with `audio:`, or set one with `/config set audio_url:` or `APEX_AUDIO_URL`.',
            ephemeral: true
          });
        }
        if (!/^https?:\/\//i.test(url)) {
          return interaction.reply({ content: 'The audio source must be an http(s) URL.', ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });
        try {
          await relay.start(guild, channel, url);
          pauseIfEmpty(guild, channel);
          return interaction.editReply({
            content: `Race audio is live in ${channel}\nSource: \`${url}\`\n\nThe relay pauses itself when the room is empty and resumes when someone joins.\nVideo stays on the site - Discord bots cannot stream video into a voice channel (see bot/STREAMING.md).`
          });
        } catch (error) {
          return interaction.editReply({ content: `Could not start the relay: ${error.message}` });
        }
      }

      if (cmd === 'live') {
        await interaction.deferReply({ ephemeral: true });
        const round = interaction.options.getInteger('round');
        const slug = interaction.options.getString('session');
        // A supplied round or slug must match. Falling back would post a
        // different session than the one the owner asked to test.
        const found = (round == null && !slug)
          ? (findSession(null, null) || nextSession())
          : findSession(round, slug);
        if (!found) {
          const slugs = SEASON.flatMap(e => e.sessions.map(s => s.slug)).filter((v, i, a) => a.indexOf(v) === i).join(', ');
          return interaction.editReply({ content: `No session found for that round/slug. Valid slugs: ${slugs}` });
        }
        const state = interaction.options.getString('state') || 'live';
        const bound = st.alerts && guild.channels.cache.get(st.alerts.channelId);
        const alertsCh = bound || interaction.channel;
        const msg = await alertsCh.send({
          embeds: [sessionEmbed(found.ev, found.sess, state, deps.siteUrl, soonMinutesFor(st))],
          components: [watchRow(deps.siteUrl, state === 'ended' ? 'Results on APEX' : 'Watch on APEX')],
        });
        const where = bound ? String(alertsCh) : `${alertsCh} (no alerts channel set - posted here)`;
        return interaction.editReply({ content: `Posted ${state} embed for ${found.ev.name} · ${found.sess.name} to ${where}: ${msg.url}` });
      }
    } catch (e) {
      log('command failed:', e.message);
      const payload = { content: `Command failed: ${e.message}`, ephemeral: true };
      if (interaction.deferred || interaction.replied) return interaction.editReply(payload).catch(() => {});
      return interaction.reply(payload).catch(() => {});
    }
  }

  /* ── lifecycle ── */
  let schedulerStarted = false; // ClientReady re-fires on gateway reconnects; start the loop once
  let tickTimer = null;
  client.once(Events.ClientReady, async () => {
    log(`connected as ${client.user.tag}`);
    try {
      const rest = new REST({ version: '10' }).setToken(deps.token);
      if (deps.guildId) {
        await rest.put(Routes.applicationGuildCommands(client.user.id, deps.guildId), { body: commands });
        log(`commands registered (guild-scoped) in ${deps.guildId}`);
      } else {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        log('commands registered (global)');
      }
    } catch (e) { log('command registration failed:', e.message); }

    for (const guild of client.guilds.cache.values()) {
      const st = await store.guild(guild.id);
      discoverDriverRoles(guild, st);
      log(`guild: ${guild.name} — ${Object.keys(st.driverRoles).length} grid roles mapped`);

      // Resume an audio relay that was running before the restart.
      if (st.relay && st.relay.channelId && st.relay.url && relayModule.isAvailable()) {
        const channel = guild.channels.cache.get(st.relay.channelId);
        if (channel) {
          relay.start(guild, channel, st.relay.url, st.relay.attempts || 1)
            .then(() => pauseIfEmpty(guild, channel))
            .catch(e => log(`relay resume failed in ${guild.name}: ${e.message}`));
        } else {
          delete st.relay; await store.save();
        }
      }
    }

    if (!schedulerStarted) {
      schedulerStarted = true;
      tickTimer = setInterval(() => { tick().catch(e => log('tick failed:', e.message)); }, TICK_MS);
      tick().catch(e => log('tick failed:', e.message));
    }
    await syncPresence(Date.now());
  });

  client.on(Events.InteractionCreate, i => { onInteraction(i).catch(e => log('interaction error:', e.message)); });
  client.on(Events.MessageReactionAdd, (r, u) => { handleReaction(r, u, true).catch(() => {}); });
  client.on(Events.MessageReactionRemove, (r, u) => { handleReaction(r, u, false).catch(() => {}); });

  /* Pause the relay when the voice room empties (ffmpeg blocks on the full
     pipe, so CPU drops to ~0) and resume the moment anyone joins. */
  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    try {
      const guild = newState.guild || oldState.guild;
      if (!guild) return;
      const current = relay.status(guild.id);
      if (!current) return;
      if (oldState.channelId !== current.channelId && newState.channelId !== current.channelId) return;
      const channel = guild.channels.cache.get(current.channelId);
      if (!channel) return;
      const humans = channel.members.filter(m => !m.user.bot).size;
      relay.setPaused(guild.id, humans === 0);
    } catch (_) { /* never let a voice event break the bot */ }
  });

  client.on(Events.Error, e => log('client error:', e.message));

  client.login(deps.token).catch(e => log('login failed:', e.message));

  /* Handle for server.js: flush the store during graceful shutdown. */
  return {
    client,
    flush: () => store.save(),
    stop: () => {
      if (tickTimer) clearInterval(tickTimer);
      relay.stopAll();
      try { client.destroy(); } catch (_) {}
    },
  };
}

module.exports = {
  start,
  _test: {
    driverPanelEmbed, alertsPanelEmbed, sessionEmbed, websiteEmbed,
    gridRows, alertsRow,
    nextSession, liveSession, sessionState, findSession, presenceActivity,
    TEAMS, ALL_DRIVERS, OWNER_ID, DEFAULT_SOON_MINUTES, SESSION_MIN,
  },
};
