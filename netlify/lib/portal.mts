// Shared helpers for the Peak 301 referral partner portal.
// Secrets live only in Netlify environment variables, never in this repo:
//   JOBNIMBUS_API_KEY      JobNimbus API key (read access)
//   PORTAL_ACCOUNTS        JSON list of partner accounts: [{key,name,prefix,contact,code}]
//   PORTAL_ADMIN_CODE      GDRR admin access code (sees every partner)
//   PORTAL_SESSION_SECRET  random string used to sign sign-in sessions
import { createHmac, timingSafeEqual } from "node:crypto";

const JN_BASE = "https://app.jobnimbus.com/api1";
const SESSION_HOURS = 12;

export type Account = { key: string; name: string; prefix: string; contact?: string; code: string };
export type Session = { role: "admin" | "partner"; key?: string; exp: number };

export function env(name: string): string {
  const v = Netlify.env.get(name);
  if (!v) throw new HttpError(500, `The portal is missing its ${name} setting.`);
  return v;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export function handleError(e: unknown): Response {
  if (e instanceof HttpError) return json({ error: e.message }, e.status);
  console.error(e);
  return json({ error: "Something went wrong loading the portal. Please try again in a minute." }, 500);
}

/* ---------- accounts & sessions ---------- */

export function accounts(): Account[] {
  try {
    const list = JSON.parse(env("PORTAL_ACCOUNTS"));
    if (!Array.isArray(list)) throw new Error("not a list");
    return list;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(500, "The portal's PORTAL_ACCOUNTS setting is not valid.");
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a.trim().toUpperCase());
  const y = Buffer.from(b.trim().toUpperCase());
  return x.length === y.length && timingSafeEqual(x, y);
}

export function matchCode(code: string): Session | null {
  const exp = Date.now() + SESSION_HOURS * 3600_000;
  if (safeEqual(code, env("PORTAL_ADMIN_CODE"))) return { role: "admin", exp };
  const acct = accounts().find((a) => safeEqual(code, a.code));
  return acct ? { role: "partner", key: acct.key, exp } : null;
}

const b64u = (s: string | Buffer) => Buffer.from(s).toString("base64url");
const sign = (body: string) => createHmac("sha256", env("PORTAL_SESSION_SECRET")).update(body).digest("base64url");

export function makeToken(s: Session): string {
  const body = b64u(JSON.stringify(s));
  return `${body}.${sign(body)}`;
}

export function readSession(req: Request): Session {
  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  const [body, sig] = token.split(".");
  if (!body || !sig) throw new HttpError(401, "Please sign in with your access code.");
  const good = sign(body);
  if (good.length !== sig.length || !timingSafeEqual(Buffer.from(good), Buffer.from(sig)))
    throw new HttpError(401, "Please sign in with your access code.");
  const s: Session = JSON.parse(Buffer.from(body, "base64url").toString());
  if (s.exp < Date.now()) throw new HttpError(401, "Your session ended. Please sign in again.");
  return s;
}

/** Accounts this session may see. Partners only ever get their own. */
export function allowedAccounts(s: Session, requested?: string | null): Account[] {
  const all = accounts();
  if (s.role === "partner") return all.filter((a) => a.key === s.key);
  if (!requested || requested === "all") return all;
  const one = all.filter((a) => a.key === requested);
  if (!one.length) throw new HttpError(404, "That contractor account was not found.");
  return one;
}

export function publicAccount(a: Account) {
  return { key: a.key, name: a.name, prefix: a.prefix, contact: a.contact || a.name };
}

/* ---------- JobNimbus ---------- */

export async function jn(path: string, params: Record<string, string> = {}): Promise<any> {
  const url = new URL(JN_BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${env("JOBNIMBUS_API_KEY")}`, Accept: "application/json" },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HttpError(502, `JobNimbus returned ${res.status} for ${path}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

/** Read every page of a JobNimbus list endpoint (size/from paging, `results` list). */
export async function jnAll(path: string, params: Record<string, string> = {}, maxPages = 30): Promise<any[]> {
  const size = 100;
  const out: any[] = [];
  for (let page = 0; page < maxPages; page++) {
    const body = await jn(path, { ...params, size: String(size), from: String(page * size) });
    const rows: any[] = Array.isArray(body) ? body : body.results || body.items || [];
    out.push(...rows);
    const total = typeof body.count === "number" ? body.count : null;
    if (rows.length < size || (total !== null && out.length >= total)) break;
  }
  return out;
}

/* ---------- mapping JobNimbus records to portal jobs ---------- */

const PAID_EPSILON = 0.005;
const toISO = (sec: any): string | null => {
  const n = Number(sec);
  if (!n || n < 0) return null;
  return new Date(n * 1000).toISOString().slice(0, 10);
};

export function prefixRegex(prefix: string): RegExp {
  const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*${esc}\\s*>\\s*`, "i");
}

/** Statuses that mean Peak 301 has been applied. Override with PORTAL_DONE_STATUSES (comma list). */
function doneStatuses(): string[] {
  const custom = Netlify.env.get("PORTAL_DONE_STATUSES");
  return (custom ? custom.split(",") : ["complete", "completed", "invoiced", "paid", "closed", "job complete", "job completed"])
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Date the job was fulfilled. Uses the job's end date when one is set; otherwise the date the
 * job moved into a completed-type status.
 */
function fulfillmentDate(job: any): string | null {
  const end = toISO(job.date_end);
  if (end) return end;
  const status = String(job.status_name || "").toLowerCase();
  const done = doneStatuses().some((d) => status === d || status.includes(d));
  return done ? toISO(job.date_status_change) : null;
}

function address(job: any): string {
  const line2 = [job.city, [job.state_text, job.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [job.address_line1, job.address_line2, line2].filter(Boolean).join(", ");
}

function jobLabels(job: any): string[] {
  const out = [job.name, job.primary?.name];
  for (const r of job.related || []) if (r?.name) out.push(r.name);
  return out.filter((x) => typeof x === "string" && x.trim()) as string[];
}

export type PortalJob = {
  jnid: string;
  account: string;
  name: string;
  owner: string;
  address: string;
  status: string;
  assigned: string | null;
  fulfilled: string | null;
  invoice: null | {
    numbers: string[];
    total: number;
    paid: number;
    due: number;
    date: string | null;
    paidDate: string | null;
    isPaid: boolean;
  };
};

export async function loadJobs(accts: Account[]): Promise<{ jobs: PortalJob[]; raw: { jobs: any[]; invoices: any[] } }> {
  const jobsRaw = await jnAll("/jobs", { sort_field: "date_created", sort_direction: "desc" });
  const mine: { job: any; acct: Account; label: string }[] = [];
  for (const job of jobsRaw) {
    if (job.is_archived || job.is_active === false) continue;
    // The partner code ("NG>", "PP>") may be on the job name or on the job's customer (contact) name.
    for (const label of jobLabels(job)) {
      const acct = accts.find((a) => prefixRegex(a.prefix).test(label));
      if (acct) { mine.push({ job, acct, label }); break; }
    }
  }
  if (!mine.length) return { jobs: [], raw: { jobs: [], invoices: [] } };

  const ids = new Set(mine.map((m) => m.job.jnid));
  const invoicesRaw = (await jnAll("/v2/invoices")).filter(
    (inv) => !inv.is_archived && inv.is_active !== false && (inv.related || []).some((r: any) => ids.has(r.id)),
  );

  const jobs = mine.map(({ job, acct, label }): PortalJob => {
    const invs = invoicesRaw.filter((inv) => (inv.related || []).some((r: any) => r.id === job.jnid));
    let invoice: PortalJob["invoice"] = null;
    if (invs.length) {
      const total = invs.reduce((a, i) => a + Number(i.total || 0), 0);
      const due = invs.reduce((a, i) => a + Number(i.due ?? Math.max(0, Number(i.total || 0) - Number(i.total_paid || 0))), 0);
      const dates = invs.map((i) => toISO(i.date_invoice) || toISO(i.date_created)).filter(Boolean).sort() as string[];
      const paidDates = invs.map((i) => toISO(i.date_paid_in_full)).filter(Boolean).sort() as string[];
      const isPaid = total > 0 && due <= PAID_EPSILON;
      invoice = {
        numbers: invs.map((i) => String(i.number ?? "")).filter(Boolean),
        total,
        paid: total - due,
        due: Math.max(0, due),
        date: dates[dates.length - 1] || null,
        paidDate: isPaid ? paidDates[paidDates.length - 1] || null : null,
        isPaid,
      };
    }
    return {
      jnid: job.jnid,
      account: acct.key,
      name: label.trim(),
      owner: label.replace(prefixRegex(acct.prefix), "").trim(),
      address: address(job),
      status: String(job.status_name || ""),
      assigned: toISO(job.date_created),
      fulfilled: fulfillmentDate(job),
      invoice,
    };
  });
  return { jobs, raw: { jobs: mine.map((m) => m.job), invoices: invoicesRaw } };
}
