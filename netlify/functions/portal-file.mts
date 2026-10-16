import type { Config } from "@netlify/functions";
import { allowedAccounts, fileLink, handleError, HttpError, json, jobFiles, loadJobs, readSession } from "../lib/portal.mts";

// GET ?job=<jnid>&file=<file jnid> -> { url } a short-lived link to an invoice PDF, photo report or photo on that job.
// Only files on a job this session may see, and only those three kinds, are ever released.
export default async (req: Request) => {
  try {
    const session = readSession(req);
    const q = new URL(req.url).searchParams;
    const jnid = q.get("job"), fileId = q.get("file");
    if (!jnid || !fileId) throw new HttpError(400, "Missing job or file.");
    const { jobs } = await loadJobs(allowedAccounts(session, "all"));
    if (!jobs.some((j) => j.jnid === jnid)) throw new HttpError(404, "That job isn't on your account.");
    const files = await jobFiles(jnid);
    const ok = [...files.invoices, ...files.reports, ...files.photos].some((f) => f.id === fileId);
    if (!ok) throw new HttpError(404, "That file isn't available.");
    return json({ url: await fileLink(fileId) });
  } catch (e) {
    return handleError(e);
  }
};

export const config: Config = { path: "/api/portal/file", method: "GET" };
