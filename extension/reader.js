// Runs in a hidden frame inside a local PDF's tab (see content.js). It reads that tab's own file, and only that
// file: the address comes from Chrome (the tab this frame is in), never from the page. The bytes go straight to
// the page that holds the frame, without copying.
(async () => {
  const url = await chrome.runtime.sendMessage({ type: 'myTabFile' }).catch(() => null);
  const send = bytes => parent.postMessage({ inkfold: 'file', bytes }, '*', bytes ? [bytes] : []);
  if (!url) return send(null);
  const x = new XMLHttpRequest();   // fetch() can't read file:// URLs
  x.open('GET', url);
  x.responseType = 'arraybuffer';
  x.onload = () => send(x.response?.byteLength ? x.response : null);
  x.onerror = () => send(null);
  x.send();
})();
