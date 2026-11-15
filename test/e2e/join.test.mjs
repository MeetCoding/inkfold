// Joining two pages at their seam.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, serve, pagePoint, drag, pause } from '../helpers/browser.mjs';
import { textPdf } from '../helpers/fixtures.mjs';
import { textOf } from '../helpers/inspect.mjs';

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
const ctrl = async (page, k) => { await page.keyboard.down('Control'); await page.keyboard.press(k); await page.keyboard.up('Control'); };

test('join pages 1 and 2 at their seam; the rectangle on page 2 comes along', async () => {
  const page = await chrome.open(server.url('/doc.pdf'));
  await page.setViewport({ width: 1000, height: 900 });
  await page.keyboard.press('f');   // fit page: the seam between pages 1 and 2 is in view
  await pause(300);
  await page.evaluate(() => scrollTo(0, document.querySelectorAll('.page')[0].getBoundingClientRect().bottom - 400 + scrollY));
  await pause(200);
  // A rectangle near the top of page 2.
  await page.keyboard.press('r');
  await drag(page, await pagePoint(page, 1, 0.2, 0.05), await pagePoint(page, 1, 0.4, 0.15));
  // Hover the gap between pages 1 and 2: the Join button shows there.
  const gap = await page.evaluate(() => {
    const [a, b] = [...document.querySelectorAll('.page')].map(p => p.getBoundingClientRect());
    return { x: a.left + a.width / 2 + 120, y: (a.bottom + b.top) / 2 };
  });
  // Passing across the gap, from page 1 onto page 2, doesn't bring the button up.
  await page.mouse.move(gap.x, gap.y - 60);
  await page.mouse.move(gap.x, gap.y + 60, { steps: 6 });
  await pause(1300);
  assert.equal(await page.$eval('#seam', n => n.hidden), true, 'passing through: no button');
  await page.mouse.move(gap.x, gap.y - 30);
  await page.mouse.move(gap.x, gap.y, { steps: 4 });
  // Just passing through doesn't bring the button up; resting there for a second does.
  await pause(500);
  assert.equal(await page.$eval('#seam', n => n.hidden), true, 'not yet');
  await page.waitForSelector('#seam:not([hidden])', { timeout: 2000 });
  await page.click('#seam');
  await page.waitForFunction(() => document.querySelectorAll('.page').length === 2);
  await pause(300);
  const ratio = await page.$eval('.page', n => n.getBoundingClientRect().height / n.getBoundingClientRect().width);
  assert.ok(Math.abs(ratio - 1584 / 612) < 0.01, `one long page (${ratio})`);
  assert.equal(await page.$$eval('.page:first-child svg.shapes rect.shape', n => n.length), 1, 'the rectangle moved onto it');
  assert.match(await page.$eval('.page:first-child .pagenum', n => n.textContent), /joined/);

  const [one, two] = await textOf(await save(page));
  assert.deepEqual(one.view, [0, 0, 612, 1584]);
  assert.match(one.text, /Page 1 of .*Page 2 of/s);
  assert.match(two.text, /^Page 3 of/);

  // Undo: three pages again, the rectangle back on page 2.
  await ctrl(page, 'z');
  await page.waitForFunction(() => document.querySelectorAll('.page').length === 3);
  assert.equal(await page.$$eval('.page:nth-child(2) svg.shapes rect.shape', n => n.length), 1);
  assert.deepEqual(page.errors, []);
});
