import type { Config } from "@netlify/functions";
import { handleError, HttpError, jn, jnAll, json, readSession } from "../lib/portal.mts";
import { createInvoiceFromEstimate } from "../lib/billing.mts";

// Admin only, TEST jobs only. POST { job, rate } -> creates the invoice for a job whose name starts with "TEST",
// with a Partner Rewards credit of `rate` dollars per square, so the credit line can be checked in JobNimbus.
export default async (req: Request) => {
  try {
    const s = readSession(req);
    if (s.role !== "admin") throw new HttpError(403, "Admins only.");
    const b = await req.json();
    const rate = Number(b.rate);
    if (!(rate > 0 && rate <= 10)) throw new HttpError(400, "Give a credit rate between 0 and 10.");
    const job = await jn(`/jobs/${encodeURIComponent(String(b.job || ""))}`);
    if (!job?.jnid) throw new HttpError(404, "Job not found.");
    if (!/^TEST\b/.test(String(job.name || ""))) throw new HttpError(400, "Only jobs named TEST can be used here.");
    const est = (await jnAll("/v2/estimates")).find(
      (e: any) => !e.is_archived && e.is_active !== false && (e.related || []).some((r: any) => r.id === job.jnid),
    );
    if (!est) throw new HttpError(409, "This TEST job has no estimate yet.");
    const inv = await createInvoiceFromEstimate(job, est, { rate, tier: "Silver", quarter: "TEST" });
    return json({ number: inv.number, total: inv.total, subtotal: inv.subtotal, items: (inv.items || []).map((i: any) => ({ name: i.name, quantity: i.quantity, price: i.price, amount: i.amount })) });
  } catch (e) {
    return handleError(e);
  }
};

export const config: Config = { path: "/api/portal/rewards-test", method: "POST" };
