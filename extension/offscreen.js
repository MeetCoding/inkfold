// Hidden helper page for the background script.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'offscreen:ocr') { ocr(msg.image).then(reply, e => reply({ error: String(e?.message ?? e) })); return true; }
  if (msg?.type === 'offscreen:readClipboardImage') { readClipboardImage().then(reply, () => reply(null)); return true; }
  if (msg?.type === 'offscreen:clipboardStamp') { reply(clipboardStamp()); return false; }
  if (msg?.type !== 'offscreen:readClipboard') return false;
  const box = document.getElementById('paste');
  box.value = '';
  box.focus();
  document.execCommand('paste');
  reply(box.value);
  return false;
});

// Text recognition (OCR) runs in a worker of its own (ocr/worker.js), with PaddleOCR's models on ONNX Runtime,
// all bundled with the extension, so nothing is downloaded and no image leaves the computer. One worker is shared
// by every tab; it reads pages one at a time, in the order they're asked for.
let worker = null, nextJob = 0, idle = 0;
const waiting = new Map();
function ocr(image) {
  clearTimeout(idle);
  if (!worker) {
    worker = new Worker('ocr/worker.js', { type: 'module' });
    worker.onmessage = ({ data }) => {
      const w = waiting.get(data.id);
      waiting.delete(data.id);
      data.error ? w?.no(new Error(data.error)) : w?.ok(data.result);
      // A minute with nothing to read: let the worker go, giving back the memory its models and threads use.
      if (!waiting.size) idle = setTimeout(() => { if (!waiting.size) { worker?.terminate(); worker = null; } }, 60_000);
    };
    worker.onerror = e => {   // it couldn't start, or it broke: let it go (a fresh one starts with the next page)
      for (const w of waiting.values()) w.no(new Error(e.message || 'The text recognition worker stopped.'));
      waiting.clear();
      worker?.terminate();
      worker = null;
    };
  }
  const id = ++nextJob;
  return new Promise((ok, no) => { waiting.set(id, { ok, no }); worker.postMessage({ type: 'ocr', id, image }); });
}

// An image on the clipboard (a screenshot, a copied picture), as a data: URL, or null. Pasting into this
// hidden page hands it over without Chrome asking on behalf of the website the PDF came from.
// A cheap fingerprint of the clipboard, for noticing that something new was copied: its text, and for a picture
// just its type and size (reading the picture itself is only done when it's offered).
function clipboardStamp() {
  const box = document.getElementById('paste');
  let pic = '';
  const take = e => {
    const f = [...(e.clipboardData?.items ?? [])].find(i => i.kind === 'file' && i.type.startsWith('image/'))?.getAsFile();
    if (f) pic = f.type + ':' + f.size;
  };
  box.value = '';
  box.addEventListener('paste', take, { once: true });
  box.focus();
  document.execCommand('paste');
  box.removeEventListener('paste', take);
  const text = box.value;
  box.value = '';
  return { text, pic };
}

function readClipboardImage() {
  const box = document.getElementById('paste');
  let file = null;
  const take = e => {
    e.preventDefault();
    file = [...(e.clipboardData?.items ?? [])].find(i => i.kind === 'file' && i.type.startsWith('image/'))?.getAsFile() ?? null;
  };
  box.addEventListener('paste', take, { once: true });
  box.focus();
  document.execCommand('paste');
  box.removeEventListener('paste', take);
  if (!file) return Promise.resolve(null);
  return new Promise(ok => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => ok(null); r.readAsDataURL(file); });
}
