// Runs on web pages and local files. If the page is a PDF (and automatic opening is on, or the toolbar icon is clicked),
// it replaces Chrome's built-in PDF viewer with Inkfold in the same tab. Other pages are left alone.
(() => {
  if (window.top !== window || document.contentType !== 'application/pdf' || !/^(https?|file):$/.test(location.protocol)) return;

  let started = false;
  async function start() {
    if (started) return true;
    started = true;
    try { return await takeOver(); }
    catch {   // e.g. the extension was updated while this tab was open: give Chrome's own viewer back
      document.getElementById('inkfold-cover')?.remove();
      if (!document.querySelector('body.loaded, body.opening')) { started = false; return false; }
      try { sessionStorage.setItem('inkfold-failed', '1'); } catch {}   // reload once, into Chrome's viewer
      location.reload();
      return false;
    }
  }

  async function takeOver() {
    // Hide Chrome's own viewer straight away, in Inkfold's background colour, so it doesn't flash up first.
    const cover = document.createElement('style');
    cover.id = 'inkfold-cover';
    cover.textContent = 'html { background: #ebe9e4 !important } body > * { visibility: hidden !important }'
      + '@media (prefers-color-scheme: dark) { html { background: #1b1b19 !important } }';
    document.documentElement.append(cover);
    const base = chrome.runtime.getURL('');

    // Everything the viewer will need starts now, side by side, rather than one after another once it runs:
    // the PDF reader's worker, the PDF reader itself, and (for a file on this computer) the file's bytes.
    globalThis.inkfoldEarly = {
      worker: startWorker(base + 'lib/pdf.worker.min.mjs'),
      bytes: location.protocol === 'file:' ? quiet(readLocal(base)) : null,
      started: performance.now(),
    };
    globalThis.inkfoldReadLocal = () => readLocal(base);   // the file again, later (to check what Save wrote)
    import(base + 'lib/pdf.min.mjs').catch(() => {});

    const get = file => fetch(base + file).then(r => r.text());
    const [html, css] = await Promise.all([get('viewer.html'), get('viewer.css')]);
    if (document.readyState === 'loading') await new Promise(r => document.addEventListener('DOMContentLoaded', r, { once: true }));
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const el of doc.querySelectorAll('[href], [src]')) {   // the viewer's own files live in the extension
      for (const attr of ['href', 'src']) if (el.hasAttribute(attr)) el.setAttribute(attr, new URL(el.getAttribute(attr), base).href);
    }
    doc.querySelectorAll('script').forEach(s => s.remove());
    // Styles also go in inline, so the viewer is never seen unstyled (the link stays, in case a site's policy blocks
    // inline styles). It starts on placeholder pages, not on "Open a PDF".
    doc.querySelector('link[rel="stylesheet"]').before(Object.assign(doc.createElement('style'), { textContent: css }));
    doc.body.classList.add('opening');
    // Swap in the viewer's head and body, keeping the page's root: the file reader's frame (for a local PDF)
    // hangs off the root, so it isn't torn down while it's still reading.
    const root = document.documentElement;
    for (const a of [...root.attributes]) root.removeAttribute(a.name);
    for (const a of doc.documentElement.attributes) root.setAttribute(a.name, a.value);
    cover.remove();
    root.querySelectorAll(':scope > head, :scope > body').forEach(n => n.remove());
    root.prepend(document.adoptNode(doc.head), document.adoptNode(doc.body));
    await import(base + 'viewer.js');
    return true;
  }

  const quiet = p => { p.catch(() => {}); return p; };   // the viewer handles a failure; nothing to report here

  // pdf.js reads PDFs in a worker. A page can't start a worker from the extension's address, but it can from a copy
  // of the script. Local files (file://) have an opaque origin, where Chrome refuses module workers made from a copy;
  // there the same code runs as a classic worker, with its one export and its import.meta removed.
  async function startWorker(src) {
    try {
      const code = await (await fetch(src)).text();
      const w = await tryWorker(code, { type: 'module' });
      if (w) return w;
      const classic = code.replace(/export\s*\{\s*WorkerMessageHandler\s*\}\s*;?\s*$/, '').replaceAll('import.meta.url', JSON.stringify(src));
      return await tryWorker(classic, {});
    } catch { return null; }
  }

  function tryWorker(code, opts) {   // the worker once it says it's ready (pdf.js workers do, first thing); null if it fails
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    let w;
    try { w = new Worker(url, opts); } catch { return null; }
    return new Promise(done => {
      const end = ok => { clearTimeout(t); w.removeEventListener('message', yes); w.removeEventListener('error', no); if (!ok) w.terminate(); done(ok ? w : null); };
      const yes = () => end(true), no = () => end(false);
      const t = setTimeout(yes, 4000);   // no word either way: assume it works, as pdf.js itself would
      w.addEventListener('message', yes);
      w.addEventListener('error', no);
    });
  }

  // A file:// page can't read its own file. A small extension page, in a hidden frame, reads it (Chrome lets
  // extensions read local files when "Allow access to file URLs" is on) and hands the bytes over directly.
  function readLocal(base) {
    return new Promise((ok, no) => {
      const frame = document.createElement('iframe');
      frame.src = base + 'reader.html';
      frame.hidden = true;
      frame.setAttribute('aria-hidden', 'true');
      const timer = setTimeout(() => end(null), 20000);
      function end(buf) {
        clearTimeout(timer);
        removeEventListener('message', got);
        frame.remove();
        buf ? ok(buf) : no(new Error('unreadable'));
      }
      function got(e) {
        if (e.source !== frame.contentWindow || e.data?.inkfold !== 'file') return;
        end(e.data.bytes instanceof ArrayBuffer && e.data.bytes.byteLength ? e.data.bytes : null);
      }
      addEventListener('message', got);
      document.documentElement.append(frame);
    });
  }

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg?.type !== 'inkfold:open') return false;
    start().then(reply, () => reply(false));
    return true;
  });
  let failedBefore = false;   // Inkfold couldn't take this tab over last time: leave it to Chrome until asked
  try { failedBefore = sessionStorage.getItem('inkfold-failed') === '1'; sessionStorage.removeItem('inkfold-failed'); } catch {}
  if (!failedBefore) chrome.storage.local.get({ auto: true }).then(({ auto }) => { if (auto) start(); }).catch(() => {});
})();
