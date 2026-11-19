// Text boxes: plain text in Helvetica (one of the PDF standard fonts) with inline LaTeX ($…$, \(…\), $$…$$)
// and emoji. One layout, measured with Helvetica's own metrics, is used both to draw the box on screen (as SVG)
// and to write its appearance into the saved PDF, so the two always match. Helvetica has no emoji, so each one is
// drawn once with the system's colour-emoji font into a small picture, shown on screen and embedded in the PDF.
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

// Emoji. A grapheme is one when it's pictographic (or a flag or keycap) and not a character Helvetica has (©, ®, ™).
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u;
const graphemes = s => typeof Intl.Segmenter === 'function'
  ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].map(g => g.segment) : [...s];
const isEmoji = (g, set) => EMOJI.test(g) && !(g.length === 1 && set.has(g.codePointAt(0)));
// Room an emoji takes in a line, and the square its picture is drawn in, as fractions of the text size.
const E_ADV = 1.2, E_BOX = 1.25, E_MID = 0.34;   // E_MID: its centre, above the baseline

// One emoji drawn with the system's colour-emoji font -> { url, png } (a PNG, and the same as a data: URL),
// or null where there's no canvas (saving under Node) or no font has it (the picture came out empty).
const EMOJI_PX = 96, EMOJI_FONT = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", "Segoe UI Symbol", sans-serif';
const emojiPics = new Map();
export function emojiPicture(g) {
  if (!emojiPics.has(g)) emojiPics.set(g, (async () => {
    if (typeof OffscreenCanvas !== 'function') return null;
    const c = new OffscreenCanvas(EMOJI_PX, EMOJI_PX), x = c.getContext('2d');
    if (!x) return null;
    x.font = `${Math.round(EMOJI_PX * 0.75)}px ${EMOJI_FONT}`;
    const m = x.measureText(g);   // centred by its ink, whatever the font's metrics
    x.fillText(g, EMOJI_PX / 2 - (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2 + m.actualBoundingBoxLeft,
      EMOJI_PX / 2 + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2);
    const px = x.getImageData(0, 0, EMOJI_PX, EMOJI_PX).data;
    let ink = false;
    for (let i = 3; i < px.length && !ink; i += 4) ink = px[i] > 0;
    if (!ink) return null;
    const png = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
    let bin = '';
    for (let i = 0; i < png.length; i += 0x8000) bin += String.fromCharCode(...png.subarray(i, i + 0x8000));
    return { url: 'data:image/png;base64,' + btoa(bin), png };
  })().catch(() => null));
  return emojiPics.get(g);
}

// Plain text -> runs of text and single emoji: [{ text } | { emoji }]. Without a canvas the emoji are left in the
// text, where cleanWith drops them as before.
function emojiRuns(s, set) {
  const out = [];
  for (const g of graphemes(s)) {
    if (isEmoji(g, set)) out.push({ emoji: g });
    else if (out.length && out.at(-1).text !== undefined) out.at(-1).text += g;
    else out.push({ text: g });
  }
  return out;
}

// The width of plain text (emoji included) at this size, as layout() lays it out.
function widthOf(f, set, s, size) {
  const clean = cleanWith(set);
  let w = 0;
  for (const r of emojiRuns(s, set)) w += r.emoji !== undefined ? E_ADV * size : f.widthOfTextAtSize(clean(r.text), size);
  return w;
}

// Math: $$…$$ and \[…\] (display), \(…\) and $…$ (inline).
const MATH = /\$\$([^$]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<![\\$\w])\$(?=\S)([^$]*?\S)\$(?![\d$])/g;

// Math copied from elsewhere often spans lines ($$ on a line of its own, say). Its line breaks become spaces,
// so each formula stays in one piece; the rest of the text keeps its lines.
export const joinMath = text => text.replace(/\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)/g, m => m.replace(/\s*\n\s*/g, ' '));

// Splits a line into text and math runs.
function runs(line) {
  const out = [], re = new RegExp(MATH.source, 'g');
  let at = 0, m;
  while ((m = re.exec(line))) {
    if (m.index > at) out.push({ text: line.slice(at, m.index) });
    out.push({ tex: (m[1] ?? m[2] ?? m[3] ?? m[4]).trim(), display: m[1] !== undefined || m[2] !== undefined, src: m[0] });
    at = m.index + m[0].length;
  }
  if (at < line.length) out.push({ text: line.slice(at) });
  return out;
}

const cache = new Map();   // `${size}|${text}` -> layout (a promise while it's being made)
export const cached = (text, size) => cache.get(size + '|' + text);

// -> { w, h, lines: [{ base, items: [{ x, str, w } | { x, math, k, w } | { x, emoji, pic, w }] }], emoji: [g…] }
//    (base: baseline from the top; emoji: those used, in order, whose pictures pdfOps draws as /E0, /E1, …)
export function layout(text, size) {
  const key = size + '|' + text;
  if (cache.has(key)) return cache.get(key);   // the layout, or the promise of it
  const job = (async () => {
    const { f, set } = await font();
    const clean = cleanWith(set);
    let math = false;
    if (hasMath(text)) { try { await loadMath(); math = true; } catch {} }
    const k = size / 1000;   // MathJax units are 1/1000 em
    const lines = [], used = [];
    let y = PAD, w = 0;
    for (const raw of joinMath(text.replace(/\r\n?|[\v\f\u0085\u2028\u2029]/g, '\n')).split('\n')) {   // any line break
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
        for (const part of emojiRuns(r.text ?? r.src, set)) {
          const pic = part.emoji !== undefined && await emojiPicture(part.emoji);
          if (pic) {
            if (!used.includes(part.emoji)) used.push(part.emoji);
            items.push({ x, emoji: part.emoji, pic, w: E_ADV * size });
            x += E_ADV * size;
            asc = Math.max(asc, (E_MID + E_BOX / 2) * size);
            desc = Math.max(desc, (E_BOX / 2 - E_MID) * size);
            continue;
          }
          const str = clean(part.text ?? part.emoji);   // (an emoji with no picture is dropped)
          if (!str) continue;
          const sw = f.widthOfTextAtSize(str, size);
          items.push({ x, str, w: sw });
          x += sw;
        }
      }
      const lead = size * 0.2;
      lines.push({ base: y + asc, items });
      y += asc + desc + lead;
      w = Math.max(w, x);
    }
    const out = { size, w: Math.max(w + PAD, size * 0.6), h: y - size * 0.2 + PAD, lines, emoji: used, encode: s => f.encodeText(s).toString() };
    cache.set(key, out);
    return out;
  })();
  cache.set(key, job);
  job.catch(() => cache.delete(key));
  return job;
}

// Any colour (from the palette, a PDF, or \color{…} in a formula) as a plain #rrggbb, so nothing but a colour
// ever reaches the markup below; anything unrecognised is the text colour.
const hex = (c, fallback) => {
  const v = cssColor(c);
  return v ? '#' + v.map(x => Math.round(clampByte(x * 255)).toString(16).padStart(2, '0')).join('') : fallback;
};
const clampByte = v => Math.min(255, Math.max(0, v || 0));

// Where an emoji's picture goes: [x, y, side], its top-left corner from the box's, in points.
const emojiBox = (it, line, size) => [it.x + (it.w - E_BOX * size) / 2, line.base - (E_MID + E_BOX / 2) * size, E_BOX * size];

// The laid-out box as SVG markup, in points (the caller positions and scales it).
export function svgOf(L, color) {
  const esc = s => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  color = hex(color, '#000000');
  let out = '';
  for (const line of L.lines) {
    for (const it of line.items) {
      if (it.emoji !== undefined) {
        const [ex, ey, es] = emojiBox(it, line, L.size);
        out += `<image href="${esc(it.pic.url)}" x="${ex}" y="${ey}" width="${es}" height="${es}"/>`;
        continue;
      }
      if (it.str !== undefined) {
        out += `<text x="${it.x}" y="${line.base}" font-family='${FONT_STACK}' font-size="${L.size}" fill="${color}" textLength="${it.w}" lengthAdjust="spacingAndGlyphs" xml:space="preserve">${esc(it.str)}</text>`;
        continue;
      }
      const top = line.base - it.math.asc * it.k;
      out += `<g transform="translate(${it.x} ${top}) scale(${it.k})">`;
      for (const g of it.math.items) {
        const c = g.fill && g.fill !== 'currentColor' ? hex(g.fill, color) : color;
        if (g.d) out += `<path d="${esc(g.d)}" fill="${c}"/>`;
        else if (g.line) out += `<line x1="${+g.line[0]}" y1="${+g.line[1]}" x2="${+g.line[2]}" y2="${+g.line[3]}" stroke="${c}" stroke-width="${+g.width}"/>`;
        else if (g.text) out += `<text x="${+g.x}" y="${+g.y}" font-family='${FONT_STACK}' font-size="${+g.size}" fill="${c}">${esc(g.text)}</text>`;
      }
      out += '</g>';
    }
  }
  return out;
}

// PDF content-stream operators drawing the box with its top-left at (X, Y) in page space.
// The font must be available in the stream's resources as /Helv, and each emoji's picture (L.emoji[k]) as /Ek.
export function pdfOps(L, X, Y, rgb) {
  const n = v => +v.toFixed(3), ops = [], col = rgb.map(n).join(' ');
  const pt = (x, y) => `${n(X + x)} ${n(Y - y)}`;
  for (const line of L.lines) {
    for (const it of line.items) {
      if (it.emoji !== undefined) {
        const [ex, ey, es] = emojiBox(it, line, L.size);
        ops.push(`q ${n(es)} 0 0 ${n(es)} ${pt(ex, ey + es)} cm /E${L.emoji.indexOf(it.emoji)} Do Q`);
        continue;
      }
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
  const wOf = s => widthOf(f, set, s, size);
  const out = [];
  for (const para of joinMath(text).split('\n')) {
    let line = '';
    // Words keep the space after them; a formula counts as one word, so it's never broken across lines.
    const words = para.match(new RegExp(`(?:${MATH.source})\\s*|\\S+\\s*|\\s+`, 'g')) ?? [''];
    for (const word of words) {
      if (new RegExp(MATH.source).test(word)) {   // too wide or not, a formula goes on a line as a whole
        if (line && wOf(line + word.trimEnd()) > maxW) { out.push(line.trimEnd()); line = ''; }
        line += word;
        continue;
      }
      if (line && wOf(line + word.trimEnd()) > maxW) { out.push(line.trimEnd()); line = ''; }
      let w = graphemes(word);   // (by grapheme, so an emoji is never split)
      while (wOf(w.join('').trimEnd()) > maxW && w.length > 1) {   // a single word too long for a line
        let n = w.length - 1;
        while (n > 1 && wOf(w.slice(0, n).join('')) > maxW) n--;
        out.push(w.slice(0, n).join(''));
        w = w.slice(n);
      }
      line += w.join('');
    }
    out.push(line.trimEnd());
  }
  return out.join('\n');
}
