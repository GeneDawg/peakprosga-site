// Key-value store behind the Ops layer (Milestone 1 sandbox).
// Two implementations with the same contract:
//   memoryStore()  - tests and local demos
//   blobsStore()   - Netlify Blobs store "ops-sandbox" (deploy previews / sandbox), strong consistency
// createIfAbsent is the one atomic primitive the dedupe and invite logic rely on: of any number of
// concurrent callers for the same key, exactly one gets `true`.
// Production (Milestone 2+) swaps this for Postgres with the same contract (unique constraints).

export interface Store {
  get<T = any>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  createIfAbsent(key: string, value: unknown): Promise<boolean>;
  list(prefix: string): Promise<string[]>;
  clear(prefix?: string): Promise<void>;
}

export function memoryStore(): Store {
  const m = new Map<string, string>();
  return {
    async get(key) {
      const v = m.get(key);
      return v === undefined ? null : JSON.parse(v);
    },
    async set(key, value) {
      m.set(key, JSON.stringify(value));
    },
    async createIfAbsent(key, value) {
      if (m.has(key)) return false;
      m.set(key, JSON.stringify(value));
      return true;
    },
    async list(prefix) {
      return [...m.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
    async clear(prefix = "") {
      for (const k of [...m.keys()]) if (k.startsWith(prefix)) m.delete(k);
    },
  };
}

export async function blobsStore(name = "ops-sandbox"): Promise<Store> {
  const { getStore } = await import("@netlify/blobs");
  const s = getStore({ name, consistency: "strong" });
  return {
    async get(key) {
      return ((await s.get(key, { type: "json" })) as any) ?? null;
    },
    async set(key, value) {
      await s.setJSON(key, value);
    },
    async createIfAbsent(key, value) {
      const r: any = await s.setJSON(key, value, { onlyIfNew: true });
      return r?.modified !== false;
    },
    async list(prefix) {
      const { blobs } = await s.list({ prefix });
      return blobs.map((b: any) => b.key).sort();
    },
    async clear(prefix = "") {
      const { blobs } = await s.list({ prefix });
      for (const b of blobs) await s.delete(b.key);
    },
  };
}
