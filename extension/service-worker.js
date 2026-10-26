// AirDrop LAN Warp — MV3 background service worker.
// Opens the side panel when the toolbar action is clicked and keeps the panel
// enabled on every tab so the transfer engine stays reachable while browsing.

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error('[warp] setPanelBehavior failed', error));
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// The side panel cannot surface microphone permission prompts in Chromium.
// The panel asks us to open a full tab where the prompt can be shown once;
// the grant then applies to the whole extension origin (including the panel).
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === 'warp:open-permission-tab') {
    chrome.tabs
      .create({ url: chrome.runtime.getURL('index.html#grant=microphone') })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  return false;
});
