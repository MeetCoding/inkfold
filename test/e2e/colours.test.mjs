// Shift+1…5 pick the toolbar's colours, for new annotations and for the one selected.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, serve, pagePoint, drag, pause } from '../helpers/browser.mjs';
import { textPdf } from '../helpers/fixtures.mjs';

let chrome, server;
before(async () => {
  server = await serve({ '/doc.pdf': await textPdf(1) });
  chrome = await launch();
});
after(async () => { await chrome?.close(); await server?.close(); });

const stroke = page => page.$eval('.page svg.shapes rect.shape', n => n.getAttribute('stroke'));
const checked = page => page.$eval('#palette [aria-checked="true"]', n => n.dataset.c);

test('Shift+number picks a colour', async () => {
  const page = await chrome.open(server.url('/doc.pdf'));
  await page.keyboard.press('r');
  await page.keyboard.down('Shift'); await page.keyboard.press('Digit5'); await page.keyboard.up('Shift');
  assert.equal(await checked(page), '#1f1f1f', 'the fifth shape colour, black');
  await drag(page, await pagePoint(page, 0, 0.2, 0.5), await pagePoint(page, 0, 0.4, 0.6));
  assert.equal(await stroke(page), '#1f1f1f');
  // Select it and recolour it: Shift+3 is green.
  const hit = await pagePoint(page, 0, 0.2, 0.55);
  await page.mouse.click(hit.x, hit.y);
  await page.keyboard.down('Shift'); await page.keyboard.press('Digit3'); await page.keyboard.up('Shift');
  assert.equal(await stroke(page), '#2f9e44');
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  assert.equal(await stroke(page), '#1f1f1f', 'and it can be undone');
  // Shift+6 doesn't exist: nothing happens.
  await page.keyboard.down('Shift'); await page.keyboard.press('Digit6'); await page.keyboard.up('Shift');
  await pause(100);
  assert.deepEqual(page.errors, []);
});
