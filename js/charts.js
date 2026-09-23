/* charts.js - 依存なしのSVGチャート */
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
    let offset = 25; // 12時開始
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

  // items: [{label, value, highlight}]
  function bars(items, opts) {
    opts = opts || {};
    const w = opts.width || 640, h = opts.height || 160;
    const pad = { l: 40, r: 8, t: 10, b: 22 };
    const max = Math.max(...items.map(i => i.value), 1);
    const svg = el('svg', { width: '100%', height: h, viewBox: '0 0 ' + w + ' ' + h, preserveAspectRatio: 'none' });
    const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
    // グリッド
    for (let g = 0; g <= 3; g++) {
      const y = pad.t + ih - (ih * g / 3);
      svg.appendChild(el('line', { x1: pad.l, x2: w - pad.r, y1: y, y2: y, stroke: 'var(--border)', 'stroke-width': 1 }));
      const lbl = el('text', { x: pad.l - 6, y: y + 3, 'text-anchor': 'end', 'font-size': 9, fill: 'var(--text-sub)' });
      lbl.textContent = Math.round(max * g / 3 / 1000) + 'k';
      svg.appendChild(lbl);
    }
    const bw = iw / items.length;
    items.forEach((it, i) => {
      const bh = it.value / max * ih;
      const x = pad.l + i * bw + bw * 0.2;
      const rect = el('rect', {
        x, y: pad.t + ih - bh, width: bw * 0.6, height: Math.max(bh, it.value ? 1 : 0),
        rx: 2, fill: it.highlight ? 'var(--primary)' : 'var(--expense)', opacity: it.value ? 0.9 : 0,
      });
      const title = el('title', {});
      title.textContent = it.label + ': ¥' + it.value.toLocaleString();
      rect.appendChild(title);
      svg.appendChild(rect);
      if (it.showLabel) {
        const lbl = el('text', { x: pad.l + i * bw + bw / 2, y: h - 8, 'text-anchor': 'middle', 'font-size': 9, fill: 'var(--text-sub)' });
        lbl.textContent = it.label;
        svg.appendChild(lbl);
      }
    });
    return svg;
  }

  window.Charts = { donut, bars };
})();

