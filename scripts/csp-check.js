#!/usr/bin/env node
'use strict';

/* Keeps the two Content-Security-Policy definitions in step, and keeps every
   typeface on our own origin.

   Why this exists: the site is served from two places with two different
   policies — Netlify reads `_headers` in the front-end repo, while this server
   sets the header itself for local/preview serving (and for the dashboard).
   They drifted once: the Netlify policy was hardened to self-hosted fonts while
   the server kept allowing fonts.googleapis.com/fonts.gstatic.com. A policy that
   only *looks* tightened is worse than none, because it hides violations from
   whichever environment nobody tests.

   Checks:
     1. Directives match between `_headers` and the header this server sends.
     2. No Google Fonts host appears in either policy.
     3. No page, stylesheet or script in the front-end references Google Fonts.
     4. Every @font-face in either fonts.css points at a file that exists.
     5. Every <link rel=preload> href in either index.html resolves to a file.
     6. `media-src` allows data: — the iOS wake-lock fallback loops a 1px
        silent data:video/mp4, which a stricter policy silently blocks
        (found by browser-level CSP instrumentation; it was blocked in both).

   SITE_DIR may point at the front-end checkout; defaults to ../../netlifyf1. */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const siteDir = path.resolve(process.env.SITE_DIR || path.join(root, '..', 'netlifyf1'));

let portCursor = 36200 + Math.floor(Math.random() * 60);
const nextPort = () => (portCursor += 1 + Math.floor(Math.random() * 3));

function parsePolicy(text) {
  const out = new Map();
  for (const part of text.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (!name) continue;
    out.set(name.toLowerCase(), values.join(' ').trim());
  }
  return out;
}

function startServer(env = {}) {
  const port = nextPort();
  const dataDir = env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'freef1-csp-data-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      ADMIN_DIR: path.join(root, 'admin'),
      GEO_ENABLED: 'false',
      GEO_API: 'http://127.0.0.1:9',
      UPSTASH_REDIS_REST_URL: '',
      UPSTASH_REDIS_REST_TOKEN: '',
      PREVIEW_HOST: '127.0.0.1',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', c => { log += c; });
  child.stderr.on('data', c => { log += c; });
  return { child, port, base: `http://127.0.0.1:${port}`, log: () => log };
}

async function waitForServer(server) {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(server.base + '/healthz')).ok) return true; } catch (_) {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`server never came up:\n${server.log()}`);
}

const files = (dir, ext) => fs.readdirSync(dir).filter(f => ext.test(f)).map(f => path.join(dir, f));

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return /node_modules|\.git|data/.test(entry.name) ? [] : walk(full);
    return [full];
  });
}

async function main() {
  const checks = [];
  const check = (label, pass, detail = '') => checks.push({ label, pass: Boolean(pass), detail });
  const missing = [];
  const hasSite = fs.existsSync(path.join(siteDir, 'index.html'));
  if (!hasSite) missing.push(`front-end checkout not found at ${siteDir} (set SITE_DIR)`);

  // ── 1 + 2. The dashboards' own policy vs the header the server sends
  let dashboardCsp = '';
  const server = startServer();
  await waitForServer(server);
  try {
    const res = await fetch(server.base + '/admin', { headers: { Host: '127.0.0.1' } });
    dashboardCsp = res.headers.get('content-security-policy') || '';
    check('the server sends a Content-Security-Policy', dashboardCsp.length > 0, dashboardCsp.slice(0, 80));
  } finally {
    server.child.kill('SIGTERM');
  }

  let siteCsp = '';
  if (hasSite) {
    const headersPath = path.join(siteDir, '_headers');
    const headersFile = fs.readFileSync(headersPath, 'utf8');
    siteCsp = (/Content-Security-Policy:\s*(.+)/.exec(headersFile) || [])[1] || '';
    check('the front-end _headers declares a Content-Security-Policy', siteCsp.length > 0, siteCsp.slice(0, 80));
  }

  if (siteCsp && dashboardCsp) {
    const a = parsePolicy(dashboardCsp), b = parsePolicy(siteCsp);
    const drift = [];
    for (const key of new Set([...a.keys(), ...b.keys()])) {
      const left = (a.get(key) || '(absent)').split(/\s+/).sort().join(' ');
      const right = (b.get(key) || '(absent)').split(/\s+/).sort().join(' ');
      if (left !== right) drift.push(`${key}: server="${left}" vs _headers="${right}"`);
    }
    check('both policies declare the same directives', drift.length === 0, drift.join(' | '));
    for (const [label, policy] of [['server', dashboardCsp], ['_headers', siteCsp]]) {
      check(`${label} policy allows no Google Fonts host`, !/fonts\.(googleapis|gstatic)\.com/.test(policy), policy.slice(0, 60));
      check(`${label} policy allows data: media (iOS wake-lock fallback)`, /media-src[^;]*\bdata:/.test(policy), '');
    }
  }

  // ── 3. Nothing served to a browser may reach for Google Fonts any more.
  //      Comments and the offline downloader (scripts/fetch-fonts.js, the tool
  //      that regenerates the committed woff2 files) are allowed to name the
  //      host; anything a browser would execute is not.
  const stripComments = (text, ext) => text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(ext === '.js' || ext === '.json' ? /(^|[^:])\/\/[^\n]*/g : /(?!)/g, '$1 ');
  if (hasSite) {
    const offenders = [];
    const scanFiles = walk(siteDir).concat(walk(path.join(root, 'admin')))
      .filter(f => /\.(html|css|js|json)$/.test(f) && !/[\\/]scripts[\\/]/.test(f));
    for (const file of scanFiles) {
      const text = stripComments(fs.readFileSync(file, 'utf8'), path.extname(file));
      if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(text)) offenders.push(path.relative(root, file));
    }
    check('no served file references fonts.googleapis.com or fonts.gstatic.com', offenders.length === 0,
      `${offenders.join(', ')}  [scanning ${scanFiles.length} files, comments stripped; scripts/fetch-fonts.js excluded as tooling]`);

    // ── 4. Every @font-face resolves to a committed file
    const fontCss = [path.join(siteDir, 'fonts.css'), path.join(root, 'admin', 'fonts.css')];
    const brokenFaces = [];
    for (const css of fontCss) {
      if (!fs.existsSync(css)) { brokenFaces.push(`${path.relative(root, css)} (missing)`); continue; }
      const dir = path.dirname(css);
      const fileRoot = css.startsWith(siteDir) ? siteDir : root;   // /assets/... is site-root relative
      for (const m of fs.readFileSync(css, 'utf8').matchAll(/src:\s*url\(['"]?([^'")]+)['"]?\)/g)) {
        const url = m[1].split('?')[0];
        const target = url.startsWith('/') ? path.join(fileRoot, url) : path.resolve(dir, url);
        if (!fs.existsSync(target)) brokenFaces.push(`${path.relative(root, css)} → ${m[1]}`);
      }
    }
    check('every @font-face file exists on disk', brokenFaces.length === 0, brokenFaces.join(', '));

    // ── 5. Preloads must resolve, otherwise the browser warns on every load
    const brokenPreloads = [];
    for (const html of [path.join(siteDir, 'index.html'), path.join(siteDir, '404.html'), path.join(root, 'admin', 'index.html')]) {
      if (!fs.existsSync(html)) continue;
      const text = fs.readFileSync(html, 'utf8');
      for (const m of text.matchAll(/<link[^>]+rel=["']preload["'][^>]*>/g)) {
        const raw = (/href=["']([^"']+)["']/.exec(m[0]) || [])[1];
        if (!raw || /^https?:/.test(raw)) continue;
        const href = raw.split('?')[0];
        const isAdminHtml = html.startsWith(path.join(root, 'admin'));
        const target = isAdminHtml
          ? path.join(root, href)                       // /admin/assets/... lives under the admin dir
          : href.startsWith('/') ? path.join(siteDir, href)
            : path.resolve(path.dirname(html), href);
        if (!fs.existsSync(target)) brokenPreloads.push(`${path.relative(root, html)} → ${raw}`);
      }
    }
    check('every local <link rel=preload> resolves', brokenPreloads.length === 0, brokenPreloads.join(', '));
  }

  let failed = 0;
  for (const c of checks) {
    if (!c.pass) failed++;
    console.log(`  ${c.pass ? 'ok  ' : 'FAIL'}  ${c.label}${c.pass || !c.detail ? '' : `  →  ${c.detail}`}`);
  }
  for (const note of missing) console.log(`  skip  ${note}`);
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch(error => {
  console.error('csp-check crashed:', error.message);
  process.exit(1);
});
