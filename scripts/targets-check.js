#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  RETIRED_RELAY_IDS,
  SOURCES,
  SOURCE_IDS,
  validateTargetMap
} = require('../lib/stream-catalog.js');

const root = path.resolve(__dirname, '..');
const targetFile = path.join(root, 'data', 'stream-targets.json');
const siteDir = path.resolve(process.env.SITE_DIR || path.join(root, '..', 'netlifyf1'));
let failed = 0;

function check(label, condition, detail = '') {
  if (!condition) failed++;
  console.log(`  ${condition ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

let raw = null;
try { raw = JSON.parse(fs.readFileSync(targetFile, 'utf8')); } catch (error) {
  check('target file is valid JSON', false, error.message);
}

if (raw) {
  const { errors, targets } = validateTargetMap(raw);
  check('all target records are valid', errors.length === 0, errors.join('; '));
  check('every advertised source has a target',
    SOURCES.every(source => targets.has(source.id)),
    SOURCES.filter(source => !targets.has(source.id)).map(source => source.id).join(', '));
  check('no retired relay has a target',
    [...RETIRED_RELAY_IDS].every(id => !(id in raw)),
    [...RETIRED_RELAY_IDS].filter(id => id in raw).join(', '));
  check('source ids are unique', SOURCE_IDS.size === SOURCES.length);
  check('source labels are unique', new Set(SOURCES.map(source => source.label)).size === SOURCES.length);
}

const siteApp = path.join(siteDir, 'app.js');
if (fs.existsSync(siteApp)) {
  const source = fs.readFileSync(siteApp, 'utf8');
  const block = /const sources\s*=\s*\[([\s\S]*?)\n\];/.exec(source)?.[1] || '';
  const clientIds = [...block.matchAll(/\bid\s*:\s*["']([^"']+)["']/g)].map(match => match[1]);
  check('Netlify source ids match the backend catalog',
    JSON.stringify(clientIds) === JSON.stringify(SOURCES.map(source => source.id)),
    `site=${clientIds.join(',')} backend=${SOURCES.map(source => source.id).join(',')}`);
  check('Netlify bundle contains no retired relay ids',
    [...RETIRED_RELAY_IDS].every(id => !block.includes(id)));
} else {
  console.log(`  skip  Netlify source parity (set SITE_DIR; ${siteApp} not found)`);
}

console.log(`\n${failed ? `${failed} target check(s) failed` : 'Target checks passed'}`);
process.exitCode = failed ? 1 : 0;
