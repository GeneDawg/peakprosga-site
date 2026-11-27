// Internal staff notifications (Gene + Shadie). Never emails customers or partners.
// Off until both are set in Netlify env:
//   RESEND_API_KEY        - key from resend.com (sending domain verified there)
//   PORTAL_NOTIFY_EMAILS  - comma list, e.g. "gene@godawgsroofroof.com,shadie@godawgsroofroof.com"
//   PORTAL_NOTIFY_FROM    - optional, default "Peak Pros GA Portal <portal@peakprosga.com>"
// Recipients must be on our own domains; anything else is dropped.
const INTERNAL = /@(godawgsroofroof\.com|peakprosga\.com|peakprosusa\.com|peak301pros\.com)$/i;

export function staffRecipients(): string[] {
  return String(Netlify.env.get("PORTAL_NOTIFY_EMAILS") || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => INTERNAL.test(s));
}

export async function notifyStaff(subject: string, text: string): Promise<boolean> {
  const key = Netlify.env.get("RESEND_API_KEY");
  const to = staffRecipients();
  if (!key || !to.length) return false;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: Netlify.env.get("PORTAL_NOTIFY_FROM") || "Peak Pros GA Portal <portal@peakprosga.com>", to, subject, text }),
  });
  if (!res.ok) console.error("notifyStaff failed", res.status, await res.text().catch(() => ""));
  return res.ok;
}
