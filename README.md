# GBM Trial Pre-Mortem

An AI-powered pre-mortem analysis tool for proposed Phase 3 glioblastoma trials. Compares a user's trial design against a hand-curated database of 21 historical GBM trials and surfaces failure patterns it is most likely to repeat.

Built by Aklima Hossain. Reasoning powered by Claude.

---

## What this does

1. User fills out a structured form describing a proposed GBM Phase 3 trial (drug, mechanism, target class, setting, biomarker, endpoint, Phase 2 evidence strength, free-text context).
2. A serverless function on Vercel receives the design, embeds it alongside the 21-trial database in a carefully engineered prompt, and sends it to Claude.
3. Claude returns structured JSON: a risk verdict, named failure patterns, the 3 most similar past trials, and concrete recommendations.
4. The frontend renders the analysis as a clinical research document.

The 21-trial database is embedded in `data/trials.json`. The pattern library Claude reasons over is in `api/analyze.js`.

---

## File structure

```
gbm-premortem/
├── public/
│   └── index.html        # Frontend (form + results display)
├── api/
│   └── analyze.js        # Vercel serverless function — calls Claude
├── data/
│   └── trials.json       # 21 trials, embedded as structured data
├── package.json          # Anthropic SDK dependency
├── vercel.json           # Vercel routing config
├── .gitignore
└── README.md             # this file
```

---

## Local setup (for testing on your laptop)

You need:
- Node.js 18 or higher
- An Anthropic API key (get one at https://console.anthropic.com/)

```bash
# 1. Install dependencies
npm install

# 2. Install Vercel CLI globally (one-time)
npm install -g vercel

# 3. Create a local environment file with your API key
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env.local
# (Replace with your real key. This file is gitignored — never commit it.)

# 4. Run the dev server
vercel dev
```

The app will be at `http://localhost:3000`. Submit a trial design and confirm the analysis comes back.

**Important:** the `.env.local` file is gitignored. Your API key never leaves your machine.

---

## Deploy to Vercel (the production path)

This gives you a real URL like `gbm-premortem.vercel.app` that anyone can visit.

### Step 1 — push the project to GitHub

```bash
cd gbm-premortem
git init
git add .
git commit -m "initial commit"
# Create a new GitHub repo via https://github.com/new
# Then:
git remote add origin https://github.com/YOUR_USERNAME/gbm-premortem.git
git branch -M main
git push -u origin main
```

### Step 2 — import to Vercel

1. Go to https://vercel.com/new
2. Sign in with GitHub
3. Pick the `gbm-premortem` repo, click **Import**
4. Vercel will auto-detect the project. Leave the build settings as default.
5. **Before deploying**, expand "Environment Variables" and add:
   - **Key:** `ANTHROPIC_API_KEY`
   - **Value:** `sk-ant-...` (your real key)
6. Click **Deploy**

In ~60 seconds you'll have a live URL.

### Step 3 — test it

Visit the URL Vercel gave you. Fill out the form. Submit. You should see a real Claude-generated analysis grounded in the 21-trial database.

---

## How the API key stays secure

The architecture is:

```
User's browser  →  /api/analyze on Vercel  →  Anthropic API
                       (holds the key)
```

The key lives only on Vercel's servers as an environment variable. The frontend never sees it. Even if someone views the page source, the key isn't there.

This is the same pattern any production AI app uses.

---

## Cost

Claude Sonnet 4.6 is $3 per million input tokens, $15 per million output tokens (as of April 2026 — verify at https://www.anthropic.com/pricing).

Each query in this tool sends ~5,000 input tokens (database + prompt + user input) and gets back ~1,500 output tokens. That's roughly:
- $0.015 input + $0.0225 output ≈ **$0.04 per query**

For a portfolio demo getting hundreds of queries, you'll spend a few dollars total. Set a usage limit in your Anthropic console for safety.

---

## Updating the trial database

To add a new trial or update an existing one:

1. Edit `data/trials.json` directly, OR
2. Re-run the spreadsheet-to-JSON converter (the original script that generated `trials.json` from the source `.xlsx`).

The fields the analysis depends on are:
- `name`, `year`, `drug`, `mechanism`, `target_class`, `setting`, `biomarker`
- `primary_endpoint`, `phase2_evidence`, `hypothesis`
- `mOS_int`, `mOS_ctrl`, `OS_HR`, `OS_p`, `OS_met`, `PFS_met`
- `sponsor_reason`, `analysis`, `notes`

Push the updated file to GitHub and Vercel will redeploy automatically.

---

## Known limitations

- **Database size.** 21 trials is enough to surface the dominant patterns but not enough for statistical confidence. Where the database is thin, the tool says so explicitly.
- **Some quantitative fields are still incomplete** for ~9 of the 21 trials (descriptive info is full, but HRs/p-values are missing). Filling these would strengthen the analysis.
- **Pattern library is hand-curated.** New failure modes that emerge in future GBM trials would need to be added manually to the `PATTERN_LIBRARY` constant in `api/analyze.js`.
- **Not a regulatory or statistical predictor.** This is a structured second-opinion tool, not a probability-of-success model.

---

## Tech stack

- **Frontend:** Vanilla HTML / CSS / JS (no framework — it's one page)
- **Hosting:** Vercel (free tier)
- **Serverless runtime:** Node.js 18+ on Vercel Functions
- **Model:** Claude Sonnet 4.6 via the Anthropic Messages API
- **SDK:** `@anthropic-ai/sdk`

No build step. No bundler. The HTML is served directly; the API function is called from the page.

---

## License

Database and analysis are author's original work. Underlying trial data is from peer-reviewed publications and ClinicalTrials.gov, all publicly available.
