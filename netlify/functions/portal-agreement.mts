import type { Config, Context } from "@netlify/functions";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { accounts, allowedAccounts, fillContactIds, handleError, HttpError, json, readSession } from "../lib/portal.mts";
import { AGREEMENT_TITLE, AGREEMENT_VERSION, agreementPayload, getAck, INTRO, saveAck, SECTIONS, type Ack } from "../lib/agreement.mts";

// GET                       -> the agreement text and whether this partner has accepted it
// GET ?status=all           -> staff only: acceptance status for every partner
// GET ?pdf=1[&account=key]  -> a PDF copy of the agreement with the partner's acceptance record
// POST { name, title, email, agree:true } -> partner accepts the current version
export default async (req: Request, context: Context) => {
  try {
    const s = readSession(req);
    const url = new URL(req.url);

    if (req.method === "POST") {
      if (s.role !== "partner" || !s.key) throw new HttpError(403, "Only a partner account can accept the agreement.");
      const b = await req.json().catch(() => ({}));
      const clean = (v: any, max = 120) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
      const name = clean(b.name), title = clean(b.title), email = clean(b.email, 160);
      if (b.agree !== true) throw new HttpError(400, "Please check the box to accept the agreement.");
      if (name.split(" ").filter(Boolean).length < 2) throw new HttpError(400, "Please type your full first and last name.");
      if (!title) throw new HttpError(400, "Please enter your title.");
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "Please enter a valid email for notices.");
      const acct = accounts().find((a) => a.key === s.key)!;
      const ack: Ack = {
        version: AGREEMENT_VERSION, mode: "acknowledge", account: acct.key, company: acct.name,
        name, title, email, at: new Date().toISOString(),
        ip: context.ip || req.headers.get("x-nf-client-connection-ip") || "",
        ua: (req.headers.get("user-agent") || "").slice(0, 200),
      };
      await saveAck(ack);
      console.log("agreement accepted", JSON.stringify({ account: ack.account, name: ack.name, at: ack.at, version: ack.version }));
      return json({ ok: true, ack: { name: ack.name, at: ack.at, version: ack.version } });
    }

    if (url.searchParams.get("status") === "all") {
      if (s.role === "partner") throw new HttpError(403, "Not allowed.");
      await fillContactIds();
      const rows = await Promise.all(accounts().map(async (a) => {
        const k = await getAck(a.key);
        return { account: a.key, name: a.name, jobnimbusLinked: !!a.contactId, accepted: !!k, by: k?.name || null, title: k?.title || null, at: k?.at || null };
      }));
      return json({ version: AGREEMENT_VERSION, partners: rows });
    }

    if (url.searchParams.get("pdf")) {
      const [acct] = allowedAccounts(s, s.role === "partner" ? s.key : url.searchParams.get("account"));
      if (!acct) throw new HttpError(404, "That contractor account was not found.");
      const ack = await getAck(acct.key);
      const bytes = await agreementPdf(acct.name, ack);
      return new Response(bytes, {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": `inline; filename="Peak301Pros-MSA-${acct.key}.pdf"`,
          "cache-control": "no-store",
        },
      });
    }

    const mine = s.role === "partner" && s.key ? await getAck(s.key) : null;
    return json({
      ...agreementPayload(),
      company: s.role === "partner" ? accounts().find((a) => a.key === s.key)?.name : null,
      accepted: s.role !== "partner" || !!mine,
      ack: mine ? { name: mine.name, title: mine.title, at: mine.at } : null,
    });
  } catch (e) {
    return handleError(e);
  }
};

/** Plain, printable copy of the agreement with the acceptance record at the end. */
export async function agreementPdf(company: string, ack: Ack | null): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 612, H = 792, M = 54, LINE = 13.5;
  let page = doc.addPage([W, H]);
  let y = H - M;
  const safe = (t: string) => t.replace(/[^\x20-\x7E]/g, (c) => ({ "’": "'", "‘": "'", "“": '"', "”": '"', "–": "-", "—": "-" } as any)[c] ?? "");
  const write = (text: string, opts: { f?: any; size?: number; indent?: number; gap?: number; color?: any } = {}) => {
    const f = opts.f || font, size = opts.size || 10, indent = opts.indent || 0;
    const words = safe(text).split(" ");
    let line = "";
    const flush = () => {
      if (y < M + LINE) { page = doc.addPage([W, H]); y = H - M; }
      page.drawText(line, { x: M + indent, y, size, font: f, color: opts.color || rgb(0.1, 0.1, 0.1) });
      y -= size + 3.5; line = "";
    };
    for (const w of words) {
      const test = line ? line + " " + w : w;
      if (f.widthOfTextAtSize(test, size) > W - 2 * M - indent) flush();
      line = line ? line + " " + w : w;
    }
    if (line) flush();
    y -= opts.gap ?? 4;
  };
  write("PEAK 301 PROS", { f: bold, size: 9, color: rgb(0.78, 0.07, 0.15) });
  write(AGREEMENT_TITLE, { f: bold, size: 16, gap: 2 });
  write(`Version ${AGREEMENT_VERSION}  |  Partner: ${company}`, { size: 9, gap: 10, color: rgb(0.4, 0.4, 0.4) });
  for (const p of INTRO) write(p, { gap: 8 });
  for (const sec of SECTIONS) {
    write(sec.h, { f: bold, size: 11, gap: 3 });
    for (const p of sec.p || []) write(p, { gap: 6 });
    (sec.list || []).forEach((t) => write("-  " + t, { indent: 8, gap: 3 }));
    (sec.ol || []).forEach((t, i) => write(`${i + 1}.  ${t}`, { indent: 8, gap: 3 }));
    y -= 6;
  }
  y -= 6;
  write("Partner acceptance record", { f: bold, size: 12, gap: 4 });
  if (ack) {
    const when = new Date(ack.at).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "long", timeStyle: "short" }) + " ET";
    for (const t of [
      `Company: ${ack.company}`,
      `Accepted by: ${ack.name}, ${ack.title}`,
      `Email for notices: ${ack.email}`,
      `Date and time: ${when}`,
      `Method: typed name and checkbox in the Peak 301 Pros partner dashboard (${ack.mode})`,
      `Network address: ${ack.ip || "not recorded"}`,
    ]) write(t, { gap: 2 });
  } else {
    write("Not yet accepted.", { gap: 2 });
  }
  return doc.save();
}

export const config: Config = { path: "/api/portal/agreement", method: ["GET", "POST"] };
