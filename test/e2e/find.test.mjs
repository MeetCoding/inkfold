// Find: Tab to a result shows its page; Enter then closes the box without scrolling a second time.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, serve, pause } from '../helpers/browser.mjs';
import { textPdf } from '../helpers/fixtures.mjs';

let chrome, server;
before(async () => {
  server = await serve({ '/ten.pdf': await textPdf(10) });
  chrome = await launch();
});
after(async () => { await chrome?.close(); await server?.close(); });

test('Tab to a page, then Enter: one trip, not two', async () => {
  const page = await chrome.open(server.url('/ten.pdf'));
  await page.keyboard.down('Control'); await page.keyboard.press('f'); await page.keyboard.up('Control');
  await page.keyboard.type('Page 7 of');
  await page.waitForSelector('#findList li button');
  // Record every scroll position from here on.
  await page.evaluate(() => { window.__y = []; addEventListener('scroll', () => window.__y.push(scrollY), { passive: true }); });
  await page.keyboard.press('Tab');
  await pause(1500);
  const there = await page.evaluate(() => scrollY);
  assert.ok(there > 1000, 'Tab went down to page 7');
  await page.evaluate(() => { window.__y = []; });
  await page.keyboard.press('Enter');
  await pause(1500);
  const moves = await page.evaluate(() => window.__y);
  assert.deepEqual(moves, [], 'Enter didn’t scroll again');
  assert.equal(await page.$('#find:popover-open'), null, 'the box closed');
  assert.equal(await page.$eval('#pageNum', n => n.value), '7');
});
