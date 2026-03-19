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
  const contentType = (response.headers.get("content-type") || "").toLowerCase();

  return {
    policyUrl: response.url || parsedUrl.href,
    fetchedAt: new Date().toISOString(),
    contentType,
    rawLength: html.length,
    cleanedLength: extracted.cleanedText.length,
    title: extracted.title,
    cleanedText: extracted.cleanedText,
    blocks: extracted.blocks,
    extraction: extracted.extraction
  };
}

function extractTextFromHtml(html) {
  if (!html) {
    return {
      title: "",
      cleanedText: "",
      blocks: [],
      extraction: {
        strategy: "none",
        title: "",
        htmlLength: 0,
        candidateCount: 0,
        candidates: []
      }
    };
  }

  const title = extractTitle(html);
  const candidates = [
    // try the focused legal/article region first
    runExtractionCandidate(html, {
      strategy: "isolated-clean",
      isolateRegion: true,
      stripStructuralNoise: true
    }),
    // if that is too aggressive, retry against the full body
    runExtractionCandidate(html, {
      strategy: "body-clean",
      isolateRegion: false,
      stripStructuralNoise: true
    }),
    // last resort: preserve nearly all body text instead of returning nothing
    runExtractionCandidate(html, {
      strategy: "body-fallback",
      isolateRegion: false,
      stripStructuralNoise: false
    })
  ];

  const best = chooseBestExtraction(candidates);

  return {
    title,
    cleanedText: best.cleanedText,
    blocks: best.blocks,
    extraction: {
      strategy: best.meta.strategy,
      title,
      htmlLength: html.length,
      candidateCount: candidates.length,
      candidates: candidates.map((candidate) => candidate.meta)
    }
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
      return {
        html: match[0],
        source: pattern.source
      };
    }
  }

  return {
    html,
    source: "full-html"
  };
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

function runExtractionCandidate(html, options) {
  const region = options.isolateRegion ? isolatePolicyRegion(html) : getBodyRegion(html);
  const baseRegion = stripAlwaysNoise(region.html);
  const withoutNoiseBlocks = options.stripStructuralNoise ? stripStructuralNoise(baseRegion) : baseRegion;

  // keep structure markers so later chunking and summaries have better context
  const structured = withoutNoiseBlocks
    .replace(/<h1[^>]*>/gi, "\n\n# ")
    .replace(/<h2[^>]*>/gi, "\n\n## ")
    .replace(/<h3[^>]*>/gi, "\n\n### ")
    .replace(/<h4[^>]*>/gi, "\n\n#### ")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<(p|div|section|article|ul|ol|br|tr|td|th)[^>]*>/gi, "\n")
    .replace(/<\/(p|div|section|article|ul|ol|br|tr|td|th)>/gi, "\n");

  const noTags = structured.replace(/<[^>]+>/g, " ");
  const decoded = decodeHtmlEntities(noTags);
  const normalizedLines = decoded
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .filter((line) => !isLikelyBannerLine(line));

  const cleanedText = normalizedLines.join("\n").replace(/\n{3,}/g, "\n\n").slice(0, 50000);
  const blocks = buildPolicyBlocks(normalizedLines);
  const topLines = normalizedLines.slice(0, 20);

  return {
    cleanedText,
    blocks,
    meta: {
      strategy: options.strategy,
      regionSource: region.source,
      regionLength: region.html.length,
      afterNoiseLength: withoutNoiseBlocks.length,
      structuredLength: structured.length,
      noTagsLength: noTags.length,
      decodedLength: decoded.length,
      lineCount: normalizedLines.length,
      cleanedLength: cleanedText.length,
      blockCount: blocks.length,
      navTermHits: countPatternHits(topLines.join("\n"), NAV_NOISE_PATTERNS),
      policyKeywordHits: countPatternHits(cleanedText.slice(0, 4000), POLICY_SIGNAL_PATTERNS),
      repeatedTopLineCount: countRepeatedLines(topLines),
      shortTopLineCount: topLines.filter((line) => line.length < 30).length,
      snippet: cleanedText.slice(0, 200)
    }
  };
}

function chooseBestExtraction(candidates) {
  // prefer the richest non-empty extraction instead of trusting the first strategy blindly
  return [...candidates].sort((a, b) => scoreExtractionCandidate(b) - scoreExtractionCandidate(a))[0];
}

function scoreExtractionCandidate(candidate) {
  const textScore = Math.min(candidate.cleanedText.length, 25000);
  const blockScore = candidate.meta.blockCount * 120;
  const lineScore = Math.min(candidate.meta.lineCount, 160) * 6;
  const policyScore = candidate.meta.policyKeywordHits * 350;
  const cleanStrategyBonus = candidate.meta.strategy === "isolated-clean"
    ? 600
    : candidate.meta.strategy === "body-clean"
      ? 300
      : 0;
  const navPenalty = candidate.meta.navTermHits * 450;
  const repetitionPenalty = candidate.meta.repeatedTopLineCount * 180;
  const shortLinePenalty = candidate.meta.shortTopLineCount * 20;

  return textScore + blockScore + lineScore + policyScore + cleanStrategyBonus - navPenalty - repetitionPenalty - shortLinePenalty;
}

function getBodyRegion(html) {
  const match = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (match?.[1]) {
    return {
      html: match[1],
      source: "body"
    };
  }

  return {
    html,
    source: "full-html"
  };
}

function stripAlwaysNoise(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ");
}

function stripStructuralNoise(html) {
  return html
    .replace(/<(nav|footer|header|aside|form|button|dialog)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(div|section|aside)[^>]*(cookie|consent|gdpr|ccpa|onetrust|trustarc)[^>]*>[\s\S]*?<\/\1>/gi, " ");
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1] ? decodeHtmlEntities(match[1].replace(/\s+/g, " ").trim()) : "";
}

const NAV_NOISE_PATTERNS = [
  /view your profile/i,
  /wallet/i,
  /wishlist/i,
  /points shop/i,
  /discovery queue/i,
  /broadcasts/i,
  /community/i,
  /try chatgpt/i,
  /\blog in\b/i,
  /\bsign in\b/i,
  /overview/i,
  /faq/i
];

const POLICY_SIGNAL_PATTERNS = [
  /privacy policy/i,
  /we collect/i,
  /personal data/i,
  /personal information/i,
  /payment/i,
  /transaction/i,
  /cookies/i,
  /who has access/i,
  /how long we store/i,
  /retain/i,
  /share/i,
  /delete/i,
  /your rights/i
];

function countPatternHits(text, patterns) {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

function countRepeatedLines(lines) {
  const seen = new Set();
  let repeats = 0;

  for (const line of lines.map((line) => line.toLowerCase())) {
    if (seen.has(line)) {
      repeats += 1;
      continue;
    }
    seen.add(line);
  }

  return repeats;
}
