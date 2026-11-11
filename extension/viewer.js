import * as pdfjs from './lib/pdf.min.mjs';
import { notePdf } from './notes.js';
import { layout, cached, svgOf, pdfOps, SIZES, PAD, cleanWith } from './textbox.js';

// The viewer runs either on its own extension page, or inside a web PDF's tab (opened in place by
// content.js, so the tab keeps its https:// address). Its own files always come from the extension.
const EXT = new URL('./', import.meta.url).href;
const IN_PAGE = location.protocol !== 'chrome-extension:';
await startWorker();

async function startWorker() {
  const src = EXT + 'lib/pdf.worker.min.mjs';
  pdfjs.GlobalWorkerOptions.workerSrc = src;
  if (!IN_PAGE) return;
  // A page can't start a worker from the extension's address, but it can from a copy of the script.
  // Local files (file://) have an opaque origin, where Chrome refuses module workers made from a copy;
  // there the same code runs as a classic worker, with its one export and its import.meta removed.
  // Without any worker pdf.js would read PDFs on the page's main thread ("Setting up fake worker").
  try {
    const code = await (await fetch(src)).text();
    const classic = code.replace(/export\s*\{\s*WorkerMessageHandler\s*\}\s*;?\s*$/, '').replaceAll('import.meta.url', JSON.stringify(src));
    const w = await tryWorker(code, { type: 'module' }) ?? await tryWorker(classic, {});
    if (w) pdfjs.GlobalWorkerOptions.workerPort = w;
  } catch {}
}

async function tryWorker(code, opts) {   // the worker, once it has started without a script error; else null
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  let w;
  try { w = new Worker(url, opts); } catch { return null; }
  const ok = await Promise.race([
    new Promise(r => setTimeout(() => r(true), 600)),
    new Promise(r => w.addEventListener('error', () => r(false), { once: true })),
  ]);
  if (!ok) w.terminate();
  return ok ? w : null;
}

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
//   { page, type: 'rect'|'ellipse', x1, y1, x2, y2, color, width }   (box = centre line of the stroke)
//   { page, type: 'highlight', rects: [[x1, y1, x2, y2], …], color }   (one box per line of text)
//   { page, type: 'text', x1, y2, text, size, color }   (x1, y2 = top-left corner; the size comes from textbox.js)
const docs = new Map();         // key -> { pdf, bytes, pages: [PDFPageProxy] }
const views = new Map();        // entry id -> on-screen page
let entries = [], pages = [], shapes = [], history = [], future = [], hovered = null, renderTimer, nextId = 1, loadId = 0, name;
let tool = 'select', sel = null, drag = null, pick = null, dirty = false, msgTimer;
let zoom = 1, fit = store.get('fit', 'auto'), spread = store.get('spread', false);
let lineWidth = store.get('width', 2);
// A few standard colours: light ones for the highlighter (ink shows through), strong ones for shapes and text.
const PALETTES = {
  highlight: [['Yellow', '#ffd400'], ['Green', '#9be28f'], ['Blue', '#8fc7ff'], ['Pink', '#ff9ccb'], ['Orange', '#ffb561']],
  ink: [['Red', '#e5484d'], ['Orange', '#e8590c'], ['Green', '#2f9e44'], ['Blue', '#2f6fe0'], ['Black', '#1f1f1f']],
};
const colors = { shape: '#e5484d', highlight: '#ffd400', text: '#1f1f1f', ...store.get('colors', {}) };
let textSize = store.get('textSize', 12), editing = null, lastPress = {}, pendingText = null, erasing = null, eraseHover = null;
const ocrBusy = new Set();      // main-document page indexes still waiting for text recognition
const ocrText = new Map();      // main-document page index -> text recognised on it (pdf.js text items, PDF points)
const snapshot = () => JSON.stringify({ entries, shapes });

/* ---------- loading ---------- */

async function loadDoc(key, data) {
  const pdf = await pdfjs.getDocument({ data: data.slice(), ...PDFJS_OPTS }).promise;   // pdf.js takes ownership of its copy
  const list = [];
  for (let n = 1; n <= pdf.numPages; n++) list.push(await pdf.getPage(n));
  const doc = { pdf, bytes: data, pages: list };
  docs.set(key, doc);
  return doc;
}

async function openPdf(buf, fileName) {
  if (dirty && !confirm('Discard the unsaved changes to the current PDF?')) return;
  const data = new Uint8Array(buf);
  const id = ++loadId;
  const old = [...docs.values()];
  let main;
  try {
    main = await loadDoc('main', data);
  } catch (e) {
    return fail(e.name === 'PasswordException' ? 'Password-protected PDFs are not supported.' : 'That could not be read as a PDF.');
  }
  if (id !== loadId) return;
  // Free the documents being replaced. (pdf.js 6 documents have no destroy(); their loading task does.)
  for (const d of old) if (d.pdf !== main.pdf) d.pdf.loadingTask?.destroy().catch(() => {});
  for (const [k] of docs) if (k !== 'main') docs.delete(k);
  io.disconnect();
  views.clear();
  [name, entries, shapes, history, future, sel, dirty] = [fileName, [], [], [], [], null, false];
  ocrText.clear();
  ocrBusy.clear();
  showOcr(null);
  $('notice').hidden = true;
  document.body.classList.add('loaded');

  const { info = {} } = await main.pdf.getMetadata().catch(() => ({}));
  const title = typeof info.Title === 'string' && info.Title.trim();
  document.title = title ? `${title} (${name})` : name;
  $('pages').setAttribute('aria-label', title || name);

  for (const [i, page] of main.pages.entries()) {
    const e = { id: nextId++, doc: 'main', i, rot: 0 };
    entries.push(e);
    // Annotations saved by an earlier session become editable again; pdf.js is told not to paint them.
    for (const a of await page.getAnnotations()) {
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
        });
      } else if (a.subtype === 'FreeText') {
        const [x1, , , y2] = a.rect, da = a.defaultAppearanceData ?? {};
        const fc = da.fontColor?.length === 3 ? '#' + [...da.fontColor].map(v => v.toString(16).padStart(2, '0')).join('') : colors.text;
        shapes.push({ page: e.id, type: 'text', x1, y1: y2, x2: x1, y2, text: a.contentsObj?.str ?? '', size: da.fontSize || 12, color: fc });
      } else continue;
      main.pdf.annotationStorage.setValue(a.id, { noView: true });
    }
  }
  layoutPages();
  setZoom(fitZoom(fit ?? 'auto'), fit);
  scrollTo(0, 0);
  say(info.EncryptFilterName ? 'This PDF is encrypted: you can annotate it, but it cannot be saved.' : '', true);

  // In the background: offer to compress a PDF that's much bigger than it needs to be (once per file),
  // and recognise the text on pages that have none, such as scans.
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

// A local PDF opened in its own tab: the page can't read its own file, so the extension reads it.
async function localBytes(src) {   // (reading it directly would only fail, with a CORS error in the console)
  const b64 = await chrome.runtime.sendMessage({ type: 'readFile', url: src });
  if (!b64) throw new Error('unreadable');
  const bin = atob(b64), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

async function openUrl(src) {
  try {
    const file = decodeURIComponent(new URL(src).pathname.split('/').pop()) || 'document.pdf';
    await openPdf(IN_PAGE && src.startsWith('file:') ? await localBytes(src) : await fetchBytes(src), file);
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
    if (p.visible) { render(p); textLayer(p); } else unrender(p);
  }
}, { rootMargin: '100% 0px' });

const rotationOf = p => (p.page.rotate + p.e.rot) % 360;

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
    p.num.textContent = `${k + 1}${p.e.doc === 'main' ? '' : ' · note'}`;
    p.div.setAttribute('aria-label', `Page ${k + 1}${p.e.doc === 'main' ? '' : ' (note)'}`);
    io.observe(p.div);
  });
  $('count').textContent = `${pages.length} page${pages.length === 1 ? '' : 's'}`;
  showPage();
}

function size(p) {
  p.vp = p.page.getViewport({ scale: zoom * CSS_PER_PT, rotation: rotationOf(p) });
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
  const key = zoom + '|' + rotationOf(p);
  if (p.at === key || p.want === key) return;
  p.task?.cancel();
  p.want = key;
  // Render at device resolution, but keep any one canvas under ~16 megapixels.
  const k = Math.min(devicePixelRatio || 1, Math.sqrt(16e6 / (p.vp.width * p.vp.height)));
  const viewport = p.page.getViewport({ scale: zoom * CSS_PER_PT * k, rotation: rotationOf(p) });
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
  })();
}

/* ---------- recognising text (OCR) ---------- */

// Pages without text of their own (scans, photos of pages) are read by Tesseract, in the extension's hidden
// helper page, one page at a time. What it finds becomes an ordinary text layer, so it can be selected,
// searched, highlighted and read by assistants, and it's saved into copies as invisible text.
const OCR_STYLES = { ocr: { fontFamily: 'sans-serif', ascent: 0.8, descent: -0.2, vertical: false } };
let ocrStop = false;

function showOcr(state) {   // null hides it; otherwise { done, total }
  const box = $('ocr');
  box.hidden = !state;
  if (!state) return;
  const pct = Math.round(100 * state.done / state.total);
  $('ocrLabel').textContent = `Recognising text · page ${Math.min(state.done + 1, state.total)} of ${state.total}`;
  $('ocrBar').style.width = Math.max(4, pct) + '%';
  box.querySelector('.bar').setAttribute('aria-valuenow', pct);
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
  if (!todo.length) return;   // the PDF already has its text
  ocrStop = false;
  todo.forEach(i => ocrBusy.add(i));
  let done = 0, found = 0;
  showOcr({ done, total: todo.length });
  for (const i of todo) {
    if (id !== loadId || ocrStop) break;
    let result, vp;
    try {
      const shot = await pageImage(main.pages[i]);
      vp = shot.vp;
      result = await chrome.runtime.sendMessage({ type: 'ocr', image: shot.image });
    } catch (e) { result = { error: String(e) }; }
    if (id !== loadId) return;
    if (!result || result.error) {
      showOcr(null);
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
    showOcr({ done: ++done, total: todo.length });
  }
  ocrBusy.clear();
  showOcr(null);
  if (id !== loadId) return;
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

// Tesseract's words (image pixels) -> pdf.js text items (PDF points). Each word carries the space after it,
// and spans up to the next word, so selecting a line copies it as one line of text.
function ocrItems(lines, vp) {
  const items = [];
  for (const line of lines ?? []) {
    const H = line.b[3] - line.b[1];
    if (H <= 2) continue;
    const base = line.b[3] - 0.2 * H;
    line.words.forEach((w, k) => {
      const next = line.words[k + 1];
      const x0 = w.b[0], x1 = next ? next.b[0] : w.b[2];
      const [ox, oy] = vp.convertToPdfPoint(x0, base), [ex, ey] = vp.convertToPdfPoint(x1, base), [tx, ty] = vp.convertToPdfPoint(x0, base - H);
      const width = Math.hypot(ex - ox, ey - oy), size = Math.hypot(tx - ox, ty - oy), a = Math.atan2(ey - oy, ex - ox);
      const cos = Math.cos(a), sin = Math.sin(a);
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
}

/* ---------- offering to compress ---------- */

const fmtSize = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB');

// Once per file (remembered by its fingerprint), check how much smaller it could be; if that's more
// than a fifth, offer it. Compressing swaps in the smaller version for the copies you save.
async function checkCompression(id, encrypted) {
  const main = docs.get('main'), fp = main.pdf.fingerprints?.[0];
  const seen = store.get('compressChecked', []);
  if (encrypted || !fp || seen.includes(fp) || main.bytes.length < 100_000) return;
  await new Promise(r => setTimeout(r, 1500));   // let the first pages draw first
  if (id !== loadId) return;
  let smaller;
  try { smaller = await (await import('./compress.js')).compressPdf(main.bytes); } catch { return; }
  if (id !== loadId) return;
  store.set('compressChecked', [...seen.slice(-299), fp]);
  const before = main.bytes.length, after = smaller.length, saved = 1 - after / before;
  if (saved <= 0.2) return;
  notice({
    text: `This PDF could be ${Math.round(saved * 100)}% smaller (${fmtSize(before)} → ${fmtSize(after)}), mostly by storing its images more efficiently. Compress it?`,
    yes: 'Compress', no: 'Not now',
    onYes: () => {
      if (id !== loadId) return;
      main.bytes = smaller;
      dirty = true;
      say(`Compressed. Copies you save are now about ${fmtSize(after)}. Your original file isn’t changed.`, { action: { label: 'Save a copy', fn: save } });
    },
  });
}

function notice({ text, yes, no, onYes }) {
  $('noticeText').textContent = text;
  $('noticeYes').textContent = yes;
  $('noticeNo').textContent = no;
  $('noticeYes').onclick = () => { $('notice').hidden = true; onYes(); };
  $('noticeNo').onclick = () => { $('notice').hidden = true; };
  $('notice').hidden = false;
}

/* ---------- zoom and layout ---------- */

function fitZoom(mode) {   // sized so that the widest / tallest page fits, so mixed page sizes never scroll sideways
  const dims = pages.map(p => p.page.getViewport({ scale: CSS_PER_PT, rotation: rotationOf(p) }));
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
function setZoom(z, mode = null, lazy = false) {
  if (!pages.length) return;
  keepPlace(() => {
    fit = mode;
    zoom = clamp(z, 0.1, 5);
    pages.forEach(size);
  }, mode === 'page' && !lazy);
  settle(lazy ? 250 : 0);
  store.set('fit', mode ?? 'auto');
  const box = $('zoom'), preset = ZOOMS.find(v => Math.abs(v - zoom) < 1e-3);
  if (mode === 'width' || mode === 'page') box.value = mode;
  else if (preset) box.value = String(preset);
  else { $('custom').textContent = Math.round(zoom * 100) + '%'; box.value = 'custom'; }
}

function relayout() {   // after pages were added, removed or rotated
  const live = new Set(entries.map(e => e.id));
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

async function addNote(after = currentIndex()) {
  if (!pages.length) return;
  const md = await noteSource(after);
  if (!md?.trim()) return;
  say('Adding note…', true);
  // As wide as the page it follows; as tall as the note needs.
  const ref = pages[after], { width, height } = ref.page.getViewport({ scale: 1, rotation: rotationOf(ref) });
  const key = 'note' + nextId++;
  const doc = await loadDoc(key, await notePdf(md, Math.round(width), Math.round(height), { fit: true }));
  const added = doc.pages.map((_, i) => ({ id: nextId++, doc: key, i, rot: 0 }));
  changePages(() => { entries.splice(after + 1, 0, ...added); });
  doc.pages.forEach((_, i) => textLayer(views.get(added[i].id)));
  views.get(added[0].id).div.scrollIntoView({ block: 'start' });
  say(added.length > 1 ? `Added a ${added.length}-page note after page ${after + 1}.` : `Added a note after page ${after + 1}.`,
    { action: { label: 'Undo', fn: undo } });
}

// Where the note comes from: typed here, or the clipboard (offered only when it holds text).
async function noteSource(after) {
  let clip = '', blocked = false;
  try { clip = (IN_PAGE ? await chrome.runtime.sendMessage({ type: 'readClipboard' }) : await navigator.clipboard.readText()) ?? ''; }
  catch { blocked = true; }
  const has = !!clip.trim();
  const rClip = el2('input', { type: 'radio', name: 'noteSrc', value: 'clip' });
  const rType = el2('input', { type: 'radio', name: 'noteSrc', value: 'type' });
  const ta = el2('textarea', {
    class: 'notetext', rows: '8', spellcheck: 'true', 'aria-label': 'Your note',
    placeholder: '# A heading\n\nSome **bold** text, a list:\n- one\n- two\n\nand math, like $E = mc^2$.',
  });
  rClip.disabled = !has;
  rClip.checked = has;
  rType.checked = !has;
  const update = () => { $('dlgOk').disabled = rType.checked ? !ta.value.trim() : !has; };
  for (const r of [rClip, rType]) r.onchange = () => { update(); if (rType.checked) ta.focus(); };
  ta.addEventListener('focus', () => { rType.checked = true; update(); });
  ta.addEventListener('input', update);
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !$('dlgOk').disabled) { e.preventDefault(); $('dlgOk').click(); } });
  const clipNote = blocked ? 'Chrome didn’t let Inkfold read the clipboard.' : has ? '' : 'Your clipboard has no text.';
  const body = [
    el2('label', { class: 'opt' + (has ? '' : ' off') }, rClip, el2('span', {}, el2('strong', {}, 'Use the clipboard'), el2('small', {}, clipNote || 'The Markdown you copied, as it is.'))),
    ...(has ? [el2('div', { class: 'preview' }, clip.length > 400 ? clip.slice(0, 400) + '…' : clip)] : []),
    el2('label', { class: 'opt' }, rType, el2('span', {}, el2('strong', {}, 'Type a note'), el2('small', {}, 'Markdown and LaTeX ($…$) work here too. Ctrl+Enter adds it.'))),
    ta,
  ];
  const answer = ask({ title: `Add a note after page ${after + 1}`, body, ok: 'Add note', wide: true });
  update();
  if (!has) ta.focus();
  const ok = await answer;
  $('dlgOk').disabled = false;
  return ok ? (rType.checked ? ta.value : clip) : null;
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

async function split() {
  let groups;
  try { groups = parseRanges($('splitRanges').value, entries.length); $('panelMsg').textContent = ''; }
  catch (e) { $('panelMsg').textContent = e.message; return; }
  const base = name.replace(/\.pdf$/i, '');
  let dir = null;
  if (window.showDirectoryPicker) {   // pick the folder once, for all the files
    try { dir = await showDirectoryPicker({ id: 'pdf-shapes-split', mode: 'readwrite', startIn: 'downloads' }); }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  $('panel').hidePopover();
  try {
    const written = [];
    for (const [k, g] of groups.entries()) {
      say(`Splitting… ${k + 1} of ${groups.length}`, true);
      const out = await build(g.idx.map(i => entries[i]));
      const file = `${base} (pages ${g.label}).pdf`;
      if (dir) written.push(await writeInto(dir, file, out));
      else { download(out, file); written.push(file); }
    }
    say(dir ? `Saved ${written.length} files in “${dir.name}”.` : `Saved ${written.length} files to your downloads.`);
  } catch (e) {
    say(/encrypt/i.test(e.message) ? 'This PDF is encrypted, so it cannot be split.' : 'Could not split: ' + e.message, true);
  }
}

async function writeInto(dir, file, data) {   // never overwrite: "x.pdf" -> "x (2).pdf"
  let pick = file;
  for (let n = 2; ; n++) {
    try { await dir.getFileHandle(pick); } catch { break; }
    pick = file.replace(/\.pdf$/, ` (${n}).pdf`);
  }
  const w = await (await dir.getFileHandle(pick, { create: true })).createWritable();
  await w.write(data);
  await w.close();
  return pick;
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
    const v = view(p, [s.x1, s.y1, s.x2, s.y2]), w = s.width * p.vp.scale;
    const [tag, geo] = s.type === 'rect'
      ? ['rect', { x: v.x, y: v.y, width: v.w, height: v.h }]
      : ['ellipse', { cx: v.x + v.w / 2, cy: v.y + v.h / 2, rx: v.w / 2, ry: v.h / 2 }];
    over.push(el(tag, { ...geo, class: s === eraseHover ? 'shape erasing' : 'shape', fill: 'none', stroke: s.color, 'stroke-width': w }));
    over.push(el(tag, { ...geo, class: 'hit', 'data-i': i, 'stroke-width': Math.max(w, 10) }));   // easier to grab
    if (s !== sel) return;
    over.push(el('rect', { class: 'outline', x: v.x, y: v.y, width: v.w, height: v.h }));
    for (let h = 0; h < 4; h++) {   // corners: 0 top-left, 1 top-right, 2 bottom-left, 3 bottom-right
      over.push(el('rect', {
        class: 'handle', 'data-h': h, width: 9, height: 9,
        x: v.x + (h % 2) * v.w - 4.5, y: v.y + (h >> 1) * v.h - 4.5,
        style: `cursor:${h % 3 ? 'nesw' : 'nwse'}-resize`,
      }));
    }
  });
  p.hl.replaceChildren(...under);
  p.svg.replaceChildren(...over);
  if (editing?.p === p) placeEditor();
}

/* ---------- eraser ---------- */

// Does the eraser at (x, y), PDF points, touch this annotation? Shapes are caught by their outline,
// highlights and text boxes anywhere inside.
function touches(s, x, y, tol) {
  const inBox = ([a, b, c, d], m) => x >= a - m && x <= c + m && y >= b - m && y <= d + m;
  if (s.type === 'highlight') return s.rects.some(r => inBox(r, tol));
  const box = boxOf(s);
  if (s.type === 'text') return inBox(box, tol);
  const m = (s.width || 1) / 2 + tol, [a, b, c, d] = box;
  if (s.type === 'rect') return inBox(box, m) && !(x > a + m && x < c - m && y > b + m && y < d - m);
  const cx = (a + c) / 2, cy = (b + d) / 2, rx = Math.max((c - a) / 2, 1e-3), ry = Math.max((d - b) / 2, 1e-3);
  return Math.abs(Math.hypot((x - cx) / rx, (y - cy) / ry) - 1) * Math.min(rx, ry) <= m;
}

const underEraser = (e, p) => {
  const [x, y] = point(e, p), tol = 6 / p.vp.scale;   // a few pixels of slack, whatever the zoom
  return shapes.findLast(s => s.page === p.id && touches(s, x, y, tol)) ?? null;
};

function eraseAt(e, p) {
  const [x, y] = point(e, p), tol = 6 / p.vp.scale;
  const hit = shapes.filter(s => s.page === p.id && touches(s, x, y, tol));
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
  for (const ev of ['pointerdown', 'mousedown', 'dblclick']) ta.addEventListener(ev, e => e.stopPropagation());
  editing = { p, s, before, ta };
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

function finishEdit() {
  if (!editing) return;
  const { s, before, ta } = editing;
  editing = null;
  const text = ta.value.replace(/\s+$/, '');
  ta.remove();
  if (text.trim()) s.text = text;
  else {   // an empty box is removed
    const i = shapes.indexOf(s);
    if (i >= 0) shapes.splice(i, 1);
    if (sel === s) sel = null;
  }
  if (snapshot() !== before) commit(before);
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
    drag = { anchor: p.vp.convertToPdfPoint(v.x + (k % 2) * v.w, v.y + (k >> 1) * v.h) };
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
    const s = old?.type === 'text' ? old : { page: p.id, type: 'text', x1: at[0], y1: at[1], x2: at[0], y2: at[1], text: '', size: textSize, color: colors.text };
    pendingText = { p, s, fresh: s !== old };   // opened on release: the press itself still moves the focus
    return;
  } else if (tool === 'rect' || tool === 'ellipse') {  // draw a new one
    sel = { page: p.id, type: tool, x1: at[0], y1: at[1], x2: at[0], y2: at[1], color: colors.shape, width: lineWidth };
    shapes.push(sel);
    drag = { anchor: at, fresh: true };
  } else return;
  Object.assign(drag, { p, before });
  p.svg.setPointerCapture(e.pointerId);
  repaint();
  e.preventDefault();
}

function move(e) {
  if (erasing) return eraseAt(e, erasing.p);
  if (!drag) return;
  const [x, y] = point(e, drag.p);
  if (drag.anchor) {
    const [ax, ay] = drag.anchor;
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
}

const kind = () => { const t = sel ? sel.type : tool; return t === 'highlight' || t === 'text' ? t : 'shape'; };

const palette = () => PALETTES[kind() === 'highlight' ? 'highlight' : 'ink'];
const curColor = () => (sel?.color ?? colors[kind()]).toLowerCase();

function syncControls() {   // the colour and thickness boxes show the selection, or the defaults for the tool
  // With the select tool and nothing selected there's nothing to style, so the controls are hidden.
  const styling = (tool !== 'select' && tool !== 'eraser') || !!sel;
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
}

function redo() {
  if (!future.length) return say('Nothing to redo.');
  history.push(snapshot());
  restore(future.pop());
}

function setTool(t) {
  finishEdit();
  if (eraseHover) { eraseHover = null; repaint(); }
  if (t === 'eraser') select(null);
  tool = document.body.dataset.tool = t;
  for (const b of document.querySelectorAll('button[data-tool]')) b.setAttribute('aria-pressed', b.dataset.tool === t);
  if (t === 'highlight') highlightSelection();   // text already selected? highlight it straight away
  syncControls();
}

/* ---------- saving ---------- */

async function save() {
  finishEdit();
  if (!docs.has('main')) return;
  const suggestedName = name.replace(/\.pdf$/i, '') + '-annotated.pdf';
  let handle = null;
  if (window.showSaveFilePicker) {   // ask for a name and folder first, while the click still counts as a user action
    try {
      handle = await showSaveFilePicker({
        suggestedName, id: 'pdf-shapes', startIn: 'downloads',
        types: [{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }],
      });
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  say('Saving…', true);
  try {
    const out = await build(entries);
    if (handle) {
      const w = await handle.createWritable();
      await w.write(out);
      await w.close();
      say(firstTime('tip-save') ? `Saved “${handle.name}”. Your original PDF is unchanged.` : `Saved “${handle.name}”.`);
    } else {
      download(out, suggestedName);
      say('Saved a copy to your downloads.');
    }
    dirty = false;
  } catch (e) {
    say(/encrypt/i.test(e.message) ? 'This PDF is encrypted, so it cannot be saved.' : 'Could not save: ' + e.message, true);
  }
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
  const doc = await PDFDocument.load(docs.get('main').bytes, { updateMetadata: false });
  const ctx = doc.context, N = PDFName.of;
  const round = v => +v.toFixed(2), num = (...v) => v.map(round).join(' ');
  const orig = doc.getPages();

  const copied = new Map();   // note pages, copied in from their own small PDFs
  for (const key of new Set(list.map(e => e.doc))) {
    if (key === 'main') continue;
    const src = await PDFDocument.load(docs.get(key).bytes);
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
  }
  // Drop the annotations from an earlier session; the current set is written back below.
  for (const pg of out) {
    const annots = pg.node.Annots();
    for (let i = (annots?.size() ?? 0) - 1; i >= 0; i--) {
      const d = annots.lookup(i);
      if (!(d instanceof PDFDict)) continue;
      const author = d.lookup(N('T')), kind = d.lookup(N('Subtype'));
      if (!(author instanceof PDFString || author instanceof PDFHexString) || !MARKS.includes(author.decodeText())) continue;
      if ([N('Square'), N('Circle'), N('Highlight'), N('FreeText')].includes(kind)) annots.remove(i);
    }
  }

  // Real Square / Circle / Highlight annotations, each with its own appearance so every viewer draws it the same.
  const target = new Map(list.map((e, k) => [e.id, out[k]]));
  for (const s of shapes) {
    const pg = target.get(s.page);
    if (!pg) continue;
    const rgb = [1, 3, 5].map(i => +(parseInt(s.color.slice(i, i + 2), 16) / 255).toFixed(3));
    let dict, extra = { C: rgb };
    if (s.type === 'text') {
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
      const look = ctx.stream(`${w} w ${rgb.join(' ')} RG ${path} S`, { Type: 'XObject', Subtype: 'Form', BBox: box });
      dict = { Subtype: s.type === 'rect' ? 'Square' : 'Circle', Rect: box, BS: { W: w }, AP: { N: ctx.register(look) } };
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
  trash: '<svg viewBox="0 0 16 16"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.8 9.5h6.4L12 4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
};

async function openFile(f) {
  if (!f) return;
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
addEventListener('scroll', () => { if (!pageTimer) pageTimer = requestAnimationFrame(() => { pageTimer = 0; showPage(); }); }, { passive: true });
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
  document.querySelectorAll(':popover-open').forEach(x => x.hidePopover());
  el.style.top = header.getBoundingClientRect().bottom + 6 + 'px';
  if (id === 'panel') {   // set up before showing, so nothing changes the fields while you type
    $('panelMsg').textContent = '';
  }
  el.showPopover();
  if (field) $(field).select();
}

const thisPage = () => (pages.length ? new Set([pages[targetIndex()].id]) : null);

for (const b of document.querySelectorAll('button[data-tool]')) b.onclick = () => setTool(b.dataset.tool);
for (const b of $('widths').querySelectorAll('button')) b.onclick = () => setWidth(+b.dataset.w);
$('ocrStop').onclick = () => { ocrStop = true; showOcr(null); };
$('tsmaller').onclick = () => setTextSize(-1);
$('tbigger').onclick = () => setTextSize(1);
// The size buttons don't take focus, so a text box being typed in stays open.
for (const id of ['tsmaller', 'tbigger']) $(id).addEventListener('mousedown', e => e.preventDefault());
$('undo').onclick = undo;
$('redo').onclick = redo;
$('zin').onclick = () => step(1);
$('zout').onclick = () => step(-1);
$('zoom').onchange = e => {
  const v = e.target.value;
  if (v === 'width' || v === 'page') setZoom(fitZoom(v), v);
  else if (v !== 'custom') setZoom(+v);
};
$('spread').onclick = () => setSpread(!spread);
$('full').onclick = toggleFull;

// Full screen: the whole viewer, toolbar included. The same button (or Shift+F, or Esc) leaves it.
function toggleFull() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => say('Chrome didn’t allow full screen here. Try F11 instead.'));
}
addEventListener('fullscreenchange', () => {
  const on = !!document.fullscreenElement;
  document.body.classList.toggle('full', on);
  $('full').setAttribute('aria-pressed', on);
  const label = on ? 'Exit full screen (Shift+F or Esc)' : 'Full screen (Shift+F)';
  $('full').title = label;
  $('full').setAttribute('aria-label', label);
});
$('note').onclick = () => addNote();
$('pagesBtn').onclick = () => togglePanel('panel', 'range');
$('keysBtn').onclick = () => togglePanel('keys');
$('save').onclick = save;
$('open').onclick = () => $('file').click();
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
$('split').onclick = split;
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
  $('menuTitle').textContent = `Page ${pages.indexOf(p) + 1} of ${pages.length}${p.e.doc === 'main' ? '' : ' · note'}`;
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
addEventListener('drop', e => { e.preventDefault(); if (!docs.has('main')) openFile(e.dataTransfer.files[0]); });
addEventListener('beforeunload', e => { if (dirty) e.preventDefault(); });
let resizing;
addEventListener('resize', () => {
  cancelAnimationFrame(resizing);
  resizing = requestAnimationFrame(() => fit && setZoom(fitZoom(fit), fit, true));
});

// Every shortcut, in one place. Keys listed in the buttons' labels and in the ? sheet.
const KEYS = {
  'v': () => setTool('select'), 'h': () => setTool('highlight'), 'r': () => setTool('rect'), 'o': () => setTool('ellipse'), 't': () => setTool('text'), 'e': () => setTool('eraser'),
  '-': () => setTextSize(-1), '=': () => setTextSize(1), '+': () => setTextSize(1),
  'c': nextColor,
  '1': () => setWidth(1), '2': () => setWidth(2), '3': () => setWidth(4),
  'w': () => setZoom(fitZoom('width'), 'width'), 'f': () => setZoom(fitZoom('page'), 'page'),
  'd': () => setSpread(!spread),
  'n': () => addNote(targetIndex() >= 0 ? targetIndex() : undefined),
  'p': () => togglePanel('panel', 'range'),
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
  's': save, 'o': () => docs.has('main') || $('file').click(),   // with a PDF open, there's no opening another one here
  'z': undo, 'y': redo,
  '=': () => step(1), '+': () => step(1), '-': () => step(-1), '0': () => setZoom(1),
};

addEventListener('keydown', e => {
  if ($('dlg').open) return;
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
    const fn = k === 'z' && e.shiftKey ? redo : CTRL_KEYS[k];
    if (!fn || (typing && (k === 'z' || k === 'y'))) return;   // text boxes keep their own undo
    e.preventDefault();
    return fn();
  }
  if (typing && k === 'escape' && e.target.closest('.pop')) { e.preventDefault(); return KEYS.escape(); }
  if (typing) return;
  if (k === 'delete' && e.shiftKey) { e.preventDefault(); const ids = thisPage(); return ids && deletePages(ids); }
  if (k === 'f' && e.shiftKey) { e.preventDefault(); return toggleFull(); }
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
    el2('li', {}, el2('strong', {}, 'Your files stay on your computer. '), 'Nothing is uploaded. Saving makes a new copy; your original PDF is never changed.'),
    el2('li', {}, el2('strong', {}, 'Keyboard first. '), 'Every button shows its shortcut in brackets. Press ? for the full list.'),
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
