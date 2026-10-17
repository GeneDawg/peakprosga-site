// Shared helpers for the Peak 301 referral partner portal.
// Secrets live only in Netlify environment variables, never in this repo:
//   JOBNIMBUS_API_KEY      JobNimbus API key (read access)
//   PORTAL_ACCOUNTS        JSON list of partner accounts: [{key,name,prefix,contact,code}]
//   PORTAL_ADMIN_CODE      GDRR admin access code (sees every partner)
//   PORTAL_SESSION_SECRET  random string used to sign sign-in sessions
import { createHmac, timingSafeEqual } from "node:crypto";

const JN_BASE = "https://app.jobnimbus.com/api1";
const SESSION_HOURS = 12;

export type Account = { key: string; name: string; prefix: string; contact?: string; code: string; sources?: string[]; contactNames?: string[]; emailDomains?: string[]; contactId?: string; estimateTemplateId?: string; invoiceTemplateId?: string; service?: "peak" | "full" };
// v = fingerprint of the code used to sign in. Changing a partner's code in PORTAL_ACCOUNTS (or the admin code)
// ends every session made with the old code on the next request.
// j = set only on short-lived file links (one job, a few minutes), so those links can never act as a full sign-in.
export type Session = { role: "admin" | "partner"; key?: string; exp: number; v?: string; j?: string };

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

// Codes are compared on letters and digits only, so pasted codes still match when they carry spaces,
// long/curly dashes, no dashes, or invisible characters picked up from an email or chat.
const canon = (c: string) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(canon(a));
  const y = Buffer.from(canon(b));
  if (!x.length || !y.length) return false;
  return x.length === y.length && timingSafeEqual(x, y);
}

const codePrint = (code: string) => createHmac("sha256", env("PORTAL_SESSION_SECRET")).update("code:" + canon(code)).digest("base64url").slice(0, 12);

export function matchCode(code: string): Session | null {
  const exp = Date.now() + SESSION_HOURS * 3600_000;
  if (safeEqual(code, env("PORTAL_ADMIN_CODE"))) return { role: "admin", exp, v: codePrint(env("PORTAL_ADMIN_CODE")) };
  const acct = accounts().find((a) => safeEqual(code, a.code));
  return acct ? { role: "partner", key: acct.key, exp, v: codePrint(acct.code) } : null;
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
  if (s.j) throw new HttpError(401, "Please sign in with your access code.");
  // The code behind this session must still be current, and the partner must still exist.
  const current = s.role === "admin" ? env("PORTAL_ADMIN_CODE") : accounts().find((a) => a.key === s.key)?.code;
  if (!current || s.v !== codePrint(current)) throw new HttpError(401, "Your access code has changed. Please sign in again.");
  return s;
}

/** A link for one job's file, good for 3 minutes. Used on iPhone, where Safari needs a real web address to open a PDF. */
export function makeFileTicket(s: Session, jnid: string): string {
  return makeToken({ ...s, j: jnid, exp: Math.min(s.exp, Date.now() + 3 * 60_000) });
}

/** Checks a file link from makeFileTicket and returns its session, or null if it's expired or for another job. */
export function readFileTicket(ticket: string, jnid: string): Session | null {
  const [body, sig] = String(ticket || "").split(".");
  if (!body || !sig) return null;
  const good = sign(body);
  if (good.length !== sig.length || !timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return null;
  let s: Session;
  try { s = JSON.parse(Buffer.from(body, "base64url").toString()); } catch { return null; }
  if (!s.j || s.j !== jnid || s.exp < Date.now()) return null;
  const current = s.role === "admin" ? env("PORTAL_ADMIN_CODE") : accounts().find((a) => a.key === s.key)?.code;
  if (!current || s.v !== codePrint(current)) return null;
  return s;
}

/** Same checks as readSession, for a token passed some other way (e.g. inside a form submission). */
export function sessionFromToken(token: string): Session | null {
  try {
    return readSession(new Request("https://x/", { headers: { authorization: `Bearer ${token}` } }));
  } catch {
    return null;
  }
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
    const rows: any[] = Array.isArray(body) ? body : body.results || body.files || body.items || [];
    out.push(...rows);
    const total = typeof body.count === "number" ? body.count : null;
    if (rows.length < size || (total !== null && out.length >= total)) break;
  }
  return out;
}

/* ---------- mapping JobNimbus records to portal jobs ---------- */

const PAID_EPSILON = 0.005;
const TZ = "America/New_York";
/** JobNimbus epoch seconds -> YYYY-MM-DD in Eastern time (GDRR's local day). */
const toISO = (sec: any): string | null => {
  const n = Number(sec);
  if (!n || n < 0) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(n * 1000));
};
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
/** Epoch seconds + N business days -> YYYY-MM-DD (Eastern). */
function addBusinessDays(sec: number, n: number): string {
  const d = new Date((sec || Date.now() / 1000) * 1000);
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) added++;
  }
  return toISO(d.getTime() / 1000)!;
}
export const norm = (s: any) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

export function prefixRegex(prefix: string): RegExp {
  const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*${esc}\\s*>\\s*`, "i");
}

/** Job statuses that mean the Peak 301 work is done. Override with PORTAL_DONE_STATUSES (comma list). */
function isDone(status: string): boolean {
  const custom = Netlify.env.get("PORTAL_DONE_STATUSES");
  const list = (custom ? custom.split(",") : ["job completed", "complete", "pending payment", "paid", "closed", "invoic"]).map(norm).filter(Boolean);
  const s = norm(status);
  return list.some((d) => s.includes(d));
}

/** Fulfillment = the job's scheduled start date (when the crew applied Peak 301), once the job is in a done status. */
function fulfillmentDate(job: any): string | null {
  if (!isDone(job.status_name)) return null;
  return toISO(job.date_start) || toISO(job.date_end) || toISO(job.date_status_change);
}

function address(job: any): string {
  const line2 = [job.city, [job.state_text, job.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [job.address_line1, job.address_line2, line2].filter(Boolean).join(", ");
}

function cleanName(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Only Peak 301 jobs belong in the partner portal. A job counts when its workflow (job type) name
 * contains PORTAL_PEAK_TAG (default "Peak 301") or it carries that tag.
 * A referral lead source alone is not enough: partners also refer regular GDRR roofing work.
 */
export function isPeakJob(job: any): boolean {
  const marker = norm(Netlify.env.get("PORTAL_PEAK_TAG") || "Peak 301");
  const tags = (job.tags || []).map((x: any) => norm(typeof x === "string" ? x : x?.name));
  return tags.includes(marker) || norm(job.record_type_name).includes(marker);
}

/**
 * Which partner sent this Peak 301 job. Checked in order:
 *  1. the contractor is a contact on the job (primary or related) whose name is in the account's `contactNames`
 *  2. the customer's Lead Source matches one of the account's `sources`
 *  3. the job's tags include one of the account's `sources` or its prefix
 *  4. the job or customer name starts with the account prefix, e.g. "PP>Pam Cisneros"
 * The homeowner is the job's other contact; when the contractor is the only contact, the job name is used.
 */
function matchAccount(job: any, contact: any, accts: Account[]): { acct: Account; owner: string } | null {
  if (!isPeakJob(job)) return null;
  const people: { id?: string; name: string }[] = [];
  if (job.primary?.name) people.push({ id: job.primary.id, name: job.primary.name });
  for (const r of job.related || []) if (r?.name && (r.type || "contact") === "contact" && !people.some((p) => p.id === r.id)) people.push({ id: r.id, name: r.name });
  const source = norm(contact?.source_name);
  const tags = [...(job.tags || []), ...(contact?.tags || [])].map((x: any) => norm(typeof x === "string" ? x : x?.name));
  for (const acct of accts) {
    const partnerNames = [acct.name, ...(acct.contactNames || [])].map(norm);
    const partner = people.find((p) => partnerNames.includes(norm(p.name)));
    if (partner) {
      const homeowner = people.find((p) => p !== partner);
      return { acct, owner: cleanName(homeowner?.name || String(job.name || "")) };
    }
  }
  const owner = cleanName(String(job.primary?.name || contact?.display_name || job.name || ""));
  for (const acct of accts) {
    const sources = (acct.sources || []).map(norm);
    if (source && sources.includes(source)) return { acct, owner };
    if (tags.some((tg) => sources.includes(tg) || tg === norm(acct.prefix))) return { acct, owner };
    for (const label of [job.name, job.primary?.name, contact?.display_name]) {
      if (typeof label === "string" && prefixRegex(acct.prefix).test(label)) return { acct, owner: cleanName(label.replace(prefixRegex(acct.prefix), "")) };
    }
  }
  return null;
}

export type PortalFile = { id: string; name: string; date: string | null };

/** Files on a job that partners may open: invoice PDFs, photo reports and photos. Warranty files stay private. */
export async function jobFiles(jnid: string): Promise<PortalJob["files"]> {
  const out: PortalJob["files"] = { invoices: [], reports: [], photos: [] };
  let rows: any[] = [];
  try {
    rows = await jnAll("/files", { filter: JSON.stringify({ must: [{ term: { "related.id": jnid } }] }) }, 3);
  } catch (e) {
    console.error("files lookup failed", e);
    return out;
  }
  for (const f of rows) {
    if (f.is_archived || f.is_active === false || f.is_private) continue;
    const kind = norm(f.record_type_name);
    const name = String(f.filename || "");
    const file = { id: String(f.jnid), name, date: toISO(f.date_file_created || f.date_created) };
    if (kind === "invoice" && /\.pdf$/i.test(name)) out.invoices.push(file);
    else if (kind === "photo" && /^image\//.test(String(f.content_type || ""))) out.photos.push(file);
    else if (/photo[_ ]?report/i.test(name) && /\.pdf$/i.test(name)) out.reports.push(file);
  }
  const byDate = (a: PortalFile, b: PortalFile) => String(b.date).localeCompare(String(a.date));
  out.invoices.sort(byDate); out.reports.sort(byDate);
  out.photos = out.photos.slice(0, 60);
  return out;
}

/** A short-lived JobNimbus download link for one file. */
export async function fileLink(fileId: string): Promise<string> {
  const res = await fetch(`${JN_BASE}/files/${encodeURIComponent(fileId)}`, {
    headers: { Authorization: `Bearer ${env("JOBNIMBUS_API_KEY")}` },
    redirect: "manual",
  });
  const loc = res.headers.get("location");
  if (res.status >= 300 && res.status < 400 && loc) return loc;
  throw new HttpError(502, `JobNimbus did not return the file (status ${res.status}).`);
}

export type PortalJob = {
  jnid: string;
  account: string;
  number: string;
  owner: string;
  address: string;
  status: string;
  assigned: string | null;
  fulfilled: string | null;
  files: { invoices: PortalFile[]; reports: PortalFile[]; photos: PortalFile[] };
  invoice: null | {
    processing: boolean;
    clearsOn: string | null;
    numbers: string[];
    total: number;
    paid: number;
    due: number;
    date: string | null;
    paidDate: string | null;
    isPaid: boolean;
  };
};

export async function loadJobs(accts: Account[], withFiles = false): Promise<{ jobs: PortalJob[]; raw: { jobs: any[]; invoices: any[] } }> {
  const [jobsRaw, contactsRaw] = await Promise.all([
    jnAll("/jobs", { sort_field: "date_created", sort_direction: "desc" }),
    jnAll("/contacts", { fields: "jnid,display_name,source_name,tags" }),
  ]);
  const contacts = new Map(contactsRaw.map((c: any) => [c.jnid, c]));
  const mine: { job: any; acct: Account; owner: string }[] = [];
  for (const job of jobsRaw) {
    if (job.is_archived || job.is_active === false) continue;
    const m = matchAccount(job, contacts.get(job.primary?.id), accts);
    if (m) mine.push({ job, ...m });
  }
  if (!mine.length) return { jobs: [], raw: { jobs: [], invoices: [] } };

  const ids = new Set(mine.map((m) => m.job.jnid));
  // Payments taken on a job but not applied to an invoice (JobNimbus Payments can record them this way)
  // still count toward that job's invoices.
  const unapplied = new Map<string, { amount: number; date: string | null }>();
  // Card/ACH payments taken through JobNimbus Payments are held until they clear (PORTAL_CLEAR_DAYS business days).
  const clearing = new Map<string, string>(); // job or invoice jnid -> date the latest processor payment clears
  const holdDays = Number(Netlify.env.get("PORTAL_CLEAR_DAYS") || 3);
  try {
    const allPayments = await jnAll("/payments");
    for (const p of allPayments) {
      if (p.is_archived || p.is_active === false) continue;
      const processor = !!p.created_by_processor || /^system_jn_payments/i.test(String(p.created_by || ""));
      if (!processor) continue;
      const clears = addBusinessDays(Number(p.date_payment || p.date_created), holdDays);
      if (clears <= today()) continue;
      for (const id of [...(p.related || []).map((r: any) => r.id), ...(p.invoices || []).map((i: any) => i.invoice_id)]) {
        if (id && (!clearing.get(id) || clearing.get(id)! < clears)) clearing.set(id, clears);
      }
    }
    for (const p of allPayments) {
      if (p.is_archived || p.is_active === false || (p.invoices || []).length) continue;
      const amount = Number(p.total || 0) - Number(p.refunded_amount || 0);
      if (amount <= 0) continue;
      for (const r of p.related || []) {
        if (!ids.has(r.id)) continue;
        const prev = unapplied.get(r.id) || { amount: 0, date: null };
        const d = toISO(p.date_payment) || toISO(p.date_created);
        unapplied.set(r.id, { amount: prev.amount + amount, date: [prev.date, d].filter(Boolean).sort().pop() || null });
      }
    }
  } catch (e) {
    console.error("payments lookup failed", e);
  }
  const invoicesRaw = (await jnAll("/v2/invoices")).filter(
    (inv) => !inv.is_archived && inv.is_active !== false && norm(inv.status_name) !== "void" && (inv.related || []).some((r: any) => ids.has(r.id)),
  );

  const filesByJob = new Map<string, PortalJob["files"]>();
  if (withFiles) {
    await Promise.all(mine.map(async ({ job }) => filesByJob.set(job.jnid, await jobFiles(job.jnid))));
  }
  const jobs = mine.map(({ job, acct, owner }): PortalJob => {
    const invs = invoicesRaw.filter((inv) => (inv.related || []).some((r: any) => r.id === job.jnid));
    let invoice: PortalJob["invoice"] = null;
    if (invs.length) {
      const total = invs.reduce((a, i) => a + Number(i.total || 0), 0);
      const extra = unapplied.get(job.jnid);
      const due = invs.reduce((a, i) => a + Number(i.due ?? Math.max(0, Number(i.total || 0) - Number(i.total_paid || 0))), 0) - (extra?.amount || 0);
      const dates = invs.map((i) => toISO(i.date_invoice) || toISO(i.date_created)).filter(Boolean).sort() as string[];
      const paidDates = [...invs.map((i) => toISO(i.date_paid_in_full)), extra?.date].filter(Boolean).sort() as string[];
      // Nothing left to pay. A $0 invoice counts as paid once it is out of Draft.
      const isPaid = due <= PAID_EPSILON && (total > 0 || !!extra || invs.some((i) => toISO(i.date_paid_in_full) || norm(i.status_name) !== "draft"));
      const clearsOn = [clearing.get(job.jnid), ...invs.map((i) => clearing.get(i.jnid))].filter(Boolean).sort().pop() || null;
      const processing = isPaid && !!clearsOn;
      invoice = {
        processing,
        clearsOn: processing ? clearsOn : null,
        numbers: invs.map((i) => String(i.number ?? "")).filter(Boolean),
        total,
        paid: total - due,
        due: Math.max(0, due),
        date: dates[dates.length - 1] || null,
        paidDate: isPaid ? paidDates[paidDates.length - 1] || null : null,
        isPaid: isPaid && !processing,
      };
    }
    return {
      jnid: job.jnid,
      account: acct.key,
      number: String(job.number ?? ""),
      owner,
      address: address(job),
      status: String(job.status_name || ""),
      assigned: toISO(job.date_created),
      fulfilled: fulfillmentDate(job),
      files: filesByJob.get(job.jnid) || { invoices: [], reports: [], photos: [] },
      invoice,
    };
  });
  return { jobs, raw: { jobs: mine.map((m) => m.job), invoices: invoicesRaw } };
}
