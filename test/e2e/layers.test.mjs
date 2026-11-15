// The right-click menus: an annotation's (layer order), and the page's Join.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, serve, pagePoint, drag } from '../helpers/browser.mjs';
import { textPdf } from '../helpers/fixtures.mjs';
import { annotationsOf } from '../helpers/inspect.mjs';

let chrome, server;
before(async () => {
  server = await serve({ '/doc.pdf': await textPdf(3) });
  chrome = await launch();
});
after(async () => { await chrome?.close(); await server?.close(); });

const save = async page => {
  const seen = await chrome.downloaded();
  await page.keyboard.down('Control'); await page.keyboard.press('s'); await page.keyboard.up('Control');
  try { return (await chrome.nextDownload(seen)).bytes; }
  catch (e) { throw new Error(e.message + '; toast: ' + await page.$eval('#toast', n => n.textContent) + '; focus: ' + await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80))); }
};

test('the page menu joins too; right-click an annotation to bring it to front or send it back', async () => {
  const page = await chrome.open(server.url('/doc.pdf'));
  // Two overlapping rectangles on page 1: red first, then black on top.
  await page.keyboard.press('r');
  await drag(page, await pagePoint(page, 0, 0.2, 0.4), await pagePoint(page, 0, 0.5, 0.6));
  await page.keyboard.press('r');
  await page.keyboard.down('Shift'); await page.keyboard.press('Digit5'); await page.keyboard.up('Shift');
  await drag(page, await pagePoint(page, 0, 0.3, 0.45), await pagePoint(page, 0, 0.6, 0.65));
  const order = () => page.$$eval('.page:first-child svg.shapes rect.shape', n => n.map(r => r.getAttribute('stroke')));
  assert.deepEqual(await order(), ['#e5484d', '#1f1f1f']);
  // Right-click the red one's edge: its own menu.
  const edge = await pagePoint(page, 0, 0.2, 0.42);
  await page.mouse.click(edge.x, edge.y, { button: 'right' });
  await page.waitForSelector('#menu:popover-open');
  assert.match(await page.$eval('#menuTitle', n => n.textContent), /^Rectangle/);
  assert.equal(await page.$eval('#menu button', n => n.disabled), false, 'Bring to front');
  await page.keyboard.press('f');
  assert.deepEqual(await order(), ['#1f1f1f', '#e5484d'], 'red is on top now');
  // Saved in that order, so other viewers stack them the same way.
  const [one] = await annotationsOf(await save(page));
  assert.deepEqual(one.annots.map(a => a.color.join()), ['31,31,31', '229,72,77']);
  // And back.
  await page.mouse.click(edge.x, edge.y, { button: 'right' });
  await page.waitForSelector('#menu:popover-open');
  await page.keyboard.press('b');
  assert.deepEqual(await order(), ['#e5484d', '#1f1f1f']);
  // A right-click on the page, away from them: the page's menu, with Join.
  const blank = await pagePoint(page, 0, 0.8, 0.9);
  await page.mouse.click(blank.x, blank.y, { button: 'right' });
  await page.waitForSelector('#menu:popover-open');
  assert.match(await page.$eval('#menuTitle', n => n.textContent), /^Page 1 of 3/);
  await page.keyboard.press('j');
  await page.waitForFunction(() => document.querySelectorAll('.page').length === 2);
  assert.deepEqual(page.errors, []);
});
