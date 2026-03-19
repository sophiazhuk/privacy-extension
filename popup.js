import { sendPrompt } from "./ai.js";
import { buildPrivacyReport, renderPrivacyReport } from "./output-structure.js";

const domainText = document.getElementById("domainText");
const policyUrlAnchor = document.getElementById("policyUrl");
const statusText = document.getElementById("status");
const fetchedText = document.getElementById("fetchedText");
const aiOutput = document.getElementById("aiOutput");
const debugDump = document.getElementById("debugDump");
const copyDebugBtn = document.getElementById("copyDebugBtn");
const reportPanel = document.getElementById("reportPanel");
const reportSummary = document.getElementById("reportSummary");
const reportCategories = document.getElementById("reportCategories");
const reportUnknowns = document.getElementById("reportUnknowns");
const findPolicyBtn = document.getElementById("findPolicyBtn");
const settingsBtn = document.getElementById("settingsBtn");
const manualUrlSection = document.getElementById("manualUrlSection");
const manualPolicyUrlInput = document.getElementById("manualPolicyUrl");
const manualUrlBtn = document.getElementById("manualUrlBtn");

let activeTab;
let lastDebugState = createDebugState();

init().catch((err) => setStatus(err.message, true));

// find policy, fetch text preview, open extension settings
findPolicyBtn.addEventListener("click", onFindPolicyClicked);
settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
copyDebugBtn.addEventListener("click", onCopyDebugClicked);
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

  const supportedUrl = /^https?:/i.test(tab.url);
  if (!supportedUrl) {
    activeTab = null;
    domainText.textContent = "unsupported page";
    findPolicyBtn.disabled = true;
    setStatus("Open the extension on a normal http/https page.", true);
    return;
  }

  // store tab for later
  activeTab = tab;
  const hostname = new URL(tab.url).hostname;
  domainText.textContent = hostname;
  setDebugState({
    activeTabUrl: tab.url,
    activeTabId: tab.id,
    hostname,
    status: "ready"
  });
}

async function onFindPolicyClicked() {
  // policy URL discovery entry point
  setStatus("scanning links for a privacy policy...");
  setDebugState({
    runStartedAt: new Date().toISOString(),
    scan: { status: "started" },
    error: ""
  });

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: activeTab.id },
    func: findPolicyUrlWithFallback
  });

  // if all fallback stages fail, error
  if (!result?.bestUrl) {
    setStatus("no policy link detected on-page, homepage, or common paths.", true);
    setDebugState({
      scan: { status: "not_found", stage: result?.stage || "none", bestUrl: "" }
    });
    hideReportPanel();
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
  setDebugState({
    scan: {
      status: "found",
      stage: result.stage,
      stageLabel,
      bestUrl: result.bestUrl
    }
  });

  setStatus(`policy URL detected (${stageLabel}). fetching policy text...`);
  await summarizeCurrentPolicy();
}

async function summarizeCurrentPolicy() {
  // once a policy URL is found, go straight into the llm-backed summarize flow
  const policyUrl = policyUrlAnchor.href;
  if (!policyUrl || !policyUrl.startsWith("http")) {
    setStatus("find and detect a policy URL first.", true);
    showManualUrlInput();
    return;
  }

  hideReportPanel();
  setStatus("fetching policy text...");
  setDebugState({
    policyUrl,
    fetch: { status: "started" },
    gemini: { status: "idle" },
    error: ""
  });

  try {
    const data = await runtimeMessage({
      type: "FETCH_POLICY_TEXT",
      payload: { policyUrl }
    });

    const cleanedText = data.cleanedText || "";
    fetchedText.textContent = cleanedText;
    aiOutput.textContent = "";
    setDebugState({
      policyUrl: data.policyUrl || policyUrl,
      fetch: {
        status: "ok",
        contentType: data.contentType || "",
        rawLength: data.rawLength || 0,
        cleanedLength: data.cleanedLength || cleanedText.length,
        blockCount: Array.isArray(data.blocks) ? data.blocks.length : 0,
        title: data.title || "",
        extraction: data.extraction || {}
      }
    });

    if (!cleanedText.trim()) {
      hideReportPanel();
      aiOutput.textContent =
        "We fetched the page, but could not extract readable policy text. Check the debug dump for extraction details.";
      setStatus("Could not extract readable policy text from this page.", true);
      setDebugState({
        error: "empty extracted policy text"
      });
      return;
    }

    // build the internal report first, then let Gemini rewrite it into the final user-facing version
    const fallbackReport = buildPrivacyReport({ policyText: cleanedText, blocks: data.blocks || [] });
    setDebugState({
      heuristic: {
        categoryCount: Array.isArray(fallbackReport.categories) ? fallbackReport.categories.length : 0,
        unknownCount: Array.isArray(fallbackReport.unknowns) ? fallbackReport.unknowns.length : 0,
        topSummary: fallbackReport.top_summary || "",
        categories: summarizeDebugCategories(fallbackReport.categories)
      }
    });

    const settings = await runtimeMessage({ type: "GET_SETTINGS" });
    const apiKey = (settings?.apiKey || "").trim();
    setDebugState({
      gemini: {
        status: "ready",
        apiKeyPresent: Boolean(apiKey),
        apiKeyLength: apiKey.length
      }
    });

    if (!apiKey) {
      aiOutput.textContent = "There is something wrong with the API key. Add a valid Gemini API key in settings to generate the privacy report.";
      setStatus("There is something wrong with the API key. Add a valid Gemini API key in settings.", true);
      setDebugState({
        gemini: {
          status: "missing_key",
          apiKeyPresent: false,
          apiKeyLength: 0
        },
        error: "missing API key"
      });
      hideManualUrlInput();
      return;
    }

    setStatus("sending policy text to Gemini...");
    setDebugState({
      gemini: {
        status: "started",
        apiKeyPresent: true,
        apiKeyLength: apiKey.length,
        sourceBlockCount: Array.isArray(data.blocks) ? data.blocks.length : 0
      }
    });

    try {
      const result = await sendPrompt({
        apiKey,
        baseReport: fallbackReport,
        blocks: data.blocks || []
      });
      renderPrivacyReport(result.report, {
        reportPanel,
        reportSummary,
        reportCategories,
        reportUnknowns
      });
      aiOutput.textContent = result.rawText || "Gemini returned an empty response.";
      setStatus("Gemini report loaded.");
      setDebugState({
        gemini: {
          status: "ok",
          apiKeyPresent: true,
          apiKeyLength: apiKey.length,
          model: result.model || "",
          promptBlockCount: result.promptBlockCount || 0,
          rawTextLength: (result.rawText || "").length,
          proposedCategories: summarizeDebugCategories(result.proposedCategories)
        },
        renderedReport: {
          categoryCount: Array.isArray(result.report?.categories) ? result.report.categories.length : 0,
          unknownCount: Array.isArray(result.report?.unknowns) ? result.report.unknowns.length : 0,
          topSummary: result.report?.top_summary || "",
          categories: summarizeDebugCategories(result.report?.categories)
        }
      });
    } catch (error) {
      hideReportPanel();
      aiOutput.textContent = `There is something wrong with the API key. Check your API key in settings.\n\n${error.message}`;
      setStatus("There is something wrong with the API key. Check your API key in settings.", true);
      setDebugState({
        gemini: {
          status: "error",
          apiKeyPresent: true,
          apiKeyLength: apiKey.length
        },
        error: String(error.message || error)
      });
    }

    hideManualUrlInput();
  } catch (error) {
    hideReportPanel();
    setStatus(error.message, true);
    setDebugState({
      fetch: { status: "error" },
      error: String(error.message || error)
    });
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
  setDebugState({ policyUrl: url });
}

function setStatus(text, isError = false) {
  statusText.textContent = text;
// Update status message in popup UI
  statusText.style.color = isError ? "red" : "black";
  setDebugState({ status: text, statusIsError: isError });
}

function showManualUrlInput() {
  manualUrlSection.classList.remove("hidden");
}

function hideManualUrlInput() {
  manualUrlSection.classList.add("hidden");
}

function hideReportPanel() {
  // clear the previous report whenever summarize cannot complete the llm step
  reportPanel.classList.add("hidden");
  reportSummary.innerHTML = "";
  reportCategories.innerHTML = "";
  reportUnknowns.innerHTML = "";
  setDebugState({ reportVisible: false });
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

async function onCopyDebugClicked() {
  try {
    await navigator.clipboard.writeText(debugDump.value);
    setStatus("debug dump copied.");
  } catch {
    setStatus("could not copy debug dump.", true);
  }
}

function createDebugState() {
  return {
    timestamp: new Date().toISOString(),
    status: "",
    statusIsError: false,
    activeTabId: null,
    activeTabUrl: "",
    hostname: "",
    policyUrl: "",
    reportVisible: false,
    scan: {},
    fetch: {},
    heuristic: {},
    gemini: {},
    renderedReport: {},
    error: ""
  };
}

function setDebugState(partialState) {
  // keep a single copy-pasteable object so bug reports include the whole run in one place
  lastDebugState = {
    ...lastDebugState,
    ...partialState,
    timestamp: new Date().toISOString(),
    reportVisible: !reportPanel.classList.contains("hidden")
  };
  debugDump.value = JSON.stringify(lastDebugState, null, 2);
}

function summarizeDebugCategories(categories) {
  if (!Array.isArray(categories)) {
    return [];
  }

  return categories.map((category) => ({
    name: String(category?.name || ""),
    grade: String(category?.grade || ""),
    confidence: String(category?.confidence || ""),
    gradeModifier: String(category?.grade_modifier || ""),
    summaryLine: String(category?.summary_line || ""),
    exampleCount: Array.isArray(category?.examples) ? category.examples.length : 0,
    evidenceCount: Array.isArray(category?.evidence) ? category.evidence.length : 0
  }));
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
