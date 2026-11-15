// Split: each range typed becomes a file of its own, holding just those pages.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, serve, pause } from '../helpers/browser.mjs';
import { textPdf } from '../helpers/fixtures.mjs';
import { textOf } from '../helpers/inspect.mjs';

let chrome, server;
before(async () => {
  server = await serve({ '/five.pdf': await textPdf(5) });
  chrome = await launch();
});
after(async () => { await chrome?.close(); await server?.close(); });

test('split into files', async () => {
  const page = await chrome.open(server.url('/five.pdf'));
  const seen = await chrome.downloaded();
  await page.keyboard.press('p');
  await page.waitForSelector('#splitRanges', { visible: true });
  await page.type('#splitRanges', '1-2, 5');
  await page.click('#split');
  const first = await chrome.nextDownload(seen);
  seen.add(first.name);
  const second = await chrome.nextDownload(seen);
  const parts = Object.fromEntries([first, second].map(f => [f.name, f.bytes]));
  assert.deepEqual(Object.keys(parts).sort(), ['five (page 5).pdf', 'five (pages 1-2).pdf']);
  const a = await textOf(parts['five (pages 1-2).pdf']), b = await textOf(parts['five (page 5).pdf']);
  assert.deepEqual(a.map(p => p.text.slice(0, 6)), ['Page 1', 'Page 2']);
  assert.deepEqual(b.map(p => p.text.slice(0, 6)), ['Page 5']);
  await pause(100);
  assert.deepEqual(page.errors, []);
});
