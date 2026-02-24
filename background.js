// manages extension settings
const SETTINGS_KEY = "settings";

// default settings
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get([SETTINGS_KEY]);

  if (!existing[SETTINGS_KEY]) {
    //empty api key
    await chrome.storage.local.set({
      [SETTINGS_KEY]: {
        apiKey: ""
      }
    });
  }
});

// listen to popup and options scripts
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});

// message handler for extension actions
async function handleMessage(message) {
  switch (message?.type) {
    case "GET_SETTINGS":
      return getSettings();
    case "SAVE_SETTINGS":
      return saveSettings(message.payload ?? {});
    default:
      throw new Error("bad message type");
  }
}

// get extension settings from chrome storage
async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return stored[SETTINGS_KEY] ?? null;
}

// save extension settings
async function saveSettings(patch) {
  const current = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] ?? {};
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}
