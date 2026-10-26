/**
 * LLM-alone baseline without Qloo (until the Qloo key arrives): what the
 * model suggests for the 40 NYC merchants, measured on what needs no Qloo.
 * Qloo-dependent metrics (exists, cheaper, taste match, savings) are
 * reported as "pending key"; eval:bench fills them once Qloo is live.
 *   npm run eval:baseline -- --live-llm   (spend-capped; else scripted guesses)
 * Writes eval/results/baseline.llm_only.<live|scripted>.json (aggregates)
 * and .scratch/eval/baseline.llm_only.detail.json (suggestions).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import type { LanguageModel, LanguageModelUsage } from "ai";
import { AGENT_MODEL_ID, agentEnv } from "../lib/agent/config";
import { llmSuggest } from "../lib/agent/baseline";
import { kvFromEnv } from "../lib/agent/kv";
import { normalizeByRules } from "../lib/agent/normalize";
import { costUsd } from "../lib/agent/pricing";
import { SpendLedger } from "../lib/agent/spend";
import { nameSimilarity } from "../lib/agent/text";
import { BENCHMARK_CITY, BENCHMARK_MERCHANTS, BENCHMARK_SET_VERSION } from "./merchants";
import { loadLocalEnv } from "./env";

const GENERIC = /\b(any|local|nearby|neighbou?rhood|a cheaper|independent|generic|similar|your)\b/i;

export function baselineStats(suggestions: { merchantKey: string; suggestedName: string; neighborhood?: string }[]) {
  const byKey = new Map<string, { name: string; hood?: string }>();
  for (const s of suggestions) if (!byKey.has(s.merchantKey)) byKey.set(s.merchantKey, { name: s.suggestedName.trim(), hood: s.neighborhood?.trim() || undefined });
  const rows = BENCHMARK_MERCHANTS.map((b) => ({ id: b.id, original: b.name, category: b.category, suggestion: byKey.get(b.id)?.name, neighborhood: byKey.get(b.id)?.hood }));
  const answered = rows.filter((r) => r.suggestion);
  const names = answered.map((r) => r.suggestion!.toLowerCase());
  const generic = answered.filter((r) => GENERIC.test(r.suggestion!) || !/[A-Z]/.test(r.suggestion![0] ?? ""));
  const same = answered.filter((r) => nameSimilarity(r.suggestion!, r.original) >= 0.8);
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  const repeated = names.filter((n) => counts.get(n)! > 1).length;
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return {
    rows,
    stats: {
      merchantCount: rows.length,
      answered: answered.length,
      namedRate: answered.length ? r3((answered.length - generic.length) / answered.length) : 0,
      genericCount: generic.length,
      withNeighborhoodRate: answered.length ? r3(answered.filter((r) => r.neighborhood).length / answered.length) : 0,
      sameAsOriginalCount: same.length,
      distinctSuggestions: counts.size,
      repeatedSuggestionRate: answered.length ? r3(repeated / answered.length) : 0,
    },
  };
}

async function main() {
  loadLocalEnv();
  const live = process.argv.includes("--live-llm");
  const env = agentEnv();
  let model: LanguageModel | undefined;
  let ledger: SpendLedger | undefined;
  if (live) {
    if (!env.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    ledger = new SpendLedger(kvFromEnv(env), { totalCapUsd: env.totalSpendCapUsd, dailyCapUsd: env.dailySpendCapUsd });
    const s = await ledger.status();
    if (s.blocked) throw new Error(`spend cap reached (${s.reason})`);
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    model = createAnthropic({ apiKey: env.anthropicApiKey, baseURL: "https://api.anthropic.com/v1" })(AGENT_MODEL_ID);
  }
  let cost = 0;
  let usage: LanguageModelUsage | undefined;
  const t0 = Date.now();
  const norms = BENCHMARK_MERCHANTS.map((b) => normalizeByRules({ key: b.id, rawMerchant: b.descriptor, count: 4, totalSpend: 100, currency: "USD" }, { known: false }));
  const suggestions = await llmSuggest(
    // the same per-line input the agent gets: descriptor, name, category
    BENCHMARK_MERCHANTS.map((b, i) => ({ key: b.id, rawMerchant: b.descriptor, name: `${norms[i].name} (${b.hood})`, category: norms[i].category })),
    BENCHMARK_CITY,
    {
      model,
      onUsage: (u) => {
        usage = u;
        cost += costUsd(AGENT_MODEL_ID, u);
      },
    },
  );
  if (ledger && cost > 0) await ledger.record(cost);
  const { rows, stats } = baselineStats(suggestions);
  const summary = {
    version: 1,
    setVersion: BENCHMARK_SET_VERSION,
    generatedAt: new Date().toISOString(),
    system: "llm_only",
    modelMode: live ? "live" : "scripted",
    model: live ? AGENT_MODEL_ID : "scripted",
    city: BENCHMARK_CITY,
    ...stats,
    pendingQlooKey: ["hallucinationRate", "cheaperHitRate", "tasteMatch", "monthlySavingsUsd"],
    costUsd: Math.round(cost * 1e5) / 1e5,
    tokens: usage ? { input: usage.inputTokens ?? 0, output: usage.outputTokens ?? 0 } : undefined,
  };
  mkdirSync("eval/results", { recursive: true });
  const out = `eval/results/baseline.llm_only.${summary.modelMode}.json`;
  writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
  mkdirSync(".scratch/eval", { recursive: true });
  writeFileSync(".scratch/eval/baseline.llm_only.detail.json", `${JSON.stringify({ summary, rows }, null, 2)}\n`);
  console.log(`LLM alone (${summary.model}) on ${stats.merchantCount} NYC merchants, no Qloo:`);
  console.log(`  answered ${stats.answered}, named places ${(stats.namedRate * 100).toFixed(1)}%, generic ${stats.genericCount}, same as original ${stats.sameAsOriginalCount}`);
  console.log(`  distinct suggestions ${stats.distinctSuggestions}, repeated ${(stats.repeatedSuggestionRate * 100).toFixed(1)}%`);
  console.log(`  pending Qloo key: ${summary.pendingQlooKey.join(", ")}`);
  console.log(`  cost $${summary.costUsd} (${summary.tokens ? `${summary.tokens.input} in / ${summary.tokens.output} out` : "no model"}), ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  wrote ${out}`);
}

if (process.argv[1]?.endsWith("baseline.ts")) {
  main().catch((err) => {
    console.error(`baseline failed: ${String((err as Error)?.message ?? err).replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 300)}`);
    process.exit(1);
  });
}
