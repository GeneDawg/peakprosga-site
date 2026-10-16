import { accounts, sessionFromToken } from "../lib/portal.mts";
import { createFromAssignment } from "../lib/intake.mts";

// Runs automatically every time a Netlify form on this site is submitted (Netlify signs these events).
// Only the contractor assignment form creates JobNimbus records.
// The form carries the partner's signed-in session (partner_token). A valid partner session decides which
// contractor the job belongs to. Without one, the job is still created so no lead is lost, but it is marked
// "CHECK -" and left unattached for Shadie to confirm.
export default async (req: Request) => {
  const body = await req.json().catch(() => null);
  const p = body?.payload;
  if (!p || p.form_name !== "PeakProsGA-Assignment") return new Response("ignored");
  if (Netlify.env.get("PORTAL_INTAKE_OFF") === "true") return new Response("intake turned off");
  const data = { ...(p.data || {}) };
  const token = String(data.partner_token || "");
  delete data.partner_token;
  const session = token ? sessionFromToken(token) : null;
  try {
    let result;
    if (session?.role === "partner") {
      const account = accounts().find((a) => a.key === session.key) || null;
      result = await createFromAssignment(data, { account });
    } else if (session?.role === "admin") {
      result = await createFromAssignment(data); // GDRR staff entering a job: match by company/email
    } else {
      result = await createFromAssignment(data, { unverified: true });
    }
    console.log("assignment created in JobNimbus", JSON.stringify({ ...result, verified: !!session }));
    return new Response("ok");
  } catch (e) {
    console.error("assignment intake failed", e);
    return new Response("failed", { status: 500 });
  }
};
