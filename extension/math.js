// LaTeX -> vector shapes for note pages. MathJax (loaded only when a note contains math) turns TeX
// into SVG; this flattens that SVG into absolute path outlines measured in MathJax units (1/1000 em),
// with the box's top-left at (0, 0) and y pointing down, ready for pdf-lib's drawSvgPath.

let ready = null;

export function loadMath() {
  ready ??= new Promise((ok, no) => {
    window.MathJax = {
      startup: { typeset: false },
      svg: { fontCache: 'none' },          // every glyph as its own path, no <use> references
      options: { enableMenu: false },
    };
    const s = document.createElement('script');
    s.src = new URL('./lib/mathjax/tex-svg-full.js', import.meta.url).href;
    s.onload = () => window.MathJax.startup.promise.then(ok, no);
    s.onerror = () => no(new Error('MathJax could not be loaded'));
    document.head.append(s);
  }).catch(e => { ready = null; throw e; });
  return ready;
}

// Does this Markdown contain math? $…$, $$…$$, \(…\) or \[…\]
export const hasMath = md => /\$\$[\s\S]+?\$\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]|(^|[^\\$\w])\$(?=\S)[^$\n]*?\S\$(?!\d)/.test(md);

const mul = ([a, b, c, d, e, f], [A, B, C, D, E, F]) =>
  [a * A + c * B, b * A + d * B, a * C + c * D, b * C + d * D, a * E + c * F + e, b * E + d * F + f];
const apply = ([a, b, c, d, e, f], x, y) => [a * x + c * y + e, b * x + d * y + f];

function parseTransform(t) {
  let m = [1, 0, 0, 1, 0, 0];
  for (const [, fn, args] of t.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const v = args.split(/[\s,]+/).filter(Boolean).map(Number);
    const step = {
      translate: [1, 0, 0, 1, v[0] || 0, v[1] || 0],
      scale: [v[0], 0, 0, v[1] ?? v[0], 0, 0],
      matrix: v,
      rotate: (() => { const r = (v[0] || 0) * Math.PI / 180; return [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]; })(),
    }[fn];
    if (step) m = mul(m, step);
  }
  return m;
}

// SVG path data -> absolute M / L / C / Z through matrix m.
function transformPath(d, m) {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/g) || [];
  const out = [], f = v => +v.toFixed(1);
  const put = (cmd, ...pts) => out.push(cmd + pts.map(([x, y]) => { const [X, Y] = apply(m, x, y); return f(X) + ' ' + f(Y); }).join(' '));
  let i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0, cx = null, cy = null, qx = null, qy = null;
  const num = () => +tokens[i++];
  while (i < tokens.length) {
    if (/[a-z]/i.test(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    let nc = null, nq = null;
    if (C === 'Z') { out.push('Z'); x = sx; y = sy; cmd = ''; cx = cy = qx = qy = null; continue; }
    if (C === 'M') { x = ox + num(); y = oy + num(); sx = x; sy = y; put('M', [x, y]); cmd = rel ? 'l' : 'L'; }
    else if (C === 'L') { x = ox + num(); y = oy + num(); put('L', [x, y]); }
    else if (C === 'H') { x = ox + num(); put('L', [x, y]); }
    else if (C === 'V') { y = oy + num(); put('L', [x, y]); }
    else if (C === 'C' || C === 'S') {
      let x1, y1;
      if (C === 'C') { x1 = ox + num(); y1 = oy + num(); }
      else { x1 = cx !== null ? 2 * x - cx : x; y1 = cy !== null ? 2 * y - cy : y; }
      const x2 = ox + num(), y2 = oy + num(), ex = ox + num(), ey = oy + num();
      put('C', [x1, y1], [x2, y2], [ex, ey]); nc = [x2, y2]; x = ex; y = ey;
    } else if (C === 'Q' || C === 'T') {
      let qx1, qy1;
      if (C === 'Q') { qx1 = ox + num(); qy1 = oy + num(); }
      else { qx1 = qx !== null ? 2 * x - qx : x; qy1 = qy !== null ? 2 * y - qy : y; }
      const ex = ox + num(), ey = oy + num();
      put('C', [x + 2 / 3 * (qx1 - x), y + 2 / 3 * (qy1 - y)], [ex + 2 / 3 * (qx1 - ex), ey + 2 / 3 * (qy1 - ey)], [ex, ey]);
      nq = [qx1, qy1]; x = ex; y = ey;
    } else if (C === 'A') {   // arcs don't occur in MathJax glyphs; a straight line keeps the shape closed
      i += 5; x = ox + num(); y = oy + num(); put('L', [x, y]);
    } else { i++; continue; }
    [cx, cy] = nc ?? [null, null];
    [qx, qy] = nq ?? [null, null];
  }
  return out.join(' ');
}

const unit = v => parseFloat(v) || 0;

// Returns { w, asc, desc, items } in MathJax units; baseline is at y = asc from the top.
export function typeset(tex, display) {
  const svg = window.MathJax.tex2svg(tex, { display }).querySelector('svg');
  const err = svg.querySelector('[data-mml-node="merror"]');
  if (err) throw new Error(err.getAttribute('data-mjx-error') || 'TeX error');   // caller shows the source instead
  const [minX, minY, w, h] = svg.getAttribute('viewBox').split(/[\s,]+/).map(Number);
  const items = [];
  const walk = (el, m, fill, stroke) => {
    for (const c of el.children) {
      const tag = c.tagName.toLowerCase();
      let cm = m;
      if (tag === 'svg') cm = mul(cm, [1, 0, 0, 1, unit(c.getAttribute('x')), unit(c.getAttribute('y'))]);
      const t = c.getAttribute('transform');
      if (t) cm = mul(cm, parseTransform(t));
      const f = c.getAttribute('fill') ?? fill, s = c.getAttribute('stroke') ?? stroke;
      if (tag === 'g' || tag === 'svg' || tag === 'a') walk(c, cm, f, s);
      else if (tag === 'path' && c.getAttribute('d') && f !== 'none') items.push({ d: transformPath(c.getAttribute('d'), cm), fill: f });
      else if (tag === 'rect' && f !== 'none') {
        const x = unit(c.getAttribute('x')), y = unit(c.getAttribute('y')), rw = unit(c.getAttribute('width')), rh = unit(c.getAttribute('height'));
        items.push({ d: transformPath(`M${x} ${y}H${x + rw}V${y + rh}H${x}Z`, cm), fill: f, back: c.hasAttribute('data-background') });
      } else if (tag === 'line') {
        const [x1, y1] = apply(cm, unit(c.getAttribute('x1')), unit(c.getAttribute('y1')));
        const [x2, y2] = apply(cm, unit(c.getAttribute('x2')), unit(c.getAttribute('y2')));
        items.push({ line: [x1, y1, x2, y2], width: unit(c.getAttribute('stroke-width')) * Math.hypot(cm[0], cm[1]), fill: s });
      } else if (tag === 'text' && c.textContent.trim()) {
        const [x, y] = apply(cm, unit(c.getAttribute('x')), unit(c.getAttribute('y')));
        items.push({ text: c.textContent, x, y, size: unit(c.getAttribute('font-size') || 1000) * Math.abs(cm[3]), fill: f });
      }
    }
  };
  walk(svg, [1, 0, 0, 1, -minX, -minY], 'currentColor', 'currentColor');
  items.sort((a, b) => (b.back ? 1 : 0) - (a.back ? 1 : 0));   // background boxes first
  return { w, asc: -minY, desc: minY + h, items };
}

const probe = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;

// CSS colour -> [r, g, b] in 0..1, or null for "use the text colour".
export function cssColor(c) {
  if (!c || c === 'currentColor' || !probe) return null;
  probe.fillStyle = '#000';
  probe.fillStyle = c;
  const v = probe.fillStyle;
  if (v.startsWith('#')) return [1, 3, 5].map(i => parseInt(v.slice(i, i + 2), 16) / 255);
  const n = v.match(/[\d.]+/g)?.map(Number);
  return n ? n.slice(0, 3).map(x => x / 255) : null;
}
