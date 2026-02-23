chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  try {
    if (msg && msg.type === 'OPEN_OPTIONS') {
      chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
      return true;
    }
  } catch (e) {
    // ignore
  }
  sendResponse({ ok: false });
  return false;
});
