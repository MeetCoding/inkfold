// Runs the extension's text recognition (ocr/paddle.js on the bundled ONNX Runtime, single-threaded) on the test
// pages from make-images.py, with the models in each folder given, and reports speed and character error rate.
//   python3 scripts/ocr-check/make-images.py /tmp/ocr-check
//   node scripts/ocr-check/compare.mjs /tmp/ocr-check extension/ocr/models [other/models …]
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const EXT = new URL('../../extension/', import.meta.url).pathname;
const ort = await import(EXT + 'lib/ort/ort.wasm.min.mjs');
const { createOcr } = await import(EXT + 'ocr/paddle.js');
Object.assign(ort.env.wasm, { wasmPaths: EXT + 'lib/ort/', numThreads: 1 });
ort.env.logLevel = 'error';

const [pagesDir, ...modelDirs] = process.argv.slice(2);
const meta = JSON.parse(await readFile(resolve(pagesDir, 'meta.json'), 'utf8'));
const dict = (await readFile(EXT + 'ocr/models/dict.txt', 'utf8')).replace(/\r/g, '').split('\n').filter((l, i, a) => i < a.length - 1 || l);

function distance(a, b) {   // Levenshtein, in characters
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1]));
    prev = cur;
  }
  return prev[b.length];
}

const results = [];
for (const dir of modelDirs) {
  const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  const load = async f => ort.InferenceSession.create(new Uint8Array(await readFile(resolve(dir, f))), opts);
  let t = performance.now();
  const [det, rec, cls] = [await load('det.onnx'), await load('rec.onnx'), await load('cls.onnx')];
  const loadMs = performance.now() - t;
  const ocr = createOcr({ ort, det, rec, cls, dict });
  let ms = 0, errors = 0, chars = 0;
  const texts = [];
  for (const [k, lines] of meta.truth.entries()) {
    const data = new Uint8ClampedArray(await readFile(resolve(pagesDir, `${k}.rgba`)));
    t = performance.now();
    const r = await ocr.recognise({ data, width: meta.w, height: meta.h });
    ms += performance.now() - t;
    const got = r.lines.map(l => l.words.map(w => w.t).join(' ')).join('\n'), want = lines.join('\n');
    texts.push(got);
    errors += distance(want, got);
    chars += want.length;
  }
  results.push({ dir, texts });
  console.log(`${dir}: models loaded in ${Math.round(loadMs)} ms; ${meta.truth.length} pages in ${Math.round(ms)} ms; `
    + `character error rate ${(100 * errors / chars).toFixed(3)}%`);
}
for (const r of results.slice(1)) {
  const d = r.texts.reduce((n, t, k) => n + distance(results[0].texts[k], t), 0);
  console.log(`${r.dir} vs ${results[0].dir}: ${d} characters read differently`);
}
