import { categoryDefinitions, normalizePrivacyReport } from "./output-structure.js";

export async function sendPrompt({ apiKey, baseReport }) {
  // fail if settings are missing
  if (!apiKey) {
    throw new Error("missing API key");
  }

  if (!baseReport || !Array.isArray(baseReport.categories)) {
    throw new Error("missing base report");
  }

  // lightweight model for now
  const model = "gemini-2.5-flash-lite";
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent` +
    `?key=${encodeURIComponent(apiKey)}`;

  // model to rewrite existing report
  const categoryNames = categoryDefinitions().map((category) => category.name).join(", ");
  const prompt = [
    "Return only valid JSON.",
    "Rewrite the user-facing privacy report text in plain language.",
    "Do not change category names, grades, grade modifiers, examples, evidence, or confidence values.",
    "Only rewrite summary_line and details for the existing categories, and optionally rewrite unknowns.",
    `Keep these category names exactly: ${categoryNames}`,
    "JSON shape:",
    '{"categories":[{"name":"","summary_line":"","details":[""]}],"unknowns":[""]}',
    "Base report JSON:",
    JSON.stringify(baseReport)
  ].join("\n\n");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json"
      }
    })
  });

  // if bad response, then print error message
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.error?.message || `${response.status}`);
  }

  const responseText = body?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const parsed = JSON.parse(stripCodeFence(responseText));
  validateModelRewrite(parsed, baseReport);

  return {
    rawText: responseText,
    report: normalizePrivacyReport(mergeRewrites(baseReport, parsed))
  };
}

function validateModelRewrite(report, baseReport) {
  // one rewrite entry per category so missing text does not silently drop report content
  const expectedCategories = categoryDefinitions().map((category) => category.name);
  if (!Array.isArray(report?.categories) || report.categories.length !== expectedCategories.length) {
    throw new Error("Gemini did not return rewrite text for the full category set.");
  }

  for (const expectedName of expectedCategories) {
    const rewrite = report.categories.find((item) => String(item?.name || "").trim() === expectedName);
    const baseCategory = baseReport.categories.find((item) => item.name === expectedName);

    if (!rewrite || !baseCategory) {
      throw new Error(`Gemini missing category rewrite: ${expectedName}`);
    }

    if (!String(rewrite.summary_line || "").trim()) {
      throw new Error(`Gemini missing summary text for ${expectedName}.`);
    }

    const details = Array.isArray(rewrite.details) ? rewrite.details.filter((item) => String(item || "").trim()) : [];
    if (details.length === 0) {
      throw new Error(`Gemini missing details for ${expectedName}.`);
    }
  }
}

function mergeRewrites(baseReport, rewriteReport) {
  // only copy the rewritten wording back in
  return {
    ...baseReport,
    categories: baseReport.categories.map((category) => {
      const rewrite = rewriteReport.categories.find((item) => String(item?.name || "").trim() === category.name);
      return {
        ...category,
        summary_line: String(rewrite?.summary_line || "").trim() || category.summary_line,
        details: Array.isArray(rewrite?.details)
          ? rewrite.details.map((item) => String(item || "").trim()).filter(Boolean)
          : category.details
      };
    }),
    unknowns: Array.isArray(rewriteReport?.unknowns)
      ? rewriteReport.unknowns.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 6)
      : baseReport.unknowns
  };
}

function stripCodeFence(text) {
  return String(text)
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}
