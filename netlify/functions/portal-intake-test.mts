import type { Config } from "@netlify/functions";
import { handleError, HttpError, json, readSession } from "../lib/portal.mts";
import { createFromAssignment, matchContractor, parseAddress, summarize } from "../lib/intake.mts";

// GDRR admin only. POST an assignment shaped like the website form.
// ?dry=1 shows what would be created without touching JobNimbus; otherwise creates records marked "TEST - ".
export default async (req: Request) => {
  try {
    const s = readSession(req);
    if (s.role !== "admin") throw new HttpError(403, "Admins only.");
    const a = await req.json();
    if (new URL(req.url).searchParams.get("dry")) {
      const acct = matchContractor(a);
      return json({ contractor: acct?.name || null, address: parseAddress(a.property_address || ""), ...summarize(a, acct) });
    }
    return json(await createFromAssignment(a, { test: true }));
  } catch (e) {
    return handleError(e);
  }
};

export const config: Config = { path: "/api/portal/intake-test", method: "POST" };
