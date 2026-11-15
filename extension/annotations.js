// Inkfold's annotations as they are stored in a PDF: how each kind is written when saving, and how it is read
// back when the file is opened again, so it stays editable. One entry per kind in KINDS; nothing else needs to
// know the file format. (Drawing them on screen is still done by viewer.js.)
//
// In memory, in PDF points (y pointing up), tied to a page entry id:
//   rect, ellipse  { page, type, x1, y1, x2, y2, color, width, fill? }   (the box is the centre line of the stroke)
//   highlight      { page, type, rects: [[x1, y1, x2, y2], …], color }   (one box per line of text)
//   text           { page, type, x1, y1, x2, y2, text, size, color }    (x1, y2: the top-left corner)
//   image          { page, type, x1, y1, x2, y2, img }                  (img: a key into the viewer's pictures)
// In the file: Square, Circle, Highlight, FreeText and Stamp annotations, authored (/T) "Inkfold", each with its
// own appearance stream so that every viewer draws it the same way.

export const AUTHOR = 'Inkfold';
export const AUTHORS = [AUTHOR, 'PDF Shapes'];   // files saved under the extension's earlier name, too

const round = v => +v.toFixed(2);
const num = (...v) => v.map(round).join(' ');
export const rgbOf = color => (color ? [1, 3, 5].map(i => +(parseInt(color.slice(i, i + 2), 16) / 255).toFixed(3)) : [0, 0, 0]);
export const hexOf = c => '#' + [...(c || [0, 0, 0])].map(v => v.toString(16).padStart(2, '0')).join('');

// A rectangle's or ellipse's outline as path operators, for its appearance stream.
function outline(s) {
  const { x1, y1, x2, y2 } = s;
  if (s.type !== 'ellipse') return num(x1, y1, x2 - x1, y2 - y1) + ' re';
  const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, rx = (x2 - x1) / 2, ry = (y2 - y1) / 2, kx = rx * 0.5523, ky = ry * 0.5523;
  return [   // four Bézier quarters
    num(cx + rx, cy) + ' m',
    num(cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry) + ' c',
    num(cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy) + ' c',
    num(cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry) + ' c',
    num(cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy) + ' c h',
  ].join(' ');
}

const box = {   // rectangles and ellipses: Square and Circle annotations
  write(s, w) {
    const rgb = rgbOf(s.color), h = s.width / 2;
    const rect = [s.x1 - h, s.y1 - h, s.x2 + h, s.y2 + h].map(round);
    const path = outline(s);
    const paint = s.fill ? `${rgb.join(' ')} rg ${rgb.join(' ')} RG ${path} B` : `${rgb.join(' ')} RG ${path} S`;
    const look = w.ctx.stream(`${s.width} w ${paint}`, { Type: 'XObject', Subtype: 'Form', BBox: rect });
    return {
      Subtype: s.type === 'rect' ? 'Square' : 'Circle', Rect: rect, BS: { W: s.width }, AP: { N: w.ctx.register(look) },
      C: rgb, ...(s.fill ? { IC: rgb } : {}),
    };
  },
  read(a, page) {
    const width = a.borderStyle?.width || 1, [x1, y1, x2, y2] = a.rect, h = width / 2;
    return {
      shape: { page, type: a.subtype === 'Square' ? 'rect' : 'ellipse', x1: x1 + h, y1: y1 + h, x2: x2 - h, y2: y2 - h, color: hexOf(a.color), width },
      details: 'fill',   // filled or not: its /IC, which pdf.js doesn't pass on
    };
  },
};

export const KINDS = {
  rect: { subtype: 'Square', ...box },
  ellipse: { subtype: 'Circle', ...box },

  highlight: {
    subtype: 'Highlight',
    write(s, w) {
      const rgb = rgbOf(s.color), r = s.rects;
      const rect = [
        Math.min(...r.map(b => b[0])), Math.min(...r.map(b => b[1])), Math.max(...r.map(b => b[2])), Math.max(...r.map(b => b[3])),
      ].map(round);
      const path = r.map(([a, b, c, d]) => num(a, b, c - a, d - b) + ' re').join(' ');
      const look = w.ctx.stream(`/GS0 gs ${rgb.join(' ')} rg ${path} f`, {
        Type: 'XObject', Subtype: 'Form', BBox: rect,
        Resources: { ExtGState: { GS0: { Type: 'ExtGState', BM: 'Multiply' } } },   // ink shows through, like a marker
      });
      return {
        Subtype: 'Highlight', Rect: rect, AP: { N: w.ctx.register(look) }, C: rgb,
        QuadPoints: r.flatMap(([a, b, c, d]) => [a, d, c, d, a, b, c, b]).map(round),
      };
    },
    read(a, page) {
      if (!a.quadPoints) return null;
      const q = a.quadPoints, rects = [];   // pdf.js normalises each quad to TL, TR, BL, BR
      for (let k = 0; k < q.length; k += 8) rects.push([q[k], q[k + 5], q[k + 2], q[k + 1]]);
      return { shape: { page, type: 'highlight', rects, color: hexOf(a.color) } };
    },
  },

  // A FreeText annotation: the text as its contents, drawn by its own appearance (Helvetica plus math outlines).
  // The leading and trailing no-op text objects tell readers (pdf.js included) the font size and colour.
  // (For FreeText, /C would be a background fill, so it has none.)
  text: {
    subtype: 'FreeText',
    async write(s, w) {
      const rgb = rgbOf(s.color), L = await w.layout(s.text, s.size), helv = await w.font();
      const rect = [s.x1, s.y2 - L.h, s.x1 + L.w, s.y2].map(round);
      const mark = `BT /Helv ${s.size} Tf ${rgb.join(' ')} rg ET`;
      const look = w.ctx.stream(`${mark}\n${w.pdfOps(L, s.x1, s.y2, rgb)}\n${mark}`, {
        Type: 'XObject', Subtype: 'Form', BBox: rect, Resources: { Font: { Helv: helv.ref } },
      });
      return {
        Subtype: 'FreeText', Rect: rect, Contents: w.lib.PDFHexString.fromText(s.text),
        DA: w.lib.PDFString.of(`/Helv ${s.size} Tf ${rgb.join(' ')} rg`), BS: { W: 0 }, AP: { N: w.ctx.register(look) },
      };
    },
    read(a, page, { textColor = '#1f1f1f' } = {}) {
      const [x1, , , y2] = a.rect, da = a.defaultAppearanceData ?? {};
      const color = da.fontColor?.length === 3 ? hexOf(da.fontColor) : textColor;
      return { shape: { page, type: 'text', x1, y1: y2, x2: x1, y2, text: a.contentsObj?.str ?? '', size: da.fontSize || 12, color } };
    },
  },

  // A Stamp annotation whose appearance is the picture, so every viewer shows it.
  image: {
    subtype: 'Stamp',
    async write(s, w) {
      const pic = await w.picture(s.img);
      if (!pic) return null;
      const rect = [s.x1, s.y1, s.x2, s.y2].map(round), wd = round(s.x2 - s.x1), ht = round(s.y2 - s.y1);
      const look = w.ctx.stream(`q ${wd} 0 0 ${ht} ${rect[0]} ${rect[1]} cm /Im Do Q`, {
        Type: 'XObject', Subtype: 'Form', BBox: rect, Resources: { XObject: { Im: pic.ref } },
      });
      return { Subtype: 'Stamp', Rect: rect, Name: 'Image', Contents: w.lib.PDFHexString.fromText('Image'), AP: { N: w.ctx.register(look) } };
    },
    read(a, page) {
      const [x1, y1, x2, y2] = a.rect;
      return { shape: { page, type: 'image', x1, y1, x2, y2, img: null }, details: 'image' };   // the pixels: from the file
    },
  },
};

const BY_SUBTYPE = Object.fromEntries(Object.values(KINDS).map(k => [k.subtype, k]));
export const SUBTYPES = Object.keys(BY_SUBTYPE);

// Writing. One writer per saved file: it embeds Helvetica, and each picture, at most once.
//   images(key) -> { mime: 'image/png' | 'image/jpeg', bytes } or null
//   layout, pdfOps: textbox.js's, for text boxes
export function writer(lib, doc, { images, layout, pdfOps }) {
  const ctx = doc.context, pics = new Map();
  let helv = null;
  const w = {
    lib, ctx, layout, pdfOps,
    font: async () => (helv ??= await doc.embedFont(lib.StandardFonts.Helvetica)),
    async picture(key) {
      if (pics.has(key)) return pics.get(key);
      const im = images(key);
      const pic = im ? await (im.mime === 'image/jpeg' ? doc.embedJpg(im.bytes) : doc.embedPng(im.bytes)) : null;
      pics.set(key, pic);
      return pic;
    },
  };
  return {
    font: w.font,
    // Adds s to the page (a pdf-lib PDFPage); false if it couldn't be written (an image whose picture is missing).
    async add(page, s) {
      const kind = KINDS[s.type];
      const dict = kind && await kind.write(s, w);
      if (!dict) return false;
      page.node.addAnnot(ctx.register(ctx.obj({ Type: 'Annot', ...dict, F: 4, T: lib.PDFString.of(AUTHOR) })));
      return true;
    },
  };
}

// Takes the annotations an earlier Inkfold session wrote off a page (the current set is written afresh).
// Anything else on the page (links, form fields, other apps' comments) stays.
export function dropOurs(lib, page) {
  const { PDFName, PDFDict, PDFString, PDFHexString } = lib, N = PDFName.of;
  const annots = page.node.Annots();
  const kinds = SUBTYPES.map(k => N(k));
  for (let i = (annots?.size() ?? 0) - 1; i >= 0; i--) {
    const d = annots.lookup(i);
    if (!(d instanceof PDFDict)) continue;
    const author = d.lookup(N('T')), kind = d.lookup(N('Subtype'));
    if (!(author instanceof PDFString || author instanceof PDFHexString) || !AUTHORS.includes(author.decodeText())) continue;
    if (kinds.includes(kind)) annots.remove(i);
  }
}

// Reading. a: one annotation as pdf.js's getAnnotations() reports it.
// -> null (not one of Inkfold's), or { shape, details? }: details names what pdf.js doesn't report and
//    readDetails() has to fetch from the file itself ('fill' or 'image').
export function read(a, page, opts) {
  if (!AUTHORS.includes(a.titleObj?.str)) return null;
  return BY_SUBTYPE[a.subtype]?.read(a, page, opts) ?? null;
}

// What pdf.js doesn't report, from the file itself: whether each rectangle or ellipse is filled (its /IC), and each
// image's pixels. wanted: [{ shape, id, details }], id being pdf.js's annotation id ("12R" or "12R3").
// Fills are set on the shapes; for images it returns [{ shape, id, picture }], picture being
//   { mime: 'image/jpeg', bytes, w, h } | { mime: 'image/png', rgba, w, h } | null (couldn't be read).
export async function readDetails(lib, bytes, wanted) {
  const { PDFDocument, PDFRef, PDFName, PDFDict, PDFArray, decodePDFRawStream } = lib, N = PDFName.of;
  let ctx = null;
  try { ctx = (await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true })).context; } catch {}
  const annot = id => { const m = /^(\d+)R(\d*)$/.exec(id); return ctx.lookup(PDFRef.of(+m[1], +(m[2] || 0)), PDFDict); };
  const pictures = [];
  for (const { shape, id, details } of wanted) {
    if (details === 'fill') {
      try { if (annot(id).lookup(N('IC'), PDFArray)?.size() >= 1) shape.fill = true; } catch {}
      continue;
    }
    if (details !== 'image') continue;
    let picture = null;
    try {
      const look = annot(id).lookup(N('AP'), PDFDict).lookup(N('N'));
      const xo = look.dict.lookup(N('Resources'), PDFDict).lookup(N('XObject'), PDFDict);
      const pic = xo.lookup(xo.keys()[0]), d = pic.dict;
      const w = d.lookup(N('Width')).asNumber(), h = d.lookup(N('Height')).asNumber(), filter = String(d.lookup(N('Filter')));
      if (filter === '/DCTDecode') picture = { mime: 'image/jpeg', bytes: pic.contents, w, h };
      else {   // pdf-lib stores PNGs as raw colour plus a separate alpha mask
        const raw = decodePDFRawStream(pic).decode(), n = raw.length / (w * h);
        const mask = d.lookup(N('SMask'));
        const alpha = mask ? decodePDFRawStream(mask).decode() : null;
        const rgba = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < w * h; i++) {
          rgba[i * 4] = raw[i * n]; rgba[i * 4 + 1] = raw[i * n + (n >= 3 ? 1 : 0)]; rgba[i * 4 + 2] = raw[i * n + (n >= 3 ? 2 : 0)];
          rgba[i * 4 + 3] = alpha ? alpha[i] : 255;
        }
        picture = { mime: 'image/png', rgba, w, h };
      }
    } catch { picture = null; }
    pictures.push({ shape, id, picture });
  }
  return pictures;
}
