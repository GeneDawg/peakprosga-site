// Production by a subcontractor (High Point LLC) instead of a JobNimbus team member.
//
// Turned on by the Netlify setting PORTAL_SUB_NAME (for example "High Point LLC"). While it is NOT set, nothing here
// runs and the site keeps giving Eddie tasks exactly as before.
//
// When it IS set, at the moment a contractor signs the estimate:
//   1. the subcontractor contact is added to the job,
//   2. the job's CompanyCam project is found (the JobNimbus/CompanyCam integration creates it) and a
//      collaboration invite is made, so the sub adds photos from their own CompanyCam account,
//   3. a JobNimbus work order is created for the sub with the squares, labor pay and the CompanyCam link,
//   4. Shadie gets one task: email that work order (three dots -> Email Work Order).
// If any step fails, Shadie's task says what is left to do by hand, so no job is ever stuck.
//
// Settings: PORTAL_SUB_NAME, PORTAL_SUB_CONTACT_ID (optional, skips the name search), PORTAL_SUB_EMAIL (shown in tasks),
// PORTAL_WO_TYPE (optional work order workflow name), COMPANYCAM_API_TOKEN.
import { HttpError, jn, jnAll } from "./portal.mts";
import { addTask, jnWrite, money, round2, USERS, LABOR_PER_SQ } from "./billing.mts";

const CC_BASE = "https://api.companycam.com/v2";
export const SUB_NAME = () => (Netlify.env.get("PORTAL_SUB_NAME") || "").trim();
export const subMode = () => !!SUB_NAME();
const SUB_EMAIL = () => Netlify.env.get("PORTAL_SUB_EMAIL") || "eddie@godawgsroofroof.com";
const words = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/* ---------- the subcontractor contact in JobNimbus ---------- */

export async function findSubContact(): Promise<any | null> {
  const id = Netlify.env.get("PORTAL_SUB_CONTACT_ID");
  if (id) return jn(`/contacts/${encodeURIComponent(id)}`).catch(() => null);
  const want = words(SUB_NAME());
  if (!want) return null;
  const tries = [
    { must: [{ term: { display_name: SUB_NAME() } }] },
    { must: [{ term: { record_type_name: "Subcontractor" } }] },
  ];
  for (const f of tries) {
    const rows = await jnAll("/contacts", { filter: JSON.stringify(f) }, 5).catch(() => [] as any[]);
    const hit = rows.find((c: any) => c.is_active !== false && !c.is_archived && (words(c.display_name) === want || words(c.company) === want));
    if (hit) return hit;
  }
  return null;
}

/* ---------- CompanyCam ---------- */

async function cc(method: "GET" | "POST", path: string, params: Record<string, string> = {}): Promise<any> {
  const token = Netlify.env.get("COMPANYCAM_API_TOKEN");
  if (!token) throw new HttpError(500, "COMPANYCAM_API_TOKEN is not set.");
  const url = new URL(CC_BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new HttpError(502, `CompanyCam ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

const streetKey = (s: unknown) => {
  const w = words(s).split(" ");
  return w.slice(0, 2).join(" "); // house number + first street word, e.g. "123 main"
};

/** The CompanyCam project for this job, matched on the street address (the integration names projects after the job/address). */
export async function findCompanyCamProject(job: any): Promise<any | null> {
  const street = String(job.address_line1 || job.name || "").replace(/^(TEST|CHECK)\s*-\s*/i, "");
  const key = streetKey(street);
  if (!key) return null;
  const rows: any[] = await cc("GET", "/projects", { query: street, per_page: "25" }).then((r) => (Array.isArray(r) ? r : r.projects || [])).catch(() => []);
  return rows.find((p: any) => streetKey(p.address?.street_address_1) === key || streetKey(String(p.name || "").replace(/^(TEST|CHECK)\s*-\s*/i, "")) === key) || null;
}

/** Any web address CompanyCam returns for an invitation (field names are not documented, so take the first link). */
function firstUrl(o: any): string | null {
  if (!o || typeof o !== "object") return null;
  for (const k of ["url", "invite_url", "invitation_url", "accept_url", "link"]) if (typeof o[k] === "string" && /^https?:/.test(o[k])) return o[k];
  for (const v of Object.values(o)) {
    if (typeof v === "string" && /^https?:\/\//.test(v)) return v;
    if (v && typeof v === "object") { const u = firstUrl(v); if (u) return u; }
  }
  return null;
}

export async function companyCamInvite(job: any): Promise<{ project: any | null; inviteUrl: string | null; projectUrl: string | null; note?: string }> {
  if (!Netlify.env.get("COMPANYCAM_API_TOKEN")) return { project: null, inviteUrl: null, projectUrl: null, note: "CompanyCam token not set" };
  const project = await findCompanyCamProject(job);
  if (!project) return { project: null, inviteUrl: null, projectUrl: null, note: "No CompanyCam project found for this address yet" };
  const projectUrl = project.project_url || project.public_url || `https://app.companycam.com/projects/${project.id}`;
  try {
    const inv = await cc("POST", `/projects/${project.id}/invitations`);
    return { project, inviteUrl: firstUrl(inv), projectUrl, note: firstUrl(inv) ? undefined : `Invitation made but no link returned: ${JSON.stringify(inv).slice(0, 200)}` };
  } catch (e: any) {
    return { project, inviteUrl: null, projectUrl, note: String(e.message || e).slice(0, 200) };
  }
}

/* ---------- the work order ---------- */

async function workOrderType(): Promise<string | undefined> {
  const t = Netlify.env.get("PORTAL_WO_TYPE");
  if (t) return t;
  const one = await jn("/v2/workorders", { size: "1" }).catch(() => null);
  return one?.results?.[0]?.record_type_name || undefined;
}

export type HandOff = { workOrder: { jnid?: string; number?: string } | null; sub: string | null; companyCam: string | null; problems: string[] };

/** Called when the contractor signs: hands the install to the subcontractor. */
export async function handOffToSub(job: any, est: any, sq: number, contractorName: string): Promise<HandOff> {
  const problems: string[] = [];
  const labor = round2(sq * LABOR_PER_SQ);
  const sub = await findSubContact().catch(() => null);
  if (!sub) problems.push(`Could not find the "${SUB_NAME()}" subcontractor contact in JobNimbus`);

  // 1. Put the sub on the job.
  if (sub && !(job.related || []).some((r: any) => r.id === sub.jnid)) {
    try {
      await jnWrite("PUT", `/jobs/${job.jnid}`, { related: [...(job.related || []).map((r: any) => ({ id: r.id })), { id: sub.jnid }], subcontractors: [{ id: sub.jnid }] });
    } catch (e: any) {
      problems.push(`Could not add ${SUB_NAME()} to the job: ${String(e.message || e).slice(0, 150)}`);
    }
  }

  // 2. CompanyCam invite.
  const camera = await companyCamInvite(job).catch((e: any) => ({ project: null, inviteUrl: null, projectUrl: null, note: String(e.message || e) }));
  if (camera.note) problems.push(`CompanyCam: ${camera.note}`);
  const camLink = camera.inviteUrl || camera.projectUrl;

  // 3. Work order.
  const instructions = [
    `Peak 301 install for ${contractorName} (contractor signed estimate #${est.number ?? ""}).`,
    `Property: ${[job.address_line1, job.city, job.state_text, job.zip].filter(Boolean).join(", ") || job.name}`,
    `${sq} sq × $${LABOR_PER_SQ}/sq labor = ${money(labor)}.`,
    camera.inviteUrl ? `Add photos in CompanyCam (accept the invite): ${camera.inviteUrl}` : camera.projectUrl ? `CompanyCam project: ${camera.projectUrl}` : `CompanyCam: add photos to this address's project.`,
    `When the work is done, reply to this email so we can move the job to Job Completed.`,
  ].join("\n");
  let workOrder: HandOff["workOrder"] = null;
  try {
    const type = await workOrderType();
    const wo = await jnWrite("POST", "/v2/workorders", {
      ...(type ? { record_type_name: type } : {}),
      related: [{ id: job.jnid, type: "job", name: job.name }],
      subcontractors: sub ? [{ id: sub.jnid, name: sub.display_name }] : [],
      owners: [{ id: USERS.gene }],
      sales_rep: USERS.gene,
      items: [{
        name: "Peak 301 install labor", description: instructions, item_type: "labor", uom: "SQ",
        quantity: sq, price: LABOR_PER_SQ, cost: LABOR_PER_SQ, amount: labor,
      }],
      customer_note: instructions,
      internal_note: `Created automatically when ${contractorName} signed. Pay ${SUB_NAME()} ${money(labor)}.`,
    });
    workOrder = { jnid: wo.jnid, number: wo.number };
  } catch (e: any) {
    problems.push(`Could not create the work order: ${String(e.message || e).slice(0, 200)}`);
  }

  // 4. One task for Shadie.
  const title = workOrder
    ? `Shadie: email work order #${workOrder.number ?? ""} to ${SUB_NAME()} - ${job.name}`
    : `Shadie: send ${SUB_NAME()} the install - ${job.name}`;
  const body = [
    workOrder
      ? `Open this job > Material & Work Orders > three dots next to work order #${workOrder.number ?? ""} > Email Work Order > pick ${SUB_NAME()} (${SUB_EMAIL()}) > Send.`
      : `Email ${SUB_NAME()} (${SUB_EMAIL()}) the install details below.`,
    "",
    instructions,
    problems.length ? `\nFix by hand:\n- ${problems.join("\n- ")}` : "",
  ].join("\n");
  await addTask(job, title, body, USERS.gene, 1).catch((e) => console.error("handoff task failed", e));

  return { workOrder, sub: sub?.display_name || null, companyCam: camLink || null, problems };
}

/** Read-only check for the admin page: is everything in place? Optionally looks at one job (no changes). */
export async function productionCheck(jobNumber?: string) {
  const out: Record<string, unknown> = {
    mode: subMode() ? `ON: installs go to ${SUB_NAME()}` : "OFF: Eddie still gets tasks (set PORTAL_SUB_NAME to switch)",
    companyCamToken: !!Netlify.env.get("COMPANYCAM_API_TOKEN"),
  };
  const sub = await findSubContact().catch((e) => ({ error: String(e.message || e) }));
  out.subContact = sub ? { name: (sub as any).display_name, id: (sub as any).jnid, email: (sub as any).email, type: (sub as any).record_type_name, error: (sub as any).error } : `not found${SUB_NAME() ? "" : " (PORTAL_SUB_NAME not set)"}`;
  try {
    const me = await cc("GET", "/company");
    out.companyCam = { ok: true, company: me.name };
  } catch (e: any) {
    out.companyCam = { ok: false, error: String(e.message || e).slice(0, 200) };
  }
  const wos = await jn("/v2/workorders", { size: "1" }).catch((e: any) => ({ error: String(e.message || e) }));
  const sample = (wos as any)?.results?.[0];
  out.workOrders = (wos as any).error ? { error: (wos as any).error } : {
    count: (wos as any).count,
    workflowName: sample?.record_type_name || null,
    sampleShape: sample ? Object.keys(sample) : [],
    sampleSubcontractors: sample?.subcontractors || [],
  };
  if (jobNumber) {
    const jobs = await jn("/jobs", { size: "5", filter: JSON.stringify({ must: [{ term: { number: String(jobNumber) } }] }) }).catch(() => null);
    const job = (jobs?.results || jobs?.jobs || [])[0];
    if (!job) out.job = `Job #${jobNumber} not found`;
    else {
      const p = await findCompanyCamProject(job).catch((e: any) => ({ error: String(e.message || e) }));
      out.job = { number: job.number, name: job.name, workflow: job.record_type_name, status: job.status_name, companyCamProject: p ? { id: (p as any).id, name: (p as any).name, url: (p as any).project_url || (p as any).public_url, error: (p as any).error } : "no project matched this address" };
    }
  }
  return out;
}
