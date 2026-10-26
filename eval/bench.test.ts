import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { BenchmarkSummarySchema } from "../lib/contract";
import { CallBudget, QlooClient } from "../lib/qloo/client";
import { GATE_THRESHOLD, runBenchmark } from "./bench";
import { BENCHMARK_MERCHANTS } from "./merchants";

// whole scripted runs; the shared box can be slow under load
vi.setConfig({ testTimeout: 20_000 });

const client = () => new QlooClient({ mock: true, budget: new CallBudget(400) });

describe("NYC benchmark (mock Qloo, scripted LLM)", () => {
  it("has 40 unique merchants", () => {
    expect(BENCHMARK_MERCHANTS).toHaveLength(40);
    expect(new Set(BENCHMARK_MERCHANTS.map((m) => m.id)).size).toBe(40);
  });

  it("produces a valid summary with aggregates only", async () => {
    const res = await runBenchmark({ qloo: client(), qlooMode: "mock" });
    const s = BenchmarkSummarySchema.parse(res.summary);
    expect(s.merchantCount).toBe(40);
    expect(s.modelMode).toBe("scripted");
    expect(s.systems.sametaste.hallucinationRate).toBe(0);
    expect(s.systems.llm_only.hallucinationRate).toBeGreaterThan(0);
    expect(s.systems.sametaste.cheaperHitRate).toBeLessThanOrEqual(s.resolveRate);
    expect(s.gate.pass).toBe(s.resolveRate >= GATE_THRESHOLD && s.systems.sametaste.cheaperHitRate >= GATE_THRESHOLD);
    expect(s.qlooCalls).toBeLessThanOrEqual(200);
    // no entity ids or names from Qloo in the summary
    expect(JSON.stringify(s)).not.toMatch(/[0-9A-F]{8}-[0-9A-F]{4}-/i);
    for (const r of res.rows) {
      if (r.sametaste) {
        expect(r.sametaste.cheaper).toBe(true);
        expect(r.sametaste.monthlySavings).toBeGreaterThan(0);
      }
    }
  });

  it("does not lean on the alias table unless asked", async () => {
    const plain = await runBenchmark({ qloo: client(), qlooMode: "mock" });
    const aliased = await runBenchmark({ qloo: client(), qlooMode: "mock", aliases: true });
    expect(aliased.summary.resolveRate).toBeGreaterThanOrEqual(plain.summary.resolveRate);
    expect(plain.aliases).toBe(false);
  });

  it("the committed mock summary matches the schema", () => {
    const s = BenchmarkSummarySchema.parse(JSON.parse(readFileSync("eval/results/benchmark.mock.summary.json", "utf8")));
    expect(s.qlooMode).toBe("mock");
  });
});
