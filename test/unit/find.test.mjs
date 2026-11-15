import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pattern, count, snippet, spans, flatten, joinItems } from '../../extension/find.js';

test('words match across spaces and line breaks; case and whole words are options', () => {
  const t = flatten('The quick\nbrown   fox. Quickly, the QUICK brown fox.');
  assert.equal(count(t, pattern('quick brown')).n, 2);
  assert.equal(count(t, pattern('quick', { matchCase: true })).n, 1);
  assert.equal(count(t, pattern('quick', { word: true })).n, 2);   // not "Quickly"
  assert.equal(pattern('   '), null);
  assert.equal(count('a+b (c)', pattern('a+b (c)')).n, 1);         // regex characters are plain text
});

test('snippets and spans', () => {
  const text = 'x'.repeat(50) + ' needle ' + 'y'.repeat(100);
  const s = snippet(text, count(text, pattern('needle')).first);
  assert.equal(s.match, 'needle');
  assert.ok(s.before.startsWith('…') && s.after.endsWith('…'));
  assert.deepEqual(spans('ab ab', pattern('ab')), [[0, 2], [3, 5]]);
});

test('text items join with their line ends', () => {
  assert.equal(joinItems([{ str: 'one', hasEOL: true }, { str: 'two' }]), 'one\ntwo');
});
