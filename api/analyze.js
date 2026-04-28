// /api/analyze.js
// Vercel serverless function: receives a trial design, calls Claude with the
// embedded GBM trial database, returns structured analysis as JSON.

import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const trialsPath = path.join(process.cwd(), "data", "trials.json");
const trials = JSON.parse(fs.readFileSync(trialsPath, "utf-8"));

const PATTERN_LIBRARY = `
KNOWN FAILURE PATTERNS IN THIS DATABASE (use these names verbatim when they fit):

1. Phase 2 -> Phase 3 effect-size collapse
   Trial advanced on a Phase 2 result that was borderline (p ~0.03-0.10), small,
   or compared against historical controls. The Phase 3 effect was substantially
   smaller or absent. Examples in DB: CENTRIC, ACT IV, INTELLANCE-1 (advanced
   on INTELLANCE-2 p=0.06). HIGH SEVERITY when Phase 2 evidence is borderline,
   historical, or single-arm.

2. Pseudoresponse (anti-angiogenic class)
   Anti-angiogenic drugs (anti-VEGF, anti-VEGFR, anti-integrin) reduce contrast
   enhancement on MRI without changing tumor biology. PFS appears to improve;
   OS does not. Examples in DB: AVAglio, RTOG 0825, EORTC 26101. HIGH SEVERITY
   when target_class is anti-angiogenic AND endpoint is PFS or co-primary.

3. Cold-tumor immune therapy failure
   GBM has low TMB, sparse T-cell infiltrate, and steroid-suppressed immunity.
   PD-1/PD-L1 checkpoint inhibitors have failed across every GBM subgroup
   tested. Examples in DB: CheckMate-143, CheckMate-498, CheckMate-548. HIGH
   SEVERITY for any checkpoint inhibitor in GBM, regardless of biomarker.

4. EGFR-target frequency-vs-dependency mismatch
   EGFR is amplified in ~50% of GBM but is not a true driver dependency the
   way it is in NSCLC. EGFR-targeting strategies (vaccine, ADC) have failed
   despite biomarker enrichment. Examples in DB: ACT IV, INTELLANCE-1.
   HIGH SEVERITY when mechanism targets EGFR.

5. Standard-of-care drift / outdated historical control
   Phase 2 looked good against an outdated historical OS benchmark.
   By Phase 3 readout, contemporary control arms have improved, erasing the
   apparent benefit. Examples in DB: ACT IV. MEDIUM SEVERITY.

6. Active-comparator complications
   Comparator arm has its own confounding effects (e.g., bevacizumab as control
   has PFS effects but no OS benefit). Example in DB: CheckMate-143 (vs bev).
   MEDIUM SEVERITY when comparator is itself active in the disease.

7. Methodological corruption (endpoint changes, crossover, external controls)
   Mid-trial endpoint changes, universal crossover that eliminates the
   randomized control, or comparison against external controls from other
   trials. Example in DB: DCVax-L. HIGH SEVERITY when present in the design.

8. PK / dose-schedule inadequacy
   Drug given on a schedule that does not maintain therapeutic exposure given
   its half-life. Example in DB: CENTRIC (twice-weekly IV, half-life of hours).
   MEDIUM SEVERITY.

9. Drug-class repeat failure
   The proposed mechanism class has multiple prior Phase 3 failures in the
   indication for related reasons.

POSITIVE COMPARATORS (in DB, succeeded):
   Stupp 2005 (TMZ + RT), EF-14 (TTFields device), CeTeG (lomustine + TMZ in
   MGMT-methylated). Use these as contrast.
`;

const SYSTEM_PROMPT = `You are a senior clinical research analyst conducting pre-mortem analysis on proposed Phase 3 glioblastoma trials. You have access to a curated database of 31 historical GBM trials.

Your job: read the user's proposed trial design, compare it against the database, and identify which historical failures it most resembles and which failure patterns it is most likely to repeat.

INPUT FORMAT:
The user provides a free-text description of their trial (drug, dose, mechanism, sample size, endpoint, Phase 2 evidence, comparator, etc.) plus three structured fields: target class, setting, biomarker enrichment. Parse details out of the description as needed. If a critical detail is missing from the description (e.g. primary endpoint, Phase 2 evidence strength), say so in your analysis rather than inventing it.

GROUNDING RULES:
- Every claim about a past trial must be grounded in the database fields you are given. Do not invent trial names, drug effects, p-values, or hazard ratios.
- When the database is thin, say so rather than overclaiming.
- Quote specific numbers from the database when relevant (HRs, p-values, median OS).
- Use the PATTERN_LIBRARY names verbatim. Do not invent new pattern names when an existing one fits.

TONE:
- Direct, clinical, evidence-anchored. Like a senior MSL or clinical pharmacology reviewer.
- No hedging filler. State the evidence and the conclusion.
- No emojis. No marketing language.

CRITICAL OUTPUT FORMAT:
Your entire response must be a single valid JSON object. Nothing else. No explanation before. No explanation after. No markdown code fences. No commentary. The first character of your response must be { and the last character must be }.

The JSON object must have exactly this shape:

{
  "risk_rating": "HIGH",
  "verdict_headline": "Not worth conducting as designed.",
  "plain_explanation": "Two large trials with this exact design have already failed. Patients didn't live longer.",
  "verdict_summary": "One sentence, max 30 words.",
  "patterns_flagged": [
    {
      "name": "Pattern name from PATTERN_LIBRARY",
      "severity": "HIGH",
      "evidence_strength": "e.g. 3 of 3 anti-angiogenic trials in DB",
      "explanation": "2-4 sentences referencing specific trial names and numbers."
    }
  ],
  "similar_trials": [
    {
      "name": "Trial name from DB",
      "year": "2014",
      "outcome": "FAILED",
      "outcome_stats": "mOS 26.3 vs 26.3 mo, HR 1.02, p=0.86",
      "match_reasoning": "2-3 sentences explaining why this trial is the most relevant comparator."
    }
  ],
  "recommendations": [
    "Concrete recommendation, 1-2 sentences."
  ]
}

Field constraints:
- risk_rating: must be exactly "HIGH" or "MEDIUM" or "LOW" (uppercase string)
- verdict_headline: 4-8 words, blunt, no jargon. For HIGH use phrasing like "Not worth conducting as designed." For MEDIUM use "Reconsider before running this." For LOW use "Worth pursuing as designed." Always end with a period.
- plain_explanation: ONE sentence, max 25 words, plain English a university student understands. No abbreviations like OS/PFS/HR. No drug class jargon. Explain WHY in everyday terms (e.g. "Patients didn't live longer", "Tumor shrank but cancer still came back", "No similar trials in the database to compare against").
- verdict_summary: ONE sentence, max 30 words. Technical clinical language is fine here. This is the detailed version.
- severity: must be exactly "HIGH" or "MEDIUM" or "LOW"
- outcome: must be exactly "FAILED" or "SUCCEEDED" or "MIXED"
- patterns_flagged: 1 to 4 items
- similar_trials: exactly 3 items
- recommendations: 3 to 5 items

CALIBRATION:
- HIGH risk: design matches 2+ failure patterns OR has a single pattern with strong evidence (3+ similar prior failures).
- MEDIUM risk: 1 pattern flagged, or thin database evidence in a concerning direction.
- LOW risk: design avoids known failure patterns.

REMEMBER: Return ONLY the JSON object. Start with { and end with }. Nothing else.`;

// Robust extraction of a JSON object from a model response that may include
// preamble, markdown fences, or trailing commentary.
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
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: "ANTHROPIC_API_KEY not configured. Set it in Vercel project settings -> Environment Variables.",
    });
  }

  try {
    const body = req.body || {};
    // Payload: free-text description + 7 structured fields.
    // Also accept legacy shape (drug/mechanism/phase2/context) for back-compat.
    const description = body.description || [
      body.drug && `Drug: ${body.drug}`,
      body.mechanism && `Mechanism: ${body.mechanism}`,
      body.phase2 && `Phase 2 evidence: ${body.phase2}`,
      body.context && `Other context: ${body.context}`,
    ].filter(Boolean).join("\n");

    const target_class = body.target_class;
    const setting = body.setting;
    const biomarker = body.biomarker;
    // Structured fields (fallback if not provided)
    const sample_size = body.sample_size || "not specified";
    const endpoint = body.endpoint || "not specified";
    const comparator = body.comparator || "not specified";
    const combination = body.combination || "not specified";
    const delivery = body.delivery || "not specified";

    if (!target_class || !setting || !biomarker) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    // Description is now optional (the form went all-dropdown). Legacy clients
    // may still send it; if so, append as additional context.
    const descriptionBlock = description
      ? `\n\nAdditional free-text context (parse for any other relevant details):\n${description}`
      : "";

    const userMessage = `PROPOSED TRIAL DESIGN
======================
Target class:           ${target_class}
Setting:                ${setting}
Biomarker enrichment:   ${biomarker}
Sample size:            ${sample_size}
Primary endpoint:       ${endpoint}
Comparator arm:         ${comparator}
Combination:            ${combination}
Delivery to tumor:      ${delivery}${descriptionBlock}

DATABASE - 31 GBM TRIALS
=========================
${JSON.stringify(trials, null, 2)}

${PATTERN_LIBRARY}

Now produce the JSON pre-mortem analysis. The user filled out a structured 8-question form. Pattern-match against the database using the structured fields. If a critical detail is missing or marked "not specified", say so in your analysis rather than inventing it. Return ONLY the JSON object - start with { and end with }. No other text, no preamble, no markdown fences.`;

    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2500,
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
        error: "The model returned a response that could not be parsed. Try again.",
      });
    }

    return res.status(200).json(parsed);
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({
      error: err.message || "Unknown server error",
    });
  }
}
