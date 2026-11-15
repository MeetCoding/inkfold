import '../helpers/shims.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as lib from '../../extension/lib/pdf-lib.esm.min.js';
import { joinedPdf, shiftShape } from '../../extension/join.js';
import { getDocument } from '../../extension/lib/pdf.min.mjs';
import { textPdf } from '../helpers/fixtures.mjs';
import '../helpers/inspect.mjs';   // (sets up pdf.js's worker)

async function items(bytes) {
  const task = getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  const pg = await (await task.promise).getPage(1);
  const out = { view: pg.view, items: (await pg.getTextContent()).items.filter(i => i.str.trim()).map(i => ({ str: i.str, x: i.transform[4], y: i.transform[5] })) };
  await task.destroy();
  return out;
}

test('two pages become one long page, the first on top, text still text and in place', async () => {
  const bytes = await textPdf(2);
  const { bytes: joined, moves } = await joinedPdf(lib, [
    { key: 'main', bytes: bytes.slice(), index: 0, box: [0, 0, 612, 792] },
    { key: 'main', bytes: bytes.slice(), index: 1, box: [0, 0, 612, 792] },
  ]);
  assert.deepEqual(moves, [[0, 792], [0, 0]]);
  const { view, items: it } = await items(joined);
  assert.deepEqual(view, [0, 0, 612, 1584]);
  const p1 = it.find(i => i.str.startsWith('Page 1')), p2 = it.find(i => i.str.startsWith('Page 2'));
  assert.deepEqual([p1.x, p1.y], [72, 700 + 792], 'page 1’s heading, moved up by a page');
  assert.deepEqual([p2.x, p2.y], [72, 700], 'page 2’s heading, where it was');
});

test('crops are kept, narrower parts are centred', async () => {
  const bytes = await textPdf(2);
  const { bytes: joined, moves } = await joinedPdf(lib, [
    { key: 'a', bytes, index: 0, box: [72, 600, 540, 720] },   // just the top of page 1
    { key: 'a', bytes, index: 1, box: [0, 0, 612, 792] },
  ]);
  const { view, items: it } = await items(joined);
  assert.deepEqual(view, [0, 0, 612, 912]);
  assert.deepEqual(moves[0], [(612 - 468) / 2 - 72, 792 - 600]);
  const heading = it.filter(i => i.str.startsWith('Page 1'));
  assert.equal(heading.length, 1);
  assert.deepEqual([heading[0].x, heading[0].y], [72 + moves[0][0], 700 + moves[0][1]]);
});

test('annotations move with their page', () => {
  assert.deepEqual(shiftShape({ type: 'rect', x1: 1, y1: 2, x2: 3, y2: 4 }, [10, 100]), { type: 'rect', x1: 11, y1: 102, x2: 13, y2: 104 });
  assert.deepEqual(shiftShape({ type: 'highlight', rects: [[1, 2, 3, 4]] }, [10, 100]).rects, [[11, 102, 13, 104]]);
});

test('text read on a scanned page comes along, moved with it', async () => {
  const bytes = await textPdf(2);
  const ocr = [{ str: 'Scanned words', transform: [12, 0, 0, 12, 100, 50], width: 90 }];
  const { bytes: joined } = await joinedPdf(lib, [
    { key: 'a', bytes, index: 0, box: [0, 0, 612, 792], ocr },
    { key: 'a', bytes, index: 1, box: [0, 0, 612, 792] },
  ]);
  const w = (await items(joined)).items.find(i => i.str.startsWith('Scanned'));
  assert.deepEqual([w.x, w.y], [100, 50 + 792]);
});
