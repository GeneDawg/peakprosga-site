import type { Config, Context } from "@netlify/functions";
import { accounts, env, handleError, HttpError, jn, jnAll, json, loadJobs } from "../lib/portal.mts";

// TEMPORARY setup check. Shows which JobNimbus fields come through for the partner jobs so the
// portal's date and invoice mapping can be confirmed. Protected by PORTAL_CHECK_TOKEN; delete after setup.
const pick = (o: any, keys: string[]) => Object.fromEntries(keys.filter((k) => k in (o || {})).map((k) => [k, o[k]]));

async function probe(path: string, params: Record<string, string> = {}) {
  try {
    const body = await jn(path, { size: "2", ...params });
    const rows = Array.isArray(body) ? body : body.results || body.files || body.items || [];
    return { ok: true, count: body.count ?? rows.length, topKeys: Object.keys(body || {}), rowKeys: rows[0] ? Object.keys(rows[0]) : [] };
  } catch (e: any) {
    return { ok: false, error: String(e.message || e).slice(0, 200) };
  }
}

export default async (req: Request, context: Context) => {
  try {
    const t = context.params.token;
    if (!t || t !== env("PORTAL_CHECK_TOKEN")) throw new HttpError(404, "Not found");
    const { jobs, raw } = await loadJobs(accounts());
    const recent = await jn("/jobs", { size: "40", sort_field: "date_created", sort_direction: "desc" });
    const recentRows = recent.results || [];
    const firstJob = raw.jobs[0] || recentRows[0];
    const out: any = {
      settings: { accounts: accounts().map((a) => ({ key: a.key, prefix: a.prefix })) },
      jobCount: recent.count,
      recentJobKeys: recentRows[0] ? Object.keys(recentRows[0]) : [],
      recentJobs: recentRows.map((j: any) => pick(j, ["name", "display_name", "number", "record_type_name", "status_name", "date_created"])),
      mapped: jobs,
      rawJobs: raw.jobs.map((j) =>
        pick(j, ["jnid", "name", "number", "status_name", "record_type_name", "date_created", "date_status_change", "date_start", "date_end", "address_line1", "city", "state_text", "zip", "primary", "related", "source_name"]),
      ),
      rawInvoices: raw.invoices.map((i) => ({
        keys: Object.keys(i),
        ...pick(i, ["jnid", "number", "status", "status_name", "total", "total_paid", "due", "date_invoice", "date_due", "date_paid_in_full", "date_status_change", "date_created", "related", "payments", "is_sent", "date_sent", "email_status", "url", "public_url", "payment_url", "link"]),
      })),
      probes: {
        payments: await probe("/payments"),
        files: await probe("/files"),
        filesForJob: firstJob ? await probe("/files", { filter: JSON.stringify({ must: [{ term: { "related.id": firstJob.jnid } }] }) }) : null,
        documents: await probe("/documents"),
        attachments: firstJob ? await probe(`/jobs/${firstJob.jnid}/files`) : null,
      },
    };
    if (firstJob) {
      try {
        const body = await jn("/files", { size: "50", filter: JSON.stringify({ must: [{ term: { "related.id": firstJob.jnid } }] }) });
        const rows = body.results || body.files || [];
        out.sampleFiles = rows.slice(0, 20).map((f: any) => pick(f, ["jnid", "filename", "content_type", "type", "record_type_name", "description", "size", "date_created", "url", "thumbnail_url", "preview_url", "is_private"]));
      } catch (e: any) {
        out.sampleFiles = String(e.message || e).slice(0, 200);
      }
    }
    return json(out);
  } catch (e) {
    return handleError(e);
  }
};

export const config: Config = { path: "/api/portal/check/:token", method: "GET" };
