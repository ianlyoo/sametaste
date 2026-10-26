/**
 * HTTP handling for POST /api/agent, kept out of the route file so tests can
 * call it directly. Order: size check, JSON + schema, per-IP rate limit,
 * spend ledger, then the run streamed as NDJSON.
 *
 * Above the spend cap only cached persona runs are served. The Anthropic key
 * is read server-side here and never appears in events, logs or errors.
 */
import { createHash } from "node:crypto";
import type { LanguageModel } from "ai";
import {
  AGENT_STREAM_CONTENT_TYPE,
  AgentRequestSchema,
  CONTRACT_REVISION,
  CONTRACT_VERSION,
  type AgentEvent,
  type ParsedAgentRequest,
} from "../contract";
import { QlooClient, qlooConfigFromEnv, type CallBudget } from "../qloo/client";
import { AGENT_MODEL_ID, NORMALIZER_MODEL_ID, agentEnv, type AgentEnv } from "./config";
import { toNdjson } from "./events";
import { kvFromEnv, type KV } from "./kv";
import { clientIp, rateLimit } from "./rateLimit";
import { loadPersona } from "../../personas";
import { SNAPSHOTS, type PersonaSnapshot } from "../../personas/snapshots";
import { personaRecording } from "./recordings";
import { runAgent } from "./run";
import { SpendLedger } from "./spend";

export const MAX_BODY_BYTES = 256 * 1024;
const PERSONA_CACHE_TTL_S = 30 * 86_400;
const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";

export interface HandlerDeps {
  env?: AgentEnv;
  kv?: KV;
  /** Test hooks. */
  models?: { main: LanguageModel; normalizer: LanguageModel };
  qloo?: (budget: CallBudget) => QlooClient;
  log?: (msg: string) => void;
  /** eval/record-demo: run live even for a sample persona that has a recorded snapshot. */
  bypassSnapshots?: boolean;
}

const headers = {
  "content-type": `${AGENT_STREAM_CONTENT_TYPE}; charset=utf-8`,
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

/** A short NDJSON response (error + done) for requests that never start a run. */
function refuse(status: number, code: Extract<AgentEvent, { type: "error" }>["code"], message: string, extra: Record<string, string> = {}) {
  const runId = crypto.randomUUID();
  const ts = new Date().toISOString();
  const evs: AgentEvent[] = [
    { type: "error", code, message, retryable: code === "rate_limited", runId, seq: 0, ts },
    { type: "done", reason: code === "spend_cap" ? "limit_reached" : "error", usage: { toolTurns: 0, qlooCalls: 0, costUsd: 0 }, runId, seq: 1, ts },
  ];
  return new Response(evs.map(toNdjson).join(""), { status, headers: { ...headers, ...extra } });
}

/** Cache key for a persona run: persona id + hash of exactly what was sent. */
export function personaCacheKey(req: ParsedAgentRequest): string | undefined {
  if (!req.personaId || req.answers?.length || req.feedback?.length || req.previousPlan) return undefined;
  const h = createHash("sha256")
    .update(JSON.stringify({ m: req.mode, l: req.location, x: req.merchants, a: req.assumptions ?? null }))
    .digest("hex")
    .slice(0, 16);
  return `persona:${req.personaId.slice(0, 40)}:${req.mode}:${h}`;
}

/** The request's statement is a sample persona's, unmodified (the server's aggregation). */
function isPersonaStatement(req: ParsedAgentRequest): boolean {
  const p = req.personaId ? loadPersona(req.personaId) : undefined;
  if (!p) return false;
  const ref = AgentRequestSchema.parse({ personaId: p.id, location: p.location, merchants: p.merchants, mode: req.mode });
  return JSON.stringify([ref.location, ref.merchants]) === JSON.stringify([req.location, req.merchants]);
}

/**
 * Built-in fallback for an unmodified sample persona without a recorded
 * snapshot: the deterministic scripted driver on the synthetic Qloo mock.
 * No model, no network, no spend; marked fromCache and qlooMock in run_started.
 */
export function isBundledPersona(req: ParsedAgentRequest): boolean {
  if (req.answers?.length || req.feedback?.length || req.previousPlan) return false;
  return isPersonaStatement(req);
}

/**
 * The recorded run for a sample persona, so `/` and /demo show the same
 * events: the first run, the model-alone run, and the re-plan after
 * rejecting any one swap of the recorded plan. `snap` is the live recording
 * from KV (lib/agent/recordings.ts); by default the bundled mock one
 * (personas/snapshots).
 */
export function recordedEvents(req: ParsedAgentRequest, snap: PersonaSnapshot | undefined = req.personaId ? SNAPSHOTS[req.personaId] : undefined): AgentEvent[] | undefined {
  if (!snap || req.answers?.length) return undefined;
  const ref = AgentRequestSchema.parse({ personaId: snap.personaId, mode: req.mode, ...snap.request });
  const same = JSON.stringify([ref.location, ref.merchants]) === JSON.stringify([req.location, req.merchants]) || isPersonaStatement(req);
  if (!same) return undefined;
  if (!req.previousPlan && !req.feedback?.length) return snap[req.mode];
  const plan = snap.sametaste.findLast((e) => e.type === "plan_ready");
  const rejects = (req.feedback ?? []).filter((f) => f.verdict === "reject");
  if (req.mode !== "sametaste" || plan?.type !== "plan_ready" || req.previousPlan?.id !== plan.plan.id) return undefined;
  // one reject (accepts alongside are fine); a second reject needs a live run
  if (rejects.length !== 1) return undefined;
  return snap.replans[rejects[0].swapId];
}

/** recordedEvents over the live recording in KV, else the bundled mock one. */
async function recordedRun(kv: KV, req: ParsedAgentRequest): Promise<AgentEvent[] | undefined> {
  if (!req.personaId) return undefined;
  const r = await personaRecording(kv, req.personaId);
  return r ? recordedEvents(req, r.snap) : undefined;
}

function snapshot(req: ParsedAgentRequest, signal: AbortSignal): Response {
  return streamResponse(async (write) => {
    await runAgent(req, {
      scripted: true,
      qloo: (budget) => new QlooClient({ mock: true, budget }),
      fromCache: true,
      abortSignal: signal,
      write,
    });
  });
}

/** KV-cached live persona run, else the built-in snapshot, else undefined. */
async function cachedPersona(kv: KV, req: ParsedAgentRequest, cacheKey: string | undefined, signal: AbortSignal) {
  const cached = cacheKey ? await kv.get<AgentEvent[]>(cacheKey).catch(() => undefined) : undefined;
  if (cached?.length) return streamResponse(async (w) => replay(cached, w));
  if (isBundledPersona(req)) return snapshot(req, signal);
  return undefined;
}

/** Re-stamps cached events under a new run id with fromCache=true. */
function replay(cached: AgentEvent[], write: (ev: AgentEvent) => void) {
  const runId = crypto.randomUUID();
  cached.forEach((ev, seq) => {
    const out = { ...ev, runId, seq, ts: new Date().toISOString() } as AgentEvent;
    if (out.type === "run_started") out.fromCache = true;
    write(out);
  });
}

function redact(s: string, secrets: (string | undefined)[]): string {
  let out = s;
  for (const k of secrets) if (k && k.length > 6) out = out.split(k).join("[redacted]");
  return out.replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 300);
}

function streamResponse(run: (write: (ev: AgentEvent) => void) => Promise<void>): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const write = (ev: AgentEvent) => {
        if (!open) return;
        try {
          controller.enqueue(enc.encode(toNdjson(ev)));
        } catch {
          open = false; // client went away
        }
      };
      try {
        await run(write);
      } finally {
        if (open) controller.close();
      }
    },
  });
  return new Response(body, { status: 200, headers });
}

export async function handleAgentRequest(request: Request, deps: HandlerDeps = {}): Promise<Response> {
  const env = deps.env ?? agentEnv();
  const log = deps.log ?? ((m: string) => console.error(m));
  const kv = deps.kv ?? kvFromEnv(env);

  const len = Number(request.headers.get("content-length") ?? 0);
  if (len > MAX_BODY_BYTES) return refuse(413, "bad_request", "The request is too large.");
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return refuse(400, "bad_request", "Could not read the request.");
  }
  if (raw.length > MAX_BODY_BYTES) return refuse(413, "bad_request", "The request is too large.");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return refuse(400, "bad_request", "The request is not valid JSON.");
  }
  const parsed = AgentRequestSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return refuse(400, "bad_request", `Invalid request${first ? ` at ${first.path.join(".") || "body"}: ${first.message}` : ""}.`.slice(0, 200));
  }
  const req = parsed.data;

  let rl;
  try {
    rl = await rateLimit(kv, clientIp(request.headers), { max: env.rateLimitMax, windowS: env.rateLimitWindowS });
  } catch (err) {
    log(`[agent] rate limit store error: ${redact(String((err as Error)?.message ?? err), [env.upstashToken])}`);
    // the store is down: fail closed, but the free recorded persona runs still work
    const recorded = deps.bypassSnapshots ? undefined : await recordedRun(kv, req);
    if (recorded) return streamResponse(async (w) => replay(recorded, w));
    if (isBundledPersona(req)) return snapshot(req, request.signal);
    return refuse(503, "internal", "The service is busy; try again shortly.");
  }
  if (!rl.ok) {
    return refuse(429, "rate_limited", `Too many runs from your network; try again in ${rl.retryAfterS}s.`, { "retry-after": String(rl.retryAfterS) });
  }

  // a sample persona replays its recorded run: free, and the same as /demo
  const recorded = deps.bypassSnapshots ? undefined : await recordedRun(kv, req);
  if (recorded) return streamResponse(async (w) => replay(recorded, w));

  const live = !!env.anthropicApiKey && !env.scripted;
  const cacheKey = personaCacheKey(req);
  const ledger = new SpendLedger(kv, { totalCapUsd: env.totalSpendCapUsd, dailyCapUsd: env.dailySpendCapUsd, requirePersistent: env.requirePersistentLedger });

  if (!live && !env.scripted && !deps.models) {
    // production without a model key: cached persona runs only
    const cached = await cachedPersona(kv, req, cacheKey, request.signal);
    if (cached) return cached;
    return refuse(503, "model_error", "The agent is not configured right now; try a sample persona.");
  }

  if (live || deps.models) {
    const status = await ledger.status().catch(() => ({ blocked: true, reason: "no_persistent_ledger" as const }));
    if (status.blocked) {
      const cached = await cachedPersona(kv, req, cacheKey, request.signal);
      if (cached) return cached;
      return refuse(
        503,
        "spend_cap",
        status.reason === "daily_cap"
          ? "Today's demo budget is used up. Sample personas still work; try again tomorrow."
          : status.reason === "no_persistent_ledger"
            ? "Live runs are paused right now. Sample personas still work."
            : "The demo budget is used up. Sample personas still work.",
      );
    }
  }

  let models = deps.models;
  if (!models && live) {
    // lazy: the provider module reads ANTHROPIC_BASE_URL at import time.
    // The base URL is pinned so a stray env value can never redirect the key.
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    const anthropic = createAnthropic({ apiKey: env.anthropicApiKey, baseURL: ANTHROPIC_BASE_URL });
    models = { main: anthropic(AGENT_MODEL_ID), normalizer: anthropic(NORMALIZER_MODEL_ID) };
  }

  return streamResponse(async (write) => {
    const events: AgentEvent[] = [];
    const tee = (ev: AgentEvent) => {
      events.push(ev);
      write(ev);
    };
    await runAgent(req, {
      model: models?.main,
      modelId: AGENT_MODEL_ID,
      normalizerModel: models?.normalizer,
      normalizerModelId: NORMALIZER_MODEL_ID,
      scripted: !models,
      qloo: deps.qloo,
      ledger: models ? ledger : undefined,
      abortSignal: request.signal,
      write: tee,
      onError: (err) => {
        const e = err as { name?: string; statusCode?: number; message?: string };
        log(`[agent] run error ${e?.name ?? "Error"}${e?.statusCode ? ` ${e.statusCode}` : ""}: ${redact(String(e?.message ?? err), [env.anthropicApiKey, qlooConfigFromEnv().apiKey])}`);
      },
    });
    const done = events.at(-1);
    if (cacheKey && models && done?.type === "done" && (done.reason === "complete" || done.reason === "awaiting_answer")) {
      await kv.set(cacheKey, events, PERSONA_CACHE_TTL_S).catch(() => undefined);
    }
  });
}

/** Non-secret status for the UI (GET /api/agent). */
export async function agentStatus(deps: HandlerDeps = {}) {
  const env = deps.env ?? agentEnv();
  const kv = deps.kv ?? kvFromEnv(env);
  const live = !!env.anthropicApiKey && !env.scripted;
  const ledger = new SpendLedger(kv, { totalCapUsd: env.totalSpendCapUsd, dailyCapUsd: env.dailySpendCapUsd, requirePersistent: env.requirePersistentLedger });
  const s = live ? await ledger.status().catch(() => ({ blocked: true, reason: "no_persistent_ledger" as const })) : undefined;
  return {
    contractVersion: CONTRACT_VERSION,
    contractRevision: CONTRACT_REVISION,
    model: live ? AGENT_MODEL_ID : env.scripted ? "scripted" : "unavailable",
    qlooMock: qlooConfigFromEnv().mock,
    liveRunsAvailable: live && !s?.blocked,
    blockedReason: s?.blocked ? s.reason : undefined,
  };
}
