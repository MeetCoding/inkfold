// Text recognition: a scanned page, with no text of its own, becomes searchable, and a saved copy keeps the text.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, serve } from '../helpers/browser.mjs';
import { scannedPdf } from '../helpers/fixtures.mjs';
import { textOf } from '../helpers/inspect.mjs';

let chrome, server;
before(async () => {
  server = await serve({ '/scan.pdf': await scannedPdf() });
  chrome = await launch();
});
after(async () => { await chrome?.close(); await server?.close(); });

test('a scanned page gets its text, and keeps it when saved', { timeout: 120000 }, async () => {
  const page = await chrome.open(server.url('/scan.pdf'));
  await page.waitForFunction(() => /Recognised on this computer/.test(document.querySelector('.page .textLayer')?.textContent ?? ''), { timeout: 90000 });
  const text = await page.$eval('.page .textLayer', n => n.textContent.replace(/\s+/g, ' '));
  assert.match(text, /A scanned page with no text layer/);
  const seen = await chrome.downloaded();
  await page.keyboard.down('Control'); await page.keyboard.press('s'); await page.keyboard.up('Control');
  const [one] = await textOf((await chrome.nextDownload(seen)).bytes);
  assert.match(one.text.replace(/\s+/g, ' '), /Searchable after reading/);
  assert.deepEqual(page.errors, []);
});
