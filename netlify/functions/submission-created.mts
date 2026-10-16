import { createFromAssignment } from "../lib/intake.mts";

// Runs automatically every time a Netlify form on this site is submitted (Netlify signs these events).
// Only the contractor assignment form creates JobNimbus records.
export default async (req: Request) => {
  const body = await req.json().catch(() => null);
  const p = body?.payload;
  if (!p || p.form_name !== "PeakProsGA-Assignment") return new Response("ignored");
  if (Netlify.env.get("PORTAL_INTAKE_OFF") === "true") return new Response("intake turned off");
  try {
    const result = await createFromAssignment(p.data || {});
    console.log("assignment created in JobNimbus", JSON.stringify(result));
    return new Response("ok");
  } catch (e) {
    console.error("assignment intake failed", e);
    return new Response("failed", { status: 500 });
  }
};
