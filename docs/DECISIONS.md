# Decision log

## 2026-11-26 — Milestone 1 session 1
**Decided (Gene):** mock JobNimbus data only for M1; keep assignment@peakprosusa.com until the national system is
ready to connect; GDRR builds its own standalone CRM hub (FireSnap photos, iWallet payments later); FireSnap
replaces CompanyCam.

**Built (branch `m1-ga-sandbox`):**
- `netlify/lib/ops/` — store (memory + Netlify Blobs with atomic create), core (assignment ID, address
  normalisation, dedupe across form + inbox, state machine, audit trail, outbox that never sends, server-side
  access checks), invites (single-use, 72 h, email-bound, revoke/reissue), mock JobNimbus adapter
  (contractor = primary contact), inbox email parser.
- `netlify/functions/ops.mts` — `/api/ops/*`, inert unless `OPS_SANDBOX=1`.
- `partners/ops.html` (admin console), `partners/invite.html` (invite acceptance, sandbox view).
- `netlify/lib/portal.mts` — added `partnerSession()` export only; no existing behavior changed.
- `@netlify/blobs` 8.2 → 11.1 for conditional writes (`onlyIfNew`). Live code uses only get/setJSON/delete,
  which are unchanged — check the branch deploy's login + agreement flow before any merge.

**Tests:** 20/20 pass (`npm test`).

**Choices made in code (change any):** assignment IDs are `GA-YYYY-` + 6 random readable characters (no shared
counter needed); dedupe matches on street number + first street word + ZIP within 7 days; a stuck create-job
lock is taken over after 2 minutes.

**Open / next:**
1. Gene: add the branch-only env vars in `docs/SETUP-M1.md` and run the demo with Shadie.
2. Frank (FireSnap): webhook / API / admin role / report branding answers → M2 evidence step.
3. M2: Postgres via Netlify DB behind the same Store contract; JobNimbus test-board adapter; measurement →
   estimate version → signature → dispatch → evidence → invoice → payment → downloads.
