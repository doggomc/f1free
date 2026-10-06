#!/usr/bin/env node
'use strict';

/* Runs the front-end's round → OpenF1 meeting_key check as part of this
   repo's `npm run check`, so the Performance view's race-control feed cannot
   silently drift onto the wrong Grand Prix again.

   The check itself lives next to the code it guards
   (netlifyf1/scripts/round-meeting-check.js) and runs offline against a
   recorded OpenF1 payload. SITE_DIR points at that checkout. */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const siteDir = process.env.SITE_DIR || path.resolve(__dirname, '..', '..', 'netlifyf1');
const script = path.join(siteDir, 'scripts', 'round-meeting-check.js');

if (!fs.existsSync(script)) {
  console.error(`Round/meeting check not found at ${script}. Set SITE_DIR.`);
  process.exit(1);
}

const result = spawnSync(process.execPath, [script], { cwd: siteDir, stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
