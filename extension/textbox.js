// Text boxes: plain text in Helvetica (one of the PDF standard fonts) with inline LaTeX ($…$, \(…\), $$…$$).
// One layout, measured with Helvetica's own metrics, is used both to draw the box on screen (as SVG)
// and to write its appearance into the saved PDF, so the two always match.
// Units are PDF points, with (0, 0) at the box's top-left and y pointing down.
import { loadMath, hasMath, typeset, cssColor } from './math.js';

export const FONT_STACK = 'Helvetica, Arial, "Liberation Sans", "Nimbus Sans", sans-serif';
export const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48];
export const PAD = 2;   // room around the text inside the box

let helv = null;
async function font() {
  helv ??= (async () => {
    const { PDFDocument, StandardFonts } = await import('./lib/pdf-lib.esm.min.js');
    const f = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    return { f, set: new Set(f.getCharacterSet()) };
  })();
  return helv;
}

const SWAP = { '→': '->', '←': '<-', '⇒': '=>', '≥': '>=', '≤': '<=', '≠': '!=', '≈': '~', '−': '-', ' ': ' ', '\t': '    ', '✓': 'v', '✔': 'v' };
// Characters Helvetica (WinAnsi) can't show become '?'; emoji and invisible marks are dropped.
export const cleanWith = set => s => [...s].map(ch => SWAP[ch] ?? (set.has(ch.codePointAt(0)) ? ch
  : /[​-‏︀-️]|\p{Extended_Pictographic}/u.test(ch) ? '' : '?')).join('');

// Splits a line into text and math runs.
function runs(line) {
  const out = [], re = /\$\$([^$]+?)\$\$|\\\(([\s\S]+?)\\\)|(?<![\\$\w])\$(?=\S)([^$]*?\S)\$(?![\d$])/g;
  let at = 0, m;
  while ((m = re.exec(line))) {
    if (m.index > at) out.push({ text: line.slice(at, m.index) });
    out.push({ tex: (m[1] ?? m[2] ?? m[3]).trim(), display: m[1] !== undefined, src: m[0] });
    at = m.index + m[0].length;
  }
  if (at < line.length) out.push({ text: line.slice(at) });
  return out;
}

const cache = new Map();   // `${size}|${text}` -> layout (a promise while it's being made)
export const cached = (text, size) => cache.get(size + '|' + text);

// -> { w, h, lines: [{ base, items: [{ x, str, w } | { x, math, k, w }] }] }   (base: baseline from the top)
export function layout(text, size) {
  const key = size + '|' + text;
  if (cache.has(key)) return cache.get(key);   // the layout, or the promise of it
  const job = (async () => {
    const { f, set } = await font();
    const clean = cleanWith(set);
    let math = false;
    if (hasMath(text)) { try { await loadMath(); math = true; } catch {} }
    const k = size / 1000;   // MathJax units are 1/1000 em
    const lines = [];
    let y = PAD, w = 0;
    for (const raw of text.split('\n')) {
      const items = [];
      let x = PAD, asc = size * 0.78, desc = size * 0.24;
      for (const r of runs(raw)) {
        if (r.tex !== undefined && math) {
          try {
            const m = typeset(r.tex, r.display);
            items.push({ x, math: m, k, w: m.w * k, tex: r.tex });
            x += m.w * k;
            asc = Math.max(asc, m.asc * k);
            desc = Math.max(desc, m.desc * k);
            continue;
          } catch {}   // invalid TeX: show the source as written
        }
        const str = clean(r.text ?? r.src);
        if (!str) continue;
        const sw = f.widthOfTextAtSize(str, size);
        items.push({ x, str, w: sw });
        x += sw;
      }
      const lead = size * 0.2;
      lines.push({ base: y + asc, items });
      y += asc + desc + lead;
      w = Math.max(w, x);
    }
    const out = { size, w: Math.max(w + PAD, size * 0.6), h: y - size * 0.2 + PAD, lines, encode: s => f.encodeText(s).toString() };
    cache.set(key, out);
    return out;
  })();
  cache.set(key, job);
  job.catch(() => cache.delete(key));
  return job;
}

// The laid-out box as SVG markup, in points (the caller positions and scales it).
export function svgOf(L, color) {
  const esc = s => s.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);
  let out = '';
  for (const line of L.lines) {
    for (const it of line.items) {
      if (it.str !== undefined) {
        out += `<text x="${it.x}" y="${line.base}" font-family='${FONT_STACK}' font-size="${L.size}" fill="${color}" textLength="${it.w}" lengthAdjust="spacingAndGlyphs" xml:space="preserve">${esc(it.str)}</text>`;
        continue;
      }
      const top = line.base - it.math.asc * it.k;
      out += `<g transform="translate(${it.x} ${top}) scale(${it.k})">`;
      for (const g of it.math.items) {
        const c = g.fill && g.fill !== 'currentColor' ? g.fill : color;
        if (g.d) out += `<path d="${g.d}" fill="${c}"/>`;
        else if (g.line) out += `<line x1="${g.line[0]}" y1="${g.line[1]}" x2="${g.line[2]}" y2="${g.line[3]}" stroke="${c}" stroke-width="${g.width}"/>`;
        else if (g.text) out += `<text x="${g.x}" y="${g.y}" font-family='${FONT_STACK}' font-size="${g.size}" fill="${c}">${esc(g.text)}</text>`;
      }
      out += '</g>';
    }
  }
  return out;
}

// PDF content-stream operators drawing the box with its top-left at (X, Y) in page space.
// The font must be available in the stream's resources as /Helv.
export function pdfOps(L, X, Y, rgb) {
  const n = v => +v.toFixed(3), ops = [], col = rgb.map(n).join(' ');
  const pt = (x, y) => `${n(X + x)} ${n(Y - y)}`;
  for (const line of L.lines) {
    for (const it of line.items) {
      if (it.str !== undefined) {
        ops.push(`BT /Helv ${n(L.size)} Tf ${col} rg ${pt(it.x, line.base)} Td ${L.encode(it.str)} Tj ET`);
        continue;
      }
      const top = line.base - it.math.asc * it.k, k = it.k, at = (px, py) => pt(it.x + px * k, top + py * k);
      for (const g of it.math.items) {
        const c = cssColor(g.fill);
        const gc = c ? c.map(n).join(' ') : col;
        if (g.d) {
          const p = [], t = g.d.match(/[MLCZ]|-?[\d.]+(?:e[-+]?\d+)?/g) || [];
          for (let i = 0; i < t.length;) {
            const cmd = t[i++];
            if (cmd === 'Z') { p.push('h'); continue; }
            const cnt = cmd === 'C' ? 3 : 1, xy = [];
            for (let j = 0; j < cnt; j++) xy.push(at(+t[i++], +t[i++]));
            p.push(xy.join(' ') + ' ' + { M: 'm', L: 'l', C: 'c' }[cmd]);
          }
          ops.push(`${gc} rg ${p.join(' ')} f`);
        } else if (g.line) {
          ops.push(`${n(Math.max(0.3, g.width * k))} w ${gc} RG ${at(g.line[0], g.line[1])} m ${at(g.line[2], g.line[3])} l S`);
        } else if (g.text) {
          try { ops.push(`BT /Helv ${n(Math.max(1, g.size * k))} Tf ${gc} rg ${at(g.x, g.y)} Td ${L.encode(g.text)} Tj ET`); } catch {}
        }
      }
    }
  }
  return ops.join('\n');
}

// Breaks text into lines no wider than maxW points (at this size, in Helvetica), at spaces where it can.
// Existing line breaks are kept.
export async function wrapText(text, size, maxW) {
  const { f, set } = await font();
  const clean = cleanWith(set), wOf = s => f.widthOfTextAtSize(clean(s), size);
  const out = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/(?<=\s)/)) {   // words keep the space after them
      if (line && wOf(line + word.trimEnd()) > maxW) { out.push(line.trimEnd()); line = ''; }
      let w = word;
      while (wOf(w.trimEnd()) > maxW && w.length > 1) {   // a single word too long for a line
        let n = w.length - 1;
        while (n > 1 && wOf(w.slice(0, n)) > maxW) n--;
        out.push(w.slice(0, n));
        w = w.slice(n);
      }
      line += w;
    }
    out.push(line.trimEnd());
  }
  return out.join('\n');
}
