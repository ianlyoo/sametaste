import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { AgentEventSchema, type AgentEvent } from "../contract";
import { loadPersona } from "../../personas";
import { QlooClient } from "../qloo/client";
import { agentEnv } from "./config";
import { agentStatus, handleAgentRequest, isBundledPersona, personaCacheKey, recordedEvents, type HandlerDeps } from "./handler";
import { SNAPSHOTS } from "../../personas/snapshots";
import { FileKV, MemoryKV, UpstashKV } from "./kv";
import { AgentRequestSchema } from "../contract";

// whole scripted runs; the shared box can be slow under load
vi.setConfig({ testTimeout: 20_000 });

/** A path whose parent is a regular file, so mkdir/write fail with ENOTDIR. */
function unwritablePath() {
  const dir = mkdtempSync(path.join(tmpdir(), "st-kv-"));
  writeFileSync(path.join(dir, "file"), "x");
  return path.join(dir, "file", "state.json");
}

const FAKE_KEY = "sk-ant-test-0000000000000000";
const maya = loadPersona("maya-williamsburg")!;
const body = (extra: Record<string, unknown> = {}) => JSON.stringify({ personaId: maya.id, location: maya.location, merchants: maya.merchants, ...extra });
const post = (b: string, ip = "203.0.113.7") =>
  new Request("http://local/api/agent", { method: "POST", body: b, headers: { "content-type": "application/json", "x-forwarded-for": ip } });
const read = async (res: Response): Promise<AgentEvent[]> =>
  (await res.text())
    .split("\n")
    .filter(Boolean)
    .map((l) => AgentEventSchema.parse(JSON.parse(l)));
const qloo: HandlerDeps["qloo"] = (budget) => new QlooClient({ mock: true, budget });

/** Minimal Upstash REST stand-in: POST a JSON command array, get {result}. */
export function fakeUpstash() {
  const data = new Map<string, string>();
  const state = { down: false, auth: [] as string[] };
  const f = async (url: RequestInfo | URL, init?: RequestInit) => {
    state.auth.push(new Headers(init?.headers).get("authorization") ?? "");
    if (state.down) return new Response("unavailable", { status: 500 });
    const [cmd, key, ...rest] = JSON.parse(String(init?.body)) as string[];
    let result: unknown = null;
    switch (String(cmd).toUpperCase()) {
      case "PING":
        result = "PONG";
        break;
      case "GET":
        result = data.get(key) ?? null;
        break;
      case "SET":
        data.set(key, String(rest[0]));
        result = "OK";
        break;
      case "INCRBYFLOAT": {
        const n = Number(data.get(key) ?? 0) + Number(rest[0]);
        data.set(key, String(n));
        result = String(n);
        break;
      }
      case "EXPIRE":
        result = 1;
        break;
      default:
        return Response.json({ error: "ERR unknown command" }, { status: 400 });
    }
    void url;
    return Response.json({ result });
  };
  return {
    data,
    fetch: f as typeof fetch,
    get auth() {
      return state.auth;
    },
    set down(v: boolean) {
      state.down = v;
    },
  };
}

const usage = { inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 100, text: 100, reasoning: 0 } };
function liveish() {
  let n = 0;
  const main = new MockLanguageModelV4({
    modelId: "claude-sonnet-5-5",
    doGenerate: async () => ({
      content: [
        n++ === 0
          ? { type: "tool-call" as const, toolCallId: "a", toolName: "normalize_merchants", input: "{}" }
          : { type: "tool-call" as const, toolCallId: "b", toolName: "plan_writer", input: JSON.stringify({ summary: "ok" }) },
      ],
      finishReason: { unified: "tool-calls", raw: undefined },
      usage,
      warnings: [],
    }),
  });
  const normalizer = new MockLanguageModelV4({ modelId: "claude-haiku-5-5", doGenerate: async () => { throw new Error("unused"); } });
  return { main, normalizer };
}

describe("POST /api/agent handler", () => {
  it("streams a scripted run when no key is set (dev)", async () => {
    const res = await handleAgentRequest(post(body()), { env: agentEnv({ NODE_ENV: "test" }), kv: new MemoryKV(), qloo });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/x-ndjson/);
    const evs = await read(res);
    expect(evs[0].type).toBe("run_started");
    expect(evs.at(-1)?.type).toBe("done");
    expect(evs.some((e) => e.type === "plan_ready")).toBe(true);
  });

  it("rejects bad JSON, schema errors and oversized bodies as NDJSON", async () => {
    const deps = { env: agentEnv({ NODE_ENV: "test" }), kv: new MemoryKV(), qloo };
    const bad = await handleAgentRequest(post("{"), deps);
    expect(bad.status).toBe(400);
    expect((await read(bad))[0]).toMatchObject({ type: "error", code: "bad_request" });
    const schema = await handleAgentRequest(post(JSON.stringify({ location: { label: "x" }, merchants: [] })), deps);
    expect(schema.status).toBe(400);
    const big = await handleAgentRequest(post(" ".repeat(300 * 1024)), deps);
    expect(big.status).toBe(413);
  });

  it("rate-limits per IP", async () => {
    const deps = { env: agentEnv({ NODE_ENV: "test", RATE_LIMIT_MAX: "2" }), kv: new MemoryKV(), qloo };
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await handleAgentRequest(post(body()), deps)).status);
    expect(codes).toEqual([200, 200, 429]);
    expect((await handleAgentRequest(post(body(), "198.51.100.2"), deps)).status).toBe(200);
  });

  it("records spend, caches persona runs and replays them above the cap", async () => {
    const kv = new MemoryKV();
    const env = agentEnv({ NODE_ENV: "test", ANTHROPIC_API_KEY: FAKE_KEY, TOTAL_SPEND_CAP_USD: "0.004" });
    expect(env.scripted).toBe(false);
    const first = await read(await handleAgentRequest(post(body()), { env, kv, qloo, models: liveish(), bypassSnapshots: true }));
    expect(first.at(-1)).toMatchObject({ type: "done", reason: "complete" });
    expect((first.at(-1) as Extract<AgentEvent, { type: "done" }>).usage.costUsd).toBeGreaterThan(0.004);
    // now over the total cap: the cached persona run is replayed
    const again = await handleAgentRequest(post(body(), "198.51.100.3"), { env, kv, qloo, models: liveish(), bypassSnapshots: true });
    const evs = await read(again);
    expect(evs[0]).toMatchObject({ type: "run_started", fromCache: true });
    expect(evs[0].runId).not.toBe(first[0].runId);
    expect(evs.filter((e) => e.type === "plan_ready")).toHaveLength(1);
    // a custom statement is refused with spend_cap
    const custom = await handleAgentRequest(post(body({ personaId: undefined }), "198.51.100.4"), { env, kv, qloo, models: liveish() });
    expect(custom.status).toBe(503);
    expect((await read(custom))[0]).toMatchObject({ type: "error", code: "spend_cap" });
  });

  it("production without a persistent store fails closed and serves the persona snapshot", async () => {
    const env = agentEnv({ NODE_ENV: "production", ANTHROPIC_API_KEY: FAKE_KEY });
    const main = new MockLanguageModelV4({ doGenerate: async () => { throw new Error("must not be called"); } });
    for (const kv of [new MemoryKV(), new FileKV(unwritablePath())]) {
      // the recorded run, and (no recording) the free scripted run on the mock
      const res = await handleAgentRequest(post(body()), { env, kv, qloo, models: { main, normalizer: main } });
      expect(res.status).toBe(200);
      const evs = await read(res);
      expect(evs[0]).toMatchObject({ type: "run_started", fromCache: true });
      expect(evs.some((e) => e.type === "plan_ready")).toBe(true);
      const scripted = await read(await handleAgentRequest(post(body(), "198.51.100.8"), { env, kv, qloo, models: { main, normalizer: main }, bypassSnapshots: true }));
      expect(scripted[0]).toMatchObject({ type: "run_started", fromCache: true, qlooMock: true });
      expect(scripted.at(-1)).toMatchObject({ type: "done", usage: { costUsd: 0 } });
      const custom = await handleAgentRequest(post(body({ personaId: undefined }), "198.51.100.9"), { env, kv, qloo, models: { main, normalizer: main } });
      expect(custom.status).toBe(503);
      const err = (await read(custom))[0];
      expect(err.type === "error" && ["spend_cap", "internal"].includes(err.code)).toBe(true);
    }
    expect(main.doGenerateCalls).toHaveLength(0);
  });

  it("a sample persona replays its recorded run (the /demo events), also for one reject", async () => {
    const snap = SNAPSHOTS["maya-williamsburg"];
    expect(snap).toBeDefined();
    const main = new MockLanguageModelV4({ doGenerate: async () => { throw new Error("must not be called"); } });
    const env = agentEnv({ NODE_ENV: "production", ANTHROPIC_API_KEY: FAKE_KEY });
    const redis = fakeUpstash();
    const kv = new UpstashKV("https://example-upstash.invalid", "test-token-123", redis.fetch);
    const strip = (evs: AgentEvent[]) => evs.map((e) => JSON.stringify(AgentEventSchema.parse({ ...e, runId: "", seq: 0, ts: "", ...(e.type === "run_started" ? { fromCache: true } : {}) })));
    // the server's persona aggregation (/) and the client's own (/demo) both get the recording, live key or not
    for (const merchants of [maya.merchants, snap.request.merchants]) {
      for (const mode of ["sametaste", "llm_only"] as const) {
        const evs = await read(await handleAgentRequest(post(JSON.stringify({ personaId: maya.id, location: maya.location, merchants, mode })), { env, kv, qloo, models: { main, normalizer: main } }));
        expect(evs[0]).toMatchObject({ type: "run_started", fromCache: true });
        expect(strip(evs)).toEqual(strip(snap[mode]));
      }
    }
    // rejecting one swap of the recorded plan replays that re-plan
    const planEv = snap.sametaste.findLast((e) => e.type === "plan_ready")!;
    const plan = planEv.type === "plan_ready" ? planEv.plan : undefined!;
    const s = plan.swaps[0];
    const replan = await read(
      await handleAgentRequest(
        post(body({ previousPlan: { ...plan, swaps: plan.swaps.map((x) => (x.id === s.id ? { ...x, status: "rejected" } : x)) }, feedback: [{ swapId: s.id, merchantKey: s.merchantKey, candidateEntityId: s.to.entity.id, verdict: "reject" }] }), "198.51.100.30"),
        { env, kv, qloo, models: { main, normalizer: main } },
      ),
    );
    expect(strip(replan)).toEqual(strip(snap.replans[s.id]));
    expect(main.doGenerateCalls).toHaveLength(0);
    // an edited statement is not the recording
    const edited = maya.merchants.map((m, i) => (i ? m : { ...m, totalSpend: m.totalSpend + 1 }));
    expect(recordedEvents(AgentRequestSchema.parse({ personaId: maya.id, location: maya.location, merchants: edited }))).toBeUndefined();
  });

  it("an edited persona payload does not get the snapshot", () => {
    const a = AgentRequestSchema.parse(JSON.parse(body()));
    expect(isBundledPersona(a)).toBe(true);
    expect(isBundledPersona({ ...a, merchants: a.merchants.map((m, i) => (i ? m : { ...m, totalSpend: m.totalSpend + 1 })) })).toBe(false);
    expect(isBundledPersona({ ...a, personaId: undefined })).toBe(false);
  });

  it("production with Upstash runs live and records spend in Redis", async () => {
    const redis = fakeUpstash();
    const kv = new UpstashKV("https://example-upstash.invalid", "test-token-123", redis.fetch);
    const env = agentEnv({ NODE_ENV: "production", ANTHROPIC_API_KEY: FAKE_KEY });
    const evs = await read(await handleAgentRequest(post(body()), { env, kv, qloo, models: liveish(), bypassSnapshots: true }));
    expect(evs[0]).toMatchObject({ type: "run_started", fromCache: false });
    const done = evs.at(-1) as Extract<AgentEvent, { type: "done" }>;
    expect(done.reason).toBe("complete");
    expect(Number(redis.data.get("spend:total"))).toBeCloseTo(done.usage.costUsd, 6);
    expect([...redis.data.keys()].some((k) => k.startsWith("persona:maya-williamsburg:"))).toBe(true);
    // Redis down: fail closed, persona snapshot only, no model call
    redis.down = true;
    const models = liveish();
    const res = await handleAgentRequest(post(body(), "198.51.100.20"), { env, kv, qloo, models });
    expect((await read(res))[0]).toMatchObject({ type: "run_started", fromCache: true });
    expect(models.main.doGenerateCalls).toHaveLength(0);
    const custom = await handleAgentRequest(post(body({ personaId: undefined }), "198.51.100.21"), { env, kv, qloo, models });
    expect(custom.status).toBe(503);
  });

  it("never leaks the key in events or logs when the model fails", async () => {
    const logs: string[] = [];
    const main = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error(`401 invalid x-api-key ${FAKE_KEY}`);
      },
    });
    const env = agentEnv({ NODE_ENV: "test", ANTHROPIC_API_KEY: FAKE_KEY });
    const res = await handleAgentRequest(post(body({ personaId: undefined })), { env, kv: new MemoryKV(), qloo, models: { main, normalizer: main }, log: (m) => logs.push(m) });
    const text = await res.clone().text();
    expect(text).not.toContain(FAKE_KEY);
    expect(text).not.toContain("sk-ant");
    expect(logs.join("\n")).not.toContain(FAKE_KEY);
    expect(logs.join("\n")).toContain("[redacted]");
    const evs = await read(res);
    expect(evs.some((e) => e.type === "error" && e.code === "model_error")).toBe(true);
    expect(evs.at(-1)).toMatchObject({ type: "done", reason: "error" });
  });

  it("status exposes no secrets", async () => {
    const s = await agentStatus({ env: agentEnv({ NODE_ENV: "test", ANTHROPIC_API_KEY: FAKE_KEY }), kv: new MemoryKV() });
    expect(JSON.stringify(s)).not.toContain(FAKE_KEY);
    expect(s).toMatchObject({ model: "claude-sonnet-5-5", liveRunsAvailable: true });
  });

  it("persona cache key ignores re-plans and depends on the payload", () => {
    const a = AgentRequestSchema.parse(JSON.parse(body()));
    expect(personaCacheKey(a)).toMatch(/^persona:maya-williamsburg:sametaste:/);
    expect(personaCacheKey({ ...a, merchants: a.merchants.slice(1) })).not.toBe(personaCacheKey(a));
    expect(personaCacheKey({ ...a, answers: [{ questionId: "q", optionId: "o1" }] })).toBeUndefined();
  });
});

describe("KV stores", () => {
  it("Upstash REST: command arrays with a bearer token, JSON values, float counters", async () => {
    const redis = fakeUpstash();
    const kv = new UpstashKV("https://example-upstash.invalid/", "test-token-123", redis.fetch);
    expect(await kv.probe()).toBe(true);
    await kv.set("persona:x", [{ a: 1 }], 60);
    expect(await kv.get("persona:x")).toEqual([{ a: 1 }]);
    expect(await kv.get("missing")).toBeUndefined();
    expect(await kv.incrByFloat("spend:total", 0.25)).toBeCloseTo(0.25);
    expect(await kv.incrByFloat("spend:total", 0.5, 60)).toBeCloseTo(0.75);
    expect(redis.auth.every((a) => a === "Bearer test-token-123")).toBe(true);
    redis.down = true;
    expect(await kv.probe()).toBe(false);
    await expect(kv.get("persona:x")).rejects.toThrow(/HTTP 500/);
    await kv.get("persona:x").catch((e: Error) => expect(e.message).not.toContain("test-token-123"));
  });

  it("kvFromEnv picks Upstash when both env vars are set", async () => {
    const { kvFromEnv, setSharedKV } = await import("./kv");
    setSharedKV(null);
    const env = agentEnv({ NODE_ENV: "production", UPSTASH_REDIS_REST_URL: "https://example-upstash.invalid", UPSTASH_REDIS_REST_TOKEN: "t" });
    expect(kvFromEnv(env)).toBeInstanceOf(UpstashKV);
    setSharedKV(null);
  });

  it("a file store that cannot be written is not persistent", async () => {
    const kv = new FileKV(unwritablePath());
    expect(await kv.probe()).toBe(false);
    expect(kv.persistent).toBe(false);
    const { SpendLedger } = await import("./spend");
    expect((await new SpendLedger(kv, { totalCapUsd: 100, dailyCapUsd: 15, requirePersistent: true }).status()).reason).toBe("no_persistent_ledger");
  });
});
