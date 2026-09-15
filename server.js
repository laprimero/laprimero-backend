// LaPrimero backend — holds the AI API key server-side.
// The browser prototype (and eventually the Android app) call this
// server instead of ever talking to the AI provider directly.
//
// Uses Google's Gemini API, which has a genuine free tier (no credit
// card required) via Google AI Studio.

import express from "express";
import cors from "cors";

const app = express();
app.use(cors());               // allow the browser prototype to call this server
app.use(express.json());

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.MODEL || "gemini-2.5-flash";

if (!GEMINI_API_KEY) {
  console.warn(
    "WARNING: GEMINI_API_KEY is not set. Set it as an environment " +
    "variable in your hosting provider's dashboard — never hard-code it here."
  );
}

const BASE_SYSTEM_PROMPT =
  "You are LaPrimero, a concise, confident, friendly personal AI assistant " +
  "speaking to the user out loud through a voice interface. Keep replies " +
  "short and conversational — a few sentences at most — since they will " +
  "be read aloud by text-to-speech. If you are not sure about something, " +
  "say so plainly instead of guessing.";

const CREATOR_ADDENDUM =
  " The person you are speaking with right now is your creator — the " +
  "person who built you. Your name, LaPrimero, comes from the Spanish " +
  "for \"the first.\" Address them as Primero. If asked who made you or " +
  "who your creator is, tell them plainly that they did.";

app.get("/", (req, res) => {
  res.send("LaPrimero backend is running.");
});

app.get("/health", (req, res) => {
  res.json({ ok: true, hasKey: Boolean(GEMINI_API_KEY) });
});

app.post("/chat", async (req, res) => {
  try {
    const { message, history, isCreator } = req.body || {};

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Missing 'message' string in request body." });
    }
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: "Server is missing GEMINI_API_KEY." });
    }

    const systemPrompt = BASE_SYSTEM_PROMPT + (isCreator ? CREATOR_ADDENDUM : "");

    // Turn the prototype's { user, assistant } history pairs into
    // alternating user/model turns for the Gemini API.
    const contents = [];
    if (Array.isArray(history)) {
      for (const turn of history) {
        if (turn.user) contents.push({ role: "user", parts: [{ text: turn.user }] });
        if (turn.assistant) contents.push({ role: "model", parts: [{ text: turn.assistant }] });
      }
    }
    contents.push({ role: "user", parts: [{ text: message }] });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { maxOutputTokens: 300 }
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("AI provider error:", response.status, errText);

      if (response.status === 429) {
        let retrySeconds = 30;
        try {
          const parsed = JSON.parse(errText);
          const retryInfo = (parsed.error?.details || parsed[0]?.error?.details || [])
            .find((d) => d["@type"]?.includes("RetryInfo"));
          if (retryInfo?.retryDelay) {
            retrySeconds = parseInt(retryInfo.retryDelay) || retrySeconds;
          }
        } catch (e) { /* fall back to default */ }

        return res.status(429).json({
          error: "rate_limited",
          retryAfterSeconds: retrySeconds,
          message: `The free AI tier is being used a lot right now — try again in about ${retrySeconds} seconds.`
        });
      }

      return res.status(502).json({ error: "AI provider request failed." });
    }

    const data = await response.json();
    const reply = (data.candidates || [])[0]?.content?.parts
      ?.map((p) => p.text || "")
      .join("\n")
      .trim();

    res.json({ reply: reply || "I didn't get a usable response that time — try again." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Unexpected server error." });
  }
});

app.listen(PORT, () => {
  console.log(`LaPrimero backend listening on port ${PORT}`);
});
