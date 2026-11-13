// Inkfold background service worker.
// PDFs, on the web or on your computer, are taken over in their own tab by content.js, so the tab keeps
// its https:// or file:// address and stays shareable with tools such as Gemini in Chrome.

const VIEWER = chrome.runtime.getURL('viewer.html');
const isAuto = async () => (await chrome.storage.local.get({ auto: true })).auto;

async function setAuto(on) {
  await chrome.storage.local.set({ auto: on });
  chrome.contextMenus.update('auto', { checked: on });
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') chrome.tabs.create({ url: VIEWER + '?welcome' });   // a short welcome, once
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: 'auto', title: 'Open every PDF with Inkfold', type: 'checkbox', contexts: ['action'] });
  chrome.contextMenus.update('auto', { checked: await isAuto() });
});

chrome.contextMenus.onClicked.addListener(info => {
  if (info.menuItemId === 'auto') setAuto(info.checked);
});

// Toolbar click: annotate the PDF in this tab, or open the viewer page next to it.
chrome.action.onClicked.addListener(async tab => {
  if (/^(https?|file):/.test(tab.url || '')) {
    const took = await chrome.tabs.sendMessage(tab.id, { type: 'inkfold:open' }).catch(() => false);
    if (took) return;
  }
  const src = /^(https?|file):/.test(tab.url || '') ? '?src=' + tab.url : '';
  chrome.tabs.create({ url: VIEWER + src, index: tab.index + 1 });
});

// Requests from the viewer when it runs inside a PDF tab, where these APIs aren't available directly.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'fileAccess') { chrome.extension.isAllowedFileSchemeAccess().then(reply); return true; }
  if (msg?.type === 'openSettings') { chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }); return false; }
  if (msg?.type === 'readClipboardImage') { offscreen({ type: 'offscreen:readClipboardImage' }).then(reply, () => reply(null)); return true; }
  if (msg?.type === 'clipboardStamp') { offscreen({ type: 'offscreen:clipboardStamp' }).then(reply, () => reply(null)); return true; }
  if (msg?.type === 'readClipboard') { offscreen({ type: 'offscreen:readClipboard' }).then(reply, () => reply(null)); return true; }
  if (msg?.type === 'ocr') { offscreen({ type: 'offscreen:ocr', image: msg.image }).then(reply, e => reply({ error: String(e) })); return true; }
  if (msg?.type === 'myTabFile') {   // reader.js asks for the local file open in its own tab, and gets only that
    const url = sender.tab?.url ?? '';
    reply(sender.frameId > 0 && sender.url === chrome.runtime.getURL('reader.html') && url.startsWith('file:') ? url : null);
    return false;
  }
  return false;
});

// Two things a PDF tab can't do itself, done in a hidden extension page:
// • read the clipboard (from a web page, Chrome would ask on behalf of that website), only when the user opens "Add a note";
// • recognise text (OCR) in pages that have none, with the bundled PaddleOCR models, in a worker of its own.
let creating = null;   // requests arriving together share one creation
async function offscreen(msg) {
  if (!(await chrome.offscreen.hasDocument?.())) {
    await (creating ??= chrome.offscreen.createDocument({
      url: 'offscreen.html', reasons: ['CLIPBOARD', 'WORKERS'],
      justification: 'Read what the user copied when they use Magic paste, and recognise text in scanned pages on the device',
    }).catch(() => {}).finally(() => { creating = null; }));
  }
  return chrome.runtime.sendMessage(msg);
}
