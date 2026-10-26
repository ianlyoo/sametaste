/**
 * Recomputes the measured proof and the hero bridge from recorded runs, with
 * no API calls: every number comes from the per-pick measurements and the
 * plan already in the recording (contract 1.4 counts, the popularity-ranked
 * hero bridge, 1.6 near you / where it said and the model's run spread).
 * Distances stay as recorded: a recording made before 1.6 measured the
 * model's picks at the branch its name matched, not the nearest one.
 *   npm run eval:reproof                (all personas in personas/snapshots)
 *   npm run eval:reproof -- --check     (exit 1 if anything would change)
 * Rewrites eval/fixtures/<persona>.* and personas/snapshots/<persona-id>.ts.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentEventSchema, type AgentEvent } from "../lib/contract";
import { SNAPSHOTS } from "../personas/snapshots";
import { reproofEvent } from "./reproof-event";
import { printProof, writeSnapshot } from "./snapshot-io";

const FIXTURES = "eval/fixtures";
const check = process.argv.includes("--check");

// validated, but written in the recording's own key order
const line = (l: string) => {
  const e = JSON.parse(l) as AgentEvent;
  AgentEventSchema.parse(e);
  const out = reproofEvent(e);
  AgentEventSchema.parse(out);
  return JSON.stringify(out);
};
const same = (a: unknown, b: unknown) => JSON.stringify(AgentEventSchema.array().parse(a)) === JSON.stringify(AgentEventSchema.array().parse(b));

let changed = 0;
const write = (path: string, text: string) => {
  if (readFileSync(path, "utf8") === text) return;
  changed++;
  if (!check) writeFileSync(path, text);
  console.log(`${check ? "would rewrite" : "rewrote"} ${path}`);
};

for (const snap of Object.values(SNAPSHOTS)) {
  const name = snap.personaId.split("-")[0];
  const fx = (kind: string) => join(FIXTURES, `${name}.${kind}`);
  const next = {
    ...snap,
    sametaste: snap.sametaste.map(reproofEvent),
    llm_only: snap.llm_only.map(reproofEvent),
    replans: Object.fromEntries(Object.entries(snap.replans).map(([id, evs]) => [id, evs.map(reproofEvent)])),
  };
  for (const kind of ["sametaste", "llm_only"] as const) {
    if (!existsSync(fx(`${kind}.ndjson`))) continue;
    const lines = readFileSync(fx(`${kind}.ndjson`), "utf8").split("\n").filter(Boolean).map(line);
    if (!same(lines.map((l) => JSON.parse(l)), next[kind])) throw new Error(`${fx(`${kind}.ndjson`)} and the ${snap.personaId} snapshot are different recordings`);
    write(fx(`${kind}.ndjson`), `${lines.join("\n")}\n`);
  }
  if (existsSync(fx("replans.json"))) {
    const replans = JSON.parse(readFileSync(fx("replans.json"), "utf8")) as Record<string, string[]>;
    const out = Object.fromEntries(Object.entries(replans).map(([id, ls]) => [id, ls.map(line)]));
    write(fx("replans.json"), JSON.stringify(out));
  }
  const path = `personas/snapshots/${snap.personaId}.ts`;
  const before = readFileSync(path, "utf8");
  if (!check) {
    writeSnapshot(next, "eval/reproof.ts");
    if (readFileSync(path, "utf8") !== before) console.log(`rewrote ${path}`);
  } else if (JSON.stringify(next) !== JSON.stringify(snap)) {
    changed++;
    console.log(`would rewrite ${path}`);
  }
  const plan = next.sametaste.findLast((e) => e.type === "plan_ready");
  const theirs = next.llm_only.find((e) => e.type === "baseline_ready");
  if (plan?.type === "plan_ready") {
    console.log(`${snap.personaId}${snap.qlooMock ? " (Qloo mocked)" : " (live Qloo)"}:`);
    printProof(plan.plan, theirs?.type === "baseline_ready" ? theirs.proof : undefined, theirs?.type === "baseline_ready" ? theirs.proofRuns : undefined);
  }
}
if (check && changed) process.exit(1);
