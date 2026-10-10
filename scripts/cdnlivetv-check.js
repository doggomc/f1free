#!/usr/bin/env node
'use strict';

/* Exercises the cdnlivetv relay end to end, from wherever it will actually run.

   Run this FIRST after a deploy, and first on any new host. It answers the only
   question that matters: can THIS machine reach cdnlivetv and play the channel?
   Everything else in the relay is pure logic and either works everywhere or
   nowhere.

     node scripts/cdnlivetv-check.js                 # the default channel
     node scripts/cdnlivetv-check.js "BBC One" gb    # any channel/code

   Exit code 0 when the chain completes, 1 when any hop fails.

   Four hops, because each one fails differently:
     1  player page   — blocked egress or a geo-fence shows up here as non-200
     2  token         — extraction broke: cdnlivetv changed their obfuscation
     3  playlist      — the token was minted but rejected: signature or expiry
     4  segment       — the playlist lies: no bytes, or not MPEG-TS (not 0x47) */

const relay = require('../lib/cdnlivetv-relay.js');

const name = process.argv[2] || 'sky sports f1';
const code = process.argv[3] || 'gb';

const pad = (s, n) => String(s).padEnd(n);

(async () => {
  console.log(`cdnlivetv relay — ${name} [${code}]\n`);
  let report;
  try {
    report = await relay.selftest(name, code);
  } catch (error) {
    console.log('  FAIL  threw:', error.message);
    process.exit(1);
  }

  const s = report.steps || {};
  const rows = [
    ['1 player page', s.playerPage ? `HTTP ${s.playerPage.http}  ${s.playerPage.ms}ms` : 'not reached'],
    ['2 token', s.token ? `${s.token.ttlSeconds}s ttl  channel ${s.token.channelId}  ${s.token.domain}` : 'not extracted'],
    ['3 playlist', s.playlist ? `${s.playlist.segments} segments  ${s.playlist.ms}ms` : 'not fetched'],
    ['4 segment', s.segment ? `HTTP ${s.segment.http}  ${s.segment.bytes} bytes  first byte 0x${s.segment.firstByte}` : 'not fetched']
  ];
  for (const [label, value] of rows) console.log(`  ${pad(label, 14)} ${value}`);

  if (report.ok) {
    console.log('\nPASS  the whole chain works from this host.');
    process.exit(0);
  }

  console.log(`\nFAIL  ${report.error || 'unknown'}`);
  if (s.playerPage && s.playerPage.http !== 200) {
    console.log('      → the player page itself failed: this host may be blocked or geo-fenced.');
    console.log('        Try a channel from another country code to tell the two apart.');
  } else if (!s.token) {
    console.log('      → the page loaded but the stream url could not be extracted.');
    console.log('        cdnlivetv probably changed their obfuscation: update extractStreamUrl().');
  } else if (s.playlist && !s.playlist.segments) {
    console.log('      → the token was minted but the playlist came back empty.');
  }
  process.exit(1);
})();
