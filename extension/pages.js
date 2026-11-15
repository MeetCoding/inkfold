// Page ranges as people type them, for Delete, Rotate and Split in the Pages and file panel.

// "2-4, 7, 10-end" -> [{ label: '2-4', idx: [1, 2, 3] }, { label: '7', idx: [6] }, …]
export function parseRanges(text, n) {
  const groups = [];
  for (const raw of text.split(/[,;]/)) {
    const t = raw.trim().toLowerCase();
    if (!t) continue;
    const mt = t.match(/^(\d+|end|last)?\s*(?:(-|–|—|to)\s*(\d+|end|last)?)?$/);
    if (!mt || (!mt[1] && !mt[2])) throw new Error(`“${raw.trim()}” isn’t a page or a range.`);
    const num = s => (s === undefined ? undefined : /^(end|last)$/.test(s) ? n : +s);
    const a = num(mt[1]) ?? 1, b = mt[2] ? num(mt[3]) ?? n : a;
    if (a < 1 || b > n || a > b) throw new Error(`“${raw.trim()}” is outside pages 1–${n}.`);
    groups.push({ label: a === b ? `${a}` : `${a}-${b}`, idx: Array.from({ length: b - a + 1 }, (_, k) => a - 1 + k) });
  }
  if (!groups.length) throw new Error('Type the pages first: a page like 3, a range like 5-7, or several, like 3, 5-7, 10-end.');
  return groups;
}
