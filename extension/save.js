// Writing the PDF that Save, Split and Merge produce. No browser APIs here, so it runs (and is tested) under Node.
import * as annotations from './annotations.js';
import { layout, pdfOps, cleanWith } from './textbox.js';

// A PDF holding `list` (some or all page entries, in order) with their rotations, crops and annotations.
// It edits the original file rather than copying pages out, so bookmarks, metadata and forms survive;
// anything only the dropped pages used is then removed, so deleted pages really are gone from the file.
//   L         pdf-lib
//   list      [{ id, doc, i, rot, crop? }]: doc 'main' (the PDF that was opened) or the key of an added page's own PDF
//   shapes    the annotations (see annotations.js), tied to entry ids
//   bytesOf   key -> the bytes of that source PDF
//   images    picture key -> { mime, bytes } or null
//   ocrText   main-document page index -> text recognised on it (pdf.js text items), written as invisible text
export async function buildPdf(L, { list, shapes, bytesOf, images, ocrText = new Map() }) {
  const {
    PDFDocument, PDFName, PDFNumber, PDFDict, PDFArray, PDFRef, PDFStream,
    pushGraphicsState, popGraphicsState, setTextRenderingMode, TextRenderingMode, setCharacterSqueeze, radians,
  } = L;
  const doc = await PDFDocument.load(await bytesOf('main'), { updateMetadata: false });
  const ctx = doc.context, N = PDFName.of;
  const orig = doc.getPages();
  const marks = annotations.writer(L, doc, { layout, pdfOps, images });

  const copied = new Map();   // note pages, copied in from their own small PDFs
  for (const key of new Set(list.map(e => e.doc))) {
    if (key === 'main') continue;
    const src = await PDFDocument.load(await bytesOf(key));
    copied.set(key, await doc.copyPages(src, src.getPageIndices()));
  }
  const out = list.map(e => (e.doc === 'main' ? orig[e.i] : copied.get(e.doc)[e.i]));

  // Settings a page inherits from the old page tree are copied onto the page itself, so nothing is lost when it moves.
  for (const [k, pg] of out.entries()) {
    for (const key of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) {
      if (pg.node.get(N(key))) continue;
      const v = pg.node.getInheritableAttribute(N(key));
      if (v) pg.node.set(N(key), v);
    }
    const r = pg.node.lookup(N('Rotate'));
    pg.node.set(N('Rotate'), PDFNumber.of((((r?.asNumber?.() ?? 0) + list[k].rot) % 360 + 360) % 360));
    const c = list[k].crop;   // cropped here: the page's visible box
    if (c) pg.setCropBox(c[0], c[1], c[2] - c[0], c[3] - c[1]);
  }
  // The annotations from an earlier session come off; the current set is written back, each with its own
  // appearance so every viewer draws it the same.
  for (const pg of out) annotations.dropOurs(L, pg);
  const target = new Map(list.map((e, k) => [e.id, out[k]]));
  for (const s of shapes) {
    const pg = target.get(s.page);
    if (pg) await marks.add(pg, s);
  }

  // Recognised text goes onto its pages as invisible text, so the copy can be searched and selected anywhere.
  const scanned = list.filter(e => e.doc === 'main' && ocrText.has(e.i));
  if (scanned.length) {
    const helv = await marks.font();
    const clean = cleanWith(new Set(helv.getCharacterSet()));
    for (const e of scanned) {
      const pg = target.get(e.id);
      pg.node.wrapContentStreams(ctx.register(ctx.stream('q')), ctx.register(ctx.stream('Q')));   // our text starts from a clean state
      for (const it of ocrText.get(e.i)) {
        const t = clean(it.str);
        const [a, b, , , x, y] = it.transform, size = Math.hypot(a, b), natural = t.trim() ? helv.widthOfTextAtSize(t, size) : 0;
        if (!natural || size < 1) continue;
        pg.pushOperators(pushGraphicsState(), setTextRenderingMode(TextRenderingMode.Invisible), setCharacterSqueeze(+(100 * it.width / natural).toFixed(2)));
        pg.drawText(t, { x, y, size, font: helv, rotate: radians(Math.atan2(b, a)) });
        pg.pushOperators(popGraphicsState());
      }
    }
  }

  // Swap in a fresh, flat page tree holding just these pages, in this order.
  const tree = ctx.register(ctx.obj({ Type: 'Pages', Kids: out.map(p => p.ref), Count: out.length }));
  out.forEach(p => p.node.set(N('Parent'), tree));
  doc.catalog.set(N('Pages'), tree);

  // Remove every object that is no longer reachable, treating dropped pages as cut off.
  const dropped = new Set(orig.filter(p => !out.includes(p)).map(p => p.ref.toString()));
  const seen = new Set(), todo = Object.values(ctx.trailerInfo).filter(Boolean);
  while (todo.length) {
    const o = todo.pop();
    if (o instanceof PDFRef) {
      const k = o.toString();
      if (seen.has(k) || dropped.has(k)) continue;
      seen.add(k);
      const v = ctx.lookup(o);
      if (v) todo.push(v);
    } else if (o instanceof PDFDict) todo.push(...o.values());
    else if (o instanceof PDFArray) todo.push(...o.asArray());
    else if (o instanceof PDFStream) todo.push(o.dict);
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.toString())) ctx.delete(ref);

  return doc.save({ updateFieldAppearances: false });
}
