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
app.use(express.json({ limit: "20mb" })); // raised limit: base64 video uploads need headroom

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

async function callGemini(contents, systemPrompt, maxTokens = 500) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents,
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: { maxOutputTokens: maxTokens }
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

      const err = new Error("rate_limited");
      err.status = 429;
      err.retrySeconds = retrySeconds;
      throw err;
    }

    const err = new Error("AI provider request failed.");
    err.status = 502;
    throw err;
  }

  const data = await response.json();
  const candidate = (data.candidates || [])[0];
  const reply = (candidate?.content?.parts || [])
    .map((p) => p.text || "")
    .join("\n")
    .trim();

  const finishReason = candidate?.finishReason;
  if (finishReason && finishReason !== "STOP") {
    console.error("Gemini stopped early — finishReason:", finishReason);
    if (reply) {
      // We got partial text — say so plainly instead of pretending it's complete.
      return reply + `\n\n[Cut short by the AI provider — reason: ${finishReason}. Try again, or if you uploaded a video, try describing it in words instead.]`;
    }
    return `The AI provider stopped without returning anything (reason: ${finishReason}). Try again, or if you uploaded a video, try describing it in words instead.`;
  }

  return reply || "I didn't get a usable response that time — try again.";
}

function handleGeminiError(err, res) {
  if (err.status === 429) {
    return res.status(429).json({
      error: "rate_limited",
      retryAfterSeconds: err.retrySeconds,
      message: `The free AI tier is being used a lot right now — try again in about ${err.retrySeconds} seconds.`
    });
  }
  console.error(err);
  return res.status(err.status || 500).json({ error: err.message || "Unexpected server error." });
}

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

    const reply = await callGemini(contents, systemPrompt, 300);
    res.json({ reply });
  } catch (err) {
    handleGeminiError(err, res);
  }
});

/* ============================================================
   CONTENT CREATOR BOT — /content
   Powers the separate Content Creator Bot app. Same Gemini key,
   same server, different system prompts per "mode".
   ============================================================ */

const CONTENT_SYSTEM_PROMPTS = {
  ideas:
    "You are a short-form video content strategist for a creator who posts " +
    "gameplay clips (often eFootball) to YouTube Shorts, TikTok, and " +
    "Instagram Reels. Given a niche/topic, generate a numbered list of 8 " +
    "specific, punchy video ideas — each with a one-line hook and why it " +
    "would perform well. Be concrete, not generic. No preamble, start " +
    "straight at item 1.",

  captions:
    "You are a social captions and hashtag expert for short-form video. " +
    "Given a video description and target platform, write: (1) three " +
    "caption options of varying tone (hype, funny, minimal), and (2) a " +
    "single line of 8-12 relevant hashtags suited to that platform's " +
    "norms (TikTok/Reels hashtags differ from YouTube tags). Be concise, " +
    "no long explanations.",

  editing:
    "You are a professional short-form video editor giving another editor " +
    "a clear, step-by-step editing plan for a clip they're about to cut " +
    "together — not writing generic advice. Given details about the " +
    "footage (length, best moment, mood, platform), return a structured " +
    "plan covering: (1) the hook — exactly what should be visible/audible " +
    "in the first 1-2 seconds to stop the scroll, (2) suggested cut points " +
    "and pacing, including where to use jump cuts or speed-ramps to kill " +
    "dead air and hold retention, (3) specific music/sound-effect style " +
    "guidance — genre, energy level, and exactly where a beat drop or " +
    "sound hit should land relative to the action, (4) text-overlay " +
    "ideas and their exact timing, (5) a thumbnail/cover-frame suggestion. " +
    "Be specific and practical — something they could follow directly in " +
    "CapCut or similar. This is craft-level editing advice, not a growth " +
    "guarantee — do not promise subscribers or views. No filler, no " +
    "disclaimers beyond that."
};

app.post("/content", async (req, res) => {
  try {
    const { mode, input } = req.body || {};

    if (!mode || !CONTENT_SYSTEM_PROMPTS[mode]) {
      return res.status(400).json({ error: "Missing or invalid 'mode'. Use ideas, captions, or editing." });
    }
    if (!input || typeof input !== "string") {
      return res.status(400).json({ error: "Missing 'input' string in request body." });
    }
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: "Server is missing GEMINI_API_KEY." });
    }

    const systemPrompt = CONTENT_SYSTEM_PROMPTS[mode];
    const contents = [{ role: "user", parts: [{ text: input }] }];

    const reply = await callGemini(contents, systemPrompt, 1100);
    res.json({ reply });
  } catch (err) {
    handleGeminiError(err, res);
  }
});

/* ============================================================
   VIDEO ANALYSIS — /analyze-video
   Gemini actually watches the uploaded clip (as inline base64 data)
   and gives an editing plan grounded in what's really in the footage.
   This does NOT edit or export any video — it only analyzes and
   describes what to do, in text, same as the other /content modes.
   ============================================================ */

const VIDEO_ANALYSIS_PROMPT =
  "You are a professional short-form video editor. You have been given " +
  "actual footage to watch, not just a description. Watch it carefully " +
  "and then return a concrete, step-by-step editing plan grounded in " +
  "what you actually see and hear: (1) identify the single best moment " +
  "and its approximate timestamp — this is the hook, and say exactly " +
  "what should be visible/audible in the first 1-2 seconds to stop the " +
  "scroll, (2) flag any slow or dead sections worth cutting or trimming " +
  "with their timestamps, and suggest exact cut points and pacing " +
  "(jump cuts, speed-ramps) to hold retention, (3) recommend specific " +
  "music/sound-effect style — genre, energy — and exactly where a beat " +
  "drop or sound hit should land relative to the action you saw, " +
  "(4) suggest text-overlay ideas and their exact timing, (5) suggest " +
  "the best single frame to use as a thumbnail/cover. Be specific to " +
  "this footage — never generic. If the platform or desired mood is " +
  "given, tailor the plan to it. This is craft-level editing advice, " +
  "not a growth guarantee — do not promise subscribers or views. No " +
  "filler, no disclaimers beyond that.";

// 20mb JSON limit ≈ ~14-15mb of actual video after base64 overhead —
// plenty for a compressed short-form clip (15-60s), tight for anything longer.
const MAX_VIDEO_BASE64_CHARS = 19 * 1024 * 1024;

app.post("/analyze-video", async (req, res) => {
  try {
    const { videoBase64, mimeType, platform, mood } = req.body || {};

    if (!videoBase64 || typeof videoBase64 !== "string") {
      return res.status(400).json({ error: "Missing 'videoBase64' in request body." });
    }
    if (!mimeType || typeof mimeType !== "string") {
      return res.status(400).json({ error: "Missing 'mimeType' in request body." });
    }
    if (videoBase64.length > MAX_VIDEO_BASE64_CHARS) {
      return res.status(413).json({
        error: "video_too_large",
        message: "That clip is too large for this free setup — trim it shorter or compress it and try again (aim for well under a minute)."
      });
    }
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: "Server is missing GEMINI_API_KEY." });
    }

    let contextLine = "";
    if (platform) contextLine += `Platform: ${platform}. `;
    if (mood) contextLine += `Desired mood/style: ${mood}.`;

    const contents = [{
      role: "user",
      parts: [
        { inlineData: { mimeType, data: videoBase64 } },
        { text: contextLine || "Give the full editing plan for this clip." }
      ]
    }];

    const reply = await callGemini(contents, VIDEO_ANALYSIS_PROMPT, 1300);
    res.json({ reply });
  } catch (err) {
    handleGeminiError(err, res);
  }
});

app.listen(PORT, () => {
  console.log(`LaPrimero backend listening on port ${PORT}`);
});

