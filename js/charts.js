/* charts.js - 依存なしのSVGチャート
 *   donut(items)                 ドーナツ
 *   bars(items, opts)            棒グラフ（単一 or value2 で2系列）
 *   line(seriesList, opts)       折れ線（複数系列）
 */
(function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  };

  // items: [{label, value, color}]
  function donut(items, size) {
    size = size || 180;
    const total = items.reduce((s, i) => s + i.value, 0);
    const svg = el('svg', { width: size, height: size, viewBox: '0 0 42 42' });
    if (!total) {
      const c = el('circle', { cx: 21, cy: 21, r: 15.9, fill: 'none', stroke: 'var(--surface2)', 'stroke-width': 6 });
      svg.appendChild(c);
      return svg;
    }
    const r = 15.9, C = 2 * Math.PI * r;
    let offset = 25;
    for (const it of items) {
      const frac = it.value / total;
      const len = Math.max(frac * 100 - 0.6, 0.4);
      const c = el('circle', {
        cx: 21, cy: 21, r, fill: 'none',
        stroke: it.color, 'stroke-width': 6,
        'stroke-dasharray': len + ' ' + (100 - len),
        'stroke-dashoffset': offset,
      });
      svg.appendChild(c);
      offset -= frac * 100;
    }
    const t = el('text', { x: 21, y: 20, 'text-anchor': 'middle', 'font-size': 4.5, fill: 'var(--text-sub)' });
    t.textContent = '支出合計';
    const t2 = el('text', { x: 21, y: 25.5, 'text-anchor': 'middle', 'font-size': 5, 'font-weight': 'bold', fill: 'var(--text)' });
    t2.textContent = '¥' + total.toLocaleString();
    svg.appendChild(t); svg.appendChild(t2);
    return svg;
  }

  // items: [{label, value, value2?, highlight, color?}]
  // value2 を渡すと2系列の棒（収入/支出など）
  function bars(items, opts) {
    opts = opts || {};
    const w = opts.width || 640, h = opts.height || 160;
    const pad = { l: 40, r: 8, t: 10, b: 22 };
    const max = Math.max(...items.map(i => Math.max(i.value || 0, i.value2 || 0)), 1);
    const svg = el('svg', { width: '100%', height: h, viewBox: '0 0 ' + w + ' ' + h, preserveAspectRatio: 'none' });
    const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
    for (let g = 0; g <= 3; g++) {
      const y = pad.t + ih - (ih * g / 3);
      svg.appendChild(el('line', { x1: pad.l, x2: w - pad.r, y1: y, y2: y, stroke: 'var(--border)', 'stroke-width': 1 }));
      const lbl = el('text', { x: pad.l - 6, y: y + 3, 'text-anchor': 'end', 'font-size': 9, fill: 'var(--text-sub)' });
      lbl.textContent = Math.round(max * g / 3 / 1000) + 'k';
      svg.appendChild(lbl);
    }
    const bw = iw / items.length;
    items.forEach((it, i) => {
      const cx = pad.l + i * bw + bw / 2;
      const has2 = it.value2 !== undefined;
      const mk = (val, fill, dx, wdt) => {
        const bh = val / max * ih;
        const rect = el('rect', {
          x: cx - (has2 ? bw * 0.32 : bw * 0.3) + dx, y: pad.t + ih - bh,
          width: wdt, height: Math.max(bh, val ? 1 : 0),
          rx: 2, fill, opacity: val ? 0.9 : 0,
        });
        const title = el('title', {});
        title.textContent = it.label + ': ¥' + val.toLocaleString();
        rect.appendChild(title);
        svg.appendChild(rect);
      };
      if (has2) {
        mk(it.value, it.color || 'var(--income)', 0, bw * 0.3);
        mk(it.value2, 'var(--expense)', bw * 0.32, bw * 0.3);
      } else {
        mk(it.value, it.highlight ? 'var(--primary)' : (it.color || 'var(--expense)'), 0, bw * 0.6);
      }
      if (it.showLabel) {
        const lbl = el('text', { x: cx, y: h - 8, 'text-anchor': 'middle', 'font-size': 9, fill: 'var(--text-sub)' });
        lbl.textContent = it.label;
        svg.appendChild(lbl);
      }
    });
    return svg;
  }

  // seriesList: [{name, color, points:[{x, y}]}]  xは連番、yは値
  function line(seriesList, opts) {
    opts = opts || {};
    const w = opts.width || 640, h = opts.height || 180;
    const pad = { l: 44, r: 10, t: 10, b: 22 };
    const svg = el('svg', { width: '100%', height: h, viewBox: '0 0 ' + w + ' ' + h, preserveAspectRatio: 'none' });
    const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
    const all = seriesList.flatMap(s => s.points.map(p => p.y));
    const max = Math.max(...all, 1);
    const min = Math.min(...all, 0);
    const range = max - min || 1;
    const xMax = Math.max(...seriesList.flatMap(s => s.points.map(p => p.x)), 1);
    const X = x => pad.l + (x / xMax) * iw;
    const Y = y => pad.t + ih - ((y - min) / range) * ih;
    for (let g = 0; g <= 3; g++) {
      const yy = pad.t + ih - (ih * g / 3);
      svg.appendChild(el('line', { x1: pad.l, x2: w - pad.r, y1: yy, y2: yy, stroke: 'var(--border)', 'stroke-width': 1 }));
      const lbl = el('text', { x: pad.l - 6, y: yy + 3, 'text-anchor': 'end', 'font-size': 9, fill: 'var(--text-sub)' });
      lbl.textContent = Math.round((min + range * g / 3) / 1000) + 'k';
      svg.appendChild(lbl);
    }
    for (const s of seriesList) {
      const pts = s.points.map(p => X(p.x) + ',' + Y(p.y)).join(' ');
      svg.appendChild(el('polyline', { points: pts, fill: 'none', stroke: s.color, 'stroke-width': 2 }));
      for (const p of s.points) {
        const c = el('circle', { cx: X(p.x), cy: Y(p.y), r: 2.5, fill: s.color });
        const title = el('title', {});
        title.textContent = s.name + ' ' + (p.label || p.x) + ': ¥' + p.y.toLocaleString();
        c.appendChild(title);
        svg.appendChild(c);
      }
    }
    // x軸ラベル（先頭系列のラベルを使用）
    const labels = seriesList[0] ? seriesList[0].points : [];
    for (const p of labels) {
      if (!p.label) continue;
      const lbl = el('text', { x: X(p.x), y: h - 6, 'text-anchor': 'middle', 'font-size': 9, fill: 'var(--text-sub)' });
      lbl.textContent = p.label;
      svg.appendChild(lbl);
    }
    return svg;
  }

  window.Charts = { donut, bars, line };
  globalThis.Charts = window.Charts;
})();
