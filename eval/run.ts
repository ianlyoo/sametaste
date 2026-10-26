/**
 * One-command NYC benchmark.
 *   npm run eval:bench               Qloo live if QLOO_API_KEY is set, else mock; scripted LLM
 *   npm run eval:bench -- --mock     force the Qloo mock
 *   npm run eval:bench -- --live-llm LLM-alone baseline + normaliser on Anthropic (counts toward the spend cap)
 *   npm run eval:bench -- --aliases  also use the hand-written alias table (off by default: it
 *                                    names some benchmark merchants, which would flatter resolve rate)
 * Writes eval/results/benchmark.<mock|live>.summary.json (aggregates, safe to
 * commit and show in the UI) and .scratch/eval/benchmark.<mode>.detail.json
 * (per merchant, contains Qloo data, gitignored).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BenchmarkSummarySchema } from "../lib/contract";
import { AGENT_MODEL_ID, NORMALIZER_MODEL_ID, agentEnv } from "../lib/agent/config";
import { kvFromEnv } from "../lib/agent/kv";
import { costUsd } from "../lib/agent/pricing";
import { SpendLedger } from "../lib/agent/spend";
import { CallBudget, QlooClient, qlooConfigFromEnv } from "../lib/qloo/client";
import { runBenchmark } from "./bench";
import { loadLocalEnv } from "./env";

async function main() {
  loadLocalEnv();
  const args = new Set(process.argv.slice(2));
  const qcfg = qlooConfigFromEnv();
  const mock = args.has("--mock") || qcfg.mock;
  if (!mock && !qcfg.apiKey) throw new Error("QLOO_API_KEY is not set; run with --mock");
  const qloo = new QlooClient({ mock, budget: new CallBudget(400) });

  const env = agentEnv();
  let models: { main: import("ai").LanguageModel; normalizer: import("ai").LanguageModel } | undefined;
  let ledger: SpendLedger | undefined;
  const pending: Promise<unknown>[] = [];
  if (args.has("--live-llm")) {
    if (!env.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    ledger = new SpendLedger(kvFromEnv(env), { totalCapUsd: env.totalSpendCapUsd, dailyCapUsd: env.dailySpendCapUsd });
    const s = await ledger.status();
    if (s.blocked) throw new Error(`spend cap reached (${s.reason})`);
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    const anthropic = createAnthropic({ apiKey: env.anthropicApiKey, baseURL: "https://api.anthropic.com/v1" });
    models = { main: anthropic(AGENT_MODEL_ID), normalizer: anthropic(NORMALIZER_MODEL_ID) };
  }
  let spent = 0;

  const t0 = Date.now();
  const res = await runBenchmark({
    qloo,
    qlooMode: mock ? "mock" : "live",
    model: models?.main,
    modelId: AGENT_MODEL_ID,
    normalizerModel: models?.normalizer,
    normalizerModelId: NORMALIZER_MODEL_ID,
    onUsage: (id, u) => {
      const c = costUsd(id, u);
      spent += c;
      if (ledger) pending.push(ledger.record(c));
    },
    aliases: args.has("--aliases"),
    log: args.has("--verbose") ? (m) => console.log(m) : undefined,
  });
  await Promise.all(pending);
  const summary = BenchmarkSummarySchema.parse(res.summary);

  const mode = summary.qlooMode;
  mkdirSync("eval/results", { recursive: true });
  const out = path.join("eval/results", `benchmark.${mode}.summary.json`);
  writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
  mkdirSync(".scratch/eval", { recursive: true });
  const detail = path.join(".scratch/eval", `benchmark.${mode}.detail.json`);
  writeFileSync(detail, `${JSON.stringify(res, null, 2)}\n`);

  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const { llm_only: a, sametaste: b } = summary.systems;
  console.log(`SameTaste NYC benchmark (${summary.merchantCount} merchants, Qloo ${mode}, LLM ${summary.modelMode})${mode === "mock" ? "  [MOCK DATA: numbers prove nothing]" : ""}`);
  console.log(`resolve rate            ${pct(summary.resolveRate)}`);
  console.log(`                         LLM alone   SameTaste`);
  console.log(`hallucination rate      ${pct(a.hallucinationRate).padStart(9)}   ${pct(b.hallucinationRate).padStart(9)}`);
  console.log(`cheaper hit rate        ${pct(a.cheaperHitRate).padStart(9)}   ${pct(b.cheaperHitRate).padStart(9)}`);
  console.log(`taste match (affinity)  ${a.tasteMatch.toFixed(3).padStart(9)}   ${b.tasteMatch.toFixed(3).padStart(9)}`);
  console.log(`monthly savings (USD)   ${a.monthlySavingsUsd.toFixed(2).padStart(9)}   ${b.monthlySavingsUsd.toFixed(2).padStart(9)}`);
  console.log(`gate (>= ${pct(summary.gate.threshold)} resolve and cheaper hit): ${summary.gate.pass ? "PASS" : "FAIL"}${mode === "mock" ? " (mock)" : ""}`);
  console.log(`qloo calls ${summary.qlooCalls}, model cost $${spent.toFixed(4)}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`wrote ${out} and ${detail}`);
}

main().catch((err) => {
  // messages only: never dump objects that could carry request headers
  console.error(`benchmark failed: ${String((err as Error)?.message ?? err).replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 300)}`);
  process.exit(1);
});
