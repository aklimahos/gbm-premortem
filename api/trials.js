// /api/trials.js
// Vercel serverless function — returns the trial database as JSON.
// Used by the front-end to render the "browse the database" section.

import fs from "fs";
import path from "path";

const trialsPath = path.join(process.cwd(), "data", "trials.json");
const trials = JSON.parse(fs.readFileSync(trialsPath, "utf-8"));

export default function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  // Cache for 1 hour at the edge; revalidate in background
  res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
  return res.status(200).json(trials);
}
