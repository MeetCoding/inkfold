// Inkfold background service worker.
// Web PDFs are taken over in their own tab by content.js (so the tab keeps its https:// address and
// stays shareable with tools such as Gemini in Chrome). Local file:// PDFs open on the viewer page.

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

// PDFs on your computer (file:// links): a page can't re-read its own file, so these open on the viewer page.
chrome.webNavigation.onBeforeNavigate.addListener(async d => {
  if (d.frameId === 0 && await isAuto()) chrome.tabs.update(d.tabId, { url: VIEWER + '?src=' + d.url });
}, { url: [{ schemes: ['file'], pathSuffix: '.pdf' }, { schemes: ['file'], pathSuffix: '.PDF' }] });

// Toolbar click: annotate the PDF in this tab, or open the viewer page next to it.
chrome.action.onClicked.addListener(async tab => {
  if (/^https?:/.test(tab.url || '')) {
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
  if (msg?.type === 'readClipboard') { readClipboard().then(reply, () => reply(null)); return true; }
  return false;
});

// Reading the clipboard from a PDF tab would make Chrome ask on behalf of that website, so the
// extension reads it itself, in an offscreen document, only when the user adds a note.
async function readClipboard() {
  if (!(await chrome.offscreen.hasDocument?.())) {
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['CLIPBOARD'], justification: 'Read Markdown the user copied, when they add a note' });
  }
  return chrome.runtime.sendMessage({ type: 'offscreen:readClipboard' });
}
