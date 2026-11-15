// What makes the extension the size it is: the biggest files, and totals by folder, uncompressed and zipped
// (the Web Store and the release zips use deflate). Run with `npm run size`.
import { readdir, readFile, stat } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { join, relative, dirname } from 'node:path';

const root = new URL('../extension/', import.meta.url).pathname;
const files = [];
async function walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p);
    else files.push({ path: relative(root, p), size: (await stat(p)).size, zipped: deflateRawSync(await readFile(p), { level: 9 }).length });
  }
}
await walk(root);
const mb = n => (n / 1048576).toFixed(2).padStart(6) + ' MB';
const total = files.reduce((a, f) => ({ size: a.size + f.size, zipped: a.zipped + f.zipped }), { size: 0, zipped: 0 });
console.log(`extension/: ${files.length} files, ${mb(total.size)} (about ${mb(total.zipped).trim()} zipped)\n`);
console.log('Biggest files (zipped):');
for (const f of files.sort((a, b) => b.zipped - a.zipped).slice(0, 12)) console.log(`  ${mb(f.zipped)}  ${f.path}`);
const groups = new Map();
for (const f of files) {
  const g = dirname(f.path) === '.' ? '(top level)' : dirname(f.path).split('/').slice(0, 2).join('/');
  groups.set(g, (groups.get(g) ?? 0) + f.zipped);
}
console.log('\nBy folder (zipped):');
for (const [g, n] of [...groups].sort((a, b) => b[1] - a[1])) console.log(`  ${mb(n)}  ${g}`);
