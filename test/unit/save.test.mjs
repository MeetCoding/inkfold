// save.js: what Save, Split and Merge write, page by page.
import '../helpers/shims.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as lib from '../../extension/lib/pdf-lib.esm.min.js';
import { buildPdf } from '../../extension/save.js';
import { notePdf } from '../../extension/notes.js';
import { textOf } from '../helpers/inspect.mjs';
import { textPdf } from '../helpers/fixtures.mjs';

const sources = async (extra = {}) => {
  const files = { main: await textPdf(3), ...extra };
  return key => files[key].slice();
};
const page = (i, more = {}) => ({ id: i + 1, doc: 'main', i, rot: 0, ...more });

test('pages come out in the order given, rotated and cropped, and dropped pages are gone', async () => {
  const bytes = await buildPdf(lib, {
    list: [page(2, { rot: 90 }), page(0, { crop: [72, 400, 540, 720] })], shapes: [], bytesOf: await sources(), images: () => null,
  });
  const out = await textOf(bytes);
  assert.equal(out.length, 2);
  assert.match(out[0].text, /^Page 3 of/);
  assert.equal(out[0].rotate, 90);
  assert.match(out[1].text, /^Page 1 of/);
  assert.deepEqual(out[1].view, [72, 400, 540, 720]);
  // Page 2's content stream is unreachable now, so it was removed from the file, not just from the page list.
  const doc = await lib.PDFDocument.load(bytes);
  let streams = 0;
  for (const [, o] of doc.context.enumerateIndirectObjects()) if (o instanceof lib.PDFRawStream || o instanceof lib.PDFContentStream) streams++;
  const full = await lib.PDFDocument.load(await buildPdf(lib, { list: [page(0), page(1), page(2)], shapes: [], bytesOf: await sources(), images: () => null }));
  let all = 0;
  for (const [, o] of full.context.enumerateIndirectObjects()) if (o instanceof lib.PDFRawStream || o instanceof lib.PDFContentStream) all++;
  assert.ok(streams < all, `fewer streams once a page is dropped (${streams} vs ${all})`);
});

test('note pages are copied in where they were added', async () => {
  const note = await notePdf('# A note\n\nWith a list:\n\n- one\n- two', 612, 792, { fit: true });
  const bytes = await buildPdf(lib, {
    list: [page(0), { id: 9, doc: 'note1', i: 0, rot: 0 }, page(1)], shapes: [], bytesOf: await sources({ note1: note }), images: () => null,
  });
  const out = await textOf(bytes);
  assert.equal(out.length, 3);
  assert.match(out[1].text, /A note/);
  assert.match(out[1].text, /one/);
  assert.match(out[2].text, /^Page 2 of/);
});

test('annotations follow their page, wherever it moved', async () => {
  const shapes = [{ page: 1, type: 'rect', x1: 10, y1: 10, x2: 50, y2: 50, color: '#e5484d', width: 2 }];
  const bytes = await buildPdf(lib, { list: [page(1), page(0)], shapes, bytesOf: await sources(), images: () => null });
  const doc = await lib.PDFDocument.load(bytes);
  const counts = doc.getPages().map(p => p.node.Annots()?.size() ?? 0);
  assert.deepEqual(counts, [0, 1]);
});

test('recognised text is written as invisible, searchable text', async () => {
  const ocrText = new Map([[0, [{ str: 'Recognised words', transform: [12, 0, 0, 12, 72, 100], width: 100 }]]]);
  const bytes = await buildPdf(lib, { list: [page(0)], shapes: [], bytesOf: await sources(), images: () => null, ocrText });
  const [one] = await textOf(bytes);
  assert.match(one.text, /Recognised words/);
});

test('a crop reaching past the page makes it bigger, with white space', async () => {
  const bytes = await buildPdf(lib, {
    list: [page(0, { crop: [-100, 0, 712, 892] })], shapes: [], bytesOf: await sources(), images: () => null,
  });
  const [one] = await textOf(bytes);
  assert.deepEqual(one.view, [-100, 0, 712, 892], 'the page is the whole box');
  assert.match(one.text, /^Page 1 of/, 'and still has its text');
  const doc = await lib.PDFDocument.load(bytes);
  const m = doc.getPage(0).getMediaBox();
  assert.deepEqual([m.x, m.y, m.width, m.height], [-100, 0, 812, 892]);
});
