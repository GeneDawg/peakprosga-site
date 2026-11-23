import type { Config } from "@netlify/functions";
import { handleError, HttpError, json, jn, jnAll, readSession } from "../lib/portal.mts";
import { measuredSquares, measurementFields } from "../lib/pipeline.mts";

// GDRR admin only. GET ?job=<JobNimbus job id> -> shows which measurement-looking fields the JobNimbus API returns for that job
// and what square count the automation would use. Read-only: changes nothing.
export default async (req: Request) => {
  try {
    const s = readSession(req);
    if (s.role !== "admin") throw new HttpError(403, "Admins only.");
    const q = new URL(req.url).searchParams;
    if (q.get("products")) {
      // Read-only: price-list items that matter for the estimate (wash, tune-up, Peak 301), as JobNimbus stores them.
      const all = await jnAll("/v2/products", {}, 5);
      const pick = all.filter((p: any) => /wash|tune|peak 301/i.test(String(p.name || "")));
      return json({ count: pick.length, products: pick.map((p: any) => ({ name: p.name, jnid: p.jnid, active: p.is_active, item_type: p.item_type, description: String(p.description || "").slice(0, 60), uoms: p.uoms })) });
    }
    const id = q.get("job");
    if (!id) throw new HttpError(400, "Add ?job=<job id>.");
    const job = await jn(`/jobs/${encodeURIComponent(id)}`);
    return json({ job: job?.name, number: job?.number, fieldsSeen: measurementFields(job), squaresWouldUse: measuredSquares(job) });
  } catch (e) {
    return handleError(e);
  }
};

export const config: Config = { path: "/api/portal/measure-test", method: "GET" };
