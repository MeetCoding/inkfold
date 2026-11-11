// Hidden helper page for the background script.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'offscreen:ocr') { ocr(msg.image).then(reply, e => reply({ error: String(e?.message ?? e) })); return true; }
  if (msg?.type === 'offscreen:readFile') { readFile(msg.url).then(reply, () => reply(null)); return true; }
  if (msg?.type !== 'offscreen:readClipboard') return false;
  const box = document.getElementById('paste');
  box.value = '';
  box.focus();
  document.execCommand('paste');
  reply(box.value);
  return false;
});

// A local PDF's bytes, as base64 (messages carry text). Extension pages can read file:// URLs when the
// user has turned on "Allow access to file URLs".
function readFile(url) {
  return new Promise((ok, no) => {
    if (!/^file:/.test(url)) return no();
    const x = new XMLHttpRequest();
    x.open('GET', url);
    x.responseType = 'arraybuffer';
    x.onload = () => {
      const bytes = new Uint8Array(x.response || []);
      if (!bytes.length) return no();
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      ok(btoa(bin));
    };
    x.onerror = no;
    x.send();
  });
}

// Text recognition (OCR) with Tesseract, bundled with the extension: the engine, its worker and the
// English model all load from the extension itself, so nothing is downloaded and no image leaves the computer.
// One engine is shared by every tab; pages are recognised one at a time, in the order they're asked for.
let engine = null, queue = Promise.resolve();
const here = path => chrome.runtime.getURL(path);

function getEngine() {
  engine ??= (async () => {
    const { createWorker, OEM } = (await import(here('lib/tesseract/tesseract.esm.min.js'))).default;
    return createWorker('eng', OEM.LSTM_ONLY, {
      workerPath: here('lib/tesseract/worker.min.js'),
      corePath: here('lib/tesseract'),          // picks the SIMD build when the computer supports it
      langPath: here('lib/tesseract'),
      workerBlobURL: false, cacheMethod: 'none', gzip: true,
    });
  })().catch(e => { engine = null; throw e; });
  return engine;
}

// image: a data: URL of the rendered page. Returns { w, h, lines: [{ b, words: [{ t, b }] }] } in image pixels,
// where b = [x0, y0, x1, y1]. Words Tesseract isn't reasonably sure of are left out.
function ocr(image) {
  const job = queue.then(async () => {
    const w = await getEngine();
    const { data } = await w.recognize(image, {}, { blocks: true, text: false });
    const lines = [];
    for (const block of data.blocks ?? []) {
      for (const para of block.paragraphs ?? []) {
        for (const line of para.lines ?? []) {
          const words = (line.words ?? [])
            .filter(x => x.text?.trim() && x.confidence >= 40)
            .map(x => ({ t: x.text.trim(), b: [x.bbox.x0, x.bbox.y0, x.bbox.x1, x.bbox.y1] }));
          if (words.length) lines.push({ b: [line.bbox.x0, line.bbox.y0, line.bbox.x1, line.bbox.y1], words });
        }
      }
    }
    return { lines };
  });
  queue = job.catch(() => {});
  return job;
}
