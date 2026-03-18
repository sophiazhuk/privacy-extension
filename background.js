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
    case "FETCH_POLICY_TEXT":
      return fetchPolicyText(message.payload?.policyUrl);
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

async function fetchPolicyText(policyUrl) {
  // fetch policy HTML and return both a readable text dump and smaller blocks for analysis
  if (!policyUrl || typeof policyUrl !== "string") {
    throw new Error("policy URL is required.");
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(policyUrl);
  } catch {
    throw new Error("invalid policy URL.");
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("policy URL must be http/https.");
  }

  // follow redirects
  const response = await fetch(parsedUrl.href, { method: "GET", redirect: "follow" });
  if (!response.ok) {
    throw new Error(`fetch failed: ${response.status}`);
  }

  const html = await response.text();
  const extracted = extractTextFromHtml(html);

  return {
    policyUrl: parsedUrl.href,
    fetchedAt: new Date().toISOString(),
    rawLength: html.length,
    cleanedLength: extracted.cleanedText.length,
    cleanedText: extracted.cleanedText,
    blocks: extracted.blocks
  };
}

function extractTextFromHtml(html) {
  if (!html) return { cleanedText: "", blocks: [] };

  // focus on where policy text usually is
  const likelyPolicyRegion = isolatePolicyRegion(html);

  const withoutNoiseBlocks = likelyPolicyRegion
    // remove non-content tags first
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(nav|footer|header|aside|form|button|dialog)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(div|section|aside)[^>]*(cookie|consent|gdpr|ccpa|onetrust|trustarc)[^>]*>[\s\S]*?<\/\1>/gi, " ");

  // keep structure markers so later chunking/summaries have better context
  const structured = withoutNoiseBlocks
    .replace(/<h1[^>]*>/gi, "\n\n# ")
    .replace(/<h2[^>]*>/gi, "\n\n## ")
    .replace(/<h3[^>]*>/gi, "\n\n### ")
    .replace(/<h4[^>]*>/gi, "\n\n#### ")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<(p|div|section|article|ul|ol|br)[^>]*>/gi, "\n")
    .replace(/<\/(p|div|section|article|ul|ol|br)>/gi, "\n");

  const noTags = structured.replace(/<[^>]+>/g, " ");
  const decoded = decodeHtmlEntities(noTags);
  const normalizedLines = decoded
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .filter((line) => !isLikelyBannerLine(line));

  // flat text version for debug output
  const cleanedText = normalizedLines.join("\n").replace(/\n{3,}/g, "\n\n").slice(0, 50000);
  const blocks = buildPolicyBlocks(normalizedLines);

  return {
    cleanedText,
    blocks
  };
}

function buildPolicyBlocks(lines) {
  const blocks = [];
  let currentSection = "General";
  let pendingLines = [];

  for (const line of lines) {
    if (/^#{1,4}\s+/.test(line)) {
      // headings reset the active section
      flushPending();
      currentSection = line.replace(/^#{1,4}\s+/, "").trim() || "General";
      continue;
    }

    if (line.startsWith("- ")) {
      // list items are usually meaningful
      pendingLines.push(line.replace(/^-\s+/, ""));
      flushPending();
      continue;
    }

    pendingLines.push(line);
    if (pendingLines.length >= 2 || line.length > 160) {
      flushPending();
    }
  }

  flushPending();

  return blocks.slice(0, 200);

  function flushPending() {
    if (pendingLines.length === 0) {
      return;
    }

    const text = pendingLines.join(" ").replace(/\s+/g, " ").trim();
    pendingLines = [];

    // skip tiny fragments so categories are based on actual policy statements
    if (!text || text.length < 20) {
      return;
    }

    blocks.push({
      sectionTitle: currentSection,
      text
    });
  }
}

function isolatePolicyRegion(html) {
  // cut a lot of nav/marketing noise
  const regionPatterns = [
    /<(main)[^>]*>[\s\S]*?<\/\1>/i,
    /<(article)[^>]*>[\s\S]*?<\/\1>/i,
    /<(section|div)[^>]*(privacy|policy|legal)[^>]*>[\s\S]*?<\/\1>/i
  ];

  for (const pattern of regionPatterns) {
    const match = html.match(pattern);
    if (match?.[0]) {
      return match[0];
    }
  }

  return html;
}

function isLikelyBannerLine(line) {
  // leftover cookie/consent strings
  return /(cookie settings|manage preferences|accept all|reject all|do not sell|do not share|skip to content)/i.test(
    line
  );
}

function decodeHtmlEntities(text) {
  // decode just enough entities to keep output readable
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, "\"")
    .replace(/&#(\d+);/g, (_m, num) => String.fromCharCode(Number(num)));
}
