// Emoji in a text box: drawn (Helvetica has none, so each is a small picture from the system's emoji font) on
// screen, in the saved PDF, and again when the saved copy is opened.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, serve, pagePoint, pause } from '../helpers/browser.mjs';
import { textPdf } from '../helpers/fixtures.mjs';
import { annotationsOf } from '../helpers/inspect.mjs';
import { PDFDocument, PDFName, PDFDict } from 'pdf-lib';

let chrome, server;
before(async () => {
  server = await serve({ '/doc.pdf': await textPdf(1) });
  chrome = await launch();
});
after(async () => { await chrome?.close(); await server?.close(); });

const TEXT = 'Hi 🎉 👍🏽 🇮🇳 © 🎉';   // a skin tone and a flag are one emoji each; © is Helvetica's own
const drawn = page => page.evaluate(() => {
  const g = document.querySelector('.page:first-child svg.shapes g.text');
  return g && { pics: g.querySelectorAll('image').length, text: [...g.querySelectorAll('text')].map(t => t.textContent).join('|') };
});

test('emoji in a text box', async () => {
  const page = await chrome.open(server.url('/doc.pdf'));
  await page.keyboard.press('t');
  const at = await pagePoint(page, 0, 0.2, 0.8);
  await page.mouse.click(at.x, at.y);
  await pause(200);
  await page.keyboard.sendCharacter(TEXT);
  await page.keyboard.press('Escape');
  await pause(400);
  assert.deepEqual(await drawn(page), { pics: 4, text: 'Hi | | | © ' }, 'four emoji pictures, the rest as text');

  const seen = await chrome.downloaded();
  await page.keyboard.down('Control'); await page.keyboard.press('s'); await page.keyboard.up('Control');
  const saved = await chrome.nextDownload(seen);
  assert.deepEqual(page.errors, []);
  const [one] = await annotationsOf(saved.bytes);
  assert.equal(one.annots.find(a => a.subtype === 'FreeText').contentsObj.str, TEXT, 'the text, emoji and all');

  // Its appearance draws three pictures (🎉 twice, embedded once), each a PNG image.
  const doc = await PDFDocument.load(saved.bytes);
  const annot = doc.getPages()[0].node.Annots().asArray().map(r => doc.context.lookup(r)).find(a => a.get(PDFName.of('Subtype')) === PDFName.of('FreeText'));
  const look = doc.context.lookup(annot.lookup(PDFName.of('AP'), PDFDict).get(PDFName.of('N')));
  const xo = look.dict.lookup(PDFName.of('Resources'), PDFDict).lookup(PDFName.of('XObject'), PDFDict);
  assert.deepEqual(xo.keys().map(k => k.asString()), ['/E0', '/E1', '/E2']);
  for (const k of xo.keys()) assert.equal(xo.lookup(k).dict.get(PDFName.of('Subtype')), PDFName.of('Image'));
  const ops = new TextDecoder().decode(look.getContents());
  assert.equal(ops.match(/\/E\d Do/g).length, 4);

  server.files['/saved.pdf'] = saved.bytes;
  const again = await chrome.open(server.url('/saved.pdf'));
  await pause(400);
  assert.deepEqual(await drawn(again), { pics: 4, text: 'Hi | | | © ' }, 'the saved copy shows them again, editable');
  assert.deepEqual(again.errors, []);
});
