'use strict';

/* ══════════════════════════════════════════════════════════════════════════
   APEX Race Audio — voice-channel relay
   ══════════════════════════════════════════════════════════════════════════
   WHAT THIS IS, AND WHAT IT IS NOT
   --------------------------------
   It is NOT a video stream, because Discord does not allow that:

     • Discord's API exposes no "Go Live" endpoint. The STREAM/Video
       permission exists on the OAuth screen but is inert for bot tokens —
       Discord staff have repeatedly stated bots will not be able to send
       video, and the feature request is closed.
     • The only way to push video into a voice channel is a *self-bot*
       (a user token driving an undocumented gateway, e.g.
       @dank074/discord-video-stream). That breaches Discord's Terms of
       Service and gets the account disabled. Do not ship it.

   What IS fully supported is AUDIO: a bot joins a voice channel and plays
   an audio stream, exactly like a music bot. That is what this module does.
   For race day the practical setup is:

     1. Members sit in the "Race Control" voice channel.
     2. The bot joins and plays the race audio (official commentary feed,
        team-radio replays from OpenF1, or any HTTP/HLS audio URL).
     3. The /live and scheduler embeds keep posting the "Watch on APEX"
        button so people get video on the site and audio in Discord.

   If you want synchronised *video* inside Discord, the only official route
   is a Discord Activity (Embedded App SDK) — see bot/STREAMING.md.
   ══════════════════════════════════════════════════════════════════════════ */

const { spawn } = require('child_process');

let voice = null;
let voiceError = null;
try {
  voice = require('@discordjs/voice');
} catch (error) {
  voiceError = error;
}

/* Resolve an ffmpeg binary: explicit override, then the optional
   ffmpeg-static package, then whatever is on PATH. */
function resolveFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try { return require('ffmpeg-static'); } catch (_) { return 'ffmpeg'; }
}

const isAvailable = () => Boolean(voice) && !voiceError;

/**
 * Create a relay controller bound to a discord.js client.
 * @param {object} deps
 * @param {Function} deps.log       logger
 * @param {Function} deps.getState  async () => the whole durable store object
 * @param {Function} deps.save      persist the store (debounced is fine)
 */
function create({ log = (...a) => console.log('[Relay]', ...a), getState, save = () => {} } = {}) {
  const defaultGuild = () => ({ emojiIds: {}, driverRoles: {}, panels: {}, alerts: null, sent: {} });
  /** Persisted per-guild relay settings, created on demand. */
  async function guildState(guildId) {
    if (!getState) return null;
    const state = await getState();
    if (!state.guilds) state.guilds = {};
    if (!state.guilds[guildId]) state.guilds[guildId] = defaultGuild();
    return state.guilds[guildId];
  }
  /** guildId -> { connection, player, resource, ffmpeg, channelId, url, startedAt } */
  const sessions = new Map();

  function stopSession(guildId, { clearSaved = false } = {}) {
    const session = sessions.get(guildId);
    if (!session) return false;
    try { session.player?.stop(true); } catch (_) {}
    try { session.ffmpeg?.kill('SIGKILL'); } catch (_) {}
    try { session.connection?.destroy(); } catch (_) {}
    sessions.delete(guildId);
    if (clearSaved) {
      guildState(guildId).then(state => { if (state) { delete state.relay; save(); } }).catch(() => {});
    }
    return true;
  }

  /**
   * Join a voice channel and relay `url` into it.
   * @param {object} guild     discord.js Guild
   * @param {object} channel   discord.js VoiceBasedChannel
   * @param {string} url       any ffmpeg-readable audio source
   */
  async function start(guild, channel, url) {
    if (!isAvailable()) {
      const error = new Error(
        'Voice relay is not installed. Run: npm i @discordjs/voice @discordjs/opus ffmpeg-static'
      );
      error.code = 'missing-deps';
      throw error;
    }
    if (!guild || !channel) throw new Error('A guild and a voice channel are required.');
    if (!url || typeof url !== 'string') throw new Error('An audio URL is required.');

    stopSession(guild.id);

    const {
      joinVoiceChannel, createAudioPlayer, createAudioResource,
      AudioPlayerStatus, VoiceConnectionStatus, StreamType, NoSubscriberBehavior,
      entersState
    } = voice;

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true // the relay never needs to hear the room
    });

    // Give Discord a few seconds to hand over the UDP endpoint before
    // pushing audio, otherwise the first packets are dropped.
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    } catch (error) {
      connection.destroy();
      throw new Error(`Could not join the voice channel: ${error.message}`);
    }

    const ffmpegPath = resolveFfmpeg();
    // Re-encode to 48 kHz stereo Opus: exactly what Discord's voice gateway
    // expects, so no second transcode happens inside the library.
    const ffmpeg = spawn(ffmpegPath, [
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      '-nostdin', '-loglevel', 'error',
      '-i', url,
      '-vn',                       // drop any video track
      '-analyzeduration', '0',
      '-acodec', 'libopus',
      '-ar', '48000', '-ac', '2',
      '-b:a', '96k',
      '-f', 'opus',
      'pipe:1'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let startupError = '';
    ffmpeg.stderr?.on('data', chunk => { startupError = (startupError + chunk.toString()).slice(-800); });

    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play }
    });

    const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Opus });

    const session = { connection, player, resource, ffmpeg, channelId: channel.id, url, startedAt: Date.now() };
    sessions.set(guild.id, session);

    // Reconnect/robustness: if the stream dies, retry a few times before
    // giving up, because live HLS endpoints drop and come back constantly.
    let retries = 0;
    const MAX_RETRIES = 5;

    player.on('error', error => {
      log(`player error in ${guild.id}: ${error.message}`);
    });

    player.on(AudioPlayerStatus.Idle, () => {
      const current = sessions.get(guild.id);
      if (!current || current.player !== player) return;
      if (ffmpeg.exitCode !== null) {
        // The source ended (or never started).
        if (!startupError && retries < MAX_RETRIES) {
          retries++;
          log(`source ended in ${guild.id}, retry ${retries}/${MAX_RETRIES}`);
          setTimeout(() => start(guild, channel, url).catch(e => log(`retry failed: ${e.message}`)), 2000 * retries);
          return;
        }
        log(`source stopped in ${guild.id}: ${startupError.trim().split('\n').pop() || 'end of stream'}`);
        stopSession(guild.id);
        return;
      }
      // Brief gap in a live source: keep the connection, replay the resource.
      try { player.play(resource); } catch (_) {}
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
        ]);
      } catch (_) {
        connection.destroy();
        sessions.delete(guild.id);
      }
    });

    player.play(resource);
    connection.subscribe(player);

    guildState(guild.id).then(state => {
      if (!state) return;
      state.relay = { channelId: channel.id, url, startedAt: session.startedAt };
      save();
    }).catch(() => {});

    log(`relay started in ${guild.name} → ${channel.name}`);
    return session;
  }

  function status(guildId) {
    const session = sessions.get(guildId);
    if (!session) return null;
    const player = session.player;
    return {
      channelId: session.channelId,
      url: session.url,
      startedAt: session.startedAt,
      state: player ? player.state?.status : 'unknown'
    };
  }

  function stopAll() {
    for (const guildId of [...sessions.keys()]) stopSession(guildId);
  }

  return { start, stop: stopSession, status, stopAll, isAvailable, resolveFfmpeg };
}

module.exports = { create, isAvailable, resolveFfmpeg, voiceError };
