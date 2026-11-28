// EagleView report emails -> draft estimate on the matching Peak 301 Referral job.
// EagleView's delivery subject carries everything we need, e.g.
//   "EagleView Report 74332507 - 3263 Heatherwood Drive, Gainesville, GA (Bid Perfect™, $18.00, 29.6 squares)"
// so the webhook payload's subject is enough: no email body, no extra API permission.
import { createHmac, timingSafeEqual } from "node:crypto";

export type ParsedReport = { reportId: string; address: string; squares: number };

export function parseSubject(subject: string): ParsedReport | null {
  const s = String(subject || "").replace(/^(fwd?|fw):\s*/i, "");
  const m = s.match(/EagleView Report\s+(\d+)\s*-\s*(.+?)\s*\(([^)]*?)([\d.]+)\s*squares?\s*\)/i);
  if (!m) return null;
  const squares = Number(m[4]);
  if (!(squares > 0)) return null;
  return { reportId: m[1], address: m[2].trim(), squares };
}

const norm = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** House number + first word of the street name, e.g. "3263 heatherwood". */
export function addressKey(address: string): string | null {
  const m = norm(address).match(/^(\d+[a-z]?)\s+([a-z0-9]+)/);
  if (!m) return null;
  const skip = new Set(["n", "s", "e", "w", "ne", "nw", "se", "sw", "north", "south", "east", "west", "old"]);
  const words = norm(address).split(" ").slice(1);
  const street = words.find((w) => !skip.has(w)) || m[2];
  return `${m[1]} ${street}`;
}

/** Jobs whose name or address line starts with the same house number and street word. */
export function matchJobs(jobs: any[], address: string): any[] {
  const key = addressKey(address);
  if (!key) return [];
  return jobs.filter((j) => [j.address_line1, j.name].some((v) => addressKey(String(v || "").replace(/^(test|check)\s*-\s*/i, "")) === key));
}

/** Resend signs webhooks the Svix way: HMAC-SHA256 over "id.timestamp.body" with the base64 secret after "whsec_". */
export function verifySvix(secret: string, headers: Headers, body: string): boolean {
  // Resend signs with Svix. Newer deliveries may use the "webhook-*" header names instead of "svix-*"; accept both.
  const h = (n: string) => headers.get(`svix-${n}`) || headers.get(`webhook-${n}`);
  const id = h("id"), ts = h("timestamp"), sigs = h("signature");
  const clean = String(secret || "").trim().replace(/^whsec_/, "");
  if (!clean || !id || !ts || !sigs) {
    console.log("eagleview-inbound signature headers missing", { id: !!id, ts: !!ts, sig: !!sigs, secret: !!clean });
    return false;
  }
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) {
    console.log("eagleview-inbound timestamp outside window");
    return false;
  }
  const expected = createHmac("sha256", Buffer.from(clean, "base64")).update(`${id}.${ts}.${body}`).digest("base64");
  const ok = sigs.split(" ").some((part) => {
    const sig = part.split(",")[1] || "";
    return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  });
  if (!ok) console.log("eagleview-inbound signature mismatch (check RESEND_WEBHOOK_SECRET matches the webhook's signing secret)");
  return ok;
}
