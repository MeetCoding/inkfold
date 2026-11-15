// Geometry of selected text.

// Word boxes ({ l, t, r, b }, on-screen pixels with y pointing down) that sit on the same line become one box per line, so a highlight is one bar per
// line rather than a box per word. (Boxes overlapping by more than half the shorter one's height share a line.)
export function mergeLines(boxes) {
  const out = [];
  boxes.sort((a, b) => a.t - b.t || a.l - b.l);
  for (const b of boxes) {
    const h = b.b - b.t;
    const m = out.find(o => Math.min(o.b, b.b) - Math.max(o.t, b.t) > 0.5 * Math.min(h, o.b - o.t)
      && b.l <= o.r + h && b.r >= o.l - h);
    if (m) Object.assign(m, { l: Math.min(m.l, b.l), t: Math.min(m.t, b.t), r: Math.max(m.r, b.r), b: Math.max(m.b, b.b) });
    else out.push({ ...b });
  }
  return out;
}
