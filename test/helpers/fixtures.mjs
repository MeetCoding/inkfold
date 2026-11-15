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
