// Partner Rewards: quarterly, by Peak 301 squares sprayed. This file is the one scorekeeper: the dashboard panel
// and the credit line on invoices both read from here, so they always agree.
//   - Calendar quarters, Eastern time. A job lands in the quarter the roof was sprayed (its fulfillment date).
//   - Its squares count once the invoice is paid. Complimentary ($0) jobs never count.
//   - A quarter locks LOCK_DAYS after it ends: anything sprayed in the quarter and paid by then counts.
//   - The tier reached in a quarter sets the per-square credit on invoices created in the NEXT quarter.
//   - Invoices that carry a credit still earn their full squares.
// To change the program, edit TIERS / START / LOCK_DAYS only.
import type { PortalJob } from "./portal.mts";

export const START = Netlify.env.get("PORTAL_REWARDS_START") || "2026-10-01"; // jobs sprayed before this never count
export const LOCK_DAYS = Number(Netlify.env.get("PORTAL_REWARDS_LOCK_DAYS") || 10);
export const TIERS = [
  { n: "Base", min: 0, credit: 0, perk: "$85/sq partner rate" },
  { n: "Silver", min: 150, credit: 2, perk: "$2/sq credit next quarter" },
  { n: "Gold", min: 300, credit: 4, perk: "$4/sq credit next quarter" },
  { n: "Platinum", min: 500, credit: 6, perk: "$6/sq credit next quarter + co-branded marketing" },
];

export type Quarter = { label: string; start: string; end: string; lock: string };
const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => d.toISOString().slice(0, 10);
export const todayET = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const addDays = (day: string, n: number) => iso(new Date(Date.parse(day + "T12:00:00Z") + n * 864e5));
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 864e5);
const round2 = (n: number) => Math.round(n * 100) / 100;

export function quarterOf(day: string): Quarter {
  const y = Number(day.slice(0, 4)), q = Math.floor((Number(day.slice(5, 7)) - 1) / 3) + 1;
  const start = `${y}-${pad((q - 1) * 3 + 1)}-01`, end = iso(new Date(Date.UTC(y, q * 3, 0)));
  return { label: `Q${q} ${y}`, start, end, lock: addDays(end, LOCK_DAYS) };
}
export const prevQuarter = (q: Quarter) => quarterOf(addDays(q.start, -1));
export function tierIndex(sq: number): number {
  let i = 0;
  TIERS.forEach((t, k) => { if (sq >= t.min) i = k; });
  return i;
}

/** Squares for one contractor's jobs in one quarter, as of `now`. counted = paid in time; pending = sprayed, could still count. */
export function tally(jobs: PortalJob[], q: Quarter, now = todayET()) {
  let counted = 0, pending = 0;
  for (const j of jobs) {
    if (!j.fulfilled || !j.squares || j.fulfilled < q.start || j.fulfilled > q.end || j.fulfilled < START) continue;
    const inv = j.invoice;
    if (inv && inv.total <= 0) continue; // complimentary job
    if (inv?.isPaid && (!inv.paidDate || inv.paidDate <= q.lock)) counted += j.squares;
    else if (now <= q.lock) pending += j.squares;
  }
  return { counted: round2(counted), pending: round2(pending) };
}

/** The credit a contractor has on invoices created today: the tier they reached last quarter. null when none. */
export function creditFor(jobs: PortalJob[], now = todayET()): { rate: number; tier: string; quarter: string } | null {
  if (now < START) return null;
  const pq = prevQuarter(quarterOf(now));
  if (pq.end < START) return null;
  const t = TIERS[tierIndex(tally(jobs, pq, now).counted)];
  return t.credit > 0 ? { rate: t.credit, tier: t.n, quarter: pq.label } : null;
}

/** Everything the dashboard panel shows for one contractor. */
export function summary(jobs: PortalJob[], now = todayET()) {
  const q = quarterOf(now), t = tally(jobs, q, now), i = tierIndex(t.counted), next = TIERS[i + 1];
  return {
    counted: t.counted,
    pending: t.pending,
    tier: i,
    next: next ? { tier: i + 1, need: round2(next.min - t.counted) } : null,
    credit: creditFor(jobs, now),
  };
}

/** The whole payload for /api/portal/jobs. null before the program starts. */
export function rewardsPayload(jobs: PortalJob[], accountKeys: string[], now = todayET()) {
  if (now < START) return null;
  const q = quarterOf(now);
  const accounts: Record<string, ReturnType<typeof summary>> = {};
  for (const key of accountKeys) accounts[key] = summary(jobs.filter((j) => j.account === key), now);
  return { quarter: { label: q.label, end: q.end, daysLeft: Math.max(0, daysBetween(now, q.end)) }, lockDays: LOCK_DAYS, tiers: TIERS, accounts };
}
