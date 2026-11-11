// Turns Markdown into real PDF pages (selectable text, working links) the same size as a given page.
// Supports headings, paragraphs, **bold**, *italic*, ~~strike~~, `code`, links, images (as a label),
// bullet / numbered / task lists (nested), > quotes, fenced code blocks, tables, --- rules and
// LaTeX math: $inline$, \(inline\), $$display$$, \[display\] and \begin{equation|align|…} blocks.
// Text uses the PDF standard fonts, so characters outside Western European text are swapped or dropped.
import { loadMath, hasMath, typeset, cssColor } from './math.js';

export async function notePdf(md, W, H) {
  const {
    PDFDocument, StandardFonts, PDFString, rgb,
    pushGraphicsState, popGraphicsState, setTextRenderingMode, TextRenderingMode,
  } = await import('./lib/pdf-lib.esm.min.js');
  let mathOK = false;
  if (hasMath(md) || /\\begin\{/.test(md)) {
    try { await loadMath(); mathOK = true; } catch {}   // without MathJax, formulas show as their TeX source
  }
  const doc = await PDFDocument.create();
  doc.setProducer('Inkfold');
  const F = {
    r: await doc.embedFont(StandardFonts.Helvetica),
    b: await doc.embedFont(StandardFonts.HelveticaBold),
    i: await doc.embedFont(StandardFonts.HelveticaOblique),
    bi: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
    c: await doc.embedFont(StandardFonts.Courier),
  };
  const C = {
    ink: rgb(0.13, 0.13, 0.12), dim: rgb(0.38, 0.37, 0.35), link: rgb(0.1, 0.36, 0.8),
    rule: rgb(0.85, 0.84, 0.81), codeBg: rgb(0.95, 0.945, 0.93), headBg: rgb(0.96, 0.955, 0.94), bar: rgb(0.8, 0.79, 0.76),
  };
  const charset = new Set(F.r.getCharacterSet());
  const SWAP = { '→': '->', '←': '<-', '⇒': '=>', '↔': '<->', '≥': '>=', '≤': '<=', '≠': '!=', '≈': '~', '✓': '[x]', '✔': '[x]', '✗': 'x', '✘': 'x', '−': '-', ' ': ' ', '\t': '    ' };
  const clean = s => [...s].map(ch => {
    if (SWAP[ch]) return SWAP[ch];
    if (charset.has(ch.codePointAt(0)) || ch === '\n') return ch;
    return /[​-‏︀-️☀-➿]|\p{Extended_Pictographic}/u.test(ch) ? '' : '?';
  }).join('');

  const BASE = 9.5, LEAD = 1.45;
  const m = Math.round(Math.min(72, Math.max(36, Math.min(W, H) * 0.09)));
  const X0 = m, MAXW = W - 2 * m;
  let page, y, links;
  const made = [];
  const atTop = () => y >= H - m - 0.5;
  const newPage = () => {
    page = doc.addPage([W, H]);
    y = H - m;
    links = [];
    made.push({ page, links });
  };
  newPage();
  const room = h => { if (y - h < m && !atTop()) newPage(); };
  const advance = (h, ctx) => {   // move down, drawing any quote bars alongside
    for (const bx of ctx.bars) page.drawRectangle({ x: bx, y: y - h, width: 2.5, height: h, color: C.bar });
    y -= h;
  };
  const gap = (h, ctx) => { if (!atTop()) advance(Math.min(h, y - m), ctx); };

  /* ----- inline Markdown -> styled runs ----- */
  function inline(src, st = {}) {
    const out = [];
    let buf = '';
    const flush = () => { if (buf) out.push({ ...st, text: buf }); buf = ''; };
    const wordy = c => /[\p{L}\p{N}]/u.test(c ?? '');
    src = src.replace(/<br\s*\/?>/gi, '\n');
    for (let i = 0; i < src.length;) {
      const rest = src.slice(i), prev = src[i - 1];
      let mt;
      if ((mt = rest.match(/^(`+)([\s\S]*?[^`])\1(?!`)/))) {
        flush(); out.push({ ...st, code: true, text: mt[2].replace(/^ ([\s\S]*) $/, '$1') });
        i += mt[0].length; continue;
      }
      if ((mt = rest.match(/^\$\$([\s\S]+?)\$\$/) || rest.match(/^\\\(([\s\S]+?)\\\)/) || rest.match(/^\\\[([\s\S]+?)\\\]/)
        || (!/[\\$\w]/.test(prev ?? '') && rest.match(/^\$(?=\S)([^$\n]*?[^\s\\])\$(?!\d)/)))) {
        flush(); out.push(mathRun(mt[1], /^(\$\$|\\\[)/.test(mt[0]), st));
        i += mt[0].length; continue;
      }
      if (rest[0] === '\\' && /[\\`*_{}[\]()#+\-.!~|>$]/.test(rest[1] ?? '')) { buf += rest[1]; i += 2; continue; }
      if ((mt = rest.match(/^!\[([^\]]*)\]\([^)]*\)/))) {
        flush(); out.push({ ...st, italic: true, text: mt[1] ? `[image: ${mt[1]}]` : '[image]' });
      } else if ((mt = rest.match(/^\[((?:[^[\]]|\[[^\]]*\])*)\]\(\s*<?([^)\s>]+)>?(?:\s+["'(][^"')]*["')])?\s*\)/))) {
        flush(); out.push(...inline(mt[1], { ...st, link: mt[2] }));
      } else if ((mt = rest.match(/^<((?:https?:\/\/|mailto:)[^>\s]+)>/))) {
        flush(); out.push({ ...st, link: mt[1], text: mt[1].replace(/^mailto:/, '') });
      } else if (!wordy(prev) && (mt = rest.match(/^https?:\/\/[^\s<]*[^\s<.,:;"')\]!?*_]/))) {
        flush(); out.push({ ...st, link: mt[0], text: mt[0] });
      } else if ((mt = rest.match(/^(\*\*\*|___)(?=\S)([\s\S]*?\S)\1/)) && (mt[1][0] === '*' || !wordy(prev))) {
        flush(); out.push(...inline(mt[2], { ...st, bold: true, italic: true }));
      } else if ((mt = rest.match(/^(\*\*|__)(?=\S)([\s\S]*?\S)\1/)) && (mt[1][0] === '*' || !wordy(prev))) {
        flush(); out.push(...inline(mt[2], { ...st, bold: true }));
      } else if ((mt = rest.match(/^~~(?=\S)([\s\S]*?\S)~~/))) {
        flush(); out.push(...inline(mt[1], { ...st, strike: true }));
      } else if ((mt = rest.match(/^([*_])(?=\S)([\s\S]*?[^\s*_])\1(?![*_])/))
        && (mt[1] === '*' || (!wordy(prev) && !wordy(src[i + mt[0].length])))) {
        flush(); out.push(...inline(mt[2], { ...st, italic: true }));
      } else { buf += rest[0]; i++; continue; }
      i += mt[0].length;
    }
    flush();
    return out;
  }

  function mathRun(tex, display, st) {
    if (mathOK) {
      try { return { ...st, math: typeset(tex.trim(), display), tex: tex.trim(), text: '' }; } catch {}
    }
    return { ...st, code: true, text: tex.trim() };
  }

  const fontOf = r => r.code ? F.c : r.bold && r.italic ? F.bi : r.bold ? F.b : r.italic ? F.i : F.r;

  /* ----- runs -> wrapped lines ----- */
  function wrap(runs, width, size) {
    const lines = [];
    let line = [], w = 0;
    const end = () => {
      while (line.length && line.at(-1).text === ' ') w -= line.pop().w;
      const merged = [];   // join neighbours with the same style into one piece of text
      for (const it of line) {
        const last = merged.at(-1);
        if (last && !last.math && !it.math && last.f === it.f && last.sz === it.sz && last.link === it.link && last.strike === it.strike && last.code === it.code) {
          last.text += it.text; last.w += it.w;
        } else merged.push({ ...it });
      }
      let asc = size * 0.78, desc = size * 0.25;   // taller formulas make their line taller
      for (const it of merged) if (it.math) { asc = Math.max(asc, it.math.asc * it.k); desc = Math.max(desc, it.math.desc * it.k); }
      lines.push({ items: merged, width: w, size, asc, desc });
      line = []; w = 0;
    };
    for (const r of runs) {
      if (r.math) {
        const k = Math.min(size / 1000, width / Math.max(1, r.math.w)), mw = r.math.w * k;
        if (w + mw > width && line.length) end();
        line.push({ ...r, k, sz: size, w: mw }); w += mw;
        continue;
      }
      for (const part of clean(r.text).split(/(\n| +)/)) {
        if (!part) continue;
        if (part === '\n') { end(); continue; }
        const f = fontOf(r), sz = r.code ? size * 0.92 : size;
        if (part[0] === ' ') {
          if (!line.length) continue;
          const sw = f.widthOfTextAtSize(' ', sz);
          line.push({ ...r, text: ' ', f, sz, w: sw }); w += sw;
          continue;
        }
        let text = part, tw = f.widthOfTextAtSize(text, sz);
        if (w + tw > width && line.length) end();
        while (tw > width) {   // a single word longer than the line: break it
          let k = text.length;
          while (k > 1 && f.widthOfTextAtSize(text.slice(0, k), sz) > width) k--;
          line.push({ ...r, text: text.slice(0, k), f, sz, w: f.widthOfTextAtSize(text.slice(0, k), sz) });
          w += line.at(-1).w; end();
          text = text.slice(k); tw = f.widthOfTextAtSize(text, sz);
        }
        if (text) { line.push({ ...r, text, f, sz, w: tw }); w += tw; }
      }
    }
    if (line.length || !lines.length) end();
    return lines;
  }

  function drawLine(l, x, ctx, { color = C.ink, lead = LEAD, marker } = {}) {
    const h = Math.max(l.size * lead, l.asc + l.desc + l.size * (lead - 1));
    room(h);
    const base = y - (h - l.asc - l.desc) / 2 - l.asc;
    marker?.(base);
    for (const it of l.items) {
      if (it.math) { drawMath(it, x, base, color); x += it.w; continue; }
      if (it.code) page.drawRectangle({ x: x - 1.5, y: base - it.sz * 0.28, width: it.w + 3, height: it.sz * 1.2, color: C.codeBg });
      if (it.text.trim()) page.drawText(it.text, { x, y: base, size: it.sz, font: it.f, color: it.link ? C.link : color });
      if (it.strike) page.drawLine({ start: { x, y: base + it.sz * 0.3 }, end: { x: x + it.w, y: base + it.sz * 0.3 }, thickness: 0.7, color });
      if (it.link) {
        page.drawLine({ start: { x, y: base - 1.5 }, end: { x: x + it.w, y: base - 1.5 }, thickness: 0.5, color: C.link });
        if (/^(https?:|mailto:)/i.test(it.link)) links.push({ rect: [x, base - it.sz * 0.3, x + it.w, base + it.sz * 0.9], url: it.link });
      }
      x += it.w;
    }
    advance(h, ctx);
  }

  // Formula outlines, plus the TeX source as invisible text on top, so the formula can be
  // selected, copied, searched and read by assistants.
  function drawMath(it, x, base, color) {
    const { math, k } = it, top = base + math.asc * k;
    for (const g of math.items) {
      const c = cssColor(g.fill), col = c ? rgb(...c) : color;
      if (g.d) page.drawSvgPath(g.d, { x, y: top, scale: k, color: col });
      else if (g.line) {
        page.drawLine({ start: { x: x + g.line[0] * k, y: top - g.line[1] * k }, end: { x: x + g.line[2] * k, y: top - g.line[3] * k }, thickness: Math.max(0.3, g.width * k), color: col });
      } else if (g.text) {
        const t = clean(g.text);
        if (t.trim()) page.drawText(t, { x: x + g.x * k, y: top - g.y * k, size: Math.max(1, g.size * k), font: F.r, color: col });
      }
    }
    // Shrunk (not squeezed) to the formula's width, so extractors don't drop overlapping letters.
    const src = clean(it.tex.replace(/\s+/g, ' '));
    const tw = F.r.widthOfTextAtSize(src, it.sz);
    if (!src.trim() || !tw) return;
    page.pushOperators(pushGraphicsState(), setTextRenderingMode(TextRenderingMode.Invisible));
    page.drawText(src, { x, y: base, size: Math.max(1, Math.min(it.sz, it.sz * it.w / tw)), font: F.r });
    page.pushOperators(popGraphicsState());
  }

  /* ----- block Markdown -> blocks ----- */
  function parse(lines) {
    const blocks = [];
    const isItem = s => /^\s*([-*+]|\d{1,9}[.)])\s+/.test(s);
    const isTableSep = s => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(s) && s.includes('-');
    const starts = (s, next) => /^\s*(```|~~~|#{1,6}\s|>|\$\$|\\\[|\\begin\{)/.test(s) || isItem(s) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(s)
      || (s.includes('|') && isTableSep(next ?? ''));
    const cells = s => s.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
    for (let i = 0; i < lines.length;) {
      const s = lines[i];
      let mt;
      if (!s.trim()) { i++; continue; }
      if ((mt = s.match(/^\s*(\$\$|\\\[|\\begin\{([a-zA-Z]+\*?)\})(.*)$/))) {
        const env = mt[2], close = mt[1] === '$$' ? '$$' : mt[1] === '\\[' ? '\\]' : `\\end{${env}}`;
        let body = env ? s.trim() : mt[3], j = i;
        const from = env ? mt[1].length : 0;
        while (body.indexOf(close, from) < 0 && j + 1 < lines.length && lines[j + 1].trim()) body += '\n' + lines[++j];
        const at = body.indexOf(close, from);
        let tex = at < 0 ? body : env ? body.slice(0, at + close.length) : body.slice(0, at);
        const after = at < 0 ? '' : body.slice(at + close.length).trim();
        i = j + 1;
        blocks.push({ t: 'math', tex: tex.trim() });
        if (after) blocks.push({ t: 'p', text: after });
      } else if ((mt = s.match(/^\s*(```|~~~)/))) {
        const body = [];
        for (i++; i < lines.length && !lines[i].trim().startsWith(mt[1]); i++) body.push(lines[i]);
        i++;
        blocks.push({ t: 'code', lines: body.length ? body : [''] });
      } else if ((mt = s.match(/^\s*(#{1,6})\s+(.*?)\s*#*\s*$/))) {
        blocks.push({ t: 'h', level: mt[1].length, text: mt[2] }); i++;
      } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(s)) {
        blocks.push({ t: 'hr' }); i++;
      } else if (s.includes('|') && isTableSep(lines[i + 1] ?? '')) {
        const head = cells(s), align = cells(lines[i + 1]).map(c => c.endsWith(':') ? (c.startsWith(':') ? 'center' : 'right') : 'left');
        const rows = [];
        for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(cells(lines[i]));
        blocks.push({ t: 'table', head, align, rows });
      } else if (/^\s*>/.test(s)) {
        const inner = [];
        for (; i < lines.length && lines[i].trim() && (/^\s*>/.test(lines[i]) || !starts(lines[i], lines[i + 1])); i++) {
          inner.push(lines[i].replace(/^\s*> ?/, ''));
        }
        blocks.push({ t: 'quote', blocks: parse(inner) });
      } else if (isItem(s)) {
        const items = [], stack = [];
        for (; i < lines.length; i++) {
          const l = lines[i];
          if (!l.trim()) {   // a blank line ends the list unless another item follows
            if (isItem(lines[i + 1] ?? '')) continue;
            break;
          }
          const it = l.match(/^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/);
          if (it) {
            const ind = it[1].replace(/\t/g, '    ').length;
            while (stack.length && ind < stack.at(-1)) stack.pop();
            if (!stack.length || ind > stack.at(-1)) stack.push(ind);
            const task = it[3].match(/^\[([ xX])\]\s+(.*)$/);
            items.push({
              level: stack.length - 1, ordered: /\d/.test(it[2]), marker: it[2].replace(')', '.'),
              task: task ? task[1] !== ' ' : null, text: task ? task[2] : it[3],
            });
          } else if (!starts(l, lines[i + 1]) || /^\s{2,}/.test(l)) {
            items.at(-1).text += '\n' + l.trim().replace(/^```.*$/, '');   // continuation line
          } else break;
        }
        blocks.push({ t: 'list', items });
      } else {
        const body = [s];
        for (i++; i < lines.length && lines[i].trim() && !starts(lines[i], lines[i + 1]); i++) {
          if (/^\s*=+\s*$/.test(lines[i]) || /^\s*-+\s*$/.test(lines[i])) break;
          body.push(lines[i]);
        }
        const setext = (lines[i] ?? '').match(/^\s*(=+|-+)\s*$/);
        if (setext && lines[i].trim()) { i++; blocks.push({ t: 'h', level: setext[1][0] === '=' ? 1 : 2, text: body.join(' ') }); continue; }
        // two trailing spaces or a backslash keep a line break; otherwise lines flow together
        blocks.push({ t: 'p', text: body.map((l, k) => (k < body.length - 1 && /( {2,}|\\)$/.test(l) ? l.replace(/( +|\\)$/, '\n') : l.trim() + ' ')).join('') });
      }
    }
    return blocks;
  }

  /* ----- blocks -> pages ----- */
  function render(blocks, ctx) {
    blocks.forEach((b, k) => draw(b, ctx, k === 0));
  }

  function draw(b, ctx, first) {
    const x = X0 + ctx.indent, width = MAXW - ctx.indent, color = ctx.color;
    if (b.t === 'h') {
      const sz = [17, 14, 12, 10.5, 9.5, 9][b.level - 1];
      if (!first) gap(sz * 0.95, ctx);
      room(sz * 1.3 + BASE * LEAD * 2);   // keep a heading with the text after it
      for (const l of wrap(inline(b.text, { bold: true }), width, sz)) drawLine(l, x, ctx, { color, lead: 1.3 });
      if (b.level <= 2) {
        advance(2, ctx);
        page.drawLine({ start: { x, y }, end: { x: x + width, y }, thickness: 0.6, color: C.rule });
        advance(5, ctx);
      } else advance(2, ctx);
    } else if (b.t === 'p') {
      if (!first) gap(7, ctx);
      for (const l of wrap(inline(b.text.trim()), width, BASE)) drawLine(l, x, ctx, { color });
    } else if (b.t === 'code') {
      if (!first) gap(7, ctx);
      const sz = 8, h = sz * 1.45, pad = 6, cw = F.c.widthOfTextAtSize('M', sz), per = Math.max(8, Math.floor((width - 2 * pad) / cw));
      const rows = b.lines.flatMap(l => {
        const t = clean(l.replace(/\s+$/, ''));
        const parts = [];
        for (let k = 0; k < t.length; k += per) parts.push(t.slice(k, k + per));
        return parts.length ? parts : [''];
      });
      const strip = hh => { room(hh); page.drawRectangle({ x, y: y - hh, width, height: hh, color: C.codeBg }); };
      strip(pad); advance(pad, ctx);
      for (const t of rows) {
        strip(h);
        if (t.trim()) page.drawText(t, { x: x + pad, y: y - h / 2 - sz * 0.3, size: sz, font: F.c, color: C.ink });
        advance(h, ctx);
      }
      strip(pad); advance(pad, ctx);
    } else if (b.t === 'math') {
      let m = null;
      if (mathOK) { try { m = typeset(b.tex, true); } catch {} }
      if (!m) return draw({ t: 'code', lines: b.tex.split('\n') }, ctx, first);
      if (!first) gap(5, ctx);
      const k = Math.min(BASE * 1.05 / 1000, width / Math.max(1, m.w)), mh = (m.asc + m.desc) * k;
      room(mh + 8);
      advance(4, ctx);
      drawMath({ math: m, k, tex: b.tex, sz: BASE, w: m.w * k }, x + (width - m.w * k) / 2, y - m.asc * k, color);
      advance(mh + 4, ctx);
    } else if (b.t === 'hr') {
      if (!first) gap(6, ctx);
      room(12); advance(6, ctx);
      page.drawLine({ start: { x, y }, end: { x: x + width, y }, thickness: 0.8, color: C.rule });
      advance(6, ctx);
    } else if (b.t === 'quote') {
      if (!first) gap(7, ctx);
      render(b.blocks, { indent: ctx.indent + 14, bars: [...ctx.bars, x + 1], color: C.dim });
    } else if (b.t === 'list') {
      if (!first) gap(7, ctx);
      const counters = [];
      b.items.forEach((it, k) => {
        counters.length = it.level + 1;
        const ix = x + it.level * 18, mw = it.ordered ? Math.max(18, F.r.widthOfTextAtSize(it.marker, BASE) + 6) : 14;
        if (k) advance(2.5, ctx);
        wrap(inline(it.text), width - (ix - x) - mw, BASE).forEach((l, j) => drawLine(l, ix + mw, ctx, {
          color,
          marker: j ? null : base => {
            if (it.task !== null) {
              const s = 8, bx = ix + 1, by = base - 0.5;
              page.drawRectangle({ x: bx, y: by, width: s, height: s, borderColor: C.dim, borderWidth: 0.8 });
              if (it.task) page.drawSvgPath('M 1.6 4.2 L 3.4 6.2 L 6.6 1.8', { x: bx, y: by + s, borderColor: C.ink, borderWidth: 1.2 });
            } else {
              if (it.ordered) return page.drawText(it.marker, { x: ix, y: base, size: BASE, font: F.r, color });
              const cx = ix + 4, cy = base + BASE * 0.3, lv = it.level % 3;   // filled dot, ring, square
              if (lv === 2) page.drawRectangle({ x: cx - 2, y: cy - 2, width: 4, height: 4, color });
              else page.drawCircle({ x: cx, y: cy, size: 2.1, ...(lv ? { borderColor: color, borderWidth: 0.8 } : { color }) });
            }
          },
        }));
      });
    } else if (b.t === 'table') {
      if (!first) gap(8, ctx);
      const sz = 8.5, pad = 5, n = Math.max(b.head.length, ...b.rows.map(r => r.length));
      const runs = row => Array.from({ length: n }, (_, c) => inline(row[c] ?? ''));
      const head = runs(b.head).map(r => r.map(x => ({ ...x, bold: true }))), body = b.rows.map(runs);
      const natural = Array.from({ length: n }, (_, c) => Math.max(36, ...[head, ...body].map(r =>
        r[c].reduce((s, x) => s + (x.math ? x.math.w * sz / 1000 : fontOf(x).widthOfTextAtSize(clean(x.text).replace(/\n/g, ' '), x.code ? sz * 0.92 : sz)), 0) + 2 * pad + 1)));   // +1: room for rounding, so a word never wraps in its own column
      const total = natural.reduce((s, v) => s + v, 0);
      const cols = total <= width ? natural : natural.map(v => Math.max(36, width * v / total));
      const tableW = cols.reduce((s, v) => s + v, 0);
      const row = (cellsRuns, isHead) => {
        const wrapped = cellsRuns.map((r, c) => wrap(r, cols[c] - 2 * pad, sz));
        const lh = l => Math.max(sz * 1.35, l.asc + l.desc + sz * 0.35);
        const rh = Math.max(...wrapped.map(ls => ls.reduce((s, l) => s + lh(l), 0))) + 2 * pad;
        return { wrapped, rh, lh, isHead };
      };
      const drawRow = ({ wrapped, rh, lh, isHead }) => {
        let cx = x;
        if (isHead) page.drawRectangle({ x, y: y - rh, width: tableW, height: rh, color: C.headBg });
        wrapped.forEach((ls, c) => {
          page.drawRectangle({ x: cx, y: y - rh, width: cols[c], height: rh, borderColor: C.rule, borderWidth: 0.6 });
          const saveY = y;
          y -= pad;
          for (const l of ls) {
            const off = b.align[c] === 'right' ? cols[c] - 2 * pad - l.width : b.align[c] === 'center' ? (cols[c] - 2 * pad - l.width) / 2 : 0;
            drawCell(l, cx + pad + off, lh(l));
          }
          y = saveY;
          cx += cols[c];
        });
        advance(rh, ctx);
      };
      const drawCell = (l, cx, lh) => {   // like drawLine, but never breaks the page (rows are kept whole)
        const base = y - (lh - l.asc - l.desc) / 2 - l.asc;
        for (const it of l.items) {
          if (it.math) { drawMath(it, cx, base, C.ink); cx += it.w; continue; }
          if (it.code) page.drawRectangle({ x: cx - 1, y: base - it.sz * 0.28, width: it.w + 2, height: it.sz * 1.2, color: C.codeBg });
          if (it.text.trim()) page.drawText(it.text, { x: cx, y: base, size: it.sz, font: it.f, color: it.link ? C.link : C.ink });
          if (it.strike) page.drawLine({ start: { x: cx, y: base + it.sz * 0.3 }, end: { x: cx + it.w, y: base + it.sz * 0.3 }, thickness: 0.7, color: C.ink });
          if (it.link && /^(https?:|mailto:)/i.test(it.link)) links.push({ rect: [cx, base - it.sz * 0.3, cx + it.w, base + it.sz * 0.9], url: it.link });
          cx += it.w;
        }
        y -= lh;
      };
      const h = row(head, true);
      room(h.rh + (body[0] ? row(body[0]).rh : 0));
      drawRow(h);
      for (const r of body) {
        const rr = row(r);
        if (y - rr.rh < m && !atTop()) { newPage(); drawRow(h); }   // repeat the header on the next page
        drawRow(rr);
      }
    }
  }

  const text = md.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
  render(parse(text.split('\n')), { indent: 0, bars: [], color: C.ink });

  for (const { page: p, links: ls } of made) {   // clickable links
    for (const { rect, url } of ls) {
      p.node.addAnnot(doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Link', Rect: rect.map(v => +v.toFixed(2)), Border: [0, 0, 0],
        A: { Type: 'Action', S: 'URI', URI: PDFString.of(url) },
      })));
    }
  }
  return doc.save();
}
