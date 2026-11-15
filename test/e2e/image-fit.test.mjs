// A picture added to a page fits in the window: all four of its corners are in view, without scrolling or zooming.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, serve, pause } from '../helpers/browser.mjs';
import { textPdf } from '../helpers/fixtures.mjs';
import { png } from '../helpers/images.mjs';

let chrome, server, tall;
before(async () => {
  server = await serve({ '/doc.pdf': await textPdf(2) });
  chrome = await launch();
  tall = join(await mkdtemp(join(tmpdir(), 'inkfold-img-')), 'tall.png');
  await writeFile(tall, png(1200, 2400, [40, 120, 220, 255]));   // a tall picture, bigger than the window
});
after(async () => { await chrome?.close(); await server?.close(); });

async function addPicture(page) {
  await pause(300);   // (settled after the resize)
  const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 10000 }), page.click('#addImage')]);
  await chooser.accept([tall]);
  await page.waitForSelector('#magic:popover-open .acts button');
  await page.click('#magic .acts button.primary');   // "Add to page …"
  await page.waitForSelector('.page svg.shapes g.image');
  await pause(200);
}

for (const [label, scrollTo] of [['top of the page', 0], ['partway down', 500]]) {
  test(`fits the window (${label})`, async () => {
    const page = await chrome.open(server.url('/doc.pdf'));
    await page.setViewport({ width: 1000, height: 700 });   // fit width: a page is much taller than the window
    await pause(300);
    await page.evaluate(y => scrollTo(0, y), scrollTo);
    await pause(200);
    await addPicture(page);
    const r = await page.$eval('.page svg.shapes g.image image', n => { const b = n.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right }; });
    const bar = await page.$eval('header', n => n.getBoundingClientRect().top);
    assert.ok(r.top >= 0 && r.left >= 0 && r.right <= 1000 && r.bottom <= bar, `all four corners in view: ${JSON.stringify(r)}`);
    assert.ok(r.bottom - r.top > 300, 'and not needlessly small');
    const ratio = (r.bottom - r.top) / (r.right - r.left);
    assert.ok(Math.abs(ratio - 2) < 0.02, `keeps its proportions (${ratio})`);
  });
}
