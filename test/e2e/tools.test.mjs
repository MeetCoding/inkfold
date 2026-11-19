// The highlighter stays on after a highlight; with the toolbar hidden, the pill shows the tool's icon and its
// options, each with the key that picks it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, serve, drag, pause } from '../helpers/browser.mjs';
import { textPdf } from '../helpers/fixtures.mjs';

let chrome, server;
before(async () => {
  server = await serve({ '/doc.pdf': await textPdf(1) });
  chrome = await launch();
});
after(async () => { await chrome?.close(); await server?.close(); });

const lineAt = (page, n) => page.evaluate(n => {
  const r = [...document.querySelectorAll('.page .textLayer span')].find(s => s.textContent.startsWith(`Line ${n}`)).getBoundingClientRect();
  return [{ x: r.left + 1, y: r.top + r.height / 2 }, { x: r.right - 1, y: r.top + r.height / 2 }];
}, n);

test('the highlighter stays on, one passage after another', async () => {
  const page = await chrome.open(server.url('/doc.pdf'));
  await page.waitForSelector('.page .textLayer span');
  await page.keyboard.press('h');
  await drag(page, ...await lineAt(page, 1));
  await pause(200);
  assert.equal(await page.$eval('body', b => b.dataset.tool), 'highlight');
  await drag(page, ...await lineAt(page, 3));
  await pause(200);
  assert.equal(await page.$$eval('.page svg.hl rect', n => n.length), 2);
});

test('the pill, with the toolbar hidden', async () => {
  const page = await chrome.open(server.url('/doc.pdf'));
  await page.keyboard.down('Shift'); await page.keyboard.press('h'); await page.keyboard.up('Shift');
  const pill = () => page.$eval('#status', n => ({
    text: n.querySelector('.tool').textContent, icon: !!n.querySelector('.tool svg'),
    keys: [...n.querySelectorAll('.opts small')].map(s => s.textContent).join(' '),
    shift: n.querySelectorAll('.set.shifted > .shift svg').length,   // the colours' one shift arrow
  }));
  assert.deepEqual(await pill(), { text: '', icon: true, keys: '', shift: 0 }, 'pointer: just its icon');
  await page.keyboard.press('r');
  assert.deepEqual(await pill(), { text: '', icon: true, keys: '1 2 3 4 5 1 2 3 R', shift: 1 }, 'colours (with Shift), thickness, fill');
  await page.keyboard.press('h');
  assert.deepEqual((await pill()).keys, '1 2 3 4 5', 'colours only');
  await page.click('#status .shifted button.opt:nth-of-type(3)');   // the third colour, by clicking it
  assert.equal(await page.$eval('#status .opt.on small', n => n.textContent), '3');
  await page.keyboard.press('t');   // text: its size, with − and + to click
  const size = () => page.$eval('#status .size .val', n => n.textContent);
  const was = parseFloat(await size());
  await page.click('#status .size .step:last-child');
  assert.ok(parseFloat(await size()) > was, 'the + button makes text larger');
  await page.click('#status .size .step:first-child');
  assert.equal(parseFloat(await size()), was, 'and − brings it back');
  await page.keyboard.press('Escape');
  await page.keyboard.down('Shift'); await page.keyboard.press('h'); await page.keyboard.up('Shift');
});
