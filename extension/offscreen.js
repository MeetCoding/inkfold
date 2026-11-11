// Hidden helper page for the background script.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'offscreen:readFile') { readFile(msg.url).then(reply, () => reply(null)); return true; }
  if (msg?.type !== 'offscreen:readClipboard') return false;
  const box = document.getElementById('paste');
  box.value = '';
  box.focus();
  document.execCommand('paste');
  reply(box.value);
  return false;
});

// A local PDF's bytes, as base64 (messages carry text). Extension pages can read file:// URLs when the
// user has turned on "Allow access to file URLs".
function readFile(url) {
  return new Promise((ok, no) => {
    if (!/^file:/.test(url)) return no();
    const x = new XMLHttpRequest();
    x.open('GET', url);
    x.responseType = 'arraybuffer';
    x.onload = () => {
      const bytes = new Uint8Array(x.response || []);
      if (!bytes.length) return no();
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      ok(btoa(bin));
    };
    x.onerror = no;
    x.send();
  });
}
