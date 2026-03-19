import {
  buildInterpretationPrompt,
  buildPromptBlocks,
  mergeInterpretation,
  stripCodeFence,
  validateModelInterpretation
} from "./ai-report-interpretation.js";
import { normalizePrivacyReport } from "./output-structure.js";

const MODEL = "gemini-2.5-flash-lite";

export async function sendPrompt({ apiKey, baseReport, blocks }) {
  if (!apiKey) {
    throw new Error("missing API key");
  }

  if (!baseReport || !Array.isArray(baseReport.categories)) {
    throw new Error("missing base report");
  }

  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new Error("missing policy blocks");
  }

  const promptBlocks = buildPromptBlocks(blocks);
  if (promptBlocks.length === 0) {
    throw new Error("no usable policy blocks for Gemini");
  }

  const response = await fetch(buildEndpoint(apiKey), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: buildInterpretationPrompt(promptBlocks) }] }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json"
      }
    })
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.error?.message || `${response.status}`);
  }

  const responseText = body?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const parsed = JSON.parse(stripCodeFence(responseText));
  validateModelInterpretation(parsed, promptBlocks);

  return {
    model: MODEL,
    promptBlockCount: promptBlocks.length,
    rawText: responseText,
    proposedCategories: Array.isArray(parsed?.categories) ? parsed.categories : [],
    report: normalizePrivacyReport(mergeInterpretation(baseReport, parsed, promptBlocks))
  };
}

function buildEndpoint(apiKey) {
  return (
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent` +
    `?key=${encodeURIComponent(apiKey)}`
  );
}
