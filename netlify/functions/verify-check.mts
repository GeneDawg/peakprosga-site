import type { Config, Context } from "@netlify/functions";
import { accounts, env, handleError, HttpError, jn, jnAll, loadJobs } from "../lib/portal.mts";

// TEMPORARY, preview-only and read-only: one line per partner job showing what the dashboard will show,
// plus the CompanyCam fields JobNimbus holds for each job. Never merged to the live site.
export default async (req: Request, context: Context) => {
  try {
    if (context.params.token !== env("PORTAL_CHECK_TOKEN")) throw new HttpError(404, "Not found");
    const { jobs, raw } = await loadJobs(accounts(), true);
    const lines: string[] = [];
    for (const j of jobs) {
      const r: any = raw.jobs.find((x: any) => x.jnid === j.jnid) || {};
      const cc = Object.entries(r).filter(([k]) => /companycam|company cam/i.test(k)).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
      let allFiles: any[] = [];
      try { allFiles = await jnAll("/files", { filter: JSON.stringify({ must: [{ term: { "related.id": j.jnid } }] }) }, 3); } catch {}
      const tally: Record<string, number> = {};
      for (const f of allFiles) { const k = `${f.record_type_name}${f.is_private ? "(private)" : ""}`; tally[k] = (tally[k] || 0) + 1; }
      lines.push([
        `#${j.number} ${j.owner}`, `acct=${j.account}`, `status=${j.status}`, `assigned=${j.assigned}`, `fulfilled=${j.fulfilled}`,
        `invoice=${j.invoice ? `${j.invoice.numbers.join("/")} total=${j.invoice.total} due=${j.invoice.due} paid=${j.invoice.isPaid} processing=${j.invoice.processing}` : "none"}`,
        `portal: photos=${j.files.photos.length} reports=${j.files.reports.length} invoicePdfs=${j.files.invoices.length}`,
        `warranty=${j.invoice?.isPaid ? "UNLOCKED" : "locked"}`,
        `jnFiles=${JSON.stringify(tally)}`, cc ? `companycam: ${cc}` : "companycam: none",
      ].join(" | "));
    }
    // Which job fields mention CompanyCam at all (field names only)
    const sample = raw.jobs[0] ? Object.keys(raw.jobs[0]).filter((k) => /cam|photo/i.test(k)) : [];
    lines.push(`fields with cam/photo in name: ${sample.join(", ") || "none"}`);
    return new Response(lines.join("\n"), { headers: { "content-type": "text/plain" } });
  } catch (e) {
    return handleError(e);
  }
};
export const config: Config = { path: "/api/verify/:token", method: "GET" };
