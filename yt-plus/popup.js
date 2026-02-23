(() => {
  'use strict';
  const open = (url) => chrome.tabs.create({ url });
  document.getElementById('openManager').addEventListener('click', () => open('https://www.youtube.com/feed/channels'));
  document.getElementById('openFeed').addEventListener('click', () => open('https://www.youtube.com/feed/subscriptions'));
  document.getElementById('openOptions').addEventListener('click', () => chrome.runtime?.openOptionsPage?.());
})();
