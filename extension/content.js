// Runs on web pages. If the page is a PDF (and automatic opening is on, or the toolbar icon is clicked),
// it replaces Chrome's built-in PDF viewer with Inkfold in the same tab. Other pages are left alone.
(() => {
  if (window.top !== window || document.contentType !== 'application/pdf' || !/^https?:$/.test(location.protocol)) return;

  let started = false;
  async function start() {
    if (started) return true;
    started = true;
    if (document.readyState === 'loading') await new Promise(r => document.addEventListener('DOMContentLoaded', r, { once: true }));
    const base = chrome.runtime.getURL('');
    const html = await (await fetch(base + 'viewer.html')).text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const el of doc.querySelectorAll('[href], [src]')) {   // the viewer's own files live in the extension
      for (const attr of ['href', 'src']) if (el.hasAttribute(attr)) el.setAttribute(attr, new URL(el.getAttribute(attr), base).href);
    }
    doc.querySelectorAll('script').forEach(s => s.remove());
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
