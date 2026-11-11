// Makes a smaller copy of a PDF, in the browser:
// • big photos and scans are re-encoded as JPEG (quality 0.8), and scaled down to at most 2,400 px
//   on their longer side (about 220 dpi on a Letter or A4 page);
// • streams stored without compression are compressed;
// • the file is rewritten with compact cross-references (object streams).
// Anything unusual (CMYK or indexed colours, masks, custom decoding, predictors) is left exactly as it is.
// Only what got smaller is kept. The pages, text, links, forms and annotations are untouched.

const MAX_SIDE = 2400, QUALITY = 0.8, MIN_IMAGE_BYTES = 40_000;
const tick = () => new Promise(r => setTimeout(r));   // let the page breathe between images

export async function compressPdf(bytes, { onProgress } = {}) {
  const lib = await import('./lib/pdf-lib.esm.min.js');
  const { PDFDocument, PDFName, PDFNumber, PDFArray, PDFDict, PDFRef, decodePDFRawStream } = lib;
  const N = PDFName.of;
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  const objects = ctx.enumerateIndirectObjects();
  const isStream = o => o && o.dict instanceof PDFDict && o.contents instanceof Uint8Array;

  // Images used as masks of other images stay lossless.
  const masks = new Set();
  for (const [, o] of objects) {
    if (!isStream(o)) continue;
    for (const k of ['SMask', 'Mask']) { const v = o.dict.get(N(k)); if (v instanceof PDFRef) masks.add(v.toString()); }
  }

  let done = 0;
  for (const [ref, o] of objects) {
    done++;
    if (!isStream(o)) continue;
    const d = o.dict, filter = d.lookup(N('Filter'));
    const filters = filter instanceof PDFArray ? filter.asArray().map(String) : filter ? [String(filter)] : [];
    const type = String(d.lookup(N('Type')) ?? ''), sub = String(d.lookup(N('Subtype')) ?? '');
    try {
      if (sub === '/Image') {
        if (o.contents.length < MIN_IMAGE_BYTES || masks.has(ref.toString())) continue;
        const out = await recodeImage(o, d, filters, { N, decodePDFRawStream, ctx });
        if (out && out.length < o.contents.length * 0.8) {
          const keep = {};
          for (const [k, v] of d.entries()) {
            if (!['/Filter', '/DecodeParms', '/Length', '/Width', '/Height', '/ColorSpace', '/BitsPerComponent'].includes(String(k))) keep[String(k).slice(1)] = v;
          }
          ctx.assign(ref, ctx.stream(out.bytes, { ...keep, Width: out.w, Height: out.h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' }));
        }
        await tick();
      } else if (!filters.length && o.contents.length > 256 && !['/XRef', '/ObjStm'].includes(type) && !d.has(N('DecodeParms'))) {
        const z = await deflate(o.contents);
        if (z.length < o.contents.length * 0.9) {
          const keep = {};
          for (const [k, v] of d.entries()) if (String(k) !== '/Length') keep[String(k).slice(1)] = v;
          ctx.assign(ref, ctx.stream(z, { ...keep, Filter: 'FlateDecode' }));
        }
      }
    } catch { /* leave this object as it was */ }
    onProgress?.(done / objects.length);
  }
  return doc.save({ useObjectStreams: true, updateFieldAppearances: false });
}

// -> { bytes, w, h, length } or null when the image is better left alone.
async function recodeImage(o, d, filters, { N, decodePDFRawStream, ctx }) {
  if (d.has(N('Decode')) || d.has(N('SMaskInData')) || String(d.lookup(N('ImageMask')) ?? '') === 'true') return null;
  const w = d.lookup(N('Width'))?.asNumber?.(), h = d.lookup(N('Height'))?.asNumber?.();
  const bpc = d.lookup(N('BitsPerComponent'))?.asNumber?.();
  if (!w || !h || bpc !== 8) return null;
  const comps = components(d.lookup(N('ColorSpace')), N, ctx);
  if (comps !== 1 && comps !== 3) return null;

  let source;
  if (filters.length === 1 && filters[0] === '/DCTDecode') {
    source = await createImageBitmap(new Blob([o.contents], { type: 'image/jpeg' }));
  } else if (filters.length === 1 && filters[0] === '/FlateDecode' && !d.has(N('DecodeParms'))) {
    if (w * h < 1_500_000) return null;   // keep smaller lossless pictures (diagrams, screenshots) sharp
    const raw = decodePDFRawStream(o).decode();
    if (raw.length < w * h * comps) return null;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0, j = 0; i < w * h; i++, j += comps) {
      rgba[i * 4] = raw[j]; rgba[i * 4 + 1] = raw[j + (comps === 3 ? 1 : 0)]; rgba[i * 4 + 2] = raw[j + (comps === 3 ? 2 : 0)]; rgba[i * 4 + 3] = 255;
    }
    source = await createImageBitmap(new ImageData(rgba, w, h));
  } else return null;

  const k = Math.min(1, MAX_SIDE / Math.max(w, h));
  const W = Math.max(1, Math.round(w * k)), H = Math.max(1, Math.round(h * k));
  const canvas = new OffscreenCanvas(W, H), g = canvas.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, W, H);
  g.imageSmoothingQuality = 'high';
  g.drawImage(source, 0, 0, W, H);
  source.close?.();
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: QUALITY })).arrayBuffer());
  return { bytes, w: W, h: H, length: bytes.length };
}

function components(cs, N, ctx) {   // colour components of an image's colour space, or 0 if it's one we don't touch
  const name = String(cs?.asArray ? ctx.lookup(cs.asArray()[0]) : cs ?? '');
  if (name === '/DeviceRGB' || name === '/CalRGB') return 3;
  if (name === '/DeviceGray' || name === '/CalGray') return 1;
  if (name === '/ICCBased') {
    const stream = ctx.lookup(cs.asArray()[1]);
    const n = stream?.dict ? stream.dict.lookup(N('N')) : null;
    return n?.asNumber?.() === 3 || n?.asNumber?.() === 1 ? n.asNumber() : 0;
  }
  return 0;
}

async function deflate(bytes) {   // zlib format, which is what PDF's FlateDecode expects
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
