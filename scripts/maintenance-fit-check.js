#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const siteDir = path.resolve(process.env.SITE_DIR || path.join(root, '..', 'netlifyf1'));
const paths = {
  html: path.join(siteDir, 'maintenance.html'),
  css: path.join(siteDir, 'maintenance.css'),
  js: path.join(siteDir, 'maintenance.js')
};

if (!Object.values(paths).every(fs.existsSync)) {
  console.log(`skip maintenance fit check — set SITE_DIR (looked in ${siteDir})`);
  process.exit(0);
}

const html = fs.readFileSync(paths.html, 'utf8');
const css = fs.readFileSync(paths.css, 'utf8');
const js = fs.readFileSync(paths.js, 'utf8');
let failed = 0;
function check(label, condition, detail = '') {
  if (!condition) failed++;
  console.log(`  ${condition ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

check('mobile viewport uses the safe area', /viewport-fit=cover/.test(html));
check('maintenance message and ETA have stable ids',
  /id="maintenanceMessage"/.test(html) && /id="returnEta"/.test(html));
check('connection state is announced accessibly',
  /id="autoStatus"[^>]*role="status"[^>]*aria-live="polite"/.test(html));
check('a no-script fallback exists', /<noscript>[\s\S]*<\/noscript>/.test(html));
check('the page is locked to the small viewport height',
  /height:\s*100svh/.test(css) && /@supports\s*\(height:\s*100dvh\)/.test(css));
check('the one-screen layout prevents accidental page scroll',
  /body\s*\{[\s\S]*?overflow:\s*hidden/.test(css));
check('phone and short-landscape layouts both exist',
  /@media\s*\(max-width:\s*600px\)/.test(css) &&
  /@media\s*\(max-height:\s*560px\)\s*and\s*\(min-aspect-ratio:\s*1\/1\)/.test(css));
check('reduced-motion users do not get looping animation',
  /@media\s*\(prefers-reduced-motion:\s*reduce\)/.test(css));
check('maintenance checks the small site-status endpoint',
  /\/api\/site\/status/.test(js));
check('maintenance prefers SSE over aggressive polling',
  /new EventSource/.test(js) && /sseConnected/.test(js));
check('maintenance files contain no large inline image',
  !/data:image\/(?:png|jpe?g|webp);base64,/i.test(html + css + js));

console.log(`\n${failed ? `${failed} maintenance check(s) failed` : 'Maintenance fit checks passed'}`);
process.exitCode = failed ? 1 : 0;
