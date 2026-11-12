import * as pdfjs from './lib/pdf.min.mjs';
import { notePdf } from './notes.js';
import { layout, cached, svgOf, pdfOps, SIZES, PAD, cleanWith, wrapText } from './textbox.js';

// The viewer runs either on its own extension page, or inside a web PDF's tab (opened in place by
// content.js, so the tab keeps its https:// address). Its own files always come from the extension.
const EXT = new URL('./', import.meta.url).href;
const IN_PAGE = location.protocol !== 'chrome-extension:';
// pdf.js reads PDFs in a worker. In a PDF's own tab, content.js has already started one (a page can't start a
// worker from the extension's address); on the extension's own page pdf.js starts it from the file.
pdfjs.GlobalWorkerOptions.workerSrc = EXT + 'lib/pdf.worker.min.mjs';
const workerReady = (async () => {
  const w = IN_PAGE ? await globalThis.inkfoldEarly?.worker : null;
  if (w) pdfjs.GlobalWorkerOptions.workerPort = w;
})();

const MARK = 'Inkfold';         // author tag on the annotations we write, so we can re-edit them later
const MARKS = [MARK, 'PDF Shapes'];   // also recognise files saved by the earlier name
const CSS_PER_PT = 96 / 72;
const NS = 'http://www.w3.org/2000/svg';
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
const GAP = 16;                 // matches main's gap and padding in viewer.css
const PDFJS_OPTS = { cMapUrl: EXT + 'lib/cmaps/', standardFontDataUrl: EXT + 'lib/standard_fonts/', wasmUrl: EXT + 'lib/wasm/' };
const $ = id => document.getElementById(id);
const header = document.querySelector('header');
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lib = () => import('./lib/pdf-lib.esm.min.js');
// Settings live in the extension's own storage (not the website's), loaded once at start.
const settings = await chrome.storage.local.get(null).catch(() => ({}));
const store = {
  get: (k, fallback) => settings[k] ?? fallback,
  set(k, v) { settings[k] = v; chrome.storage.local.set({ [k]: v }).catch(() => {}); },
};

// The document is a list of page entries, each pointing at a page of a source PDF:
// the file you opened ('main') or a note made from Markdown ('note…').
//   entries: [{ id, doc, i, rot }]        rot = extra rotation added on top of the page's own
// Annotations are kept in PDF points and tied to an entry id, so they follow their page around:
//   { page, type: 'rect'|'ellipse', x1, y1, x2, y2, color, width, fill }   (box = centre line of the stroke; fill: solid inside)
//   { page, type: 'highlight', rects: [[x1, y1, x2, y2], …], color }   (one box per line of text)
//   { page, type: 'text', x1, y2, text, size, color }   (x1, y2 = top-left corner; the size comes from textbox.js)
//   { page, type: 'image', x1, y1, x2, y2, img }        (img: key into imgs, which holds the picture itself)
const docs = new Map();         // key -> { pdf, bytes, pages: [PDFPageProxy] }
const views = new Map();        // entry id -> on-screen page
let entries = [], pages = [], shapes = [], history = [], future = [], hovered = null, renderTimer, nextId = 1, loadId = 0, name;
let tool = 'select', sel = null, drag = null, pick = null, dirty = false, msgTimer;
let zoom = 1, fit = store.get('fit', 'auto'), spread = store.get('spread', false);
let lineWidth = store.get('width', 2);
let fillShapes = store.get('fill', false);   // new rectangles and ellipses: filled or just outlined
// A few standard colours: light ones for the highlighter (ink shows through), strong ones for shapes and text.
const PALETTES = {
  highlight: [['Yellow', '#ffd400'], ['Green', '#9be28f'], ['Blue', '#8fc7ff'], ['Pink', '#ff9ccb'], ['Orange', '#ffb561']],
  ink: [['Red', '#e5484d'], ['Orange', '#e8590c'], ['Green', '#2f9e44'], ['Blue', '#2f6fe0'], ['Black', '#1f1f1f']],
};
const colors = { shape: '#e5484d', highlight: '#ffd400', text: '#1f1f1f', ...store.get('colors', {}) };
let textSize = store.get('textSize', 12), editing = null, lastPress = {}, pendingText = null, erasing = null, eraseHover = null;
const imgs = new Map();         // image key -> { src: data URL, w, h (pixels), mime }
let nextImg = 1;
const ocrBusy = new Set();      // main-document page indexes still waiting for text recognition
const ocrText = new Map();      // main-document page index -> text recognised on it (pdf.js text items, PDF points)
const snapshot = () => JSON.stringify({ entries, shapes });

/* ---------- loading ---------- */

// src: the PDF's bytes, or { url } for a PDF on the web. A web PDF is read in pieces as they're needed (where the
// server allows it), so its first page shows long before a large file has finished downloading; the rest keeps
// coming in the background, and doc.data gives the whole file once it's all there (for saving, for instance).
async function loadDoc(key, src) {
  await workerReady;
  // The bytes are handed over to pdf.js rather than copied, so a big file isn't held twice; when the whole file is
  // needed again (saving, splitting, compressing), pdf.js hands back a copy.
  const params = src.url ? { url: src.url, withCredentials: true, rangeChunkSize: 64 * 1024, disableStream: true, disableAutoFetch: true } : { data: src };
  const pdf = await pdfjs.getDocument({ ...params, ...PDFJS_OPTS }).promise;
  const list = await Promise.all(Array.from({ length: pdf.numPages }, (_, n) => pdf.getPage(n + 1)));
  const doc = { pdf, bytes: null, pages: list };   // bytes: only once replaced by a compressed version
  docs.set(key, doc);
  return doc;
}
// The whole file, as a promise of a fresh copy (for a web PDF, asking for it fetches whatever hasn't arrived yet).
const bytesOf = async doc => doc.bytes ?? doc.pdf.getData();
let painted = null;   // resolves once the first page of the newly opened PDF is on screen

async function openPdf(buf, fileName) {
  if (dirty && !confirm('Discard the unsaved changes to the current PDF?')) return;
  const src = buf.url ? buf : new Uint8Array(buf);
  // What's on disk, so a later save over the file can tell whether another program changed it meanwhile. Taken
  // now, before pdf.js takes the bytes over.
  const onDisk = src.url ? null : { size: src.length, hash: digest(src) };
  const id = ++loadId;
  const old = [...docs.values()];
  let main, err;
  try {
    main = await loadDoc('main', src);
  } catch (e) { err = e; }
  if (!main && src.url && err?.name !== 'PasswordException') {   // the server wouldn't serve it in pieces: read it whole
    try { main = await loadDoc('main', new Uint8Array(await fetchBytes(src.url))); } catch (e) { err = e; }
  }
  if (!main) return fail(err?.name === 'PasswordException' ? 'Password-protected PDFs are not supported.' : 'That could not be read as a PDF.');
  let onPaint;
  painted = new Promise(r => (onPaint = r));
  painted.done = () => { painted.isDone = true; onPaint(); };
  if (id !== loadId) return;
  // Free the documents being replaced. (pdf.js 6 documents have no destroy(); their loading task does.)
  for (const d of old) if (d.pdf !== main.pdf) d.pdf.loadingTask?.destroy().catch(() => {});
  for (const [k] of docs) if (k !== 'main') docs.delete(k);
  io.disconnect();
  views.clear();
  [name, entries, shapes, history, future, sel, dirty] = [fileName, [], [], [], [], null, false];
  disk = onDisk;
  syncUndo();
  ocrText.clear();
  ocrBusy.clear();
  showOcr({ phase: 'checking' });
  showZip({ phase: 'checking' });
  mergeItems = [{ current: true }];
  $('notice').hidden = true;
  document.body.classList.add('loaded');

  const { info = {} } = await main.pdf.getMetadata().catch(() => ({}));
  const title = typeof info.Title === 'string' && info.Title.trim();
  document.title = title ? `${title} (${name})` : name;
  $('pages').setAttribute('aria-label', title || name);

  const stamps = [];   // images Inkfold saved, read back below
  imgs.clear();
  const annots = await Promise.all(main.pages.map(page => page.getAnnotations().catch(() => [])));
  for (const [i] of main.pages.entries()) {
    const e = { id: nextId++, doc: 'main', i, rot: 0 };
    entries.push(e);
    // Annotations saved by an earlier session become editable again; pdf.js is told not to paint them.
    for (const a of annots[i]) {
      if (!MARKS.includes(a.titleObj?.str)) continue;
      const color = '#' + [...(a.color || [0, 0, 0])].map(v => v.toString(16).padStart(2, '0')).join('');
      if (a.subtype === 'Highlight' && a.quadPoints) {
        const q = a.quadPoints, rects = [];   // pdf.js normalises each quad to TL, TR, BL, BR
        for (let k = 0; k < q.length; k += 8) rects.push([q[k], q[k + 5], q[k + 2], q[k + 1]]);
        shapes.push({ page: e.id, type: 'highlight', rects, color });
      } else if (a.subtype === 'Square' || a.subtype === 'Circle') {
        const w = a.borderStyle?.width || 1, [x1, y1, x2, y2] = a.rect;
        shapes.push({
          page: e.id, type: a.subtype === 'Square' ? 'rect' : 'ellipse',
          x1: x1 + w / 2, y1: y1 + w / 2, x2: x2 - w / 2, y2: y2 - w / 2, color, width: w,
          ...(a.interiorColor?.length === 3 ? { fill: true } : {}),
        });
      } else if (a.subtype === 'FreeText') {
        const [x1, , , y2] = a.rect, da = a.defaultAppearanceData ?? {};
        const fc = da.fontColor?.length === 3 ? '#' + [...da.fontColor].map(v => v.toString(16).padStart(2, '0')).join('') : colors.text;
        shapes.push({ page: e.id, type: 'text', x1, y1: y2, x2: x1, y2, text: a.contentsObj?.str ?? '', size: da.fontSize || 12, color: fc });
      } else if (a.subtype === 'Stamp') {
        const s = { page: e.id, type: 'image', x1: a.rect[0], y1: a.rect[1], x2: a.rect[2], y2: a.rect[3], img: null };
        shapes.push(s);
        stamps.push({ s, id: a.id });
      } else continue;
      main.pdf.annotationStorage.setValue(a.id, { noView: true });
    }
  }
  if (stamps.length) await readStamps(await bytesOf(main), stamps);
  if (id !== loadId) return;
  layoutPages();
  const back = restorePlace(main);
  if (back === false) {
    setZoom(fitZoom(fit ?? 'auto'), fit);
    scrollTo(0, 0);
  }
  say(info.EncryptFilterName ? 'This PDF is encrypted: you can annotate it, but it cannot be saved.' : '', true);
  if (back > 1 && !info.EncryptFilterName) say(`Back where you left off, on page ${back}.`, { action: { label: 'Go to page 1', fn: () => jumpTo(0) } });

  // In the background, once the first page is on screen (so none of this slows it down): offer to compress a PDF
  // that's much bigger than it needs to be (once per file), and recognise the text on pages that have none, such as scans.
  await Promise.race([painted, new Promise(r => setTimeout(r, 1500))]);
  if (id !== loadId) return;
  checkCompression(id, !!info.EncryptFilterName);
  autoOcr(id);

  // Build every page's text layer in the background, so the whole document is selectable,
  // searchable with Ctrl+F, and readable by assistants and screen readers, not just the pages in view.
  for (const p of [...pages]) {
    if (id !== loadId) return;
    await textLayer(p);
  }
}

function fail(text) {
  document.body.classList.remove('opening');
  if (docs.has('main')) return say(text);
  $('hint').textContent = text;
}

function fetchBytes(src) {   // XHR rather than fetch, because fetch cannot read file:// URLs
  return new Promise((ok, no) => {
    const x = new XMLHttpRequest();
    x.open('GET', src);
    x.responseType = 'arraybuffer';
    x.withCredentials = true;
    x.onload = () => (x.status === 200 || (x.status === 0 && x.response?.byteLength) ? ok(x.response) : no());
    x.onerror = no;
    x.send();
  });
}

async function openUrl(src) {
  try {
    const file = decodeURIComponent(new URL(src).pathname.split('/').pop()) || 'document.pdf';
    srcUrl = src;
    srcHandle = null;
    srcStored = null;
    if (src.startsWith('file:')) recallHandle(src).then(h => { if (srcUrl === src) srcStored = h ?? null; });
    let source;
    if (!src.startsWith('file:')) source = { url: src };   // read in pieces, first page first
    else if (IN_PAGE) source = await (globalThis.inkfoldEarly?.bytes ?? Promise.reject());   // read by content.js, as the tab opened
    else source = await fetchBytes(src);
    await openPdf(source, file);
  } catch {
    fail(src.startsWith('file:')
      ? 'To open PDFs from your computer, turn on “Allow access to file URLs” for Inkfold in chrome://extensions. Or just drop the file here.'
      : 'That PDF could not be loaded again here. Download it and drop it here.');
  }
}

/* ---------- pages on screen ---------- */

const io = new IntersectionObserver(list => {
  for (const e of list) {
    const p = e.target.p;
    p.visible = e.isIntersecting;
    if (!p.visible) { unrender(p); continue; }
    // Until the first page is on screen, pages just outside the window wait, so they don't compete with it
    // (for a web PDF, for the connection as well).
    const onScreen = e.boundingClientRect.top < innerHeight && e.boundingClientRect.bottom > 0;
    if (!onScreen && painted && !painted.isDone) painted.then(() => p.visible && (render(p), textLayer(p)));
    else { render(p); textLayer(p); }
  }
}, { rootMargin: '100% 0px' });

const rotationOf = p => (p.page.rotate + p.e.rot) % 360;

// A page's viewport, showing only its crop box (e.crop: [x1, y1, x2, y2] in PDF points) when it has one.
// While the page is being cropped, it shows whole.
function viewportOf(p, scale, rotation = rotationOf(p)) {
  const vp = p.page.getViewport({ scale, rotation }), c = p.cropping ? null : p.e.crop;
  return c ? new vp.constructor({ viewBox: c, userUnit: p.page.userUnit ?? 1, scale, rotation }) : vp;
}
const cropKey = p => (p.cropping ? '' : p.e.crop?.join(',') ?? '');

function makeView(e) {
  const div = document.createElement('div');
  const hl = el('svg', { class: 'hl', 'aria-hidden': 'true' });
  const svg = el('svg', { class: 'shapes', 'aria-hidden': 'true' });
  const num = document.createElement('span');
  const p = div.p = { id: e.id, e, page: docs.get(e.doc).pages[e.i], div, hl, svg, num, canvas: null, task: null, at: '', want: '', visible: false, text: null };
  div.className = 'page';
  div.setAttribute('role', 'region');
  num.className = 'pagenum';
  num.setAttribute('aria-hidden', 'true');
  div.append(hl, svg, num);
  svg.addEventListener('pointerdown', ev => down(ev, p));
  svg.addEventListener('pointermove', ev => { if (tool === 'eraser' && !erasing) hoverErase(underEraser(ev, p), p); });
  svg.addEventListener('pointerleave', () => hoverErase(null, p));
  div.addEventListener('mousedown', ev => pressPage(ev, p));
  views.set(e.id, p);
  return p;
}

const kindOf = e => (e.doc === 'main' ? '' : e.doc.startsWith('pic') ? 'image' : 'note');   // pages added here

function layoutPages() {   // match the DOM to `entries`
  const live = new Set(entries.map(e => e.id));
  for (const p of views.values()) {
    if (live.has(p.id) || !p.div.isConnected) continue;
    io.unobserve(p.div);
    p.visible = false;
    unrender(p);
  }
  pages = entries.map(e => {
    const p = views.get(e.id) ?? makeView(e);
    p.e = e;
    return p;
  });
  $('pages').replaceChildren(...pages.map(p => p.div));
  pages.forEach((p, k) => {
    const kind = kindOf(p.e);
    p.num.textContent = `${k + 1}${kind ? ' · ' + kind : ''}`;
    p.div.setAttribute('aria-label', `Page ${k + 1}${kind ? ` (${kind})` : ''}`);
    io.observe(p.div);
  });
  $('count').textContent = `${pages.length} page${pages.length === 1 ? '' : 's'}`;
  showPage();
  findStale();
}

function size(p) {
  p.vp = viewportOf(p, zoom * CSS_PER_PT);
  const ck = cropKey(p);
  if (p.textReady && p.textKey !== ck) rebuildText(p);   // the text sits relative to the page's box
  p.textKey = ck;
  p.div.style.width = p.vp.width + 'px';
  p.div.style.height = p.vp.height + 'px';
  p.div.style.setProperty('--scale-factor', p.vp.scale);
  p.text?.update({ viewport: p.vp });
  paint(p);   // the old canvas stretches to the new size until settle() re-renders it sharp
}

function settle(delay = 0) {   // re-render visible pages once sizes stop changing
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => pages.forEach(p => p.visible && render(p)), delay);
}

async function render(p) {
  const key = zoom + '|' + rotationOf(p) + '|' + cropKey(p);
  if (p.at === key || p.want === key) return;
  p.task?.cancel();
  p.want = key;
  // Render at device resolution, but keep any one canvas under ~16 megapixels.
  const k = Math.min(devicePixelRatio || 1, Math.sqrt(16e6 / (p.vp.width * p.vp.height)));
  const viewport = viewportOf(p, zoom * CSS_PER_PT * k);
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const task = p.task = p.page.render({
    canvas, canvasContext: canvas.getContext('2d'), viewport,
    annotationMode: pdfjs.AnnotationMode.ENABLE_STORAGE,   // honours the noView flags set in openPdf
  });
  try { await task.promise; } catch { return; }   // cancelled by a newer render
  if (p.task !== task) return;
  p.canvas?.remove();
  p.div.prepend(canvas);
  painted?.done();
  Object.assign(p, { canvas, task: null, at: key });
}

function unrender(p) {
  p.task?.cancel();
  p.canvas?.remove();
  Object.assign(p, { canvas: null, task: null, at: '', want: '' });
}

function textLayer(p) {   // invisible, selectable text laid over the canvas
  return p.textReady ??= (async () => {
    const div = document.createElement('div');
    div.className = 'textLayer';
    div.addEventListener('pointerdown', () => div.classList.add('selecting'));
    p.svg.before(div);
    const ocr = p.e.doc === 'main' && ocrText.get(p.e.i);
    const textContentSource = ocr ? { items: ocr, styles: OCR_STYLES, lang: 'en' } : p.page.streamTextContent();
    p.text = new pdfjs.TextLayer({ textContentSource, container: div, viewport: p.vp });
    try { await p.text.render(); } catch {}
    p.text.update({ viewport: p.vp });   // in case the page was rotated or zoomed meanwhile
    const end = document.createElement('div');   // lets a drag that starts in the margin still select text
    end.className = 'endOfContent';
    div.append(end);
    markPage(p);
  })();
}

/* ---------- recognising text (OCR) ---------- */

// Pages without text of their own (scans, photos of pages) are read by PaddleOCR, in a worker of the extension's
// hidden helper page, one page at a time. What it finds becomes an ordinary text layer, so it can be selected,
// searched, highlighted and read by assistants, and it's saved into copies as invisible text.
const OCR_STYLES = { ocr: { fontFamily: 'sans-serif', ascent: 0.8, descent: -0.2, vertical: false } };
let ocrStop = false;

// Text recognition's state, shown in the Pages and file panel (and as a ring around its gear button while it runs).
// phase: 'checking' | 'none' (the PDF has its text) | 'running' | 'done' | 'stopped' | 'failed'
let ocrState = { phase: 'checking' };
function showOcr(state) {
  ocrState = state;
  const { phase, done = 0, total = 0, found = 0 } = state, running = phase === 'running';
  const pct = total ? Math.round(100 * done / total) : 0;
  const pl = n => `${n} scanned page${n === 1 ? '' : 's'}`;
  $('ocrLabel').textContent = {
    checking: 'Checking the pages…',
    none: 'Not needed: this PDF already has its text.',
    running: `Reading page ${Math.min(done + 1, total)} of ${total} · ${pct}%`,
    done: found ? `Done: text found on ${pl(found)}. You can select, find and highlight it.` : `Done: no text found on the ${pl(total)}.`,
    stopped: `Stopped after ${done} of ${total} pages${found ? `; ${found} kept their text` : ''}.`,
    failed: 'Couldn’t recognise the text on the scanned pages.',
  }[phase];
  const bar = $('ocrFact').querySelector('.bar');
  bar.hidden = !running;
  $('ocrBar').style.width = Math.max(4, pct) + '%';
  bar.setAttribute('aria-valuenow', pct);
  $('ocrStop').hidden = !running;
  $('pagesBtn').classList.toggle('busy', running);
  $('pagesBtn').querySelector('.ring').style.setProperty('--p', Math.max(4, pct));
  $('pagesBtn').title = running ? `Pages and file (P) · recognising text, ${pct}%` : 'Pages and file (P): rotate, delete or split pages, text recognition, compression';
}

async function autoOcr(id) {
  const main = docs.get('main');
  const todo = [];
  for (const [i, page] of main.pages.entries()) {
    const tc = await page.getTextContent().catch(() => null);
    if (id !== loadId) return;
    const chars = tc ? tc.items.reduce((n, it) => n + (it.str?.replace(/\s/g, '').length ?? 0), 0) : 0;
    if (chars < 8) todo.push(i);
  }
  if (!todo.length) return showOcr({ phase: 'none' });   // the PDF already has its text
  ocrStop = false;
  todo.forEach(i => ocrBusy.add(i));
  let done = 0, found = 0;
  const total = todo.length;
  showOcr({ phase: 'running', done, total });
  const left = new Set(todo);
  while (left.size) {
    if (id !== loadId || ocrStop) break;
    // Next, the scanned page nearest the one you're looking at (from it onwards first), so it gets its text soonest.
    const e = entries[currentIndex()], at = e?.doc === 'main' ? e.i : 0;
    let i = null;
    for (const k of left) if (i === null || Math.abs(k - at) + (k < at ? 0.5 : 0) < Math.abs(i - at) + (i < at ? 0.5 : 0)) i = k;
    left.delete(i);
    let result, vp;
    try {
      const shot = await pageImage(main.pages[i]);
      vp = shot.vp;
      result = await chrome.runtime.sendMessage({ type: 'ocr', image: shot.image });
    } catch (e) { result = { error: String(e) }; }
    if (id !== loadId) return;
    if (!result || result.error) {
      showOcr({ phase: 'failed' });
      ocrBusy.clear();
      return say('Inkfold couldn’t recognise the text on this PDF’s scanned pages.', { long: true });
    }
    const items = ocrItems(result.lines, vp);
    if (items.length) {
      ocrText.set(i, items);
      found++;
      for (const p of views.values()) if (p.e.doc === 'main' && p.e.i === i) rebuildText(p);
    }
    ocrBusy.delete(i);
    if (id === loadId) showOcr({ phase: 'running', done: ++done, total });
  }
  ocrBusy.clear();
  if (id !== loadId) return;
  showOcr({ phase: ocrStop ? 'stopped' : 'done', done, total, found });
  if (ocrStop) say(`Stopped recognising text. ${found ? `The ${found} page${found === 1 ? '' : 's'} already done keep their text.` : ''}`);
  else if (found) say(`Recognised the text on ${found} scanned page${found === 1 ? '' : 's'}. You can now select, search and highlight it, and copies you save keep it.`, { long: true });
}

async function pageImage(page) {   // the page as a ~200 dpi JPEG, upright as it's meant to be read
  const [x0, y0, x1, y1] = page.view, side = Math.max(x1 - x0, y1 - y0);
  const vp = page.getViewport({ scale: Math.min(200 / 72, 2400 / side) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: g, viewport: vp, annotationMode: pdfjs.AnnotationMode.DISABLE }).promise;
  const image = canvas.toDataURL('image/jpeg', 0.92);
  canvas.width = canvas.height = 0;
  return { vp, image };
}

// Recognised words (image pixels) -> pdf.js text items (PDF points). A word is given by where its baseline starts
// and ends (a, z) and its line's letter height (h), so skewed, vertical and upside-down lines keep their direction.
// Each word carries the space after it and spans up to the next word, so selecting a line copies it as one line.
function ocrItems(lines, vp) {
  const items = [];
  for (const line of lines ?? []) {
    if (!(line.h > 2)) continue;
    line.words.forEach((w, k) => {
      const next = line.words[k + 1];
      const end = next ? next.a : w.z;
      const dx = w.z[0] - w.a[0], dy = w.z[1] - w.a[1], len = Math.hypot(dx, dy) || 1;
      const top = [w.a[0] + dy / len * line.h, w.a[1] - dx / len * line.h];   // up from the baseline, at the word's start
      const [ox, oy] = vp.convertToPdfPoint(...w.a), [ex, ey] = vp.convertToPdfPoint(...end), [tx, ty] = vp.convertToPdfPoint(...top);
      const width = Math.hypot(ex - ox, ey - oy), size = Math.hypot(tx - ox, ty - oy);
      const a = Math.atan2(ey - oy, ex - ox), cos = Math.cos(a), sin = Math.sin(a);
      items.push({
        str: next ? w.t + ' ' : w.t, dir: 'ltr', width, height: size, fontName: 'ocr', hasEOL: !next,
        transform: [size * cos, size * sin, -size * sin, size * cos, ox, oy],
      });
    });
  }
  return items;
}

function rebuildText(p) {   // swap a page's text layer for a fresh one (after its text was recognised)
  try { p.text?.cancel(); } catch {}
  p.div.querySelector('.textLayer')?.remove();
  p.text = null;
  p.textReady = null;
  textLayer(p);
  findStale();   // its words can now be found (or found again, after a crop)
}

/* ---------- offering to compress ---------- */

const fmtSize = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB');

// How much smaller the file could be is worked out once per file (remembered by its fingerprint, with the
// result) and shown in the Pages and file panel. The first time it's more than a fifth, Inkfold also offers it.
// phase: 'checking' | 'small' | 'locked' | 'ready' (could be smaller) | 'compact' | 'working' | 'done' | 'failed'
let zipState = { phase: 'checking' };
function showZip(state) {
  zipState = state;
  const { phase, before, after } = state, pct = before ? Math.round(100 * (1 - after / before)) : 0;
  $('zipLabel').textContent = {
    checking: 'Checking how much smaller it could be…',
    small: 'Not needed: the file is already small.',
    locked: 'Not available for encrypted PDFs.',
    ready: `Could be ${pct}% smaller (${fmtSize(before)} → ${fmtSize(after)}).`,
    compact: pct > 0 ? `Already compact: at most ${pct}% smaller.` : 'Already compact.',
    working: 'Compressing…',
    done: `Compressed by ${pct}%: copies you save are about ${fmtSize(after)}.`,
    failed: 'Couldn’t check this file.',
  }[phase];
  const meter = $('zipFact').querySelector('.meter');
  meter.hidden = !['ready', 'compact', 'done'].includes(phase) || pct <= 0;
  $('zipBar').style.width = clamp(pct, 0, 100) + '%';
  $('zipGo').hidden = phase !== 'ready';
  $('zipGo').classList.toggle('go', pct > 20);
}

async function smallerCopy() {
  return (await import('./compress.js')).compressPdf(await bytesOf(docs.get('main')));
}

async function applyCompression(id, smaller) {
  const main = docs.get('main');
  if (id !== loadId) return;
  const before = main.bytes?.length ?? (await main.pdf.getDownloadInfo()).length;
  if (id !== loadId) return;
  main.bytes = smaller;
  dirty = true;
  showZip({ phase: 'done', before, after: smaller.length });
  say(`Compressed. Saved copies are now about ${fmtSize(smaller.length)}. Press Save to keep it.`, { action: { label: 'Save', fn: () => save() } });
}

async function checkCompression(id, encrypted) {
  const main = docs.get('main'), fp = main.pdf.fingerprints?.[0];
  let size;
  try { size = (await main.pdf.getDownloadInfo()).length; } catch {}
  if (id !== loadId) return;
  if (!size) return showZip({ phase: 'failed' });
  if (encrypted) return showZip({ phase: 'locked' });
  if (size < 100_000) return showZip({ phase: 'small' });
  const known = store.get('compressInfo', {})[fp];
  const show = after => showZip({ phase: 1 - after / size > 0.05 ? 'ready' : 'compact', before: size, after });
  if (known && known[0] === size) return show(known[1]);
  await new Promise(r => setTimeout(r, 1500));   // let the first pages draw first
  if (id !== loadId) return;
  let smaller;
  try { smaller = await smallerCopy(); } catch { return id === loadId && showZip({ phase: 'failed' }); }
  if (id !== loadId) return;
  const before = size, after = smaller.length, saved = 1 - after / before;
  if (fp) {
    const info = store.get('compressInfo', {});
    delete info[fp];
    const keep = Object.entries(info).slice(-299);
    store.set('compressInfo', Object.fromEntries([...keep, [fp, [before, after]]]));
  }
  show(after);
  const offered = store.get('compressChecked', []);
  if (saved <= 0.2 || (fp && offered.includes(fp))) return;
  if (fp) store.set('compressChecked', [...offered.slice(-299), fp]);
  notice({
    text: `This PDF could be ${Math.round(saved * 100)}% smaller (${fmtSize(before)} → ${fmtSize(after)}), mostly by storing its images more efficiently. Compress it?`,
    yes: 'Compress', no: 'Not now',
    onYes: () => applyCompression(id, smaller),
  });
}

$('zipGo').onclick = async () => {
  const id = loadId;
  const was = zipState;
  showZip({ phase: 'working' });
  try { applyCompression(id, await smallerCopy()); } catch { if (id === loadId) showZip(was); }
};

function notice({ text, yes, no, onYes }) {
  $('noticeText').textContent = text;
  $('noticeYes').textContent = yes;
  $('noticeNo').textContent = no;
  $('noticeYes').onclick = () => { $('notice').hidden = true; onYes(); };
  $('noticeNo').onclick = () => { $('notice').hidden = true; };
  $('notice').hidden = false;
}

/* ---------- merging PDFs ---------- */

// In the Pages and file panel: add PDFs, put them in order (drag the grip, or focus it and use ↑ ↓), and merge.
// The open PDF, with its changes, is always one of the items. The merged file is a new file, saved
// where you choose; the open PDF isn't changed.
let mergeItems = [{ current: true }];

const GRIP = '<svg viewBox="0 0 12 14" aria-hidden="true"><g fill="currentColor"><circle cx="4" cy="3" r="1.2"/><circle cx="8" cy="3" r="1.2"/><circle cx="4" cy="7" r="1.2"/><circle cx="8" cy="7" r="1.2"/><circle cx="4" cy="11" r="1.2"/><circle cx="8" cy="11" r="1.2"/></g></svg>';
const CROSS = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

function drawMerge(focus = null) {
  const list = $('mergeList');
  list.replaceChildren(...mergeItems.map((it, k) => {
    const label = it.current ? 'This PDF' : it.name;
    const grip = el2('button', { type: 'button', class: 'grip', title: 'Drag to reorder (or ↑ ↓)', 'aria-label': `Move ${label}: ↑ or ↓` });
    grip.innerHTML = GRIP;
    // The open PDF always takes part (that's what's being merged into); the others can be taken out again.
    const rm = it.current ? el2('span', { class: 'rm' })
      : el2('button', { type: 'button', class: 'rm', title: 'Remove from the merge', 'aria-label': `Remove ${label}` });
    if (!it.current) {
      rm.innerHTML = CROSS;
      rm.onclick = () => { mergeItems.splice(k, 1); drawMerge(); };
    }
    const pagesN = it.current ? entries.length : it.pages;
    const count = it.error ? it.error : pagesN == null ? '…' : `${pagesN} page${pagesN === 1 ? '' : 's'}`;
    const li = el2('li', { class: (it.current ? 'current' : '') + (it.error ? ' bad' : '') },
      grip, el2('span', { class: 'name', title: it.current ? `${name}, with your changes` : label }, it.current ? el2('b', {}, 'This PDF') : label),
      el2('span', { class: 'count' }, count), rm);
    grip.addEventListener('keydown', e => {
      const d = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
      if (!d) return;
      e.preventDefault();
      e.stopPropagation();
      const j = k + d;
      if (j < 0 || j >= mergeItems.length) return;
      [mergeItems[k], mergeItems[j]] = [mergeItems[j], mergeItems[k]];
      drawMerge(j);
    });
    grip.addEventListener('pointerdown', e => dragMerge(e, li, k));
    return li;
  }));
  const ok = mergeItems.filter(it => !it.error).length;
  $('merge').disabled = ok < 2;
  $('merge').textContent = ok >= 2 ? `Merge ${ok} PDFs and save` : 'Merge and save';
  if (focus != null) list.children[focus]?.querySelector('.grip').focus();
}

function dragMerge(e, li, from) {   // drag a row up or down; the others make room as it passes them
  if (e.button) return;
  e.preventDefault();
  const list = $('mergeList'), rows = [...list.children], y0 = e.clientY;
  const h = li.getBoundingClientRect().height + 4;
  // The row stays within the list: from the top of the first row to the bottom of the last.
  const box = list.getBoundingClientRect(), me = li.getBoundingClientRect();
  const minDy = box.top - me.top, maxDy = box.bottom - me.bottom;
  let to = from;
  li.classList.add('dragging');
  li.querySelector('.grip').setPointerCapture(e.pointerId);
  const onMove = ev => {
    const dy = clamp(ev.clientY - y0, minDy, maxDy);
    to = clamp(from + Math.round(dy / h), 0, rows.length - 1);
    li.style.transform = `translateY(${dy}px)`;
    rows.forEach((r, k) => {
      if (r === li) return;
      const shift = from < to && k > from && k <= to ? -h : from > to && k < from && k >= to ? h : 0;
      r.style.transform = shift ? `translateY(${shift}px)` : '';
    });
  };
  const onUp = () => {
    removeEventListener('pointermove', onMove);
    removeEventListener('pointerup', onUp);
    removeEventListener('pointercancel', onUp);
    const [it] = mergeItems.splice(from, 1);
    mergeItems.splice(to, 0, it);
    drawMerge(to);
  };
  addEventListener('pointermove', onMove);
  addEventListener('pointerup', onUp);
  addEventListener('pointercancel', onUp);
}

async function addMergeFiles(files) {
  const pdfs = [...files].filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (!pdfs.length) return say('Only PDF files can be merged.');
  const items = pdfs.map(file => ({ file, name: file.name, pages: null }));
  mergeItems.push(...items);
  drawMerge();
  for (const it of items) {   // count their pages (and find any that can't be read) without holding them open
    try {
      const pdf = await pdfjs.getDocument({ data: new Uint8Array(await it.file.arrayBuffer()), ...PDFJS_OPTS }).promise;
      it.pages = pdf.numPages;
      pdf.loadingTask.destroy().catch(() => {});
    } catch (e) {
      it.error = e.name === 'PasswordException' ? 'password-protected' : 'can’t be read';
    }
    drawMerge();
  }
}

async function merge() {
  const items = mergeItems.filter(it => !it.error);
  if (items.length < 2) return;
  finishEdit();
  const base = name.replace(/\.pdf$/i, '');
  const suggestedName = `${base} (merged).pdf`;
  let handle = null;
  if (window.showSaveFilePicker) {   // ask where first, while the click still counts as a user action
    try {
      handle = await showSaveFilePicker({ suggestedName, id: folderId(), types: [{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }] });
    } catch (e) { if (e.name === 'AbortError') return; }
  }
  $('panel').hidePopover();
  say('Merging…', true);
  try {
    const { PDFDocument } = await lib();
    let out = null, total = 0;
    for (const [k, it] of items.entries()) {
      say(`Merging… ${k + 1} of ${items.length}`, true);
      const bytes = it.current ? await build(entries) : new Uint8Array(await it.file.arrayBuffer());
      let src;
      try { src = await PDFDocument.load(bytes, { updateMetadata: false }); }
      catch (e) { throw new Error(/encrypt/i.test(e.message) ? `“${it.current ? name : it.name}” is encrypted, so it can’t be merged.` : `“${it.current ? name : it.name}” couldn’t be read.`); }
      total += src.getPageCount();
      if (!out) { out = src; continue; }   // the first file is the base, so its bookmarks and details are kept
      for (const pg of await out.copyPages(src, src.getPageIndices())) out.addPage(pg);
    }
    const data = await out.save({ useObjectStreams: true });
    if (handle) {
      const w = await handle.createWritable();
      await w.write(data);
      await w.close();
      say(`Saved the merged PDF, “${handle.name}”: ${total} pages from ${items.length} files.`);
    } else {
      download(data, suggestedName);
      say(`Saved the merged PDF to your downloads: ${total} pages from ${items.length} files.`);
    }
  } catch (e) {
    say(e.message.startsWith('“') ? e.message : 'Could not merge: ' + e.message, true);
  }
}

$('mergeAdd').onclick = () => { $('mergeFiles').value = ''; $('mergeFiles').click(); };
$('mergeFiles').onchange = () => addMergeFiles($('mergeFiles').files);
$('merge').onclick = merge;
$('panel').addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); $('panel').classList.add('dropping'); } });
$('panel').addEventListener('dragleave', e => { if (!$('panel').contains(e.relatedTarget)) $('panel').classList.remove('dropping'); });
$('panel').addEventListener('drop', e => {
  e.preventDefault();
  e.stopPropagation();
  $('panel').classList.remove('dropping');
  addMergeFiles(e.dataTransfer.files);
});

/* ---------- moving a page ---------- */

// Right-click a page, Move page: the page lifts and a small copy of it follows the pointer. The two pages on either
// side of where it would go ease apart to make room, and the copy says where that is. Click (or release, after
// dragging) to put it there. Arrow keys move the line too, Enter drops, Esc cancels.
// The window scrolls when the pointer nears its top or bottom edge. One undo puts it back.
let moving = null;   // { p, from, slot, ghost, line, x, y, scroll }

function startMove(p) {
  if (pages.length < 2) return say('There’s only one page, so there’s nowhere to move it.');
  finishEdit();
  select(null);
  const from = pages.indexOf(p);
  const ghost = el2('div', { class: 'ghost', 'aria-hidden': 'true' });
  const r = p.div.getBoundingClientRect(), W = 96, H = Math.round(W * r.height / r.width);
  const c = Object.assign(document.createElement('canvas'), { width: W * 2, height: H * 2 });
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  if (p.canvas) g.drawImage(p.canvas, 0, 0, c.width, c.height);
  const where = el2('span', {}, `Page ${from + 1}`);
  ghost.append(c, where);
  const spot = el2('div', { class: 'dropspot', 'aria-hidden': 'true' }, el2('span', {}, `Page ${from + 1} goes here`));
  document.body.append(ghost, spot);
  moving = { p, from, slot: from, ghost, where, spot, parted: [], x: r.left + r.width / 2, y: Math.max(r.top, 80) + 40, scroll: 0, key: false };
  p.div.classList.add('lifted');
  document.body.classList.add('moving');
  placeGhost();
  say(`Moving page ${from + 1}: point between two pages and click to put it there. Arrow keys and Enter work too; Esc cancels.`, true);
}

// The gaps a page can go into: before each page, and after the last. In two-page view the gaps sit between
// the pages of a row (and at its ends); otherwise between one page and the next.
function slots() {
  const out = [], col = spread;
  const rect = q => {   // where the page is, leaving out how far it's been eased aside
    const r = q.div.getBoundingClientRect();
    // (its current offset, mid-animation included, as the browser has it right now)
    const t = q.part || q.div.style.translate ? getComputedStyle(q.div).translate : 'none';
    const [dx = 0, dy = 0] = t === 'none' ? [] : t.split(' ').map(parseFloat);
    return { left: r.left - dx, right: r.right - dx, top: r.top - dy, bottom: r.bottom - dy, width: r.width, height: r.height };
  };
  pages.forEach((q, k) => {
    const r = rect(q);
    out.push(col ? { k, x: r.left - GAP / 2, y: r.top + r.height / 2, len: r.height, vertical: true, r }
      : { k, x: r.left + r.width / 2, y: r.top - GAP / 2, len: r.width, vertical: false, r });
  });
  const r = rect(pages.at(-1));
  out.push(col ? { k: pages.length, x: r.right + GAP / 2, y: r.top + r.height / 2, len: r.height, vertical: true, r }
    : { k: pages.length, x: r.left + r.width / 2, y: r.bottom + GAP / 2, len: r.width, vertical: false, r });
  return out;
}

function placeGhost() {
  const m = moving;
  if (!m) return;
  m.ghost.style.transform = `translate(${m.x + 14}px, ${m.y + 14}px)`;
  const all = slots();
  if (!m.key) {   // the gap nearest the pointer (rows count before columns, so it doesn't jump across in two-page view)
    const dist = sl => (sl.vertical ? Math.hypot(m.x - sl.x, Math.max(0, Math.abs(m.y - sl.y) - sl.len / 2) * 4)
      : Math.hypot(Math.max(0, Math.abs(m.x - sl.x) - sl.len / 2) * 4, m.y - sl.y));
    let best = null, d = Infinity;
    for (const sl of all) { const dd = dist(sl); if (dd < d) { d = dd; best = sl; } }
    // Only change gaps once the pointer is clearly nearer the new one, so the pages don't flick back and forth.
    const cur = all[m.slot], hold = Math.min(80, 0.15 * (cur?.vertical ? cur.r.width : cur?.r.height ?? 0));
    if (!cur || best.k === m.slot || d + hold < dist(cur)) m.slot = best.k;
  }
  const sl = all[m.slot], same = m.slot === m.from || m.slot === m.from + 1;
  // The pages either side of the gap ease apart (unless the page would land where it already is).
  const before = pages[m.slot - 1], after = pages[m.slot], push = 30;
  const want = same ? [] : [[before, -push], [after, push]].filter(([q]) => q && q !== m.p);
  for (const q of m.parted) if (!want.some(([w]) => w === q)) part(q, null);
  for (const [q, d] of want) part(q, sl.vertical ? [d, 0] : [0, d]);
  m.parted = want.map(([q]) => q);
  const n = pages.length;
  m.where.textContent = same ? `Page ${m.from + 1} · stays here`
    : m.slot === 0 ? `Page ${m.from + 1} → first` : m.slot === n ? `Page ${m.from + 1} → last`
    : `Page ${m.from + 1} → between ${m.slot} and ${m.slot + 1}`;
  m.ghost.classList.toggle('same', same);
  // A marker in the opened gap: "Page 2 goes here".
  m.spot.classList.toggle('show', !same);
  m.spot.classList.toggle('v', sl.vertical);
  m.spot.style.translate = `${sl.x}px ${sl.y}px`;
  if (m.key) m.ghost.style.transform = `translate(${sl.vertical ? sl.x + 14 : sl.x + Math.min(sl.len / 2, 160) + 14}px, ${sl.y + 10}px)`;   // beside the gap
}

function part(q, d) {   // ease a page aside by [dx, dy] (null: back in place)
  q.part = d;
  q.div.style.translate = d ? `${d[0]}px ${d[1]}px` : '';
}

function moveGlide() {   // scroll while the pointer is near the top or bottom edge
  const m = moving;
  if (!m || m.key) return;
  const top = header.getBoundingClientRect().bottom, edge = 70;
  const v = m.y < top + edge ? -(top + edge - m.y) : m.y > innerHeight - edge ? m.y - (innerHeight - edge) : 0;
  if (v) { scrollBy(0, Math.sign(v) * Math.min(28, Math.abs(v) / 2.5 + 2)); placeGhost(); }
  m.scroll = v ? requestAnimationFrame(moveGlide) : 0;
}

function endMove(drop) {
  const m = moving;
  if (!m) return;
  moving = null;
  cancelAnimationFrame(m.scroll);
  m.ghost.remove();
  for (const q of m.parted) part(q, null);
  m.spot.remove();
  m.p.div.classList.remove('lifted');
  document.body.classList.remove('moving');
  if (!drop || m.slot === m.from || m.slot === m.from + 1) return say(drop ? 'The page stays where it was.' : 'Move cancelled.');
  const e = entries[m.from], to = m.slot > m.from ? m.slot - 1 : m.slot;
  changePages(() => { entries.splice(m.from, 1); entries.splice(to, 0, e); });
  const where = to === 0 ? 'to the start: it’s now page 1' : to === entries.length - 1 ? `to the end: it’s now page ${to + 1}` : `: it’s now page ${to + 1}`;
  views.get(e.id)?.div.scrollIntoView({ block: 'nearest' });
  showPage();
  say(`Moved page ${m.from + 1}${where.startsWith(':') ? '' : ' '}${where}.`, { action: { label: 'Undo', fn: undo } });
}

addEventListener('pointermove', e => {
  if (!moving) return;
  Object.assign(moving, { x: e.clientX, y: e.clientY, key: false });
  placeGhost();
  if (!moving.scroll) moveGlide();
}, true);
addEventListener('pointerdown', e => {
  if (!moving || e.target.closest('#toast')) return;
  e.preventDefault();
  e.stopPropagation();
  moving.down = { x: e.clientX, y: e.clientY };
}, true);
addEventListener('pointerup', e => {
  if (!moving?.down) return;
  e.preventDefault();
  e.stopPropagation();
  endMove(true);
  swallow = true;   // the click that follows this release isn't for the page underneath
  setTimeout(() => { swallow = false; }, 400);
}, true);
let swallow = false;
addEventListener('click', e => { if (swallow) { swallow = false; e.preventDefault(); e.stopPropagation(); } }, true);
addEventListener('keydown', e => {
  if (!moving) return;
  e.preventDefault();
  e.stopPropagation();
  const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1, Home: -Infinity, End: Infinity }[e.key];
  if (e.key === 'Escape') return endMove(false);
  if (e.key === 'Enter' || e.key === ' ') return endMove(true);
  if (step === undefined) return;
  moving.key = true;
  moving.slot = clamp(moving.slot + step, 0, pages.length);
  const sl = slots()[moving.slot];
  const top = header.getBoundingClientRect().bottom;
  if (sl.y < top + 40 || sl.y > innerHeight - 40) scrollBy({ top: sl.y - (top + innerHeight) / 2 });
  if (sl.x < 20 || sl.x > innerWidth - 20) scrollBy({ left: sl.x - innerWidth / 2 });
  placeGhost();
}, true);
addEventListener('scroll', () => moving && placeGhost(), { passive: true });

/* ---------- find ---------- */

// Ctrl+F lists every page that mentions the text, once, with how many times and a snippet. Moving through the
// list (Tab, ↓) scrolls to each page in turn; the matches are lit up on the pages with the CSS Highlight API,
// so the page's own text is never touched.
const findCache = new WeakMap();   // pdf.js page -> its text as one string
let findRun = 0, findHits = [], findOn = -1, findTimer = 0;
const findMarks = new Map();       // page view -> Range[] of its matches

function findPattern() {
  const q = $('findQ').value.trim();
  if (!q) return null;
  let src = q.split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  if ($('findWord').checked) src = `(?<![\\p{L}\\p{N}_])${src}(?![\\p{L}\\p{N}_])`;
  try { return new RegExp(src, $('findCase').checked ? 'gu' : 'giu'); } catch { return null; }
}

const joinItems = items => items.map(it => (it.str ?? '') + (it.hasEOL ? '\n' : '')).join('');
async function pageText(p) {
  let t;
  if (p.e.doc === 'main' && ocrText.has(p.e.i)) t = joinItems(ocrText.get(p.e.i));
  else if ((t = findCache.get(p.page)) === undefined) {
    const tc = await p.page.getTextContent().catch(() => ({ items: [] }));
    findCache.set(p.page, t = joinItems(tc.items));
  }
  const boxes = shapes.filter(s => s.page === p.id && s.type === 'text').map(s => s.text);   // your own text boxes too
  return (boxes.length ? t + '\n' + boxes.join('\n') : t).replace(/[\s­]+/g, ' ');
}

function openFind() {
  if (!docs.has('main')) return;
  const f = $('find');
  if (!f.matches(':popover-open')) {
    document.querySelectorAll('.pop:popover-open, #zoomPop:popover-open').forEach(x => x.hidePopover());
    f.style.top = header.getBoundingClientRect().bottom + 6 + 'px';
    clearTimeout(findFade);
    f.showPopover();
    $('findBtn').setAttribute('aria-pressed', 'true');
    const picked = String(getSelection()).trim();   // selected text becomes the search
    if (picked && picked.length < 80 && !picked.includes('\n')) $('findQ').value = picked;
    if ($('findQ').value) runFind();
  }
  $('findQ').focus();
  $('findQ').select();
}

let findFade = 0;
function closeFind(linger = false) {   // linger: leave the matches lit for a moment, to show where they are
  $('find').hidePopover();
  $('findBtn').setAttribute('aria-pressed', 'false');
  findRun++;
  clearTimeout(findFade);
  const clear = () => { findMarks.clear(); CSS.highlights?.delete('find'); CSS.highlights?.delete('find-on'); };
  if (linger) findFade = setTimeout(() => { if (!$('find').matches(':popover-open')) clear(); }, 2500);
  else clear();
}

function findStale() {   // pages or their text changed: search again, quietly
  if (!$('find').matches(':popover-open') || !$('findQ').value.trim()) return;
  clearTimeout(findTimer);
  findTimer = setTimeout(() => runFind(true), 250);
}

async function runFind(keepFocus = false) {
  const run = ++findRun, re = findPattern(), list = $('findList'), sum = $('findSum');
  const onPage = findOn >= 0 ? findHits[findOn]?.p : null;
  findHits = []; findOn = -1;
  findMarks.clear();
  list.replaceChildren();
  $('find').querySelector('.empty')?.remove();
  paintMarks();
  if (!re) { sum.textContent = ''; return; }
  let total = 0;
  sum.textContent = 'Searching…';
  for (const [k, p] of pages.entries()) {
    const text = await pageText(p);
    if (run !== findRun) return;
    re.lastIndex = 0;
    let n = 0, first = null, m;
    while ((m = re.exec(text))) { if (!first) first = m; n++; if (!m[0].length) re.lastIndex++; }
    if (n) {
      total += n;
      const hit = { p, k, n };
      findHits.push(hit);
      list.append(findRow(hit, text, first));
      sum.innerHTML = '';
      sum.append(...summary(total, findHits.length, k + 1 < pages.length));
    }
    if (k % 8 === 7) await new Promise(r => setTimeout(r));   // stay responsive on long PDFs
  }
  if (run !== findRun) return;
  sum.replaceChildren(...summary(total, findHits.length, false));
  if (!findHits.length) {
    const scanning = ocrState.phase === 'running';
    list.after(el2('p', { class: 'empty' }, scanning ? 'No matches yet. Inkfold is still reading the scanned pages; they’ll be searched as they’re done.' : 'No matches in this PDF.'));
  }
  for (const p of pages) if (p.textReady) p.textReady.then(() => markPage(p));
  const back = onPage && findHits.findIndex(h => h.p === onPage);
  if (keepFocus && back >= 0) setFindOn(back, false);
}

function summary(total, nPages, more) {
  if (!total) return [document.createTextNode(more ? 'Searching…' : 'No matches')];
  const b = s => el2('b', {}, String(s));
  return [b(total), ` match${total === 1 ? '' : 'es'} on `, b(nPages), ` page${nPages === 1 ? '' : 's'}${more ? '…' : ''}`];
}

function findRow(hit, text, m) {
  const a = Math.max(0, m.index - 36), z = Math.min(text.length, m.index + m[0].length + 70);
  const snip = el2('span', { class: 'snip' },
    (a ? '…' : '') + text.slice(a, m.index).trimStart(), el2('mark', {}, m[0]), text.slice(m.index + m[0].length, z) + (z < text.length ? '…' : ''));
  const isNote = hit.p.e.doc !== 'main';
  const btn = el2('button', { type: 'button', title: `Page ${hit.k + 1}: ${hit.n} match${hit.n === 1 ? '' : 'es'}` },
    el2('span', { class: 'pg' }, el2('small', {}, isNote ? 'Note' : 'Page'), el2('span', {}, String(hit.k + 1))),
    snip,
    el2('span', { class: 'n', 'aria-label': `${hit.n} match${hit.n === 1 ? '' : 'es'}` }, '×' + hit.n));
  btn.addEventListener('focus', () => setFindOn(findHits.indexOf(hit)));
  btn.addEventListener('click', async () => { await setFindOn(findHits.indexOf(hit)); closeFind(true); });
  return el2('li', {}, btn);
}

// Scroll to a result's page (its first match, once the page's text is there) and light its matches up brighter.
async function setFindOn(i, scroll = true) {
  const hit = findHits[i];
  if (!hit) return;
  findOn = i;
  $('findList').querySelectorAll('button.on').forEach(b => b.classList.remove('on'));
  const btn = $('findList').children[i]?.firstChild;
  btn?.classList.add('on');
  btn?.scrollIntoView({ block: 'nearest' });
  if (!scroll) return paintMarks();
  const p = hit.p;
  p.div.scrollIntoView({ block: 'start' });
  scrollBy(0, -GAP);
  showPage(hit.k);
  await textLayer(p);
  if (findOn !== i) return;
  markPage(p);
  const r = findMarks.get(p)?.[0]?.getBoundingClientRect();
  const top = header.getBoundingClientRect().bottom;
  if (r && (r.bottom > innerHeight - 40 || r.top < top)) scrollBy({ top: r.top - top - innerHeight * 0.25, behavior: 'smooth' });
}

// The ranges of the matches in a page's text layer.
function markPage(p) {
  if (!$('find').matches(':popover-open') || !findHits.some(h => h.p === p)) {
    if (findMarks.delete(p)) paintMarks();
    return;
  }
  const re = findPattern(), layer = p.div.querySelector('.textLayer');
  if (!re || !layer) return;
  const nodes = [], walk = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let str = '';
  for (let n; (n = walk.nextNode());) {
    if (n.nodeType === 3) { nodes.push([n, str.length]); str += n.data; }
    else if (n.tagName === 'BR') str += '\n';   // line ends, so words on two lines don't run together
  }
  if (!nodes.length) return;
  const at = off => {   // string offset -> [text node, offset in it]
    let lo = 0, hi = nodes.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (nodes[mid][1] <= off) lo = mid; else hi = mid - 1; }
    return [nodes[lo][0], off - nodes[lo][1]];
  };
  const ranges = [];
  for (let m; (m = re.exec(str));) {
    if (!m[0].length) { re.lastIndex++; continue; }
    const r = new Range();
    const [a, ao] = at(m.index), [b, bo] = at(m.index + m[0].length - 1);
    r.setStart(a, ao);
    r.setEnd(b, bo + 1);
    ranges.push(r);
  }
  findMarks.set(p, ranges);
  paintMarks();
}

function paintMarks() {
  if (!CSS.highlights || typeof Highlight === 'undefined') return;
  const on = findHits[findOn]?.p, all = [], cur = [];
  for (const [p, rs] of findMarks) (p === on ? cur : all).push(...rs);
  CSS.highlights.set('find', new Highlight(...all));
  CSS.highlights.set('find-on', new Highlight(...cur));
}

$('findBtn').onclick = () => ($('find').matches(':popover-open') ? closeFind() : openFind());
$('findClose').onclick = () => closeFind();
$('findQ').addEventListener('input', () => { clearTimeout(findTimer); findTimer = setTimeout(runFind, 140); });
$('findCase').onchange = $('findWord').onchange = () => { runFind(); $('findQ').focus(); };
$('find').addEventListener('keydown', e => {
  const rows = [...$('findList').querySelectorAll('li > button')];
  const i = rows.indexOf(document.activeElement), mod = e.ctrlKey || e.metaKey;
  const go = j => { e.preventDefault(); rows[(j + rows.length) % rows.length]?.focus(); };
  if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); e.stopPropagation(); $('findQ').focus(); $('findQ').select(); return; }
  if (mod) return;   // Ctrl+Z, Ctrl+S… still work
  e.stopPropagation();   // letters typed here aren't tool shortcuts
  if (e.key === 'Escape') { e.preventDefault(); return closeFind(); }
  if (!rows.length) return;
  if (e.target === $('findQ')) {
    if ((e.key === 'Tab' && !e.shiftKey) || e.key === 'ArrowDown') return go(0);
    if (e.key === 'Enter') { e.preventDefault(); rows[0].click(); }
    return;
  }
  if (i < 0) return;
  if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) return go(i + 1);
  if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) return i === 0 ? (e.preventDefault(), $('findQ').focus()) : go(i - 1);
  if (e.key === 'Home') return go(0);
  if (e.key === 'End') return go(rows.length - 1);
});

/* ---------- zoom and layout ---------- */

function fitZoom(mode) {   // sized so that the widest / tallest page fits, so mixed page sizes never scroll sideways
  const dims = pages.map(p => viewportOf(p, CSS_PER_PT));
  const widest = list => Math.max(0, ...list.map(v => v.width));
  const w = spread
    ? widest(dims.filter((_, i) => i % 2 === 0)) + (dims.length > 1 ? GAP + widest(dims.filter((_, i) => i % 2)) : 0)
    : widest(dims);
  const h = Math.max(...dims.map(v => v.height));
  const W = document.documentElement.clientWidth - 2 * 12 - 2, H = innerHeight - header.offsetHeight - 2 * GAP;
  return mode === 'page' ? Math.min(W / w, H / h) : mode === 'width' ? W / w : Math.min(W / w, 1.25);
}

function keepPlace(fn, toTop) {   // keep the same spot of the same page under the toolbar while fn() changes things
  const top = header.getBoundingClientRect().bottom;
  const a = pages.find(p => p.div.getBoundingClientRect().bottom > top + 1) ?? pages[0];
  const idx = pages.indexOf(a), r = a?.div.getBoundingClientRect();
  const frac = r && !toTop ? Math.max(0, (top - r.top) / r.height) : 0;
  fn();
  const b = pages.includes(a) ? a : pages[Math.min(idx, pages.length - 1)];
  if (!b) return;
  const r2 = b.div.getBoundingClientRect();
  scrollBy(0, r2.top + frac * r2.height - top - (frac ? 0 : GAP));
}

// mode: 'width' | 'page' | 'auto' keep fitting on resize; null is a fixed zoom.
// While the window is being resized (lazy), pages are only re-rendered once it stops.
function setZoom(z, mode = null, lazy = false, quiet = false) {   // quiet: this file's own zoom, not a new default
  if (!pages.length) return;
  keepPlace(() => {
    fit = mode;
    zoom = clamp(z, 0.1, 5);
    pages.forEach(size);
  }, mode === 'page' && !lazy);
  settle(lazy ? 250 : 0);
  if (!quiet) store.set('fit', mode ?? 'auto');
  syncZoomUi();
  notePlace();
}

/* ---------- remembering where you were ---------- */

// Each file (known by its fingerprint, so it's recognised wherever it's opened from) remembers the page you were on,
// how far down it, and the zoom. Opening it again lands you there. The last 300 files are remembered, in the
// extension's own storage on this computer. A link to a page (…pdf#page=12) still goes to that page.
const PLACES = 300;
let placeTimer = 0, placing = false;

function notePlace() {
  if (placing || !pages.length) return;
  clearTimeout(placeTimer);
  placeTimer = setTimeout(savePlace, 400);
}

function savePlace() {
  clearTimeout(placeTimer);
  const fp = docs.get('main')?.pdf.fingerprints?.[0];
  if (!fp || !pages.length || placing) return;
  const top = header.getBoundingClientRect().bottom;
  const p = pages.find(p => p.div.getBoundingClientRect().bottom > top + 1) ?? pages[0];
  const r = p.div.getBoundingClientRect();
  const at = {
    k: pages.indexOf(p), i: p.e.doc === 'main' ? p.e.i : null, frac: +clamp((top - r.top) / r.height, 0, 1).toFixed(4),
    zoom: +zoom.toFixed(4), fit, t: Date.now(),
  };
  const all = store.get('places', {});
  delete all[fp];
  const keep = Object.entries(all).sort((a, b) => a[1].t - b[1].t).slice(-(PLACES - 1));
  store.set('places', Object.fromEntries([...keep, [fp, at]]));
}

// -> the page number it went back to, or false when there's nothing to go back to.
function restorePlace(main) {
  const link = /(?:^#|&)page=(\d+)/.exec(location.hash);
  const at = store.get('places', {})[main.pdf.fingerprints?.[0]];
  if (!at && !link) return false;
  placing = true;
  try {
    if (at) setZoom(at.fit ? fitZoom(at.fit) : at.zoom, at.fit ?? null, false, true);
    else setZoom(fitZoom(fit ?? 'auto'), fit);
    let k = link ? +link[1] - 1 : at.i != null ? pages.findIndex(p => p.e.doc === 'main' && p.e.i === at.i) : at.k;
    if (k < 0 || k >= pages.length) k = clamp(link ? k : at.k, 0, pages.length - 1);
    const frac = link ? 0 : at.frac;
    const r = pages[k].div.getBoundingClientRect(), top = header.getBoundingClientRect().bottom;
    scrollBy(0, r.top + frac * r.height - top - (frac ? 0 : GAP));
    showPage(k);
    return link ? 0 : k + 1;   // (no "welcome back" for a link to a page)
  } finally { placing = false; }
}
addEventListener('pagehide', savePlace);
document.addEventListener('visibilitychange', () => { if (document.hidden && placeTimer) savePlace(); });

// The zoom control: − [ 125% ⌄ ] + in the toolbar, and a card with the fit modes, a dial and presets.
const Z_MIN = 0.25, Z_MAX = 5, zToRange = z => Math.round(1000 * Math.log(z / Z_MIN) / Math.log(Z_MAX / Z_MIN));
const rangeToZ = v => Z_MIN * (Z_MAX / Z_MIN) ** (v / 1000);
function syncZoomUi() {
  const pct = Math.round(zoom * 100);
  $('zoomVal').textContent = pct + '%';
  $('zoomMode').textContent = fit === 'width' ? 'Width' : fit === 'page' ? 'Page' : '';
  $('zoom').dataset.fit = fit === 'width' || fit === 'page' ? fit : '';
  $('zoomBig').firstChild.textContent = pct;
  const r = $('zoomRange');
  if (document.activeElement !== r) r.value = zToRange(clamp(zoom, Z_MIN, Z_MAX));
  r.style.setProperty('--at', r.value / 10 + '%');
  for (const b of $('zoomPop').querySelectorAll('[data-fit]')) b.setAttribute('aria-pressed', fit === b.dataset.fit);
  for (const b of $('zoomPop').querySelectorAll('[data-z]')) b.setAttribute('aria-pressed', !fit?.match(/width|page/) && Math.abs(+b.dataset.z - zoom) < 1e-3);
}
function buildZoomPop() {
  const chips = $('zoomPop').querySelector('.chips'), ticks = $('zoomPop').querySelector('.ticks');
  for (const z of ZOOMS) {
    const b = document.createElement('button');
    Object.assign(b.dataset, { z });
    b.setAttribute('aria-pressed', 'false');
    if (z === 1) b.title = 'Actual size (Ctrl+0)';
    b.textContent = Math.round(z * 100) + '%';
    b.onclick = () => setZoom(z);
    chips.append(b);
    const t = document.createElement('i');
    t.style.left = zToRange(z) / 10 + '%';
    if (z === 1) t.className = 'one';
    ticks.append(t);
  }
  for (const b of $('zoomPop').querySelectorAll('[data-fit]')) b.onclick = () => setZoom(fitZoom(b.dataset.fit), b.dataset.fit);
  const r = $('zoomRange');
  r.oninput = () => {
    let z = rangeToZ(+r.value);
    const near = ZOOMS.find(v => Math.abs(zToRange(v) - +r.value) < 12);   // a little snap to the presets
    if (near) z = near;
    setZoom(z, null, true);
  };
  r.onchange = () => { r.blur(); syncZoomUi(); };
  const pop = $('zoomPop');
  pop.addEventListener('beforetoggle', e => {
    $('zoom').setAttribute('aria-expanded', e.newState === 'open');
    if (e.newState !== 'open') return;
    const a = $('zoom').parentElement.getBoundingClientRect();
    pop.style.top = a.bottom + 8 + 'px';
    pop.style.left = clamp(a.left + a.width / 2 - 152, 8, innerWidth - 312) + 'px';
    syncZoomUi();
  });
}

function relayout() {   // after pages were added, removed, rotated or cropped
  const live = new Set(entries.map(e => e.id));
  if (cropping && !live.has(cropping.p.id)) endCrop();
  if (sel && !live.has(sel.page)) sel = null;
  keepPlace(() => {
    layoutPages();
    if (fit) zoom = fitZoom(fit);
    pages.forEach(size);
  });
  settle();
  syncControls();
}

function step(dir) {
  setZoom(dir > 0
    ? ZOOMS.find(v => v > zoom + 1e-3) ?? zoom * 1.25
    : ZOOMS.findLast(v => v < zoom - 1e-3) ?? zoom / 1.25);
}

function setSpread(on) {
  spread = on;
  store.set('spread', on);
  $('pages').classList.toggle('spread', on);
  $('spread').setAttribute('aria-pressed', on);
  setZoom(fit ? fitZoom(fit) : zoom, fit);
}

const targetIndex = () => (hovered && pages.includes(hovered) ? pages.indexOf(hovered) : currentIndex());

function currentIndex() {   // the page taking up most of the window
  let best = 0, area = -1;
  pages.forEach((p, k) => {
    const r = p.div.getBoundingClientRect();
    const a = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, header.getBoundingClientRect().bottom))
      * Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
    if (a > area) { area = a; best = k; }
  });
  return best;
}

/* ---------- page operations ---------- */

function changePages(fn) {
  const before = snapshot();
  if (fn() === false) return false;
  commit(before);
  relayout();
  return true;
}

function rotatePages(ids, delta) {
  return changePages(() => entries.forEach(e => { if (ids.has(e.id)) e.rot = (e.rot + delta + 360) % 360; }));
}

function deletePages(ids) {
  if (entries.every(e => ids.has(e.id))) { say('A PDF needs at least one page, so the last one can’t be deleted.'); return false; }
  const n = entries.filter(e => ids.has(e.id)).length;
  const done = changePages(() => { entries = entries.filter(e => !ids.has(e.id)); });
  if (done) {
    const what = n === 1 ? 'Page deleted.' : `${n} pages deleted.`;
    say(firstTime('tip-delete') ? `${what} It’s only left out of copies you save; your original file isn’t changed.` : what,
      { action: { label: 'Undo', fn: undo }, long: true });
  }
  return done;
}

async function addNote(after = currentIndex(), given = null) {
  if (!pages.length) return;
  const md = given ?? await noteSource(after);
  if (!md?.trim()) return;
  say('Adding note…', true);
  // As wide as the page it follows; as tall as the note needs.
  const ref = pages[after], { width, height } = viewportOf(ref, 1);
  const key = 'note' + nextId++;
  const doc = await loadDoc(key, await notePdf(md, Math.round(width), Math.round(height), { fit: true }));
  const added = doc.pages.map((_, i) => ({ id: nextId++, doc: key, i, rot: 0 }));
  changePages(() => { entries.splice(after + 1, 0, ...added); });
  doc.pages.forEach((_, i) => textLayer(views.get(added[i].id)));
  views.get(added[0].id).div.scrollIntoView({ block: 'start' });
  say(added.length > 1 ? `Added a ${added.length}-page note after page ${after + 1}.` : `Added a note after page ${after + 1}.`,
    { action: { label: 'Undo', fn: undo } });
}

// Type a note. (Markdown you've copied goes in with Magic paste, Ctrl+V.)
async function noteSource(after) {
  const ta = el2('textarea', {
    class: 'notetext', rows: '9', spellcheck: 'true', 'aria-label': 'Your note',
    placeholder: '# A heading\n\nSome **bold** text, a list:\n- one\n- two\n\nand math, like $E = mc^2$.',
  });
  const update = () => { $('dlgOk').disabled = !ta.value.trim(); };
  ta.addEventListener('input', update);
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !$('dlgOk').disabled) { e.preventDefault(); $('dlgOk').click(); } });
  const body = [
    el2('p', {}, 'Markdown and LaTeX math ($…$) work here. Ctrl+Enter adds it. To use something you copied, press Ctrl+V for Magic paste instead.'),
    ta,
  ];
  const answer = ask({ title: `Add a note after page ${after + 1}`, body, ok: 'Add note', wide: true });
  update();
  ta.focus();
  const ok = await answer;
  $('dlgOk').disabled = false;
  return ok ? ta.value : null;
}

// "2-4, 7, 10-end" -> [{ label: '2-4', idx: [1, 2, 3] }, { label: '7', idx: [6] }, …]
function parseRanges(text, n) {
  const groups = [];
  for (const raw of text.split(/[,;]/)) {
    const t = raw.trim().toLowerCase();
    if (!t) continue;
    const mt = t.match(/^(\d+|end|last)?\s*(?:(-|–|—|to)\s*(\d+|end|last)?)?$/);
    if (!mt || (!mt[1] && !mt[2])) throw new Error(`“${raw.trim()}” isn’t a page or a range.`);
    const num = s => (s === undefined ? undefined : /^(end|last)$/.test(s) ? n : +s);
    const a = num(mt[1]) ?? 1, b = mt[2] ? num(mt[3]) ?? n : a;
    if (a < 1 || b > n || a > b) throw new Error(`“${raw.trim()}” is outside pages 1–${n}.`);
    groups.push({ label: a === b ? `${a}` : `${a}-${b}`, idx: Array.from({ length: b - a + 1 }, (_, k) => a - 1 + k) });
  }
  if (!groups.length) throw new Error('Type the pages first: a page like 3, a range like 5-7, or several, like 3, 5-7, 10-end.');
  return groups;
}

function rangeIds() {
  try {
    const ids = new Set(parseRanges($('range').value, entries.length).flatMap(g => g.idx).map(k => entries[k].id));
    $('panelMsg').textContent = '';
    return ids;
  } catch (e) {
    $('panelMsg').textContent = e.message;
    return null;
  }
}

// Split: each range as a file of its own (mode 'separate'), or all of them, in the order typed, as one PDF ('one').
async function split(mode = 'separate') {
  let groups;
  try { groups = parseRanges($('splitRanges').value, entries.length); $('panelMsg').textContent = ''; }
  catch (e) { $('panelMsg').textContent = e.message; return; }
  finishEdit();
  const base = name.replace(/\.pdf$/i, '');
  const one = mode === 'one';
  let label = groups.map(g => g.label).join(', ');
  if (label.length > 60) label = label.slice(0, 57).replace(/,?\s*[^,]*$/, '') + ' …';
  const parts = one
    ? [{ g: { idx: groups.flatMap(g => g.idx) }, file: `${base} (${/^\d+$/.test(label) ? 'page' : 'pages'} ${label}).pdf` }]   // every range, in order, in one file
    : groups.map(g => ({ g, file: `${base} (${/^\d+$/.test(g.label) ? 'page' : 'pages'} ${g.label}).pdf` }));
  $('panel').hidePopover();
  // Each part gets its own save dialog, named and in the same folder as the last one, so it's mostly just Enter.
  // (A folder picker would ask only once, but Chrome won't let a page save straight into Downloads, Documents or
  // the Desktop that way, which is where most PDFs are.)
  const saved = [];
  try {
    for (const [k, part] of parts.entries()) {
      let handle = null;
      if (window.showSaveFilePicker) {
        handle = await pickPart(part.file, k, parts.length, saved.length);
        if (handle === 'stop') break;
      }
      say(one ? 'Saving…' : `Splitting… part ${k + 1} of ${parts.length}`, true);
      const out = await build(part.g.idx.map(i => entries[i]));
      if (handle) {
        const w = await handle.createWritable();
        await w.write(out);
        await w.close();
        saved.push(handle.name);
      } else {
        download(out, part.file);
        saved.push(part.file);
      }
    }
    if (!saved.length) return say(one ? 'Cancelled.' : 'Split cancelled.');
    if (one) return say(`Saved “${saved[0]}”: ${parts[0].g.idx.length} page${parts[0].g.idx.length === 1 ? '' : 's'} from ${groups.length} range${groups.length === 1 ? '' : 's'}.`);
    say(saved.length === parts.length
      ? `Saved ${saved.length} files: ${saved.map(f => `“${f}”`).join(', ')}.`
      : `Saved ${saved.length} of ${parts.length} parts: ${saved.map(f => `“${f}”`).join(', ')}.`, { long: true });
  } catch (e) {
    say(/encrypt/i.test(e.message) ? 'This PDF is encrypted, so it cannot be split.' : 'Could not split: ' + e.message, true);
  }
}

// The save dialog for one part. Chrome only opens one shortly after a click, so when the moment has passed, a button
// asks for the click that opens the next one. -> a file handle, or 'stop' if the dialog was cancelled.
async function pickPart(file, k, n, done) {
  const opts = { suggestedName: file, id: folderId(), types: [{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }] };
  const ask = () => showSaveFilePicker(opts).catch(e => (e.name === 'AbortError' ? 'stop' : Promise.reject(e)));
  try { return await ask(); }
  catch {
    return new Promise(resolve => {
      say(`${done ? `Saved ${done} of ${n}. ` : ''}Next: part ${k + 1} of ${n}.`, {
        sticky: true,
        action: { label: `Save part ${k + 1}`, fn: () => ask().then(resolve, () => resolve('stop')) },
      });
    });
  }
}

/* ---------- annotations on screen ---------- */

function view(p, [x1, y1, x2, y2]) {   // a PDF box in on-screen pixels (handles rotated pages too)
  const [a, b] = p.vp.convertToViewportPoint(x1, y1), [c, d] = p.vp.convertToViewportPoint(x2, y2);
  return { x: Math.min(a, c), y: Math.min(b, d), w: Math.abs(c - a), h: Math.abs(d - b) };
}

function el(tag, attrs) {
  const node = document.createElementNS(NS, tag);
  for (const k in attrs) node.setAttribute(k, attrs[k]);
  return node;
}

function paint(p) {
  const under = [], over = [];
  shapes.forEach((s, i) => {
    if (s.page !== p.id) return;
    if (s.type === 'highlight') {
      for (const r of s.rects) {
        const v = view(p, r);
        under.push(el('rect', { x: v.x, y: v.y, width: v.w, height: v.h, fill: s.color, class: s === eraseHover ? 'erasing' : '' }));
        if (s === sel) over.push(el('rect', { class: 'outline', x: v.x - 2, y: v.y - 2, width: v.w + 4, height: v.h + 4 }));
      }
      return;
    }
    if (s.type === 'text') return paintText(p, s, i, over);
    if (s.type === 'image') return paintImage(p, s, i, over);
    const v = view(p, [s.x1, s.y1, s.x2, s.y2]), w = s.width * p.vp.scale;
    const [tag, geo] = s.type === 'rect'
      ? ['rect', { x: v.x, y: v.y, width: v.w, height: v.h }]
      : ['ellipse', { cx: v.x + v.w / 2, cy: v.y + v.h / 2, rx: v.w / 2, ry: v.h / 2 }];
    over.push(el(tag, { ...geo, class: s === eraseHover ? 'shape erasing' : 'shape', fill: s.fill ? s.color : 'none', stroke: s.color, 'stroke-width': w }));
    over.push(el(tag, { ...geo, class: s.fill ? 'hit filled' : 'hit', 'data-i': i, 'stroke-width': Math.max(w, 10) }));   // easier to grab
    if (s === sel) grips(v, over);
  });
  p.hl.replaceChildren(...under);
  p.svg.replaceChildren(...over);
  if (editing?.p === p) placeEditor();
}

// The selection frame and its four corner handles (0 top-left, 1 top-right, 2 bottom-left, 3 bottom-right).
function grips(v, over) {
  over.push(el('rect', { class: 'outline', x: v.x, y: v.y, width: v.w, height: v.h }));
  for (let h = 0; h < 4; h++) {
    over.push(el('rect', {
      class: 'handle', 'data-h': h, width: 9, height: 9,
      x: v.x + (h % 2) * v.w - 4.5, y: v.y + (h >> 1) * v.h - 4.5,
      style: `cursor:${h % 3 ? 'nesw' : 'nwse'}-resize`,
    }));
  }
}

function paintImage(p, s, i, over) {
  const im = imgs.get(s.img);
  if (!im) return;
  const [ax, ay] = p.vp.convertToViewportPoint(s.x1, s.y2);   // its top-left corner, turned with the page
  const g = el('g', { class: s === eraseHover ? 'image erasing' : 'image', transform: `translate(${ax} ${ay}) rotate(${rotationOf(p)}) scale(${p.vp.scale})` });
  g.append(el('image', { href: im.src, width: s.x2 - s.x1, height: s.y2 - s.y1, preserveAspectRatio: 'none' }));
  over.push(g);
  const v = view(p, [s.x1, s.y1, s.x2, s.y2]);
  over.push(el('rect', { class: 'hit ihit', 'data-i': i, x: v.x, y: v.y, width: v.w, height: v.h }));
  if (s === sel) grips(v, over);
}

/* ---------- images ---------- */

const dataBytes = src => Uint8Array.from(atob(src.slice(src.indexOf(',') + 1)), c => c.charCodeAt(0));

// Any picture -> a PNG or JPEG (what PDFs can hold), at most 4,000 px on its longer side.
async function prepImage(src) {
  const img = new Image();
  img.src = src;
  await img.decode();
  let { naturalWidth: w, naturalHeight: h } = img;
  const mime = src.slice(5, src.indexOf(';'));
  const k = Math.min(1, 4000 / Math.max(w, h));
  if ((mime === 'image/png' || mime === 'image/jpeg') && k === 1) return { src, w, h, mime };
  w = Math.max(1, Math.round(w * k));
  h = Math.max(1, Math.round(h * k));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  const out = mime === 'image/jpeg' ? c.toDataURL('image/jpeg', 0.9) : c.toDataURL('image/png');
  return { src: out, w, h, mime: mime === 'image/jpeg' ? 'image/jpeg' : 'image/png' };
}

// Add an image from the computer. (A copied picture goes in with Magic paste, Ctrl+V.)
function addImage(at = targetIndex()) {
  if (!pages.length) return;
  const pick = $('imgFile');
  pick.value = '';
  pick.onchange = () => {
    const f = pick.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => chooseImage(rd.result, Math.min(at, pages.length - 1));
    rd.onerror = () => say('That file couldn’t be read.');
    rd.readAsDataURL(f);
  };
  pick.click();
}

// A picture can go onto the page, where it can be moved and resized like a shape, or onto a new page of its own
// after it, as wide as that page and as tall as the picture needs (like a note).
function imageActions(src, at) {
  return [
    [`Add to page ${at + 1}`, () => placeImage(pages[at], src)],
    [`Add as a new page after page ${at + 1}`, () => imagePage(at, src)],
  ];
}

function chooseImage(src, at) {
  const box = $('magic');
  const preview = Object.assign(el2('img', { alt: 'The picture you chose' }), { src });
  box.dataset.card = 'image';
  showCard(box, $('addImage'), 'Add an image', 'Where should it go?', preview, imageActions(src, at));
}

// The small card under a toolbar button, with a preview and a column of choices (Magic paste, Add image).
function showCard(box, anchor, title, kind, preview, acts) {
  const buttons = acts.map(([label, fn], i) => {
    const b = el2('button', { type: 'button', class: i ? '' : 'primary' }, label);
    b.onclick = () => { box.hidePopover(); fn(); };
    return b;
  });
  box.replaceChildren(el2('h2', { id: 'magicTitle' }, title), el2('p', { class: 'kind' }, kind), ...(preview ? [preview] : []), el2('div', { class: 'acts' }, ...buttons));
  if (!box.matches(':popover-open')) box.showPopover();
  const r = anchor.getBoundingClientRect();
  box.style.top = r.bottom + 8 + 'px';
  box.style.left = Math.max(12, Math.min(r.left, innerWidth - box.offsetWidth - 12)) + 'px';
  buttons[0]?.focus();
}

async function imagePage(after, src) {
  let im;
  try { im = await prepImage(src); } catch { return say('That file couldn’t be read as a picture.'); }
  const ref = pages[after], { width } = viewportOf(ref, 1);
  let W = Math.round(width), H = Math.max(1, Math.round(W * im.h / im.w));
  const MAXH = 14400;   // the tallest page PDF allows; a very long picture is narrowed to fit, in the middle
  const w = H > MAXH ? W * MAXH / H : W;
  H = Math.min(H, MAXH);
  const { PDFDocument } = await lib();
  const d = await PDFDocument.create();
  const pic = im.mime === 'image/jpeg' ? await d.embedJpg(dataBytes(im.src)) : await d.embedPng(dataBytes(im.src));
  d.addPage([W, H]).drawImage(pic, { x: (W - w) / 2, y: 0, width: w, height: H });
  const key = 'pic' + nextId++;
  await loadDoc(key, await d.save());
  const added = { id: nextId++, doc: key, i: 0, rot: 0 };
  changePages(() => { entries.splice(after + 1, 0, added); });
  views.get(added.id)?.div.scrollIntoView({ block: 'start' });
  showPage();
  say(`Added the image as a new page after page ${after + 1}.`, { action: { label: 'Undo', fn: undo } });
}

// Put it in the middle of the part of the page in view, scaled down to fit the page if it's big.
async function placeImage(p, src) {
  let im;
  try { im = await prepImage(src); } catch { return say('That file couldn’t be read as a picture.'); }
  const key = 'img' + nextImg++;
  imgs.set(key, im);
  const [x0, y0, x1, y1] = p.page.view, PW = x1 - x0, PH = y1 - y0;
  const k = Math.min(1, (PW * 0.8) / (im.w * 0.75), (PH * 0.8) / (im.h * 0.75));   // 1 px = 0.75 pt at 96 dpi
  const W = im.w * 0.75 * k, H = im.h * 0.75 * k;
  const r = p.div.getBoundingClientRect();
  const sx = (Math.max(r.left, 0) + Math.min(r.right, innerWidth)) / 2 - r.left;
  const sy = (Math.max(r.top, 60) + Math.min(r.bottom, innerHeight)) / 2 - r.top;
  let [cx, cy] = p.vp.convertToPdfPoint(sx, sy);
  cx = clamp(cx, x0 + W / 2, x1 - W / 2);
  cy = clamp(cy, y0 + H / 2, y1 - H / 2);
  commit(snapshot());
  const s = { page: p.id, type: 'image', x1: cx - W / 2, y1: cy - H / 2, x2: cx + W / 2, y2: cy + H / 2, img: key };
  shapes.push(s);
  setTool('select');
  select(s);
  say('Image added. Drag it to move it, drag a corner to resize it, or press Del to remove it.');
}

// The pictures inside Inkfold's saved image stamps, so they can be moved and resized again.
async function readStamps(bytes, stamps) {
  const { PDFDocument, PDFRef, PDFName, PDFDict, decodePDFRawStream } = await lib();
  const N = PDFName.of;
  let ctx;
  try { ctx = (await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true })).context; } catch { ctx = null; }
  for (const { s, id } of stamps) {
    try {
      const m = /^(\d+)R(\d*)$/.exec(id);
      const look = ctx.lookup(PDFRef.of(+m[1], +(m[2] || 0)), PDFDict).lookup(N('AP'), PDFDict).lookup(N('N'));
      const xo = look.dict.lookup(N('Resources'), PDFDict).lookup(N('XObject'), PDFDict);
      const pic = xo.lookup(xo.keys()[0]), d = pic.dict;
      const w = d.lookup(N('Width')).asNumber(), h = d.lookup(N('Height')).asNumber(), filter = String(d.lookup(N('Filter')));
      let src;
      if (filter === '/DCTDecode') src = 'data:image/jpeg;base64,' + b64(pic.contents);
      else {   // pdf-lib stores PNGs as raw colour plus a separate alpha mask
        const raw = decodePDFRawStream(pic).decode(), n = raw.length / (w * h);
        const mask = d.lookup(N('SMask'));
        const alpha = mask ? decodePDFRawStream(mask).decode() : null;
        const rgba = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < w * h; i++) {
          rgba[i * 4] = raw[i * n]; rgba[i * 4 + 1] = raw[i * n + (n >= 3 ? 1 : 0)]; rgba[i * 4 + 2] = raw[i * n + (n >= 3 ? 2 : 0)];
          rgba[i * 4 + 3] = alpha ? alpha[i] : 255;
        }
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        c.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
        src = c.toDataURL('image/png');
      }
      const key = 'img' + nextImg++;
      imgs.set(key, { src, w, h, mime: filter === '/DCTDecode' ? 'image/jpeg' : 'image/png' });
      s.img = key;
    } catch { s.img = null; }
  }
  // A stamp that couldn't be read stays in the file as it was (pdf.js draws it), but isn't editable.
  for (const { s, id } of stamps) {
    if (s.img) continue;
    shapes.splice(shapes.indexOf(s), 1);
    docs.get('main').pdf.annotationStorage.setValue(id, { noView: false });
  }
}

function b64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/* ---------- magic paste ---------- */

// Markdown or just text? A couple of Markdown signs (a heading, a table, code, a checklist,
// or several lighter ones like lists, bold and links) make it Markdown.
function looksLikeMarkdown(t) {
  let score = 0;
  if (/^#{1,6}\s+\S/m.test(t)) score += 2;
  if (/^```/m.test(t)) score += 2;
  if (/^\s*\|.*\|\s*$/m.test(t) && /^\s*\|?\s*:?-{3,}/m.test(t)) score += 2;
  if (/^\s*[-*+] \[[ xX]\]\s/m.test(t)) score += 2;
  if (/^\s*([-*+]|\d+[.)])\s+\S/m.test(t) && t.includes('\n')) score += 1;
  if (/\*\*[^*\n]+\*\*|__[^_\n]+__/.test(t)) score += 1;
  if (/\[[^\]\n]+\]\([^)\s]+\)/.test(t)) score += 1;
  if (/^>\s/m.test(t)) score += 1;
  if (/\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\begin\{/.test(t)) score += 1;
  return score >= 2;
}

// Looks at the clipboard and offers what fits: a picture goes on this page, Markdown becomes a note
// after it, plain text becomes a text box on it.
async function magicPaste() {
  if (!pages.length) return;
  const box = $('magic'), at = targetIndex(), p = pages[at];
  if (box.matches(':popover-open') && box.dataset.card === 'magic') return box.hidePopover();
  box.dataset.card = 'magic';
  box.replaceChildren(el2('p', { class: 'kind' }, 'Looking at your clipboard…'));
  box.showPopover();
  const r = $('magicBtn').getBoundingClientRect();
  box.style.top = r.bottom + 8 + 'px';
  box.style.left = Math.max(12, Math.min(r.left, innerWidth - box.offsetWidth - 12)) + 'px';
  const [img, text] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'readClipboardImage' }).catch(() => null),
    chrome.runtime.sendMessage({ type: 'readClipboard' }).catch(() => null),
  ]);
  const t = lines(text ?? '').replace(/^\n+|\s+$/g, '');
  const md = !!t && looksLikeMarkdown(t);
  const go = fn => () => { box.hidePopover(); fn(); };
  const acts = [];
  if (img) acts.push(...imageActions(img, at).map(([label, fn]) => [label, go(fn)]));
  if (t) {
    const note = [`Add as a note after page ${at + 1}`, go(() => addNote(at, t))];
    const tb = [`Add as a text box on page ${at + 1}`, go(() => pasteTextBox(p, t))];
    acts.push(...(md ? [note, tb] : [tb, note]));
  }
  const kind = img ? 'A picture' : md ? 'Markdown' : t ? 'Text' : '';
  if (!acts.length) {
    box.replaceChildren(el2('h2', { id: 'magicTitle' }, 'Nothing to paste'),
      el2('p', { class: 'kind' }, 'Your clipboard is empty. Copy a picture, some Markdown or some text, then try again.'));
    return;
  }
  const preview = img ? Object.assign(el2('img', { alt: 'The picture on your clipboard' }), { src: img })
    : el2('div', { class: 'snippet' }, t.slice(0, 400));
  const buttons = acts.map(([label, fn], i) => { const b = el2('button', { type: 'button', class: i ? '' : 'primary' }, label); b.onclick = fn; return b; });
  box.replaceChildren(
    el2('h2', { id: 'magicTitle' }, 'Magic paste'),
    el2('p', { class: 'kind' }, `${kind} on your clipboard${img && t ? ' (and some text)' : ''}`),
    preview, el2('div', { class: 'acts' }, ...buttons));
  buttons[0].focus();
}

// Plain text as a text box, wrapped to about 60% of the page's width, in the middle of what's in view.
async function pasteTextBox(p, t) {
  const [x0, y0, x1, y1] = p.page.view;
  const text = await wrapText(t, textSize, (x1 - x0) * 0.6);
  const L = await layout(text, textSize);
  const r = p.div.getBoundingClientRect();
  const sx = (Math.max(r.left, 0) + Math.min(r.right, innerWidth)) / 2 - r.left;
  const sy = (Math.max(r.top, 60) + Math.min(r.bottom, innerHeight)) / 2 - r.top;
  let [cx, cy] = p.vp.convertToPdfPoint(sx, sy);
  const left = clamp(cx - L.w / 2, x0, Math.max(x0, x1 - L.w)), top = clamp(cy + L.h / 2, Math.min(y1, y0 + L.h), y1);
  commit(snapshot());
  const s = { page: p.id, type: 'text', x1: left, y1: top, x2: left, y2: top, text, size: textSize, color: colors.text };
  shapes.push(s);
  setTool('select');
  select(s);
  say('Added the copied text as a text box. Drag it to move it; double-click it to edit.');
}

/* ---------- eraser ---------- */

// Does the eraser at (x, y), PDF points, touch this annotation? Outlined shapes are caught by their outline,
// filled shapes, highlights and text boxes anywhere inside.
function touches(s, x, y, tol) {
  const inBox = ([a, b, c, d], m) => x >= a - m && x <= c + m && y >= b - m && y <= d + m;
  if (s.type === 'highlight') return s.rects.some(r => inBox(r, tol));
  const box = boxOf(s);
  if (s.type === 'text' || s.type === 'image') return inBox(box, tol);
  const m = (s.width || 1) / 2 + tol, [a, b, c, d] = box;
  if (s.fill && s.type === 'rect') return inBox(box, m);
  if (s.fill) { const cx = (a + c) / 2, cy = (b + d) / 2; return Math.hypot((x - cx) / Math.max((c - a) / 2 + m, 1e-3), (y - cy) / Math.max((d - b) / 2 + m, 1e-3)) <= 1; }
  if (s.type === 'rect') return inBox(box, m) && !(x > a + m && x < c - m && y > b + m && y < d - m);
  const cx = (a + c) / 2, cy = (b + d) / 2, rx = Math.max((c - a) / 2, 1e-3), ry = Math.max((d - b) / 2, 1e-3);
  return Math.abs(Math.hypot((x - cx) / rx, (y - cy) / ry) - 1) * Math.min(rx, ry) <= m;
}

const underEraser = (e, p) => {
  const [x, y] = point(e, p), tol = 6 / p.vp.scale;   // a few pixels of slack, whatever the zoom
  return shapes.findLast(s => s.page === p.id && touches(s, x, y, tol)) ?? null;
};

// A click removes only the topmost thing under the pointer; dragging removes everything it passes over.
function eraseAt(e, p, all = false) {
  const [x, y] = point(e, p), tol = 6 / p.vp.scale, top = underEraser(e, p);
  const hit = all ? shapes.filter(s => s.page === p.id && touches(s, x, y, tol)) : top ? [top] : [];
  if (!hit.length) return;
  for (const s of hit) shapes.splice(shapes.indexOf(s), 1);
  if (hit.includes(sel)) sel = null;
  eraseHover = null;
  paint(p);
}

function hoverErase(s, p) {   // fade what the eraser would remove
  if (s === eraseHover) return;
  eraseHover = s;
  paint(p);
}

/* ---------- text boxes ---------- */

const ready = L => L && !(L instanceof Promise);
// A text box's corners in PDF points, from its top-left corner and laid-out size.
function boxOf(s) {
  if (s.type !== 'text') return [s.x1, s.y1, s.x2, s.y2];
  const L = cached(s.text, s.size), w = ready(L) ? L.w : 0, h = ready(L) ? L.h : 0;
  return [s.x1, s.y2 - h, s.x1 + w, s.y2];
}

function paintText(p, s, i, over) {
  if (s === editing?.s) return;   // the editor stands in for it
  const L = layout(s.text, s.size);
  if (!ready(L)) { L.then(() => paint(p), () => {}); return; }
  const [ax, ay] = p.vp.convertToViewportPoint(s.x1, s.y2);
  const g = el('g', { class: s === eraseHover ? 'text erasing' : 'text', transform: `translate(${ax} ${ay}) rotate(${rotationOf(p)}) scale(${p.vp.scale})` });
  g.innerHTML = svgOf(L, s.color);
  over.push(g);
  const v = view(p, boxOf(s));
  over.push(el('rect', { class: 'hit thit', 'data-i': i, x: v.x, y: v.y, width: v.w, height: v.h }));
  if (s === sel) over.push(el('rect', { class: 'outline', x: v.x - 2, y: v.y - 2, width: v.w + 4, height: v.h + 4 }));
}

// Typing into a text box: a plain text field over the box, showing the source ($…$ for math).
function editText(p, s, fresh = false) {
  finishEdit();
  const before = snapshot();
  if (fresh) shapes.push(s);
  sel = s;
  const ta = document.createElement('textarea');
  ta.className = 'tedit';
  ta.value = s.text;
  ta.spellcheck = false;
  ta.placeholder = 'Type here. $x^2$ for math';
  ta.setAttribute('aria-label', 'Text box. Put LaTeX between $ signs, like $x^2$. Press Esc or click outside to finish.');
  ta.addEventListener('keydown', e => {
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); e.stopPropagation(); finishEdit(); }
  });
  ta.addEventListener('blur', () => finishEdit());
  if (!CSS.supports('field-sizing', 'content')) {   // older Chrome: grow the box with its text by hand
    const fit = () => { ta.style.height = 'auto'; ta.style.width = 'auto'; ta.style.height = ta.scrollHeight + 'px'; ta.style.width = Math.max(ta.scrollWidth, 40) + 'px'; };
    ta.addEventListener('input', fit);
    requestAnimationFrame(fit);
  }
  ta.addEventListener('paste', e => {   // put copied text in as lines, whatever the source used to break them
    const d = e.clipboardData;
    let t = d?.getData('text/plain');
    if (!t && d?.getData('text/html')) {
      const div = document.createElement('div');
      div.innerHTML = d.getData('text/html');
      div.style.cssText = 'position:fixed;left:-9999px;white-space:normal';
      document.body.append(div);
      t = div.innerText;
      div.remove();
    }
    if (!t) return;
    e.preventDefault();
    // Long lines are wrapped to fit the page from where the box starts (as Magic paste does), keeping the
    // lines it already had and never breaking a formula.
    const [, , x1] = p.page.view, room = Math.max((x1 - p.page.view[0]) * 0.4, x1 - s.x1 - 18);
    const at = [ta.selectionStart, ta.selectionEnd];
    wrapText(lines(t), s.size, room).catch(() => lines(t)).then(w => {
      if (editing?.ta !== ta) return;
      ta.setRangeText(w, at[0], at[1], 'end');
      ta.dispatchEvent(new Event('input'));
    });
  });
  for (const ev of ['pointerdown', 'mousedown', 'dblclick']) ta.addEventListener(ev, e => e.stopPropagation());
  editing = { p, s, before, ta, fresh };
  p.div.append(ta);
  syncControls();
  paint(p);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

function placeEditor() {
  const { p, s, ta } = editing, k = p.vp.scale, [ax, ay] = p.vp.convertToViewportPoint(s.x1, s.y2);
  Object.assign(ta.style, {
    left: ax + 'px', top: ay + 'px', fontSize: s.size * k + 'px', padding: PAD * k + 'px', color: s.color,
    transform: `rotate(${rotationOf(p)}deg)`,
  });
}

// \r\n, \r, vertical tabs (Word's line breaks), form feeds and Unicode line/paragraph separators all become \n.
const lines = t => t.replace(/\r\n?|[\v\f\u0085\u2028\u2029]/g, '\n');

function finishEdit() {
  if (!editing) return;
  const { s, before, ta, fresh } = editing;
  editing = null;
  const text = lines(ta.value).replace(/\s+$/, '');
  ta.remove();
  if (text.trim()) s.text = text;
  else {   // an empty box is removed
    const i = shapes.indexOf(s);
    if (i >= 0) shapes.splice(i, 1);
    if (sel === s) sel = null;
  }
  if (snapshot() !== before) commit(before);
  if (fresh && text.trim()) select(s);   // a new box is done: selected, to move or resize
  syncControls();
  repaint();
}

function setTextSize(step) {   // one size larger or smaller
  const cur = sel?.type === 'text' ? sel.size : textSize;
  const i = SIZES.findIndex(v => v >= cur);
  const next = SIZES[clamp((i < 0 ? SIZES.length - 1 : SIZES[i] === cur ? i : step > 0 ? i - 1 : i) + step, 0, SIZES.length - 1)];
  textSize = next;
  store.set('textSize', next);
  if (sel?.type === 'text' && sel.size !== next) {
    if (!editing) commit(snapshot());
    sel.size = next;
    repaint();
  }
  syncControls();
}

const repaint = () => pages.forEach(paint);

function select(s) {
  sel = s;
  syncControls();
  repaint();
}

/* ---------- drawing and editing shapes ---------- */

function point(e, p) {   // pointer position as PDF coordinates, kept inside the page
  const r = p.div.getBoundingClientRect();
  return p.vp.convertToPdfPoint(clamp(e.clientX - r.left, 0, r.width), clamp(e.clientY - r.top, 0, r.height));
}

function down(e, p) {
  if (e.button !== 0) return;
  if (tool === 'eraser') {   // erase what's under the pointer, and anything else the drag passes over
    e.preventDefault();
    erasing = { p, before: snapshot() };
    p.svg.setPointerCapture(e.pointerId);
    return eraseAt(e, p);
  }
  const t = e.target, at = point(e, p), before = snapshot();
  if (t.dataset.h) {                                   // resize: the opposite corner stays put
    const v = view(p, [sel.x1, sel.y1, sel.x2, sel.y2]), k = 3 - t.dataset.h;
    drag = { anchor: p.vp.convertToPdfPoint(v.x + (k % 2) * v.w, v.y + (k >> 1) * v.h), ratio: (sel.x2 - sel.x1) / (sel.y2 - sel.y1) };
  } else if (tool === 'select' && t.dataset.i) {       // move (a second quick press on a text box edits it)
    const s = shapes[t.dataset.i];
    if (s.type === 'text' && lastPress.s === s && e.timeStamp - lastPress.t < 450) {
      e.preventDefault();
      lastPress = {};
      pendingText = { p, s, fresh: false };
      return;
    }
    lastPress = { s, t: e.timeStamp };
    select(s);
    drag = { from: at, orig: { ...sel } };
  } else if (tool === 'text') {                        // type into a box: an existing one, or a new one here
    e.preventDefault();
    const old = shapes[t.dataset.i];
    if (editing && old?.type !== 'text') return finishEdit();   // a click away from the box being typed in just ends it
    const s = old?.type === 'text' ? old : { page: p.id, type: 'text', x1: at[0], y1: at[1], x2: at[0], y2: at[1], text: '', size: textSize, color: colors.text };
    pendingText = { p, s, fresh: s !== old };   // opened on release: the press itself still moves the focus
    return;
  } else if (tool === 'rect' || tool === 'ellipse') {  // draw a new one
    sel = { page: p.id, type: tool, x1: at[0], y1: at[1], x2: at[0], y2: at[1], color: colors.shape, width: lineWidth, ...(fillShapes ? { fill: true } : {}) };
    shapes.push(sel);
    drag = { anchor: at, fresh: true };
  } else return;
  Object.assign(drag, { p, before });
  p.svg.setPointerCapture(e.pointerId);
  repaint();
  e.preventDefault();
}

function move(e) {
  if (erasing) return eraseAt(e, erasing.p, true);
  if (!drag) return;
  let [x, y] = point(e, drag.p);
  if (drag.anchor) {
    const [ax, ay] = drag.anchor;
    if (sel.type === 'image' && !e.shiftKey) {   // images keep their proportions (Shift: stretch freely)
      let w = Math.abs(x - ax), h = Math.abs(y - ay);
      if (w / h > drag.ratio) w = h * drag.ratio; else h = w / drag.ratio;
      if (w < 4) return;
      x = ax + (x < ax ? -w : w);
      y = ay + (y < ay ? -h : h);
    }
    Object.assign(sel, { x1: Math.min(ax, x), y1: Math.min(ay, y), x2: Math.max(ax, x), y2: Math.max(ay, y) });
  } else {
    const dx = x - drag.from[0], dy = y - drag.from[1], o = drag.orig;
    Object.assign(sel, { x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy });
  }
  paint(drag.p);
}

function up() {
  if (pendingText) {
    const { p, s, fresh } = pendingText;
    pendingText = null;
    if (fresh && tool === 'text') {   // a box placed: back to the pointer straight away, while you type into it
      tool = document.body.dataset.tool = 'select';
      for (const b of document.querySelectorAll('button[data-tool]')) b.setAttribute('aria-pressed', b.dataset.tool === 'select');
    }
    setTimeout(() => editText(p, s, fresh));
  }
  if (erasing) {   // one undo step for the whole stroke
    if (snapshot() !== erasing.before) commit(erasing.before);
    erasing = null;
    syncControls();
  }
  if (!drag) return;
  const px = drag.p.vp.scale;
  if (drag.fresh && (sel.x2 - sel.x1) * px < 4 && (sel.y2 - sel.y1) * px < 4) {   // a click, not a drag
    shapes.pop();
    sel = null;
  }
  if (snapshot() !== drag.before) commit(drag.before);
  drag = null;
  syncControls();
  repaint();
}

/* ---------- highlighting text ---------- */

// In select mode, a plain click on a highlight selects it; a drag over it still selects text.
function pressPage(e, p) {
  if (tool === 'highlight' && !e.button && p.textReady && !p.div.querySelector('.textLayer span')) {
    if (p.e.doc === 'main' && ocrBusy.has(p.e.i)) return say('Inkfold is still reading the text on this scanned page. Try again in a moment.');
    p.textReady.then(() => {
      if (!p.div.querySelector('.textLayer span')) say('This page has no selectable text (it may be a scanned image), so it can’t be highlighted. Draw a rectangle (R) instead.', { long: true });
    });
  }
  if (e.button || tool !== 'select' || e.target.closest('.shapes')) return;
  const [x, y] = point(e, p);
  pick = shapes.findLast(s => s.page === p.id && s.type === 'highlight'
    && s.rects.some(([a, b, c, d]) => x >= a && x <= c && y >= b && y <= d)) ?? null;
  if (sel) select(null);
}

function released() {
  document.querySelectorAll('.textLayer.selecting').forEach(d => d.classList.remove('selecting'));
  if (pick && getSelection().isCollapsed) select(pick);
  pick = null;
  if (tool === 'highlight') setTimeout(highlightSelection);
}

function highlightSelection() {
  const s = getSelection();
  if (!s.rangeCount || s.isCollapsed) return;
  const range = s.getRangeAt(0), before = snapshot(), made = [];
  for (const p of pages) {
    const layer = p.div.querySelector('.textLayer');
    if (!layer || !range.intersectsNode(layer)) continue;
    const box = p.div.getBoundingClientRect(), boxes = [];
    const walk = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) {   // measure just the selected part of each piece of text
      const t = walk.currentNode;
      if (!range.intersectsNode(t)) continue;
      const r = document.createRange();
      r.selectNodeContents(t);
      if (range.comparePoint(t, 0) < 0) r.setStart(t, range.startOffset);
      if (range.comparePoint(t, t.length) > 0) r.setEnd(t, range.endOffset);
      for (const c of r.getClientRects()) {
        if (c.width > 0.5 && c.height > 0.5) boxes.push({ l: c.left - box.left, t: c.top - box.top, r: c.right - box.left, b: c.bottom - box.top });
      }
    }
    const rects = mergeLines(boxes).map(m => {
      const [x1, y1] = p.vp.convertToPdfPoint(m.l, m.t), [x2, y2] = p.vp.convertToPdfPoint(m.r, m.b);
      return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
    });
    if (rects.length) made.push({ page: p.id, type: 'highlight', rects, color: colors.highlight });
  }
  s.removeAllRanges();
  if (!made.length) return;
  shapes.push(...made);
  commit(before);
  repaint();
}

function mergeLines(boxes) {   // join word boxes that sit on the same line into one box per line
  const out = [];
  boxes.sort((a, b) => a.t - b.t || a.l - b.l);
  for (const b of boxes) {
    const h = b.b - b.t;
    const m = out.find(o => Math.min(o.b, b.b) - Math.max(o.t, b.t) > 0.5 * Math.min(h, o.b - o.t)
      && b.l <= o.r + h && b.r >= o.l - h);
    if (m) Object.assign(m, { l: Math.min(m.l, b.l), t: Math.min(m.t, b.t), r: Math.max(m.r, b.r), b: Math.max(m.b, b.b) });
    else out.push({ ...b });
  }
  return out;
}

/* ---------- edits ---------- */

function commit(before) {
  history.push(before);
  future = [];
  dirty = true;
  syncUndo();
}

function syncUndo() {   // the buttons are greyed out when there's nothing to undo or redo
  $('undo').disabled = !history.length;
  $('redo').disabled = !future.length;
}

const kind = () => { const t = sel ? sel.type : tool; return t === 'highlight' || t === 'text' ? t : 'shape'; };

const palette = () => PALETTES[kind() === 'highlight' ? 'highlight' : 'ink'];
const curColor = () => (sel?.color ?? colors[kind()]).toLowerCase();

function syncControls() {   // the colour and thickness boxes show the selection, or the defaults for the tool
  // With the select tool and nothing selected there's nothing to style, so the controls are hidden.
  const styling = ((tool !== 'select' && tool !== 'eraser') || !!sel) && sel?.type !== 'image';
  $('styleBox').hidden = $('styleSep').hidden = !styling;
  const pal = palette(), box = $('palette');
  if (box.dataset.set !== pal[0][1]) {   // rebuild when switching between highlighter and ink colours
    box.dataset.set = pal[0][1];
    box.replaceChildren(...pal.map(([n, c]) => {
      const b = el2('button', { type: 'button', role: 'radio', 'data-c': c, title: `${n} (C for the next colour)`, 'aria-label': n }, el2('span', { class: 'dot' }));
      b.firstChild.style.background = c;
      b.addEventListener('mousedown', e => e.preventDefault());   // keeps a text box being typed in open
      b.onclick = () => pickColor(c);
      return b;
    }));
  }
  for (const b of box.children) b.setAttribute('aria-checked', b.dataset.c === curColor());
  const w = sel?.width ?? lineWidth, k = kind();
  for (const b of $('widths').querySelectorAll('button')) {
    b.setAttribute('aria-checked', +b.dataset.w === w && k === 'shape');
    b.disabled = k === 'highlight';
  }
  $('widths').hidden = k === 'text';
  const shapeType = sel ? sel.type : tool, filled = sel ? !!sel.fill : fillShapes;
  $('fills').hidden = shapeType !== 'rect' && shapeType !== 'ellipse';
  $('fills').dataset.shape = shapeType;
  for (const b of $('fills').children) b.setAttribute('aria-checked', (b.dataset.fill === '1') === filled);
  document.body.dataset.fill = fillShapes;
  $('tsize').hidden = k !== 'text';
  $('tsizeVal').textContent = (sel?.type === 'text' ? sel.size : textSize) + ' pt';
}

function pickColor(c) {   // for the selection, and as the default for new annotations of that kind
  colors[kind()] = c;
  store.set('colors', colors);
  if (sel && sel.color !== c) {
    if (!editing) commit(snapshot());
    sel.color = c;
    repaint();
  }
  syncControls();
}

function nextColor() {
  const pal = palette(), i = pal.findIndex(([, c]) => c === curColor());
  pickColor(pal[(i + 1) % pal.length][1]);
}

function remove() {
  if (!sel) return;
  commit(snapshot());
  shapes.splice(shapes.indexOf(sel), 1);
  select(null);
}

function restore(state) {
  const s = JSON.parse(state);
  const changed = JSON.stringify(s.entries) !== JSON.stringify(entries);
  [entries, shapes, dirty, sel] = [s.entries, s.shapes, true, null];
  if (changed) relayout();
  syncControls();
  repaint();
}

function undo() {
  if (!history.length) return say('Nothing to undo.');
  future.push(snapshot());
  restore(history.pop());
  syncUndo();
}

function redo() {
  if (!future.length) return say('Nothing to redo.');
  history.push(snapshot());
  restore(future.pop());
  syncUndo();
}

// Outline or filled: for the selected shape, and for new rectangles and ellipses.
function setFill(f) {
  fillShapes = f;
  store.set('fill', f);
  if (sel && (sel.type === 'rect' || sel.type === 'ellipse') && !!sel.fill !== f) {
    commit(snapshot());
    if (f) sel.fill = true; else delete sel.fill;
    repaint();
  }
  syncControls();
}

// Choosing the rectangle or ellipse tool again (its button, R or O) switches between outline and filled.
function pickTool(t) {
  if (t === tool && (t === 'rect' || t === 'ellipse')) return setFill(!(sel && sel.type === t ? !!sel.fill : fillShapes));
  setTool(t);
}

function setTool(t) {
  finishEdit();
  if (eraseHover) { eraseHover = null; repaint(); }
  if (t === 'eraser' || (sel && t !== 'select' && t !== sel.type)) select(null);   // a new tool starts fresh
  tool = document.body.dataset.tool = t;
  for (const b of document.querySelectorAll('button[data-tool]')) b.setAttribute('aria-pressed', b.dataset.tool === t);
  if (t === 'highlight') highlightSelection();   // text already selected? highlight it straight away
  syncControls();
}

/* ---------- cropping pages ---------- */

// Right-click a page → Crop page: the whole page shows, with a box to drag (its corners and edges resize it,
// inside moves it, dragging outside draws a new one). Enter (or Crop) keeps what's inside; Esc cancels. The box
// is kept as fractions of the page as shown, so zooming meanwhile is fine; on Crop it becomes a box in PDF points
// (the page's CropBox when saved). Undo brings the page back.
let cropping = null;   // { p, box: [left, top, right, bottom] as fractions of the whole page on screen }

function startCrop(p) {
  if (cropping) endCrop();
  finishEdit();
  select(null);
  const had = p.e.crop;
  p.cropping = true;
  size(p);
  render(p);
  const v = p.vp, box = had ? fractionsOf(p, had) : [0, 0, 1, 1];
  const ui = el2('div', { class: 'cropper' }, el2('div', { class: 'crop-box' },
    ...['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map(h => el2('i', { 'data-h': h })), el2('b', { class: 'thirds' })));
  p.div.append(ui);
  cropping = { p, box, ui };
  ui.addEventListener('pointerdown', cropDrag);
  drawCrop();
  $('cropTitle').textContent = `Crop page ${pages.indexOf(p) + 1}`;
  $('cropAll').hidden = pages.filter(q => sameSize(q, p)).length < 2;
  $('cropbar').hidden = false;
  document.body.classList.add('cropping');
  const r = p.div.getBoundingClientRect();
  if (r.top < header.offsetHeight || r.bottom > innerHeight - 70) p.div.scrollIntoView({ block: r.height > innerHeight - 140 ? 'start' : 'center', behavior: 'smooth' });
  $('cropOk').focus();
}

function endCrop() {
  if (!cropping) return;
  const { p, ui } = cropping;
  cropping = null;
  ui.remove();
  $('cropbar').hidden = true;
  document.body.classList.remove('cropping');
  p.cropping = false;
  size(p);
  render(p);
}

const sameSize = (q, p) => q.page.view.every((v, i) => Math.abs(v - p.page.view[i]) < 1) && rotationOf(q) === rotationOf(p);

// A box in PDF points <-> fractions of the whole page as shown (rotation included).
function fractionsOf(p, [x1, y1, x2, y2]) {
  const vp = p.page.getViewport({ scale: 1, rotation: rotationOf(p) });
  const a = vp.convertToViewportPoint(x1, y1), b = vp.convertToViewportPoint(x2, y2);
  return [Math.min(a[0], b[0]) / vp.width, Math.min(a[1], b[1]) / vp.height, Math.max(a[0], b[0]) / vp.width, Math.max(a[1], b[1]) / vp.height];
}
function pointsOf(p, [l, t, r, b]) {
  const vp = p.page.getViewport({ scale: 1, rotation: rotationOf(p) });
  const a = vp.convertToPdfPoint(l * vp.width, t * vp.height), c = vp.convertToPdfPoint(r * vp.width, b * vp.height);
  const [X1, Y1, X2, Y2] = p.page.view, round = v => Math.round(v * 100) / 100;
  return [Math.max(X1, Math.min(a[0], c[0])), Math.max(Y1, Math.min(a[1], c[1])), Math.min(X2, Math.max(a[0], c[0])), Math.min(Y2, Math.max(a[1], c[1]))].map(round);
}

function drawCrop() {
  const { p, box: [l, t, r, b], ui } = cropping, W = p.div.clientWidth, H = p.div.clientHeight;
  Object.assign(ui.firstChild.style, { left: l * W + 'px', top: t * H + 'px', width: (r - l) * W + 'px', height: (b - t) * H + 'px' });
  $('cropOk').disabled = false;
}

function cropDrag(ev) {
  if (ev.button !== 0) return;
  ev.preventDefault();
  ev.stopPropagation();
  const { p, ui } = cropping, rect = p.div.getBoundingClientRect();
  const at = e => [Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)), Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height))];
  const start = at(ev), from = [...cropping.box];
  const minW = 24 / rect.width, minH = 24 / rect.height;
  let h = ev.target.dataset.h ?? (ev.target.closest('.crop-box') ? 'move' : 'new');
  if (h === 'new') { cropping.box = [start[0], start[1], start[0], start[1]]; h = 'se'; from.splice(0, 4, ...cropping.box); }
  ui.classList.add('dragging');
  ui.setPointerCapture(ev.pointerId);
  const move = e => {
    const [x, y] = at(e), dx = x - start[0], dy = y - start[1];
    let [l, t, r, b] = from;
    if (h === 'move') {
      const w = r - l, hh = b - t;
      l = Math.min(1 - w, Math.max(0, l + dx)); t = Math.min(1 - hh, Math.max(0, t + dy));
      cropping.box = [l, t, l + w, t + hh];
    } else {
      if (h.includes('w')) l = Math.min(x, r - minW);
      if (h.includes('e')) r = Math.max(x, l + minW);
      if (h.includes('n')) t = Math.min(y, b - minH);
      if (h.includes('s')) b = Math.max(y, t + minH);
      if (h === 'se' && from[0] === from[2]) { l = Math.min(start[0], x); r = Math.max(start[0], x); t = Math.min(start[1], y); b = Math.max(start[1], y); }
      cropping.box = [Math.max(0, l), Math.max(0, t), Math.min(1, r), Math.min(1, b)];
    }
    drawCrop();
  };
  const up = () => {
    ui.classList.remove('dragging');
    ui.removeEventListener('pointermove', move);
    const [l, t, r, b] = cropping.box;
    if (r - l < minW || b - t < minH) cropping.box = from[0] === from[2] ? [0, 0, 1, 1] : from;   // a click, not a drag
    drawCrop();
  };
  ui.addEventListener('pointermove', move);
  ui.addEventListener('pointerup', up, { once: true });
  ui.addEventListener('pointercancel', up, { once: true });
}

// Trim margins: the box shrinks to what's printed on the page (anything not near-white), plus a little air.
async function trimCrop() {
  if (!cropping) return;
  const { p } = cropping, base = p.page.getViewport({ scale: 1, rotation: rotationOf(p) });
  const vp = p.page.getViewport({ scale: Math.min(2, 900 / Math.max(base.width, base.height)), rotation: rotationOf(p) });
  const c = document.createElement('canvas');
  c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  try { await p.page.render({ canvas: c, canvasContext: g, viewport: vp, annotationMode: pdfjs.AnnotationMode.ENABLE_STORAGE }).promise; } catch { return; }
  if (cropping?.p !== p) return;
  const { data, width: W, height: H } = g.getImageData(0, 0, c.width, c.height);
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = 4 * (y * W + x);
    if (data[o] < 235 || data[o + 1] < 235 || data[o + 2] < 235) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  // Shapes, highlights and text boxes added here count too.
  for (const sh of shapes) {
    if (sh.page !== p.id) continue;
    const [a, b2, c2, d] = boxOf(sh), q = vp.convertToViewportPoint(a, b2), r = vp.convertToViewportPoint(c2, d);
    x0 = Math.min(x0, q[0], r[0]); x1 = Math.max(x1, q[0], r[0]); y0 = Math.min(y0, q[1], r[1]); y1 = Math.max(y1, q[1], r[1]);
  }
  if (x1 < 0) return say('This page looks blank, so there are no margins to trim.');
  const pad = 12 * vp.scale;   // about 12 points of air
  cropping.box = [Math.max(0, x0 - pad) / W, Math.max(0, y0 - pad) / H, Math.min(W, x1 + 1 + pad) / W, Math.min(H, y1 + 1 + pad) / H];
  drawCrop();
}

function applyCrop(all = false) {
  if (!cropping) return;
  const { p, box } = cropping, whole = box[0] <= 0.001 && box[1] <= 0.001 && box[2] >= 0.999 && box[3] >= 0.999;
  const crop = whole ? null : pointsOf(p, box);
  const targets = all ? pages.filter(q => sameSize(q, p)) : [p];
  endCrop();
  changePages(() => {
    for (const q of targets) { if (crop) q.e.crop = crop; else delete q.e.crop; }
  });
  if (all) say(crop ? `Cropped ${targets.length} pages the same way.` : `Showing ${targets.length} pages whole again.`);
  else if (crop) say(`Cropped page ${pages.indexOf(p) + 1}. Ctrl+Z brings it back.`);
}

/* ---------- saving ---------- */

// Where the open PDF came from, so Save can write over it.
let srcHandle = null;   // a file handle, when it was picked or dropped here
let srcPicked = false;  // picked with Open (so the open picker's id remembers its folder)
let srcUrl = null;      // its address, when it was opened straight in Chrome
let srcStored = null;   // for a file opened from its file:// address: the handle remembered from its first save
let disk = null;        // { size, hash } of the file as it is on disk (as opened, or as last saved here)

// Chrome remembers the last folder used with each picker id. A file opened from file:// gives no handle,
// so each of its folders gets its own id: after the first save there, the picker opens in that folder.
function folderId() {
  if (!srcUrl?.startsWith('file:')) return 'inkfold-save';
  const dir = srcUrl.slice(0, srcUrl.lastIndexOf('/'));
  let h = 5381;
  for (const c of dir) h = (h * 33 ^ c.charCodeAt(0)) >>> 0;
  return 'inkfold-' + h.toString(36);
}

// A file straight in Downloads, Desktop or Documents (the usual places): Chrome can open its dialog right there.
function wellKnown(url) {
  const parts = decodeURIComponent(new URL(url).pathname).split('/').filter(Boolean);
  const dir = parts.at(-2)?.toLowerCase(), home = parts.slice(0, -2).join('/').toLowerCase();
  if (!/((^|\/)(users|home)\/[^/]+|^root)(\/onedrive[^/]*)?$/.test(home)) return null;
  return { downloads: 'downloads', desktop: 'desktop', documents: 'documents' }[dir] ?? null;
}

async function digest(bytes) {
  try { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join(''); }
  catch { return null; }
}

// Handles to local files, remembered by their file:// address (in this browser only). A PDF opened from its
// address gives Inkfold no handle, so its first save needs the save dialog; after that, saving over it only
// needs Chrome's permission, even after the tab is closed and the file opened again.
function handles(mode, f) {
  return new Promise((ok, no) => {
    const q = indexedDB.open('inkfold-files', 1);
    q.onupgradeneeded = () => q.result.createObjectStore('h');
    q.onerror = () => no(q.error);
    q.onsuccess = () => {
      const db = q.result, t = db.transaction('h', mode), r = f(t.objectStore('h'));
      t.oncomplete = () => { db.close(); ok(r.result); };
      t.onerror = t.onabort = () => { db.close(); no(t.error); };
    };
  });
}
const recallHandle = url => handles('readonly', s => s.get(url)).catch(() => null);
const rememberHandle = (url, h) => handles('readwrite', s => s.put(h, url)).catch(() => {});
const forgetHandle = url => handles('readwrite', s => s.delete(url)).catch(() => {});

// Chrome's own "Save changes to …?" question, asked only when this tab doesn't already have permission.
// 'yes', 'no', or 'gone' when the file can't be reached any more (moved, renamed or deleted).
async function mayWrite(h) {
  try {
    let p = await h.queryPermission({ mode: 'readwrite' });
    if (p !== 'granted') p = await h.requestPermission({ mode: 'readwrite' });
    if (p !== 'granted') return 'no';
    await h.getFile();
    return 'yes';
  } catch { return 'gone'; }
}

// Whether the file on disk is still the one opened (or last saved) here.
async function unchanged(h) {
  if (!disk) return true;
  try {
    const f = await h.getFile();
    if (f.size !== disk.size) return false;
    const [now, was] = await Promise.all([digest(await f.arrayBuffer()), disk.hash]);
    return !now || !was || now === was;
  } catch { return true; }
}

const PDF_TYPES = [{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }];

// Save writes over the original: with only Chrome's permission when Inkfold has the file's handle (opened with
// Open, dropped here, or saved once before from its file:// address), or else through the save dialog, which
// suggests the original's name and folder. Ctrl+Shift+S (copy) always asks where, for a new file.
async function save(copy = false) {
  finishEdit();
  if (!docs.has('main')) return;
  let handle = null, over = false;
  const own = copy ? null : srcHandle ?? srcStored;
  if (own) {
    const may = await mayWrite(own);
    if (may === 'no') return say(`Not saved: Chrome wasn’t allowed to change “${own.name}”. To save a copy elsewhere, press Ctrl+Shift+S.`, true);
    if (may === 'gone') {
      if (own === srcStored) { forgetHandle(srcUrl); srcStored = null; }
      if (own === srcHandle) srcHandle = null;
      return say(`“${own.name}” has been moved, renamed or deleted. Press Save again to choose where to save.`, true);
    }
    if (!(await unchanged(own)) && !(await ask({
      title: 'Changed on disk',
      body: [para(`“${own.name}” has been changed by another program since you opened it here. Saving will replace those changes with this version.`)],
      ok: 'Save over it',
    }))) return;
    handle = own;
    over = true;
  }
  if (!handle && window.showSaveFilePicker) {   // ask where first, while the click still counts as a user action
    const opts = { suggestedName: copy ? name.replace(/(\.pdf)?$/i, ' (copy).pdf') : name, id: folderId(), types: PDF_TYPES };
    // Chrome opens a file handle given as startIn one folder too high, so the original's folder comes from the
    // picker id instead: a file chosen with Open shares its id, which remembers the folder it was picked in.
    if (srcHandle) opts.id = srcPicked ? 'inkfold-open' : opts.id;
    else if (!srcUrl?.startsWith('file:')) opts.startIn = 'downloads';
    else if (!copy && wellKnown(srcUrl)) { opts.startIn = wellKnown(srcUrl); delete opts.id; }   // the folder itself, not a remembered one
    try {
      handle = await showSaveFilePicker(opts);
    } catch (e) {
      if (e.name === 'AbortError') return;
      if (/already active/i.test(e.message)) return;   // a save dialog is open already
      if (opts.startIn) {   // e.g. the original was moved since it was opened
        delete opts.startIn;
        try { handle = await showSaveFilePicker(opts); } catch (e2) { if (e2.name === 'AbortError') return; }
      }
    }
  }
  say('Saving…', true);
  try {
    const out = await build(entries);
    if (handle) {
      const w = await handle.createWritable();
      await w.write(out);
      await w.close();
      if (!over) over = srcHandle ? await srcHandle.isSameEntry(handle).catch(() => false)
        : !!srcUrl?.startsWith('file:') && handle.name === name && await originalIs(out);
      if (over) {
        disk = { size: out.length, hash: digest(out) };
        // Remember the original's handle, so the next save (in this tab or after reopening it) needs no dialog.
        if (!srcHandle && srcUrl?.startsWith('file:') && handle !== srcStored) { srcStored = handle; rememberHandle(srcUrl, handle); }
      }
      say(over ? `Saved over “${handle.name}”.` : `Saved “${handle.name}”.`);
    } else {
      download(out, name);
      say('Saved to your downloads.');
    }
    dirty = false;
  } catch (e) {
    say(/encrypt/i.test(e.message) ? 'This PDF is encrypted, so it cannot be saved.' : 'Could not save: ' + e.message, true);
  }
}

// For a PDF opened from its file:// address there's no file handle to compare with, and the same name could be in
// another folder: so read the original again and see whether it's now exactly what was just saved.
async function originalIs(data) {
  try {
    const now = new Uint8Array(IN_PAGE ? await globalThis.inkfoldReadLocal() : await fetchBytes(srcUrl));
    if (now.length !== data.length) return false;
    for (let i = 0; i < now.length; i++) if (now[i] !== data[i]) return false;
    return true;
  } catch { return false; }
}

function download(data, file) {
  const url = URL.createObjectURL(new Blob([data], { type: 'application/pdf' }));
  Object.assign(document.createElement('a'), { href: url, download: file }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Writes a PDF holding `list` (some or all entries, in order) with their rotations and annotations.
// It edits the original file rather than copying pages out, so bookmarks, metadata and forms survive;
// anything only the dropped pages used is then removed, so deleted pages really are gone from the file.
async function build(list) {
  const {
    PDFDocument, PDFName, PDFNumber, PDFString, PDFHexString, PDFDict, PDFArray, PDFRef, PDFStream, StandardFonts,
    pushGraphicsState, popGraphicsState, setTextRenderingMode, TextRenderingMode, setCharacterSqueeze, radians,
  } = await lib();
  let helv = null;   // Helvetica, added only if there are text boxes
  const pics = new Map();   // image key -> the picture embedded in this file (once, however often it's used)
  const doc = await PDFDocument.load(await bytesOf(docs.get('main')), { updateMetadata: false });
  const ctx = doc.context, N = PDFName.of;
  const round = v => +v.toFixed(2), num = (...v) => v.map(round).join(' ');
  const orig = doc.getPages();

  const copied = new Map();   // note pages, copied in from their own small PDFs
  for (const key of new Set(list.map(e => e.doc))) {
    if (key === 'main') continue;
    const src = await PDFDocument.load(await bytesOf(docs.get(key)));
    copied.set(key, await doc.copyPages(src, src.getPageIndices()));
  }
  const out = list.map(e => (e.doc === 'main' ? orig[e.i] : copied.get(e.doc)[e.i]));

  // Settings a page inherits from the old page tree are copied onto the page itself, so nothing is lost when it moves.
  for (const [k, pg] of out.entries()) {
    for (const key of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) {
      if (pg.node.get(N(key))) continue;
      const v = pg.node.getInheritableAttribute(N(key));
      if (v) pg.node.set(N(key), v);
    }
    const r = pg.node.lookup(N('Rotate'));
    pg.node.set(N('Rotate'), PDFNumber.of((((r?.asNumber?.() ?? 0) + list[k].rot) % 360 + 360) % 360));
    const c = list[k].crop;   // cropped here: the page's visible box
    if (c) pg.setCropBox(c[0], c[1], c[2] - c[0], c[3] - c[1]);
  }
  // Drop the annotations from an earlier session; the current set is written back below.
  for (const pg of out) {
    const annots = pg.node.Annots();
    for (let i = (annots?.size() ?? 0) - 1; i >= 0; i--) {
      const d = annots.lookup(i);
      if (!(d instanceof PDFDict)) continue;
      const author = d.lookup(N('T')), kind = d.lookup(N('Subtype'));
      if (!(author instanceof PDFString || author instanceof PDFHexString) || !MARKS.includes(author.decodeText())) continue;
      if ([N('Square'), N('Circle'), N('Highlight'), N('FreeText'), N('Stamp')].includes(kind)) annots.remove(i);
    }
  }

  // Real Square / Circle / Highlight annotations, each with its own appearance so every viewer draws it the same.
  const target = new Map(list.map((e, k) => [e.id, out[k]]));
  for (const s of shapes) {
    const pg = target.get(s.page);
    if (!pg) continue;
    const rgb = s.color ? [1, 3, 5].map(i => +(parseInt(s.color.slice(i, i + 2), 16) / 255).toFixed(3)) : [0, 0, 0];
    let dict, extra = { C: rgb };
    if (s.type === 'image') {
      // A Stamp annotation whose appearance is the picture, so every viewer shows it; Inkfold reads it back.
      const im = imgs.get(s.img);
      if (!im) continue;
      let pic = pics.get(s.img);
      if (!pic) pics.set(s.img, pic = await (im.mime === 'image/jpeg' ? doc.embedJpg(dataBytes(im.src)) : doc.embedPng(dataBytes(im.src))));
      const box = [s.x1, s.y1, s.x2, s.y2].map(round), w = round(s.x2 - s.x1), h = round(s.y2 - s.y1);
      const look = ctx.stream(`q ${w} 0 0 ${h} ${box[0]} ${box[1]} cm /Im Do Q`, {
        Type: 'XObject', Subtype: 'Form', BBox: box, Resources: { XObject: { Im: pic.ref } },
      });
      dict = { Subtype: 'Stamp', Rect: box, Name: 'Image', Contents: PDFHexString.fromText('Image'), AP: { N: ctx.register(look) } };
      extra = {};
    } else if (s.type === 'text') {
      // A FreeText annotation: the text as its contents, drawn by its own appearance (Helvetica plus math outlines).
      // The leading and trailing no-op text objects tell readers (pdf.js included) the font size and colour.
      const L = await layout(s.text, s.size), box = boxOf(s).map(round);
      helv ??= await doc.embedFont(StandardFonts.Helvetica);
      const mark = `BT /Helv ${s.size} Tf ${rgb.join(' ')} rg ET`;
      const look = ctx.stream(`${mark}\n${pdfOps(L, s.x1, s.y2, rgb)}\n${mark}`, {
        Type: 'XObject', Subtype: 'Form', BBox: box, Resources: { Font: { Helv: helv.ref } },
      });
      dict = {
        Subtype: 'FreeText', Rect: box, Contents: PDFHexString.fromText(s.text),
        DA: PDFString.of(`/Helv ${s.size} Tf ${rgb.join(' ')} rg`), BS: { W: 0 }, AP: { N: ctx.register(look) },
      };
      extra = {};   // (for FreeText, /C would be a background fill)
    } else if (s.type === 'highlight') {
      const box = [
        Math.min(...s.rects.map(r => r[0])), Math.min(...s.rects.map(r => r[1])),
        Math.max(...s.rects.map(r => r[2])), Math.max(...s.rects.map(r => r[3])),
      ].map(round);
      const path = s.rects.map(([a, b, c, d]) => num(a, b, c - a, d - b) + ' re').join(' ');
      const look = ctx.stream(`/GS0 gs ${rgb.join(' ')} rg ${path} f`, {
        Type: 'XObject', Subtype: 'Form', BBox: box,
        Resources: { ExtGState: { GS0: { Type: 'ExtGState', BM: 'Multiply' } } },   // ink shows through, like a marker
      });
      dict = {
        Subtype: 'Highlight', Rect: box, AP: { N: ctx.register(look) },
        QuadPoints: s.rects.flatMap(([a, b, c, d]) => [a, d, c, d, a, b, c, b]).map(round),
      };
    } else {
      const { x1, y1, x2, y2, width: w } = s, h = w / 2;
      const box = [x1 - h, y1 - h, x2 + h, y2 + h].map(round);
      let path = num(x1, y1, x2 - x1, y2 - y1) + ' re';
      if (s.type === 'ellipse') {   // four Bézier quarters
        const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, rx = (x2 - x1) / 2, ry = (y2 - y1) / 2, kx = rx * 0.5523, ky = ry * 0.5523;
        path = [
          num(cx + rx, cy) + ' m',
          num(cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry) + ' c',
          num(cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy) + ' c',
          num(cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry) + ' c',
          num(cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy) + ' c h',
        ].join(' ');
      }
      const paint = s.fill ? `${rgb.join(' ')} rg ${rgb.join(' ')} RG ${path} B` : `${rgb.join(' ')} RG ${path} S`;
      const look = ctx.stream(`${w} w ${paint}`, { Type: 'XObject', Subtype: 'Form', BBox: box });
      dict = { Subtype: s.type === 'rect' ? 'Square' : 'Circle', Rect: box, BS: { W: w }, AP: { N: ctx.register(look) }, ...(s.fill ? { IC: rgb } : {}) };
    }
    pg.node.addAnnot(ctx.register(ctx.obj({ Type: 'Annot', ...dict, ...extra, F: 4, T: PDFString.of(MARK) })));
  }

  // Recognised text goes onto its pages as invisible text, so the copy can be searched and selected anywhere.
  const scanned = list.filter(e => e.doc === 'main' && ocrText.has(e.i));
  if (scanned.length) {
    helv ??= await doc.embedFont(StandardFonts.Helvetica);
    const clean = cleanWith(new Set(helv.getCharacterSet()));
    for (const e of scanned) {
      const pg = target.get(e.id);
      pg.node.wrapContentStreams(ctx.register(ctx.stream('q')), ctx.register(ctx.stream('Q')));   // our text starts from a clean state
      for (const it of ocrText.get(e.i)) {
        const t = clean(it.str);
        const [a, b, , , x, y] = it.transform, size = Math.hypot(a, b), natural = t.trim() ? helv.widthOfTextAtSize(t, size) : 0;
        if (!natural || size < 1) continue;
        pg.pushOperators(pushGraphicsState(), setTextRenderingMode(TextRenderingMode.Invisible), setCharacterSqueeze(+(100 * it.width / natural).toFixed(2)));
        pg.drawText(t, { x, y, size, font: helv, rotate: radians(Math.atan2(b, a)) });
        pg.pushOperators(popGraphicsState());
      }
    }
  }

  // Swap in a fresh, flat page tree holding just these pages, in this order.
  const tree = ctx.register(ctx.obj({ Type: 'Pages', Kids: out.map(p => p.ref), Count: out.length }));
  out.forEach(p => p.node.set(N('Parent'), tree));
  doc.catalog.set(N('Pages'), tree);

  // Remove every object that is no longer reachable, treating dropped pages as cut off.
  const dropped = new Set(orig.filter(p => !out.includes(p)).map(p => p.ref.toString()));
  const seen = new Set(), todo = Object.values(ctx.trailerInfo).filter(Boolean);
  while (todo.length) {
    const o = todo.pop();
    if (o instanceof PDFRef) {
      const k = o.toString();
      if (seen.has(k) || dropped.has(k)) continue;
      seen.add(k);
      const v = ctx.lookup(o);
      if (v) todo.push(v);
    } else if (o instanceof PDFDict) todo.push(...o.values());
    else if (o instanceof PDFArray) todo.push(...o.asArray());
    else if (o instanceof PDFStream) todo.push(o.dict);
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.toString())) ctx.delete(ref);

  return doc.save({ updateFieldAppearances: false });
}

// Short messages at the bottom of the window; some carry an action such as Undo.
function say(text, opts = {}) {
  const { sticky = false, action = null, long = false } = typeof opts === 'boolean' ? { sticky: opts } : opts;
  const t = $('toast');
  clearTimeout(msgTimer);
  if (!text) { t.classList.remove('show'); return; }
  const parts = [Object.assign(document.createElement('span'), { textContent: text })];
  if (action) {
    const b = Object.assign(document.createElement('button'), { textContent: action.label });
    b.onclick = () => { t.classList.remove('show'); action.fn(); };
    parts.push(b);
  }
  t.replaceChildren(...parts);
  t.classList.add('show');
  if (!sticky) msgTimer = setTimeout(() => t.classList.remove('show'), action || long ? 8000 : 4000);
}

const firstTime = key => { const seen = store.get(key, false); if (!seen) store.set(key, true); return !seen; };
const para = text => el2('p', {}, text);
function el2(tag, attrs, ...kids) {
  const node = Object.assign(document.createElement(tag), attrs.class ? { className: attrs.class } : {});
  for (const [k, v] of Object.entries(attrs)) if (k !== 'class') node.setAttribute(k, v);
  node.append(...kids);
  return node;
}

// A small modal: resolves true for the main button, false for Cancel / Escape.
function ask({ title, body, ok = 'OK', cancel = 'Cancel', wide = false }) {
  const d = $('dlg');
  d.classList.toggle('wide', wide);
  $('dlgTitle').textContent = title;
  $('dlgBody').replaceChildren(...body);
  $('dlgOk').textContent = ok;
  $('dlgCancel').textContent = cancel ?? '';
  $('dlgCancel').hidden = !cancel;
  d.returnValue = '';
  d.showModal();
  $('dlgOk').focus();
  return new Promise(res => d.addEventListener('close', () => res(d.returnValue === 'ok'), { once: true }));
}


/* ---------- wiring ---------- */

const ICONS = {
  left: '<svg viewBox="0 0 16 16"><path d="M3.5 6.5A5 5 0 1 1 4 11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M1.8 3.2l1.7 3.3 3.4-1.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  right: '<svg viewBox="0 0 16 16"><path d="M12.5 6.5A5 5 0 1 0 12 11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M14.2 3.2l-1.7 3.3-3.4-1.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  note: '<svg viewBox="0 0 16 16"><path d="M3 1.8h6.5l3.5 3.5v8.9H3z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8 7.2v5M5.5 9.7h5" stroke="currentColor" stroke-width="1.4"/></svg>',
  move: '<svg viewBox="0 0 16 16"><path d="M8 1.8v12.4M5.5 4.3 8 1.8l2.5 2.5M5.5 11.7 8 14.2l2.5-2.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.5 8h3M10.5 8h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  crop: '<svg viewBox="0 0 16 16"><path d="M4.5 1.5v9.5a.5.5 0 0 0 .5.5h9.5M1.5 4.5h9.5a.5.5 0 0 1 .5.5v9.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  trash: '<svg viewBox="0 0 16 16"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.8 9.5h6.4L12 4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
};

async function openFile(f, handle = null, picked = false) {
  if (!f) return;
  srcHandle = handle;
  srcPicked = !!handle && !!picked;
  srcUrl = srcStored = null;
  await openPdf(await f.arrayBuffer(), f.name);
  // Files dropped or picked here live on the extension's page, which Gemini in Chrome can't read.
  if (!IN_PAGE && docs.has('main') && firstTime('tip-gemini')) {
    say('Tip: Gemini in Chrome can’t read files opened here. To use it, open the PDF straight in Chrome instead (drag it onto the tab bar).', { long: true });
  }
}

function setWidth(w) {
  if (kind() !== 'shape') return;
  lineWidth = w;
  store.set('width', w);
  if (sel && sel.width !== w) {
    commit(snapshot());
    sel.width = w;
    repaint();
  }
  syncControls();
}

function goPage(dir) { jumpTo(currentIndex() + dir); }

// ← / →: glide to the previous or next page (or pair of pages, in two-page view). Quick presses add up.
let pageTarget = -1, pageTargetAt = 0;
function stepPage(dir) {
  if (!pages.length) return;
  const from = performance.now() - pageTargetAt < 700 ? pageTarget : currentIndex();
  const k = clamp(from + dir * (spread ? 2 : 1), 0, pages.length - 1);
  pageTarget = k;
  pageTargetAt = performance.now();
  pages[k].div.scrollIntoView({ block: 'start', behavior: 'smooth' });
  showPage(k);
}

// ↑ / ↓: a smooth glide instead of the browser's steps. Holding the key speeds it up gently;
// letting go eases it to a stop. A quick tap moves about three lines.
let glide = null;
function glideStart(dir) {
  if (glide) { glide.dir = dir; glide.held = true; return; }
  const g = glide = { dir, v: 0.45, held: true, t: performance.now() };   // speed in px per ms
  const tick = now => {
    if (glide !== g) return;
    const dt = Math.min(40, now - g.t);
    g.t = now;
    if (g.held) g.v = Math.min(1.6, g.v + dt * 0.0022);
    else if ((g.v -= dt * 0.007) <= 0) { glide = null; return; }
    const y = scrollY;
    scrollTo({ top: y + g.dir * g.v * dt, behavior: 'instant' });
    if (Math.abs(scrollY - y) < 0.01 && dt > 0 && !g.held) { glide = null; return; }   // reached the top or end
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
const glideStop = () => { if (glide) glide.held = false; };
addEventListener('keyup', e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') glideStop(); });
addEventListener('blur', () => { glide = null; });
function jumpTo(k) {
  k = clamp(k, 0, pages.length - 1);
  pages[k]?.div.scrollIntoView({ block: 'start' });
  showPage(k);
}

// Page number box: shows the page filling the window; type a number and press Enter to go there.
let pageTimer = 0;
function showPage(k = currentIndex()) {
  $('pageOf').textContent = `/ ${pages.length}`;
  if (document.activeElement !== $('pageNum')) $('pageNum').value = pages.length ? k + 1 : '';
}
addEventListener('scroll', () => {
  if (!pageTimer) pageTimer = requestAnimationFrame(() => { pageTimer = 0; showPage(); });
  notePlace();
}, { passive: true });
$('pageNum').onkeydown = e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const n = parseInt($('pageNum').value, 10);
    if (n >= 1 && n <= pages.length) { $('pageNum').blur(); jumpTo(n - 1); }
    else { say(`There’s no page ${$('pageNum').value.trim() || 'there'}. Pick one from 1 to ${pages.length}.`); $('pageNum').select(); }
  } else if (e.key === 'Escape') { e.preventDefault(); $('pageNum').blur(); }
};
$('pageNum').onblur = () => showPage();
$('pageNum').onfocus = () => $('pageNum').select();

function togglePanel(id, field) {
  const el = $(id);
  if (el.matches(':popover-open')) return el.hidePopover();
  document.querySelectorAll(':popover-open:not(#find)').forEach(x => x.hidePopover());
  el.style.top = header.getBoundingClientRect().bottom + 6 + 'px';
  if (id === 'panel') {   // set up before showing, so nothing changes the fields while you type
    $('panelMsg').textContent = '';
    drawMerge();
  }
  el.showPopover();
  if (field) $(field).select();
}

const thisPage = () => (pages.length ? new Set([pages[targetIndex()].id]) : null);

for (const b of document.querySelectorAll('button[data-tool]')) b.onclick = () => pickTool(b.dataset.tool);
$('cropOk').onclick = () => applyCrop();
$('cropAll').onclick = () => applyCrop(true);
$('cropCancel').onclick = () => endCrop();
$('cropTrim').onclick = () => trimCrop();
$('cropWhole').onclick = () => { if (cropping) { cropping.box = [0, 0, 1, 1]; drawCrop(); } };
for (const b of $('fills').children) { b.addEventListener('mousedown', e => e.preventDefault()); b.onclick = () => setFill(b.dataset.fill === '1'); }
for (const b of $('widths').querySelectorAll('button')) b.onclick = () => setWidth(+b.dataset.w);
$('addImage').onclick = () => addImage();
$('magicBtn').onclick = magicPaste;
$('ocrStop').onclick = () => { ocrStop = true; };
$('tsmaller').onclick = () => setTextSize(-1);
$('tbigger').onclick = () => setTextSize(1);
// The size buttons don't take focus, so a text box being typed in stays open.
for (const id of ['tsmaller', 'tbigger']) $(id).addEventListener('mousedown', e => e.preventDefault());
$('undo').onclick = undo;
$('redo').onclick = redo;
$('zin').onclick = () => step(1);
$('zout').onclick = () => step(-1);
buildZoomPop();
syncUndo();
$('spread').onclick = () => setSpread(!spread);
$('full').onclick = toggleFull;

// Full screen: the whole viewer, toolbar included. The same button (or Shift+F, or Esc) leaves it.
// Chrome's own full screen (F11) is different: a page can't leave it, so the button says to press F11.
const browserFull = () => !document.fullscreenElement && (matchMedia('(display-mode: fullscreen)').matches
  // the window fills the screen and has no frame around the page (works at any page zoom)
  || (Math.abs(screen.width - outerWidth) < 4 && Math.abs(screen.height - outerHeight) < 4
    && Math.abs(outerWidth / innerWidth - outerHeight / innerHeight) < 0.01));

function toggleFull() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else if (browserFull()) say('This is Chrome’s full screen (F11). Press F11 to leave it.');
  else document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => say('Chrome didn’t allow full screen here. Try F11 instead.'));
}
function syncFull() {
  const page = !!document.fullscreenElement, browser = !page && browserFull();
  document.body.classList.toggle('full', page || browser);
  $('full').setAttribute('aria-pressed', page || browser);
  const label = page ? 'Exit full screen (Shift+F or Esc)' : browser ? 'Exit full screen (F11)' : 'Full screen (Shift+F)';
  $('full').title = label;
  $('full').setAttribute('aria-label', label);
}
addEventListener('fullscreenchange', syncFull);
addEventListener('resize', syncFull);
matchMedia('(display-mode: fullscreen)').addEventListener?.('change', syncFull);
syncFull();
$('note').onclick = () => addNote();
$('pagesBtn').onclick = () => togglePanel('panel', 'range');
$('keysBtn').onclick = () => togglePanel('keys');
$('save').onclick = () => save();
async function pickFile() {   // the File System Access picker gives a handle, so Save can open the same folder
  if (!window.showOpenFilePicker) return $('file').click();
  try {
    const [h] = await showOpenFilePicker({ id: 'inkfold-open', types: [{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }] });
    await openFile(await h.getFile(), h, true);
  } catch (e) { if (e.name !== 'AbortError') $('file').click(); }
}
$('open').onclick = pickFile;
$('file').onchange = e => { openFile(e.target.files[0]); e.target.value = ''; };

// Pages panel: the same keys as on a page, but applied to the typed range
const rangeRotate = d => { const ids = rangeIds(); if (ids) rotatePages(ids, d); };
const rangeDelete = () => {
  const ids = rangeIds();
  if (ids && deletePages(ids)) $('range').value = '';
};
$('rotL').onclick = () => rangeRotate(-90);
$('rotR').onclick = () => rangeRotate(90);
$('delPages').onclick = rangeDelete;
$('split').onclick = () => split('separate');
$('splitOne').onclick = () => split('one');
$('range').onkeydown = e => {
  if (e.key === '[' || e.key === ']') { e.preventDefault(); rangeRotate(e.key === '[' ? -90 : 90); }
  else if (e.key === 'Delete' && e.shiftKey) { e.preventDefault(); rangeDelete(); }
  else if (e.key === 'Enter') e.preventDefault();
};
$('splitRanges').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); split(); } };

// Right-click a page for its own menu. With text selected, or with Shift held, Chrome's own menu
// (Copy, Search, Gemini…) shows instead.
const MENU = [
  ['left', 'Rotate left', '[', p => rotatePages(new Set([p.id]), -90)],
  ['right', 'Rotate right', ']', p => rotatePages(new Set([p.id]), 90)],
  ['note', 'Add note after this page', 'N', p => addNote(pages.indexOf(p))],
  ['move', 'Move page', 'M', p => startMove(p)],
  ['crop', 'Crop page', 'C', p => startCrop(p)],
  null,
  ['trash', 'Delete page', 'Shift+Del', p => deletePages(new Set([p.id]))],
];
let menuPage = null;
$('menu').append(...MENU.map(m => {
  if (!m) return document.createElement('hr');
  const b = el2('button', { type: 'button', role: 'menuitem', class: m[0] === 'trash' ? 'danger' : '' }, m[1], el2('span', { class: 'key' }, m[2]));
  b.insertAdjacentHTML('afterbegin', ICONS[m[0]]);
  b.onclick = () => { closeMenu(); if (pages.includes(menuPage)) m[3](menuPage); };
  return b;
}));
function openMenu(p, x, y) {
  const m = $('menu');
  menuPage = p;
  $('menuTitle').textContent = `Page ${pages.indexOf(p) + 1} of ${pages.length}${kindOf(p.e) ? ' · ' + kindOf(p.e) : ''}`;
  m.querySelector('.danger').disabled = pages.length < 2;
  m.style.left = m.style.top = '0px';
  m.showPopover();
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
  m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
  m.querySelector('button').focus();
}
$('pages').addEventListener('contextmenu', e => {
  const p = e.target.closest('.page')?.p;
  if (!p || e.shiftKey) return;
  const s = getSelection();
  if (!s.isCollapsed && s.toString().trim()) return;
  e.preventDefault();
  let { clientX: x, clientY: y } = e;
  if (!x && !y) { const r = p.div.getBoundingClientRect(); x = r.left + 24; y = Math.max(r.top, 60) + 24; }   // the menu key
  openMenu(p, x, y);
});
function menuKey(e) {   // arrow keys move through the menu, even if focus has wandered off it
  const items = [...$('menu').querySelectorAll('button:not(:disabled)')], i = items.indexOf(document.activeElement);
  const to = { ArrowDown: i + 1, ArrowUp: i < 0 ? -1 : i - 1, Home: 0, End: -1 }[e.key];
  if (to === undefined) return false;
  e.preventDefault();
  items.at(to % items.length).focus();
  return true;
}
// The menu closes itself (a light-dismiss popover would close on the release of the very right-click that opened it).
const closeMenu = () => $('menu').matches(':popover-open') && $('menu').hidePopover();
addEventListener('pointerdown', e => { if (!$('menu').contains(e.target)) closeMenu(); }, true);
addEventListener('scroll', closeMenu, { passive: true });
addEventListener('resize', closeMenu);
addEventListener('blur', closeMenu);
// Page shortcuts act on the page under the pointer, or else the one filling most of the window.
$('pages').addEventListener('pointerover', e => { hovered = e.target.closest('.page')?.p ?? hovered; });
$('pages').addEventListener('pointerleave', () => { hovered = null; });

addEventListener('pointermove', move);
addEventListener('pointerup', up);
addEventListener('pointercancel', up);
addEventListener('mouseup', released);
$('pages').addEventListener('mousedown', e => { if (e.target === e.currentTarget && sel) select(null); });
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', async e => {
  e.preventDefault();
  if (docs.has('main')) return;
  const item = [...e.dataTransfer.items].find(i => i.kind === 'file');
  const f = e.dataTransfer.files[0], h = item?.getAsFileSystemHandle?.();   // must be asked for during the event
  openFile(f, await h?.catch(() => null) ?? null);
});
addEventListener('beforeunload', e => { if (dirty) e.preventDefault(); });
let resizing;
addEventListener('resize', () => {
  cancelAnimationFrame(resizing);
  resizing = requestAnimationFrame(() => fit && setZoom(fitZoom(fit), fit, true));
});

// Every shortcut, in one place. Keys listed in the buttons' labels and in the ? sheet.
const KEYS = {
  'v': () => setTool('select'), 'h': () => setTool('highlight'), 'r': () => pickTool('rect'), 'o': () => pickTool('ellipse'), 't': () => setTool('text'), 'e': () => setTool('eraser'), 'i': () => addImage(),
  '-': () => setTextSize(-1), '=': () => setTextSize(1), '+': () => setTextSize(1),
  'c': nextColor,
  '1': () => setWidth(1), '2': () => setWidth(2), '3': () => setWidth(4),
  'w': () => setZoom(fitZoom('width'), 'width'), 'f': () => setZoom(fitZoom('page'), 'page'),
  'd': () => setSpread(!spread),
  'n': () => addNote(targetIndex() >= 0 ? targetIndex() : undefined),
  'p': () => togglePanel('panel', 'range'),
  'm': () => pages.length && startMove(pages[targetIndex()]),
  '/': () => openFind(),
  '?': () => togglePanel('keys'),
  '[': () => thisPage() && rotatePages(thisPage(), -90), ']': () => thisPage() && rotatePages(thisPage(), 90),
  'j': () => goPage(1), 'k': () => goPage(-1), 'g': () => { $('pageNum').focus(); $('pageNum').select(); },
  'delete': () => remove(), 'backspace': () => remove(),
  'escape': () => {
    const open = document.querySelectorAll(':popover-open');
    if (open.length) return open.forEach(x => x.hidePopover());
    getSelection().removeAllRanges();
    select(null);
  },
};
const CTRL_KEYS = {
  's': save, 'f': () => openFind(), 'o': () => docs.has('main') || pickFile(),   // with a PDF open, there's no opening another one here
  'z': undo, 'y': redo, 'v': magicPaste,
};

// Ctrl + / Ctrl − / Ctrl 0 (and Ctrl + the mouse wheel, or a pinch on a touchpad) zoom the pages, never the whole
// window with its toolbar. They're caught first, whatever has the focus, and matched by the physical key, so they
// work on any keyboard layout and with the number pad.
const ZOOM_KEYS = { Equal: 1, NumpadAdd: 1, Minus: -1, NumpadSubtract: -1, Digit0: 0, Numpad0: 0 };
addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const dir = ZOOM_KEYS[e.code] ?? { '+': 1, '=': 1, '-': -1, '_': -1, '0': 0 }[e.key];
  if (dir === undefined) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (!pages.length || moving) return;
  if (dir) step(dir); else setZoom(1);
}, true);
let wheelZoom = 0;
addEventListener('wheel', e => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  if (!pages.length || moving) return;
  wheelZoom += -e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025);   // lines or pixels
  if (Math.abs(wheelZoom) < 0.02) return;
  const z = clamp(zoom * Math.exp(wheelZoom), Z_MIN, Z_MAX);
  wheelZoom = 0;
  setZoom(z, null, true);
}, { passive: false, capture: true });

addEventListener('keydown', e => {
  if ($('dlg').open) return;
  if (cropping) {   // while cropping, only its own keys
    if (e.key === 'Enter') { e.preventDefault(); applyCrop(); }
    else if (e.key === 'Escape') { e.preventDefault(); endCrop(); }
    return;
  }
  if ($('menu').matches(':popover-open')) {   // the menu's own shortcuts act on its page
    const m = MENU.find(m => m && (m[2] === 'Shift+Del' ? e.key === 'Delete' && e.shiftKey : e.key.toLowerCase() === m[2].toLowerCase()));
    if (m && !(m[0] === 'trash' && pages.length < 2)) { e.preventDefault(); $('menu').hidePopover(); return m[3](menuPage); }
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); }
    else menuKey(e);
    return;
  }
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  const typing = e.target.matches('input:not([type="color"]), select, textarea');
  if (e.altKey || e.isComposing) return;
  if (mod) {
    const fn = k === 'z' && e.shiftKey ? redo : k === 's' && e.shiftKey ? () => save(true) : CTRL_KEYS[k];
    if (!fn || (typing && (k === 'z' || k === 'y' || k === 'v'))) return;   // text fields keep their own undo and paste
    e.preventDefault();
    return fn();
  }
  if (typing && k === 'escape' && e.target.closest('.pop')) { e.preventDefault(); return KEYS.escape(); }
  if (typing) return;
  if (k === 'delete' && e.shiftKey) { e.preventDefault(); const ids = thisPage(); return ids && deletePages(ids); }
  if (k === 'f' && e.shiftKey) { e.preventDefault(); return toggleFull(); }
  if (!e.shiftKey && (k === 'arrowdown' || k === 'arrowup')) { e.preventDefault(); return glideStart(k === 'arrowdown' ? 1 : -1); }
  if (!e.shiftKey && (k === 'arrowleft' || k === 'arrowright')) { e.preventDefault(); return stepPage(k === 'arrowright' ? 1 : -1); }
  const fn = KEYS[e.key === '?' ? '?' : k];
  if (!fn) return;
  e.preventDefault();
  fn();
});

setTool(tool);
$('pages').classList.toggle('spread', spread);
$('spread').setAttribute('aria-pressed', spread);

// First run: what Inkfold does to Chrome's PDF handling, file access, and privacy.
async function welcome() {
  const fileAccess = await chrome.runtime.sendMessage({ type: 'fileAccess' }).catch(() => true) ?? true;
  const settingsBtn = el2('button', { type: 'button', class: 'link' }, 'Open Inkfold’s settings');
  settingsBtn.onclick = () => chrome.runtime.sendMessage({ type: 'openSettings' });
  const list = el2('ul', {},
    el2('li', {}, el2('strong', {}, 'PDFs now open here. '), 'Any PDF you open in Chrome opens in Inkfold. To use Chrome’s own viewer again, right-click the Inkfold toolbar icon and untick “Open every PDF with Inkfold”.'),
    el2('li', {}, el2('strong', {}, 'Scanned PDFs become searchable. '), 'Inkfold reads the text of pages that have none, in the background, right on your computer.'),
    el2('li', {}, el2('strong', {}, 'Your files stay on your computer. '), 'Nothing is uploaded. Save writes over your original after you confirm, or makes a new copy if you pick another name.'),
    el2('li', {}, el2('strong', {}, 'Keyboard first. '), 'Hover over a button to see its shortcut. Press ? for the full list, and Ctrl+F to find text.'),
  );
  if (!fileAccess) {
    list.append(el2('li', {}, el2('strong', {}, 'PDFs on your computer: '), 'to open them straight from Chrome, turn on “Allow access to file URLs”. ', settingsBtn));
  }
  await ask({ title: 'Welcome to Inkfold', body: [para('Highlight, draw, type text with LaTeX, add notes, and rotate, delete or split pages, right in Chrome.'), list], ok: 'Get started', cancel: null });
  store.set('welcomed', true);
}
if (!store.get('welcomed', false) || location.search.startsWith('?welcome')) welcome();

// ?src=<url> comes from the toolbar button or the automatic PDF redirect; it is everything after "?src=".
const at = location.href.indexOf('?src=');
let src = at < 0 ? null : location.href.slice(at + 5);
if (src && /^[a-z]+%3a/i.test(src)) src = decodeURIComponent(src);
if (IN_PAGE) src = location.href;
if (src) {
  document.body.classList.add('opening');
  openUrl(src);
}
