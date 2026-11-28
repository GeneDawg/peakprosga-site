import type { Config } from "@netlify/functions";
import { jnAll } from "../lib/portal.mts";
import { buildEstimate, money } from "../lib/billing.mts";
import { notifyStaff } from "../lib/notify.mts";
import { matchJobs, parseSubject, verifySvix } from "../lib/eagleview.mts";

// Resend "email.received" webhook. A Gmail filter forwards each EagleView "Report" email to the Resend receiving
// address; this builds the draft estimate on the matching Peak 301 Referral job (status Assigned, no estimate yet).
// Nothing is ever sent to a contractor from here: buildEstimate only drafts it and notifies Gene + Shadie.
// Needs RESEND_WEBHOOK_SECRET (the webhook's signing secret, whsec_...). PORTAL_EV_INBOUND_OFF=true turns it off.
export default async (req: Request) => {
  const secret = Netlify.env.get("RESEND_WEBHOOK_SECRET") || "";
  if (!secret || Netlify.env.get("PORTAL_EV_INBOUND_OFF") === "true") return new Response("off", { status: 503 });
  const raw = await req.text();
  if (!verifySvix(secret, req.headers, raw)) return new Response("bad signature", { status: 401 });
  const evt = JSON.parse(raw || "{}");
  if (evt.type !== "email.received") return new Response("ignored");
  const subject = String(evt.data?.subject || "");

  // Gmail sends a confirmation code here when the forwarding address is first added. Pass it to Gene.
  if (/forwarding confirmation/i.test(subject)) {
    await notifyStaff(`Gmail forwarding code: ${subject}`, `Gmail sent a forwarding confirmation to the EagleView inbox.\nSubject: ${subject}\nThe confirmation code is the number at the start of the subject. Enter it in Gmail > Settings > Forwarding.`).catch(() => {});
    return new Response("forwarding code passed on");
  }

  const report = parseSubject(subject);
  if (!report) return new Response("not an EagleView report");

  const jobs = (await jnAll("/jobs", { sort_field: "date_created", sort_direction: "desc" }, 5)).filter(
    (j: any) => !j.is_archived && j.is_active !== false && /peak 301 referral/i.test(String(j.record_type_name || "")),
  );
  const open = matchJobs(jobs, report.address).filter((j: any) => /^assigned$/i.test(String(j.status_name || "")));
  const tell = (title: string, body: string) => notifyStaff(title, `${body}\n\nEagleView report ${report.reportId}: ${report.address}, ${report.squares} squares.`).catch(() => {});

  if (open.length !== 1) {
    await tell(
      `EagleView report needs a hand: ${report.address}`,
      open.length
        ? `More than one referral job matches this address (${open.map((j: any) => "#" + j.number).join(", ")}). Build the estimate from the admin screen.`
        : `No referral job in Assigned matches this address. Check the job's address or status, then build the estimate from the admin screen.`,
    );
    return new Response("no single match");
  }
  try {
    const r = await buildEstimate(open[0].jnid, report.squares);
    console.log("eagleview estimate built", report.reportId, r.estimate?.number, money(r.price));
    return new Response("estimate built");
  } catch (e: any) {
    if (e?.status === 409 && /already has estimate/i.test(String(e?.message))) return new Response("estimate already exists");
    await tell(`EagleView report: estimate not built for ${report.address}`, `The estimate could not be built automatically: ${e?.message || e}. Build it from the admin screen.`);
    return new Response("build failed");
  }
};

export const config: Config = { path: "/api/eagleview-inbound", method: "POST" };
