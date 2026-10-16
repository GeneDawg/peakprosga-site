import type { Config } from "@netlify/functions";
import { allowedAccounts, handleError, json, loadJobs, readSession } from "../lib/portal.mts";

// GET ?account=<key|all> -> the jobs, invoices and warranty status this session may see.
export default async (req: Request) => {
  try {
    const session = readSession(req);
    const requested = new URL(req.url).searchParams.get("account");
    const accts = allowedAccounts(session, requested);
    const { jobs } = await loadJobs(accts, true);
    return json({ updated: new Date().toISOString(), jobs });
  } catch (e) {
    return handleError(e);
  }
};

export const config: Config = { path: "/api/portal/jobs", method: "GET" };
