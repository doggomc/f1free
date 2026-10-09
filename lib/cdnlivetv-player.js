'use strict';

/* Builds the HTML page that the cockpit's <iframe> loads for a cdnlivetv source.

   Why a page and not the playlist: an <iframe> cannot render an .m3u8 — the
   browser would treat it as a download. The cockpit frames every source, so the
   relay has to answer with a real document that plays HLS inside it. hls.js is
   inlined from vendor/ at first use and cached, so the page has no CDN
   dependency and no external request at all. */

const fs = require('fs');
const path = require('path');

const HLS_PATH = path.resolve(__dirname, '..', 'vendor', 'hls.min.js');
let hlsCache = null;

function hlsSource() {
  if (hlsCache === null) {
    try {
      hlsCache = fs.readFileSync(HLS_PATH, 'utf8');
    } catch (_) {
      hlsCache = '';   // page falls back to native HLS, or a clear message
    }
  }
  return hlsCache;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* `src` is a same-origin path to the relay playlist route, so the page needs no
   origin detection at all — it is served by the same host that serves it. */
function buildPlayerPage({ title, src } = {}) {
  const safeTitle = escapeHtml(title || 'Live stream');
  const safeSrc = JSON.stringify(String(src || '/relay/cdnlivetv/m3u8'));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${safeTitle}</title>
<style>
  :root{--acc:#ff0046;--fg:#e8eef2;--dim:#8fa3ad}
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;background:#000;color:var(--fg);overflow:hidden;
    font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}
  #stage{position:fixed;inset:0;background:#000}
  video{width:100%;height:100%;display:block;background:#000;object-fit:contain;outline:none}
  .ov{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
      flex-direction:column;gap:14px;text-align:center;background:#000;z-index:30;transition:opacity .35s}
  .ov.hide{opacity:0;pointer-events:none}
  .spin{width:38px;height:38px;border:3px solid rgba(255,0,70,.22);border-top-color:var(--acc);
      border-radius:50%;animation:sp 1s linear infinite}
  @keyframes sp{to{transform:rotate(360deg)}}
  .ov h2{margin:0;font-size:17px;font-weight:600}
  .ov p{margin:0;color:var(--dim);max-width:80%;font-size:13px}
  .ov button{background:var(--acc);color:#fff;border:0;padding:10px 22px;border-radius:6px;
      font-size:14px;font-weight:600;cursor:pointer}
  #bar{position:absolute;top:0;left:0;right:0;padding:12px 14px;z-index:20;display:flex;
      align-items:center;gap:10px;background:linear-gradient(180deg,rgba(0,0,0,.72),transparent);
      opacity:0;transition:opacity .25s;pointer-events:none}
  #bar.show{opacity:1}
  .live{background:var(--acc);color:#fff;font-size:10px;font-weight:700;letter-spacing:.09em;
      padding:3px 8px;border-radius:3px;display:flex;align-items:center;gap:5px}
  .live i{width:6px;height:6px;border-radius:50%;background:#fff;animation:pulse 1.6s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}
  .ttl{font-weight:600;font-size:14px;text-shadow:0 1px 3px #000;flex:1;
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #stats{font-size:11px;color:var(--dim);font-variant-numeric:tabular-nums;text-shadow:0 1px 3px #000}
  video::-webkit-media-controls{display:none}
  video::-moz-media-controls{display:none}
</style>
</head>
<body>
<div id="stage">
  <video id="v" playsinline webkit-playsinline crossorigin="anonymous"></video>
  <div id="bar">
    <span class="live"><i></i>LIVE</span>
    <span class="ttl" id="ttl">${safeTitle}</span>
    <span id="stats"></span>
  </div>
  <div class="ov" id="ovLoad"><div class="spin"></div><p>Connecting to stream…</p></div>
  <div class="ov hide" id="ovErr"><h2>Stream unavailable</h2><p id="errMsg"></p>
       <button id="bRetry">Retry</button></div>
  <div class="ov hide" id="ovTap" style="cursor:pointer"><h2>Tap to enable sound</h2>
       <p>Your browser blocked autoplay with audio.</p></div>
</div>
<script>${hlsSource()}</script>
<script>
(function(){
  "use strict";
  var SRC = ${safeSrc};
  var v = document.getElementById('v');
  var ovLoad = document.getElementById('ovLoad');
  var ovErr  = document.getElementById('ovErr');
  var ovTap  = document.getElementById('ovTap');
  var errMsg = document.getElementById('errMsg');
  var hls = null;

  function hide(el){ el.classList.add('hide'); }
  function show(el){ el.classList.remove('hide'); }
  function fail(msg){ hide(ovLoad); errMsg.textContent = msg; show(ovErr); }

  function play(){
    var p = v.play();
    if (p && p.catch) p.catch(function(){
      v.muted = true;
      var q = v.play();
      if (q && q.catch) q.catch(function(){ show(ovTap); }); else show(ovTap);
    });
  }

  function start(){
    if (!window.Hls || !window.Hls.isSupported()) {
      if (v.canPlayType('application/vnd.apple.mpegurl')) { v.src = SRC; v.play(); return; }
      fail('This browser cannot play HLS.');
      return;
    }
    hls = new window.Hls({
      liveSyncDurationCount: 3,
      maxBufferLength: 30,
      backBufferLength: 30,
      enableWorker: true
    });
    hls.loadSource(SRC);
    hls.attachMedia(v);

    hls.on(window.Hls.Events.LEVEL_LOADED, function(){ hide(ovLoad); play(); });
    hls.on(window.Hls.Events.ERROR, function(ev, d){
      if (!d || !d.fatal) return;
      if (d.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
        // The playlist route re-mints its own token, so this is nearly always
        // transient. Back off, then ask for a fresh manifest.
        setTimeout(function(){
          try { hls.loadSource(SRC); hls.startLoad(); } catch (_) {}
        }, 1500);
        return;
      }
      if (d.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
        try { hls.recoverMediaError(); } catch (_) {}
        return;
      }
      fail('Playback could not start. ' + (d.details || ''));
    });
  }

  v.addEventListener('playing', function(){ hide(ovLoad); });
  v.addEventListener('waiting', function(){ if (!v.paused) show(ovLoad); });
  v.addEventListener('error', function(){ fail('Media error — reload to try again.'); });
  ovTap.onclick = function(){ v.muted = false; hide(ovTap); v.play(); };
  document.getElementById('bRetry').onclick = function(){ location.reload(); };

  var bar = document.getElementById('bar'), stats = document.getElementById('stats'), tmr;
  function poke(){
    bar.classList.add('show');
    clearTimeout(tmr);
    tmr = setTimeout(function(){ if (!v.paused) bar.classList.remove('show'); }, 2600);
  }
  ['mousemove','touchstart','click'].forEach(function(e){
    document.addEventListener(e, poke, { passive: true });
  });
  poke();

  setInterval(function(){
    if (!v.videoWidth) return;
    var bw = hls ? Math.round((hls.bandwidthEstimate || 0) / 1000) : 0;
    var buf = v.buffered.length ? Math.round(v.buffered.end(v.buffered.length - 1) - v.currentTime) : 0;
    stats.textContent = v.videoWidth + '×' + v.videoHeight +
                        (bw ? '  ' + bw + ' kbps' : '') + '  +' + buf + 's';
  }, 1000);

  v.muted = true;
  start();
})();
</script>
</body>
</html>`;
}

module.exports = { buildPlayerPage };
