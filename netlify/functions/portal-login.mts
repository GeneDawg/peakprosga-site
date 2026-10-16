import type { Config } from "@netlify/functions";
import { accounts, handleError, HttpError, json, makeToken, matchCode, publicAccount } from "../lib/portal.mts";

// POST { code } -> a signed session for that contractor (or GDRR admin).
export default async (req: Request) => {
  try {
    if (req.method !== "POST") throw new HttpError(405, "Use POST.");
    const { code } = await req.json().catch(() => ({ code: "" }));
    const session = typeof code === "string" && code.trim() ? matchCode(code) : null;
    if (!session) {
      await new Promise((r) => setTimeout(r, 800)); // slow down guessing
      throw new HttpError(401, "That code didn't match an account. Check it and try again, or call 404-323-1869.");
    }
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
