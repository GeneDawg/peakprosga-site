// Turns a peakprosga.com assignment (Netlify form "PeakProsGA-Assignment") into JobNimbus records:
//   1. a homeowner contact
//   2. a Peak 301 Referral job (status Assigned) under the right contractor, with the form details filled in
//   3. a task for Shadie (who signs in as Gene) to order the EagleView QuickSquares report
//   4. a task for Eddie with the job price and labor pay ($20 per square, confirmed from EagleView)
// Writes use JOBNIMBUS_WRITE_KEY when set, otherwise JOBNIMBUS_API_KEY.
import { accounts, env, HttpError, type Account } from "./portal.mts";

const JN_BASE = "https://app.jobnimbus.com/api1";
const USERS = {
  gene: "m9n0ajnc1wl1dlw1e01d8t6", // Shadie works under Gene's login
  eddie: "f51ac41fcfb54674950809f89d42766f",
};
const LABOR_PER_SQ = Number(Netlify.env.get("PORTAL_LABOR_PER_SQ") || 20);

export type Assignment = Record<string, string | undefined>;

async function jnWrite(method: "POST" | "PUT", path: string, body: unknown): Promise<any> {
  const key = Netlify.env.get("JOBNIMBUS_WRITE_KEY") || env("JOBNIMBUS_API_KEY");
  const res = await fetch(JN_BASE + path, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(502, `JobNimbus ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
const domainOf = (email: string) => clean(email).toLowerCase().split("@")[1] || "";
const norm = (s: unknown) => clean(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Which contractor sent this: by email domain first, then by company name. */
export function matchContractor(a: Assignment): Account | null {
  const domain = domainOf(a.contact_email || "");
  const company = norm(a.company);
  for (const acct of accounts()) {
    if (domain && (acct.emailDomains || []).map((d) => d.toLowerCase()).includes(domain)) return acct;
  }
  for (const acct of accounts()) {
    const names = [acct.name, ...(acct.contactNames || [])].map(norm);
    if (company && names.some((n) => n && (company.includes(n) || n.includes(company)))) return acct;
  }
  return null;
}

/** "123 Main St, Atlanta, GA 30301" -> parts. Falls back to the whole string on line 1. */
export function parseAddress(raw: string) {
  const s = clean(raw);
  const m = s.match(/^(.+?),\s*([^,]+?),\s*([A-Za-z]{2}|Georgia|South Carolina)\.?\s*(\d{5})?(?:-\d{4})?$/i);
  if (!m) return { address_line1: s, city: "", state_text: "", zip: "" };
  const st = m[3].length === 2 ? m[3].toUpperCase() : m[3];
  return { address_line1: m[1], city: m[2], state_text: st, zip: m[4] || "" };
}

function splitName(full: string) {
  const parts = clean(full).split(" ");
  if (parts.length === 1) return { first_name: parts[0] || "Homeowner", last_name: "" };
  return { first_name: parts.slice(0, -1).join(" "), last_name: parts[parts.length - 1] };
}

const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
function parseMoney(s?: string): number | null {
  const n = Number(String(s ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Map the form's roof age to the JobNimbus "Roof Age" choices. */
function roofAge(v?: string): string | undefined {
  const s = clean(v).toLowerCase();
  if (s.startsWith("under 5")) return "0-5 Years";
  if (s.startsWith("5")) return "6-10 Years";
  if (s.startsWith("10")) return "11-15 Years";
  if (s.startsWith("15")) return "16-20 Years";
  if (s.startsWith("20")) return "21+ Years";
  return undefined;
}

export function summarize(a: Assignment, acct: Account | null) {
  const sq = Number(a.roof_size || 0) || null;
  const price = parseMoney(a.quoted_price);
  const lines = [
    `Peak 301 referral from ${acct ? acct.name : clean(a.company) + " (CONTRACTOR NEEDS REVIEW)"}`,
    `Submitted by: ${clean(a.contact_name)} · ${clean(a.contact_phone)} · ${clean(a.contact_email)}`,
    `Homeowner: ${clean(a.homeowner_name)} · ${clean(a.homeowner_phone)}`,
    `Property: ${clean(a.property_address)}`,
    `Roof size (contractor): ${sq ? sq + " sq" : "not given"} · Age: ${clean(a.roof_age) || "—"} · Type: ${clean(a.roof_type) || "—"}`,
    `Two story: ${clean(a.two_story) || "—"} · Steep pitch: ${clean(a.pitch) || "—"} · Damage: ${clean(a.damage) || "—"}`,
    `Quoted price: ${price ? money(price) : clean(a.quoted_price) || "—"}`,
    `Requested service date: ${clean(a.service_date) || "—"}`,
    a.scope_notes ? `Notes: ${clean(a.scope_notes)}` : "",
  ].filter(Boolean);
  return { text: lines.join("\n"), sq, price };
}

const day = 86400;
const now = () => Math.floor(Date.now() / 1000);

// opts.account: the partner proven by their signed-in session. When given, it wins over name/email matching.
// opts.unverified: the form arrived without a valid partner sign-in; the job is created but flagged for Shadie
// and not attached to any contractor until a person checks it.
export async function createFromAssignment(a: Assignment, opts: { test?: boolean; account?: Account | null; unverified?: boolean } = {}) {
  const acct = opts.unverified ? null : opts.account || matchContractor(a);
  const { text, sq, price } = summarize(a, acct);
  const addr = parseAddress(a.property_address || "");
  const tag = opts.test ? "TEST - " : opts.unverified ? "CHECK - " : "";

  // 1. Homeowner contact
  const homeowner = await jnWrite("POST", "/contacts", {
    ...splitName(a.homeowner_name || "Homeowner"),
    display_name: tag + clean(a.homeowner_name || "Homeowner"),
    record_type_name: "Customer",
    status_name: "New",
    home_phone: clean(a.homeowner_phone),
    ...addr,
    description: "Peak 301 referral homeowner",
    source_name: acct?.sources?.[0],
    sales_rep: USERS.gene,
  });

  // 2. Job under the contractor
  const related: { id: string }[] = [{ id: homeowner.jnid }];
  if (acct?.contactId) related.push({ id: acct.contactId });
  const fields: Record<string, unknown> = {};
  const age = roofAge(a.roof_age);
  if (age) fields["Roof Age"] = age;
  if (/asphalt/i.test(a.roof_type || "")) fields["Roof Type"] = "Asphalt Shingles";
  const job = await jnWrite("POST", "/jobs", {
    name: tag + (addr.address_line1 || clean(a.property_address)),
    record_type_name: "Peak 301 Referral",
    status_name: "Assigned",
    primary: { id: homeowner.jnid },
    related,
    ...addr,
    description: text,
    source_name: acct?.sources?.[0],
    sales_rep: USERS.gene,
    ...fields,
  });

  // 3. Shadie: order EagleView
  const t = now();
  const shadie = await jnWrite("POST", "/tasks", {
    title: `${tag}Shadie: EagleView + estimate - ${addr.address_line1 || clean(a.property_address)}`,
    record_type_name: "Task",
    description: `1. Order the EagleView QuickSquares report for ${clean(a.property_address)} (contractor says ${sq ? sq + " sq" : "size not given"}).\n2. When it arrives, create the estimate on this job from the "Peak 301 Only" layout using the EagleView squares.\n3. Send it for signature to ${acct ? acct.name : "the contractor"}. The board moves to Estimate Sent, then Scheduled when they sign; Eddie gets the schedule task with labor at $${LABOR_PER_SQ}/sq.`,
    related: [{ id: job.jnid }],
    owners: [{ id: USERS.gene }],
    date_start: t,
    date_end: t + day,
  });

  // 4. Eddie: production with price and labor
  const labor = sq ? sq * LABOR_PER_SQ : null;
  const eddie = await jnWrite("POST", "/tasks", {
    title: `${tag}Eddie: schedule Peak 301 - ${addr.address_line1 || clean(a.property_address)}`,
    record_type_name: "Task",
    description: [
      `Peak 301 job for ${acct ? acct.name : clean(a.company)}.`,
      `Job price (quoted to contractor): ${price ? money(price) : clean(a.quoted_price) || "—"}`,
      `Labor: $${LABOR_PER_SQ}/sq × EagleView squares. Estimate from contractor's ${sq ?? "?"} sq = ${labor ? money(labor) : "—"} (confirm with the EagleView report).`,
      `Requested date: ${clean(a.service_date) || "—"}`,
      a.scope_notes ? `Notes: ${clean(a.scope_notes)}` : "",
    ].filter(Boolean).join("\n"),
    related: [{ id: job.jnid }],
    owners: [{ id: USERS.eddie }],
    date_start: t,
    date_end: t + 2 * day,
  });

  return { contractor: acct?.key || null, homeowner: homeowner.jnid, job: job.jnid, tasks: [shadie.jnid, eddie.jnid] };
}
