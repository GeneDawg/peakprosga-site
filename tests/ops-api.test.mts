// API-level checks for netlify/functions/ops.mts: permissions are enforced on the server, and the whole API is
// inert unless OPS_SANDBOX=1. Uses an in-memory store and a stand-in for the Netlify runtime.
import { test } from "node:test";
import assert from "node:assert/strict";

const ENV: Record<string, string> = {
  OPS_SANDBOX: "1", OPS_STORE: "memory", PORTAL_SESSION_SECRET: "test-secret-not-real", PORTAL_ADMIN_CODE: "ADMIN-TEST-1",
  PORTAL_ACCOUNTS: JSON.stringify([
    { key: "ngrg", name: "North Georgia Roofing and Gutters", prefix: "NG", code: "NG-TEST-1", emailDomains: ["ngrg-test.example"], contactId: "x1" },
    { key: "peachpeak", name: "Peach Peak Roofing", prefix: "PP", code: "PP-TEST-1", emailDomains: ["peachpeak-test.example"], contactId: "x2" },
  ]),
};
(globalThis as any).Netlify = { env: { get: (k: string) => ENV[k] } };
const { default: handler } = await import("../netlify/functions/ops.mts");
const { makeToken, matchCode } = await import("../netlify/lib/portal.mts");

const tok = (code: string) => makeToken(matchCode(code)!);
const ADMIN = tok("ADMIN-TEST-1"), NG = tok("NG-TEST-1"), PP = tok("PP-TEST-1");
async function call(path: string, token?: string, body?: unknown) {
  const res = await handler(new Request("https://sandbox.test" + path, {
    method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), {} as any);
  return { status: res.status, body: await res.json().catch(() => null) };
}
const job = (addr: string) => ({ homeowner_name: "Pat Sample", property_address: addr, roof_size: "28" });

test("partner A cannot list, open or guess partner B's assignment", async () => {
  const a = await call("/api/ops/sandbox/form", ADMIN, { asCompany: "ngrg", data: job("1 Alpha St, Duluth, GA 30096") });
  const b = await call("/api/ops/sandbox/form", ADMIN, { asCompany: "peachpeak", data: job("2 Beta St, Duluth, GA 30096") });
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  const mine = await call("/api/ops/assignments", NG);
  assert.deepEqual(mine.body.assignments.map((x: any) => x.id), [a.body.assignment.id]);
  assert.equal((await call(`/api/ops/assignment?id=${b.body.assignment.id}`, NG)).status, 404);
  const own = await call(`/api/ops/assignment?id=${a.body.assignment.id}`, NG);
  assert.equal(own.status, 200);
  assert.equal(own.body.audit, undefined); // partners don't get internal audit/outbox detail
});

test("partners and anonymous callers can't use admin routes", async () => {
  assert.equal((await call("/api/ops/assignments")).status, 401);
  assert.equal((await call("/api/ops/sandbox/form", NG, { asCompany: "ngrg", data: job("3 C St, Duluth, GA 30096") })).status, 403);
  assert.equal((await call("/api/ops/invites", PP)).status, 403);
  assert.equal((await call("/api/ops/review", NG, { id: "x", action: "approve", companyKey: "ngrg" })).status, 403);
  assert.equal((await call("/api/ops/sandbox/reset", PP, {})).status, 403);
});

test("invite link signs the partner in to their own company only, once", async () => {
  const r = await call("/api/ops/invites", ADMIN, { action: "issue", companyKey: "peachpeak", email: "neil@peachpeak-test.example" });
  const token = new URL(r.body.link).searchParams.get("t");
  const ok = await call("/api/ops/invite/redeem", undefined, { token, email: "neil@peachpeak-test.example" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.company.key, "peachpeak");
  const seen = await call("/api/ops/assignments", ok.body.token);
  assert.ok(seen.body.assignments.every((x: any) => x.companyKey === "peachpeak"));
  assert.equal((await call("/api/ops/invite/redeem", undefined, { token, email: "neil@peachpeak-test.example" })).status, 400);
});

test("replaying the same form event through the API creates one job", async () => {
  const body = { asCompany: "ngrg", eventId: "netlify-sub-777", data: job("44 Replay Rd, Duluth, GA 30096") };
  const r1 = await call("/api/ops/sandbox/form", ADMIN, body);
  const r2 = await call("/api/ops/sandbox/form", ADMIN, body);
  assert.equal(r2.body.outcome, "replay");
  assert.equal(r2.body.assignment.id, r1.body.assignment.id);
  const d = await call(`/api/ops/assignment?id=${r1.body.assignment.id}`, ADMIN);
  assert.equal(d.body.mockContact.display_name, "North Georgia Roofing and Gutters");
  assert.equal(d.body.outbox.length, 1);
  assert.equal(d.body.outbox[0].status, "not_sent");
});

test("with OPS_SANDBOX off, every Ops route is 404", async () => {
  ENV.OPS_SANDBOX = "";
  try {
    assert.equal((await call("/api/ops/assignments", ADMIN)).status, 404);
    assert.equal((await call("/api/ops/invite/redeem", undefined, { token: "x" })).status, 404);
  } finally { ENV.OPS_SANDBOX = "1"; }
});
