// LaPrimero backend — holds the AI API key server-side.
// The browser prototype (and eventually the Android app) call this
// server instead of ever talking to the AI provider directly.

import express from "express";
import cors from "cors";

const app = express();
app.use(cors());               // allow the browser prototype to call this server
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MODEL || "claude-sonnet-4-6";

if (!ANTHROPIC_API_KEY) {
  console.warn(
    "WARNING: ANTHROPIC_API_KEY is not set. Set it as an environment " +
    "variable in your hosting provider's dashboard — never hard-code it here."
  );
}

const SYSTEM_PROMPT =
  "You are LaPrimero, a concise, confident, friendly personal AI assistant " +
  "speaking to the user out loud through a voice interface. Keep replies " +
  "short and conversational — a few sentences at most — since they will " +
  "be read aloud by text-to-speech. If you are not sure about something, " +
  "say so plainly instead of guessing.";

app.get("/", (req, res) => {
  res.send("LaPrimero backend is running.");
});

app.get("/health", (req, res) => {
  res.json({ ok: true, hasKey: Boolean(ANTHROPIC_API_KEY) });
});

app.post("/chat", async (req, res) => {
  try {
    const { message, history } = req.body || {};

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Missing 'message' string in request body." });
    }
    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY." });
    }

    // Turn the prototype's { user, assistant } history pairs into
    // alternating user/assistant messages for the API call.
    const messages = [];
    if (Array.isArray(history)) {
      for (const turn of history) {
        if (turn.user) messages.push({ role: "user", content: turn.user });
        if (turn.assistant) messages.push({ role: "assistant", content: turn.assistant });
      }
    }
    messages.push({ role: "user", content: message });

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        system: SYSTEM_PROMPT,
        messages
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("AI provider error:", response.status, errText);
      return res.status(502).json({ error: "AI provider request failed." });
    }

    const data = await response.json();
    const reply = (data.content || [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
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
