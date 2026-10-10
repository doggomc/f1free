'use strict';

/* Builds the HTML page that the cockpit's <iframe> loads for a cdnlivetv source.

   Why a page and not the playlist: an <iframe> cannot render an .m3u8 — the
   browser would treat it as a download. The cockpit frames every source, so the
   relay has to answer with a real document that plays HLS inside it. hls.js is
   inlined from vendor/ at first use and cached, so the page has no CDN
   dependency and makes no external request of its own.

   The native <video> controls are hidden, so this page MUST render its own.
   They are hidden because the cockpit's frame is sized and positioned by the
   site, and the stock controls vary wildly between browsers (and are not
   styleable) — but that only works if a real control bar is supplied here. */

const fs = require('fs');
const path = require('path');

const HLS_PATH = path.resolve(__dirname, '..', 'vendor', 'hls.min.js');
let hlsCache = null;

function hlsSource() {
  if (hlsCache === null) {
    try {
      hlsCache = fs.readFileSync(HLS_PATH, 'utf8');
    } catch (_) {
      hlsCache = '';   // page falls back to native HLS, or says so plainly
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
  /* Native controls are replaced by #ctl below — see the note at the top. */
  video::-webkit-media-controls{display:none}
  video::-moz-media-controls{display:none}

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

  /* ── chrome: both bars fade out together, and stay put while paused ── */
  #bar,#ctl{position:absolute;left:0;right:0;z-index:20;display:flex;align-items:center;
      opacity:0;transition:opacity .25s;pointer-events:none}
  #bar{top:0;padding:12px 14px;gap:10px;
      background:linear-gradient(180deg,rgba(0,0,0,.72),transparent)}
  #ctl{bottom:0;padding:14px;gap:8px;
      background:linear-gradient(0deg,rgba(0,0,0,.80),transparent)}
  #stage.show-ui #bar,#stage.show-ui #ctl{opacity:1;pointer-events:auto}

  /* Top bar carries only the stats readout. The LIVE badge and channel title
     that used to occupy the top-left corner are gone by request; the stats are
     pushed right so they do not sit over the middle of the picture. */
  #stats{margin-left:auto;font-size:11px;color:var(--dim);font-variant-numeric:tabular-nums;
      text-shadow:0 1px 3px #000;flex:0 0 auto}

  .btn{background:rgba(255,255,255,.12);border:0;color:#fff;width:36px;height:36px;
      border-radius:6px;cursor:pointer;display:flex;align-items:center;justify-content:center;
      padding:0;flex:0 0 auto;transition:background .15s}
  .btn:hover{background:rgba(255,255,255,.28)}
  .btn:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
  .btn svg{width:18px;height:18px;fill:#fff;pointer-events:none}
  #time{font-size:11px;color:var(--dim);font-variant-numeric:tabular-nums;
      min-width:52px;text-align:center}
  .spacer{flex:1}
  select{background:rgba(255,255,255,.12);color:#fff;border:0;border-radius:6px;
      padding:7px;font-size:11px;cursor:pointer;outline:none;flex:0 0 auto}
  select option{background:#111;color:#fff}

  /* ── narrow screens ────────────────────────────────────────────────────
     The frame is only ~286px wide on a 320px phone. Measured there, the
     stats readout held 153px it would not give up and squeezed the channel
     title to 32px, so the label was clipped to nothing. Below 480px the
     stats go and the title gets the room; below 340px the behind-live
     readout goes too, so the buttons always survive.

     Buttons grow to 44px because the 36px targets are below the touch
     minimum, and the bottom bar clears the home indicator on notched
     phones with env(safe-area-inset-bottom). */
  @media (max-width: 480px){
    #stats{display:none}
    #bar{padding:10px 12px}
    #ctl{padding:10px 12px calc(10px + env(safe-area-inset-bottom, 0px));
         padding-bottom:calc(10px + env(safe-area-inset-bottom, 0px))}
    .btn{width:44px;height:44px}
    .btn svg{width:20px;height:20px}
    #time{min-width:44px}
  }
  @media (max-width: 340px){
    #time{display:none}
  }
  @media (pointer: coarse){
    /* Touch devices: bigger targets regardless of width (tablets). */
    .btn{width:44px;height:44px}
    .btn svg{width:20px;height:20px}
  }
</style>
</head>
<body>
<div id="stage" class="show-ui">
  <video id="v" playsinline webkit-playsinline crossorigin="anonymous"></video>

  <div id="bar">
    <span id="stats"></span>
  </div>

  <div id="ctl">
    <button class="btn" id="bPlay" type="button" title="Play / Pause" aria-label="Play">
      <svg id="iPlay" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
      <svg id="iPause" viewBox="0 0 24 24" style="display:none"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>
    </button>
    <button class="btn" id="bMute" type="button" title="Unmute" aria-label="Unmute">
      <svg id="iVol" viewBox="0 0 24 24" style="display:none"><path d="M4 9v6h4l5 4V5L8 9H4zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/></svg>
      <svg id="iMute" viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4zm14.6 3l2.4-2.4-1.2-1.2-2.4 2.4-2.4-2.4-1.2 1.2 2.4 2.4-2.4 2.4 1.2 1.2 2.4-2.4 2.4 2.4 1.2-1.2z"/></svg>
    </button>
    <span id="time">--:--</span>
    <select id="qual" title="Quality" style="display:none"><option value="-1">Auto</option></select>
    <span class="spacer"></span>
    <button class="btn" id="bLive" type="button" title="Jump to live edge" aria-label="Jump to live">LIVE</button>
    <button class="btn" id="bFs" type="button" title="Fullscreen" aria-label="Fullscreen">
      <svg id="iFsOn" viewBox="0 0 24 24"><path d="M4 9V4h5v2H6v3H4zm11-5h5v5h-2V6h-3V4zM4 15h2v3h3v2H4v-5zm14 0h2v5h-5v-2h3v-3z"/></svg>
      <svg id="iFsOff" viewBox="0 0 24 24" style="display:none"><path d="M9 9V4H7v3H4v2h5zm6 0h5V7h-3V4h-2v5zm0 6h5v-2h-3v-3h-2v5zM4 15h5v-5H7v3H4v2z"/></svg>
    </button>
  </div>

  <div class="ov" id="ovLoad"><div class="spin"></div><p>Connecting to stream…</p></div>
  <div class="ov hide" id="ovErr"><h2>Stream unavailable</h2><p id="errMsg"></p>
       <button id="bRetry" type="button">Retry</button></div>
  <div class="ov hide" id="ovTap" style="cursor:pointer"><h2>Tap to enable sound</h2>
       <p>Your browser blocked autoplay with audio.</p></div>
</div>

<script>${hlsSource()}</script>
<script>
(function(){
  "use strict";
  var SRC = ${safeSrc};
  var v = document.getElementById('v');
  var stage = document.getElementById('stage');
  var ovLoad = document.getElementById('ovLoad');
  var ovErr  = document.getElementById('ovErr');
  var ovTap  = document.getElementById('ovTap');
  var errMsg = document.getElementById('errMsg');
  var bPlay = document.getElementById('bPlay');
  var bMute = document.getElementById('bMute');
  var bFs   = document.getElementById('bFs');
  var bLive = document.getElementById('bLive');
  var iPlay = document.getElementById('iPlay');
  var iPause= document.getElementById('iPause');
  var iVol  = document.getElementById('iVol');
  var iMute = document.getElementById('iMute');
  var iFsOn = document.getElementById('iFsOn');
  var iFsOff= document.getElementById('iFsOff');
  var timeEl= document.getElementById('time');
  var qual  = document.getElementById('qual');
  var stats = document.getElementById('stats');
  var hls = null, levels = [];
  /* A live playlist is re-fetched every few seconds, so LEVEL_LOADED fires
     constantly. Autoplay must happen on the FIRST one only — otherwise every
     refresh calls play() again and silently un-pauses a viewer who paused. */
  var autoStarted = false;
  /* What the viewer last asked for. Recovery after a network error resumes
     only if they had not deliberately paused. */
  var wantPlaying = true;

  function hide(el){ el.classList.add('hide'); }
  function show(el){ el.classList.remove('hide'); }
  function fail(msg){ hide(ovLoad); errMsg.textContent = msg; show(ovErr); }

  /* ── chrome visibility ──────────────────────────────────────────────────
     Fades after a few seconds of inactivity, but never while the viewer is
     paused or has focus inside the bar — otherwise the controls vanish under
     the cursor on the way to the button being aimed at. */
  var uiTimer = null;
  function poke(){
    stage.classList.add('show-ui');
    clearTimeout(uiTimer);
    uiTimer = setTimeout(function(){
      if (!v.paused && !ctlHover) stage.classList.remove('show-ui');
    }, 3000);
  }
  var ctlHover = false;
  ['mouseenter','focusin'].forEach(function(e){
    document.getElementById('ctl').addEventListener(e, function(){ ctlHover = true; poke(); });
  });
  ['mouseleave','focusout'].forEach(function(e){
    document.getElementById('ctl').addEventListener(e, function(){ ctlHover = false; poke(); });
  });
  ['mousemove','touchstart','pointerdown'].forEach(function(e){
    document.addEventListener(e, poke, { passive: true });
  });
  poke();

  /* ── transport ──────────────────────────────────────────────────────── */
  function syncPlay(){
    var paused = v.paused;
    iPlay.style.display  = paused ? '' : 'none';
    iPause.style.display = paused ? 'none' : '';
    bPlay.setAttribute('aria-label', paused ? 'Play' : 'Pause');
    bPlay.title = paused ? 'Play' : 'Pause';
    if (paused) stage.classList.add('show-ui');
  }
  function syncMute(){
    iVol.style.display  = v.muted ? 'none' : '';
    iMute.style.display = v.muted ? '' : 'none';
    bMute.setAttribute('aria-label', v.muted ? 'Unmute' : 'Mute');
    bMute.title = v.muted ? 'Unmute' : 'Mute';
  }
  function togglePlay(){
    wantPlaying = v.paused;
    if (v.paused) { v.play().catch(function(){}); } else { v.pause(); }
  }
  function toggleMute(){
    v.muted = !v.muted;
    if (!v.muted) { hide(ovTap); v.volume = 1; }
    syncMute();
  }
  function start(){
    wantPlaying = true;
    var p = v.play();
    if (p && p.catch) p.catch(function(){
      /* Unmuted autoplay was refused. Go muted so something is on screen, and
         surface the tap-to-unmute hint so sound is one click away. */
      v.muted = true; syncMute();
      var q = v.play();
      if (q && q.catch) q.catch(function(){}); else show(ovTap);
    });
  }

  bPlay.addEventListener('click', togglePlay);
  bMute.addEventListener('click', toggleMute);
  ovTap.addEventListener('click', function(){ toggleMute(); v.play().catch(function(){}); });
  v.addEventListener('click', togglePlay);
  v.addEventListener('play', syncPlay);
  v.addEventListener('pause', syncPlay);
  v.addEventListener('volumechange', syncMute);

  /* ── fullscreen ─────────────────────────────────────────────────────── */
  function fsElement(){ return document.fullscreenElement || document.webkitFullscreenElement || null; }
  function syncFs(){
    var on = Boolean(fsElement());
    iFsOn.style.display  = on ? 'none' : '';
    iFsOff.style.display = on ? '' : 'none';
    bFs.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Fullscreen');
  }
  function toggleFs(){
    var el = document.getElementById('stage');
    if (fsElement()) {
      (document.exitFullscreen || document.webkitExitFullscreen || function(){}).call(document);
    } else if (el.requestFullscreen) {
      el.requestFullscreen().catch(function(){});
    } else if (el.webkitRequestFullscreen) {
      el.webkitRequestFullscreen();
    }
  }
  bFs.addEventListener('click', toggleFs);
  v.addEventListener('dblclick', toggleFs);
  document.addEventListener('fullscreenchange', syncFs);
  document.addEventListener('webkitfullscreenchange', syncFs);

  /* ── live edge ──────────────────────────────────────────────────────── */
  function jumpToLive(){
    /* Chase the end of the buffer. With a live sliding window the newest
       segment is the end, minus a small margin so we do not stall on it. */
    if (v.seekable && v.seekable.length) {
      var end = v.seekable.end(v.seekable.length - 1);
      v.currentTime = Math.max(0, end - 0.5);
    } else if (v.buffered && v.buffered.length) {
      v.currentTime = Math.max(0, v.buffered.end(v.buffered.length - 1) - 0.5);
    }
    if (v.paused) { wantPlaying = true; v.play().catch(function(){}); }
    hide(ovTap);
  }
  bLive.addEventListener('click', jumpToLive);

  /* ── quality ────────────────────────────────────────────────────────── */
  function levelIndexForHeight(px){
    for (var i = 0; i < levels.length; i++) if ((levels[i].height || 0) === px) return i;
    return -1;
  }
  qual.addEventListener('change', function(e){
    if (!hls) return;
    var val = parseInt(e.target.value, 10);
    hls.currentLevel = (isNaN(val) || val === -1) ? -1 : levelIndexForHeight(val);
  });

  /* ── playback ───────────────────────────────────────────────────────── */
  function startPlayback(){
    if (!window.Hls || !window.Hls.isSupported()) {
      if (v.canPlayType('application/vnd.apple.mpegurl')) { v.src = SRC; v.load(); start(); return; }
      fail('This browser cannot play HLS.');
      return;
    }
    hls = new window.Hls({
      /* Was liveSyncDurationCount 3 / maxBufferLength 30, which with ~10s
         segments parked the viewer a full 30s behind live. Two segments keeps
         a cushion against jitter while roughly halving the delay.
         liveMaxLatencyDurationCount is the safety net: if a stall leaves us
         further behind than this, hls.js seeks forward instead of letting the
         gap grow for the rest of the session. */
      liveSyncDurationCount: 2,
      liveMaxLatencyDurationCount: 6,
      maxBufferLength: 20,
      maxMaxBufferLength: 60,
      backBufferLength: 30,
      enableWorker: true,
      nudgeMaxRetry: 10
    });
    hls.loadSource(SRC);
    hls.attachMedia(v);

    hls.on(window.Hls.Events.MANIFEST_PARSED, function(){
      levels = hls.levels || [];
      // A single-variant (media) playlist reports one level with no height or
      // bitrate, so a picker would read "0 kbps". Only show it when there is
      // genuinely something to choose between.
      var named = levels.filter(function(l){ return (l.height || 0) > 0 || (l.bitrate || 0) > 0; });
      if (named.length > 1) {
        qual.innerHTML = '<option value="-1">Auto</option>';
        named.slice().sort(function(a, b){ return (b.height || 0) - (a.height || 0); })
          .forEach(function(l){
            var o = document.createElement('option');
            o.value = l.height || '';
            o.textContent = l.height ? (l.height + 'p')
                                     : (Math.round((l.bitrate || 0) / 1000) + ' kbps');
            qual.appendChild(o);
          });
        qual.style.display = '';
      }
    });

    hls.on(window.Hls.Events.LEVEL_LOADED, function(){
      hide(ovLoad);
      if (!autoStarted) { autoStarted = true; start(); }
    });

    hls.on(window.Hls.Events.ERROR, function(ev, d){
      if (!d || !d.fatal) return;
      if (d.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
        // The playlist route re-mints its own token, so this is nearly always
        // transient. Back off, then ask for a fresh manifest.
        setTimeout(function(){
          try { hls.loadSource(SRC); hls.startLoad(); } catch (_) {}
          // Respect a deliberate pause: only resume if they wanted playback.
          if (wantPlaying && v.paused) v.play().catch(function(){});
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

  v.addEventListener('playing', function(){ hide(ovLoad); syncPlay(); });
  v.addEventListener('waiting', function(){ if (!v.paused) show(ovLoad); });
  v.addEventListener('error', function(){ fail('Media error — reload to try again.'); });
  document.getElementById('bRetry').addEventListener('click', function(){ location.reload(); });

  /* ── readouts ───────────────────────────────────────────────────────── */
  function behindLive(){
    if (!v.seekable || !v.seekable.length || !v.buffered || !v.buffered.length) return 0;
    return Math.max(0, v.seekable.end(v.seekable.length - 1) - v.currentTime);
  }
  setInterval(function(){
    if (!v.videoWidth) return;
    var bw = hls ? Math.round((hls.bandwidthEstimate || 0) / 1000) : 0;
    var cur = (hls && hls.currentLevel >= 0 && levels[hls.currentLevel]) ? levels[hls.currentLevel] : null;
    var lvl = cur ? (cur.height ? cur.height + 'p'
                                : (cur.bitrate ? Math.round(cur.bitrate / 1000) + ' kbps' : 'Source'))
                  : 'auto';
    stats.textContent = v.videoWidth + '×' + v.videoHeight +
                        (bw ? '  ' + bw + ' kbps' : '') + '  ' + lvl;
  }, 1000);
  setInterval(function(){
    if (v.paused) { timeEl.textContent = 'PAUSED'; return; }
    var b = behindLive();
    timeEl.textContent = b > 8 ? '-' + Math.round(b) + 's' : 'LIVE';
  }, 500);

  v.muted = true;      // muted start: the only way autoplay is allowed at all
  syncMute();
  syncPlay();
  syncFs();
  startPlayback();
})();
</script>
</body>
</html>`;
}

module.exports = { buildPlayerPage };
