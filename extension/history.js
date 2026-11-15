// @ts-check
// Undo and redo, kept as differences rather than as copies of the whole document.
//
// The viewer describes its state as a snapshot: JSON of { entries, shapes } (page entries and annotations).
// Before each change it hands over the snapshot from before it (record). Only the newest step is held as a whole
// snapshot; once the next step starts (or Undo is pressed) it is reduced to what actually changed: in each list,
// the run of items between the unchanged ones at its start and at its end. Moving one shape or adding one page
// is then a step of one or two items, however long the document and however many steps are kept.

const items = snap => {
  const o = typeof snap === 'string' ? JSON.parse(snap) : snap;
  return { entries: o.entries.map(x => JSON.stringify(x)), shapes: o.shapes.map(x => JSON.stringify(x)) };
};
const state = it => ({ entries: it.entries.map(x => JSON.parse(x)), shapes: it.shapes.map(x => JSON.parse(x)) });

// a -> b, as { at, from, to }: b is a with a.slice(at, at + from.length) replaced by `to`.
export function diff(a, b) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  return { at: s, from: a.slice(s, a.length - e), to: b.slice(s, b.length - e) };
}
// dir 1 turns a into b; dir -1 turns b back into a. Steps are made from consecutive states actually seen, so each
// one fits the state it's applied to; the check is a safety net all the same: better no undo than a wrong one.
export function apply(list, d, dir) {
  const [out, inn] = dir < 0 ? [d.to, d.from] : [d.from, d.to];
  if (d.at + out.length > list.length || out.some((x, k) => list[d.at + k] !== x)) throw new Error('history out of step');
  return [...list.slice(0, d.at), ...inn, ...list.slice(d.at + out.length)];
}
const step = (cur, d, dir) => {
  try { return state({ entries: apply(cur.entries, d.entries, dir), shapes: apply(cur.shapes, d.shapes, dir) }); } catch { return null; }
};

export function createHistory({ limit = 300 } = {}) {
  let past = [], future = [], pending = null;   // pending: the newest step's whole "before", until it's reduced

  // The newest step, as differences, now that `now` (the state it led to) is known.
  function settle(now) {
    if (!pending) return;
    const after = items(now);
    past.push({ entries: diff(pending.entries, after.entries), shapes: diff(pending.shapes, after.shapes) });
    pending = null;
    if (past.length > limit) past.splice(0, past.length - limit);
  }

  return {
    get canUndo() { return past.length > 0 || !!pending; },
    get canRedo() { return future.length > 0; },
    get size() { return past.length + (pending ? 1 : 0); },

    // A change is about to be made (or has just been made); before: the snapshot from before it. The state seen
    // when the next change is recorded (or Undo is pressed) is taken as what this one led to, so anything changed
    // in between without being recorded becomes part of this step.
    record(before) {
      settle(before);
      pending = items(before);
      future = [];
    },

    // now: the current snapshot. -> the state to go back to ({ entries, shapes }), or null.
    undo(now) {
      settle(now);
      const d = past.pop();
      if (!d) return null;
      const back = step(items(now), d, -1);
      if (!back) { past = []; future = []; return null; }   // out of step (see apply): start afresh
      future.push(d);
      return back;
    },

    redo(now) {
      const d = future.pop();
      if (!d) return null;
      const next = step(items(now), d, 1);
      if (!next) { past = []; future = []; return null; }
      past.push(d);
      return next;
    },

    clear() { past = []; future = []; pending = null; },
  };
}
