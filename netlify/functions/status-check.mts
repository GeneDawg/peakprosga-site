import type { Config, Context } from "@netlify/functions";
import { env, handleError, HttpError, jnAll } from "../lib/portal.mts";

// TEMPORARY, preview-only: read-only invoice/payment status for given invoice numbers. Not merged to the live site.
export default async (req: Request, context: Context) => {
  try {
    if (context.params.token !== env("PORTAL_CHECK_TOKEN")) throw new HttpError(404, "Not found");
    const want = (new URL(req.url).searchParams.get("inv") || "").split(",").filter(Boolean);
    const invs = (await jnAll("/v2/invoices")).filter((i: any) => want.includes(String(i.number)));
    const pays = await jnAll("/payments");
    const lines = invs.map((i: any) => {
      const job = (i.related || []).find((r: any) => r.type === "job");
      const related = pays.filter((p: any) => (p.invoices || []).some((x: any) => x.invoice_id === i.jnid) || (p.related || []).some((r: any) => r.id === job?.id));
      return `#${i.number} | ${job?.name || ""} | status=${i.status_name} | total=${i.total} | paid=${i.total_paid} | due=${i.due} | paid_in_full=${i.date_paid_in_full ? new Date(i.date_paid_in_full * 1000).toISOString().slice(0, 10) : "no"} | payments=${related.map((p: any) => `${p.total}@${new Date((p.date_payment || p.date_created) * 1000).toISOString().slice(0, 10)}${p.invoices?.length ? "" : "(unapplied)"}`).join(";") || "none"}`;
    });
    return new Response(lines.join("\n") || "none", { headers: { "content-type": "text/plain" } });
  } catch (e) {
    return handleError(e);
  }
};
export const config: Config = { path: "/api/status/:token", method: "GET" };
