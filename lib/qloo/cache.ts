/**
 * Private server-side cache for Qloo responses. Qloo allows private caching
 * with no time limit; responses must never be committed or sent to logs.
 */
export interface QlooCache {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export class MemoryCache implements QlooCache {
  private readonly map = new Map<string, { value: unknown; expires: number }>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(opts: { maxEntries?: number; ttlMs?: number } = {}) {
    this.maxEntries = opts.maxEntries ?? 1000;
    this.ttlMs = opts.ttlMs ?? 3600_000;
  }

  async get(key: string) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // refresh LRU position
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  async set(key: string, value: unknown) {
    this.map.delete(key);
    this.map.set(key, { value, expires: Date.now() + this.ttlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get size() {
    return this.map.size;
  }
}
