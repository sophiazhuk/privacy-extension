const domainText = document.getElementById("domainText");
const policyUrlAnchor = document.getElementById("policyUrl");

const statusText = document.getElementById("status");
const findPolicyBtn = document.getElementById("findPolicyBtn");
const settingsBtn = document.getElementById("settingsBtn");

let activeTab;

init().catch((err) => setStatus(err.message, true));

settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
// init popup with current tab info
  if (!tab?.id || !tab.url) {
    throw new Error("no active tab URL available.");
  }

  activeTab = tab;
  domainText.textContent = new URL(tab.url).hostname;
}

async function onFindPolicyClicked() {
  // implement button click logic

}

async function runtimeMessage(message) {
  const response = await chrome.runtime.sendMessage(message);
// send message to background and handle response
  if (!response?.ok) {
    throw new Error(response?.error ?? "runtime error.");
  }
  return response.data;
}

function setPolicyUrl(url) {
// update policy URL in popup
}

function setStatus(text, isError = false) {
  statusText.textContent = text;
// Update status message in popup UI
  statusText.style.color = isError ? "red" : "black";
}

function scanPolicyLinks() {
  // implement actual scanning logic
  // i have an idea -sophia
  const keywords = ["privacy", "privacy policy", "privacy notice", "data policy"];

}
