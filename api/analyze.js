// /api/analyze.js
// Vercel serverless function — receives a trial design, calls Claude with the
// embedded GBM trial database, returns structured analysis as JSON.
//
// This file runs on Vercel's serverless infrastructure. Your ANTHROPIC_API_KEY
// is set as an environment variable in Vercel (never exposed to the browser).

import Anthropic from "@anthropic-ai/sdk";
import trials from "../data/trials.json" assert { type: "json" };

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// The patterns Aklima identified during her analysis. These give Claude
// curated priors so it can name patterns precisely instead of inventing them.
const PATTERN_LIBRARY = `
KNOWN FAILURE PATTERNS IN THIS DATABASE (use these names verbatim when they fit):

1. Phase 2 → Phase 3 effect-size collapse
   Trial advanced on a Phase 2 result that was borderline (p ≈ 0.03–0.10), small,
   or compared against historical controls. The Phase 3 effect was substantially
   smaller or absent. Examples in DB: CENTRIC, ACT IV, INTELLANCE-1 (advanced
   on INTELLANCE-2 p=0.06). HIGH SEVERITY when user's Phase 2 evidence is
   borderline / historical / single-arm.

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
   Phase 2 looked good against an outdated historical OS benchmark (e.g., 16 mo
   from older Stupp data). By Phase 3 readout, contemporary control arms have
   improved (better surgery, MGMT selection, supportive care), erasing the
   apparent benefit. Examples in DB: ACT IV. MEDIUM SEVERITY when Phase 2
   compared to literature controls without contemporary calibration.

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
   MEDIUM SEVERITY when drug PK does not match dosing schedule.

9. Drug-class repeat failure
   The proposed mechanism class has multiple prior Phase 3 failures in the
   indication for related reasons. Use this when 2+ trials in the same class
   appear in the database and have failed.

POSITIVE COMPARATORS (in DB, succeeded):
   Stupp 2005 (TMZ + RT), EF-14 (TTFields device), CeTeG (lomustine + TMZ in
   MGMT-methylated). Use these as contrast — what successful approaches share.
`;

const SYSTEM_PROMPT = `You are a senior clinical research analyst conducting pre-mortem analysis on proposed Phase 3 glioblastoma trials. You have access to a curated database of 21 historical GBM trials with full design and outcome data.

Your job: read the user's proposed trial design, compare it against the database, and identify which historical failures it most resembles and which failure patterns it is most likely to repeat.

GROUNDING RULES — these are non-negotiable:
- Every claim about a past trial must be grounded in the database fields you are given. Do not invent trial names, drug effects, p-values, or hazard ratios.
- When the database is thin for a given comparison (e.g., only one prior trial of a mechanism), explicitly say so rather than overclaiming.
- Quote specific numbers from the database when relevant (HRs, p-values, median OS) — they are the strongest evidence.
- Use the PATTERN_LIBRARY names verbatim. Do not invent new pattern names when an existing one fits.
- If the user's design is genuinely novel (no good comparators in the database), say so directly.
- Distinguish "high risk because the database has many similar failures" from "uncertain because the database is small."

TONE:
- Direct, clinical, evidence-anchored. Like a senior MSL or clinical pharmacology reviewer.
- No hedging filler ("it might possibly be the case that…"). State the evidence and the conclusion.
- No emojis. No marketing language. No promises about success — only flags about specific risks.

OUTPUT FORMAT:
You MUST return a single valid JSON object with exactly this shape. No prose before or after. No markdown code fences.

{
  "risk_rating": "HIGH" | "MEDIUM" | "LOW",
  "verdict_summary": "One sentence (max 30 words). The headline conclusion.",
  "patterns_flagged": [
    {
      "name": "Pattern name from PATTERN_LIBRARY",
      "severity": "HIGH" | "MEDIUM" | "LOW",
      "evidence_strength": "e.g. '3 of 3 anti-angiogenic trials in DB' or '2 prior failures, narrow basis'",
      "explanation": "2-4 sentences. What the pattern is, why it applies to this design, what specifically goes wrong. Reference specific trial names and numbers from the DB."
    }
  ],
  "similar_trials": [
    {
      "name": "Trial name as it appears in the DB",
      "year": "Year readout (string)",
      "outcome": "FAILED" | "SUCCEEDED" | "MIXED",
      "outcome_stats": "Compact stats line, e.g. 'mOS 26.3 vs 26.3 mo · HR 1.02 · p=0.86'",
      "match_reasoning": "2-3 sentences. Why this trial is the most relevant comparator. Be specific — what features match (mechanism, setting, biomarker, endpoint, Phase 2 evidence quality)."
    }
  ],
  "recommendations": [
    "Concrete, actionable recommendation. 1-2 sentences each. 3-5 total."
  ]
}

CALIBRATION:
- HIGH risk: design matches 2+ failure patterns OR has a single pattern with strong evidence (3+ similar prior failures).
- MEDIUM risk: 1 pattern flagged, or thin database evidence in a concerning direction.
- LOW risk: design avoids known failure patterns; resembles successful trials more than failed ones.

Return up to 4 patterns_flagged (only include real ones), exactly 3 similar_trials, and 3-5 recommendations.`;

export default async function handler(req, res) {
  // CORS / method
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: "ANTHROPIC_API_KEY not configured. Set it in Vercel project settings → Environment Variables.",
    });
  }

  try {
    const { drug, mechanism, target_class, setting, biomarker, endpoint, phase2, context } = req.body || {};

    if (!drug || !mechanism || !target_class || !setting || !biomarker || !endpoint || !phase2) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    const userMessage = `PROPOSED TRIAL DESIGN
======================
Drug / intervention: ${drug}
Mechanism of action: ${mechanism}
Target class: ${target_class}
Setting: ${setting}
Biomarker enrichment: ${biomarker}
Primary endpoint: ${endpoint}
Phase 2 evidence strength: ${phase2}
Additional context: ${context || "(none provided)"}

DATABASE — 21 GBM TRIALS
=========================
${JSON.stringify(trials, null, 2)}

${PATTERN_LIBRARY}

Now produce the JSON pre-mortem analysis as specified in your instructions.`;

    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2500,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    // Extract text content
    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    // Parse the JSON Claude returned
    let parsed;
    try {
      // Strip any accidental markdown code fences
      const cleaned = text
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
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
