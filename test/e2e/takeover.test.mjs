// content.js: a PDF opened in a tab is shown in Inkfold in that same tab, at its own address.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, serve } from '../helpers/browser.mjs';
import { textPdf } from '../helpers/fixtures.mjs';

let chrome, server;
before(async () => {
  server = await serve({ '/report.pdf': await textPdf(3) });
  chrome = await launch();
});
after(async () => { await chrome?.close(); await server?.close(); });

test('a web PDF opens in Inkfold in its own tab', async () => {
  const page = await chrome.browser.newPage();
  await page.setViewport({ width: 1000, height: 1400 });
  const url = server.url('/report.pdf');
  await page.goto(url);
  await page.waitForSelector('body.loaded .page canvas', { timeout: 20000 });
  assert.equal(page.url(), url, 'the tab keeps the PDF’s address');
  assert.equal(await page.$$eval('.page', n => n.length), 3);
  await page.waitForSelector('.page:first-child .textLayer span');
  const text = await page.$eval('.page:first-child .textLayer', n => n.textContent);
  assert.match(text, /Page 1 of the Inkfold test document/);
});

test('turning automatic opening off leaves PDFs to Chrome', async () => {
  await chrome.worker.evaluate(() => chrome.storage.local.set({ auto: false }));
  const page = await chrome.browser.newPage();
  await page.goto(server.url('/report.pdf'));
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(await page.$('body.loaded'), null);
  await chrome.worker.evaluate(() => chrome.storage.local.set({ auto: true }));
});
