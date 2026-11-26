# Peak 301 Referral Network Platform — Blueprint v1 (repo summary)

The full blueprint (diagrams, connector matrix, permission matrix, dashboards, milestones) lives in the Claude doc
"Peak 301 Referral Network Platform — Blueprint v1". This file keeps the rules code must follow.

## Direction (Gene, 2026-11-26)
GDRR gets its own standalone CRM: one hub for the roof rejuvenation division and the Georgia referral network
(SEO/marketing, FireSnap photos, dashboard, warranties, payments via iWallet once that deal is live), usable on
laptop, iPad and phone. The Ops layer in `netlify/lib/ops/` is the start of it. It takes over from JobNimbus one
function at a time, each with a side-by-side check — never all at once.

## System of record
| Data | Owner | Rule |
|---|---|---|
| Partners, users, invites, assignments, consent, audit trail | Ops layer | Copies elsewhere never overwrite it |
| Production job, status, measurements, estimates, signatures, invoices, payments | JobNimbus (for now) | JobNimbus wins; Ops caches |
| Marketing leads, sequences, bookings | MyChangeMachine — GDRR sub-account only | Opt-outs win everywhere |
| Photos + photo reports | FireSnap (target) / JobNimbus files (today) | Report's Job Number carries our assignment ID |

## Non-negotiables
- The assigning contractor is the JobNimbus job's primary contact (they are billed). Homeowner = job detail.
- Every submission gets an assignment ID (`GA-YYYY-XXXXXX`) and is saved before any JobNimbus call.
- Same event twice = replay; same partner + same address within 7 days = one assignment, one job.
- Partners see only their own company's records; checked on the server on every request.
- Nothing messages customers or partners, publishes to social, or writes to live JobNimbus/accounting until Gene
  switches it on for an approved pilot. Build switched off, test with one record first.
- No SMS or AI calling without consent capture and legal review. Exclude DNC numbers and TCPA litigators.
- Never create an "Initial Appointment" task assigned to Eddie in JobNimbus (it texts the customer).
- Secrets only in Netlify environment variables. Never in code, docs or chat.
- Referral-partner-facing material says "Serviced by Peak 301 Pros"; no GDRR branding there.

## States
received → needs_review | accepted → measurement_ordered (Milestone 1)
→ measured → estimate_sent → scheduled → completed → invoiced → paid → closed (Milestone 2), with holds:
measurement_overdue, measure_hold, estimate_expired, evidence_hold, partial_paid.
Only the signed estimate version may schedule. Missing photo evidence holds invoicing. Only full cleared payment
unlocks downloads, for that job only.

## Milestones
1. GA sandbox (this branch): invites, intake with ID + dedupe (form + inbox), one mock job under the contractor,
   Administrator's measurement request rendered (not sent), admin screens, audit trail. Mock data only.
2. GA full loop: measurement → signed version → dispatch → FireSnap evidence → invoice → cleared payment →
   downloads; marketing queue in parallel. Needs Frank (FireSnap) API/webhook answers.
3. Next market by configuration, not cloning (ownership for other states: decide with Kent).
