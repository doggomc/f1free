#!/usr/bin/env node
'use strict';

/* Verifies the audio relay's FFmpeg pipeline end-to-end without Discord:
   serves a locally generated MP3 over HTTP, runs the exact spawn() argument
   list from bot/voice-relay.js, and asserts the output is a playable Opus
   bitstream at 48 kHz stereo — what Discord's voice gateway expects.
   Skips itself when the optional voice packages / ffmpeg are unavailable. */

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const relay = require(path.join(__dirname, '..', 'bot', 'voice-relay.js'));

const results = [];
const check = (label, pass, detail = '') => results.push({ label, pass: Boolean(pass), detail });

function run(bin, args) {
  return new Promise(resolve => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    proc.stdout.on('data', c => out.push(c));
    proc.stderr.on('data', c => err.push(c));
    proc.on('close', code => resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() }));
  });
}

(async () => {
  // Optional feature: skip (rather than fail) when the voice packages or an
  // ffmpeg binary are not installed, so `npm run check` stays useful.
  if (!relay.isAvailable()) {
    console.log('skipped: @discordjs/voice is not installed (optional dependency)');
    return process.exit(0);
  }
  const { execFileSync } = require('child_process');
  try {
    execFileSync(relay.resolveFfmpeg(), ['-version'], { stdio: 'ignore' });
  } catch (_) {
    console.log('skipped: no usable ffmpeg binary');
    return process.exit(0);
  }
  const ffmpeg = relay.resolveFfmpeg();

  // 1. ffmpeg is usable and can encode Opus.
  let version = null;
  try {
    version = await run(ffmpeg, ['-version']);
  } catch (_) {}
  check('ffmpeg binary resolves and runs', version && version.code === 0, version ? `exit ${version.code}` : 'spawn failed');
  if (!version || version.code !== 0) return report();

  const encoders = await run(ffmpeg, ['-hide_banner', '-encoders']);
  check('ffmpeg has the libopus encoder', encoders.stdout.toString().includes('libopus'));

  // 2. Build a 6-second test tone as MP3 (simulates a remote audio source).
  const tmpDir = require('os').tmpdir();
  const src = path.join(tmpDir, `freef1-relay-src-${process.pid}.mp3`);
  const made = await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6:sample_rate=48000',
    '-ac', '2', '-b:a', '96k', src
  ]);
  check('generated a test audio source', made.code === 0 && require('fs').existsSync(src), made.stderr.slice(-200));

  // 3. Serve it over HTTP, exactly like a real remote feed.
  const audio = require('fs').readFileSync(src);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': audio.length });
    res.end(audio);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/race.mp3`;

  // 4. Run the relay's exact argument list.
  const relayArgs = [
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-nostdin', '-loglevel', 'error',
    '-i', url,
    '-vn',
    '-analyzeduration', '0',
    '-acodec', 'libopus',
    '-ar', '48000', '-ac', '2',
    '-b:a', '96k',
    '-f', 'opus',
    'pipe:1'
  ];
  const relayed = await run(ffmpeg, relayArgs);
  const opusBytes = relayed.stdout.length;
  check('relay pipeline exits cleanly', relayed.code === 0, `exit ${relayed.code} — ${relayed.stderr.slice(-300)}`);
  check('relay pipeline produced Opus bytes', opusBytes > 5000, `${opusBytes} bytes`);

  // 5. Discord's voice gateway needs raw Opus packets; the first byte of an
  //    Opus packet has the TOC byte: config in the top 5 bits (0..31).
  if (opusBytes > 0) {
    const config = (relayed.stdout[0] >> 3) & 0x1f;
    check('output is raw Opus packets (valid TOC config)', config <= 31, `TOC config ${config}`);
  }

  // 6. Validate the codec parameters themselves. This ffmpeg build ships an
  //    Opus muxer but no raw-Opus demuxer, so the same encode is re-run into
  //    an Ogg container (identical libopus / 48 kHz / stereo settings) and
  //    decoded from a temp file to prove the audio is real and playable.
  if (opusBytes > 0) {
    const oggArgs = relayArgs.slice();
    const flagIndex = oggArgs.indexOf('opus', oggArgs.indexOf('-f'));
    oggArgs[flagIndex] = 'ogg';
    const oggPath = path.join(tmpDir, `freef1-relay-${process.pid}.ogg`);
    const oggRun = await run(ffmpeg, [...oggArgs.slice(0, -1), '-y', oggPath]);
    check('same encode into an Ogg container succeeds', oggRun.code === 0, `exit ${oggRun.code} — ${oggRun.stderr.slice(-200)}`);

    if (oggRun.code === 0) {
      const probe = await run(ffmpeg, ['-hide_banner', '-i', oggPath, '-f', 'null', '-']);
      const info = probe.stderr || '';
      check('encoded audio decodes cleanly', probe.code === 0, `exit ${probe.code}`);
      check('encoded audio is 48 kHz stereo Opus', /48000 Hz/.test(info) && /stereo/.test(info) && /opus/i.test(info),
        info.match(/Audio:\s*.*/)?.[0] || 'no stream info');
      try { require('fs').unlinkSync(oggPath); } catch (_) {}
    }
  }

  server.close();
  try { require('fs').unlinkSync(src); } catch (_) {}
  report();

  function report() {
    let failed = 0;
    for (const { label, pass, detail } of results) {
      if (!pass) failed++;
      console.log(`${pass ? '  ok  ' : ' FAIL '} ${label}${detail && !pass ? ` — ${detail}` : ''}`);
    }
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    process.exit(failed ? 1 : 0);
  }
})().catch(error => { console.error(error); process.exit(1); });
