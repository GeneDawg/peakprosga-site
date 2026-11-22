// Referral Partner Master Service Agreement, shown to every partner the first time they sign in
// (and again whenever AGREEMENT_VERSION changes). Until counsel approves the final version, partners
// ACKNOWLEDGE these terms (typed name + checkbox); the record is kept in Netlify Blobs ("portal-agreements").
//
// To issue a new version: edit SECTIONS, change AGREEMENT_VERSION, deploy. Every partner is asked again
// on their next sign-in. Old acknowledgements stay on file under their own version.
import { getStore } from "@netlify/blobs";
import { HttpError, type Session } from "./portal.mts";

export const AGREEMENT_VERSION = "2026-11-ack";
export const AGREEMENT_MODE: "acknowledge" | "sign" = "acknowledge";
export const AGREEMENT_TITLE = "Referral Partner Master Service Agreement";

export type Section = { h: string; p?: string[]; list?: string[]; ol?: string[] };

export const INTRO = [
  "This Master Service Agreement (the \"Agreement\") is between Peak 301 Pros (\"Peak 301 Pros\") and the referral partner company named below (\"Partner\"). It takes effect on the date Partner acknowledges it in the Peak 301 Pros partner dashboard (the \"Effective Date\").",
];

export const SECTIONS: Section[] = [
  { h: "1. Purpose", p: [
    "Partner is a roofing or exterior-services contractor that wants to offer Peak 301 roof rejuvenation to its customers. Peak 301 Pros provides Peak 301 services through its certified applicators. This Agreement sets the terms for every project Partner sends to Peak 301 Pros.",
  ] },
  { h: "2. Definitions", list: [
    "Assignment: a roof Partner submits to Peak 301 Pros for service through the Peak 301 Pros partner dashboard or website.",
    "Services: Peak 301 roof rejuvenation, and any add-on services (such as washing or tune-up) listed on the signed estimate.",
    "Certified Applicator: the Peak 301 Pros certified contractor that performs the Services.",
    "Dashboard: the online partner portal where Partner submits Assignments and views service dates, invoices, payment status and warranties.",
    "Work Authorization: an estimate for an Assignment that Partner has signed digitally.",
  ] },
  { h: "3. Assignments and Services", ol: [
    "Partner submits each Assignment with the property address, homeowner contact details and any roof photos or notes.",
    "Peak 301 Pros may decline any roof it finds unsuitable for Peak 301 and will say so in writing.",
    "Peak 301 Pros orders a roof measurement report and sends Partner an estimate with these terms attached.",
    "Work begins only after Partner signs the estimate. The signed estimate is the Work Authorization.",
    "The Certified Applicator performs the Services as a subcontractor to Partner, in a good and workmanlike manner and in line with the manufacturer's application instructions.",
    "Partner owns the relationship and contract with the homeowner. Partner is responsible for scheduling access with the homeowner and for any permits or approvals its own contract requires.",
  ] },
  { h: "4. Pricing", ol: [
    "Peak 301 application is priced at $85 per square, measured from the roof measurement report.",
    "Full-service packages (washing plus tune-up) are quoted separately on the estimate.",
    "Peak 301 Pros may change pricing on 30 days' written notice. A change never applies to an Assignment Partner has already signed.",
  ] },
  { h: "5. Payment", ol: [
    "Partner is solely responsible for paying Peak 301 Pros, whether or not the homeowner has paid Partner. Collecting from the homeowner is Partner's job.",
    "Peak 301 Pros invoices Partner, not the homeowner, when the work is complete, and sends the invoice with the photo report and measurement report.",
    "Each invoice is due within 7 days of job completion.",
    "An invoice unpaid after 30 days carries a late fee of 1.5% per month on the unpaid balance.",
    "Peak 301 Pros may suspend new Assignments and scheduled work until all late invoices are paid.",
    "Peak 301 Pros releases the warranty certificate to Partner only after the invoice is paid in full.",
  ] },
  { h: "6. Lien rights", p: [
    "Peak 301 Pros reserves the right to file a mechanic's lien against the property for any unpaid amount, as the law of the state where the property sits allows. Partner agrees to cooperate in resolving the lien once it pays. Partner pays reasonable collection costs and attorney's fees Peak 301 Pros incurs to collect overdue invoices.",
  ] },
  { h: "7. Warranty", p: [
    "Each completed Assignment carries the Peak 301 manufacturer's warranty, issued in the property owner's name and on the terms printed on the warranty certificate. The certificate names the Certified Applicator of record. There is no warranty on a roof that is unsuitable for the product or that is damaged by causes the certificate excludes.",
  ] },
  { h: "8. Insurance", p: [
    "Each party keeps commercial general liability insurance of at least $1,000,000 per occurrence and workers' compensation insurance as the law requires. Each party gives the other a certificate of insurance on request and tells the other promptly if coverage lapses.",
  ] },
  { h: "9. Relationship of the parties", list: [
    "The parties are independent businesses. Nothing here creates a partnership, joint venture, franchise or employment relationship.",
    "Partner pays no fee to Peak 301 Pros to enter this Agreement and is not required to buy product, inventory, equipment or training.",
    "Partner decides how it runs its business. The relationship is not exclusive for either party, and Partner receives no protected territory.",
    "Each party keeps its own customers. Peak 301 Pros and its Certified Applicators will not solicit homeowners on Partner's projects for roof repair or replacement work.",
  ] },
  { h: "10. Liability and indemnity", list: [
    "Each party indemnifies the other against third-party claims caused by its own negligence, willful misconduct or breach of this Agreement.",
    "Partner is responsible for what it tells homeowners about Peak 301 and must not promise results or warranty terms beyond the written warranty.",
    "Neither party is liable to the other for lost profits or indirect damages. Peak 301 Pros' total liability on any Assignment is limited to the amount Partner paid for that Assignment.",
  ] },
  { h: "11. Compliance, marketing and confidentiality", list: [
    "Each party follows the licensing, safety and consumer-protection laws that apply to its work.",
    "Partner may use Peak 301 Pros names and logos only as the written brand guidelines allow, and only while this Agreement is in force.",
    "Each party keeps the other's pricing, customer lists, dashboard access code and non-public information confidential, except as needed to perform the Services.",
  ] },
  { h: "12. Term and termination", ol: [
    "This Agreement starts on the Effective Date and runs for one year, then renews yearly unless a party ends it.",
    "Either party may end it for any reason on 30 days' written notice.",
    "Peak 301 Pros may end it immediately if Partner fails to pay an invoice within 30 days of the due date or lets required insurance lapse.",
    "Ending this Agreement does not cancel Assignments already signed. Those are completed and paid under these terms, and the payment, lien, warranty, liability and confidentiality sections survive.",
  ] },
  { h: "13. General terms", list: [
    "Governing law: Georgia, without regard to conflict-of-law rules.",
    "Entire agreement: this Agreement and each signed estimate are the whole deal. A signed estimate cannot override this Agreement unless it says so.",
    "Changes: only in writing, except pricing under Section 4. Peak 301 Pros may issue an updated version of this Agreement through the Dashboard; Partner is asked to review and accept it at its next sign-in.",
    "Notices: by email to the addresses on file, effective when sent. Peak 301 Pros: gene@peak301pros.com.",
    "Neither party may transfer this Agreement without the other's written consent.",
    "Electronic acknowledgements and signatures are valid. If a clause is unenforceable, the rest stays in force.",
  ] },
];

export type Ack = {
  version: string;
  mode: string;
  account: string;
  company: string;
  name: string;
  title: string;
  email: string;
  at: string; // ISO time
  ip: string;
  ua: string;
};

const store = () => getStore({ name: "portal-agreements", consistency: "strong" });
const keyFor = (account: string, version = AGREEMENT_VERSION) => `${account}/${version}`;

export async function getAck(account: string, version = AGREEMENT_VERSION): Promise<Ack | null> {
  try {
    return ((await store().get(keyFor(account, version), { type: "json" })) as Ack) || null;
  } catch (e) {
    console.error("agreement read failed", e);
    return null;
  }
}

export async function saveAck(a: Ack): Promise<void> {
  await store().setJSON(keyFor(a.account, a.version), a);
}

/** Partners must have accepted the current agreement before they see jobs, files or warranties. Staff are exempt. */
export async function requireAgreement(s: Session): Promise<void> {
  if (s.role !== "partner" || !s.key) return;
  if (await getAck(s.key)) return;
  throw new HttpError(403, "AGREEMENT_REQUIRED");
}

export function agreementPayload() {
  return { version: AGREEMENT_VERSION, mode: AGREEMENT_MODE, title: AGREEMENT_TITLE, intro: INTRO, sections: SECTIONS };
}
