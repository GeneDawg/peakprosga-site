// Moves Peak 301 referral jobs along the JobNimbus "Peak 301 Referral" board so Shadie only handles exceptions:
//   Assigned       -> Scheduled       when the contractor signs the estimate (Eddie gets a "schedule it" task)
//   Job Completed  -> Invoiced        creates the Net 5 invoice from the signed estimate (Shadie gets a "send invoice" task)
//   Invoiced       -> Paid & Closed   once the invoice is paid and the payment has cleared; open tasks are completed
// Moving a job to Job Completed stays a person's call (Eddie/Shadie), because only they know the work is done.
import { accounts, jnAll, loadJobs, norm, peakSquares } from "./portal.mts";
import { creditFor } from "./rewards.mts";
import { addTask, buildEstimate, contractorFor, createInvoiceFromEstimate, jnWrite, jobTasks, money, round2, setStatus, USERS, NET_DAYS } from "./billing.mts";

export const STATUS = {
  assigned: Netlify.env.get("PORTAL_STATUS_ASSIGNED") || "Assigned",
  sent: Netlify.env.get("PORTAL_STATUS_SENT") || "Estimate Sent", // waiting on the contractor's signature
  scheduled: Netlify.env.get("PORTAL_STATUS_SCHEDULED") || "Scheduled",
  completed: Netlify.env.get("PORTAL_STATUS_COMPLETED") || "Job Completed",
  invoiced: Netlify.env.get("PORTAL_STATUS_INVOICED") || "Invoiced",
  closed: Netlify.env.get("PORTAL_STATUS_CLOSED") || "Paid & Closed",
};

// Squares Shadie types into the JobNimbus Measurements tab ("Quick Squares (SQ)" first, then "Total Roof Area (SQ)").
// Field names can be changed with PORTAL_MEASURE_FIELDS (comma separated). Returns 0 when nothing usable is filled in.
const norm2 = (k: string) => String(k).toLowerCase().replace(/[^a-z0-9]/g, "");
export function measurementFields(job: any, depth = 3): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (o: any, path: string, d: number) => {
    if (!o || typeof o !== "object" || d < 0) return;
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === "object") walk(v, `${path}${k}.`, d - 1);
      else if (/square|roofarea|sq\b|measure/i.test(k)) out[`${path}${k}`] = v;
    }
  };
  walk(job, "", depth);
  return out;
}
export function measuredSquares(job: any): number {
  const wanted = (Netlify.env.get("PORTAL_MEASURE_FIELDS") || "Quick Squares (SQ),Total Roof Area (SQ)").split(",").map(norm2).filter(Boolean);
  const found: Record<string, unknown> = {};
  const walk = (o: any, d: number) => {
    if (!o || typeof o !== "object" || d < 0) return;
    for (const [k, v] of Object.entries(o)) (v && typeof v === "object" ? walk(v, d - 1) : (found[norm2(k)] = v));
  };
  walk(job, 3);
  for (const w of wanted) {
    const n = Number(found[w]);
    // EagleView's JobNimbus sync writes square FEET into "Total Roof Area (SQ)" (e.g. 2957.6 for 29.6 squares).
    // No house roof is over 300 squares, so a bigger number is square feet: divide by 100.
    if (n > 300) return Math.round(n) / 100;
    if (n > 0) return n;
  }
  return 0;
}

const live = (x: any) => !x.is_archived && x.is_active !== false && norm(x.status_name) !== "void";
const isSigned = (e: any) => !!e.esigned || Number(e.date_signed || 0) > 0 || /^(signed|approved|accepted)/i.test(String(e.signature_status || "")) || /approved|accepted|signed/i.test(String(e.status_name || ""));
const isSent = (e: any) => Number(e.date_sign_requested || 0) > 0 || /sent|requested/i.test(String(e.signature_status || "")) || /sent/i.test(String(e.status_name || ""));

export type Action = { job: string; status: string; did: string };

export async function runPipeline(opts: { dry?: boolean } = {}) {
  const dry = !!opts.dry;
  const { jobs, raw } = await loadJobs(accounts());
  const portal = new Map(jobs.map((j) => [j.jnid, j]));
  const [estimates, invoices] = await Promise.all([jnAll("/v2/estimates"), jnAll("/v2/invoices")]);
  const relatedTo = (rows: any[], id: string) =>
    rows.filter((r) => live(r) && (r.related || []).some((x: any) => x.id === id)).sort((a, b) => Number(b.date_created || 0) - Number(a.date_created || 0));
  const actions: Action[] = [];
  const log = (job: any, did: string) => actions.push({ job: `#${job.number} ${job.name}`, status: job.status_name, did });

  for (const job of raw.jobs) {
    if (!/peak 301 referral/i.test(job.record_type_name || "")) continue;
    const status = String(job.status_name || "");
    const est = relatedTo(estimates, job.jnid)[0];
    const invs = relatedTo(invoices, job.jnid);
    const acct = contractorFor(job);
    try {
      // 1. Waiting on the contractor's signature.
      if (status === STATUS.assigned || (STATUS.sent && status === STATUS.sent)) {
        // 0. Squares entered on the Measurements tab and no estimate yet: build the draft estimate. Off unless PORTAL_AUTOESTIMATE_ON=1.
        if (!est && status === STATUS.assigned && Netlify.env.get("PORTAL_AUTOESTIMATE_ON")) {
          const sq = measuredSquares(job);
          if (sq > 0) {
            if (sq < 3 || sq > 150) {
              log(job, `measurement ${sq} looks wrong (outside 3-150 sq) - task for Shadie to check it`);
              if (!dry && !(await jobTasks(job.jnid)).some((t: any) => /check the squares/i.test(String(t.title || ""))))
                await addTask(job, `Shadie: check the squares - ${job.name}`, `The measurement on this job reads ${sq} sq, which looks off. Fix it on the Measurements tab; the estimate is built on the next check.`, USERS.gene);
            } else {
              log(job, `measurement ${sq} sq found, no estimate -> build draft estimate (Shadie sends it)`);
              if (!dry) await buildEstimate(job.jnid, sq);
            }
            continue;
          }
        }
        if (est && isSigned(est)) {
          log(job, `estimate #${est.number} signed -> ${STATUS.scheduled}; Eddie task to schedule`);
          if (!dry) {
            await setStatus(job, STATUS.scheduled);
            const sq = round2(peakSquares(est));
            await addTask(job, `Eddie: contractor signed - schedule Peak 301 - ${job.name}`,
              `${acct?.name || "The contractor"} signed estimate #${est.number}. Schedule the install.\n${sq ? `${sq} sq. Labor: ${sq} × $20 = ${money(sq * 20)}.\n` : ""}When the work is done, move the job to ${STATUS.completed}; the invoice is created automatically.`,
              USERS.eddie, 2);
          }
        } else if (est && isSent(est) && STATUS.sent && status !== STATUS.sent) {
          log(job, `estimate #${est.number} sent for signature -> ${STATUS.sent}`);
          if (!dry) await setStatus(job, STATUS.sent);
        }
        continue;
      }
      // 2. Work done: invoice it.
      if (status === STATUS.completed) {
        if (invs.length) {
          log(job, `already has invoice #${invs[0].number} -> ${STATUS.invoiced}`);
          if (!dry) await setStatus(job, STATUS.invoiced);
        } else if (est) {
          log(job, `create Net ${NET_DAYS} invoice from estimate #${est.number} (${money(Number(est.total || 0))}) -> ${STATUS.invoiced}; Shadie task to send it`);
          if (!dry) {
            const key = portal.get(job.jnid)?.account;
            const credit = key ? creditFor(jobs.filter((j) => j.account === key)) : null;
            const inv = await createInvoiceFromEstimate(job, est, credit);
            await setStatus(job, STATUS.invoiced);
            await addTask(job, `Shadie: send invoice #${inv.number ?? ""} - ${job.name}`,
              `Invoice #${inv.number ?? ""} for ${money(Number(inv.total ?? est.total ?? 0))} was created from estimate #${est.number}. Open it and click Send to ${acct?.name || "the contractor"} (Net ${NET_DAYS}, pay link included).${credit ? `\nPartner Rewards: ${credit.tier} credit from ${credit.quarter} is already on it ($${credit.rate}/sq).` : ""}`,
              USERS.gene);
          }
        } else {
          log(job, `no estimate yet - Shadie task to enter the EagleView squares`);
          if (!dry) await addTask(job, `Shadie: job completed but no estimate - ${job.name}`,
            `This job is marked ${STATUS.completed} but has no estimate. Create the estimate on this job from the \"Peak 301 Only\" layout with the EagleView squares and get it signed; the invoice is created on the next check.`, USERS.gene);
        }
        continue;
      }
      // 3. Paid and cleared: close it out.
      if (status === STATUS.invoiced) {
        const p = portal.get(job.jnid)?.invoice;
        if (p?.isPaid) {
          const cost = invs.reduce((a, i) => a + Number(i.cost || 0), 0);
          log(job, `paid ${money(p.total)} and cleared -> ${STATUS.closed}; revenue ${money(p.total)}, cost ${money(cost)}, profit ${money(p.total - cost)}; open tasks completed`);
          if (!dry) {
            await setStatus(job, STATUS.closed);
            for (const t of await jobTasks(job.jnid)) if (!t.is_completed) await jnWrite("PUT", `/tasks/${t.jnid}`, { is_completed: true });
          }
        }
      }
    } catch (e: any) {
      log(job, `ERROR ${String(e.message || e).slice(0, 200)}`);
    }
  }
  return { dry, ran: new Date().toISOString(), actions };
}
