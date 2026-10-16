import type { Config } from "@netlify/functions";
import { runPipeline } from "../lib/pipeline.mts";

// Every 15 minutes: moves Peak 301 referral jobs along the JobNimbus board, creates invoices at Job Completed,
// and closes jobs once payment clears. Scheduled functions only run on the published site.
// Set PORTAL_PIPELINE_OFF=1 to pause.
export default async () => {
  if (Netlify.env.get("PORTAL_PIPELINE_OFF")) return;
  const out = await runPipeline();
  if (out.actions.length) console.log(JSON.stringify(out));
};

export const config: Config = { schedule: "*/15 * * * *" };
