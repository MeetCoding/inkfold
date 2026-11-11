// Text recognition worker, started by the extension's hidden helper page (offscreen.js).
// Runs PaddleOCR's models with ONNX Runtime (WebAssembly), all bundled with the extension: nothing is
// downloaded and no image leaves the computer. Pages are read one at a time, in the order they're sent.
import * as ort from '../lib/ort/ort.wasm.min.mjs';
import { createOcr } from './paddle.js';

const here = p => new URL(p, import.meta.url).href;
ort.env.wasm.wasmPaths = here('../lib/ort/');
// Several threads when Chrome allows them here (the helper page is cross-origin isolated); leave a core or two
// for the rest of the computer, since this runs in the background.
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, Math.max(2, (navigator.hardwareConcurrency || 2) - 2)) : 1;
ort.env.logLevel = 'error';

let engine = null;
function getEngine() {
  engine ??= (async () => {
    const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
    const model = async f => ort.InferenceSession.create(new Uint8Array(await (await fetch(here('models/' + f))).arrayBuffer()), opts);
    const [det, rec, cls, dict] = await Promise.all([model('det.onnx'), model('rec.onnx'), model('cls.onnx'),
      fetch(here('models/dict.txt')).then(r => r.text())]);
    return createOcr({ ort, det, rec, cls, dict: dict.replace(/\r/g, '').split('\n').filter((l, i, a) => i < a.length - 1 || l) });
  })().catch(e => { engine = null; throw e; });
  return engine;
}

async function pixels(image) {   // a data: URL (or Blob) -> { data, width, height } (RGBA)
  const blob = image instanceof Blob ? image : await (await fetch(image)).blob();
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  bmp.close();
  const { data, width, height } = g.getImageData(0, 0, c.width, c.height);
  return { data, width, height };
}

let queue = Promise.resolve();
self.onmessage = ({ data: msg }) => {
  if (msg?.type !== 'ocr') return;
  const job = queue.then(async () => {
    const t0 = performance.now();
    const ocr = await getEngine();
    const out = await ocr.recognise(await pixels(msg.image));
    out.ms = Math.round(performance.now() - t0);
    out.threads = ort.env.wasm.numThreads;
    return out;
  });
  queue = job.catch(() => {});
  job.then(r => self.postMessage({ id: msg.id, result: r }), e => self.postMessage({ id: msg.id, error: String(e?.message ?? e) }));
};
