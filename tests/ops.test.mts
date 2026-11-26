// Milestone 1 acceptance tests (docs/BLUEPRINT.md, "Acceptance checklist"). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryStore } from "../netlify/lib/ops/store.mts";
import { mockJobNimbus } from "../netlify/lib/ops/adapters/jobnimbus.mts";
import { parseAssignmentEmail } from "../netlify/lib/ops/adapters/inbox.mts";
import {
  ingest, advance, approve, mergeInto, auditTrail, outbox, listAssignments, visibleAssignments, assignmentFor,
  normalizeAddress, type Ctx,
} from "../netlify/lib/ops/core.mts";
import { issueInvite, redeemInvite, revokeInvite, reissueInvite } from "../netlify/lib/ops/invites.mts";

const COMPANIES = [
  { key: "ngrg", name: "North Georgia Roofing and Gutters", prefix: "NG", emailDomains: ["ngrg-test.example"] },
  { key: "peachpeak", name: "Peach Peak Roofing", prefix: "PP", emailDomains: ["peachpeak-test.example"] },
];

function ctx(over: Partial<Ctx> = {}): Ctx {
  const store = memoryStore();
  let t = Date.parse("2026-12-01T14:00:00Z");
  return { store, jn: mockJobNimbus(store), companies: COMPANIES, market: "GA", now: () => t, ...over, ...(over.now ? {} : { now: () => t }) };
}

const JOB = {
  company: "North Georgia Roofing and Gutters", contact_name: "Test Contact", contact_email: "office@ngrg-test.example",
  homeowner_name: "Pat Sample", homeowner_phone: "555-0100", property_address: "123 Test Lane, Duluth, GA 30096", roof_size: "28",
};
const form = (id: string, data = JOB, companyKey: string | null = "ngrg") => ({ source: "form" as const, sourceEventId: id, data, companyKey });

async function jobsIn(c: Ctx) { return (await c.jn.listJobs()).length; }

test("same form submission delivered twice -> one assignment, one JobNimbus job", async () => {
  const c = ctx();
  const r1 = await ingest(c, form("sub-1"));
  await advance(c, r1.assignment.id);
  const r2 = await ingest(c, form("sub-1"));
  await advance(c, r2.assignment.id);
  assert.equal(r2.outcome, "replay");
  assert.equal(r2.assignment.id, r1.assignment.id);
  assert.equal((await listAssignments(c)).length, 1);
  assert.equal(await jobsIn(c), 1);
});

test("same job submitted again as a new form within 7 days -> attached, not a second job", async () => {
  const c = ctx();
  const r1 = await ingest(c, form("sub-1"));
  await advance(c, r1.assignment.id);
  const r2 = await ingest(c, form("sub-2", { ...JOB, property_address: "123 TEST LN., Duluth, Georgia 30096" }));
  assert.equal(r2.outcome, "duplicate");
  assert.equal(r2.assignment.id, r1.assignment.id);
  await advance(c, r2.assignment.id);
  assert.equal(await jobsIn(c), 1);
});

test("form + matching email to the assignment inbox -> one assignment, one job", async () => {
  const c = ctx();
  const r1 = await ingest(c, form("sub-1"));
  await advance(c, r1.assignment.id);
  const email = {
    messageId: "<abc@mail>", from: "NGRG Office <office@ngrg-test.example>", subject: "New Peak job",
    body: "Homeowner: Pat Sample\nProperty address: 123 Test Ln, Duluth GA 30096\nRoof size: 28 sq\n",
  };
  const r2 = await ingest(c, { source: "inbox", sourceEventId: email.messageId, data: parseAssignmentEmail(email) });
  assert.equal(r2.outcome, "duplicate");
  assert.equal(r2.assignment.id, r1.assignment.id);
  assert.equal(await jobsIn(c), 1);
});

test("email arrives first (held), then the signed-in form -> same assignment, accepted, one job", async () => {
  const c = ctx();
  const email = { messageId: "<first@mail>", from: "office@ngrg-test.example", body: "Homeowner: Pat Sample\nAddress: 123 Test Lane, Duluth, GA 30096" };
  const r1 = await ingest(c, { source: "inbox", sourceEventId: email.messageId, data: parseAssignmentEmail(email) });
  assert.equal(r1.assignment.state, "needs_review");
  const r2 = await ingest(c, form("sub-9"));
  assert.equal(r2.assignment.id, r1.assignment.id);
  assert.equal(r2.assignment.state, "accepted");
  await advance(c, r2.assignment.id);
  assert.equal(await jobsIn(c), 1);
});

test("unverified copy of an open address is held next to the original and can be merged", async () => {
  const c = ctx();
  const r1 = await ingest(c, form("sub-1"));
  await advance(c, r1.assignment.id);
  const r2 = await ingest(c, form("anon-1", { ...JOB, company: "", contact_email: "someone@gmail.com" }, null));
  assert.equal(r2.outcome, "suggested_duplicate");
  assert.equal(r2.assignment.state, "needs_review");
  assert.equal(r2.assignment.duplicateOf, r1.assignment.id);
  await mergeInto(c, r2.assignment.id, r1.assignment.id, "admin:test");
  assert.equal(await jobsIn(c), 1);
});

test("10 simultaneous copies of one job -> one assignment, one job", async () => {
  const c = ctx();
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => ingest(c, form(`burst-${i}`))));
  const ids = new Set(results.map((r) => r.assignment.id));
  assert.equal(ids.size, 1);
  await Promise.all([...ids, ...ids].map((id) => advance(c, id)));
  assert.equal(await jobsIn(c), 1);
});

test("crash after JobNimbus created the job -> retry resumes with no second job", async () => {
  let t = Date.parse("2026-12-01T14:00:00Z");
  const c = ctx({ now: () => t });
  const r = await ingest(c, form("sub-1"));
  let crash = true;
  c.hooks = { afterJobCreated: () => { if (crash) { crash = false; throw new Error("simulated crash"); } } };
  await assert.rejects(advance(c, r.assignment.id), /simulated crash/);
  assert.equal(await jobsIn(c), 1);
  t += 5 * 60_000; // the crashed worker's lock goes stale
  const a = await advance(c, r.assignment.id);
  assert.equal(a.state, "measurement_ordered");
  assert.equal(await jobsIn(c), 1);
  assert.ok((await auditTrail(c, a.id)).some((e) => e.action === "job_recovered"));
});

test("job is filed under the assigning contractor; homeowner is job detail, not the contact", async () => {
  const c = ctx();
  const r = await ingest(c, form("sub-1"));
  const a = await advance(c, r.assignment.id);
  const job = await c.jn.getJob(a.jn.jobId!);
  const contact = await c.store.get(`jn/contact/${job.primary.id}`);
  assert.equal(contact.display_name, "North Georgia Roofing and Gutters");
  assert.equal(job["Homeowner Name"], "Pat Sample");
  assert.equal(job["Assignment ID"], a.id);
  assert.match(a.id, /^GA-2026-[2-9A-HJ-NP-Z]{6}$/);
});

test("measurement request rendered once for the Administrator, never sent", async () => {
  const c = ctx();
  const r = await ingest(c, form("sub-1"));
  await advance(c, r.assignment.id);
  await advance(c, r.assignment.id);
  const msgs = await outbox(c);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].status, "not_sent");
  assert.equal(msgs[0].to, "shadie@godawgsroofroof.com");
});

test("partners cannot see each other's assignments", async () => {
  const c = ctx();
  const a = (await ingest(c, form("sub-1"))).assignment;
  const b = (await ingest(c, form("sub-2", { ...JOB, contact_email: "x@peachpeak-test.example", property_address: "9 Other St, Lawrenceville, GA 30043" }, "peachpeak"))).assignment;
  const ngrg = { role: "partner" as const, companyKey: "ngrg" };
  const seen = await visibleAssignments(c, ngrg);
  assert.deepEqual(seen.map((x) => x.id), [a.id]);
  assert.equal(await assignmentFor(c, ngrg, b.id), null);
  assert.equal((await visibleAssignments(c, { role: "partner" })).length, 0); // no company on the session = nothing
  assert.equal((await visibleAssignments(c, { role: "admin" })).length, 2);
});

test("incomplete or unmatched submissions go to review; approve then creates exactly one job", async () => {
  const c = ctx();
  const r = await ingest(c, form("anon-2", { ...JOB, company: "Unknown Roofing", contact_email: "a@unknown.example", property_address: "77 Nowhere Rd, Marietta, GA 30060" }, null));
  assert.equal(r.assignment.state, "needs_review");
  assert.ok(r.assignment.reviewReasons.length >= 2);
  assert.equal(await jobsIn(c), 0);
  await approve(c, r.assignment.id, "peachpeak", "admin:test");
  await advance(c, r.assignment.id);
  assert.equal(await jobsIn(c), 1);
});

test("every state change is in the audit trail with actor and time", async () => {
  const c = ctx();
  const r = await ingest(c, form("sub-1"));
  await advance(c, r.assignment.id);
  const trail = await auditTrail(c, r.assignment.id);
  const states = trail.filter((e) => e.action === "state").map((e) => `${e.from}->${e.to}`);
  assert.deepEqual(states, ["received->accepted", "accepted->measurement_ordered"]);
  assert.ok(trail.every((e) => e.actor && e.at));
});

test("invites: single use, expire, revoke, reissue, bound to one email", async () => {
  let t = Date.parse("2026-12-01T14:00:00Z");
  const c = ctx({ now: () => t });
  const { token } = await issueInvite(c, { companyKey: "ngrg", email: "Owner@NGRG-test.example", issuedBy: "admin:gene" });
  await assert.rejects(redeemInvite(c, token, "other@ngrg-test.example"), /different email/);
  const inv = await redeemInvite(c, token, "owner@ngrg-test.example");
  assert.equal(inv.companyKey, "ngrg");
  await assert.rejects(redeemInvite(c, token), /already been used/);

  const late = await issueInvite(c, { companyKey: "ngrg", email: "late@ngrg-test.example", issuedBy: "admin:gene" });
  t += 73 * 3600_000;
  await assert.rejects(redeemInvite(c, late.token), /expired/);

  const r = await issueInvite(c, { companyKey: "peachpeak", email: "neil@peachpeak-test.example", issuedBy: "admin:gene" });
  await revokeInvite(c, r.invite.id, "admin:gene");
  await assert.rejects(redeemInvite(c, r.token), /cancelled/);

  const r2 = await issueInvite(c, { companyKey: "peachpeak", email: "neil@peachpeak-test.example", issuedBy: "admin:gene" });
  const fresh = await reissueInvite(c, r2.invite.id, "admin:gene");
  await assert.rejects(redeemInvite(c, r2.token), /cancelled/);
  assert.equal((await redeemInvite(c, fresh.token)).companyKey, "peachpeak");

  const race = await issueInvite(c, { companyKey: "ngrg", email: "race@ngrg-test.example", issuedBy: "admin:gene" });
  const outcomes = await Promise.allSettled([redeemInvite(c, race.token), redeemInvite(c, race.token), redeemInvite(c, race.token)]);
  assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
  await assert.rejects(redeemInvite(c, "x".repeat(32)), /isn't valid/);
});

test("JobNimbus live / test-board modes refuse to run in Milestone 1", async () => {
  const { jobNimbusAdapter } = await import("../netlify/lib/ops/adapters/jobnimbus.mts");
  assert.throws(() => jobNimbusAdapter("live", memoryStore()), /not available in Milestone 1/);
  assert.throws(() => jobNimbusAdapter("test-board", memoryStore()), /not available in Milestone 1/);
});

test("address normalisation treats common spellings as the same place", () => {
  assert.equal(normalizeAddress("123 Test Lane, Duluth, Georgia 30096-1234"), normalizeAddress("123 test ln. duluth ga 30096"));
});
