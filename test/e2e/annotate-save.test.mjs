// The whole loop in a real browser: open a web PDF, annotate it, save, check the file, and open the saved copy
// again to check that everything comes back editable.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, serve, pagePoint, drag, pause } from '../helpers/browser.mjs';
import { textPdf } from '../helpers/fixtures.mjs';
import { annotationsOf } from '../helpers/inspect.mjs';

let chrome, server;
before(async () => {
  server = await serve({ '/doc.pdf': await textPdf(2) });
  chrome = await launch();
});
after(async () => { await chrome?.close(); await server?.close(); });

const overlay = page => page.evaluate(() => ({
  rects: document.querySelectorAll('.page:first-child svg.shapes rect.shape').length,
  ellipses: document.querySelectorAll('.page:first-child svg.shapes ellipse.shape').length,
  texts: document.querySelectorAll('.page:first-child svg.shapes g.text').length,
  highlights: document.querySelectorAll('.page:first-child svg.hl rect').length,
  pages: document.querySelectorAll('.page').length,
}));

test('annotate, save, reopen', async () => {
  const page = await chrome.open(server.url('/doc.pdf'));
  assert.equal((await overlay(page)).pages, 2);

  // A rectangle and a filled ellipse.
  await page.keyboard.press('r');
  await drag(page, await pagePoint(page, 0, 0.15, 0.55), await pagePoint(page, 0, 0.45, 0.7));
  await page.keyboard.press('o');
  await page.keyboard.press('o');   // again: filled
  await drag(page, await pagePoint(page, 0, 0.55, 0.55), await pagePoint(page, 0, 0.85, 0.7));

  // A highlight across the first line of text.
  await page.waitForSelector('.page:first-child .textLayer span');
  await page.keyboard.press('h');
  const line = await page.evaluate(() => {
    const r = [...document.querySelectorAll('.page:first-child .textLayer span')].find(s => s.textContent.startsWith('Line 1')).getBoundingClientRect();
    return { y: r.top + r.height / 2, x1: r.left + 2, x2: r.left + r.width * 0.6 };
  });
  await drag(page, { x: line.x1, y: line.y }, { x: line.x2, y: line.y });
  await pause(300);

  // A text box with some math.
  await page.keyboard.press('t');
  const at = await pagePoint(page, 0, 0.2, 0.8);
  await page.mouse.click(at.x, at.y);
  await pause(200);
  await page.keyboard.type('Hello $x^2$');
  await page.keyboard.press('Escape');
  await pause(300);
  const shown = await overlay(page);
  assert.deepEqual([shown.rects, shown.ellipses, shown.texts], [1, 1, 1]);
  assert.ok(shown.highlights >= 1, 'a highlight was drawn');

  // Undo and redo the text box: it goes and comes back.
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  assert.equal((await overlay(page)).texts, 0);
  await page.keyboard.down('Control'); await page.keyboard.press('y'); await page.keyboard.up('Control');
  assert.equal((await overlay(page)).texts, 1);

  // Rotate page 2 and save.
  await page.evaluate(() => document.querySelectorAll('.page')[1].scrollIntoView());
  await pause(300);
  const p2 = await pagePoint(page, 1, 0.5, 0.5);
  await page.mouse.move(p2.x, p2.y);
  await page.keyboard.press(']');
  const seen = await chrome.downloaded();
  await page.keyboard.down('Control'); await page.keyboard.press('s'); await page.keyboard.up('Control');
  const saved = await chrome.nextDownload(seen);
  assert.deepEqual(page.errors, []);

  const [one, two] = await annotationsOf(saved.bytes);
  const kinds = one.annots.filter(a => a.titleObj?.str === 'Inkfold').map(a => a.subtype).sort();
  assert.deepEqual(kinds, ['Circle', 'FreeText', 'Highlight', 'Square']);
  assert.equal(one.annots.find(a => a.subtype === 'FreeText').contentsObj.str, 'Hello $x^2$');
  assert.equal(two.rotate, 90);

  // Open the saved copy: everything is editable again (drawn by Inkfold, not baked into the page).
  server.files['/saved.pdf'] = saved.bytes;
  const again = await chrome.open(server.url('/saved.pdf'));
  await pause(300);
  const back = await overlay(again);
  assert.deepEqual([back.rects, back.ellipses, back.texts, back.pages], [1, 1, 1, 2]);
  assert.ok(back.highlights >= 1);
  const filled = await again.evaluate(() => document.querySelector('.page:first-child svg.shapes ellipse.shape').getAttribute('fill'));
  assert.notEqual(filled, 'none', 'the ellipse is still filled');
  assert.deepEqual(again.errors, []);
});
