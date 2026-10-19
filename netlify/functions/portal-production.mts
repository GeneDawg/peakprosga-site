import type { Config } from "@netlify/functions";
import { handleError, HttpError, jn, jnAll, json, readSession } from "../lib/portal.mts";
import { contractorFor } from "../lib/billing.mts";
import { handOffToSub, productionCheck, subMode } from "../lib/production.mts";

// GDRR admin only.
//   {action:"check", job?:"123"}  read-only: subcontractor contact, CompanyCam token, work order setup, the job's CompanyCam project
//   {action:"test",  job:"123", squares?: 20}  runs the subcontractor hand-off on ONE job whose name starts with "TEST -"
export default async (req: Request) => {
  try {
    const s = readSession(req);
    if (s.role !== "admin") throw new HttpError(403, "Admins only.");
    const b = await req.json().catch(() => ({}));
    if (b.action === "check") return json(await productionCheck(b.job ? String(b.job) : undefined));
    if (b.action === "test") {
      if (!subMode()) throw new HttpError(400, "Set PORTAL_SUB_NAME in Netlify first.");
      const r = await jn("/jobs", { size: "5", filter: JSON.stringify({ must: [{ term: { number: String(b.job || "") } }] }) });
      const job = (r?.results || r?.jobs || [])[0];
      if (!job) throw new HttpError(404, `Job #${b.job} not found.`);
      if (!/^TEST\s*-/i.test(job.name || "")) throw new HttpError(400, "For safety the test only runs on a job whose name starts with \"TEST -\".");
      const ests = await jnAll("/v2/estimates").catch(() => [] as any[]);
      const est = ests.find((e: any) => (e.related || []).some((x: any) => x.id === job.jnid)) || { number: "TEST" };
      const sq = Number(b.squares) || Number((est.items || []).find((i: any) => /sq/i.test(i.uom || ""))?.quantity) || 20;
      return json(await handOffToSub(job, est, sq, contractorFor(job)?.name || "TEST contractor"));
    }
    throw new HttpError(400, "Unknown action.");
  } catch (e) {
    return handleError(e);
  }
};

export const config: Config = { path: "/api/portal/production", method: "POST" };
