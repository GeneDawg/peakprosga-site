// Ops core (Milestone 1, Georgia sandbox): assignments with a stable ID, dedupe across the web form and the
// assignment inbox, a state machine, and an append-only audit trail.
//
// Pure TypeScript: no Netlify globals, so it runs in tests. Everything it needs comes in through Ctx.
// System-of-record rules (docs/BLUEPRINT.md): this layer owns the assignment, partner, invite and audit records;
// JobNimbus owns the production job. Nothing here sends a real message: emails are rendered into the outbox.
import { createHash, randomBytes } from "node:crypto";
import type { Store } from "./store.mts";
import type { JobNimbusAdapter } from "./adapters/jobnimbus.mts";

export type Company = { key: string; name: string; prefix?: string; emailDomains?: string[]; contactNames?: string[]; billingEmail?: string };

export type State =
  | "received" | "needs_review" | "rejected" | "accepted" | "measurement_ordered"
  // Milestone 2 states. Declared so the contract is visible; nothing moves a job into them yet.
  | "measurement_overdue" | "measured" | "measure_hold" | "estimate_sent" | "estimate_expired"
  | "scheduled" | "completed" | "evidence_hold" | "invoiced" | "partial_paid" | "paid" | "closed";

export type Source = "form" | "inbox" | "admin";

export type AssignmentData = {
  company?: string; contact_name?: string; contact_email?: string; contact_phone?: string;
  homeowner_name?: string; homeowner_phone?: string; property_address?: string;
  roof_size?: string; roof_age?: string; roof_type?: string; two_story?: string; pitch?: string;
  damage?: string; quoted_price?: string; service_date?: string; scope_notes?: string;
};

export type Assignment = {
  id: string;
  market: string;
  idemKey: string;
  source: Source;
  sourceEvents: { source: Source; id: string; at: string }[];
  companyKey: string | null;
  verified: boolean;
  state: State;
  reviewReasons: string[];
  duplicateOf?: string | null;
  data: AssignmentData;
  normAddress: string;
  jn: { contactId?: string; jobId?: string; measurementTaskId?: string };
  createdAt: string;
  updatedAt: string;
};

export type AuditEvent = { assignmentId: string; at: string; actor: string; action: string; from?: State | null; to?: State | null; detail?: unknown };

export type OutboxMessage = { key: string; to: string; subject: string; body: string; status: "not_sent"; reason: string; at: string };

export type Ctx = {
  store: Store;
  jn: JobNimbusAdapter;
  companies: Company[];
  market?: string;                 // "GA"
  shadieEmail?: string;            // measurement requests go here (rendered only)
  dedupeDays?: number;             // same partner + same address within this many days = same job (default 7)
  lockStaleMs?: number;            // a create-job lock older than this can be taken over (default 2 min)
  now?: () => number;
  hooks?: { afterJobCreated?: () => void }; // test hook: simulate a crash right after JobNimbus accepted the job
};

const now = (c: Ctx) => (c.now ? c.now() : Date.now());
const iso = (c: Ctx) => new Date(now(c)).toISOString();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

// ---------- normalisation & identity ----------

const ABBR: Record<string, string> = {
  street: "st", avenue: "ave", road: "rd", drive: "dr", lane: "ln", court: "ct", circle: "cir", boulevard: "blvd",
  place: "pl", parkway: "pkwy", highway: "hwy", trail: "trl", terrace: "ter", way: "way",
  north: "n", south: "s", east: "e", west: "w", northeast: "ne", northwest: "nw", southeast: "se", southwest: "sw",
  georgia: "ga", "south carolina": "sc",
};

/** "3688 Allenhurst Drive, Peachtree Corners, Georgia 30092" -> "3688 allenhurst dr peachtree corners ga 30092" */
export function normalizeAddress(raw: string): string {
  let s = clean(raw).toLowerCase().replace(/[.,#]/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/\bsouth carolina\b/g, "sc");
  s = s.split(" ").map((w) => ABBR[w] ?? w).join(" ");
  s = s.replace(/\b(\d{5})-\d{4}\b/, "$1");
  return s;
}

/** Street number + street name + ZIP: the part that survives different ways of typing the same address. */
export function addressFingerprint(raw: string): string {
  const n = normalizeAddress(raw);
  const zip = (n.match(/\b\d{5}\b(?!.*\b\d{5}\b)/) || [""])[0];
  const head = n.split(" ").slice(0, 3).join(" ");
  return `${head}|${zip}`;
}

export const domainOf = (email?: string) => clean(email).toLowerCase().split("@")[1] || "";
const norm = (s: unknown) => clean(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function matchCompany(c: Ctx, d: AssignmentData): Company | null {
  const domain = domainOf(d.contact_email);
  if (domain) for (const co of c.companies) if ((co.emailDomains || []).map((x) => x.toLowerCase()).includes(domain)) return co;
  const name = norm(d.company);
  if (name) for (const co of c.companies) {
    const names = [co.name, ...(co.contactNames || [])].map(norm).filter(Boolean);
    if (names.some((n) => name.includes(n) || n.includes(name))) return co;
  }
  return null;
}

function newId(c: Ctx): string {
  const year = new Date(now(c)).getUTCFullYear();
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0/O/1/I: easy to read out on the phone
  const bytes = randomBytes(6);
  let s = "";
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return `${c.market || "GA"}-${year}-${s}`;
}

// ---------- audit & outbox ----------

let seq = 0;
export async function audit(c: Ctx, e: Omit<AuditEvent, "at">) {
  const at = iso(c);
  seq = (seq + 1) % 1e6;
  await c.store.set(`audit/${e.assignmentId}/${at}-${String(seq).padStart(6, "0")}-${randomBytes(3).toString("hex")}`, { ...e, at });
}

export async function auditTrail(c: Ctx, id: string): Promise<AuditEvent[]> {
  const keys = await c.store.list(`audit/${id}/`);
  const out: AuditEvent[] = [];
  for (const k of keys) { const e = await c.store.get<AuditEvent>(k); if (e) out.push(e); }
  return out;
}

/** Messages are rendered and kept, never sent, in Milestone 1. Keyed so a retry can't queue the same message twice. */
export async function queueMessage(c: Ctx, m: Omit<OutboxMessage, "status" | "reason" | "at">): Promise<boolean> {
  return c.store.createIfAbsent(`outbox/${m.key}`, { ...m, status: "not_sent", reason: "Sandbox: outbound messages are switched off", at: iso(c) });
}

export async function outbox(c: Ctx, prefix = ""): Promise<OutboxMessage[]> {
  const keys = await c.store.list(`outbox/${prefix}`);
  return (await Promise.all(keys.map((k) => c.store.get<OutboxMessage>(k)))).filter(Boolean) as OutboxMessage[];
}

// ---------- assignments ----------

export const getAssignment = (c: Ctx, id: string) => c.store.get<Assignment>(`assignment/${id}`);
async function save(c: Ctx, a: Assignment) { a.updatedAt = iso(c); await c.store.set(`assignment/${a.id}`, a); }

export async function listAssignments(c: Ctx, filter: { companyKey?: string; state?: State } = {}): Promise<Assignment[]> {
  const keys = await c.store.list("assignment/");
  const all = (await Promise.all(keys.map((k) => c.store.get<Assignment>(k)))).filter(Boolean) as Assignment[];
  return all
    .filter((a) => (filter.companyKey === undefined || a.companyKey === filter.companyKey) && (!filter.state || a.state === filter.state))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function setState(c: Ctx, a: Assignment, to: State, actor: string, detail?: unknown) {
  const from = a.state;
  a.state = to;
  await save(c, a);
  await audit(c, { assignmentId: a.id, actor, action: "state", from, to, detail });
}

function reviewReasons(d: AssignmentData, verified: boolean, co: Company | null): string[] {
  const r: string[] = [];
  if (!verified) r.push("Not submitted from a signed-in partner account");
  if (!co) r.push("Could not match the assigning contractor");
  if (!clean(d.property_address)) r.push("Property address missing");
  else if (!/\b\d{5}\b/.test(d.property_address!)) r.push("Property address has no ZIP code");
  if (!clean(d.homeowner_name)) r.push("Homeowner name missing");
  return r;
}

export type IngestInput = {
  source: Source;
  sourceEventId: string;          // Netlify submission id, email Message-ID, or an admin-generated id
  data: AssignmentData;
  companyKey?: string | null;     // set only when proven by a signed-in partner session (or an admin)
  actor?: string;
};

export type IngestResult = { assignment: Assignment; outcome: "created" | "replay" | "duplicate" | "suggested_duplicate" };

/**
 * Takes one submission from any channel. Guarantees:
 *  - the same event (same source + id) delivered twice returns the same assignment ("replay");
 *  - the same partner + same address within dedupeDays attaches to the existing assignment ("duplicate");
 *  - an unverified submission for an address already open is held for review, pointing at the likely match.
 * The assignment is saved before anything is sent to JobNimbus, so nothing is lost if that call fails.
 */
export async function ingest(c: Ctx, input: IngestInput): Promise<IngestResult> {
  const actor = input.actor || `system:${input.source}`;
  const eventKey = `event/${input.source}/${sha(input.sourceEventId).slice(0, 32)}`;
  const seen = await c.store.get<{ assignmentId: string }>(eventKey);
  if (seen) {
    const a = await getAssignment(c, seen.assignmentId);
    if (a) return { assignment: a, outcome: "replay" };
  }

  const d: AssignmentData = Object.fromEntries(Object.entries(input.data || {}).map(([k, v]) => [k, clean(v)])) as AssignmentData;
  let co: Company | null = null;
  let verified = false;
  if (input.companyKey) { co = c.companies.find((x) => x.key === input.companyKey) || null; verified = !!co; }
  else if (input.source === "inbox") co = matchCompany(c, d); // sender's email domain is evidence, but not proof
  const fp = addressFingerprint(d.property_address || "");
  const owner = co ? `co:${co.key}` : "unmatched";
  const idemKey = sha(`${owner}|${fp}`).slice(0, 40);
  const at = iso(c);
  const windowMs = (c.dedupeDays ?? 7) * 86400_000;

  // 1. Same partner, same address, recently: one job.
  const idx = `idem/${idemKey}`;
  const existing = await c.store.get<{ assignmentId: string; at: string }>(idx);
  if (existing && now(c) - Date.parse(existing.at) < windowMs) {
    const a = await getAssignment(c, existing.assignmentId);
    if (a) {
      a.sourceEvents.push({ source: input.source, id: input.sourceEventId, at });
      // The email copy arrived first and was held; now the signed-in partner's form proves who sent it.
      const upgrade = verified && !a.verified && a.state === "needs_review";
      if (upgrade) {
        a.verified = true;
        a.data = { ...d, ...Object.fromEntries(Object.entries(a.data).filter(([, v]) => v)) } as AssignmentData;
      }
      await save(c, a);
      await c.store.set(eventKey, { assignmentId: a.id });
      await audit(c, { assignmentId: a.id, actor, action: "duplicate_attached", detail: { source: input.source, eventId: input.sourceEventId } });
      if (upgrade) {
        const reasons = reviewReasons(a.data, true, co);
        a.reviewReasons = reasons;
        if (!reasons.length) await setState(c, a, "accepted", "system:rules", { verifiedBy: input.source });
        else await save(c, a);
      }
      return { assignment: a, outcome: "duplicate" };
    }
  }

  const a: Assignment = {
    id: newId(c), market: c.market || "GA", idemKey, source: input.source,
    sourceEvents: [{ source: input.source, id: input.sourceEventId, at }],
    companyKey: co?.key || null, verified, state: "received", reviewReasons: [], duplicateOf: null,
    data: d, normAddress: normalizeAddress(d.property_address || ""), jn: {}, createdAt: at, updatedAt: at,
  };

  // Claim the dedupe slot atomically: of two simultaneous copies, exactly one creates the assignment.
  const claimed = existing
    ? (await c.store.set(idx, { assignmentId: a.id, at }), true) // the old slot is past the window: this is a new job
    : await c.store.createIfAbsent(idx, { assignmentId: a.id, at });
  if (!claimed) return ingest(c, input); // lost the race: go round once more and attach to the winner

  // 2. Unverified copy of an address that is already open under a partner: hold it next to its likely match.
  let outcome: IngestResult["outcome"] = "created";
  const fpKey = `addr/${sha(fp).slice(0, 32)}`;
  const open = await c.store.get<{ assignmentId: string; at: string }>(fpKey);
  if (!verified && open && open.assignmentId !== a.id && now(c) - Date.parse(open.at) < windowMs) {
    a.duplicateOf = open.assignmentId;
    outcome = "suggested_duplicate";
  }
  if (verified || !open) await c.store.set(fpKey, { assignmentId: a.id, at });

  await save(c, a);
  await c.store.set(eventKey, { assignmentId: a.id });
  await audit(c, { assignmentId: a.id, actor, action: "received", to: "received", detail: { source: input.source, eventId: input.sourceEventId, companyKey: a.companyKey, verified } });

  const reasons = reviewReasons(d, verified, co);
  if (a.duplicateOf) reasons.unshift(`Looks like a copy of ${a.duplicateOf}`);
  if (reasons.length) { a.reviewReasons = reasons; await setState(c, a, "needs_review", "system:rules", { reasons }); }
  else await setState(c, a, "accepted", "system:rules");
  return { assignment: a, outcome };
}

/**
 * Moves an accepted assignment into production: contractor contact, ONE JobNimbus job, the measurement task and
 * Shadie's request. Safe to run any number of times, including after a crash part-way through.
 */
export async function advance(c: Ctx, id: string, actor = "system:pipeline"): Promise<Assignment> {
  const a = await getAssignment(c, id);
  if (!a) throw new Error(`No assignment ${id}`);
  if (a.state !== "accepted") return a;
  const co = c.companies.find((x) => x.key === a.companyKey);
  if (!co) throw new Error(`Assignment ${id} has no contractor`);

  // Only one worker may create the job. A lock left behind by a crashed worker goes stale and can be taken over.
  const lockKey = `lock/${a.id}/create-job`;
  const stale = c.lockStaleMs ?? 120_000;
  if (!(await c.store.createIfAbsent(lockKey, { at: now(c) }))) {
    const lock = await c.store.get<{ at: number }>(lockKey);
    if (lock && now(c) - lock.at < stale) return a; // another worker is on it
    await c.store.set(lockKey, { at: now(c) });
    await audit(c, { assignmentId: a.id, actor, action: "lock_taken_over" });
  }

  if (!a.jn.contactId) {
    a.jn.contactId = await c.jn.findOrCreateContractorContact(co);
    await save(c, a);
  }
  if (!a.jn.jobId) {
    const found = await c.jn.findJobByExternalId(a.id); // a crash after create but before save left a job behind
    if (found) {
      a.jn.jobId = found;
      await audit(c, { assignmentId: a.id, actor, action: "job_recovered", detail: { jobId: found } });
    } else {
      const jobId = await c.jn.createJob({
        externalId: a.id,
        name: `${co.prefix ? co.prefix + ">" : ""}${a.data.homeowner_name || "Homeowner"} - ${a.data.property_address}`,
        primaryContactId: a.jn.contactId!,             // the assigning contractor: they are who we bill
        status: "Assigned",
        address: a.data.property_address || "",
        homeowner: { name: a.data.homeowner_name || "", phone: a.data.homeowner_phone || "" }, // job fields, not a contact
        description: describe(a, co),
      });
      c.hooks?.afterJobCreated?.();
      a.jn.jobId = jobId;
      await audit(c, { assignmentId: a.id, actor, action: "job_created", detail: { jobId, primaryContactId: a.jn.contactId } });
    }
    await save(c, a);
  }
  if (!a.jn.measurementTaskId) {
    a.jn.measurementTaskId = await c.jn.ensureTask(a.jn.jobId!, "measurement", {
      title: `Administrator: order roof measurement - ${a.data.property_address}`,
      description: `Order the QuickSquares report for ${a.data.property_address}. Assignment ${a.id}.`,
    });
    await save(c, a);
  }
  const queued = await queueMessage(c, {
    key: `${a.id}/measurement-request`,
    to: c.shadieEmail || "shadie@godawgsroofroof.com",
    subject: `Measurement order: ${a.data.property_address} (${a.id})`,
    body: [
      `New Peak 301 referral assignment ${a.id} from ${co.name}.`,
      `Property: ${a.data.property_address}`,
      `Homeowner: ${a.data.homeowner_name || "-"} ${a.data.homeowner_phone || ""}`.trim(),
      `Contractor's size estimate: ${a.data.roof_size ? a.data.roof_size + " sq" : "not given"}`,
      `JobNimbus job: ${a.jn.jobId}  ·  Task: ${a.jn.measurementTaskId}`,
      "",
      "Please order the roof measurement report and enter the squares on the job's Measurements tab.",
    ].join("\n"),
  });
  if (queued) await audit(c, { assignmentId: a.id, actor, action: "measurement_request_rendered", detail: { to: c.shadieEmail || "shadie@godawgsroofroof.com", sent: false } });
  await setState(c, a, "measurement_ordered", actor);
  await c.store.set(lockKey, { at: 0, done: true });
  return a;
}

function describe(a: Assignment, co: Company) {
  const d = a.data;
  return [
    `Peak 301 referral ${a.id} from ${co.name}`,
    `Submitted by: ${[d.contact_name, d.contact_phone, d.contact_email].filter(Boolean).join(" · ") || "-"}`,
    `Homeowner: ${d.homeowner_name || "-"} · ${d.homeowner_phone || "-"}`,
    `Property: ${d.property_address}`,
    `Roof (contractor): ${d.roof_size ? d.roof_size + " sq" : "size not given"} · Age ${d.roof_age || "-"} · ${d.roof_type || "-"}`,
    d.scope_notes ? `Notes: ${d.scope_notes}` : "",
  ].filter(Boolean).join("\n");
}

// ---------- review actions (admin) ----------

export async function approve(c: Ctx, id: string, companyKey: string, actor: string): Promise<Assignment> {
  const a = await getAssignment(c, id);
  if (!a) throw new Error(`No assignment ${id}`);
  if (a.state !== "needs_review") throw new Error(`Assignment ${id} is ${a.state}, not waiting for review`);
  const co = c.companies.find((x) => x.key === companyKey);
  if (!co) throw new Error(`Unknown contractor ${companyKey}`);
  if (!clean(a.data.property_address)) throw new Error("Add the property address before approving");
  a.companyKey = co.key;
  a.reviewReasons = [];
  await setState(c, a, "accepted", actor, { companyKey: co.key });
  return advance(c, id, actor);
}

export async function reject(c: Ctx, id: string, reason: string, actor: string): Promise<Assignment> {
  const a = await getAssignment(c, id);
  if (!a) throw new Error(`No assignment ${id}`);
  if (a.state !== "needs_review") throw new Error(`Assignment ${id} is ${a.state}, not waiting for review`);
  await setState(c, a, "rejected", actor, { reason });
  return a;
}

/** Folds a held copy into the real assignment: the copy is closed and its source event recorded on the original. */
export async function mergeInto(c: Ctx, id: string, intoId: string, actor: string): Promise<Assignment> {
  const a = await getAssignment(c, id);
  const into = await getAssignment(c, intoId);
  if (!a || !into) throw new Error("Assignment not found");
  if (a.state !== "needs_review") throw new Error(`Assignment ${id} is ${a.state}, not waiting for review`);
  into.sourceEvents.push(...a.sourceEvents);
  await save(c, into);
  await audit(c, { assignmentId: into.id, actor, action: "duplicate_merged", detail: { from: a.id } });
  a.duplicateOf = into.id;
  await setState(c, a, "rejected", actor, { reason: `Duplicate of ${into.id}` });
  return into;
}

// ---------- access (checked on the server for every request) ----------

export type Viewer = { role: "admin" | "viewer" | "partner"; companyKey?: string };

/** Partners see only their own company's assignments; held copies from unknown senders stay staff-only. */
export function canSee(v: Viewer, a: Assignment): boolean {
  if (v.role === "admin" || v.role === "viewer") return true;
  return !!v.companyKey && a.companyKey === v.companyKey && a.verified;
}

export async function visibleAssignments(c: Ctx, v: Viewer): Promise<Assignment[]> {
  if (v.role === "partner" && !v.companyKey) return [];
  const list = await listAssignments(c, v.role === "partner" ? { companyKey: v.companyKey } : {});
  return list.filter((a) => canSee(v, a));
}

export async function assignmentFor(c: Ctx, v: Viewer, id: string): Promise<Assignment | null> {
  const a = await getAssignment(c, id);
  return a && canSee(v, a) ? a : null; // "not found" either way: never confirm another partner's job exists
}
