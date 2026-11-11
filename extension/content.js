// Runs on web pages and local files. If the page is a PDF (and automatic opening is on, or the toolbar icon is clicked),
// it replaces Chrome's built-in PDF viewer with Inkfold in the same tab. Other pages are left alone.
(() => {
  if (window.top !== window || document.contentType !== 'application/pdf' || !/^(https?|file):$/.test(location.protocol)) return;

  let started = false;
  async function start() {
    if (started) return true;
    started = true;
    // Hide Chrome's own viewer straight away, in Inkfold's background colour, so it doesn't flash up first.
    const cover = document.createElement('style');
    cover.textContent = 'html { background: #ebe9e4 !important } body > * { visibility: hidden !important }'
      + '@media (prefers-color-scheme: dark) { html { background: #1b1b19 !important } }';
    document.documentElement.append(cover);
    const base = chrome.runtime.getURL('');
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
    document.replaceChild(document.adoptNode(doc.documentElement), document.documentElement);
    await import(base + 'viewer.js');
    return true;
  }

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg?.type !== 'inkfold:open') return false;
    start().then(reply, () => reply(false));
    return true;
  });
  chrome.storage.local.get({ auto: true }).then(({ auto }) => { if (auto) start(); });
})();
