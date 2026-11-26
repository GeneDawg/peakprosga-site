import type { Config, Context } from "@netlify/functions";
import { randomBytes } from "node:crypto";
import { accounts, handleError, HttpError, json, makeToken, partnerSession, readSession, type Session } from "../lib/portal.mts";
import { blobsStore, memoryStore, type Store } from "../lib/ops/store.mts";
import { jobNimbusAdapter } from "../lib/ops/adapters/jobnimbus.mts";
import { parseAssignmentEmail } from "../lib/ops/adapters/inbox.mts";
import {
  advance, approve, assignmentFor, auditTrail, ingest, mergeInto, outbox, reject, visibleAssignments,
  type Ctx, type Viewer,
} from "../lib/ops/core.mts";
import { InviteError, issueInvite, listInvites, redeemInvite, reissueInvite, revokeInvite } from "../lib/ops/invites.mts";

// Ops API: Milestone 1 Georgia sandbox (docs/BLUEPRINT.md).
// Answers ONLY when OPS_SANDBOX=1 is set on the site/branch; otherwise every route is 404, so this file is inert
// on the live site. Everything here is mock data: JobNimbus is simulated, nothing is emailed or texted.
//
//   GET  /api/ops/assignments            staff: all · partner: own company only
//   GET  /api/ops/assignment?id=         one assignment + audit trail + mock JobNimbus job + rendered messages
//   POST /api/ops/review                 admin: { id, action: approve|reject|merge, companyKey?, reason?, into? }
//   GET  /api/ops/invites                admin
//   POST /api/ops/invites                admin: { action: issue|revoke|reissue, companyKey?, email?, id? }
//   POST /api/ops/invite/redeem          public: { token, email } -> partner session (sandbox screens only)
//   POST /api/ops/sandbox/form           admin: simulate a form submission { data, asCompany?, eventId? }
//   POST /api/ops/sandbox/email          admin: simulate an assignment-inbox email { from, body, messageId? }
//   POST /api/ops/sandbox/reset          admin: wipe the sandbox store

const on = () => Netlify.env.get("OPS_SANDBOX") === "1";

let mem: Store | null = null; // OPS_STORE=memory: local runs and the API tests, no Netlify Blobs needed
async function ctx(): Promise<Ctx> {
  const store = Netlify.env.get("OPS_STORE") === "memory" ? (mem ||= memoryStore()) : await blobsStore("ops-sandbox");
  return {
    store,
    jn: jobNimbusAdapter(Netlify.env.get("OPS_JN_MODE") || "mock", store),
    companies: accounts().map((a) => ({ key: a.key, name: a.name, prefix: a.prefix, emailDomains: a.emailDomains, contactNames: a.contactNames })),
    market: "GA",
    shadieEmail: Netlify.env.get("OPS_ADMINISTRATOR_EMAIL") || "shadie@godawgsroofroof.com",
  };
}

const viewerOf = (s: Session): Viewer => ({ role: s.role, companyKey: s.role === "partner" ? s.key : undefined });
const who = (s: Session) => (s.role === "partner" ? `partner:${s.key}` : `${s.role}:gdrr`);
function requireAdmin(s: Session) { if (s.role !== "admin") throw new HttpError(403, "Only a GDRR admin can do that."); }

export default async (req: Request, _context: Context) => {
  try {
    if (!on()) return new Response("Not found", { status: 404 });
    const url = new URL(req.url);
    const route = url.pathname.replace(/^\/api\/ops\/?/, "");
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const c = await ctx();

    if (route === "invite/redeem" && req.method === "POST") {
      try {
        const inv = await redeemInvite(c, String(body.token || ""), String(body.email || ""));
        const s = partnerSession(inv.companyKey);
        const acct = accounts().find((a) => a.key === inv.companyKey)!;
        return json({ token: makeToken(s), role: "partner", company: { key: acct.key, name: acct.name }, sandbox: true });
      } catch (e) {
        if (e instanceof InviteError) throw new HttpError(400, e.message);
        throw e;
      }
    }

    const s = readSession(req);
    const v = viewerOf(s);

    if (route === "assignments" && req.method === "GET") {
      const list = await visibleAssignments(c, v);
      return json({ assignments: list, jnMode: c.jn.mode, sandbox: true });
    }

    if (route === "assignment" && req.method === "GET") {
      const a = await assignmentFor(c, v, url.searchParams.get("id") || "");
      if (!a) throw new HttpError(404, "Assignment not found.");
      if (v.role === "partner") return json({ assignment: a });
      const [trail, msgs, job] = await Promise.all([auditTrail(c, a.id), outbox(c, a.id + "/"), a.jn.jobId ? c.jn.getJob(a.jn.jobId) : null]);
      const contact = job ? await c.store.get(`jn/contact/${job.primary.id}`) : null;
      return json({ assignment: a, audit: trail, outbox: msgs, mockJob: job, mockContact: contact });
    }

    if (route === "review" && req.method === "POST") {
      requireAdmin(s);
      const id = String(body.id || "");
      if (body.action === "approve") return json({ assignment: await approve(c, id, String(body.companyKey || ""), who(s)) });
      if (body.action === "reject") return json({ assignment: await reject(c, id, String(body.reason || "Rejected by admin"), who(s)) });
      if (body.action === "merge") return json({ assignment: await mergeInto(c, id, String(body.into || ""), who(s)) });
      throw new HttpError(400, "Unknown review action.");
    }

    if (route === "invites") {
      requireAdmin(s);
      if (req.method === "GET") return json({ invites: await listInvites(c) });
      const base = `${url.origin}/partners/invite.html?t=`;
      if (body.action === "issue") {
        const r = await issueInvite(c, { companyKey: String(body.companyKey || ""), email: String(body.email || ""), issuedBy: who(s) });
        return json({ invite: r.invite, link: base + r.token, note: "Sandbox: this link is shown here only and is never emailed." });
      }
      if (body.action === "revoke") return json({ invite: await revokeInvite(c, String(body.id || ""), who(s)) });
      if (body.action === "reissue") {
        const r = await reissueInvite(c, String(body.id || ""), who(s));
        return json({ invite: r.invite, link: base + r.token });
      }
      throw new HttpError(400, "Unknown invite action.");
    }

    if (route === "sandbox/form" && req.method === "POST") {
      requireAdmin(s);
      const companyKey = body.asCompany ? String(body.asCompany) : null; // as if the partner were signed in
      const r = await ingest(c, { source: "form", sourceEventId: String(body.eventId || "sim-" + randomBytes(6).toString("hex")), data: body.data || {}, companyKey, actor: "sandbox:form" });
      const a = r.assignment.state === "accepted" ? await advance(c, r.assignment.id) : r.assignment;
      return json({ outcome: r.outcome, assignment: a });
    }

    if (route === "sandbox/email" && req.method === "POST") {
      requireAdmin(s);
      const email = { messageId: String(body.messageId || `<sim-${randomBytes(6).toString("hex")}@sandbox>`), from: String(body.from || ""), body: String(body.body || "") };
      const r = await ingest(c, { source: "inbox", sourceEventId: email.messageId, data: parseAssignmentEmail(email), actor: "sandbox:inbox" });
      const a = r.assignment.state === "accepted" ? await advance(c, r.assignment.id) : r.assignment;
      return json({ outcome: r.outcome, assignment: a });
    }

    if (route === "sandbox/reset" && req.method === "POST") {
      requireAdmin(s);
      await c.store.clear();
      return json({ ok: true });
    }

    throw new HttpError(404, "Unknown Ops route.");
  } catch (e) {
    if (e instanceof Error && !(e instanceof HttpError) && /^(No assignment|Assignment |Unknown contractor|Add the property|Enter a valid|Invite not found)/.test(e.message))
      return handleError(new HttpError(400, e.message));
    return handleError(e);
  }
};

export const config: Config = { path: ["/api/ops/*"] };
