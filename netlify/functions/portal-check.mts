import type { Config, Context } from "@netlify/functions";
import { accounts, env, handleError, HttpError, jn, jnAll, jobFiles, json, loadJobs } from "../lib/portal.mts";
import { createFromAssignment, matchContractor, summarize } from "../lib/intake.mts";
import { buildEstimate } from "../lib/billing.mts";
import { runPipeline } from "../lib/pipeline.mts";

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
    // Workflow statuses: ?workflow=1 lists the Peak 301 Referral workflow's statuses as plain text.
    if (new URL(req.url).searchParams.get("workflow")) {
      const lines: string[] = [];
      try {
        const s = await jn("/account/settings");
        const wfs = s.workflows || s.job_workflows || [];
        lines.push("settingsKeys=" + Object.keys(s || {}).join(","));
        for (const w of wfs) {
          if (!/peak|referral/i.test(w.name || "")) continue;
          lines.push(`WORKFLOW ${w.name} (${w.object_type || w.type || ""}) id=${w.id}`);
          for (const st of w.status || w.statuses || []) lines.push(`  ${st.order ?? ""} ${st.name} | stage=${st.stage ?? st.stage_name ?? ""} | active=${st.is_active ?? ""} | id=${st.id}`);
        }
      } catch (e: any) { lines.push("settings error " + String(e.message || e).slice(0, 150)); }
      const jobs = await jnAll("/jobs", {}, 3);
      const seen = new Map<string, number>();
      for (const j of jobs) if (/peak 301 referral/i.test(j.record_type_name || "")) seen.set(j.status_name, (seen.get(j.status_name) || 0) + 1);
      lines.push("statuses in use: " + [...seen].map(([k, v]) => `${k}(${v})`).join(", "));
      return new Response(lines.join("\n"), { headers: { "content-type": "text/plain" } });
    }
    // Test cleanup: close the four TEST tasks and archive the two TEST homeowner contacts.
    if (new URL(req.url).searchParams.get("cleanup")) {
      const key = Netlify.env.get("JOBNIMBUS_WRITE_KEY") || env("JOBNIMBUS_API_KEY");
      const put = async (path: string, body: unknown) => {
        const r = await fetch("https://app.jobnimbus.com/api1" + path, { method: "PUT", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
        return { path, status: r.status, body: (await r.text()).slice(0, 160) };
      };
      const out: any[] = [];
      for (const t of ["mvab3z2p26tw9tsvq9erp1c", "mvab3z60n70axv0k5fofaju", "mvacboo3cy8qi00x43zdeg3", "mvacborjwyvehxd4chjj3ac"]) out.push(await put(`/tasks/${t}`, { is_completed: true }));
      for (const c of ["mvab3yxjuj1hprw2icvoqoo", "mvacbo944kt7pt5ioiva493"]) out.push(await put(`/contacts/${c}`, { is_active: false }));
      for (const j of ["mvab3z0ne1j3zm6tiemalju", "mvacboeny3dtpwinm8crjgh"]) { try { const x = await jn(`/jobs/${j}`); out.push({ job: x.number, is_active: x.is_active, is_archived: x.is_archived }); } catch (e: any) { out.push({ job: j, gone: String(e.message || e).slice(0, 80) }); } }
      const { jobs } = await loadJobs(accounts());
      return json({ out, portalJobs: jobs.map((j: any) => j.title || j.name || j.homeowner || j.id) });
    }
    // Price list: ?product=show prints the Referral Install product's units; ?product=create adds the $84/SQ partner install.
    const productMode = new URL(req.url).searchParams.get("product");
    if (productMode) {
      const prods = await jnAll("/v2/products", {}, 5);
      const flat = (o: any, p = ""): string[] => o && typeof o === "object" ? Object.entries(o).flatMap(([k, v]) => flat(v, p ? `${p}.${k}` : k)) : [`${p}=${JSON.stringify(o)}`];
      const src = prods.find((p: any) => p.name === "Peak 301 Referral Install");
      const existing = prods.find((p: any) => p.name === "Peak 301 Referral Partner Install");
      if (productMode === "show") return new Response([...flat(src?.uoms), "item_type=" + src?.item_type, "existing=" + (existing?.jnid || "none")].join("\n"), { headers: { "content-type": "text/plain" } });
      if (productMode === "reprice" && existing) {
        const matPrice = Number(new URL(req.url).searchParams.get("mat"));
        if (!(matPrice > 0)) throw new HttpError(400, "mat required");
        const uoms = existing.uoms.map((u: any) => ({ ...u, material: { ...u.material, price: matPrice } }));
        const key = Netlify.env.get("JOBNIMBUS_WRITE_KEY") || env("JOBNIMBUS_API_KEY");
        const r = await fetch(`https://app.jobnimbus.com/api1/v2/products/${existing.jnid}`, { method: "PUT", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ ...existing, uoms }) });
        const t = await r.text();
        let after: string[] = [];
        try { after = flat(JSON.parse(t).uoms); } catch {}
        return new Response([`status=${r.status}`, ...after, t.slice(0, 200)].join("\n"), { headers: { "content-type": "text/plain" } });
      }
      if (productMode === "create") {
        if (existing) return json({ already: existing.jnid });
        const body = JSON.parse(JSON.stringify(src));
        for (const k of ["jnid", "id", "date_created", "date_updated", "created_by", "created_by_name", "customer", "type", "recid", "number"]) delete body[k];
        body.name = "Peak 301 Referral Partner Install";
        body.description = "Peak 301 roof rejuvenation installed by Go Dawgs Roof Roof as subcontractor for a Peak 301 referral partner. Priced per square from the EagleView measurement.";
        body.item_type = src.item_type;
        body.uoms = [{ ...src.uoms[0], uom: "SQ", material: { ...(src.uoms[0].material || {}), cost: 14, price: 64 }, labor: { ...(src.uoms[0].labor || {}), cost: 20, price: 20 } }];
        const key = Netlify.env.get("JOBNIMBUS_WRITE_KEY") || env("JOBNIMBUS_API_KEY");
        const r = await fetch("https://app.jobnimbus.com/api1/v2/products", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const created = await r.text();
        let after: string[] = [];
        try { after = flat(JSON.parse(created).uoms); } catch {}
        return new Response([`status=${r.status}`, ...after, created.slice(0, 300)].join("\n"), { headers: { "content-type": "text/plain" } });
      }
    }
    // Test helper: ?move=<job jnid>&to=<status> moves a TEST job only (stands in for Eddie dragging the card).
    const moveJob = new URL(req.url).searchParams.get("move");
    if (moveJob) {
      const job = await jn(`/jobs/${moveJob}`);
      if (!/^TEST - /.test(job.name || "")) throw new HttpError(400, "Only TEST jobs can be moved here.");
      const { setStatus } = await import("../lib/billing.mts");
      await setStatus(job, String(new URL(req.url).searchParams.get("to")));
      const after = await jn(`/jobs/${moveJob}`);
      return json({ job: after.number, status: after.status_name });
    }
    // Test helper: ?cleanjob=<job jnid> completes a TEST job's tasks and archives its TEST homeowner contact.
    const cleanJob = new URL(req.url).searchParams.get("cleanjob");
    if (cleanJob) {
      const job = await jn(`/jobs/${cleanJob}`);
      if (!/^TEST - /.test(job.name || "")) throw new HttpError(400, "Only TEST jobs can be cleaned here.");
      const { jobTasks, jnWrite } = await import("../lib/billing.mts");
      const out: string[] = [];
      for (const t of await jobTasks(job.jnid)) { await jnWrite("PUT", `/tasks/${t.jnid}`, { is_completed: true }); out.push(`task done: ${t.title}`); }
      if (job.primary?.id && /^TEST - /.test(job.primary.name || "")) { await jnWrite("PUT", `/contacts/${job.primary.id}`, { is_active: false }); out.push(`contact archived: ${job.primary.name}`); }
      return json({ job: job.number, out });
    }
    // ?estimate=<number> prints that estimate's fields (no items) as plain text, to find how layouts are referenced.
    const estNo = new URL(req.url).searchParams.get("estimate");
    if (estNo) {
      const all = await jnAll("/v2/estimates", {}, 5);
      const e = all.find((x: any) => String(x.number) === estNo);
      if (!e) throw new HttpError(404, "no such estimate");
      const lines = Object.entries(e).filter(([k]) => !["items", "sections", "related", "owners"].includes(k)).map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 120)}`);
      return new Response(lines.join("\n"), { headers: { "content-type": "text/plain" } });
    }
    // Board automation: ?pipeline=dry shows what would move; ?pipeline=run does it.
    const pipe = new URL(req.url).searchParams.get("pipeline");
    if (pipe) return json(await runPipeline({ dry: pipe !== "run" }));
    const billJob = new URL(req.url).searchParams.get("bill");
    if (billJob) return json(await buildEstimate(billJob, Number(new URL(req.url).searchParams.get("sq"))));
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
