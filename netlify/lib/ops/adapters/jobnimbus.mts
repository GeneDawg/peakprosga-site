// JobNimbus adapter for the Ops layer.
// Milestone 1 runs ONLY the mock: it keeps contacts, jobs and tasks in the Ops store so the whole flow can be
// exercised without touching GDRR's real JobNimbus. "test-board" and "live" modes are declared for Milestone 2
// and refuse to run until they are built and switched on for an approved pilot.
import type { Store } from "../store.mts";
import type { Company } from "../core.mts";
import { randomBytes } from "node:crypto";

export type NewJob = {
  externalId: string;            // our assignment ID; lets a retry find the job instead of creating a second one
  name: string;
  primaryContactId: string;      // the assigning contractor
  status: string;
  address: string;
  homeowner: { name: string; phone: string };
  description: string;
};

export interface JobNimbusAdapter {
  mode: "mock" | "test-board" | "live";
  findOrCreateContractorContact(co: Company): Promise<string>;
  findJobByExternalId(externalId: string): Promise<string | null>;
  createJob(job: NewJob): Promise<string>;
  ensureTask(jobId: string, kind: string, t: { title: string; description: string }): Promise<string>;
  getJob(jobId: string): Promise<any | null>;
  listJobs(): Promise<any[]>;
}

const jnid = () => "mock_" + randomBytes(8).toString("hex");

export function mockJobNimbus(store: Store): JobNimbusAdapter {
  return {
    mode: "mock",
    async findOrCreateContractorContact(co) {
      const key = `jn/company/${co.key}`;
      const hit = await store.get<{ id: string }>(key);
      if (hit) return hit.id;
      const id = jnid();
      if (await store.createIfAbsent(key, { id })) {
        await store.set(`jn/contact/${id}`, { jnid: id, display_name: co.name, record_type_name: "Contractor", email: co.billingEmail || "" });
        return id;
      }
      return (await store.get<{ id: string }>(key))!.id;
    },
    async findJobByExternalId(externalId) {
      // Real JobNimbus: search jobs for the assignment ID stored in a custom field. Mock: an index.
      const hit = await store.get<{ id: string }>(`jn/ext/${externalId}`);
      return hit?.id || null;
    },
    async createJob(job) {
      // Like the real API, creating is NOT idempotent: two calls make two jobs. Callers must look first.
      const id = jnid();
      await store.set(`jn/job/${id}`, {
        jnid: id, name: job.name, record_type_name: "Peak 301 Referral", status_name: job.status,
        primary: { id: job.primaryContactId }, address_line1: job.address,
        "Homeowner Name": job.homeowner.name, "Homeowner Phone": job.homeowner.phone,
        "Assignment ID": job.externalId, description: job.description, created: new Date().toISOString(),
      });
      await store.set(`jn/ext/${job.externalId}`, { id });
      return id;
    },
    async ensureTask(jobId, kind, t) {
      const key = `jn/jobtask/${jobId}/${kind}`;
      const hit = await store.get<{ id: string }>(key);
      if (hit) return hit.id;
      const id = jnid();
      if (await store.createIfAbsent(key, { id })) {
        await store.set(`jn/task/${id}`, { jnid: id, related: [{ id: jobId }], ...t, owner: "Gene (Administrator works under Gene's login)" });
        return id;
      }
      return (await store.get<{ id: string }>(key))!.id;
    },
    async getJob(jobId) {
      return store.get(`jn/job/${jobId}`);
    },
    async listJobs() {
      const keys = await store.list("jn/job/");
      return (await Promise.all(keys.map((k) => store.get(k)))).filter(Boolean);
    },
  };
}

export function jobNimbusAdapter(mode: string | undefined, store: Store): JobNimbusAdapter {
  if (!mode || mode === "mock") return mockJobNimbus(store);
  throw new Error(`JobNimbus mode "${mode}" is not available in Milestone 1. Use OPS_JN_MODE=mock.`);
}
