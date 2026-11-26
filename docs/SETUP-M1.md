# Milestone 1 — Georgia sandbox: setup and demo

Everything here is **mock data**. JobNimbus is simulated, nothing is emailed or texted, and the live intake,
pipeline and partner dashboard are untouched.

## Turn it on (branch deploy only — never on production)
In Netlify → Site configuration → Environment variables, add these **scoped to the `m1-ga-sandbox` branch deploy only**:

| Name | Value | Why |
|---|---|---|
| `OPS_SANDBOX` | `1` | Without it every `/api/ops/*` route answers 404 |
| `OPS_JN_MODE` | `mock` | The only mode Milestone 1 allows |
| `OPS_ADMINISTRATOR_EMAIL` | (optional) | Address shown on rendered measurement requests; defaults to Shadie's |

Existing settings (`PORTAL_ACCOUNTS`, `PORTAL_ADMIN_CODE`, `PORTAL_SESSION_SECRET`) are reused for sign-in.
Data goes to the Netlify Blobs store `ops-sandbox`, separate from everything live.

## Demo (about 5 minutes)
1. Open `<branch-deploy-url>/partners/ops.html`, sign in with the GDRR admin code.
2. **Sandbox tester** → submit a job "as" North Georgia Roofing. Result: new `GA-2026-…` assignment, status
   *Measurement ordered*.
3. Press **Send again (same submission)**. Result: "Same submission again: no new assignment."
4. Send the test email (body already filled in) from the partner's email domain. Result: "Matched an open
   assignment: attached, no new job."
5. Open the assignment: the mock JobNimbus job is filed under the contractor, the homeowner is a job detail,
   the measurement request is rendered and marked *Not sent*, and the audit trail lists every step.
6. Submit as **Not signed in** with an unknown email. It lands in **Review queue**; approve it to a contractor and
   exactly one job is created.
7. **Invites** → create a link for a test email, open it in a private window, enter that email. The partner sees
   only their own company's test assignments. Open the link again: "already been used."

## Tests
`npm install` then `npm test` — 20 tests covering the Milestone 1 acceptance checklist.

## Not in Milestone 1
Real JobNimbus writes, the real inbox, sending any message, the Postgres database (the store interface is ready
for it), Milestone 2 states, FireSnap and iWallet connections.
