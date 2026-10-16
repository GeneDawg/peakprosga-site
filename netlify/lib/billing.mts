// Peak 301 referral billing.
//   buildEstimate(job, squares): from the EagleView square count, creates the estimate (Draft) addressed to the contractor,
//     using the JobNimbus estimate template (terms of service + signature block), updates Eddie's labor on his task,
//     and gives Shadie a task to send it for signature.
//   createInvoiceFromEstimate(job, estimate): when the job reaches Job Completed, copies the estimate's lines into a
//     Net 5 invoice (PORTAL_NET_DAYS) addressed to the contractor. Sending stays a one-click step in JobNimbus.
import { accounts, env, HttpError, jn, jnAll, type Account } from "./portal.mts";

const JN_BASE = "https://app.jobnimbus.com/api1";
// Price list item "Peak 301 Referral Partner Install": $85/SQ = $65 material line (cost $14) + $20 labor (cost $20).
const PRODUCT_NAME = Netlify.env.get("PORTAL_PRODUCT_NAME") || "Peak 301 Referral Partner Install";
const FALLBACK = { material: { cost: 14, price: 65 }, labor: { cost: 20, price: 20 } };
export const LABOR_PER_SQ = Number(Netlify.env.get("PORTAL_LABOR_PER_SQ") || 20);
export const NET_DAYS = Number(Netlify.env.get("PORTAL_NET_DAYS") || 7);
export const USERS = { gene: "m9n0ajnc1wl1dlw1e01d8t6", eddie: "f51ac41fcfb54674950809f89d42766f" }; // Shadie works under Gene's login

export async function jnWrite(method: "POST" | "PUT", path: string, body: unknown): Promise<any> {
  const key = Netlify.env.get("JOBNIMBUS_WRITE_KEY") || env("JOBNIMBUS_API_KEY");
  const res = await fetch(JN_BASE + path, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(502, `JobNimbus ${method} ${path} failed (${res.status}): ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

export const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
export const round2 = (n: number) => Math.round(n * 100) / 100;
const now = () => Math.floor(Date.now() / 1000);

export function contractorFor(job: any): Account | undefined {
  return accounts().find((a) => a.contactId && (job.related || []).some((r: any) => r.id === a.contactId));
}

/** Contractor first (they sign and pay), then the homeowner for reference. */
function relatedFor(job: any, acct?: Account) {
  const related: any[] = [{ id: job.jnid, type: "job", name: job.name }];
  if (acct?.contactId) related.push({ id: acct.contactId, type: "contact", name: acct.name });
  if (job.primary?.id && job.primary.id !== acct?.contactId) related.push({ id: job.primary.id, type: "contact", name: job.primary.name });
  return related;
}

export async function jobTasks(jobId: string): Promise<any[]> {
  const tasks = await jn("/tasks", { size: "100", filter: JSON.stringify({ must: [{ term: { "related.id": jobId } }] }) });
  return tasks.results || tasks.activity || tasks.tasks || [];
}

/** Adds a task unless one with the same title already exists on the job. */
export async function addTask(job: any, title: string, description: string, owner: string, dueDays = 1) {
  const existing = await jobTasks(job.jnid).catch(() => []);
  if (existing.some((t: any) => String(t.title || "") === title)) return null;
  const t = now();
  return jnWrite("POST", "/tasks", {
    title, description, record_type_name: "Task", related: [{ id: job.jnid }], owners: [{ id: owner }], date_start: t, date_end: t + dueDays * 86400,
  });
}

export async function setStatus(job: any, status: string) {
  if (job.status_name === status) return false;
  await jnWrite("PUT", `/jobs/${job.jnid}`, { status_name: status });
  return true;
}

export async function buildEstimate(jobId: string, squares: number) {
  if (!(squares > 0 && squares < 1000)) throw new HttpError(400, "Enter the EagleView square count (for example 24.6).");
  const sq = round2(squares);
  const job = await jn(`/jobs/${encodeURIComponent(jobId)}`);
  if (!job?.jnid) throw new HttpError(404, "Job not found in JobNimbus.");
  const prior = (await jnAll("/v2/estimates").catch(() => [] as any[])).find(
    (e: any) => !e.is_archived && e.is_active !== false && !/void/i.test(String(e.status_name || "")) && (e.related || []).some((r: any) => r.id === job.jnid),
  );
  if (prior) throw new HttpError(409, `This job already has estimate #${prior.number}. Edit that one in JobNimbus, or void it first.`);
  const products = await jnAll("/v2/products", {}, 5).catch(() => [] as any[]);
  const product = products.find((p: any) => p.name === PRODUCT_NAME && p.is_active !== false);
  const unit = product?.uoms?.find((u: any) => u.uom === "SQ") || product?.uoms?.[0] || FALLBACK;
  const mat = { cost: Number(unit.material?.cost ?? 14), price: Number(unit.material?.price ?? 65) };
  const lab = { cost: Number(unit.labor?.cost ?? 20), price: Number(unit.labor?.price ?? 20) };

  const acct = contractorFor(job);
  const estimateTemplate = acct?.estimateTemplateId || Netlify.env.get("PORTAL_ESTIMATE_TEMPLATE_ID") || undefined;
  const amount = round2(sq * (mat.price + lab.price));
  const costTotal = round2(sq * (mat.cost + lab.cost));
  const item = {
    jnid: product?.jnid,
    name: product?.name || PRODUCT_NAME,
    description: product?.description || "Peak 301 roof rejuvenation installed by Go Dawgs Roof Roof as subcontractor for a Peak 301 referral partner.",
    item_type: "labor+material",
    uom: "SQ",
    quantity: sq,
    price: mat.price,
    cost: mat.cost,
    amount: round2(sq * mat.price),
    labor: { price: lab.price, cost: lab.cost, amount: round2(sq * lab.price) },
  };
  const estimate = await jnWrite("POST", "/v2/estimates", {
    related: relatedFor(job, acct),
    items: [item],
    sections: [],
    subtotal: amount,
    total: amount,
    cost: costTotal,
    margin: amount ? round2(((amount - costTotal) / amount) * 100) : 0,
    tax: 0,
    sales_rep: job.sales_rep || undefined,
    owners: job.owners || undefined,
    date_estimate: now(),
    status: 1,
    template_id: estimateTemplate,
  });

  // Eddie's task gets the confirmed labor.
  const labor = round2(sq * LABOR_PER_SQ);
  let eddieUpdated = false;
  try {
    for (const t of await jobTasks(job.jnid)) {
      if (!/eddie/i.test(String(t.title || ""))) continue;
      await jnWrite("PUT", `/tasks/${t.jnid}`, {
        description: `${t.description || ""}\n\nEagleView confirmed: ${sq} sq. Labor: ${sq} × $${LABOR_PER_SQ} = ${money(labor)}. Job price: ${money(amount)} (estimate #${estimate.number ?? "—"}). Wait for the contractor's signature before scheduling.`.trim(),
      });
      eddieUpdated = true;
    }
  } catch (e) {
    console.error("Eddie task update failed", e);
  }
  // Shadie: send it for signature.
  await addTask(
    job,
    `Shadie: send estimate #${estimate.number ?? ""} for signature - ${job.name}`,
    `Open estimate #${estimate.number ?? ""} on this job and click Send for signature to ${acct?.name || "the contractor"}${acct ? "" : " (CONTRACTOR NOT MATCHED - check the job's contacts)"}.\n${sq} sq × $${mat.price + lab.price} = ${money(amount)}. Net ${NET_DAYS} once invoiced.\nWhen they sign, the job moves to Scheduled automatically.`,
    USERS.gene,
  ).catch((e) => console.error("Shadie task failed", e));

  return { squares: sq, price: amount, cost: costTotal, labor, contractor: acct?.name || null, estimateTemplate: estimateTemplate || null, estimate: { jnid: estimate.jnid, number: estimate.number }, eddieUpdated };
}

/** Copies the job's estimate into a Net 5 invoice addressed to the contractor. */
export async function createInvoiceFromEstimate(job: any, estimate: any) {
  const acct = contractorFor(job);
  const t = now();
  const items = (estimate.items || []).map((i: any) => {
    const { lineId, ...rest } = i;
    return rest;
  });
  return jnWrite("POST", "/v2/invoices", {
    related: relatedFor(job, acct),
    items,
    sections: estimate.sections || [],
    subtotal: estimate.subtotal,
    total: estimate.total,
    cost: estimate.cost,
    margin: estimate.margin,
    tax: estimate.tax || 0,
    sales_rep: job.sales_rep || undefined,
    owners: job.owners || undefined,
    date_invoice: t,
    date_due: t + NET_DAYS * 86400,
    terms: NET_DAYS,
    status: 1,
    template_id: acct?.invoiceTemplateId || Netlify.env.get("PORTAL_INVOICE_TEMPLATE_ID") || undefined,
    note: `Estimate #${estimate.number ?? ""} signed by ${acct?.name || "the contractor"}. Payment due Net ${NET_DAYS}.`,
  });
}
