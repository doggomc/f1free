/* ═══════════════════════════════════════════════════════════
   FreeF1 Admin — Audience Analytics section
   Pulls /admin/api/analytics, folds the hourly/daily buckets
   into the selected range and renders every chart. Refreshes
   itself every minute while the tab is visible.
   ═══════════════════════════════════════════════════════════ */

'use strict';

const Analytics = (() => {
  const REFRESH_MS = 60_000;
  const RANGES = {
    '24h': { label: 'Last 24 hours', hours: 24, granularity: 'hour' },
    '7d': { label: 'Last 7 days', hours: 7 * 24, granularity: 'hour' },
    '14d': { label: 'Last 14 days', hours: 14 * 24, granularity: 'hour' },
    '30d': { label: 'Last 30 days', days: 30, granularity: 'day' },
    '90d': { label: 'Last 90 days', days: 90, granularity: 'day' }
  };
  const TEAM_META = {
    default: ['Apex Red', '#E10600'], mclaren: ['McLaren', '#FF8000'], ferrari: ['Ferrari', '#DC0000'], redbull: ['Red Bull', '#1E41FF'],
    mercedes: ['Mercedes', '#00D2BE'], williams: ['Williams', '#005AFF'], astonmartin: ['Aston Martin', '#006F62'], alpine: ['Alpine', '#FF0080'],
    haas: ['Haas', '#B3B3B3'], audi: ['Audi', '#E62213'], cadillac: ['Cadillac', '#B4A07A'], racingbulls: ['Racing Bulls', '#6692FF']
  };
  const PAGE_LABELS = { '/': 'Home / Cockpit', '/news': 'News', '/info': 'Terms · Privacy · FAQ', '/other': 'Other' };
  const DURATION_LABELS = ['< 1 min', '1–5 min', '5–15 min', '15–45 min', '45 min–2 h', '2 h +'];
  const DEVICE_COLORS = { Desktop: '#60a5fa', Mobile: '#00d57e', Tablet: '#ffb020' };

  let data = null;
  let range = localStorage.getItem('freef1_analytics_range') || '7d';
  let timer = 0;
  let loading = false;
  let resizeTimer = 0;
  let regionNames = null;
  try { regionNames = new Intl.DisplayNames(['en'], { type: 'region' }); } catch (_) { regionNames = null; }

  const $ = id => document.getElementById(id);
  const F = Charts;

  // ── Data folding ────────────────────────────────────────
  function emptyTotals() {
    return { sessions: 0, ended: 0, durationMs: 0, durHist: [0, 0, 0, 0, 0, 0], newVisitors: 0, returning: 0, pageViews: 0, peakOnline: 0, onlineSum: 0, onlineSamples: 0, device: {}, browser: {}, os: {}, country: {}, pages: {}, source: {}, team: {}, fullscreen: 0, nostream: 0, streamReady: 0, streamReadyMs: 0, streamTimeout: 0 };
  }
  function addInto(total, bucket) {
    if (!bucket) return total;
    for (const key of Object.keys(total)) {
      const v = bucket[key];
      if (v == null) continue;
      if (Array.isArray(total[key])) total[key] = total[key].map((c, i) => c + (Number(v[i]) || 0));
      else if (typeof total[key] === 'object') for (const [name, count] of Object.entries(v)) total[key][name] = (total[key][name] || 0) + (Number(count) || 0);
      else if (key === 'peakOnline') total.peakOnline = Math.max(total.peakOnline, Number(v) || 0);
      else total[key] += Number(v) || 0;
    }
    return total;
  }
  const avgOnline = b => (b.onlineSamples ? b.onlineSum / b.onlineSamples : 0);
  const avgDuration = b => (b.ended ? b.durationMs / b.ended : 0);

  // Build a dense, gap-free series for the chosen range.
  function buildSeries(spec) {
    const now = data.generatedAt || Date.now();
    if (spec.granularity === 'hour') {
      const byHour = new Map(data.hourly.map(b => [b.t, b]));
      const end = Math.floor(now / 3_600_000) * 3_600_000;
      const points = [];
      for (let t = end - (spec.hours - 1) * 3_600_000; t <= end; t += 3_600_000) points.push({ t, b: byHour.get(t) || null });
      return points;
    }
    const byDay = new Map(data.daily.map(b => [b.d, b]));
    const points = [];
    const today = new Date(now); today.setUTCHours(0, 0, 0, 0);
    for (let i = spec.days - 1; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86_400_000);
      const key = d.toISOString().slice(0, 10);
      points.push({ t: d.getTime(), d: key, b: byDay.get(key) || null });
    }
    return points;
  }

  function previousTotals(spec) {
    // Same-length window immediately before the selected range (for deltas).
    const now = data.generatedAt || Date.now();
    const total = emptyTotals();
    if (spec.granularity === 'hour') {
      const end = Math.floor(now / 3_600_000) * 3_600_000 - spec.hours * 3_600_000;
      const start = end - (spec.hours - 1) * 3_600_000;
      for (const b of data.hourly) if (b.t >= start && b.t <= end) addInto(total, b);
    } else {
      const today = new Date(now); today.setUTCHours(0, 0, 0, 0);
      const end = today.getTime() - spec.days * 86_400_000, start = end - (spec.days - 1) * 86_400_000;
      for (const b of data.daily) if (b.t >= start && b.t <= end) addInto(total, b);
    }
    return total;
  }

  function delta(current, previous) {
    if (!previous && !current) return { text: '—', cls: '' };
    if (!previous) return { text: 'new', cls: 'up' };
    const pct = ((current - previous) / previous) * 100;
    if (Math.abs(pct) < 0.5) return { text: '± 0%', cls: '' };
    return { text: `${pct > 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(Math.abs(pct) >= 10 ? 0 : 1)}%`, cls: pct > 0 ? 'up' : 'down' };
  }

  function countryName(code) {
    if (!code || code === 'Unknown' || code === 'Other') return code || 'Unknown';
    try { return regionNames?.of(code) || code; } catch (_) { return code; }
  }
  function flag(cc) {
    if (!cc || cc.length !== 2 || !/^[A-Z]{2}$/i.test(cc)) return '🌐';
    return cc.toUpperCase().split('').map(c => String.fromCodePoint(0x1F1E6 - 65 + c.charCodeAt(0))).join('');
  }
  const toRows = (map, color) => Object.entries(map || {}).map(([label, value], i) => ({ label, value, color: typeof color === 'function' ? color(label, i) : color }));

  // ── Rendering ───────────────────────────────────────────
  function render() {
    if (!data) return;
    const spec = RANGES[range] || RANGES['7d'];
    const points = buildSeries(spec);
    const totals = points.reduce((acc, p) => addInto(acc, p.b), emptyTotals());
    const prev = previousTotals(spec);
    const isHour = spec.granularity === 'hour';
    const xs = points.map(p => p.t);
    const xFmt = (t, i, full) => full
      ? (isHour ? F.dayHourFmt.format(t) : F.fullDayFmt.format(t))
      : (isHour ? (spec.hours <= 24 ? F.timeFmt.format(t) : (new Date(t).getHours() === 0 ? F.dayFmt.format(t) : F.timeFmt.format(t))) : F.dayFmt.format(t));

    // Range buttons
    document.querySelectorAll('#analyticsRange .range-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.range === range));
    $('analyticsRangeLabel').textContent = spec.label;
    const store = String(data.store || 'unknown').toUpperCase();
    const storeEl = $('analyticsStore');
    storeEl.textContent = store === 'UPSTASH' ? '● Durable · Upstash' : store === 'FILE' ? '● Local file' : '● Memory only';
    storeEl.className = `panel-badge ${store === 'UPSTASH' ? 'normal' : store === 'FILE' ? 'warn' : 'live'}`;
    $('analyticsSince').textContent = data.since ? `Collecting since ${F.fullDayFmt.format(data.since)}` : 'Collecting from the first heartbeat';

    // KPI cards ----------------------------------------------------------------
    const kpi = (id, value, sub, d) => {
      $(id + 'Val').textContent = value;
      if (sub != null) $(id + 'Sub').textContent = sub;
      const dEl = $(id + 'Delta');
      if (dEl) { dEl.textContent = d ? d.text : ''; dEl.className = `kpi-delta ${d ? d.cls : ''}`; }
    };
    const liveOpen = data.current || { online: 0, openSessions: 0, openSessionMs: 0 };
    kpi('kSessions', F.fmtInt(totals.sessions), `${F.fmtInt(totals.pageViews)} page views`, delta(totals.sessions, prev.sessions));
    kpi('kAvgTime', F.fmtDuration(avgDuration(totals)), `${F.fmtInt(totals.ended)} completed · open now avg ${F.fmtDuration(liveOpen.openSessions ? liveOpen.openSessionMs / liveOpen.openSessions : 0)}`, delta(avgDuration(totals), avgDuration(prev)));
    const livePeak = range === '24h' && Array.isArray(data.live) ? data.live.reduce((m, p) => Math.max(m, p[1] || 0), 0) : 0;
    kpi('kAvgOnline', avgOnline(totals).toFixed(avgOnline(totals) >= 10 ? 0 : 1), `Peak ${F.fmtInt(Math.max(totals.peakOnline, livePeak))} concurrent · ${F.fmtInt(liveOpen.online)} now`, delta(avgOnline(totals), avgOnline(prev)));
    const newShare = totals.newVisitors + totals.returning ? totals.newVisitors / (totals.newVisitors + totals.returning) : 0;
    kpi('kNew', `${Math.round(newShare * 100)}%`, `${F.fmtInt(totals.newVisitors)} new · ${F.fmtInt(totals.returning)} returning`, delta(totals.newVisitors, prev.newVisitors));
    const bounce = totals.ended ? totals.durHist[0] / totals.ended : 0;
    kpi('kBounce', `${Math.round(bounce * 100)}%`, 'sessions under one minute', (() => { const d = delta(bounce, prev.ended ? prev.durHist[0] / prev.ended : 0); if (d.cls) d.cls = d.cls === 'up' ? 'down' : 'up'; return d; })());
    const totalWatch = totals.durationMs + liveOpen.openSessionMs;
    kpi('kWatch', F.fmtDuration(totalWatch).replace(/ \d+s$/, ''), 'total time on site (incl. open sessions)', delta(totals.durationMs, prev.durationMs));

    // Concurrent viewers ---------------------------------------------------------
    const liveEl = $('chartLive');
    if (range === '24h' && Array.isArray(data.live) && data.live.length > 1) {
      const liveXs = data.live.map(p => p[0]);
      F.lineChart(liveEl, {
        xs: liveXs, height: 240, xTicks: 8,
        series: [{ name: 'Viewers online', color: '#00d57e', values: data.live.map(p => p[1]) }],
        xFormat: (t, i, full) => (full ? F.dayHourFmt.format(t) : F.timeFmt.format(t)),
        yFormat: F.fmtCompact, tooltipFormat: v => F.fmtInt(v),
        markers: data.serverStartedAt && data.serverStartedAt > liveXs[0] ? [{ t: data.serverStartedAt, label: 'server start' }] : []
      });
      $('chartLiveNote').textContent = 'One-minute resolution · last 24 hours';
    } else {
      F.lineChart(liveEl, {
        xs, height: 240, xFormat: xFmt, xTicks: isHour && spec.hours > 24 ? 7 : 8,
        series: [
          { name: 'Peak concurrent', color: '#00d57e', values: points.map(p => (p.b ? p.b.peakOnline || 0 : 0)) },
          { name: 'Average concurrent', color: '#60a5fa', values: points.map(p => (p.b ? avgOnline(p.b) : 0)), fill: false, dashed: true, tooltipFormat: v => v.toFixed(1) }
        ],
        tooltipFormat: v => F.fmtInt(v)
      });
      $('chartLiveNote').textContent = isHour ? 'Hourly peak and average · switch to 24h for minute resolution' : 'Daily peak and average concurrent viewers';
    }

    // Sessions / new vs returning -----------------------------------------------
    F.barChart($('chartSessions'), {
      xs, height: 220, xFormat: xFmt, xTicks: isHour && spec.hours > 24 ? 7 : 8,
      series: [
        { name: 'Returning', color: '#60a5fa', values: points.map(p => (p.b ? p.b.returning || 0 : 0)) },
        { name: 'New visitors', color: '#e10600', values: points.map(p => (p.b ? p.b.newVisitors || 0 : 0)) },
        { name: 'Unclassified', color: '#4a5262', values: points.map(p => (p.b ? Math.max(0, (p.b.sessions || 0) - (p.b.newVisitors || 0) - (p.b.returning || 0)) : 0)) }
      ],
      tooltipFormat: v => F.fmtInt(v)
    });

    // Average time on site trend -------------------------------------------------
    F.lineChart($('chartDuration'), {
      xs, height: 200, xFormat: xFmt, xTicks: isHour && spec.hours > 24 ? 7 : 8, stepped: false,
      series: [{ name: 'Avg session length', color: '#a78bfa', values: points.map(p => (p.b ? avgDuration(p.b) / 60_000 : 0)) }],
      yFormat: v => `${Math.round(v)}m`, tooltipFormat: v => F.fmtDuration(v * 60_000),
      emptyText: 'Needs completed sessions — check back after viewers leave'
    });
    F.histogram($('chartDurationHist'), { labels: DURATION_LABELS, values: totals.durHist, color: '#a78bfa' });

    // Heat-map: average concurrent viewers by weekday × hour ---------------------
    const cells = Array.from({ length: 7 }, () => Array(24).fill(0)), counts = Array.from({ length: 7 }, () => Array(24).fill(0));
    for (const b of data.hourly) {
      const d = new Date(b.t); const day = (d.getDay() + 6) % 7, hour = d.getHours();
      cells[day][hour] += b.onlineSamples ? b.onlineSum / b.onlineSamples : 0; counts[day][hour]++;
    }
    const heat = cells.map((row, d) => row.map((v, h) => (counts[d][h] ? v / counts[d][h] : 0)));
    F.heatmap($('chartHeat'), { cells: heat, title: 'Avg viewers online', format: v => v.toFixed(1) });
    const heatNote = $('chartHeatNote');
    if (heatNote) heatNote.textContent = `avg viewers online · weekday × hour · ${Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time'} · last ${Math.round((data.retention?.hourlyHours || 336) / 24)} days`;

    // Audience breakdowns ----------------------------------------------------------
    F.donut($('chartDevice'), { rows: toRows(totals.device, l => DEVICE_COLORS[l] || '#a78bfa') });
    F.rankedBars($('chartBrowser'), { rows: toRows(totals.browser), max: 8 });
    F.rankedBars($('chartOs'), { rows: toRows(totals.os), max: 8 });
    F.rankedBars($('chartCountry'), { rows: toRows(totals.country), max: 12, labelFormat: r => `${flag(r.label)}  ${countryName(r.label)}` });

    // Content & player -------------------------------------------------------------
    F.rankedBars($('chartPages'), { rows: toRows(totals.pages).map(r => ({ ...r, label: PAGE_LABELS[r.label] || r.label })), max: 6, format: F.fmtInt });
    F.rankedBars($('chartSource'), { rows: toRows(totals.source), max: 8, emptyText: 'No feed picks recorded yet' });
    F.rankedBars($('chartTeam'), { rows: toRows(totals.team).map(r => ({ ...r, label: TEAM_META[r.label]?.[0] || r.label, color: TEAM_META[r.label]?.[1] || '#4a5262' })), max: 12, emptyText: 'No livery picks recorded yet' });

    const health = $('playerHealth');
    const readyAvg = totals.streamReady ? totals.streamReadyMs / totals.streamReady : 0;
    const attempts = totals.streamReady + totals.streamTimeout;
    health.innerHTML = '';
    [
      ['Player loads', F.fmtInt(attempts), attempts ? `${F.fmtPct(totals.streamReady, attempts)} ready within 5 s` : 'waiting for a stream'],
      ['Avg time to first frame', readyAvg ? F.fmtDuration(readyAvg) : '—', 'iframe load → visible'],
      ['Slow / timed out', F.fmtInt(totals.streamTimeout), attempts ? F.fmtPct(totals.streamTimeout, attempts) + ' of loads' : ''],
      ['Fullscreen taps', F.fmtInt(totals.fullscreen), totals.sessions ? `${(totals.fullscreen / totals.sessions).toFixed(2)} per session` : ''],
      ['"No stream" impressions', F.fmtInt(totals.nostream), 'visits outside a live session'],
      ['Feed switches', F.fmtInt(Object.values(totals.source).reduce((s, v) => s + v, 0)), totals.sessions ? `${(Object.values(totals.source).reduce((s, v) => s + v, 0) / totals.sessions).toFixed(2)} per session` : '']
    ].forEach(([label, value, sub]) => {
      const item = document.createElement('div'); item.className = 'health-item';
      item.innerHTML = `<div class="health-label">${label}</div><div class="health-value">${value}</div><div class="health-sub">${sub}</div>`;
      health.appendChild(item);
    });

    // Busiest hours table ----------------------------------------------------------
    const busiest = [...data.hourly].filter(b => (b.peakOnline || 0) > 0).sort((a, b) => (b.peakOnline || 0) - (a.peakOnline || 0) || (b.sessions || 0) - (a.sessions || 0)).slice(0, 8);
    const tbody = $('busiestBody');
    tbody.innerHTML = busiest.length ? busiest.map(b => `
      <tr>
        <td>${F.dayHourFmt.format(b.t)}</td>
        <td class="num">${F.fmtInt(b.peakOnline || 0)}</td>
        <td class="num">${avgOnline(b).toFixed(1)}</td>
        <td class="num">${F.fmtInt(b.sessions || 0)}</td>
        <td class="num">${F.fmtDuration(avgDuration(b))}</td>
        <td>${Object.entries(b.country || {}).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([cc]) => flag(cc)).join(' ') || '—'}</td>
      </tr>`).join('') : '<tr><td colspan="6"><div class="empty-state">No busy hours recorded yet</div></td></tr>';

    $('analyticsUpdated').textContent = `Updated ${F.timeFmt.format(Date.now())}`;
  }

  // ── Loading ─────────────────────────────────────────────
  async function load(force = false) {
    if (loading || (!force && document.hidden)) return;
    loading = true;
    try {
      const response = await fetch('/admin/api/analytics', { cache: 'no-store' });
      if (response.status === 401) return;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      data = await response.json();
      render();
      $('analyticsError').hidden = true;
    } catch (error) {
      const box = $('analyticsError');
      box.textContent = `Analytics unavailable: ${error.message || error}`;
      box.hidden = false;
    } finally {
      loading = false;
    }
  }

  function exportCsv() {
    if (!data) return;
    const spec = RANGES[range];
    const points = buildSeries(spec);
    const header = ['period_start_utc', 'sessions', 'page_views', 'new_visitors', 'returning', 'completed_sessions', 'avg_session_seconds', 'peak_online', 'avg_online', 'fullscreen', 'feed_switches', 'stream_ready', 'stream_timeout', 'nostream_impressions'];
    const lines = [header.join(',')];
    for (const p of points) {
      const b = p.b || {};
      lines.push([
        new Date(p.t).toISOString(), b.sessions || 0, b.pageViews || 0, b.newVisitors || 0, b.returning || 0, b.ended || 0,
        b.ended ? Math.round((b.durationMs || 0) / b.ended / 1000) : 0, b.peakOnline || 0, b.onlineSamples ? ((b.onlineSum || 0) / b.onlineSamples).toFixed(2) : 0,
        b.fullscreen || 0, Object.values(b.source || {}).reduce((s, v) => s + v, 0), b.streamReady || 0, b.streamTimeout || 0, b.nostream || 0
      ].join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `freef1-analytics-${range}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function start() {
    if (timer) return;
    document.querySelectorAll('#analyticsRange .range-btn').forEach(btn => btn.addEventListener('click', () => {
      range = btn.dataset.range; localStorage.setItem('freef1_analytics_range', range); render();
    }));
    $('analyticsRefresh')?.addEventListener('click', () => load(true));
    $('analyticsExport')?.addEventListener('click', exportCsv);
    window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 150); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
    load(true);
    timer = setInterval(load, REFRESH_MS);
  }

  function stop() { clearInterval(timer); timer = 0; }

  return { start, stop, load, render };
})();
