import type { Config } from "@netlify/functions";
import { handleError, HttpError, json, jn, readSession } from "../lib/portal.mts";
import { measuredSquares, measurementFields } from "../lib/pipeline.mts";

// GDRR admin only. GET ?job=<JobNimbus job id> -> shows which measurement-looking fields the JobNimbus API returns for that job
// and what square count the automation would use. Read-only: changes nothing.
export default async (req: Request) => {
  try {
    const s = readSession(req);
    if (s.role !== "admin") throw new HttpError(403, "Admins only.");
    const id = new URL(req.url).searchParams.get("job");
    if (!id) throw new HttpError(400, "Add ?job=<job id>.");
    const job = await jn(`/jobs/${encodeURIComponent(id)}`);
    return json({ job: job?.name, number: job?.number, fieldsSeen: measurementFields(job), squaresWouldUse: measuredSquares(job) });
  } catch (e) {
    return handleError(e);
  }
};

export const config: Config = { path: "/api/portal/measure-test", method: "GET" };
