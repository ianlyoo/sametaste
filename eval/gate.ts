/**
 * 10/27 go/no-go gate: >= 60% resolve rate and >= 60% cheaper taste-match
 * hit rate on the NYC benchmark with live Qloo data.
 *   npm run eval:gate                  reads eval/results/benchmark.live.summary.json
 *   npm run eval:gate -- --allow-mock  falls back to the mock summary (labelled, not a real result)
 * Exit 0 = GO, 1 = NO-GO, 2 = no live result yet.
 */
import { existsSync, readFileSync } from "node:fs";
import { BenchmarkSummarySchema } from "../lib/contract";

const allowMock = process.argv.includes("--allow-mock");
const live = "eval/results/benchmark.live.summary.json";
const mock = "eval/results/benchmark.mock.summary.json";
const file = existsSync(live) ? live : allowMock && existsSync(mock) ? mock : undefined;
if (!file) {
  console.log("NO RESULT: run `npm run eval:bench` with QLOO_API_KEY set first (or pass --allow-mock).");
  process.exit(2);
}
const s = BenchmarkSummarySchema.parse(JSON.parse(readFileSync(file, "utf8")));
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const label = s.qlooMode === "mock" ? "MOCK, not a real gate result" : "live Qloo";
console.log(`gate on ${file} (${label}, ${s.generatedAt})`);
console.log(`  resolve rate      ${pct(s.gate.resolveRate)}  (need ${pct(s.gate.threshold)})  ${s.gate.resolveRate >= s.gate.threshold ? "ok" : "LOW"}`);
console.log(`  cheaper hit rate  ${pct(s.gate.cheaperHitRate)}  (need ${pct(s.gate.threshold)})  ${s.gate.cheaperHitRate >= s.gate.threshold ? "ok" : "LOW"}`);
console.log(s.gate.pass ? `GO${s.qlooMode === "mock" ? " (mock)" : ""}` : `NO-GO${s.qlooMode === "mock" ? " (mock)" : ""}`);
process.exit(s.gate.pass ? 0 : 1);
