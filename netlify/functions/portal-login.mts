import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { accounts, handleError, HttpError, json, makeToken, matchCode, publicAccount } from "../lib/portal.mts";

// POST { code } -> a signed session for that contractor (or GDRR admin).
// Guessing is slowed (0.8 s per wrong code) and capped: 8 wrong codes from one address in 15 minutes
// locks that address out for 15 minutes.
const MAX_FAILS = 8;
const WINDOW_MS = 15 * 60_000;

export default async (req: Request, context: Context) => {
  try {
    if (req.method !== "POST") throw new HttpError(405, "Use POST.");
    const ip = context.ip || req.headers.get("x-nf-client-connection-ip") || "unknown";
    const store = getStore({ name: "portal-logins", consistency: "strong" });
    const key = `ip-${ip.replace(/[^0-9a-fA-F:.]/g, "_")}`;
    let rec: { fails: number; first: number } | null = null;
    try { rec = (await store.get(key, { type: "json" })) as any; } catch (e) { console.error("login throttle read failed", e); }
    if (rec && Date.now() - rec.first > WINDOW_MS) rec = null;
    if (rec && rec.fails >= MAX_FAILS) {
      throw new HttpError(429, "Too many tries. Please wait 15 minutes, or call 404-323-1869 for help.");
    }

    const { code } = await req.json().catch(() => ({ code: "" }));
    const session = typeof code === "string" && code.trim() ? matchCode(code) : null;
    if (!session) {
      try { await store.setJSON(key, { fails: (rec?.fails || 0) + 1, first: rec?.first || Date.now() }); } catch (e) { console.error("login throttle write failed", e); }
      await new Promise((r) => setTimeout(r, 800));
      throw new HttpError(401, "That code didn't match an account. Check it and try again, or call 404-323-1869.");
    }
    if (rec) { try { await store.delete(key); } catch {} }
    const all = accounts();
    return json({
      token: makeToken(session),
      role: session.role,
      accounts: session.role === "admin" ? all.map(publicAccount) : all.filter((a) => a.key === session.key).map(publicAccount),
    });
  } catch (e) {
    return handleError(e);
  }
};

export const config: Config = { path: "/api/portal/login", method: "POST" };
