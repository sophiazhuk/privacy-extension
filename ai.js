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
    throw createGeminiError("auth", "missing API key");
  }

  if (!baseReport || !Array.isArray(baseReport.categories)) {
    throw createGeminiError("input", "missing base report");
  }

  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw createGeminiError("input", "missing policy blocks");
  }

  const promptBlocks = buildPromptBlocks(blocks);
  if (promptBlocks.length === 0) {
    throw createGeminiError("input", "no usable policy blocks for Gemini");
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
  }).catch((error) => {
    throw createGeminiError("http", error.message || "network error");
  });

  const body = await response.json().catch(() => {
    throw createGeminiError("json_parse", "Gemini returned a non-JSON response body.");
  });

  if (!response.ok) {
    throw createGeminiError(classifyHttpError(response.status, body?.error?.message), body?.error?.message || `${response.status}`);
  }

  const responseText = body?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  if (!responseText.trim()) {
    throw createGeminiError("empty_response", "Gemini returned an empty response.");
  }

  const parsed = parseGeminiJson(responseText);
  try {
    validateModelInterpretation(parsed, promptBlocks);
  } catch (error) {
    throw createGeminiError("validation", error.message || "Gemini returned an incomplete report.");
  }

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

function parseGeminiJson(responseText) {
  try {
    return JSON.parse(stripCodeFence(responseText));
  } catch {
    throw createGeminiError("json_parse", "Gemini returned invalid JSON.");
  }
}

function classifyHttpError(status, message) {
  const lowerMessage = String(message || "").toLowerCase();
  if (status === 401 || status === 403 || lowerMessage.includes("api key")) {
    return "auth";
  }
  if (status === 429 || lowerMessage.includes("quota")) {
    return "quota";
  }
  return "http";
}

function createGeminiError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
