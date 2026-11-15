import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHistory, diff, apply } from '../../extension/history.js';

// A tiny stand-in for the viewer: a state, changed only through commit-then-mutate, as viewer.js does.
function editor(n = 0) {
  let s = { entries: [{ id: 1 }, { id: 2 }], shapes: Array.from({ length: n }, (_, i) => ({ type: 'rect', x: i })) };
  const h = createHistory({ limit: 5 });
  const snap = () => JSON.stringify(s);
  return {
    h, get s() { return s; },
    change(fn) { h.record(snap()); s = structuredClone(s); fn(s); },
    undo() { const b = h.undo(snap()); if (b) s = b; return !!b; },
    redo() { const b = h.redo(snap()); if (b) s = b; return !!b; },
  };
}

test('undo and redo walk back and forth through every change', () => {
  const ed = editor(3), states = [JSON.stringify(ed.s)];
  ed.change(s => s.shapes.push({ type: 'ellipse' })); states.push(JSON.stringify(ed.s));
  ed.change(s => { s.shapes[1].x = 99; }); states.push(JSON.stringify(ed.s));
  ed.change(s => s.shapes.splice(0, 1)); states.push(JSON.stringify(ed.s));
  ed.change(s => s.entries.reverse()); states.push(JSON.stringify(ed.s));
  for (let k = states.length - 2; k >= 0; k--) { assert.ok(ed.undo()); assert.equal(JSON.stringify(ed.s), states[k]); }
  assert.equal(ed.undo(), false);
  for (let k = 1; k < states.length; k++) { assert.ok(ed.redo()); assert.equal(JSON.stringify(ed.s), states[k]); }
  assert.equal(ed.redo(), false);
});

test('a new change after undo drops the redo steps', () => {
  const ed = editor(1);
  ed.change(s => { s.shapes[0].x = 1; });
  ed.undo();
  assert.ok(ed.h.canRedo);
  ed.change(s => { s.shapes[0].x = 2; });
  assert.equal(ed.h.canRedo, false);
});

test('only the newest steps are kept', () => {
  const ed = editor(1);
  for (let k = 1; k <= 8; k++) ed.change(s => { s.shapes[0].x = k; });
  let n = 0;
  while (ed.undo()) n++;
  assert.equal(n, 5);
  assert.equal(ed.s.shapes[0].x, 3);
});

test('a step holds only what changed', () => {
  const big = Array.from({ length: 5000 }, (_, i) => `{"x":${i}}`);
  const moved = big.slice(); moved[2500] = '{"x":-1}';
  const d = diff(big, moved);
  assert.deepEqual(d, { at: 2500, from: ['{"x":2500}'], to: ['{"x":-1}'] });
});

test('a change made outside any step joins the step before it', () => {
  const ed = editor(2);
  ed.change(s => { s.shapes[0].x = 50; });
  ed.s.shapes[1].x = 70;   // not recorded
  assert.ok(ed.undo());
  assert.deepEqual(ed.s.shapes.map(s => s.x), [0, 1]);
});

test('steps are made from the states actually seen, so an out-of-date "before" still undoes cleanly', () => {
  const ed = editor(2);
  const stale = JSON.stringify(ed.s);           // e.g. taken when a drag started…
  ed.change(s => { s.shapes[0].x = 50; });       // …then another change was recorded meanwhile…
  ed.h.record(stale);                            // …and the drag recorded the old state as its "before"
  ed.change(s => { s.shapes[1].x = 61; });
  const seen = [];
  while (ed.undo()) seen.push(ed.s.shapes.map(s => s.x).join());
  assert.equal(seen.at(-1), '0,1');              // all the way back to the start, through real states only
  while (ed.redo());
  assert.deepEqual(ed.s.shapes.map(s => s.x), [50, 61]);
});

test('a step applied to a state it doesn’t fit is refused', () => {
  const d = diff(['a', 'b'], ['a', 'c']);
  assert.throws(() => apply(['a', 'x'], d, -1), /out of step/);
  assert.deepEqual(apply(['a', 'c'], d, -1), ['a', 'b']);
});
