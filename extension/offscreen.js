// Reads the clipboard for the background script, only when the user adds a note.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type !== 'offscreen:readClipboard') return false;
  const box = document.getElementById('paste');
  box.value = '';
  box.focus();
  document.execCommand('paste');
  reply(box.value);
  return false;
});
