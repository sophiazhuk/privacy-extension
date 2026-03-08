const domainText = document.getElementById("domainText");
const policyUrlAnchor = document.getElementById("policyUrl");

const statusText = document.getElementById("status");
const findPolicyBtn = document.getElementById("findPolicyBtn");
const settingsBtn = document.getElementById("settingsBtn");

let activeTab;

init().catch((err) => setStatus(err.message, true));

findPolicyBtn.addEventListener("click", onFindPolicyClicked);
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
  setStatus("scanning links for a privacy policy...");

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: activeTab.id },
    func: scanPolicyLinks
  });

  if (!result?.bestUrl) {
    setStatus("no policy link detected. Try navigating to the site footer.", true);
    return;
  }

  setPolicyUrl(result.bestUrl);
  setStatus("policy URL detected.");
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
  policyUrlAnchor.textContent = url;
// update policy URL in popup
  policyUrlAnchor.href = url;
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
  const anchors = Array.from(document.querySelectorAll("a[href]"));
  const candidates = anchors
    .map((anchor) => {
      const text = (anchor.textContent || "").trim().toLowerCase();
      const href = anchor.getAttribute("href") || "";
      const absoluteUrl = new URL(href, window.location.href).href;
      const score = scoreAnchor(text, absoluteUrl, anchor);
      return { href: absoluteUrl, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  return { bestUrl: candidates[0]?.href || "" };

  function scoreAnchor(text, href, element) {
    let score = 0;
    const loweredHref = href.toLowerCase();

    if (keywords.some((keyword) => text.includes(keyword))) score += 3;
    if (keywords.some((keyword) => loweredHref.includes(keyword.replace(" ", "")))) score += 2;
    if (loweredHref.includes("/privacy")) score += 2;
    if (loweredHref.includes("policy")) score += 1;
    if (element.closest("footer")) score += 2;
    if (!href.startsWith("http")) score = 0;

    return score;
  }
}
