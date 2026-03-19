const GRADE_ORDER = {
  "Not addressed": 0,
  "Does Not Leave Device": 1,
  "Processed But Not Stored": 2,
  Stored: 3,
  "Shared with Third Party": 4
};

const CATEGORY_DEFS = [
  {
    name: "Confidential Data",
    sensitivity: 7,
    terms: [
      /username/i,
      /password/i,
      /credential/i,
      /payment card/i,
      /payment data/i,
      /payment method/i,
      /transaction and payment data/i,
      /transaction data/i,
      /billing/i,
      /financial/i,
      /credit card/i,
      /debit card/i,
      /health/i,
      /medical/i,
      /bank/i
    ],
    examples: ["username", "passwords", "payment card info", "transaction data", "billing info", "financial info", "health info"]
  },
  {
    name: "Personal Information",
    sensitivity: 6,
    terms: [/personal information/i, /first and last name/i, /name/i, /gender/i, /pronoun/i, /e-?mail/i, /phone/i, /mobile number/i, /address/i, /profile information/i, /date of birth/i, /student id/i, /contact information/i],
    examples: ["name", "gender", "email address", "phone number", "profile information"]
  },
  {
    name: "Device Files",
    sensitivity: 5,
    terms: [/uploaded files?/i, /submitted content/i, /research papers?/i, /class assignments?/i, /school projects?/i, /documents?/i, /uploads?/i, /post content/i],
    examples: ["uploaded files", "documents", "photos", "videos", "assignments"]
  },
  {
    name: "Communication History and Logs",
    sensitivity: 4,
    terms: [/messages?/i, /email content/i, /chat/i, /discussion group comments?/i, /communications?/i, /private messages?/i, /log history/i, /interactions with us/i],
    examples: ["messages", "email content", "comments", "chat logs"]
  },
  {
    name: "Location Data",
    sensitivity: 5,
    terms: [
      /precise location/i,
      /location information/i,
      /geographic information/i,
      /geographic location/i,
      /approximate location/i,
      /ip address/i,
      /where you are located/i,
      /country or state/i,
      /country of residence/i,
      /gps/i,
      /geolocation/i,
      /cell tower/i,
      /wi-?fi hotspot/i,
      /content delivery/i,
      /deliver content/i
    ],
    examples: ["precise location", "approximate location", "country", "region", "GPS", "cell tower location", "Wi-Fi hotspot location"]
  },
  {
    name: "Camera and Microphone",
    sensitivity: 5,
    terms: [/camera/i, /microphone/i, /voice recordings?/i, /video images?/i, /microphone access/i, /camera access/i],
    examples: ["video images", "voice recordings", "camera access", "microphone access"]
  },
  {
    name: "Device Information and Usage Data",
    sensitivity: 3,
    terms: [/device information/i, /browser type/i, /operating system/i, /persistent identifiers?/i, /internet protocol/i, /ip address/i, /domain name/i, /unique device identifiers?/i, /device id/i, /product usage information/i, /how you use our products/i, /analytics/i],
    examples: ["browser type", "operating system", "IP address", "device ID", "usage data"]
  }
];

const ACTION_PATTERNS = {
  "Shared with Third Party": [
    /viewable by other users/i,
    /searchable by other users/i,
    /publicly available/i,
    /accessible to other users/i
  ],
  Stored: [
    /retain/i,
    /store/i,
    /kept?/i,
    /maintain/i,
    /archive/i,
    /save/i,
    /hold/i,
    /record/i
  ],
  "Processed But Not Stored": [
    /process/i,
    /use the information/i,
    /use your information/i,
    /provide/i,
    /operate/i,
    /improve/i,
    /personalize/i,
    /respond to/i,
    /customer support/i,
    /not stored/i,
    /not retain/i,
    /temporary/i,
    /session only/i
  ],
  "Does Not Leave Device": [
    /on-device/i,
    /on device/i,
    /locally on your device/i,
    /never leaves? your device/i,
    /not transmitted/i,
    /local processing/i
  ]
};

const LEGAL_RETENTION_PATTERNS = [/required by law/i, /legal obligation/i, /comply with law/i, /tax/i, /regulatory/i, /statutory/i];
const VAGUE_PATTERNS = [/may share/i, /may retain/i, /as necessary/i, /for as long as needed/i, /certain information/i, /other information/i];
const SHARING_SECTION_PATTERNS = [/disclosure/i, /sharing/i, /third.?party/i, /recipient/i];
const COLLECTION_SECTION_PATTERNS = [/information collection/i, /personal information/i, /device information/i, /user communications/i, /product usage information/i];
const USE_SECTION_PATTERNS = [/use of your information/i, /how we use/i, /our use/i];
const SHARING_VERB_PATTERNS = [/share/i, /disclos/i, /make available/i, /transfer/i, /provide to/i];
const SHARING_RECIPIENT_PATTERNS = [
  /service providers?/i,
  /affiliates?/i,
  /subsidiar/i,
  /third part/i,
  /employer partners?/i,
  /social networking platforms?/i,
  /academic institutions?/i,
  /fellow students?/i,
  /parents of students/i,
  /other users/i,
  /public/i
];
const COLLECTION_VERB_PATTERNS = [/collect/i, /gather/i];

export function buildPrivacyReport(input) {
  // accept either raw text or the extracted block payload from background
  const policyText = typeof input === "string" ? input : input?.policyText || "";
  const blocks = normalizeBlocks(input?.blocks, policyText);
  const lines = normalizeLines(policyText);
  const categories = CATEGORY_DEFS.map((category) => analyzeCategory(category, blocks));
  const knownCategories = categories.filter((category) => category.grade !== "Not addressed");
  const topFlags = [...knownCategories]
    .sort(compareConcern)
    .slice(0, 3)
    .map((category) => `${category.name}: ${category.summary_line}`);

  const unknowns = buildUnknowns(categories, blocks, lines);

  return normalizePrivacyReport({
    top_summary: buildTopSummary(knownCategories, unknowns),
    top_flags: topFlags,
    categories,
    unknowns
  });
}

export function normalizePrivacyReport(report) {
  // fill the UI contract back out so partial model responses do not break rendering
  const rawReport = report ?? {};
  const categories = CATEGORY_DEFS.map((definition) => normalizeCategory(rawReport, definition));
  const knownCategories = categories.filter((category) => category.grade !== "Not addressed");

  const unknowns = unique(stringList(rawReport.unknowns)).slice(0, 6);
  const topFlags = [...knownCategories].sort(compareConcern).slice(0, 3).map((category) => `${category.name}: ${category.summary_line}`);
  const topSummary = buildTopSummary(knownCategories, unknowns);

  return {
    top_summary: topSummary,
    top_flags: topFlags,
    categories,
    unknowns
  };
}

export function renderPrivacyReport(report, elements) {
  const { reportPanel, reportSummary, reportCategories, reportUnknowns } = elements;

  reportSummary.innerHTML = `
    <div class="report-hero">
      <p class="report-summary">${escapeHtml(report.top_summary)}</p>
      <ul class="report-flags">${report.top_flags.map((flag) => `<li>${escapeHtml(flag)}</li>`).join("")}</ul>
    </div>
  `;

  reportCategories.innerHTML = report.categories.map(renderCategoryCard).join("");

  if (report.unknowns.length > 0) {
    reportUnknowns.innerHTML = `
      <details class="report-card unknown-card">
        <summary>
          <span class="category-name">Unclear or Missing</span>
          <span class="grade-pill unclear-pill">${report.unknowns.length}</span>
        </summary>
        <ul class="detail-list">${report.unknowns.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
      </details>
    `;
  } else {
    reportUnknowns.innerHTML = "";
  }

  reportPanel.classList.remove("hidden");
}

export function categoryDefinitions() {
  return CATEGORY_DEFS.map(({ name, examples }) => ({ name, examples: [...examples] }));
}

function analyzeCategory(category, blocks) {
  const categoryBlocks = blocks.filter((block) => blockMatchesCategory(block, category));
  if (categoryBlocks.length === 0) {
    return emptyCategory(category, "This category is not clearly addressed in the policy.");
  }

  // keep evidence separated by action so the chosen grade and shown evidence stay aligned
  const actionBuckets = {
    "Does Not Leave Device": [],
    "Processed But Not Stored": [],
    Stored: [],
    "Shared with Third Party": []
  };

  for (const block of categoryBlocks) {
    const action = classifyBlockAction(block);
    if (action) {
      actionBuckets[action].push(block);
    }
  }

  const grade = highestBucketGrade(actionBuckets);
  if (!grade) {
    if (category.name === "Location Data" && categoryBlocks.some((block) => hasApproximateLocationCue(block.text))) {
      return {
        name: category.name,
        grade: "Processed But Not Stored",
        grade_modifier: "",
        summary_line: "Location Data appears to be used in an approximate way, such as country or IP-based delivery.",
        examples: collectExamples(categoryBlocks, category),
        details: [
          "The policy mentions location-related handling, but it does not clearly describe precise location collection.",
          "This looks more like approximate or IP-based location use than exact GPS-style tracking."
        ],
        evidence: categoryBlocks.slice(0, 3).map(formatEvidenceLine),
        confidence: "partially clear",
        sensitivity: category.sensitivity
      };
    }

    return {
      ...emptyCategory(category, `${category.name} is mentioned, but the policy does not clearly explain what happens to it.`),
      examples: collectExamples(categoryBlocks, category),
      details: [
        "The policy mentions this category of data, but the handling is not specific enough to grade.",
        "Review the source text directly before drawing a conclusion."
      ],
      evidence: categoryBlocks.slice(0, 2).map(formatEvidenceLine)
    };
  }

  const winningBlocks = actionBuckets[grade];
  const confidence = winningBlocks.some((block) => isVague(block.text)) ? "partially clear" : "clear";
  const examples = collectExamples(winningBlocks.length > 0 ? winningBlocks : categoryBlocks, category);
  const gradeModifier = grade === "Stored" && winningBlocks.some((block) => LEGAL_RETENTION_PATTERNS.some((pattern) => pattern.test(block.text)))
    ? "Legally Required Retention"
    : "";

  return {
    name: category.name,
    grade,
    grade_modifier: gradeModifier,
    summary_line: buildCategorySummary(category.name, grade, gradeModifier, examples),
    examples,
    details: buildDetails(grade, examples, confidence),
    evidence: winningBlocks.slice(0, 3).map(formatEvidenceLine),
    confidence,
    sensitivity: category.sensitivity
  };
}

function classifyBlockAction(block) {
  const localText = block.text.toLowerCase();
  const sectionText = block.sectionTitle.toLowerCase();

  // pick the strongest local action signal in this block instead of mixing signals from the whole document
  if (ACTION_PATTERNS["Does Not Leave Device"].some((pattern) => pattern.test(localText))) {
    return "Does Not Leave Device";
  }

  if (hasLocalSharingCue(localText) || (SHARING_SECTION_PATTERNS.some((pattern) => pattern.test(sectionText)) && hasLocalSharingCue(localText))) {
    return "Shared with Third Party";
  }

  if (ACTION_PATTERNS.Stored.some((pattern) => pattern.test(localText))) {
    return "Stored";
  }

  if (COLLECTION_VERB_PATTERNS.some((pattern) => pattern.test(localText)) || COLLECTION_SECTION_PATTERNS.some((pattern) => pattern.test(sectionText))) {
    return "Processed But Not Stored";
  }

  if (ACTION_PATTERNS["Processed But Not Stored"].some((pattern) => pattern.test(localText))) {
    return "Processed But Not Stored";
  }

  if (USE_SECTION_PATTERNS.some((pattern) => pattern.test(sectionText)) && /use|process|improve|operate|provide|personalize|support/i.test(localText)) {
    return "Processed But Not Stored";
  }

  return "";
}

function hasLocalSharingCue(text) {
  const directShare = ACTION_PATTERNS["Shared with Third Party"].some((pattern) => pattern.test(text));
  const recipientShare = SHARING_VERB_PATTERNS.some((pattern) => pattern.test(text))
    && SHARING_RECIPIENT_PATTERNS.some((pattern) => pattern.test(text));

  return directShare || recipientShare;
}

function highestBucketGrade(actionBuckets) {
  for (const grade of ["Shared with Third Party", "Stored", "Processed But Not Stored", "Does Not Leave Device"]) {
    if (actionBuckets[grade].length > 0) {
      return grade;
    }
  }
  return "";
}

function normalizeCategory(report, definition) {
  const fromReport = Array.isArray(report?.categories)
    ? report.categories.find((item) => stringValue(item?.name) === definition.name)
    : null;

  const grade = validGrade(stringValue(fromReport?.grade)) ? stringValue(fromReport?.grade) : "Not addressed";
  const gradeModifier = stringValue(fromReport?.grade_modifier);
  const examples = stringList(fromReport?.examples);
  const confidence = validConfidence(stringValue(fromReport?.confidence)) ? stringValue(fromReport?.confidence) : "unclear";
  const evidence = stringList(fromReport?.evidence).slice(0, 3);
  const details = stringList(fromReport?.details);
  const summaryLine = stringValue(fromReport?.summary_line) || buildCategorySummary(definition.name, grade, gradeModifier, examples);

  return {
    name: definition.name,
    grade,
    grade_modifier: gradeModifier,
    summary_line: summaryLine,
    examples,
    details: details.length > 0 ? details : buildDetails(grade, examples, confidence),
    evidence,
    confidence,
    sensitivity: definition.sensitivity
  };
}

function buildDetails(grade, examples, confidence) {
  const joinedExamples = examples.join(", ");
  const details = [];

  if (joinedExamples) {
    details.push(`Examples mentioned: ${joinedExamples}.`);
  }

  if (grade === "Shared with Third Party") {
    details.push("The policy suggests this data can leave the company and be disclosed to outside parties.");
  } else if (grade === "Stored") {
    details.push("The policy suggests this data is kept by the company instead of being used only temporarily.");
  } else if (grade === "Processed But Not Stored") {
    details.push("The policy suggests this data is used temporarily without clear long-term retention.");
  } else if (grade === "Does Not Leave Device") {
    details.push("The policy suggests this data is processed locally and does not leave the device.");
  } else {
    details.push("The policy does not clearly explain what happens to this category of data.");
  }

  if (confidence !== "clear") {
    details.push("The wording is vague enough that this should be reviewed directly in the policy.");
  }

  return details;
}

function buildCategorySummary(name, grade, gradeModifier, examples) {
  const exampleText = examples.length > 0 ? ` such as ${examples.join(", ")}` : "";

  if (grade === "Shared with Third Party") {
    return `${name}${exampleText} may be shared with outside parties.`;
  }
  if (grade === "Stored") {
    if (gradeModifier) {
      return `${name}${exampleText} appears to be stored for legal or compliance reasons.`;
    }
    return `${name}${exampleText} appears to be stored by the company.`;
  }
  if (grade === "Processed But Not Stored") {
    return `${name}${exampleText} appears to be processed without clear long-term storage.`;
  }
  if (grade === "Does Not Leave Device") {
    return `${name}${exampleText} appears to stay on the device.`;
  }
  return `${name} is not clearly described in the policy.`;
}

function buildTopSummary(categories, unknowns) {
  if (categories.length === 0) {
    return "The policy text was fetched, but the main data-handling categories are still unclear.";
  }

  const highest = [...categories].sort(compareConcern)[0];
  const unknownNote = unknowns.length > 0 ? ` ${unknowns.length} area(s) are still unclear.` : "";
  return `The biggest concern appears to be ${highest.name.toLowerCase()} because it is graded as ${highest.grade.toLowerCase()}.${unknownNote}`;
}

function buildUnknowns(categories, blocks, lines) {
  const unknowns = [];

  for (const category of categories) {
    if (category.grade === "Not addressed") {
      if (category.evidence.length > 0) {
        unknowns.push(`${category.name} is mentioned, but the policy does not clearly explain how it is handled.`);
      } else {
        unknowns.push(`${category.name} is not clearly addressed in the policy.`);
      }
    } else if (category.confidence !== "clear") {
      unknowns.push(`${category.name} uses vague wording, so the handling is only partially clear.`);
    }
  }

  if (lines.some((line) => /retain/i.test(line)) && !lines.some((line) => /days|months|years|delete/i.test(line))) {
    unknowns.push("Retention is mentioned, but the policy does not clearly explain how long data is kept.");
  }

  if (blocks.some((block) => SHARING_VERB_PATTERNS.some((pattern) => pattern.test(block.text))) && !blocks.some((block) => hasLocalSharingCue(block.text.toLowerCase()))) {
    unknowns.push("Sharing is mentioned, but the policy does not clearly say who receives the data.");
  }

  return unique(unknowns).slice(0, 6);
}

function renderCategoryCard(category) {
  const gradeLabel = category.grade_modifier ? `${category.grade} (${category.grade_modifier})` : category.grade;
  const exampleMarkup = category.examples.length > 0
    ? `<p class="report-examples">Examples: ${escapeHtml(category.examples.join(", "))}</p>`
    : "";
  const evidenceMarkup = category.evidence.length > 0
    ? `
      <details class="evidence-toggle">
        <summary>Show source</summary>
        <ul class="evidence-list">${category.evidence.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>
      </details>
    `
    : "";

  return `
    <details class="report-card">
      <summary>
        <span class="category-name">${escapeHtml(category.name)}</span>
        <span class="grade-pill ${gradeClassName(category.grade)}">${escapeHtml(gradeLabel)}</span>
      </summary>
      <p class="summary-line">${escapeHtml(category.summary_line)}</p>
      <p class="confidence-line">Clarity: ${escapeHtml(category.confidence)}</p>
      ${exampleMarkup}
      <ul class="detail-list">${category.details.map((detail) => `<li>${escapeHtml(detail)}</li>`).join("")}</ul>
      ${evidenceMarkup}
    </details>
  `;
}

function emptyCategory(category, summaryLine) {
  return {
    name: category.name,
    grade: "Not addressed",
    grade_modifier: "",
    summary_line: summaryLine,
    examples: [],
    details: [],
    evidence: [],
    confidence: "unclear",
    sensitivity: category.sensitivity
  };
}

function blockMatchesCategory(block, category) {
  const searchable = `${block.sectionTitle} ${block.text}`;
  return category.terms.some((pattern) => pattern.test(searchable));
}

function collectExamples(blocks, category) {
  const collected = [];

  for (const example of category.examples) {
    const sample = example.toLowerCase().replace(/details|information/g, "").trim();
    if (sample && blocks.some((block) => block.text.toLowerCase().includes(sample))) {
      collected.push(example);
    }
  }

  return collected.slice(0, 4);
}

function isVague(text) {
  return VAGUE_PATTERNS.some((pattern) => pattern.test(text));
}

function hasApproximateLocationCue(text) {
  return /(ip address|country|region|geographic location|content delivery|deliver content|localized content)/i.test(text);
}

function formatEvidenceLine(block) {
  return `${block.sectionTitle}: ${block.text}`;
}

function compareConcern(a, b) {
  const byGrade = GRADE_ORDER[b.grade] - GRADE_ORDER[a.grade];
  if (byGrade !== 0) {
    return byGrade;
  }
  return b.sensitivity - a.sensitivity;
}

function normalizeBlocks(blocks, policyText) {
  if (Array.isArray(blocks) && blocks.length > 0) {
    return blocks
      .map((block) => ({
        sectionTitle: stringValue(block?.sectionTitle) || "General",
        text: stringValue(block?.text)
      }))
      .filter((block) => block.text);
  }

  return normalizeLines(policyText).map((line) => ({ sectionTitle: "General", text: line }));
}

function normalizeLines(text) {
  return text
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function validGrade(value) {
  return Object.hasOwn(GRADE_ORDER, value);
}

function validConfidence(value) {
  return ["clear", "partially clear", "unclear"].includes(value);
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function stringList(value) {
  return Array.isArray(value)
    ? value.map((item) => stringValue(item)).filter(Boolean)
    : [];
}

function gradeClassName(grade) {
  return {
    "Shared with Third Party": "grade-shared",
    Stored: "grade-stored",
    "Processed But Not Stored": "grade-processed",
    "Does Not Leave Device": "grade-local",
    "Not addressed": "grade-unknown"
  }[grade] || "grade-unknown";
}

function unique(items) {
  return [...new Set(items)];
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
