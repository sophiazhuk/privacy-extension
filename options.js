// Options page script: handles settings UI and persistence
const apiKeyInput = document.getElementById("apiKey");
const saveBtn = document.getElementById("saveBtn");
const status = document.getElementById("status");

init().catch((err) => setStatus(err.message, true));
saveBtn.addEventListener("click", onSaveClicked);

// set settings with stored values
async function init() {
  const settings = await runtimeMessage({ type: "GET_SETTINGS" });
  if (!settings) {
    return;
  }
  apiKeyInput.value = settings.apiKey || "";
}

// save settings when user clicks save
async function onSaveClicked() {
  await runtimeMessage({
    type: "SAVE_SETTINGS",
    payload: {
      apiKey: apiKeyInput.value.trim()
    }
  });

  setStatus("settings saved");
}

// send runtime message to background
async function runtimeMessage(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    throw new Error(response?.error ?? "extension runtime error.");
  }
  return response.data;
}
