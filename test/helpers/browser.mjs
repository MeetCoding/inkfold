// Runs the unpacked extension in Chrome for Testing (branded Chrome no longer loads unpacked extensions from the
// command line). Set CHROME_PATH to its binary; `npx @puppeteer/browsers install chrome@stable` downloads one.
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

// INKFOLD_EXTENSION: test another copy, such as an unzipped release, instead of extension/.
export const EXTENSION = resolve(process.env.INKFOLD_EXTENSION || resolve(import.meta.dirname, '../../extension'));

// Serves PDFs from memory: files['/a.pdf'] = bytes.
export async function serve(files = {}) {
  const server = createServer((req, res) => {
    const body = files[new URL(req.url, 'http://x').pathname];
    if (!body) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': body.length, 'Access-Control-Allow-Origin': '*' });
    res.end(body);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { files, url: p => `http://127.0.0.1:${server.address().port}${p}`, close: () => new Promise(r => server.close(r)) };
}

export async function launch() {
  const downloads = await mkdtemp(join(tmpdir(), 'inkfold-dl-'));
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || 'google-chrome',
    headless: true,
    pipe: true,
    enableExtensions: [EXTENSION],
    args: ['--no-sandbox', '--no-first-run', '--no-default-browser-check'],
  });
  const sw = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().endsWith('/background.js'));
  const id = new URL(sw.url()).host;
  const worker = await sw.worker();
  await worker.evaluate(() => chrome.storage.local.set({ welcomed: true }));   // no first-run dialog
  // (Saves are downloads here, see open(). Chrome lets a site make one download without asking, then asks: so a
  // test file saves from one tab only, or launches a browser per test.)
  // The welcome tab opened on install isn't needed.
  for (const p of await browser.pages()) if (p.url().includes('?welcome')) await p.close();

  async function open(src) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 1400 });   // a whole Letter page fits, at fit width
    const cdp = await page.createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
    // No save dialog in a headless browser: without the File System Access picker, Save falls back to a download.
    await page.evaluateOnNewDocument(() => { delete window.showSaveFilePicker; delete window.showOpenFilePicker; });
    page.on('pageerror', e => { page.errors.push(e); });
    page.errors = [];
    await page.goto(`chrome-extension://${id}/viewer.html?src=${src}`);
    await page.waitForSelector('body.loaded .page canvas', { timeout: 20000 });
    return page;
  }

  // The next file to land in the downloads folder (Save without a picker downloads).
  async function nextDownload(after = new Set(), timeout = 20000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const done = (await readdir(downloads)).filter(f => !f.endsWith('.crdownload') && !after.has(f));
      if (done.length) return { name: done[0], bytes: new Uint8Array(await readFile(join(downloads, done[0]))) };
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('No download arrived');
  }
  const downloaded = async () => new Set(await readdir(downloads));

  return {
    browser, id, worker, open, nextDownload, downloaded,
    close: async () => { await browser.close(); await rm(downloads, { recursive: true, force: true }); },
  };
}

// The point at fraction (fx, fy) of a page on screen (fx, fy in 0…1 from its top-left).
export async function pagePoint(page, index, fx, fy) {
  return page.evaluate((index, fx, fy) => {
    const r = document.querySelectorAll('.page')[index].getBoundingClientRect();
    return { x: r.left + r.width * fx, y: r.top + r.height * fy };
  }, index, fx, fy);
}

export async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let k = 1; k <= 8; k++) await page.mouse.move(from.x + (to.x - from.x) * k / 8, from.y + (to.y - from.y) * k / 8);
  await page.mouse.up();
}

export const pause = ms => new Promise(r => setTimeout(r, ms));
