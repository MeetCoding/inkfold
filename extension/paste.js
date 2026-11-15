// @ts-check
// Magic paste: what kind of thing was copied.

// Markdown or just text? A couple of Markdown signs (a heading, a table, code, a checklist,
// or several lighter ones like lists, bold and links) make it Markdown.
export function looksLikeMarkdown(t) {
  let score = 0;
  if (/^#{1,6}\s+\S/m.test(t)) score += 2;
  if (/^```/m.test(t)) score += 2;
  if (/^\s*\|.*\|\s*$/m.test(t) && /^\s*\|?\s*:?-{3,}/m.test(t)) score += 2;
  if (/^\s*[-*+] \[[ xX]\]\s/m.test(t)) score += 2;
  if (/^\s*([-*+]|\d+[.)])\s+\S/m.test(t) && t.includes('\n')) score += 1;
  if (/\*\*[^*\n]+\*\*|__[^_\n]+__/.test(t)) score += 1;
  if (/\[[^\]\n]+\]\([^)\s]+\)/.test(t)) score += 1;
  if (/^>\s/m.test(t)) score += 1;
  if (/\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\begin\{/.test(t)) score += 1;
  return score >= 2;
}
