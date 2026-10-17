import type { Config } from "@netlify/functions";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { allowedAccounts, handleError, HttpError, json, loadJobs, makeFileTicket, readFileTicket, readSession } from "../lib/portal.mts";
import { WARRANTY_TEMPLATE_B64 } from "../lib/warranty-template.mts";

// GET ?job=<jnid> -> the completed Peak 301 warranty PDF. Released only when the job's invoice is paid in full.
// GET ?job=<jnid>&link=1 -> { url } a 3-minute link to the same PDF (iPhone/iPad, which can't save a file from a script).
// GET ?job=<jnid>&t=<link ticket> -> the PDF shown in the browser, with Safari's Share button to save or send it.
export default async (req: Request) => {
  try {
    const url = new URL(req.url);
    const jnid = url.searchParams.get("job");
    if (!jnid) throw new HttpError(400, "Missing job.");
    const ticket = url.searchParams.get("t");
    const session = ticket ? readFileTicket(ticket, jnid) : readSession(req);
    if (!session) throw new HttpError(401, "This warranty link has expired. Go back to your dashboard and tap Download warranty again.");
    const { jobs } = await loadJobs(allowedAccounts(session, "all"));
    const job = jobs.find((j) => j.jnid === jnid);
    if (!job) throw new HttpError(404, "That job isn't on your account.");
    if (!job.invoice?.isPaid) throw new HttpError(403, "The warranty is released once the invoice is paid in full.");
    if (!ticket && url.searchParams.get("link") === "1")
      return json({ url: `/api/portal/warranty?job=${encodeURIComponent(jnid)}&t=${encodeURIComponent(makeFileTicket(session, jnid))}` });

    const pdf = await PDFDocument.load(Buffer.from(WARRANTY_TEMPLATE_B64, "base64"));
    const page = pdf.getPage(0);
    const font = await pdf.embedFont(StandardFonts.HelveticaBold);
    const { height } = page.getSize();
    const start = job.fulfilled
      ? new Date(job.fulfilled + "T12:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })
      : "";
    // Value column of the template's four-row table (row middles measured from the top of the page).
    const rows: [number, string][] = [
      [162, "Go Dawgs Roof Roof"],
      [210, job.owner],
      [258, job.address],
      [306, start],
    ];
    for (const [mid, text] of rows) {
      if (!text) continue;
      let size = 12;
      while (size > 8 && font.widthOfTextAtSize(text, size) > 300) size -= 0.5;
      page.drawText(text, { x: 228, y: height - mid - 4, size, font, color: rgb(0.07, 0.07, 0.08) });
    }
    pdf.setTitle(`Peak 301 Warranty - ${job.owner}`);
    const bytes = await pdf.save();
    const file = `Peak301_Warranty_${job.owner.replace(/[^A-Za-z0-9]+/g, "_")}.pdf`;
    return new Response(bytes, {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `${ticket ? "inline" : "attachment"}; filename="${file}"`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    return handleError(e);
  }
};

export const config: Config = { path: "/api/portal/warranty", method: "GET" };
