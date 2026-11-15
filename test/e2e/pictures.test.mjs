// Pictures placed by an earlier session (Stamp annotations, PNG and JPEG) open as editable pictures again, and
// survive another save.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as lib from '../../extension/lib/pdf-lib.esm.min.js';
import { writer } from '../../extension/annotations.js';
import { layout, pdfOps } from '../../extension/textbox.js';
import { launch, serve, pause } from '../helpers/browser.mjs';
import { textPdf } from '../helpers/fixtures.mjs';
import { png, jpeg } from '../helpers/images.mjs';
import { annotationsOf } from '../helpers/inspect.mjs';

let chrome, server;
before(async () => {
  const doc = await lib.PDFDocument.load(await textPdf(1));
  const images = { p: { mime: 'image/png', bytes: png(20, 10, [0, 120, 255, 200]) }, j: { mime: 'image/jpeg', bytes: jpeg } };
  const w = writer(lib, doc, { layout, pdfOps, images: k => images[k] });
  await w.add(doc.getPage(0), { type: 'image', x1: 100, y1: 300, x2: 300, y2: 400, img: 'p' });
  await w.add(doc.getPage(0), { type: 'image', x1: 350, y1: 300, x2: 430, y2: 360, img: 'j' });
  server = await serve({ '/pics.pdf': await doc.save() });
  chrome = await launch();
});
after(async () => { await chrome?.close(); await server?.close(); });

test('saved pictures come back editable and are saved again', async () => {
  const page = await chrome.open(server.url('/pics.pdf'));
  await pause(300);
  const hrefs = await page.$$eval('.page svg.shapes g.image image', n => n.map(i => i.getAttribute('href').slice(0, 22)));
  assert.deepEqual(hrefs.sort(), ['data:image/jpeg;base64', 'data:image/png;base64,']);
  // Delete the first picture, then save: one picture is left in the file.
  await page.click('.page svg.shapes rect.ihit');
  await page.keyboard.press('Delete');
  const seen = await chrome.downloaded();
  await page.keyboard.down('Control'); await page.keyboard.press('s'); await page.keyboard.up('Control');
  const [one] = await annotationsOf((await chrome.nextDownload(seen)).bytes);
  assert.equal(one.annots.filter(a => a.subtype === 'Stamp').length, 1);
  assert.deepEqual(page.errors, []);
});
