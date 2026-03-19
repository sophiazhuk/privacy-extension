import { categoryDefinitions } from "./output-structure.js";

const VALID_GRADES = [
  "Not addressed",
  "Does Not Leave Device",
  "Processed But Not Stored",
  "Stored",
  "Shared with Third Party"
];

const VALID_CONFIDENCE = ["clear", "partially clear", "unclear"];

const GRADE_RANK = {
  "Not addressed": 0,
  "Does Not Leave Device": 1,
  "Processed But Not Stored": 2,
  Stored: 3,
  "Shared with Third Party": 4
};

const CONFIDENCE_RANK = {
  unclear: 0,
  "partially clear": 1,
  clear: 2
};

const SHARING_VERB_PATTERNS = [/share/i, /disclos/i, /make available/i, /transfer/i, /provide to/i];
const SHARING_RECIPIENT_PATTERNS = [
  /service providers?/i,
  /affiliates?/i,
  /subsidiar/i,
  /third part/i,
  /partners?/i,
  /other users/i,
  /public/i,
  /academic institutions?/i,
  /parents?/i,
  /developers?/i
];
const DIRECT_SHARING_PATTERNS = [
  /viewable by other users/i,
  /searchable by other users/i,
  /publicly available/i,
  /accessible to other users/i
];
const STORAGE_PATTERNS = [/retain/i, /store/i, /kept?/i, /maintain/i, /archive/i, /save/i, /hold/i, /record/i];
const LEGAL_RETENTION_PATTERNS = [/required by law/i, /legal obligation/i, /tax/i, /regulatory/i, /statutory/i];
const PROCESS_PATTERNS = [
  /process/i,
  /collect/i,
  /gather/i,
  /use/i,
  /provide/i,
  /operate/i,
  /improve/i,
  /personalize/i,
  /respond to/i,
  /customer support/i
];
const LOCAL_ONLY_PATTERNS = [/on-device/i, /on device/i, /locally on your device/i, /never leaves? your device/i, /not transmitted/i, /local processing/i];
const UI_NOISE_TERMS = [
  "view your profile",
  "wallet",
  "wishlist",
  "points shop",
  "discovery queue",
  "broadcasts",
  "try chatgpt",
  "log in",
  "sign in",
  "skip to main content"
];

export function buildInterpretationPrompt(promptBlocks) {
  const categoryGuide = categoryDefinitions()
    .map((category) => `- ${category.name}: examples include ${category.examples.join(", ")}`)
    .join("\n");

  const blockGuide = promptBlocks
    .map((block) => `${block.id} | ${block.sectionTitle} | ${block.text}`)
    .join("\n");

  return [
    "Return only valid JSON.",
    "You are interpreting privacy-policy evidence blocks, not the whole page.",
    "Use only the supplied evidence blocks. Do not invent evidence or use outside knowledge.",
    "Prefer 'Not addressed' over guessing when evidence is weak or ambiguous.",
    `Allowed grades: ${VALID_GRADES.join(", ")}.`,
    `Allowed confidence values: ${VALID_CONFIDENCE.join(", ")}.`,
    "If a category is not 'Not addressed', include 1 to 3 evidence_ids from the provided block list.",
    "Use short, plain-language summary_line and 1 to 3 short details per category.",
    "Only set grade_modifier to 'Legally Required Retention' when the evidence explicitly supports legal or tax retention.",
    "JSON shape:",
    '{"categories":[{"name":"","grade":"","grade_modifier":"","summary_line":"","details":[""],"examples":[""],"confidence":"","evidence_ids":["B1"]}],"unknowns":[""]}',
    "Categories:",
    categoryGuide,
    "Evidence blocks:",
    blockGuide
  ].join("\n\n");
}

export function buildPromptBlocks(blocks) {
  return blocks
    .map((block, index) => ({
      id: `B${index + 1}`,
      sectionTitle: String(block?.sectionTitle || "General").trim() || "General",
      text: String(block?.text || "").replace(/\s+/g, " ").trim()
    }))
    .filter((block) => block.text.length >= 25)
    .filter((block) => !isLikelyUiNoiseBlock(block.text))
    .map((block) => ({
      ...block,
      score: scorePromptBlock(block)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 80)
    .map(({ score, ...block }) => block);
}

export function validateModelInterpretation(report, promptBlocks) {
  const expectedCategories = categoryDefinitions().map((category) => category.name);
  if (!Array.isArray(report?.categories) || report.categories.length !== expectedCategories.length) {
    throw new Error("Gemini did not return the full category set.");
  }

  const allowedBlockIds = new Set(promptBlocks.map((block) => block.id));

  for (const expectedName of expectedCategories) {
    const category = report.categories.find((item) => String(item?.name || "").trim() === expectedName);
    if (!category) {
      throw new Error(`Gemini missing category interpretation: ${expectedName}`);
    }

    if (!VALID_GRADES.includes(String(category.grade || "").trim())) {
      throw new Error(`Gemini returned an invalid grade for ${expectedName}.`);
    }

    if (!VALID_CONFIDENCE.includes(String(category.confidence || "").trim())) {
      throw new Error(`Gemini returned an invalid confidence value for ${expectedName}.`);
    }

    if (!String(category.summary_line || "").trim()) {
      throw new Error(`Gemini missing summary text for ${expectedName}.`);
    }

    const details = Array.isArray(category.details) ? category.details.filter((item) => String(item || "").trim()) : [];
    if (details.length === 0) {
      throw new Error(`Gemini missing details for ${expectedName}.`);
    }

    const evidenceIds = normalizeEvidenceIds(category.evidence_ids);
    if (String(category.grade).trim() === "Not addressed") {
      continue;
    }

    if (evidenceIds.length === 0) {
      throw new Error(`Gemini missing evidence ids for ${expectedName}.`);
    }

    if (evidenceIds.some((id) => !allowedBlockIds.has(id))) {
      throw new Error(`Gemini referenced unknown evidence ids for ${expectedName}.`);
    }
  }
}

export function mergeInterpretation(baseReport, interpretedReport, promptBlocks) {
  const blockMap = new Map(promptBlocks.map((block) => [block.id, block]));

  return {
    ...baseReport,
    categories: categoryDefinitions().map((definition) => {
      const baseCategory = baseReport.categories.find((item) => item.name === definition.name) || {};
      const interpreted = interpretedReport.categories.find((item) => String(item?.name || "").trim() === definition.name) || {};
      const evidenceIds = normalizeEvidenceIds(interpreted.evidence_ids);
      const evidenceBlocks = evidenceIds
        .map((id) => blockMap.get(id))
        .filter(Boolean)
        .slice(0, 3);

      return mergeCategoryDecision(baseCategory, interpreted, evidenceBlocks, definition.name);
    }),
    unknowns: mergeUnknowns(baseReport.unknowns, interpretedReport?.unknowns)
  };
}

export function stripCodeFence(text) {
  return String(text)
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

function scorePromptBlock(block) {
  const text = `${block.sectionTitle} ${block.text}`.toLowerCase();
  let score = Math.min(block.text.length, 600) / 10;

  if (/privacy policy|collect|share|retain|store|delete|access|cookies|payment|ip address|chat|account/i.test(text)) {
    score += 40;
  }

  if (/how long|who has access|tracking|cookies|rights|information collect|payment|transaction|chat|device/i.test(text)) {
    score += 25;
  }

  if (/view your profile|wallet|wishlist|community|broadcasts|points shop|news|charts/i.test(text)) {
    score -= 80;
  }

  if (/^[-\w\s]{1,40}$/.test(block.text)) {
    score -= 20;
  }

  return score;
}

function isLikelyUiNoiseBlock(text) {
  const lower = text.toLowerCase();
  const navHits = UI_NOISE_TERMS.filter((term) => lower.includes(term)).length;
  return navHits >= 2;
}

function normalizeEvidenceIds(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

function mergeCategoryDecision(baseCategory, interpreted, evidenceBlocks, categoryName) {
  const baseGrade = validGrade(baseCategory?.grade) ? String(baseCategory.grade).trim() : "Not addressed";
  const proposedGrade = validGrade(interpreted?.grade) ? String(interpreted.grade).trim() : baseGrade;
  const supported = proposalSupportedByEvidence(proposedGrade, evidenceBlocks);

  if (!supported) {
    return { ...baseCategory, name: categoryName };
  }

  const severityDelta = GRADE_RANK[proposedGrade] - GRADE_RANK[baseGrade];
  const baseConfidence = validConfidence(baseCategory?.confidence) ? String(baseCategory.confidence).trim() : "unclear";
  const proposedConfidence = validConfidence(interpreted?.confidence) ? String(interpreted.confidence).trim() : baseConfidence;

  if (severityDelta < 0 && baseGrade !== "Not addressed") {
    return {
      ...baseCategory,
      name: categoryName,
      confidence: moreConservativeConfidence(baseConfidence, proposedConfidence)
    };
  }

  if (severityDelta > 0 && baseGrade !== "Not addressed" && baseConfidence === "clear") {
    return { ...baseCategory, name: categoryName };
  }

  const evidence = evidenceBlocks.map((block) => `${block.sectionTitle}: ${block.text}`);

  return {
    ...baseCategory,
    name: categoryName,
    grade: proposedGrade,
    grade_modifier: supportedGradeModifier(String(interpreted?.grade_modifier || "").trim(), evidenceBlocks),
    summary_line: String(interpreted?.summary_line || "").trim() || baseCategory.summary_line,
    details: Array.isArray(interpreted?.details)
      ? interpreted.details.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 3)
      : baseCategory.details,
    examples: Array.isArray(interpreted?.examples)
      ? interpreted.examples.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 4)
      : baseCategory.examples,
    confidence: moreConservativeConfidence(baseConfidence, proposedConfidence),
    evidence
  };
}

function proposalSupportedByEvidence(grade, evidenceBlocks) {
  if (grade === "Not addressed") {
    return true;
  }

  if (!Array.isArray(evidenceBlocks) || evidenceBlocks.length === 0) {
    return false;
  }

  const joined = evidenceBlocks.map((block) => block.text).join("\n");

  if (grade === "Shared with Third Party") {
    return hasSharingCue(joined);
  }

  if (grade === "Stored") {
    return STORAGE_PATTERNS.some((pattern) => pattern.test(joined)) || LEGAL_RETENTION_PATTERNS.some((pattern) => pattern.test(joined));
  }

  if (grade === "Processed But Not Stored") {
    return PROCESS_PATTERNS.some((pattern) => pattern.test(joined));
  }

  if (grade === "Does Not Leave Device") {
    return LOCAL_ONLY_PATTERNS.some((pattern) => pattern.test(joined));
  }

  return false;
}

function hasSharingCue(text) {
  return DIRECT_SHARING_PATTERNS.some((pattern) => pattern.test(text))
    || (SHARING_VERB_PATTERNS.some((pattern) => pattern.test(text))
      && SHARING_RECIPIENT_PATTERNS.some((pattern) => pattern.test(text)));
}

function supportedGradeModifier(gradeModifier, evidenceBlocks) {
  if (gradeModifier !== "Legally Required Retention") {
    return "";
  }

  const joined = evidenceBlocks.map((block) => block.text).join("\n");
  return LEGAL_RETENTION_PATTERNS.some((pattern) => pattern.test(joined)) ? gradeModifier : "";
}

function moreConservativeConfidence(left, right) {
  return CONFIDENCE_RANK[left] <= CONFIDENCE_RANK[right] ? left : right;
}

function mergeUnknowns(baseUnknowns, interpretedUnknowns) {
  return [...new Set([
    ...normalizeStringList(baseUnknowns),
    ...normalizeStringList(interpretedUnknowns)
  ])].slice(0, 6);
}

function normalizeStringList(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

function validGrade(value) {
  return VALID_GRADES.includes(String(value || "").trim());
}

function validConfidence(value) {
  return VALID_CONFIDENCE.includes(String(value || "").trim());
}
