/* ═══════════════════════════════════════════════════════════
   FreeF1 Admin — Chart module (dependency-free SVG)
   Line/area charts, stacked bars, horizontal bars, a 7×24
   heat-map and sparklines. Hover tooltips. No external code.
   ═══════════════════════════════════════════════════════════ */

'use strict';

const Charts = (() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const PALETTE = ['#e10600', '#60a5fa', '#00d57e', '#ffb020', '#a78bfa', '#f472b6', '#22d3ee', '#fb923c', '#84cc16', '#94a3b8'];

  function el(name, attrs = {}, children = []) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attrs)) if (value != null) node.setAttribute(key, value);
    for (const child of children) if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    return node;
  }

  function html(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  const fmtInt = n => Number(n || 0).toLocaleString('en-GB');
  const fmtCompact = n => {
    n = Number(n || 0);
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
    if (n >= 1e4) return Math.round(n / 1e3) + 'k';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
  };
  const fmtDuration = ms => {
    ms = Math.max(0, Number(ms || 0));
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  };
  const fmtPct = (part, total) => (total ? `${Math.round((part / total) * 100)}%` : '0%');

  const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
  const dayFmt = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short' });
  const dayHourFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const fullDayFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });

  function niceMax(value) {
    if (!(value > 0)) return 1;
    const exp = Math.pow(10, Math.floor(Math.log10(value)));
    const frac = value / exp;
    const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 2.5 ? 2.5 : frac <= 5 ? 5 : 10;
    return nice * exp;
  }

  /* ── Width memo / read-write batching ──────────────────────
     Each chart used to clear its own container (write) and then read
     container.clientWidth (read) before painting, so a dashboard render
     interleaved ~12 write/read pairs and forced a synchronous layout on
     every one of them.

     Call `prepare()` once at the top of a render pass: it measures every
     chart container up front in a single read phase, so the paint phase
     below is write-only and forces no layout at all. */
  const widthCache = new Map();
  const measureWidth = container => Math.max(320, container.clientWidth || 640);

  const prepare = (root, selector = '.chart-body') => {
    widthCache.clear();
    const scope = root && root.querySelectorAll ? root : document;
    for (const container of scope.querySelectorAll(selector)) widthCache.set(container, measureWidth(container));
  };

  const chartWidth = container => {
    const cached = widthCache.get(container);
    if (cached !== undefined) return cached;
    // Un-prepared container: measure lazily (correct, just not batched).
    const width = measureWidth(container);
    widthCache.set(container, width);
    return width;
  };

  const invalidateWidths = () => widthCache.clear();
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', invalidateWidths, { passive: true });
    window.addEventListener('orientationchange', invalidateWidths, { passive: true });
  }

  // ── Tooltip (one shared element) ─────────────────────────
  let tip = null;
  function showTip(host, x, y, content) {
    if (!tip) { tip = html('div', 'chart-tip'); document.body.appendChild(tip); }
    tip.innerHTML = content;
    tip.style.opacity = '1';
    const rect = host.getBoundingClientRect();
    const left = rect.left + x + window.scrollX;
    const top = rect.top + y + window.scrollY;
    tip.style.left = `${Math.min(left + 14, window.scrollX + document.documentElement.clientWidth - tip.offsetWidth - 12)}px`;
    tip.style.top = `${top - tip.offsetHeight - 14}px`;
  }
  function hideTip() { if (tip) tip.style.opacity = '0'; }

  // ── Line / area chart ────────────────────────────────────
  // series: [{ name, color, values: number[] , dashed?, fill? }], xs: timestamps[]
  function lineChart(container, { xs, series, height = 220, xFormat, yFormat = fmtCompact, tooltipFormat, stepped = false, xTicks = 6, emptyText = 'No data yet', markers = [] }) {
    container.innerHTML = '';
    const width = chartWidth(container);
    const pad = { top: 14, right: 16, bottom: 26, left: 40 };
    const innerW = width - pad.left - pad.right, innerH = height - pad.top - pad.bottom;
    const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height, class: 'chart-svg', role: 'img' });
    container.appendChild(svg);

    const n = xs.length;
    if (!n || !series.some(s => s.values.some(v => v > 0))) {
      svg.appendChild(el('text', { x: width / 2, y: height / 2, class: 'chart-empty', 'text-anchor': 'middle' }, [emptyText]));
      drawGrid(svg, pad, innerW, innerH, 1, yFormat);
      return;
    }

    const rawMax = Math.max(...series.flatMap(s => s.values.filter(Number.isFinite)));
    const yMax = niceMax(rawMax * 1.08);
    const xOf = i => pad.left + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
    const yOf = v => pad.top + innerH - (Math.max(0, v) / yMax) * innerH;

    drawGrid(svg, pad, innerW, innerH, yMax, yFormat);

    // x labels
    const step = Math.max(1, Math.round(n / xTicks));
    for (let i = 0; i < n; i += step) {
      svg.appendChild(el('text', { x: xOf(i), y: height - 8, class: 'chart-xlabel', 'text-anchor': i === 0 ? 'start' : 'middle' }, [xFormat ? xFormat(xs[i], i) : String(xs[i])]));
    }

    // markers (vertical lines, e.g. server restarts / sessions)
    for (const marker of markers) {
      const i = xs.findIndex(x => x >= marker.t);
      if (i < 0) continue;
      svg.appendChild(el('line', { x1: xOf(i), x2: xOf(i), y1: pad.top, y2: pad.top + innerH, class: 'chart-marker' }));
      if (marker.label) svg.appendChild(el('text', { x: xOf(i) + 4, y: pad.top + 10, class: 'chart-marker-label' }, [marker.label]));
    }

    const defs = el('defs');
    svg.appendChild(defs);
    series.forEach((s, si) => {
      const color = s.color || PALETTE[si % PALETTE.length];
      const points = s.values.map((v, i) => [xOf(i), yOf(Number.isFinite(v) ? v : 0)]);
      let d = '';
      points.forEach(([x, y], i) => {
        if (i === 0) d += `M${x.toFixed(1)},${y.toFixed(1)}`;
        else if (stepped) d += `H${x.toFixed(1)}V${y.toFixed(1)}`;
        else d += `L${x.toFixed(1)},${y.toFixed(1)}`;
      });
      if (s.fill !== false) {
        const gradId = `g${si}-${Math.random().toString(36).slice(2, 8)}`;
        defs.appendChild(el('linearGradient', { id: gradId, x1: 0, y1: 0, x2: 0, y2: 1 }, [
          el('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': 0.28 }),
          el('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': 0.02 })
        ]));
        const base = pad.top + innerH;
        svg.appendChild(el('path', { d: `${d}V${base}H${points[0][0].toFixed(1)}Z`, fill: `url(#${gradId})`, stroke: 'none' }));
      }
      svg.appendChild(el('path', { d, class: 'chart-line', stroke: color, 'stroke-dasharray': s.dashed ? '4 4' : null }));
    });

    // hover layer
    const cursor = el('line', { class: 'chart-cursor', y1: pad.top, y2: pad.top + innerH, style: 'opacity:0' });
    svg.appendChild(cursor);
    const dots = series.map((s, si) => { const dot = el('circle', { r: 3.5, class: 'chart-dot', fill: s.color || PALETTE[si % PALETTE.length], style: 'opacity:0' }); svg.appendChild(dot); return dot; });
    const hit = el('rect', { x: pad.left, y: pad.top, width: innerW, height: innerH, fill: 'transparent' });
    svg.appendChild(hit);

    const move = event => {
      const rect = svg.getBoundingClientRect();
      const scale = width / rect.width;
      const px = (event.clientX - rect.left) * scale;
      const i = Math.max(0, Math.min(n - 1, Math.round(((px - pad.left) / innerW) * (n - 1))));
      const x = xOf(i);
      cursor.setAttribute('x1', x); cursor.setAttribute('x2', x); cursor.style.opacity = '1';
      series.forEach((s, si) => { dots[si].setAttribute('cx', x); dots[si].setAttribute('cy', yOf(s.values[i] || 0)); dots[si].style.opacity = '1'; });
      const rows = series.map((s, si) => `<div class="tip-row"><i style="background:${s.color || PALETTE[si % PALETTE.length]}"></i>${s.name}<b>${(s.tooltipFormat || tooltipFormat || yFormat)(s.values[i] || 0, i)}</b></div>`).join('');
      showTip(svg, x / scale, yOf(Math.max(...series.map(s => s.values[i] || 0))) / scale, `<div class="tip-head">${xFormat ? xFormat(xs[i], i, true) : xs[i]}</div>${rows}`);
    };
    const leave = () => { cursor.style.opacity = '0'; dots.forEach(d => (d.style.opacity = '0')); hideTip(); };
    hit.addEventListener('mousemove', move);
    hit.addEventListener('mouseleave', leave);
    hit.addEventListener('touchstart', e => { if (e.touches[0]) move(e.touches[0]); }, { passive: true });
    hit.addEventListener('touchmove', e => { if (e.touches[0]) move(e.touches[0]); }, { passive: true });
    hit.addEventListener('touchend', leave);
  }

  function drawGrid(svg, pad, innerW, innerH, yMax, yFormat) {
    const lines = 4;
    for (let i = 0; i <= lines; i++) {
      const y = pad.top + innerH - (i / lines) * innerH;
      svg.appendChild(el('line', { x1: pad.left, x2: pad.left + innerW, y1: y, y2: y, class: 'chart-grid' }));
      svg.appendChild(el('text', { x: pad.left - 8, y: y + 3.5, class: 'chart-ylabel', 'text-anchor': 'end' }, [yFormat((yMax * i) / lines)]));
    }
  }

  // ── Vertical (stacked) bar chart ─────────────────────────
  // series: [{ name, color, values }], xs: labels
  function barChart(container, { xs, series, height = 220, xFormat, yFormat = fmtCompact, tooltipFormat, xTicks = 8, emptyText = 'No data yet' }) {
    container.innerHTML = '';
    const width = chartWidth(container);
    const pad = { top: 14, right: 16, bottom: 26, left: 40 };
    const innerW = width - pad.left - pad.right, innerH = height - pad.top - pad.bottom;
    const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height, class: 'chart-svg', role: 'img' });
    container.appendChild(svg);
    const n = xs.length;
    const totals = xs.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] || 0), 0));
    if (!n || !totals.some(t => t > 0)) {
      drawGrid(svg, pad, innerW, innerH, 1, yFormat);
      svg.appendChild(el('text', { x: width / 2, y: height / 2, class: 'chart-empty', 'text-anchor': 'middle' }, [emptyText]));
      return;
    }
    const yMax = niceMax(Math.max(...totals) * 1.08);
    drawGrid(svg, pad, innerW, innerH, yMax, yFormat);
    const slot = innerW / n, barW = Math.max(2, Math.min(28, slot * 0.68));
    const step = Math.max(1, Math.round(n / xTicks));
    xs.forEach((x, i) => {
      const cx = pad.left + slot * i + slot / 2;
      let yCursor = pad.top + innerH;
      const group = el('g', { class: 'chart-bar-group' });
      series.forEach((s, si) => {
        const v = s.values[i] || 0;
        if (!v) return;
        const h = (v / yMax) * innerH;
        yCursor -= h;
        group.appendChild(el('rect', { x: cx - barW / 2, y: yCursor, width: barW, height: h, rx: 2, fill: s.color || PALETTE[si % PALETTE.length], class: 'chart-bar' }));
      });
      svg.appendChild(group);
      if (i % step === 0) svg.appendChild(el('text', { x: cx, y: height - 8, class: 'chart-xlabel', 'text-anchor': 'middle' }, [xFormat ? xFormat(x, i) : String(x)]));
      const hit = el('rect', { x: pad.left + slot * i, y: pad.top, width: slot, height: innerH, fill: 'transparent' });
      hit.addEventListener('mousemove', event => {
        const rect = svg.getBoundingClientRect();
        const rows = series.map((s, si) => `<div class="tip-row"><i style="background:${s.color || PALETTE[si % PALETTE.length]}"></i>${s.name}<b>${(tooltipFormat || yFormat)(s.values[i] || 0, i)}</b></div>`).join('');
        showTip(svg, (cx / width) * rect.width, ((pad.top + innerH - (totals[i] / yMax) * innerH) / height) * rect.height, `<div class="tip-head">${xFormat ? xFormat(x, i, true) : x}</div>${rows}${series.length > 1 ? `<div class="tip-row tip-total">Total<b>${(tooltipFormat || yFormat)(totals[i], i)}</b></div>` : ''}`);
      });
      hit.addEventListener('mouseleave', hideTip);
      svg.appendChild(hit);
    });
  }

  // ── Horizontal ranked bars ───────────────────────────────
  // rows: [{ label, value, color?, hint? }]
  function rankedBars(container, { rows, max = 10, format = fmtInt, emptyText = 'No data yet', labelFormat }) {
    container.innerHTML = '';
    const sorted = [...rows].filter(r => r.value > 0).sort((a, b) => b.value - a.value);
    const total = sorted.reduce((s, r) => s + r.value, 0);
    if (!sorted.length) { container.appendChild(html('div', 'chart-empty-block', emptyText)); return; }
    const shown = sorted.slice(0, max);
    const rest = sorted.slice(max).reduce((s, r) => s + r.value, 0);
    if (rest > 0) shown.push({ label: `Other (${sorted.length - max})`, value: rest, color: '#4a5262' });
    const top = shown[0].value;
    const list = html('div', 'rank-list');
    shown.forEach((row, i) => {
      const item = html('div', 'rank-row');
      const label = html('div', 'rank-label');
      label.appendChild(html('span', 'rank-name', labelFormat ? labelFormat(row) : row.label));
      label.appendChild(html('span', 'rank-value', `${format(row.value)} · ${fmtPct(row.value, total)}`));
      const track = html('div', 'rank-track');
      const bar = html('div', 'rank-bar');
      bar.style.width = `${Math.max(1.5, (row.value / top) * 100)}%`;
      bar.style.background = row.color || PALETTE[i % PALETTE.length];
      track.appendChild(bar);
      item.appendChild(label); item.appendChild(track);
      if (row.hint) item.title = row.hint;
      list.appendChild(item);
    });
    container.appendChild(list);
  }

  // ── Donut with legend ────────────────────────────────────
  function donut(container, { rows, format = fmtInt, size = 132, emptyText = 'No data yet' }) {
    container.innerHTML = '';
    const data = rows.filter(r => r.value > 0).sort((a, b) => b.value - a.value);
    const total = data.reduce((s, r) => s + r.value, 0);
    if (!total) { container.appendChild(html('div', 'chart-empty-block', emptyText)); return; }
    const wrap = html('div', 'donut-wrap');
    const r = size / 2 - 10, c = size / 2, circ = 2 * Math.PI * r;
    const svg = el('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, class: 'donut-svg' });
    svg.appendChild(el('circle', { cx: c, cy: c, r, class: 'donut-track' }));
    let offset = 0;
    data.forEach((row, i) => {
      const len = (row.value / total) * circ;
      const seg = el('circle', { cx: c, cy: c, r, class: 'donut-seg', stroke: row.color || PALETTE[i % PALETTE.length], 'stroke-dasharray': `${len} ${circ - len}`, 'stroke-dashoffset': -offset, transform: `rotate(-90 ${c} ${c})` });
      seg.addEventListener('mousemove', e => { const rect = svg.getBoundingClientRect(); showTip(svg, e.clientX - rect.left, e.clientY - rect.top, `<div class="tip-row"><i style="background:${row.color || PALETTE[i % PALETTE.length]}"></i>${row.label}<b>${format(row.value)} · ${fmtPct(row.value, total)}</b></div>`); });
      seg.addEventListener('mouseleave', hideTip);
      svg.appendChild(seg);
      offset += len;
    });
    svg.appendChild(el('text', { x: c, y: c - 2, class: 'donut-total', 'text-anchor': 'middle' }, [fmtCompact(total)]));
    svg.appendChild(el('text', { x: c, y: c + 14, class: 'donut-sub', 'text-anchor': 'middle' }, ['total']));
    wrap.appendChild(svg);
    const legend = html('div', 'donut-legend');
    data.slice(0, 6).forEach((row, i) => {
      const item = html('div', 'legend-row');
      const sw = html('i'); sw.style.background = row.color || PALETTE[i % PALETTE.length];
      item.appendChild(sw);
      item.appendChild(html('span', 'legend-name', row.label));
      item.appendChild(html('b', null, fmtPct(row.value, total)));
      legend.appendChild(item);
    });
    wrap.appendChild(legend);
    container.appendChild(wrap);
  }

  // ── Weekday × hour heat-map ──────────────────────────────
  // cells: number[7][24] (Mon..Sun × 0..23), values already averaged
  function heatmap(container, { cells, format = v => v.toFixed(1), title = '', emptyText = 'No data yet' }) {
    container.innerHTML = '';
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const flat = cells.flat().filter(Number.isFinite);
    const max = Math.max(0, ...flat);
    if (!max) { container.appendChild(html('div', 'chart-empty-block', emptyText)); return; }
    const width = chartWidth(container);
    const left = 34, top = 18, cellW = (width - left - 6) / 24, cellH = 20;
    const height = top + cellH * 7 + 6;
    const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height, class: 'chart-svg heat-svg' });
    for (let h = 0; h < 24; h += 3) svg.appendChild(el('text', { x: left + h * cellW + cellW / 2, y: 11, class: 'chart-xlabel', 'text-anchor': 'middle' }, [`${String(h).padStart(2, '0')}h`]));
    days.forEach((day, d) => {
      svg.appendChild(el('text', { x: left - 6, y: top + d * cellH + cellH / 2 + 3.5, class: 'chart-ylabel', 'text-anchor': 'end' }, [day]));
      for (let h = 0; h < 24; h++) {
        const v = cells[d][h] || 0;
        const alpha = v > 0 ? 0.12 + 0.88 * Math.sqrt(v / max) : 0;
        const rect = el('rect', { x: left + h * cellW + 1, y: top + d * cellH + 1, width: Math.max(1, cellW - 2), height: cellH - 2, rx: 3, class: 'heat-cell', fill: v > 0 ? `rgba(225,6,0,${alpha.toFixed(3)})` : 'rgba(255,255,255,0.035)' });
        rect.addEventListener('mousemove', e => { const r = svg.getBoundingClientRect(); showTip(svg, e.clientX - r.left, e.clientY - r.top, `<div class="tip-head">${day} ${String(h).padStart(2, '0')}:00–${String(h).padStart(2, '0')}:59</div><div class="tip-row">${title}<b>${format(v)}</b></div>`); });
        rect.addEventListener('mouseleave', hideTip);
        svg.appendChild(rect);
      }
    });
    container.appendChild(svg);
  }

  // ── Duration histogram (simple vertical bars with labels) ─
  function histogram(container, { labels, values, color = '#60a5fa', height = 150, emptyText = 'No completed sessions yet' }) {
    container.innerHTML = '';
    const total = values.reduce((s, v) => s + v, 0);
    if (!total) { container.appendChild(html('div', 'chart-empty-block', emptyText)); return; }
    const width = chartWidth(container);
    const pad = { top: 22, right: 10, bottom: 24, left: 10 };
    const innerW = width - pad.left - pad.right, innerH = height - pad.top - pad.bottom;
    const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height, class: 'chart-svg' });
    const max = Math.max(...values);
    const slot = innerW / values.length, barW = Math.min(64, slot * 0.6);
    values.forEach((v, i) => {
      const cx = pad.left + slot * i + slot / 2;
      const h = max ? (v / max) * innerH : 0;
      svg.appendChild(el('rect', { x: cx - barW / 2, y: pad.top + innerH - h, width: barW, height: h, rx: 3, fill: color, class: 'chart-bar', opacity: 0.4 + 0.6 * (v / max) }));
      svg.appendChild(el('text', { x: cx, y: pad.top + innerH - h - 6, class: 'chart-value', 'text-anchor': 'middle' }, [`${fmtPct(v, total)}`]));
      svg.appendChild(el('text', { x: cx, y: height - 7, class: 'chart-xlabel', 'text-anchor': 'middle' }, [labels[i]]));
    });
    container.appendChild(svg);
  }

  function sparkline(container, values, { color = '#00d57e', height = 34 } = {}) {
    container.innerHTML = '';
    const width = Math.max(80, container.clientWidth || 120);
    const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height, class: 'spark-svg' });
    const max = Math.max(1, ...values), n = values.length;
    if (n > 1) {
      const pts = values.map((v, i) => `${((i / (n - 1)) * width).toFixed(1)},${(height - 3 - (v / max) * (height - 6)).toFixed(1)}`);
      svg.appendChild(el('polyline', { points: pts.join(' '), fill: 'none', stroke: color, 'stroke-width': 1.5, 'stroke-linejoin': 'round' }));
    }
    container.appendChild(svg);
  }

  return { lineChart, barChart, rankedBars, donut, heatmap, histogram, sparkline, PALETTE, fmtInt, fmtCompact, fmtDuration, fmtPct, timeFmt, dayFmt, dayHourFmt, fullDayFmt, hideTip, invalidateWidths, prepare };
})();
