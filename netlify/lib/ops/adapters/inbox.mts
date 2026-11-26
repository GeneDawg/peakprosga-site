// Assignment inbox adapter. The inbox stays assignment@peakprosusa.com until the national system is ready
// (decision 2026-11-26). Milestone 1 uses this parser on fixture emails only; Milestone 2 connects the mailbox.
//
// It reads the "Label: value" lines our own form notification emails contain, and the same lines a partner
// types by hand. Anything it can't read is left blank, and the assignment is held for review.
import type { AssignmentData } from "../core.mts";

export type InboundEmail = { messageId: string; from: string; subject?: string; body: string };

const LABELS: Record<string, keyof AssignmentData> = {
  company: "company", "contractor": "company", "company name": "company",
  "contact name": "contact_name", "submitted by": "contact_name", "your name": "contact_name",
  "contact email": "contact_email", "email": "contact_email",
  "contact phone": "contact_phone", "phone": "contact_phone",
  "homeowner": "homeowner_name", "homeowner name": "homeowner_name", "customer": "homeowner_name",
  "homeowner phone": "homeowner_phone",
  "property": "property_address", "property address": "property_address", "address": "property_address",
  "roof size": "roof_size", "squares": "roof_size",
  "roof age": "roof_age", "roof type": "roof_type",
  "notes": "scope_notes", "scope notes": "scope_notes",
  "service date": "service_date", "requested date": "service_date",
};

export function parseAssignmentEmail(e: InboundEmail): AssignmentData {
  const d: AssignmentData = {};
  for (const line of e.body.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z ]{2,30}):\s*(.+?)\s*$/);
    if (!m) continue;
    const field = LABELS[m[1].trim().toLowerCase()];
    if (field && !d[field]) d[field] = m[2];
  }
  const fromAddr = (e.from.match(/<([^>]+)>/) || [null, e.from])[1]!.trim();
  if (!d.contact_email) d.contact_email = fromAddr;
  if (d.roof_size) d.roof_size = (d.roof_size.match(/\d+(\.\d+)?/) || [""])[0];
  return d;
}
