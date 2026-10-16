import type { Config } from "@netlify/functions";
import { handleError, HttpError, json, readSession } from "../lib/portal.mts";
import { buildEstimateAndInvoice } from "../lib/billing.mts";

// GDRR admin only. POST { job, squares } -> creates the Peak 301 estimate and invoice (Draft) and updates Eddie's labor.
export default async (req: Request) => {
  try {
    const s = readSession(req);
    if (s.role !== "admin") throw new HttpError(403, "Admins only.");
    const { job, squares } = await req.json();
    if (!job) throw new HttpError(400, "Missing job.");
    return json(await buildEstimateAndInvoice(String(job), Number(squares)));
  } catch (e) {
    return handleError(e);
  }
};

export const config: Config = { path: "/api/portal/billing", method: "POST" };
