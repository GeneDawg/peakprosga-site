// Builds the Peak 301 estimate and invoice for a job from the EagleView square count,
// and updates Eddie's labor amount ($20/sq) on his task. Records are created as Draft; sending stays manual.
// The estimate is addressed to the contractor (they hire GDRR as their subcontractor) and uses the JobNimbus
// estimate template set in PORTAL_ESTIMATE_TEMPLATE_ID (or the contractor's own estimateTemplateId), so the
// template's terms of service and signature block come with it. The invoice is Net 5 by default (PORTAL_NET_DAYS).
import { accounts, env, HttpError, jn, jnAll } from "./portal.mts";

const JN_BASE = "https://app.jobnimbus.com/api1";
// Price list item "Peak 301 Referral Partner Install": $84/SQ = $64 material line (cost $14) + $20 labor (cost $20).
const PRODUCT_NAME = Netlify.env.get("PORTAL_PRODUCT_NAME") || "Peak 301 Referral Partner Install";
const FALLBACK = { material: { cost: 14, price: 64 }, labor: { cost: 20, price: 20 } };
const LABOR_PER_SQ = Number(Netlify.env.get("PORTAL_LABOR_PER_SQ") || 20);
const NET_DAYS = Number(Netlify.env.get("PORTAL_NET_DAYS") || 5);

async function jnWrite(method: "POST" | "PUT", path: string, body: unknown): Promise<any> {
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

const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const round2 = (n: number) => Math.round(n * 100) / 100;

export async function buildEstimateAndInvoice(jobId: string, squares: number) {
  if (!(squares > 0 && squares < 1000)) throw new HttpError(400, "Enter the EagleView square count (for example 24.6).");
  const sq = round2(squares);
  const job = await jn(`/jobs/${encodeURIComponent(jobId)}`);
  if (!job?.jnid) throw new HttpError(404, "Job not found in JobNimbus.");
  const products = await jnAll("/v2/products", {}, 5).catch(() => [] as any[]);
  const product = products.find((p: any) => p.name === PRODUCT_NAME && p.is_active !== false);
  const unit = product?.uoms?.find((u: any) => u.uom === "SQ") || product?.uoms?.[0] || FALLBACK;
  const mat = { cost: Number(unit.material?.cost ?? 14), price: Number(unit.material?.price ?? 64) };
  const lab = { cost: Number(unit.labor?.cost ?? 20), price: Number(unit.labor?.price ?? 20) };
  const PRICE_PER_SQ = mat.price + lab.price;

  // Contractor first (they sign and pay), then the homeowner for reference.
  const acct = accounts().find((a) => a.contactId && (job.related || []).some((r: any) => r.id === a.contactId));
  const related: any[] = [{ id: job.jnid, type: "job", name: job.name }];
  if (acct?.contactId) related.push({ id: acct.contactId, type: "contact", name: acct.name });
  if (job.primary?.id && job.primary.id !== acct?.contactId) related.push({ id: job.primary.id, type: "contact", name: job.primary.name });
  const estimateTemplate = acct?.estimateTemplateId || Netlify.env.get("PORTAL_ESTIMATE_TEMPLATE_ID") || undefined;
  const invoiceTemplate = acct?.invoiceTemplateId || Netlify.env.get("PORTAL_INVOICE_TEMPLATE_ID") || undefined;
  const amount = round2(sq * PRICE_PER_SQ);
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
  const now = Math.floor(Date.now() / 1000);
  const common = {
    related,
    items: [item],
    sections: [],
    subtotal: amount,
    total: amount,
    cost: costTotal,
    margin: amount ? round2(((amount - costTotal) / amount) * 100) : 0,
    tax: 0,
    sales_rep: job.sales_rep || undefined,
    owners: job.owners || undefined,
  };

  const estimate = await jnWrite("POST", "/v2/estimates", { ...common, date_estimate: now, status: 1, template_id: estimateTemplate });
  const invoice = await jnWrite("POST", "/v2/invoices", {
    ...common, date_invoice: now, date_due: now + NET_DAYS * 86400, terms: NET_DAYS, status: 1, template_id: invoiceTemplate,
  });

  // Update Eddie's task with the confirmed labor.
  const labor = round2(sq * LABOR_PER_SQ);
  let eddieUpdated = false;
  try {
    const tasks = await jn("/tasks", { size: "50", filter: JSON.stringify({ must: [{ term: { "related.id": job.jnid } }] }) });
    for (const t of tasks.results || tasks.activity || []) {
      if (!/eddie/i.test(String(t.title || ""))) continue;
      await jnWrite("PUT", `/tasks/${t.jnid}`, {
        description: `${t.description || ""}\n\nEagleView confirmed: ${sq} sq. Labor: ${sq} × $${LABOR_PER_SQ} = ${money(labor)}. Job price: ${money(amount)} (invoice #${invoice.number ?? "—"}).`.trim(),
      });
      eddieUpdated = true;
    }
  } catch (e) {
    console.error("Eddie task update failed", e);
  }
  return { squares: sq, price: amount, cost: costTotal, product: product?.jnid || null, labor, contractor: acct?.name || null, netDays: NET_DAYS, estimateTemplate: estimateTemplate || null, estimate: { jnid: estimate.jnid, number: estimate.number }, invoice: { jnid: invoice.jnid, number: invoice.number }, eddieUpdated };
}
