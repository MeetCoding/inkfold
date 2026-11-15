// Magic paste: copying text from the PDF itself offers it; the card that opened by itself closes after about three
// seconds, but not while the pointer is on it; its "open by itself" setting is a switch.
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

async function copyLine(page, n) {
  const line = await page.evaluate(n => {
    const r = [...document.querySelectorAll('.page .textLayer span')].find(s => s.textContent.startsWith(`Line ${n}`)).getBoundingClientRect();
    return { y: r.top + r.height / 2, x1: r.left + 1, x2: r.right - 1 };
  }, n);
  await drag(page, { x: line.x1, y: line.y }, { x: line.x2, y: line.y });
  await page.keyboard.down('Control'); await page.keyboard.press('c'); await page.keyboard.up('Control');
}
const isOpen = page => page.$eval('#magic', b => b.matches(':popover-open'));

test('a copy from the PDF opens the card, which closes by itself', async () => {
  const page = await chrome.open(server.url('/doc.pdf'));
  await page.waitForSelector('.page .textLayer span');
  await pause(1800);   // the clipboard as it was when the PDF opened is the baseline
  await copyLine(page, 2);
  await page.waitForFunction(() => document.querySelector('#magic:popover-open h2')?.textContent === 'You copied something', { timeout: 4000 });
  assert.match(await page.$eval('#magic .snippet', n => n.textContent), /Line 2: the quick brown fox/);
  assert.equal(await page.$eval('#magic input.switch', n => [n.getAttribute('role'), n.checked].join()), 'switch,true');
  await pause(3600);
  assert.equal(await isOpen(page), false, 'closed after about three seconds');
});

test('the card waits while the pointer is on it', async () => {
  const page = await chrome.open(server.url('/doc.pdf'));
  await page.waitForSelector('.page .textLayer span');
  await pause(1800);
  await copyLine(page, 3);
  await page.waitForSelector('#magic:popover-open .timer');
  await page.hover('#magic h2');
  await pause(4000);
  assert.equal(await isOpen(page), true, 'still open while hovered');
  await page.mouse.move(5, 300);
  await pause(3500);
  assert.equal(await isOpen(page), false, 'closed once the pointer left');
});
