/**
 * Re-records the /demo replay fixtures in one command:
 *   npm run eval:record-demo                      (live LLM, Qloo as configured)
 *   npm run eval:record-demo -- --require-live-qloo   (key day: refuse the mock)
 * Options: --persona maya|dev|sam (default maya), --out <dir> (default
 * eval/fixtures on mock Qloo, .recordings/<persona-id> on live Qloo),
 * --client <dir> (lib/client to build requests with),
 * --no-replans, --scripted (no model; free, for pipeline checks),
 * --baseline-runs N (run the model-alone baseline N times, about $0.007
 * each: the first is the recorded run, all N go in its
 * `baseline_ready.proofRuns`, and the paper prints their spread).
 *
 * On live Qloo (Qloo's terms: no Qloo data in a public repository) the run
 * goes to the server's KV (lib/agent/recordings.ts; Upstash when
 * KV_REST_API_URL/TOKEN are set, else the local dev store) and to a
 * gitignored copy in .recordings/<persona-id>/; nothing tracked is written.
 * /demo (GET /api/recording) and the `/` fallback replay it from KV.
 *
 * On mock Qloo (QLOO_MOCK=1, or --scripted without a key) it writes the
 * tracked fallback, in the replay format (app/demo/replay.ts):
 *   <persona>.sametaste.ndjson   the SameTaste run
 *   <persona>.llm_only.ndjson    the model-alone baseline
 *   <persona>.replans.json       one re-plan per swap, keyed by the rejected swap id
 * the same events as personas/snapshots/<persona-id>.ts, and for maya the
 * scene's public/scene/demo copies. Commit those.
 * The requests are built exactly as the browser builds them: the persona CSV
 * goes through the client's own statement parser and merchant aggregation
 * (lib/client), then through handleAgentRequest like POST /api/agent. Spend
 * goes through the app's spend ledger and counts toward its caps.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentEvent, AgentRequest, MerchantAggregate, Plan, ProofSide } from "../lib/contract";
import { writeRecording, type StoredRecording } from "../lib/agent/recordings";
import { LOCAL_RECORDINGS, assertIgnored, writeLocalRecording } from "./recording-files";
import { agentEnv } from "../lib/agent/config";
import { handleAgentRequest } from "../lib/agent/handler";
import { kvFromEnv } from "../lib/agent/kv";
import { SpendLedger } from "../lib/agent/spend";
import { qlooConfigFromEnv } from "../lib/qloo/client";
import { PERSONAS } from "../personas";
import type { PersonaSnapshot } from "../personas/snapshots";
import { loadLocalEnv } from "./env";
import { printProof, SNAPSHOT_DIR, writeSnapshot } from "./snapshot-io";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

interface ClientLib {
  parseStatement(text: string): unknown;
  aggregateMerchants(statement: unknown): unknown[];
  toWire(m: unknown): MerchantAggregate;
}

/** The client's parser and aggregation, so merchant keys match what the scene computes from the CSV. */
async function loadClient(): Promise<{ lib: ClientLib; dir: string }> {
  const dirs = [arg("client"), "lib/client", "../wt-scene/lib/client", "../wt-ui/lib/client"].filter((d): d is string => !!d);
  for (const d of dirs) {
    const dir = resolve(d);
    if (!existsSync(join(dir, "statement.ts")) || !existsSync(join(dir, "merchants.ts"))) continue;
    const statement = await import(join(dir, "statement.ts"));
    const merchants = await import(join(dir, "merchants.ts"));
    return { lib: { parseStatement: statement.parseStatement, aggregateMerchants: merchants.aggregateMerchants, toWire: merchants.toWire }, dir };
  }
  throw new Error(`lib/client not found (tried ${dirs.join(", ")}); pass --client <dir>`);
}

const SECRET = /sk-ant-[A-Za-z0-9_-]{8,}/;

async function main() {
  loadLocalEnv();
  const short = arg("persona") ?? "maya";
  const persona = PERSONAS.find((p) => p.id.startsWith(short));
  if (!persona) throw new Error(`unknown persona ${short}`);
  const baselineRuns = Number(arg("baseline-runs") ?? 1);
  if (!Number.isInteger(baselineRuns) || baselineRuns < 1 || baselineRuns > 10) throw new Error("--baseline-runs takes 1..10");
  const scripted = flag("scripted");
  const base = agentEnv();
  if (!scripted && !base.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is not set (or pass --scripted)");
  const qloo = qlooConfigFromEnv();
  if (flag("require-live-qloo") && qloo.mock) throw new Error("Qloo is mocked (QLOO_MOCK=1 or no QLOO_API_KEY); refusing with --require-live-qloo");
  const outDir = arg("out") ?? (qloo.mock ? "eval/fixtures" : join(LOCAL_RECORDINGS, persona.id));
  // before any spend: a live recording may only land where git ignores it
  if (!qloo.mock) assertIgnored(outDir);
  // a local CLI, not a public endpoint: the per-IP rate limit does not apply
  const env = { ...base, scripted, rateLimitMax: 1000 };
  const kv = kvFromEnv(env);
  const ledger = new SpendLedger(kv, { totalCapUsd: env.totalSpendCapUsd, dailyCapUsd: env.dailySpendCapUsd });
  const spent0 = (await ledger.status()).totalUsd;

  const { lib, dir } = await loadClient();
  const csv = readFileSync(join("personas", persona.file), "utf8");
  const merchants = lib.aggregateMerchants(lib.parseStatement(csv)).map((m) => lib.toWire(m));
  const head: AgentRequest = { mode: "sametaste", personaId: persona.id, location: persona.location, merchants };
  console.log(`${persona.id}: ${merchants.length} merchants via ${dir}; model ${scripted ? "scripted" : "live"}, Qloo ${qloo.mock ? "MOCK" : "live"}`);

  const post = async (label: string, body: AgentRequest) => {
    const t0 = Date.now();
    const res = await handleAgentRequest(new Request("http://localhost/api/agent", { method: "POST", body: JSON.stringify(body) }), { env, kv, bypassSnapshots: true });
    const text = await res.text();
    if (SECRET.test(text)) throw new Error(`${label}: output contains a key-like string; nothing written`);
    const lines = text.split("\n").filter(Boolean);
    const events = lines.map((l) => JSON.parse(l) as AgentEvent);
    const done = events.at(-1);
    const err = events.find((e) => e.type === "error");
    if (res.status !== 200 || done?.type !== "done" || !["complete", "awaiting_answer"].includes(done.reason)) {
      throw new Error(`${label}: run failed (${res.status}${err?.type === "error" ? `, ${err.code}: ${err.message}` : ""})`);
    }
    const start = events[0];
    if (start.type === "run_started" && start.fromCache) throw new Error(`${label}: served from cache, not recorded live`);
    console.log(`  ${label}: ${events.length} events, ${((Date.now() - t0) / 1000).toFixed(1)}s, $${done.usage.costUsd.toFixed(4)}`);
    return { lines, events };
  };

  const main = await post("sametaste", head);
  const planEv = main.events.filter((e) => e.type === "plan_ready").at(-1);
  if (planEv?.type !== "plan_ready") throw new Error("sametaste: no plan");
  const plan: Plan = planEv.plan;
  const baseline = await post("llm_only", { ...head, mode: "llm_only" });
  if (baselineRuns > 1) {
    // the model alone is not deterministic: record every run's proof on the first run's baseline_ready
    const at = baseline.events.findIndex((e) => e.type === "baseline_ready");
    const first = baseline.events[at];
    if (first?.type !== "baseline_ready" || !first.proof) throw new Error("llm_only: no measured proof to repeat");
    const runs: ProofSide[] = [first.proof];
    for (let i = 2; i <= baselineRuns; i++) {
      const again = (await post(`llm_only ${i}/${baselineRuns}`, { ...head, mode: "llm_only" })).events.find((e) => e.type === "baseline_ready");
      if (again?.type !== "baseline_ready" || !again.proof) throw new Error(`llm_only ${i}: no measured proof`);
      runs.push(again.proof);
    }
    const withRuns: AgentEvent = { ...first, proofRuns: runs };
    baseline.events[at] = withRuns;
    baseline.lines[at] = JSON.stringify(withRuns);
  }

  const replans: Record<string, string[]> = {};
  const replanEvents: Record<string, AgentEvent[]> = {};
  if (!flag("no-replans")) {
    // what useAgentFlow sends after a reject: the last plan with that swap rejected, plus the feedback
    for (const s of plan.swaps.filter((x) => x.status !== "rejected")) {
      const r = await post(`reject ${s.from.name}`, {
        ...head,
        previousPlan: { ...plan, swaps: plan.swaps.map((x) => (x.id === s.id ? { ...x, status: "rejected" as const } : x)) },
        feedback: [{ swapId: s.id, merchantKey: s.merchantKey, candidateEntityId: s.to.entity.id, verdict: "reject" }],
      });
      replans[s.id] = r.lines;
      replanEvents[s.id] = r.events;
    }
  }

  const recordedAt = new Date().toISOString();
  const request = { location: head.location, merchants };
  const spent = (await ledger.status()).totalUsd - spent0;
  const t = plan.totals;
  if (!qloo.mock) {
    // live Qloo: the server's KV and a gitignored copy, never a tracked file
    const rec: StoredRecording = {
      version: 1,
      personaId: persona.id,
      recordedAt,
      qlooMock: false,
      request,
      parts: { sametaste: `${main.lines.join("\n")}\n`, llm_only: `${baseline.lines.join("\n")}\n`, replans: JSON.stringify(replans) },
    };
    writeLocalRecording(outDir, rec);
    const w = await writeRecording(kv, rec);
    console.log(`wrote ${outDir}/ (gitignored) and KV ${w.key} rev ${w.rev} (${kv.persistent && env.upstashUrl ? "Upstash" : "local dev store"})`);
  } else {
    mkdirSync(outDir, { recursive: true });
    const name = short.replace(/[^a-z]/g, "");
    const files: [string, string][] = [
      [`${name}.sametaste.ndjson`, `${main.lines.join("\n")}\n`],
      [`${name}.llm_only.ndjson`, `${baseline.lines.join("\n")}\n`],
      ...(flag("no-replans") ? [] : [[`${name}.replans.json`, JSON.stringify(replans)] as [string, string]]),
    ];
    for (const [f, text] of files) writeFileSync(join(outDir, f), text);
    // the scene's copies of the maya run (its tests read them)
    if (name === "maya" && !arg("out")) for (const [f, text] of files) writeFileSync(join("public/scene/demo", f), text);
    // the same events for the production fallback (bundled; JSON.parse keeps tsc fast)
    const snap: PersonaSnapshot = {
      version: 1,
      personaId: persona.id,
      recordedAt,
      qlooMock: true,
      request,
      sametaste: main.events,
      llm_only: baseline.events,
      replans: replanEvents,
    };
    writeSnapshot(snap);
    console.log(`wrote ${outDir}/${name}.{sametaste.ndjson,llm_only.ndjson${flag("no-replans") ? "" : ",replans.json"}}${name === "maya" && !arg("out") ? " and public/scene/demo" : ""}`);
    console.log(`  wrote ${SNAPSHOT_DIR}/${persona.id}.ts and ${SNAPSHOT_DIR}/index.ts`);
  }
  console.log(`  ${plan.swaps.length} swaps, saves $${t.monthlySavings.toFixed(2)} of $${t.monthlyBefore.toFixed(2)} a month (${(t.savingsRate * 100).toFixed(1)}%); ${Object.keys(replans).length} re-plans`);
  const theirs = baseline.events.find((e) => e.type === "baseline_ready");
  printProof(plan, theirs?.type === "baseline_ready" ? theirs.proof : undefined, theirs?.type === "baseline_ready" ? theirs.proofRuns : undefined);
  console.log(`  spend this recording $${spent.toFixed(4)} (app ledger)`);
  if (qloo.mock) console.log("  NOTE: Qloo is mocked (qlooMock:true): tracked files only; a live recording goes to KV and .recordings/.");
}

main().catch((err) => {
  console.error(`record-demo failed: ${String((err as Error)?.message ?? err).replace(SECRET, "[redacted]").slice(0, 300)}`);
  process.exit(1);
});
