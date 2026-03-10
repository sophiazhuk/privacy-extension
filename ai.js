export async function sendPrompt({ apiKey }) {
  // fail if settings are missing
  if (!apiKey) {
    throw new Error("missing API key");
  }

  // lightweight model for now
  const model = "gemini-2.5-flash-lite";
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent` +
    `?key=${encodeURIComponent(apiKey)}`;

  // placeholder prompt for now
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "Explain how AI works in a few words" }] }],
      generationConfig: { temperature: 0.2 }
    })
  });

  // if bad response, then print error message
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.error?.message || `${response.status}`);
  }

  // grab answer Gemini wrote, fallback to empty string
  return body?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}
