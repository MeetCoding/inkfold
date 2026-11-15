// Reads a saved PDF back, outside the browser, with the extension's own pdf.js, to check what Inkfold wrote.
import './shims.mjs';
import { getDocument, GlobalWorkerOptions } from '../../extension/lib/pdf.min.mjs';

GlobalWorkerOptions.workerSrc = new URL('../../extension/lib/pdf.worker.min.mjs', import.meta.url).href;

export async function annotationsOf(bytes) {
  const task = getDocument({ data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false });
  const pdf = await task.promise;
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const pg = await pdf.getPage(n);
    pages.push({ rotate: pg.rotate, view: pg.view, annots: await pg.getAnnotations() });
  }
  await task.destroy();   // (pdf.js 6 documents have no destroy(); their loading task does)
  return pages;
}
