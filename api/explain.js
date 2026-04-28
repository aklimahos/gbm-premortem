// /api/explain.js
// Vercel serverless function: takes a trial name, returns a plain-English
// deep-dive of that single trial's outcome and why it landed that way.
// Used by the "click any trial card" deep-dive modal in the database section.

import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const trialsPath = path.join(process.cwd(), "data", "trials.json");
const trials = JSON.parse(fs.readFileSync(trialsPath, "utf-8"));

const SYSTEM_PROMPT = `You are a clinical research educator explaining a single past glioblastoma trial to non-clinical readers (university students, journalists, curious people).

Given one trial's data, write a plain-English breakdown that a smart high-schooler could understand. Avoid clinical jargon (OS, PFS, HR, mAb, mOS, etc.) without translating it. Use concrete numbers from the trial data, but rephrase them in human terms (say "patients lived about 15 months on average" instead of "mOS 15.0 mo").

GROUNDING:
- Every claim must come from the trial's data fields. Do not invent numbers, drug effects, or rationale.
- If the database doesn't tell you something, say so rather than guessing.
- Use the trial's own analysis and notes fields as primary source for the "why" section.

TONE:
- Plain English, warm but accurate.
- No clinical jargon without immediate translation.
- No marketing language. No emojis.

CRITICAL OUTPUT FORMAT:
Your entire response must be a single valid JSON object. Nothing else. No explanation before. No explanation after. No markdown code fences.

The JSON must have exactly this shape:

{
  "outcome_summary": "ONE sentence telling the reader the bottom-line outcome in plain English (max 20 words). Be blunt. Examples: 'The drug didn't help patients live longer.' or 'The drug worked when given to the right patients.'",
  "what_they_tried": "2 to 3 sentences. What was the drug or treatment? Who got it? What were they hoping would happen?",
  "what_happened": "2 to 3 sentences with the actual numbers translated to plain English. Did patients live longer than the comparison group? By how much? Was the difference real or could it have been chance?",
  "why": "2 to 4 sentences explaining the underlying reason this trial succeeded or failed. Reference the biology or trial design choice, in plain language. This is the most important section.",
  "what_we_learned": "1 to 2 sentences on the broader lesson for future trials in this disease."
}

Field constraints:
- outcome_summary: ONE sentence, max 20 words.
- what_they_tried, what_happened, why: 2-4 sentences each.
- what_we_learned: 1-2 sentences.
- All fields plain English. No abbreviations like OS, PFS, HR, ORR, mOS without immediate translation.

REMEMBER: Return ONLY the JSON object. Start with { and end with }. Nothing else.`;

function extractJson(text) {
  if (!text) return null;
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  try { return JSON.parse(cleaned); } catch (_) {}
  const start = cleaned.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = cleaned.slice(start, i + 1);
        try { return JSON.parse(candidate); } catch (_) { return null; }
      }
    }
  }
  return null;
}

export default async function handler(req, res) {
  // GET so Vercel's edge can cache identical trial requests
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: "ANTHROPIC_API_KEY not configured.",
    });
  }

  try {
    const trial_name = req.query.trial || (req.query && req.query.trial_name);
    if (!trial_name) {
      return res.status(400).json({ error: "Missing ?trial= parameter." });
    }

    const trial = trials.find((t) => t.name === trial_name);
    if (!trial) {
      return res.status(404).json({ error: `Trial "${trial_name}" not found.` });
    }

    const userMessage = `TRIAL DATA (every claim in your output must come from these fields):
${JSON.stringify(trial, null, 2)}

Now produce the plain-English breakdown JSON object.`;

    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1200,
      system: SYSTEM_PROMPT,
      messages: [
        { role: "user", content: userMessage },
      ],
    });

    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    const parsed = extractJson(text);
    if (!parsed) {
      console.error("JSON parse failed. Raw text:", text);
      return res.status(502).json({
        error: "Could not parse model response. Try again.",
      });
    }

    // Add metadata so the front-end can render header info without an extra lookup
    parsed.name = trial.name;
    parsed.year = trial.year ? Math.round(trial.year) : null;

    // Cache identical requests at the Vercel edge for 24 hours, serve stale
    // for up to 7 days while revalidating in the background. First visitor
    // pays the ~3-5s cost; everyone after gets near-instant response.
    res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
    return res.status(200).json(parsed);
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({
      error: err.message || "Unknown server error",
    });
  }
}
