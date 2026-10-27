import type { Config } from "@netlify/functions";
import { timingSafeEqual } from "node:crypto";

// National dashboard for Peak 301 Pros leadership (read only).
// GET ?state=GA|SC|FL|AZ|TX  with  Authorization: Bearer <national code>  -> that state's jobs.
// This function signs in to each state site with the same national code (a read-only role on each site) and merges the results.
const STATES = [
  { code: "GA", name: "Georgia", base: "https://peakprosga.com" },
  { code: "SC", name: "South Carolina", base: "https://peakprossc.com" },
  { code: "FL", name: "Florida", base: "https://peakprosfl.com" },
  { code: "AZ", name: "Arizona", base: "https://peakprosaz.com" },
  { code: "TX", name: "Texas", base: "https://peakproshouston.com" },
];

const canon = (c: string) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
function same(a: string, b: string) {
  const x = Buffer.from(canon(a)), y = Buffer.from(canon(b));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function loadState(s: (typeof STATES)[number], code: string) {
  const ctl = AbortSignal.timeout(9000);
  try {
    const lr = await fetch(`${s.base}/api/portal/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }), signal: ctl });
    const login: any = await lr.json().catch(() => ({}));
    if (!lr.ok || !login.token) return { ...s, ok: false, error: login.error || `Sign-in failed (${lr.status})`, jobs: [] };
    const jr = await fetch(`${s.base}/api/portal/jobs?account=all&lite=1`, { headers: { authorization: `Bearer ${login.token}` }, signal: ctl });
    const body: any = await jr.json().catch(() => ({}));
    if (!jr.ok) return { ...s, ok: false, error: body.error || `Could not load jobs (${jr.status})`, jobs: [] };
    const names = new Map<string, string>((login.accounts || []).map((a: any) => [a.key, a.name]));
    const jobs = (body.jobs || []).map((j: any) => ({
      state: s.code, contractor: names.get(j.account) || (j.account === "unassigned" ? "Needs review" : j.account), number: j.number, owner: j.owner,
      address: j.address, assigned: j.assigned, fulfilled: j.fulfilled,
      invoice: j.invoice ? { total: j.invoice.total, paid: j.invoice.paid, due: j.invoice.due, date: j.invoice.date, paidDate: j.invoice.paidDate, isPaid: j.invoice.isPaid } : null,
    }));
    return { ...s, ok: true, error: null, jobs };
  } catch (e: any) {
    return { ...s, ok: false, error: "Could not reach this state's site right now.", jobs: [] };
  }
}

export default async (req: Request) => {
  const nat = Netlify.env.get("PORTAL_NATIONAL_CODE");
  const code = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!nat || !same(code, nat)) {
    await new Promise((r) => setTimeout(r, 800));
    return json({ error: "That code didn't match. Check it and try again." }, 401);
  }
  // One state per request, so each state gets its own time budget; the page asks for all of them at once.
  const want = (new URL(req.url).searchParams.get("state") || "").toUpperCase();
  const st = STATES.find((x) => x.code === want);
  if (!st) return json({ ok: true, states: STATES.map((x) => ({ code: x.code, name: x.name })) });
  const { base, ...out } = await loadState(st, code);
  return json({ updated: new Date().toISOString(), ...out });
};

export const config: Config = { path: "/api/national", method: "GET" };
