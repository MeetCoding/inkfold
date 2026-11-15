// The small pure helpers the viewer is built on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRanges } from '../../extension/pages.js';
import { mergeLines } from '../../extension/geometry.js';
import { looksLikeMarkdown } from '../../extension/paste.js';

test('page ranges', () => {
  const idx = (t, n = 12) => parseRanges(t, n).map(g => [g.label, g.idx]);
  assert.deepEqual(idx('2-4, 7, 10-end'), [['2-4', [1, 2, 3]], ['7', [6]], ['10-12', [9, 10, 11]]]);
  assert.deepEqual(idx('last'), [['12', [11]]]);
  assert.deepEqual(idx('-3'), [['1-3', [0, 1, 2]]]);
  assert.deepEqual(idx('11-'), [['11-12', [10, 11]]]);
  assert.deepEqual(idx('1 to 2; 5–6'), [['1-2', [0, 1]], ['5-6', [4, 5]]]);
  assert.throws(() => parseRanges('0', 5), /outside pages 1–5/);
  assert.throws(() => parseRanges('4-2', 5), /outside/);
  assert.throws(() => parseRanges('6', 5), /outside/);
  assert.throws(() => parseRanges('abc', 5), /isn’t a page or a range/);
  assert.throws(() => parseRanges(' , ', 5), /Type the pages first/);
});

test('word boxes on a line merge into one; separate lines stay apart', () => {
  const words = [
    { l: 60, t: 10, r: 100, b: 22 }, { l: 10, t: 10, r: 55, b: 22 },   // one line, out of order
    { l: 10, t: 40, r: 80, b: 52 },                                     // the next line
    { l: 400, t: 10, r: 440, b: 22 },                                   // same height, but far along: another column
  ];
  assert.deepEqual(mergeLines(words), [
    { l: 10, t: 10, r: 100, b: 22 }, { l: 400, t: 10, r: 440, b: 22 }, { l: 10, t: 40, r: 80, b: 52 },
  ]);
});

test('Markdown or plain text', () => {
  assert.equal(looksLikeMarkdown('# Title\n\nSome text'), true);
  assert.equal(looksLikeMarkdown('| a | b |\n|---|---|\n| 1 | 2 |'), true);
  assert.equal(looksLikeMarkdown('- one\n- **two**'), true);
  assert.equal(looksLikeMarkdown('Just a sentence copied from a page.'), false);
  assert.equal(looksLikeMarkdown('- a single list item'), false);
});
