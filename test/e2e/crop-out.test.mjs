// Cropping can also reach past the page: the page grows, with white space there, on screen and in the saved file.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, serve, drag, pause } from '../helpers/browser.mjs';
import { textPdf } from '../helpers/fixtures.mjs';
import { textOf } from '../helpers/inspect.mjs';

let chrome, server;
before(async () => {
  server = await serve({ '/doc.pdf': await textPdf(1) });
  chrome = await launch();
});
after(async () => { await chrome?.close(); await server?.close(); });

test('drag the crop box out past the page', async () => {
  const page = await chrome.open(server.url('/doc.pdf'));
  const first = await page.$eval('.page', n => n.getBoundingClientRect().toJSON());
  await page.mouse.click(first.left + first.width / 2, first.top + 200, { button: 'right' });
  await page.waitForSelector('#menu:popover-open');
  await page.keyboard.press('c');
  await page.waitForSelector('.cropper');
  await pause(300);
  // Drag the right edge out, past the page, by a fifth of its width.
  const e = await page.$eval('.crop-box i[data-h="e"]', n => { const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const w = await page.$eval('.page', n => n.getBoundingClientRect().width);
  await drag(page, e, { x: e.x + w * 0.2, y: e.y });
  await pause(100);
  const sheet = await page.$eval('.crop-sheet', n => [n.getBoundingClientRect().width, getComputedStyle(n).backgroundColor]);
  assert.ok(sheet[0] > w * 1.15, 'the white sheet reaches past the page');
  await page.screenshot({ path: '/tmp/crop-out.png' });
  await page.keyboard.press('Enter');
  await pause(500);
  const after = await page.$eval('.page', n => n.getBoundingClientRect().toJSON());
  assert.ok(after.width / after.height > first.width / first.height * 1.15, 'the page is wider for its height');
  const seen = await chrome.downloaded();
  await page.keyboard.down('Control'); await page.keyboard.press('s'); await page.keyboard.up('Control');
  const [one] = await textOf((await chrome.nextDownload(seen)).bytes);
  assert.equal(one.view[0], 0);
  assert.ok(one.view[2] > 612 * 1.15, `saved wider: ${one.view}`);
  assert.equal(one.view[3], 792);
  assert.deepEqual(page.errors, []);
});
