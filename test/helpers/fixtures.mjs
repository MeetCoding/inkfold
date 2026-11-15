// Small PDFs made on the fly for the tests, with the same pdf-lib the extension ships.
import { PDFDocument, StandardFonts, rgb } from '../../extension/lib/pdf-lib.esm.min.js';

// pages: Letter-sized pages, each with a heading and a few lines of real, selectable text.
export async function textPdf(pages = 2) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= pages; n++) {
    const pg = doc.addPage([612, 792]);
    pg.drawText(`Page ${n} of the Inkfold test document`, { x: 72, y: 700, size: 18, font, color: rgb(0, 0, 0) });
    for (let l = 0; l < 6; l++) {
      pg.drawText(`Line ${l + 1}: the quick brown fox jumps over the lazy dog.`, { x: 72, y: 650 - l * 24, size: 12, font });
    }
  }
  return doc.save();
}

// A PDF made mostly of one big photo-like picture stored losslessly: much bigger than it needs to be, so Inkfold
// offers to compress it.
export async function bloatedPdf() {
  const { png } = await import('./images.mjs');
  const w = 1800, h = 1300;
  const doc = await PDFDocument.create();
  const pic = await doc.embedPng(noisy(png, w, h));
  const pg = doc.addPage([612, 792]);
  pg.drawImage(pic, { x: 36, y: 200, width: 540, height: 390 });
  pg.drawText('A page with a large picture', { x: 72, y: 700, size: 18, font: await doc.embedFont(StandardFonts.Helvetica) });
  return doc.save();
}

function noisy(png, w, h) {   // a smooth gradient with a little grain, like a photo
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, g = (rand() - 0.5) * 24;
    px[i] = 40 + 180 * x / w + g; px[i + 1] = 60 + 150 * y / h + g; px[i + 2] = 200 - 120 * x / w + g; px[i + 3] = 255;
  }
  return png(w, h, px);
}

// A "scanned" page: a picture of three lines of text, with no text layer, for text recognition.
export async function scannedPdf() {
  const { readFile } = await import('node:fs/promises');
  const doc = await PDFDocument.create();
  const pic = await doc.embedPng(await readFile(new URL('../fixtures/scan.png', import.meta.url)));
  doc.addPage([612, 792]).drawImage(pic, { x: 0, y: 0, width: 612, height: 792 });
  return doc.save();
}
