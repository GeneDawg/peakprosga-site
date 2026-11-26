// Single-use partner invites: replaces handing out long-lived shared access codes.
//  - The link carries a random token; only its SHA-256 hash is stored, so a leaked store can't be replayed.
//  - Tied to one email address, expires (72 h by default), works once, can be revoked or reissued.
//  - Redeeming proves the person is the invited partner; the portal then signs them in to that company only.
// In the Milestone 1 sandbox the link is shown to the admin on screen and never emailed.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Ctx } from "./core.mts";
import { audit } from "./core.mts";

export type Invite = {
  id: string; companyKey: string; email: string; tokenHash: string;
  issuedBy: string; issuedAt: string; expiresAt: string;
  usedAt?: string | null; revokedAt?: string | null; revokedBy?: string | null; replacedBy?: string | null;
};

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
const now = (c: Ctx) => (c.now ? c.now() : Date.now());

export async function issueInvite(c: Ctx, p: { companyKey: string; email: string; issuedBy: string; hours?: number }) {
  if (!c.companies.some((x) => x.key === p.companyKey)) throw new Error(`Unknown contractor ${p.companyKey}`);
  const email = p.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Enter a valid email address");
  const token = randomBytes(24).toString("base64url");
  const id = "inv_" + randomBytes(6).toString("hex");
  const t = now(c);
  const inv: Invite = {
    id, companyKey: p.companyKey, email, tokenHash: hash(token), issuedBy: p.issuedBy,
    issuedAt: new Date(t).toISOString(), expiresAt: new Date(t + (p.hours ?? 72) * 3600_000).toISOString(),
    usedAt: null, revokedAt: null,
  };
  await c.store.set(`invite/${id}`, inv);
  await c.store.set(`invite-token/${inv.tokenHash}`, { id });
  await audit(c, { assignmentId: `partner:${p.companyKey}`, actor: p.issuedBy, action: "invite_issued", detail: { id, email, expiresAt: inv.expiresAt } });
  return { invite: inv, token };
}

export async function listInvites(c: Ctx): Promise<Invite[]> {
  const keys = await c.store.list("invite/");
  return ((await Promise.all(keys.map((k) => c.store.get<Invite>(k)))).filter(Boolean) as Invite[]).sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
}

export async function revokeInvite(c: Ctx, id: string, by: string) {
  const inv = await c.store.get<Invite>(`invite/${id}`);
  if (!inv) throw new Error("Invite not found");
  if (!inv.revokedAt) {
    inv.revokedAt = new Date(now(c)).toISOString();
    inv.revokedBy = by;
    await c.store.set(`invite/${id}`, inv);
    await audit(c, { assignmentId: `partner:${inv.companyKey}`, actor: by, action: "invite_revoked", detail: { id } });
  }
  return inv;
}

/** Revokes the old invite and issues a fresh one to the same person. */
export async function reissueInvite(c: Ctx, id: string, by: string) {
  const old = await revokeInvite(c, id, by);
  const next = await issueInvite(c, { companyKey: old.companyKey, email: old.email, issuedBy: by });
  old.replacedBy = next.invite.id;
  await c.store.set(`invite/${id}`, old);
  return next;
}

export class InviteError extends Error {}

/** One use only, even if the link is opened twice at the same moment. */
export async function redeemInvite(c: Ctx, token: string, email?: string): Promise<Invite> {
  const bad = new InviteError("This invite link isn't valid. Ask Peak 301 Pros for a new one.");
  if (!token || token.length < 20) throw bad;
  const h = hash(token);
  const ref = await c.store.get<{ id: string }>(`invite-token/${h}`);
  const inv = ref ? await c.store.get<Invite>(`invite/${ref.id}`) : null;
  if (!inv || !timingSafeEqual(Buffer.from(inv.tokenHash), Buffer.from(h))) throw bad;
  if (inv.revokedAt) throw new InviteError("This invite was cancelled. Ask Peak 301 Pros for a new one.");
  if (inv.usedAt) throw new InviteError("This invite has already been used. Sign in with your account, or ask for a new invite.");
  if (now(c) > Date.parse(inv.expiresAt)) throw new InviteError("This invite has expired. Ask Peak 301 Pros for a new one.");
  if (email && email.trim().toLowerCase() !== inv.email) throw new InviteError("This invite was sent to a different email address.");
  if (!(await c.store.createIfAbsent(`invite-used/${inv.id}`, { at: now(c) }))) throw new InviteError("This invite has already been used. Sign in with your account, or ask for a new invite.");
  inv.usedAt = new Date(now(c)).toISOString();
  await c.store.set(`invite/${inv.id}`, inv);
  await audit(c, { assignmentId: `partner:${inv.companyKey}`, actor: `partner:${inv.email}`, action: "invite_redeemed", detail: { id: inv.id } });
  return inv;
}
