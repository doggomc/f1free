'use strict';

/* ════════════════════════════════════════════════════════════════════
   APEX Race Control — Discord companion bot (owner-operated)
   ════════════════════════════════════════════════════════════════════
   Runs in-process with the f1free Express server; started only when
   DISCORD_BOT_TOKEN is set. Everything the owner configures with
   commands is persisted (file locally / Upstash in production), so
   restarts and redeploys keep panels, bindings and sent-history.

   Ownership is hard-coded to a single user id by design (spec):
   every command except /website refuses anyone else, ephemerally.

   Feature set:
     /rolemenu    owner — posts the two-part supporter-role panel;
                          reacting with a driver's number emoji grants
                          the matching "NN | CODE" role, unreacting
                          removes it. (Discord caps reactions per
                          message at 20 and the grid has 22 drivers,
                          so the panel ships as two linked embeds.)
     /alertsmenu  owner — posts the stream-alerts opt-in panel; the
                          reaction grants the ping role.
     /live        owner — force-posts the LIVE embed for a session.
     /emojis      owner — uploads any missing custom number emojis.
     /website     everyone — stylish link embed for the site.
     scheduler    — 10 min before each session start: "STARTING SOON"
                    embed + ping in the alerts channel; at lights-out
                    the same message edits itself into "LIVE NOW"
                    with a Watch button. Deduped via durable store.

   Intents stay unprivileged: Guilds, GuildMessages, GuildMessageReactions
   (+ Message/Reaction partials so panels survive bot restarts).
   ════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const {
  Client, GatewayIntentBits, Partials, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, REST, Routes, Events,
} = require('discord.js');

const OWNER_ID = '915483308522086460';
const SOON_MINUTES = 10;          // lead time for the "starting soon" alert
const LIVE_WINDOW_HOURS = 3;      // how long a session counts as live
const TICK_MS = 15000;            // scheduler resolution
const REACT_GAP_MS = 300;         // breathing room between panel reactions
const APEX_RED = 0xE10600;
const APEX_GREEN = 0x00D57E;
const ROLE_NAME_RE = /^(\d{1,2}) \| ([A-Z]{3})$/;

const SEASON = require('./schedule-2026.json');
SEASON.forEach(ev => ev.sessions.forEach(s => { s.ts = Date.parse(s.start); }));

/* 2026 grid in panel order — colors mirror the site's livery palette. */
const TEAMS = [
  { name: 'Ferrari',         color: 0xDC0000, drivers: [[16, 'LEC'], [44, 'HAM']] },
  { name: 'Mercedes',        color: 0x00D2BE, drivers: [[12, 'ANT'], [63, 'RUS']] },
  { name: 'McLaren',         color: 0xFF8000, drivers: [[1, 'NOR'], [81, 'PIA']] },
  { name: 'Red Bull Racing', color: 0x1E41FF, drivers: [[3, 'VER'], [6, 'HAD']] },
  { name: 'Aston Martin',    color: 0x006F62, drivers: [[14, 'ALO'], [18, 'STR']] },
  { name: 'Williams',        color: 0x005AFF, drivers: [[23, 'ALB'], [55, 'SAI']] },
  { name: 'Haas',            color: 0xE6E6E6, drivers: [[31, 'OCO'], [87, 'BEA']] },
  { name: 'Audi',            color: 0xE62213, drivers: [[5, 'BOR'], [27, 'HUL']] },
  { name: 'Racing Bulls',    color: 0x6692FF, drivers: [[30, 'LAW'], [41, 'LIN']] },
  { name: 'Alpine',          color: 0xFF0080, drivers: [[10, 'GAS'], [43, 'COL']] },
  { name: 'Cadillac',        color: 0xB4A07A, drivers: [[11, 'PER'], [77, 'BOT']] },
];
const ALL_DRIVERS = TEAMS.flatMap(t => t.drivers.map(([n, c]) => ({ num: n, code: c, team: t.name, color: t.color })));
/* Reaction cap is 20 per message → split 10 / 12 drivers by team block. */
const PANEL_SPLIT = 5; // teams in part one

/* ───────────────────────── embed builders (pure, testable) ───────────────────────── */

function driverPanelEmbed(teamsSlice, partLabel) {
  const lines = teamsSlice.map(t =>
    `**${t.name.toUpperCase()}**\n` + t.drivers.map(([n, c]) => `\`${String(n).padStart(2, ' ')}\`  ${c}`).join('    ')
  ).join('\n\n');
  return {
    color: APEX_RED,
    title: `SUPPORTER ROLES — ${partLabel}`,
    description: `React with a driver's number to wear their colours.\nRemove your reaction to take the role off.\n\n${lines}`,
    footer: { text: 'APEX · freef1.netlify.app · independent fan project' },
  };
}

function alertsPanelEmbed(roleName) {
  return {
    color: APEX_RED,
    title: 'STREAM ALERTS',
    description:
      `React below to join **${roleName}** — the role that gets pinged\n` +
      `the moment a session goes live.\n\n` +
      `Remove your reaction to opt out.`,
    footer: { text: 'APEX · freef1.netlify.app · independent fan project' },
  };
}

function sessionEmbed(ev, sess, state, siteUrl) {
  const sec = Math.floor(sess.ts / 1000);
  const live = state === 'live';
  return {
    color: live ? APEX_GREEN : APEX_RED,
    title: live ? 'LIVE NOW' : 'STARTING SOON',
    description:
      `**${ev.name}**\n` +
      `${sess.name}  ·  <t:${sec}:F>  ·  <t:${sec}:R>\n\n` +
      (live
        ? 'The feed is up — grab a seat in the cockpit.'
        : `Lights out in about ${SOON_MINUTES} minutes. Settle in.`),
    fields: [
      { name: 'Round', value: `${ev.round} · ${ev.locality}, ${ev.country}`, inline: true },
      { name: 'Format', value: ev.sprint ? 'Sprint weekend' : 'Standard weekend', inline: true },
    ],
    footer: { text: 'APEX · freef1.netlify.app · independent fan project' },
    url: siteUrl,
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
    new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(label).setURL(siteUrl)
  );
}

function websiteRow(siteUrl, inviteUrl) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel('Open APEX').setURL(siteUrl),
    new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel('Server invite').setURL(inviteUrl)
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

function findSession(round, sessionSlug) {
  const ev = SEASON.find(e => e.round === Number(round)) || nextSession()?.ev;
  if (!ev) return null;
  const sess = ev.sessions.find(s => s.slug === sessionSlug) || ev.sessions.find(s => s.ts <= Date.now() && Date.now() - s.ts < 3 * 3600000) || ev.sessions.find(s => s.ts > Date.now());
  return sess ? { ev, sess } : null;
}

/* ───────────────────────── bot ───────────────────────── */

function start(deps) {
  const log = deps.log || ((...a) => console.log('[Bot]', ...a));
  const EMOJI_DIR = path.join(__dirname, 'assets', 'emoji');

  /* ── durable store: file locally, Upstash in production ── */
  let storeCache = null;
  let saveTimer = null;
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
    save() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        try {
          if (deps.upstash) await deps.upstash(['SET', deps.redisKey, JSON.stringify(storeCache)]);
          else deps.writeLocalJson(deps.fileKey, storeCache);
        } catch (e) { log('store save failed:', e.message); }
      }, 400);
    },
    async guild(guildId) {
      const s = await this.load();
      if (!s.guilds[guildId]) {
        s.guilds[guildId] = { emojiIds: {}, driverRoles: {}, panels: {}, alerts: null, sent: {} };
      }
      return s.guilds[guildId];
    },
  };

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Message, Partials.Reaction],
  });

  /* ── emoji management ── */
  async function ensureEmojis(guild, st) {
    const wanted = [...ALL_DRIVERS.map(d => ({ key: String(d.num), file: `n${d.num}.png` })), { key: 'live', file: 'apexlive.png' }];
    for (const w of wanted) {
      const existing = guild.emojis.cache.find(e => e.name === (w.key === 'live' ? 'apexlive' : `n${w.key}`));
      if (existing) { st.emojiIds[w.key] = existing.id; continue; }
      if (st.emojiIds[w.key] && guild.emojis.cache.has(st.emojiIds[w.key])) continue;
      try {
        const buf = fs.readFileSync(path.join(EMOJI_DIR, w.file));
        const created = await guild.emojis.create({ name: w.key === 'live' ? 'apexlive' : `n${w.key}`, attachment: buf, reason: 'APEX reaction panels' });
        st.emojiIds[w.key] = created.id;
        log(`emoji uploaded: ${created.name}`);
      } catch (e) {
        log(`emoji upload failed (${w.file}):`, e.message);
      }
    }
    store.save();
  }

  function discoverDriverRoles(guild, st) {
    const map = {};
    for (const role of guild.roles.cache.values()) {
      const m = ROLE_NAME_RE.exec(role.name);
      if (m) map[m[1]] = role.id;
    }
    st.driverRoles = map;
    store.save();
    return map;
  }

  /* ── panel posting ── */
  async function postDriverPanels(guild, channel, st) {
    await ensureEmojis(guild, st);
    const roles = discoverDriverRoles(guild, st);
    const missing = ALL_DRIVERS.filter(d => !roles[String(d.num)]).map(d => d.num);
    if (missing.length) throw new Error(`missing grid roles for numbers: ${missing.join(', ')}`);

    // retire previous panels so a rerun rebuilds cleanly
    for (const key of ['d1', 'd2']) {
      const old = st.panels[key];
      if (old) {
        try { const ch = guild.channels.cache.get(old.channelId); const msg = await ch?.messages.fetch(old.messageId); await msg?.delete(); } catch (_) {}
      }
      delete st.panels[key];
    }

    const halves = [TEAMS.slice(0, PANEL_SPLIT), TEAMS.slice(PANEL_SPLIT)];
    const labels = ['GRID 1/2', 'GRID 2/2'];
    for (let i = 0; i < 2; i++) {
      const msg = await channel.send({ embeds: [driverPanelEmbed(halves[i], labels[i])] });
      st.panels[i === 0 ? 'd1' : 'd2'] = { channelId: channel.id, messageId: msg.id };
      for (const [num] of halves[i].flatMap(t => t.drivers)) {
        try { await msg.react(st.emojiIds[String(num)]); await new Promise(r => setTimeout(r, REACT_GAP_MS)); }
        catch (e) { log('react failed:', e.message); }
      }
    }
    store.save();
  }

  async function postAlertsPanel(guild, channel, st, role) {
    await ensureEmojis(guild, st);
    let target = role;
    if (!target) {
      target = guild.roles.cache.find(r => r.name === 'Stream Alerts');
      if (!target) {
        target = await guild.roles.create({ name: 'Stream Alerts', color: APEX_RED, reason: 'APEX stream alerts opt-in' });
      }
    }
    const old = st.panels.alerts;
    if (old) {
      try { const ch = guild.channels.cache.get(old.channelId); const msg = await ch?.messages.fetch(old.messageId); await msg?.delete(); } catch (_) {}
    }
    const msg = await channel.send({ embeds: [alertsPanelEmbed(target.name)] });
    try { await msg.react(st.emojiIds.live); } catch (e) { log('alerts react failed:', e.message); }
    st.panels.alerts = { channelId: channel.id, messageId: msg.id };
    st.alerts = { channelId: channel.id, roleId: target.id };
    store.save();
  }

  /* ── reaction role handling ── */
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
    if (!panelKey) return;

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

  /* ── scheduler: soon → live, edit-in-place ── */
  async function tick() {
    const s = await store.load();
    const now = Date.now();
    for (const guildId of Object.keys(s.guilds)) {
      const st = s.guilds[guildId];
      if (!st.alerts || !st.alerts.channelId) continue;
      const guild = client.guilds.cache.get(guildId);
      const channel = guild && guild.channels.cache.get(st.alerts.channelId);
      if (!channel) continue;

      for (const ev of SEASON) for (const sess of ev.sessions) {
        const dt = sess.ts - now;
        const keySoon = `${ev.slug}:${sess.slug}:soon`;
        const keyLive = `${ev.slug}:${sess.slug}:live`;

        if (dt > 0 && dt <= SOON_MINUTES * 60000 && !st.sent[keySoon]) {
          try {
            const content = st.alerts.roleId ? `<@&${st.alerts.roleId}>` : '';
            const msg = await channel.send({
              content,
              embeds: [sessionEmbed(ev, sess, 'soon', deps.siteUrl)],
              components: [watchRow(deps.siteUrl)],
              allowedMentions: { roles: st.alerts.roleId ? [st.alerts.roleId] : [] },
            });
            st.sent[keySoon] = { messageId: msg.id, at: now };
            log(`soon alert: ${ev.slug}/${sess.slug}`);
            store.save();
          } catch (e) { log('soon alert failed:', e.message); }
        }

        if (dt <= 0 && dt > -LIVE_WINDOW_HOURS * 3600000 && !st.sent[keyLive]) {
          try {
            const soonMsgId = st.sent[keySoon] && st.sent[keySoon].messageId;
            let msg = null;
            if (soonMsgId) {
              try { msg = await channel.messages.fetch(soonMsgId); await msg.edit({ embeds: [sessionEmbed(ev, sess, 'live', deps.siteUrl)], components: [watchRow(deps.siteUrl)] }); }
              catch (_) { msg = null; }
            }
            if (!msg) msg = await channel.send({ embeds: [sessionEmbed(ev, sess, 'live', deps.siteUrl)], components: [watchRow(deps.siteUrl)] });
            st.sent[keyLive] = { messageId: msg.id, at: now };
            log(`live alert: ${ev.slug}/${sess.slug}`);
            store.save();
          } catch (e) { log('live alert failed:', e.message); }
        }
      }

      // prune sent-history older than 7 days
      const cutoff = now - 7 * 86400000;
      let pruned = false;
      for (const k of Object.keys(st.sent)) if ((st.sent[k].at || 0) < cutoff) { delete st.sent[k]; pruned = true; }
      if (pruned) store.save();
    }
  }

  /* ── commands ── */
  const commands = [
    { name: 'rolemenu', description: 'Owner: post the supporter-role reaction panels (two parts).', dm_permission: false },
    {
      name: 'alertsmenu', description: 'Owner: post the stream-alerts opt-in panel in this channel.', dm_permission: false,
      options: [{ type: 8, name: 'role', description: 'Ping role to grant (defaults to Stream Alerts)', required: false }],
    },
    {
      name: 'live', description: 'Owner: force-post the LIVE embed for a session.', dm_permission: false,
      options: [
        { type: 4, name: 'round', description: 'Round number (defaults to current/next)', required: false },
        { type: 3, name: 'session', description: 'Session slug: fp1 fp2 fp3 sprint-qualifying sprint qualifying race', required: false },
      ],
    },
    { name: 'emojis', description: 'Owner: upload any missing number emojis to this server.', dm_permission: false },
    { name: 'website', description: 'The APEX stream hub — link embed.' },
  ];

  async function onInteraction(interaction) {
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
        await postDriverPanels(guild, interaction.channel, st);
        return interaction.editReply({ content: 'Supporter panels posted. Reactions are live.' });
      }

      if (cmd === 'alertsmenu') {
        await interaction.deferReply({ ephemeral: true });
        await postAlertsPanel(guild, interaction.channel, st, interaction.options.getRole('role'));
        return interaction.editReply({ content: `Alerts panel posted in ${interaction.channel}. Sessions will ping here.` });
      }

      if (cmd === 'live') {
        await interaction.deferReply({ ephemeral: true });
        const found = findSession(interaction.options.getInteger('round'), interaction.options.getString('session')) || nextSession();
        if (!found) return interaction.editReply({ content: 'No session found.' });
        const msg = await interaction.channel.send({ embeds: [sessionEmbed(found.ev, found.sess, 'live', deps.siteUrl)], components: [watchRow(deps.siteUrl)] });
        return interaction.editReply({ content: `Posted: ${msg.url}` });
      }
    } catch (e) {
      log('command failed:', e.message);
      const payload = { content: `Command failed: ${e.message}`, ephemeral: true };
      if (interaction.deferred || interaction.replied) return interaction.editReply(payload).catch(() => {});
      return interaction.reply(payload).catch(() => {});
    }
  }

  /* ── lifecycle ── */
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
    }
    setInterval(() => { tick().catch(e => log('tick failed:', e.message)); }, TICK_MS);
    tick().catch(e => log('tick failed:', e.message));
  });

  client.on(Events.InteractionCreate, i => { onInteraction(i).catch(e => log('interaction error:', e.message)); });
  client.on(Events.MessageReactionAdd, (r, u) => { handleReaction(r, u, true).catch(() => {}); });
  client.on(Events.MessageReactionRemove, (r, u) => { handleReaction(r, u, false).catch(() => {}); });
  client.on(Events.Error, e => log('client error:', e.message));

  client.login(deps.token).catch(e => log('login failed:', e.message));
  return client;
}

module.exports = {
  start,
  _test: { driverPanelEmbed, alertsPanelEmbed, sessionEmbed, websiteEmbed, nextSession, findSession, TEAMS, ALL_DRIVERS, OWNER_ID, SOON_MINUTES },
};
