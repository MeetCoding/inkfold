// The cutter: across text it strikes through in red; anywhere else it crosses out the box dragged. Both are saved
// as standard annotations (StrikeOut, Ink) and come back editable.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, serve, pagePoint, drag, pause } from '../helpers/browser.mjs';
import { textPdf } from '../helpers/fixtures.mjs';
import { annotationsOf } from '../helpers/inspect.mjs';

let chrome, server;
before(async () => {
  server = await serve({ '/doc.pdf': await textPdf(1) });
  chrome = await launch();
});
after(async () => { await chrome?.close(); await server?.close(); });

const marks = page => page.evaluate(() => ({
  lines: document.querySelectorAll('.page svg.shapes line.shape').length,
  crosses: document.querySelectorAll('.page svg.shapes path.shape').length,
  stroke: document.querySelector('.page svg.shapes .shape')?.getAttribute('stroke'),
}));

test('strike through text, cross out the rest, save, reopen', async () => {
  const page = await chrome.open(server.url('/doc.pdf'));
  await page.waitForSelector('.page .textLayer span');
  await page.keyboard.press('x');
  const line = await page.evaluate(() => {
    const r = [...document.querySelectorAll('.page .textLayer span')].find(s => s.textContent.startsWith('Line 4')).getBoundingClientRect();
    return { y: r.top + r.height / 2, x1: r.left + 1, x2: r.right - 1 };
  });
  await drag(page, { x: line.x1, y: line.y }, { x: line.x2, y: line.y });
  await pause(200);
  // Off the text: an X across the box dragged out.
  await drag(page, await pagePoint(page, 0, 0.3, 0.6), await pagePoint(page, 0, 0.6, 0.75));
  await pause(100);
  assert.equal(await page.$eval('body', b => b.dataset.tool), 'cut', 'the cutter stays on');
  assert.deepEqual(await marks(page), { lines: 1, crosses: 1, stroke: '#e5484d' });
  assert.equal(await page.$eval('#styleBox', n => n.hidden), true, 'nothing to style: always red');

  const seen = await chrome.downloaded();
  await page.keyboard.down('Control'); await page.keyboard.press('s'); await page.keyboard.up('Control');
  const [one] = await annotationsOf((await chrome.nextDownload(seen)).bytes);
  assert.deepEqual(one.annots.map(a => a.subtype).sort(), ['Ink', 'StrikeOut']);

  // The eraser takes the X off.
  await page.keyboard.press('v');
  const x = await pagePoint(page, 0, 0.45, 0.675);   // the middle of the X
  await page.keyboard.down('e'); await page.mouse.click(x.x, x.y); await page.keyboard.up('e');
  assert.equal((await marks(page)).crosses, 0);
  assert.deepEqual(page.errors, []);
});
