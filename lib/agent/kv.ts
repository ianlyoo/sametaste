/**
 * Tiny KV used for the spend ledger, rate limits and cached persona runs.
 * Upstash Redis REST when configured, else a JSON file (dev), else memory.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export interface KV {
  readonly persistent: boolean;
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlS?: number): Promise<void>;
  incrByFloat(key: string, by: number, ttlS?: number): Promise<number>;
  /** Checks the store can persist right now (writable file, reachable Redis). */
  probe?(): Promise<boolean>;
}

type Entry = { v: unknown; exp?: number };

export class MemoryKV implements KV {
  get persistent(): boolean {
    return false;
  }
  protected data = new Map<string, Entry>();
  protected live(key: string): Entry | undefined {
    const e = this.data.get(key);
    if (e?.exp && e.exp < Date.now()) {
      this.data.delete(key);
      return undefined;
    }
    return e;
  }
  async get<T>(key: string) {
    return this.live(key)?.v as T | undefined;
  }
  async set(key: string, value: unknown, ttlS?: number) {
    this.data.set(key, { v: value, exp: ttlS ? Date.now() + ttlS * 1000 : undefined });
    await this.flush();
  }
  async incrByFloat(key: string, by: number, ttlS?: number) {
    const cur = this.live(key);
    const n = (typeof cur?.v === "number" ? cur.v : 0) + by;
    this.data.set(key, { v: n, exp: cur?.exp ?? (ttlS ? Date.now() + ttlS * 1000 : undefined) });
    await this.flush();
    return n;
  }
  protected async flush() {}
}

/** Dev-only persistence across restarts. Single process; not for serverless. */
export class FileKV extends MemoryKV {
  /** False once a write failed or the probe found the file not writable. */
  private writable: boolean | undefined;
  override get persistent(): boolean {
    return this.writable !== false;
  }
  private loaded = false;
  private chain: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) {
    super();
  }
  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await fs.readFile(this.file, "utf8")) as Record<string, Entry>;
      this.data = new Map(Object.entries(raw));
    } catch {
      // first run
    }
  }
  override async get<T>(key: string) {
    await this.load();
    return super.get<T>(key);
  }
  override async set(key: string, value: unknown, ttlS?: number) {
    await this.load();
    return super.set(key, value, ttlS);
  }
  override async incrByFloat(key: string, by: number, ttlS?: number) {
    await this.load();
    return super.incrByFloat(key, by, ttlS);
  }
  async probe(): Promise<boolean> {
    if (this.writable !== undefined) return this.writable;
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const p = `${this.file}.probe`;
      await fs.writeFile(p, "ok", { mode: 0o600 });
      await fs.unlink(p);
      this.writable = true;
    } catch {
      this.writable = false;
    }
    return this.writable;
  }
  protected override async flush() {
    const snapshot = JSON.stringify(Object.fromEntries(this.data));
    const write = this.chain.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, snapshot, { mode: 0o600 });
      await fs.rename(tmp, this.file);
    });
    this.chain = write;
    try {
      await write;
    } catch (err) {
      this.writable = false;
      throw err;
    }
  }
}

/** Upstash Redis over its REST API (no SDK dependency). */
export class UpstashKV implements KV {
  readonly persistent = true;
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  private async cmd(args: (string | number)[]): Promise<unknown> {
    const res = await this.fetchImpl(this.url.replace(/\/+$/, ""), {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`KV command ${String(args[0])} failed with HTTP ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: string };
    if (body.error) throw new Error(`KV command ${String(args[0])} failed`);
    return body.result;
  }
  async get<T>(key: string) {
    const r = await this.cmd(["GET", key]);
    if (r === null || r === undefined) return undefined;
    try {
      return JSON.parse(String(r)) as T;
    } catch {
      return r as T;
    }
  }
  async set(key: string, value: unknown, ttlS?: number) {
    const args: (string | number)[] = ["SET", key, JSON.stringify(value)];
    if (ttlS) args.push("EX", Math.ceil(ttlS));
    await this.cmd(args);
  }
  async probe(): Promise<boolean> {
    try {
      return (await this.cmd(["PING"])) === "PONG";
    } catch {
      return false;
    }
  }
  async incrByFloat(key: string, by: number, ttlS?: number) {
    const n = Number(await this.cmd(["INCRBYFLOAT", key, by]));
    if (ttlS) await this.cmd(["EXPIRE", key, Math.ceil(ttlS), "NX"]);
    return n;
  }
}

let shared: KV | null = null;

export function kvFromEnv(opts: { upstashUrl?: string; upstashToken?: string; stateFile?: string }): KV {
  if (shared) return shared;
  if (opts.upstashUrl && opts.upstashToken) {
    shared = new UpstashKV(opts.upstashUrl, opts.upstashToken);
  } else if (!process.env.VERCEL) {
    shared = new FileKV(opts.stateFile ?? path.join(process.cwd(), ".scratch", "sametaste-state.json"));
  } else {
    shared = new MemoryKV();
  }
  return shared;
}

/** Test hook. */
export function setSharedKV(kv: KV | null) {
  shared = kv;
}
