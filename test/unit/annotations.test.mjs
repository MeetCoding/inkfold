// Every kind of annotation, written into a PDF and read back from it (as the viewer does: pdf.js for most
// things, pdf-lib for the details pdf.js doesn't report), comes back as it was.
import '../helpers/shims.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as lib from '../../extension/lib/pdf-lib.esm.min.js';
import { writer, read, readDetails, dropOurs, AUTHOR } from '../../extension/annotations.js';
import { layout, pdfOps } from '../../extension/textbox.js';
import { annotationsOf } from '../helpers/inspect.mjs';
import { textPdf } from '../helpers/fixtures.mjs';
import { png, jpeg } from '../helpers/images.mjs';

const IMAGES = { p: { mime: 'image/png', bytes: png(3, 2, [10, 200, 30, 128]) }, j: { mime: 'image/jpeg', bytes: jpeg } };
const SHAPES = [
  { page: 1, type: 'rect', x1: 100, y1: 100, x2: 200, y2: 150, color: '#e5484d', width: 2 },
  { page: 1, type: 'rect', x1: 300, y1: 100, x2: 400, y2: 150, color: '#ffffff', width: 1, fill: true },
  { page: 1, type: 'ellipse', x1: 100, y1: 300, x2: 220, y2: 360, color: '#2f6fe0', width: 4 },
  { page: 1, type: 'highlight', rects: [[72, 640, 300, 655], [72, 616, 250, 631]], color: '#ffd400' },
  { page: 1, type: 'text', x1: 80, y1: 500, x2: 80, y2: 500, text: 'Hello, PDF', size: 14, color: '#2f9e44' },
  { page: 2, type: 'image', x1: 50, y1: 50, x2: 110, y2: 90, img: 'p' },
  { page: 2, type: 'image', x1: 150, y1: 50, x2: 190, y2: 80, img: 'j' },
];

async function save(shapes, base) {
  const doc = await lib.PDFDocument.load(base ?? await textPdf(2));
  const w = writer(lib, doc, { layout, pdfOps, images: k => IMAGES[k] ?? null });
  const pages = doc.getPages();
  for (const pg of pages) dropOurs(lib, pg);
  const added = [];
  for (const s of shapes) added.push(await w.add(pages[s.page - 1], s));
  return { bytes: await doc.save(), added };
}

async function load(bytes) {
  const pages = await annotationsOf(bytes), shapes = [], wanted = [];
  pages.forEach((pg, k) => {
    for (const a of pg.annots) {
      const got = read(a, k + 1);
      if (!got) continue;
      shapes.push(got.shape);
      if (got.details) wanted.push({ shape: got.shape, id: a.id, details: got.details });
    }
  });
  const pictures = await readDetails(lib, bytes, wanted);
  return { shapes, pictures, pages };
}

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.02, `${msg}: ${a} vs ${b}`);

test('every kind survives a save and reopen', async () => {
  const { bytes, added } = await save(SHAPES);
  assert.ok(added.every(Boolean));
  const { shapes, pictures } = await load(bytes);
  assert.equal(shapes.length, SHAPES.length);
  for (const [k, want] of SHAPES.entries()) {
    const got = shapes[k];
    assert.equal(got.type, want.type);
    assert.equal(got.page, want.page);
    if (want.type === 'highlight') {
      assert.equal(got.color, want.color);
      assert.equal(got.rects.length, want.rects.length);
      got.rects.forEach((r, i) => r.forEach((v, j) => near(v, want.rects[i][j], 'highlight box')));
    } else if (want.type === 'text') {
      assert.deepEqual([got.text, got.size, got.color], [want.text, want.size, want.color]);
      near(got.x1, want.x1, 'text left'); near(got.y2, want.y2, 'text top');
    } else {
      for (const c of ['x1', 'y1', 'x2', 'y2']) near(got[c], want[c], `${want.type} ${c}`);
      if (want.type !== 'image') assert.deepEqual([got.color, got.width, !!got.fill], [want.color, want.width, !!want.fill]);
    }
  }
  assert.equal(pictures.length, 2);
  const [p, j] = pictures;
  assert.deepEqual([p.picture.mime, p.picture.w, p.picture.h], ['image/png', 3, 2]);
  assert.deepEqual([...p.picture.rgba.slice(0, 4)], [10, 200, 30, 128]);
  assert.deepEqual([j.picture.mime, j.picture.w, j.picture.h], ['image/jpeg', 4, 3]);
  assert.deepEqual(j.picture.bytes, jpeg);
});

test('saving again replaces Inkfold’s annotations but keeps everyone else’s', async () => {
  const { bytes } = await save(SHAPES.slice(0, 3));
  // Another app's comment on page 1.
  const doc = await lib.PDFDocument.load(bytes);
  const ctx = doc.context;
  doc.getPages()[0].node.addAnnot(ctx.register(ctx.obj({
    Type: 'Annot', Subtype: 'Square', Rect: [10, 10, 20, 20], T: lib.PDFString.of('Someone else'),
  })));
  const { bytes: again } = await save(SHAPES.slice(3, 5), await doc.save());
  const { pages } = await load(again);
  const authors = pages[0].annots.map(a => `${a.titleObj?.str}:${a.subtype}`).sort();
  assert.deepEqual(authors, [`${AUTHOR}:FreeText`, `${AUTHOR}:Highlight`, 'Someone else:Square']);
});

test('files from the earlier name (“PDF Shapes”) are read too, and other authors aren’t', () => {
  const a = { subtype: 'Square', rect: [0, 0, 10, 10], color: [255, 0, 0], borderStyle: { width: 2 } };
  assert.equal(read({ ...a, titleObj: { str: 'PDF Shapes' } }, 1).shape.type, 'rect');
  assert.equal(read({ ...a, titleObj: { str: 'Acrobat' } }, 1), null);
  assert.equal(read({ ...a, subtype: 'Ink', titleObj: { str: AUTHOR } }, 1), null);
});

test('an image whose picture is gone is left out, not written broken', async () => {
  const { added } = await save([{ page: 1, type: 'image', x1: 0, y1: 0, x2: 10, y2: 10, img: 'missing' }]);
  assert.deepEqual(added, [false]);
});
