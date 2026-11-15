// @ts-check
// Joining pages: two (or more) pages, one above the other, as one long page, a small PDF of its own. Each page's
// visible part (its crop box, if it has one) is placed whole, centred across the width of the widest, so the
// text stays real text and nothing is redrawn as a picture. No browser APIs: tested under Node.
//
//   L      pdf-lib
//   parts  [{ key, bytes, index, box: [x0, y0, x1, y1], ocr? }], top first: the source PDF (key names it, so one
//          that appears twice is read once), the page's index in it, the part of the page to show, in its points,
//          and any text recognised on it (OCR, pdf.js text items), which comes along as invisible text
// -> { bytes, moves }: the new PDF, and for each part the [dx, dy] that takes a point on its page to the same point on
//    the long page (for moving annotations across).
import { invisibleText } from './save.js';

export async function joinedPdf(L, parts) {
  const doc = await L.PDFDocument.create();
  doc.setProducer('Inkfold');
  const sizes = parts.map(({ box: [x0, y0, x1, y1] }) => [x1 - x0, y1 - y0]);
  const W = Math.max(...sizes.map(s => s[0])), H = sizes.reduce((h, s) => h + s[1], 0);
  const page = doc.addPage([W, H]);
  const sources = new Map();
  /** @type {[number, number][]} */
  const moves = [];
  let top = H, helv = null;
  for (const [k, part] of parts.entries()) {
    const [x0, y0, x1, y1] = part.box, [w, h] = sizes[k];
    let src = sources.get(part.key);
    if (!src) sources.set(part.key, src = await L.PDFDocument.load(part.bytes, { updateMetadata: false, ignoreEncryption: true }));
    const embedded = await doc.embedPage(src.getPage(part.index), { left: x0, bottom: y0, right: x1, top: y1 });
    const x = (W - w) / 2, y = top - h;
    page.drawPage(embedded, { x, y, width: w, height: h });
    moves.push([x - x0, y - y0]);
    if (part.ocr?.length) invisibleText(L, page, part.ocr, helv ??= await doc.embedFont(L.StandardFonts.Helvetica), moves[k]);
    top -= h;
  }
  return { bytes: await doc.save(), moves };
}

// An annotation (see annotations.js) moved by [dx, dy], in place.
export function shiftShape(s, [dx, dy]) {
  if (s.rects) s.rects = s.rects.map(([a, b, c, d]) => [a + dx, b + dy, c + dx, d + dy]);
  else Object.assign(s, { x1: s.x1 + dx, y1: s.y1 + dy, x2: s.x2 + dx, y2: s.y2 + dy });
  return s;
}
