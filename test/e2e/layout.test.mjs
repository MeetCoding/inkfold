// The toolbar runs along the bottom; cards open in the bottom-right corner, just above it; hidden, the toolbar
// comes back when the pointer touches the bottom edge.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, serve, pause } from '../helpers/browser.mjs';
import { textPdf } from '../helpers/fixtures.mjs';

let chrome, server;
before(async () => {
  server = await serve({ '/doc.pdf': await textPdf(3) });
  chrome = await launch();
});
after(async () => { await chrome?.close(); await server?.close(); });

const box = (page, sel) => page.$eval(sel, n => { const r = n.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, right: r.right, left: r.left }; });

test('toolbar at the bottom, cards in the bottom-right corner above it', async () => {
  const page = await chrome.open(server.url('/doc.pdf'));
  const { innerWidth: W, innerHeight: H } = await page.evaluate(() => ({ innerWidth, innerHeight }));
  const bar = await box(page, 'header');
  assert.equal(Math.round(bar.bottom), H, 'the toolbar touches the bottom edge');
  for (const [key, sel] of [['p', '#panel'], ['?', '#keys']]) {
    await page.keyboard.press(key);
    await page.waitForSelector(`${sel}:popover-open`);
    const r = await box(page, sel);
    assert.ok(W - r.right <= 14 && r.bottom <= bar.top && bar.top - r.bottom <= 14, `${sel} sits in the corner above the toolbar`);
    await page.keyboard.press('Escape');
    await page.evaluate(() => document.activeElement?.blur());   // (Escape leaves the focus in the panel's field)
  }
  // The first page starts at the top; the last page ends clear of the toolbar.
  assert.ok((await box(page, '.page:first-child')).top < 40);
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await pause(200);
  assert.ok((await box(page, '.page:last-child')).bottom <= bar.top, 'the last page isn’t under the toolbar');
});

test('hidden toolbar comes back at the bottom edge', async () => {
  const page = await chrome.open(server.url('/doc.pdf'));
  const H = await page.evaluate(() => innerHeight);
  await page.keyboard.down('Shift'); await page.keyboard.press('h'); await page.keyboard.up('Shift');
  await pause(400);
  assert.ok((await box(page, 'header')).top >= H, 'slid away downwards');
  await page.mouse.move(500, H - 2);
  await pause(400);
  assert.equal(Math.round((await box(page, 'header')).bottom), H, 'back at the bottom edge');
  await page.mouse.move(500, 200);
  await pause(400);
  assert.ok((await box(page, 'header')).top >= H, 'and away again');
  await page.keyboard.down('Shift'); await page.keyboard.press('h'); await page.keyboard.up('Shift');   // (remembered: put it back)
});
