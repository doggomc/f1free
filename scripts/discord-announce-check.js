#! /usr/bin/env node
'use strict';

/* Proves the #links announcements actually happen: that the store emits an
   event when someone links or unlinks, and that the bot turns those events
   into the right message posted in the right channel.

   The bot's announcer is driven for real against a stub guild/channel, so
   this exercises the send path rather than restating it. Run:
   npm run check:announce                                                    */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { createStore } = require('../lib/discord-link.js');
const bot = require('../bot/discord-bot.js');

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then((ok) => { results.push({ name, ok: ok === true, detail: ok === true ? '' : String(ok) }); })
    .catch((error) => { results.push({ name, ok: false, detail: error.message }); });
}

const USER = {
  id: '123456789012345678', username: 'doggomc', globalName: 'Doggo',
  guildId: '999111222333444555',
};

function tmpStore(overrides = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ann-')), 'link.json');
  return createStore({
    fileKey: file,
    secret: 'test-secret-for-checks-only',
    log: () => {},
    ...overrides,
  });
}

/* ── stubs ─────────────────────────────────────────────────────────────── */

function fakeChannel(name, extra = {}) {
  return Object.assign({
    name,
    sent: [],
    isTextBased: () => true,
    async send(text) {
      if (this.failWith) throw new Error(this.failWith);
      this.sent.push(text);
      return { id: 'm1' };
    },
  }, extra);
}

function fakeGuild(channels, opts = {}) {
  const list = channels.map((c) => (typeof c === 'string' ? fakeChannel(c) : c));
  return {
    channels: {
      async fetch() {
        if (opts.fetchThrows) throw new Error('Missing Access');
        return new Map(list.map((c) => [c.name, c]));
      },
      cache: new Map(list.map((c) => [c.name, c])),
    },
  };
}

/* A client that is connected and holds one guild. */
function fakeClient(guild, { ready = true, noGuild = false } = {}) {
  const cache = new Map(noGuild || !guild ? [] : [['999111222333444555', guild]]);
  return {
    isReady: () => ready,
    guilds: { cache, first: () => (cache.values().next().value || null) },
  };
}

/* ── 1. the store emits the events at all ──────────────────────────────── */

(async () => {
  await check('confirming a code emits a "linked" event', async () => {
    const events = [];
    const store = tmpStore({ onLinkEvent: (e) => events.push(e) });
    const { code } = await store.createCode();
    await store.claimCode(code, USER);
    if (events.length !== 0) return 'emitted at claim time, but the site has not confirmed yet';
    await store.confirm(code, true);
    if (events.length !== 1) return `expected 1 event, got ${events.length}`;
    const e = events[0];
    if (e.type !== 'linked') return `type was ${e.type}`;
    if (e.userId !== USER.id) return `userId was ${e.userId}`;
    if (!e.profile || e.profile.username !== 'doggomc') return 'profile missing from event';
    return true;
  });

  await check('a rejected confirmation emits nothing', async () => {
    const events = [];
    const store = tmpStore({ onLinkEvent: (e) => events.push(e) });
    const { code } = await store.createCode();
    await store.claimCode(code, USER);
    await store.confirm(code, false); // user clicked "no"
    return events.length === 0 ? true : `emitted ${JSON.stringify(events)}`;
  });

  await check('/unlink (revoke) emits an "unlinked" event', async () => {
    const events = [];
    const store = tmpStore({ onLinkEvent: (e) => events.push(e) });
    const { code } = await store.createCode();
    await store.claimCode(code, USER);
    await store.confirm(code, true);
    await store.revoke(USER.id, 'unlink');
    if (events.length !== 2) return `expected 2 events, got ${events.length}`;
    const e = events[1];
    if (e.type !== 'unlinked') return `type was ${e.type}`;
    if (e.reason !== 'unlink') return `reason was ${e.reason}`;
    if (e.userId !== USER.id) return `userId was ${e.userId}`;
    return true;
  });

  await check('a member leaving emits an unlink with reason "left"', async () => {
    const events = [];
    const store = tmpStore({ onLinkEvent: (e) => events.push(e) });
    const { code } = await store.createCode();
    await store.claimCode(code, USER);
    await store.confirm(code, true);
    await store.revoke(USER.id, 'left');
    const e = events[events.length - 1];
    if (e.type !== 'unlinked') return `type was ${e.type}`;
    if (e.reason !== 'left') return `reason was ${e.reason}`;
    return true;
  });

  await check('the event still carries the profile after the row is deleted', async () => {
    const events = [];
    const store = tmpStore({ onLinkEvent: (e) => events.push(e) });
    const { code } = await store.createCode();
    await store.claimCode(code, USER);
    await store.confirm(code, true);
    await store.revoke(USER.id, 'left');
    const e = events[events.length - 1];
    /* The row is gone by now, so the announcer can only mention the user if
       the profile was captured before deletion. */
    if (!e.profile || e.profile.id !== USER.id) return 'profile was lost';
    const after = await store.checkUid(USER.id);
    if (after.linked !== false) return 'revoke did not actually delete the row';
    return true;
  });

  await check('revoking someone who was never linked emits nothing', async () => {
    const events = [];
    const store = tmpStore({ onLinkEvent: (e) => events.push(e) });
    const result = await store.revoke('000000000000000000', 'left');
    if (result.wasLinked !== false) return 'claimed to have revoked a stranger';
    return events.length === 0 ? true : `emitted ${JSON.stringify(events)}`;
  });

  await check('a throwing announcer never breaks a link', async () => {
    const store = tmpStore({
      onLinkEvent: () => { throw new Error('announcer exploded'); },
    });
    const { code } = await store.createCode();
    await store.claimCode(code, USER);
    const out = await store.confirm(code, true);
    if (!out || !out.token) return 'confirm failed because the announcer threw';
    const after = await store.checkUid(USER.id);
    return after.linked === true ? true : `linked=${after.linked}`;
  });

  await check('a throwing announcer never breaks a revoke', async () => {
    const store = tmpStore({
      onLinkEvent: () => { throw new Error('announcer exploded'); },
    });
    const { code } = await store.createCode();
    await store.claimCode(code, USER);
    await store.confirm(code, true);
    const result = await store.revoke(USER.id, 'left');
    if (result.wasLinked !== true) return 'revoke did not happen';
    const after = await store.checkUid(USER.id);
    return after.linked === false ? true : `linked=${after.linked}`;
  });

  /* ── 2. the bot turns events into the right message ──────────────────── */

  const { announceLinkEvent, linkAnnouncementText } = bot._test;

  await check('"linked" reads "<@id> has linked their account."', () => {
    const text = linkAnnouncementText({ type: 'linked', userId: '42', profile: USER });
    return text === '<@42> has linked their account.' ? true : text;
  });

  await check('"unlinked" reads "<@id> has unlinked their account."', () => {
    const text = linkAnnouncementText({ type: 'unlinked', userId: '42', reason: 'unlink' });
    return text === '<@42> has unlinked their account.' ? true : text;
  });

  await check('leaving reads "<@id> has left and was unlinked."', () => {
    const text = linkAnnouncementText({ type: 'unlinked', userId: '42', reason: 'left' });
    return text === '<@42> has left and was unlinked.' ? true : text;
  });

  await check('a mention works with no profile at all', () => {
    const text = linkAnnouncementText({ type: 'linked', userId: '77', profile: null });
    return text === '<@77> has linked their account.' ? true : text;
  });

  /* ── 3. the message lands in #links ──────────────────────────────────── */

  await check('the announcement is posted in #links', async () => {
    const links = fakeChannel('links');
    const guild = fakeGuild(['general', 'announcements', links]);
    const ok = await announceLinkEvent(fakeClient(guild), { guildId: '999111222333444555', log: () => {} },
      { type: 'linked', userId: '42', profile: USER });
    if (ok !== true) return 'announceLinkEvent reported failure';
    if (links.sent.length !== 1) return `#links got ${links.sent.length} messages`;
    return links.sent[0] === '<@42> has linked their account.' ? true : links.sent[0];
  });

  await check('#link (old name) also works for servers not renamed yet', async () => {
    const link = fakeChannel('link');
    const guild = fakeGuild(['general', link]);
    await announceLinkEvent(fakeClient(guild), { guildId: '999111222333444555', log: () => {} },
      { type: 'linked', userId: '42', profile: USER });
    return link.sent.length === 1 ? true : `#link got ${link.sent.length}`;
  });

  await check('#links wins when a server has both', async () => {
    const link = fakeChannel('link');
    const links = fakeChannel('links');
    const guild = fakeGuild([link, links]);
    await announceLinkEvent(fakeClient(guild), { guildId: '999111222333444555', log: () => {} },
      { type: 'linked', userId: '42', profile: USER });
    if (links.sent.length !== 1) return `#links got ${links.sent.length}`;
    return link.sent.length === 0 ? true : 'also posted to the old #link';
  });

  await check('unrelated channels are never posted to', async () => {
    const general = fakeChannel('general');
    const rules = fakeChannel('rules');
    const guild = fakeGuild([general, rules]);
    await announceLinkEvent(fakeClient(guild), { guildId: '999111222333444555', log: () => {} },
      { type: 'linked', userId: '42', profile: USER });
    return general.sent.length === 0 && rules.sent.length === 0
      ? true : 'posted into an unrelated channel';
  });

  await check('a decorated channel name ("links" with padding) still matches', () => {
    return bot._test.isLinkChannelName('  Links  ') === true
      && bot._test.isLinkChannelName('🔗links') === false // leading emoji is part of the name; fine
      && bot._test.isLinkChannelName('linking') === false
      ? true : 'name matching is wrong';
  });

  /* ── 4. the announcement never breaks the thing that triggered it ────── */

  await check('no #links channel -> no message, no throw', async () => {
    const guild = fakeGuild(['general']);
    const ok = await announceLinkEvent(fakeClient(guild), { guildId: '999111222333444555', log: () => {} },
      { type: 'linked', userId: '42', profile: USER });
    return ok === false ? true : 'claimed success with nowhere to post';
  });

  await check('bot not connected yet -> silently skipped', async () => {
    const links = fakeChannel('links');
    const guild = fakeGuild([links]);
    const ok = await announceLinkEvent(fakeClient(guild, { ready: false }),
      { guildId: '999111222333444555', log: () => {} },
      { type: 'linked', userId: '42', profile: USER });
    return ok === false && links.sent.length === 0 ? true : 'posted while disconnected';
  });

  await check('guild not in cache -> silently skipped', async () => {
    const ok = await announceLinkEvent(fakeClient(null, { noGuild: true }),
      { guildId: '999111222333444555', log: () => {} },
      { type: 'linked', userId: '42', profile: USER });
    return ok === false ? true : 'claimed success with no guild';
  });

  await check('a channel fetch that throws falls back to the cache', async () => {
    const links = fakeChannel('links');
    const guild = fakeGuild([links], { fetchThrows: true });
    const ok = await announceLinkEvent(fakeClient(guild), { guildId: '999111222333444555', log: () => {} },
      { type: 'linked', userId: '42', profile: USER });
    return ok === true && links.sent.length === 1 ? true : 'cache fallback did not work';
  });

  await check('being unable to speak in the channel is swallowed', async () => {
    const links = fakeChannel('links', { failWith: 'Missing Permissions' });
    const guild = fakeGuild([links]);
    const ok = await announceLinkEvent(fakeClient(guild), { guildId: '999111222333444555', log: () => {} },
      { type: 'linked', userId: '42', profile: USER });
    return ok === false ? true : 'a failed send was reported as success';
  });

  await check('a null event is ignored rather than crashing', async () => {
    const links = fakeChannel('links');
    const guild = fakeGuild([links]);
    const ok = await announceLinkEvent(fakeClient(guild), { guildId: '999111222333444555', log: () => {} }, null);
    return ok === false && links.sent.length === 0 ? true : 'posted for a null event';
  });

  /* ── 4b. a missing privileged intent must not kill the bot ──────────── */

  await check('a disallowed-intent refusal is recognised', () => {
    const { isDisallowedIntentError } = bot._test;
    return isDisallowedIntentError(new Error('Used disallowed intents')) === true
      && isDisallowedIntentError(new Error('Privileged intent provided is not enabled or whitelisted')) === true
      && isDisallowedIntentError({ message: 'close code 4014' }) === true
      ? true : 'did not recognise the refusal';
  });

  await check('a bad token is NOT retried as an intent problem', () => {
    const { isDisallowedIntentError } = bot._test;
    return isDisallowedIntentError(new Error('An invalid token was provided.')) === false
      && isDisallowedIntentError(new Error('TOKEN_MISSING')) === false
      ? true : 'a bad token would trigger a pointless retry loop';
  });

  await check('the GuildMembers bit can actually be dropped at runtime', () => {
    /* client.options.intents is frozen, so .remove() silently no-ops — the
       recovery relies on swapping in a fresh BitField. If that stops working
       the bot would retry with the same intents and never connect. */
    const { Client, GatewayIntentBits, IntentsBitField } = require('discord.js');
    const c = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
    c.options.intents = new IntentsBitField(c.options.intents.bitfield & ~GatewayIntentBits.GuildMembers);
    const ok = c.options.intents.has(GatewayIntentBits.GuildMembers) === false
      && c.options.intents.has(GatewayIntentBits.Guilds) === true;
    try { c.destroy(); } catch (_) {}
    return ok ? true : 'the intent bit could not be cleared';
  });

  /* ── 5. end to end: link on the site, message appears in #links ──────── */

  await check('end to end: link -> "<@42> has linked their account." in #links', async () => {
    const links = fakeChannel('links');
    const guild = fakeGuild(['general', links]);
    const client = fakeClient(guild);
    const deps = { guildId: '999111222333444555', log: () => {} };
    /* Exactly how server.js wires it: the store's events go to the bot's
       announcer, which is late-bound once the client exists. */
    const store = tmpStore({ onLinkEvent: (e) => announceLinkEvent(client, deps, e) });
    const { code } = await store.createCode();
    await store.claimCode(code, USER);
    await store.confirm(code, true);
    await new Promise((r) => setImmediate(r));
    if (links.sent.length !== 1) return `#links got ${links.sent.length} messages`;
    return links.sent[0] === `<@${USER.id}> has linked their account.` ? true : links.sent[0];
  });

  await check('end to end: leave -> "<@42> has left and was unlinked."', async () => {
    const links = fakeChannel('links');
    const guild = fakeGuild(['general', links]);
    const client = fakeClient(guild);
    const deps = { guildId: '999111222333444555', log: () => {} };
    const store = tmpStore({ onLinkEvent: (e) => announceLinkEvent(client, deps, e) });
    const { code } = await store.createCode();
    await store.claimCode(code, USER);
    await store.confirm(code, true);
    await new Promise((r) => setImmediate(r)); // let the link message land
    links.sent.length = 0; // keep only the leave announcement
    await store.revoke(USER.id, 'left');
    await new Promise((r) => setImmediate(r));
    if (links.sent.length !== 1) return `#links got ${links.sent.length} messages`;
    return links.sent[0] === `<@${USER.id}> has left and was unlinked.` ? true : links.sent[0];
  });

  await check('end to end: /unlink -> "<@42> has unlinked their account."', async () => {
    const links = fakeChannel('links');
    const guild = fakeGuild(['general', links]);
    const client = fakeClient(guild);
    const deps = { guildId: '999111222333444555', log: () => {} };
    const store = tmpStore({ onLinkEvent: (e) => announceLinkEvent(client, deps, e) });
    const { code } = await store.createCode();
    await store.claimCode(code, USER);
    await store.confirm(code, true);
    await new Promise((r) => setImmediate(r)); // let the link message land
    links.sent.length = 0;
    await store.revoke(USER.id, 'unlink');
    await new Promise((r) => setImmediate(r));
    if (links.sent.length !== 1) return `#links got ${links.sent.length} messages`;
    return links.sent[0] === `<@${USER.id}> has unlinked their account.` ? true : links.sent[0];
  });

  /* ── report ────────────────────────────────────────────────────────────── */
  const passed = results.filter((r) => r.ok).length;
  console.log('');
  for (const r of results) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  -> ${r.detail}` : ''}`);
  }
  console.log(`\n  ${passed}/${results.length} discord-announce checks passed\n`);
  process.exit(passed === results.length ? 0 : 1);
})();
