import { sendPrompt } from "./ai.js";

const domainText = document.getElementById("domainText");
const policyUrlAnchor = document.getElementById("policyUrl");
const statusText = document.getElementById("status");
const fetchedText = document.getElementById("fetchedText");
const aiOutput = document.getElementById("aiOutput");
const findPolicyBtn = document.getElementById("findPolicyBtn");
const summarizeBtn = document.getElementById("summarizeBtn");
const settingsBtn = document.getElementById("settingsBtn");
const manualUrlSection = document.getElementById("manualUrlSection");
const manualPolicyUrlInput = document.getElementById("manualPolicyUrl");
const manualUrlBtn = document.getElementById("manualUrlBtn");

let activeTab;

init().catch((err) => setStatus(err.message, true));

// find policy, fetch text preview, open extension settings
findPolicyBtn.addEventListener("click", onFindPolicyClicked);
summarizeBtn.addEventListener("click", onSummarizeClicked);
settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
manualUrlBtn.addEventListener("click", onManualUrlSubmit);
manualPolicyUrlInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    onManualUrlSubmit();
  }
});

async function init() {
  // grab active tab when popup opens
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) {
    throw new Error("no active tab URL available.");
  }

  // store tab for later
  activeTab = tab;
  const hostname = new URL(tab.url).hostname;
  domainText.textContent = hostname;
}

async function onFindPolicyClicked() {
  // policy URL discovery entry point
  setStatus("scanning links for a privacy policy...");

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: activeTab.id },
    func: findPolicyUrlWithFallback
  });

  // if all fallback stages fail, error
  if (!result?.bestUrl) {
    setStatus("no policy link detected on-page, homepage, or common paths.", true);
    showManualUrlInput();
    return;
  }

  setPolicyUrl(result.bestUrl);
  hideManualUrlInput();

  const stageLabel = {
    page_scan: "current page",
    homepage_scan: "homepage",
    common_path_probe: "common path probe"
  }[result.stage] || "fallback";

  setStatus(`policy URL detected (${stageLabel}).`);
}

async function onSummarizeClicked() {
  // placeholder
  const policyUrl = policyUrlAnchor.href;
  if (!policyUrl || !policyUrl.startsWith("http")) {
    setStatus("find a policy URL first.", true);
    showManualUrlInput();
    return;
  }

  setStatus("fetching policy text...");

  try {
    const data = await runtimeMessage({
      type: "FETCH_POLICY_TEXT",
      payload: { policyUrl }
    });

    fetchedText.textContent = data.cleanedText || "";
    aiOutput.textContent = "";

    const settings = await runtimeMessage({ type: "GET_SETTINGS" });
    const apiKey = (settings?.apiKey || "").trim();

    if (!apiKey) {
      setStatus(`fetched ${data.cleanedLength} chars of cleaned text. add API key for Gemini.`);
      hideManualUrlInput();
      return;
    }

    setStatus("sending prompt to Gemini...");
    const responseText = await sendPrompt({ apiKey });

    // keep AI response
    aiOutput.textContent = responseText || "empty response.";
    setStatus("placeholder summary generated");

    hideManualUrlInput();
  } catch (error) {
    setStatus(error.message, true);
    showManualUrlInput();
  }
}

function onManualUrlSubmit() {
  const typedValue = manualPolicyUrlInput.value.trim();
  if (!typedValue) {
    setStatus("enter a policy URL to continue.", true);
    return;
  }

  try {
    const normalizedUrl = normalizeManualUrl(typedValue);
    setPolicyUrl(normalizedUrl);
    setStatus("manual policy URL saved. you can now summarize.", false);
    hideManualUrlInput();
  } catch {
    setStatus("invalid URL. enter a full http/https link.", true);
    showManualUrlInput();
  }
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

function showManualUrlInput() {
  manualUrlSection.classList.remove("hidden");
}

function hideManualUrlInput() {
  manualUrlSection.classList.add("hidden");
}

function normalizeManualUrl(value) {
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  const parsed = new URL(withProtocol);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("bad protocol");
  }
  return parsed.href;
}

async function runtimeMessage(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    throw new Error(response?.error ?? "runtime error.");
  }
  return response.data;
}

async function findPolicyUrlWithFallback() {
  // fallback strategy
  // 1. scan current page links
  // 2. if no hit, scan homepage links
  // 3. if still no hit, try common privacy paths
  const keywords = ["privacy", "privacy policy", "privacy notice", "data policy"];
  // used for fallback search for policy URL
  const commonPaths = [
    "/privacy",
    "/privacy-policy",
    "/privacy-notice",
    "/privacy.html",
    "/legal/privacy"
  ];

  const pageBest = pickBestFromAnchors(Array.from(document.querySelectorAll("a[href]")));
  if (pageBest) {
    return { bestUrl: pageBest, stage: "page_scan" };
  }

  // homepage scan catches sites where privacy link appears only in root nav/footer
  const homepageAnchors = await loadHomepageAnchors();
  const homepageBest = pickBestFromAnchors(homepageAnchors);
  if (homepageBest) {
    return { bestUrl: homepageBest, stage: "homepage_scan" };
  }

  const origin = window.location.origin;
  for (const path of commonPaths) {
    // common URLs used by many sites
    const url = new URL(path, origin).href;
    if (await looksLikePolicyUrl(url)) {
      return { bestUrl: url, stage: "common_path_probe" };
    }
  }

  return { bestUrl: "", stage: "none" };

  // some scoring script to choose most likely privacy policy
  function pickBestFromAnchors(anchors) {
    // score links in the scan step so detection stays deterministic
    const candidates = anchors
      .map((anchor) => {
        const text = (anchor.textContent || "").trim().toLowerCase();
        const href = anchor.getAttribute("href") || "";
        let absoluteUrl = "";

        try {
          absoluteUrl = new URL(href, window.location.href).href;
        } catch {
          return null;
        }

        const score = scoreAnchor(text, absoluteUrl, anchor.closest("footer") !== null);
        return { href: absoluteUrl, score };
      })
      .filter((item) => item && item.score > 0)
      .sort((a, b) => b.score - a.score);

    return candidates[0]?.href || "";
  }

  function scoreAnchor(text, href, inFooter) {
    // choose explicit privacy words and footer/legal locations
    let score = 0;
    const loweredHref = href.toLowerCase();

    if (keywords.some((keyword) => text.includes(keyword))) score += 3;
    if (keywords.some((keyword) => loweredHref.includes(keyword.replace(" ", "")))) score += 2;
    if (loweredHref.includes("/privacy")) score += 2;
    if (loweredHref.includes("policy")) score += 1;
    if (inFooter) score += 2;
    // exclude non-http links
    if (!href.startsWith("http")) score = 0;

    return score;
  }

  async function loadHomepageAnchors() {
    // retry from homepage since policies are sometimes linked there
    // fetches homepage HTML and extracts all anchor links as fallback
    try {
      const homepageUrl = `${window.location.origin}/`;
      // get homepage URL from current origin
      const response = await fetch(homepageUrl, { credentials: "same-origin" });
      if (!response.ok) {
        return [];
      }

      const html = await response.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");
      return Array.from(doc.querySelectorAll("a[href]"));
    } catch {
      // return empty array if homepage fetch fails
      return [];
    }
  }

  async function looksLikePolicyUrl(url) {
    // basic validation so we dont get random legal or help pages
    // checks content type and page keywords to confirm it's a privacy policy
    try {
      const response = await fetch(url, { method: "GET", credentials: "same-origin" });
      if (!response.ok) {
        return false;
      }

      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      // reject non text content
      if (!(contentType.includes("text/html") || contentType.includes("text/plain") || contentType.includes("pdf"))) {
        return false;
      }

      // sample first 3000 chars and check for privacy related words
      const text = (await response.text()).slice(0, 3000).toLowerCase();
      return keywords.some((keyword) => text.includes(keyword));
    } catch {
      return false;
    }
  }
}
