const VIEWER = chrome.runtime.getURL('viewer.html');
const RULE = 1;

const isAuto = async () => (await chrome.storage.local.get({ auto: true })).auto;

// Web PDFs: any top-level page served as application/pdf (and not as a forced download)
// is redirected to the viewer, with the original address after "?src=".
async function setAuto(on) {
  await chrome.storage.local.set({ auto: on });
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE],
    addRules: on ? [{
      id: RULE, priority: 1,
      action: { type: 'redirect', redirect: { regexSubstitution: VIEWER + '?src=\\0' } },
      condition: {
        regexFilter: '^https?://.*', resourceTypes: ['main_frame'],
        responseHeaders: [{ header: 'content-type', values: ['application/pdf*'] }],
        excludedResponseHeaders: [{ header: 'content-disposition', values: ['attachment*'] }],
      },
    }] : [],
  });
  chrome.contextMenus.update('auto', { checked: on });
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') chrome.tabs.create({ url: VIEWER + '?welcome' });   // a short welcome, once
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: 'auto', title: 'Open every PDF with Inkfold', type: 'checkbox', contexts: ['action'] });
  setAuto(await isAuto());
});

chrome.contextMenus.onClicked.addListener(info => {
  if (info.menuItemId === 'auto') setAuto(info.checked);
});

// PDFs on your computer (file:// links) aren't covered by the rule above, so catch them here.
chrome.webNavigation.onBeforeNavigate.addListener(async d => {
  if (d.frameId === 0 && await isAuto()) chrome.tabs.update(d.tabId, { url: VIEWER + '?src=' + d.url });
}, { url: [{ schemes: ['file'], pathSuffix: '.pdf' }, { schemes: ['file'], pathSuffix: '.PDF' }] });

// Toolbar click: open the editor next to the current tab, pointed at that tab's address.
chrome.action.onClicked.addListener(tab => {
  const src = /^(https?|file):/.test(tab.url || '') ? '?src=' + tab.url : '';
  chrome.tabs.create({ url: VIEWER + src, index: tab.index + 1 });
});
