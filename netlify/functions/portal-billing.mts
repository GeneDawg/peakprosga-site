import type { Config } from "@netlify/functions";
import { handleError, HttpError, json, readSession } from "../lib/portal.mts";
import { buildEstimate } from "../lib/billing.mts";

// GDRR admin only. POST { job, squares } -> creates the Peak 301 estimate (Draft), updates Eddie's labor and gives Shadie the send-for-signature task.
// The invoice is created automatically when the job reaches Job Completed (see lib/pipeline.mts).
export default async (req: Request) => {
  try {
    const s = readSession(req);
    if (s.role !== "admin") throw new HttpError(403, "Admins only.");
    const { job, squares } = await req.json();
    if (!job) throw new HttpError(400, "Missing job.");
    return json(await buildEstimate(String(job), Number(squares)));
  } catch (e) {
    return handleError(e);
  }
};

export const config: Config = { path: "/api/portal/billing", method: "POST" };
