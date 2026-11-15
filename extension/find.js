// @ts-check
// Find (Ctrl+F). The box lists every page that mentions the text, once, with how many times and a snippet.
// Moving through the list (Tab, ↓) shows each page in turn; Enter or a click goes there and closes the box.
// Matches are lit up on the pages with the CSS Highlight API, so the page's own text is never touched.
//
// The pure parts (the pattern, counting, snippets, where matches fall in a text layer) are exported for tests;
// createFind() wires them to the find box in viewer.html.

// The search as a pattern: words match across any run of spaces or line breaks. null for an empty search.
export function pattern(q, { word = false, matchCase = false } = {}) {
  q = q.trim();
  if (!q) return null;
  let src = q.split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  if (word) src = `(?<![\\p{L}\\p{N}_])${src}(?![\\p{L}\\p{N}_])`;
  try { return new RegExp(src, matchCase ? 'gu' : 'giu'); } catch { return null; }
}

// pdf.js text items -> the page's text, with line ends.
export const joinItems = items => items.map(it => (it.str ?? '') + (it.hasEOL ? '\n' : '')).join('');
// Text as searched: any run of white space (and soft hyphens) as one space.
export const flatten = text => text.replace(/[\s­]+/g, ' ');

// How many matches, and the first.
export function count(text, re) {
  re.lastIndex = 0;
  let n = 0, first = null, m;
  while ((m = re.exec(text))) { if (!first) first = m; n++; if (!m[0].length) re.lastIndex++; }
  return { n, first };
}

// A few words either side of a match.
export function snippet(text, m) {
  const a = Math.max(0, m.index - 36), z = Math.min(text.length, m.index + m[0].length + 70);
  return {
    before: (a ? '…' : '') + text.slice(a, m.index).trimStart(),
    match: m[0],
    after: text.slice(m.index + m[0].length, z) + (z < text.length ? '…' : ''),
  };
}

// Where the matches are in a string: [[start, end], …] (end exclusive). Empty matches are skipped.
export function spans(str, re) {
  const out = [];
  re.lastIndex = 0;
  for (let m; (m = re.exec(str));) {
    if (!m[0].length) { re.lastIndex++; continue; }
    out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

// env: what the find box needs from the viewer.
//   pages()          the pages on screen, in order: { div, page, id, e }
//   textOf(p)        a page's own text, as one string (cached by the viewer), before your text boxes are added
//   boxesOn(p)       the text of your text boxes on that page
//   textLayer(p)     a promise of the page's text layer being ready
//   showPage(k)      the page counter shows page k
//   visibleArea()    { top, bottom }: the part of the window the pages can be seen in (the toolbar takes the rest)
//   reading()        true while scanned pages are still being read (so "no matches" may change)
//   el(tag, attrs, ...kids)
export function createFind(env) {
  const $ = id => /** @type {HTMLElement} */ (document.getElementById(id));
  const box = $('find'), q = /** @type {HTMLInputElement} */ ($('findQ')), list = $('findList'), sum = $('findSum');
  const word = /** @type {HTMLInputElement} */ ($('findWord')), matchCase = /** @type {HTMLInputElement} */ ($('findCase'));
  const GAP = 16;
  let run = 0, hits = [], on = -1, timer = 0, fade = 0;
  const marks = new Map();   // page -> Range[] of its matches
  const isOpen = () => box.matches(':popover-open');
  const current = () => pattern(q.value, { word: word.checked, matchCase: matchCase.checked });

  async function pageText(p) {
    const boxes = env.boxesOn(p);   // your own text boxes are searched too
    const t = await env.textOf(p);
    return flatten(boxes.length ? t + '\n' + boxes.join('\n') : t);
  }

  function open() {
    if (!env.pages().length) return;
    if (!isOpen()) {
      document.querySelectorAll('.pop:popover-open, #zoomPop:popover-open').forEach(x => /** @type {HTMLElement} */ (x).hidePopover());
      clearTimeout(fade);
      box.showPopover();
      $('findBtn').setAttribute('aria-pressed', 'true');
      const picked = String(getSelection()).trim();   // selected text becomes the search
      if (picked && picked.length < 80 && !picked.includes('\n')) q.value = picked;
      if (q.value) search();
    }
    q.focus();
    q.select();
  }

  function close(linger = false) {   // linger: leave the matches lit for a moment, to show where they were
    box.hidePopover();
    $('findBtn').setAttribute('aria-pressed', 'false');
    run++;
    clearTimeout(fade);
    const clear = () => { marks.clear(); CSS.highlights?.delete('find'); CSS.highlights?.delete('find-on'); };
    if (linger) fade = setTimeout(() => { if (!isOpen()) clear(); }, 2500);
    else clear();
  }

  function stale() {   // pages or their text changed: search again, quietly
    if (!isOpen() || !q.value.trim()) return;
    clearTimeout(timer);
    timer = setTimeout(() => search(true), 250);
  }

  async function search(keepFocus = false) {
    const id = ++run, re = current(), pages = env.pages();
    const onPage = on >= 0 ? hits[on]?.p : null;
    hits = []; on = -1;
    marks.clear();
    list.replaceChildren();
    box.querySelector('.empty')?.remove();
    paint();
    if (!re) { sum.textContent = ''; return; }
    let total = 0;
    sum.textContent = 'Searching…';
    for (const [k, p] of pages.entries()) {
      const text = await pageText(p);
      if (id !== run) return;
      const { n, first } = count(text, re);
      if (n) {
        total += n;
        const hit = { p, k, n };
        hits.push(hit);
        list.append(row(hit, text, first));
        sum.replaceChildren(...summary(total, hits.length, k + 1 < pages.length));
      }
      if (k % 8 === 7) await new Promise(r => setTimeout(r));   // stay responsive on long PDFs
    }
    if (id !== run) return;
    sum.replaceChildren(...summary(total, hits.length, false));
    if (!hits.length) {
      list.after(env.el('p', { class: 'empty' }, env.reading()
        ? 'No matches yet. Inkfold is still reading the scanned pages; they’ll be searched as they’re done.'
        : 'No matches in this PDF.'));
    }
    for (const p of pages) p.textReady?.then(() => markPage(p));   // pages whose text layer is (being) made
    const back = onPage ? hits.findIndex(h => h.p === onPage) : -1;
    if (keepFocus && back >= 0) go(back, false);
  }

  function summary(total, nPages, more) {
    if (!total) return [document.createTextNode(more ? 'Searching…' : 'No matches')];
    const b = s => env.el('b', {}, String(s));
    return [b(total), ` match${total === 1 ? '' : 'es'} on `, b(nPages), ` page${nPages === 1 ? '' : 's'}${more ? '…' : ''}`];
  }

  function row(hit, text, m) {
    const s = snippet(text, m);
    const many = `${hit.n} match${hit.n === 1 ? '' : 'es'}`;
    const btn = env.el('button', { type: 'button', title: `Page ${hit.k + 1}: ${many}` },
      env.el('span', { class: 'pg' }, env.el('small', {}, hit.p.e.doc !== 'main' ? 'Note' : 'Page'), env.el('span', {}, String(hit.k + 1))),
      env.el('span', { class: 'snip' }, s.before, env.el('mark', {}, s.match), s.after),
      env.el('span', { class: 'n', 'aria-label': many }, '×' + hit.n));
    btn.addEventListener('focus', () => go(hits.indexOf(hit)));
    // Enter or a click: there it is, and the box closes. The page was usually shown already when the row got the
    // focus (Tab, ↓, or the press of the click), and isn't scrolled to a second time.
    btn.addEventListener('click', async () => { await go(hits.indexOf(hit)); close(true); });
    return env.el('li', {}, btn);
  }

  // The first match on a page, on screen: its box, or null (not laid out yet).
  const firstMark = p => marks.get(p)?.[0]?.getBoundingClientRect() ?? null;
  const inView = r => { const a = env.visibleArea(); return r.top >= a.top && r.bottom <= a.bottom - 40; };

  // Show result i: scroll to its page's first match (unless it's already in view) and light its matches brighter.
  // scroll false: just mark it as the current one.
  async function go(i, scroll = true) {
    const hit = hits[i];
    if (!hit) return;
    const again = on === i;
    on = i;
    list.querySelectorAll('button.on').forEach(b => b.classList.remove('on'));
    const btn = /** @type {HTMLElement | null} */ (list.children[i]?.firstChild ?? null);
    btn?.classList.add('on');
    btn?.scrollIntoView({ block: 'nearest' });
    if (!scroll) return paint();
    const p = hit.p;
    env.showPage(hit.k);
    const seen = firstMark(p);
    if (again && seen && inView(seen)) return paint();   // already there: no second trip
    if (!seen || !inView(seen)) {   // jump to the page first, so its text layer is there to measure
      const pr = p.div.getBoundingClientRect(), a = env.visibleArea();
      if (pr.bottom < a.top || pr.top > a.bottom) scrollBy(0, pr.top - a.top - GAP);
    }
    await env.textLayer(p);
    if (on !== i) return;
    markPage(p);
    const r = firstMark(p);
    if (r && !inView(r)) {
      const a = env.visibleArea();
      scrollBy({ top: r.top - a.top - (a.bottom - a.top) * 0.25, behavior: 'smooth' });
    }
  }

  // The ranges of the matches in a page's text layer.
  function markPage(p) {
    if (!isOpen() || !hits.some(h => h.p === p)) {
      if (marks.delete(p)) paint();
      return;
    }
    const re = current(), layer = p.div.querySelector('.textLayer');
    if (!re || !layer) return;
    const nodes = [], walk = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let str = '';
    for (let n; (n = walk.nextNode());) {
      if (n.nodeType === 3) { nodes.push([n, str.length]); str += /** @type {Text} */ (n).data; }
      else if (/** @type {Element} */ (n).tagName === 'BR') str += '\n';   // line ends, so words on two lines don't run together
    }
    if (!nodes.length) return;
    const at = off => {   // string offset -> [text node, offset in it]
      let lo = 0, hi = nodes.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (nodes[mid][1] <= off) lo = mid; else hi = mid - 1; }
      return [nodes[lo][0], off - nodes[lo][1]];
    };
    const ranges = spans(str, re).map(([s, e]) => {
      const r = new Range();
      const [a, ao] = at(s), [b, bo] = at(e - 1);
      r.setStart(a, ao);
      r.setEnd(b, bo + 1);
      return r;
    });
    marks.set(p, ranges);
    paint();
  }

  function paint() {
    if (!CSS.highlights || typeof Highlight === 'undefined') return;
    const cur = hits[on]?.p, all = [], mine = [];
    for (const [p, rs] of marks) for (const r of rs) (p === cur ? mine : all).push(r);
    const hl = rs => { const h = new Highlight(); for (const r of rs) h.add(r); return h; };   // (any number of matches)
    CSS.highlights.set('find', hl(all));
    CSS.highlights.set('find-on', hl(mine));
  }

  $('findBtn').onclick = () => (isOpen() ? close() : open());
  $('findClose').onclick = () => close();
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 140); });
  matchCase.onchange = word.onchange = () => { search(); q.focus(); };
  box.addEventListener('keydown', e => {
    const rows = /** @type {HTMLElement[]} */ ([...list.querySelectorAll('li > button')]);
    const i = rows.indexOf(/** @type {HTMLElement} */ (document.activeElement)), mod = e.ctrlKey || e.metaKey;
    const focus = j => { e.preventDefault(); rows[(j + rows.length) % rows.length]?.focus(); };
    if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); e.stopPropagation(); q.focus(); q.select(); return; }
    if (mod) return;   // Ctrl+Z, Ctrl+S… still work
    e.stopPropagation();   // letters typed here aren't tool shortcuts
    if (e.key === 'Escape') { e.preventDefault(); return close(); }
    if (e.target === q && rows.length) {
      if ((e.key === 'Tab' && !e.shiftKey) || e.key === 'ArrowDown') return focus(0);   // straight to the first page found
      if (e.key === 'Enter') { e.preventDefault(); return rows[0].click(); }
    }
    if (i >= 0) {
      if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) return i === rows.length - 1 && e.key === 'Tab' ? (e.preventDefault(), q.focus()) : focus(i + 1);
      if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) return i === 0 ? (e.preventDefault(), q.focus()) : focus(i - 1);
      if (e.key === 'Home') return focus(0);
      if (e.key === 'End') return focus(rows.length - 1);
    }
    // Anywhere else, Tab and Shift+Tab go round the find box's own controls; focus never leaves it while it's open.
    if (e.key === 'Tab') {
      const ring = [q, $('findClose'), matchCase, word, ...rows];
      const k = ring.indexOf(/** @type {HTMLElement} */ (document.activeElement));
      e.preventDefault();
      ring[((k < 0 ? 0 : k + (e.shiftKey ? -1 : 1)) + ring.length) % ring.length].focus();
    }
  });

  // pageReady(p): a page's text layer was (re)made, so its matches can be lit.
  return { open, close, stale, isOpen, pageReady: markPage };
}
