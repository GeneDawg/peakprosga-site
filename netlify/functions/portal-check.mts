import type { Config, Context } from "@netlify/functions";
import { accounts, env, handleError, HttpError, jn, jnAll, jobFiles, json, loadJobs } from "../lib/portal.mts";
import { createFromAssignment, matchContractor, summarize } from "../lib/intake.mts";
import { buildEstimateAndInvoice } from "../lib/billing.mts";

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
    if (new URL(req.url).searchParams.get("inspect")) {
      const out: any = {};
      const strip = (o: any, depth = 0): any => {
        if (Array.isArray(o)) return o.slice(0, 4).map((x) => strip(x, depth + 1));
        if (o && typeof o === "object") return Object.fromEntries(Object.entries(o).filter(([k]) => !/phone|email|card|account|routing|token|secret/i.test(k)).map(([k, v]) => [k, depth > 3 ? "…" : strip(v, depth + 1)]));
        return o;
      };
      const pays = await jn("/payments", { size: "3", sort_field: "date_created", sort_direction: "desc" });
      out.payment = strip((pays.results || [])[0]);
      const ests = await jn("/v2/estimates", { size: "3", sort_field: "date_created", sort_direction: "desc" });
      out.estimate = strip((ests.results || [])[0]);
      const invs = await jn("/v2/invoices", { size: "2", sort_field: "date_created", sort_direction: "desc" });
      out.invoice = strip((invs.results || [])[0]);
      const prods = await jnAll("/v2/products", {}, 5);
      out.products = prods.filter((p: any) => /peak|301|rejuv/i.test(JSON.stringify([p.name, p.description]))).map((p: any) => strip(p));
      out.productKeys = prods[0] ? Object.keys(prods[0]) : [];
      try { const tpl = await jn("/v2/estimates/templates", { size: "20" }); out.templates = strip(tpl); } catch (e: any) { out.templates = String(e.message || e).slice(0, 160); }
      return json(out);
    }
    const billJob = new URL(req.url).searchParams.get("bill");
    if (billJob) return json(await buildEstimateAndInvoice(billJob, Number(new URL(req.url).searchParams.get("sq"))));
    // Intake test: ?intake=dry shows the plan; ?intake=run creates one assignment marked "TEST - ".
    const intake = new URL(req.url).searchParams.get("intake");
    if (intake) {
      const sample: Record<string, string> = {
        company: "Peach Peak Roofing", contact_name: "Neil Embry", contact_phone: "470-585-5184", contact_email: "neal@peachpeakroofing.com",
        property_address: "100 Test Lane, Marietta, GA 30066", homeowner_name: "Test Homeowner", homeowner_phone: "404-323-1869",
        roof_size: "30", roof_age: "10–15 years", roof_type: "Asphalt Shingle (Architectural)", quoted_price: "$2,550",
        two_story: "No — single story", pitch: "No — standard pitch", damage: "No — roof in good condition",
        service_date: "", scope_notes: "TEST assignment from Claude. Archive this job and its two tasks.",
      };
      const q = new URL(req.url).searchParams;
      if (q.get("addr")) sample.property_address = q.get("addr")!;
      if (q.get("name")) sample.homeowner_name = q.get("name")!;
      if (q.get("size")) sample.roof_size = q.get("size")!;
      if (q.get("price")) sample.quoted_price = q.get("price")!;
      const acct = matchContractor(sample);
      if (intake === "dry") return json({ writeKeySet: !!Netlify.env.get("JOBNIMBUS_WRITE_KEY"), contractor: acct?.name || null, ...summarize(sample, acct) });
      if (intake === "run") return json({ created: await createFromAssignment(sample, { test: true }) });
    }
    const { jobs, raw } = await loadJobs(accounts());
    const recent = await jn("/jobs", { size: "40", sort_field: "date_created", sort_direction: "desc" });
    const recentRows = recent.results || [];
    const firstJob = raw.jobs[0] || recentRows[0];
    const out: any = {
      settings: { accounts: accounts().map((a) => ({ key: a.key, prefix: a.prefix })) },
      jobCount: recent.count,
      recentJobKeys: recentRows[0] ? Object.keys(recentRows[0]) : [],
      recentJobs: recentRows.slice(0, 5).map((j: any) => ({ ...pick(j, ["name", "number", "status_name", "date_created", "date_status_change", "date_start", "date_end"]), primaryName: j.primary?.name, relatedNames: (j.related || []).map((r: any) => r.name) })),
      mapped: jobs,
      rawJobs: raw.jobs.map((j) =>
        pick(j, ["jnid", "name", "number", "status_name", "record_type_name", "tags", "date_created", "date_status_change", "date_start", "date_end", "address_line1", "city", "state_text", "zip", "primary", "related", "source_name"]),
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
    // Invoice PDF probe: find invoice files on the partner jobs and test how JobNimbus serves them.
    out.invoiceFiles = [];
    for (const j of raw.jobs.slice(0, 3)) {
      for (const field of ["related.id", "primary.id"]) {
        try {
          const body = await jn("/files", { size: "50", filter: JSON.stringify({ must: [{ term: { [field]: j.jnid } }] }) });
          const rows = body.results || body.files || [];
          out.invoiceFiles.push({ job: j.name, field, count: body.count ?? rows.length, files: rows.slice(0, 8).map((f: any) => ({ keys: Object.keys(f), ...pick(f, ["jnid", "filename", "content_type", "type", "record_type", "record_type_name", "size", "url", "preview_url", "thumbnail_url", "is_private"]) })) });
        } catch (e: any) { out.invoiceFiles.push({ job: j.name, field, error: String(e.message || e).slice(0, 150) }); }
      }
    }
    const firstInv = out.invoiceFiles.flatMap((x: any) => x.files || []).find((f: any) => /invoice/i.test(f.filename || ""));
    if (firstInv) {
      out.downloadProbe = {};
      for (const path of [`/files/${firstInv.jnid}`, `/files/${firstInv.jnid}/download`, `/files/${firstInv.jnid}?download=true`]) {
        try {
          const url = "https://app.jobnimbus.com/api1" + path;
          const res = await fetch(url, { headers: { Authorization: `Bearer ${env("JOBNIMBUS_API_KEY")}` }, redirect: "manual" });
          const ct = res.headers.get("content-type") || "";
          const loc = res.headers.get("location");
          let preview: any = null;
          if (ct.includes("json")) { const b = await res.json(); preview = { keys: Object.keys(b), ...pick(b, ["url", "download_url", "preview_url", "filename", "content_type"]) }; }
          out.downloadProbe[path] = { status: res.status, contentType: ct, hasLocation: !!loc, locationHost: loc ? new URL(loc).host : null, preview };
        } catch (e: any) { out.downloadProbe[path] = String(e.message || e).slice(0, 150); }
      }
    }
    try { const u = await jn("/account/users"); out.users = (u.users || u || []).map((x: any) => ({ id: x.id || x.jnid, name: x.name || x.display_name || [x.first_name, x.last_name].join(" "), email: x.email })); } catch (e: any) { out.users = String(e.message || e).slice(0, 150); }
    try {
      const pays = await jn("/payments", { size: "8", sort_field: "date_created", sort_direction: "desc" });
      const rows = pays.results || pays.payments || [];
      out.recentPayments = { count: pays.count, keys: rows[0] ? Object.keys(rows[0]) : [], rows: rows.map((p: any) => ({ ...pick(p, ["jnid", "total", "credit", "refunded_amount", "reference", "method_name", "method", "source", "date_payment", "date_created", "status", "status_name", "invoices", "related", "primary", "is_active", "is_archived"]) })) };
    } catch (e: any) { out.recentPayments = String(e.message || e).slice(0, 200); }
    out.fileDebug = [];
    for (const j of raw.jobs.slice(0, 2)) {
      try {
        const rows = await jnAll("/files", { filter: JSON.stringify({ must: [{ term: { "related.id": j.jnid } }] }) }, 3);
        const tally: any = {};
        for (const f of rows) { const k = `${f.record_type_name}|private=${f.is_private}|active=${f.is_active}|archived=${f.is_archived}|${f.content_type}`; tally[k] = (tally[k] || 0) + 1; }
        out.fileDebug.push({ job: j.name, total: rows.length, tally, mapped: await jobFiles(j.jnid).then((x) => ({ invoices: x.invoices.length, reports: x.reports.length, photos: x.photos.length })) });
      } catch (e: any) { out.fileDebug.push({ job: j.name, error: String(e.message || e).slice(0, 200) }); }
    }
    return json(out);
  } catch (e) {
    return handleError(e);
  }
};

export const config: Config = { path: "/api/portal/check/:token", method: "GET" };
