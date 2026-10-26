import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AgentEventSchema } from "@/lib/contract";
import { flowReducer, initialFlow, type FlowState } from "@/lib/client/flow";
import { parseStatement } from "@/lib/client/statement";
import { sharedMoney } from "../money";
import { cleanAddress, foldMerges, twinMonthly } from "@/lib/client/view";
import { proofRows } from "@/lib/agent/proof-rows";
import { proofText, swapLines } from "../receipt";

const base = `${__dirname}/../../../public/scene/demo`;
const csv = readFileSync(`${base}/maya.csv`, "utf8");
const baseline = readFileSync(`${base}/maya.llm_only.ndjson`, "utf8").split("\n").filter(Boolean).map((l) => AgentEventSchema.parse(JSON.parse(l)));
const events = readFileSync(`${base}/maya.sametaste.ndjson`, "utf8").split("\n").filter(Boolean).map((l) => AgentEventSchema.parse(JSON.parse(l)));

function replayed(): FlowState {
  let s = flowReducer(initialFlow, { type: "statement_loaded", statement: parseStatement(csv), personaId: "maya-williamsburg", location: { label: "Williamsburg, Brooklyn, NY" } });
  s = flowReducer(s, { type: "run_requested", mode: "sametaste", ticket: 1 });
  for (const event of events) s = flowReducer(s, { type: "event", mode: "sametaste", ticket: 1, event });
  return s;
}

describe("text receipt", () => {
  it("prints each swap with the paper's figures: visits and spend with merged descriptors, the twin's own monthly price", () => {
    const s = replayed();
    // a swap with merged descriptors when the recording has one, else the first
    const merged = s.swaps.find((x) => x.mergedKeys?.length) ?? s.swaps[0];
    expect(merged).toBeDefined();
    const keys = [merged.merchantKey, ...(merged.mergedKeys ?? [])];
    const ms = s.merchants.filter((m) => keys.includes(m.key));
    const line = swapLines(s).find((l) => l.swap.id === merged.id)!;
    expect(line.count).toBe(ms.reduce((a, m) => a + m.count, 0));
    expect(line.spend).toBeCloseTo(ms.reduce((a, m) => a + m.totalSpend, 0), 2);
    expect(line.twinMonthly).toBeCloseTo(merged.savings.visitsPerMonth * merged.savings.ticketAfter, 2);
    expect(line.twinMonthly).toBe(twinMonthly(merged));
    expect(line.saving).toBe(merged.savings.monthlySavings);
    const after = flowReducer(s, { type: "reject", swapId: merged.id });
    expect(swapLines(after).find((l) => l.swap.id === merged.id)!.live).toBe(false);
  });

  it("never shows (synthetic) in an address", () => {
    expect(cleanAddress("220 W 4th St (synthetic), West Village, New York, NY")).toBe("220 W 4th St, West Village");
    expect(cleanAddress("(synthetic)")).toBeUndefined();
    expect(cleanAddress(undefined)).toBeUndefined();
  });

  it("keeps the shared total on the paper's numbers through a reject", () => {
    const s = replayed();
    const m = sharedMoney(s);
    expect(m.saved).toBeCloseTo(s.plan!.totals.monthlySavings, 2);
    const after = flowReducer(s, { type: "reject", swapId: s.swaps[0].id });
    const m2 = sharedMoney(after);
    expect(m2.statement).toBe(m.statement);
    expect(m2.saved).toBeLessThan(m.saved);
  });

  it("stores both sides of the measured proof and prints them on one scale", () => {
    let s = replayed();
    s = flowReducer(s, { type: "run_requested", mode: "llm_only", ticket: 2 });
    for (const event of baseline) s = flowReducer(s, { type: "event", mode: "llm_only", ticket: 2, event });
    const ours = s.plan!.proof!, theirs = s.baseline.proof!;
    expect(ours).toBeDefined();
    expect(theirs).toBeDefined();
    expect(theirs.of).toBe(ours.of);
    const runs = s.baseline.proofRuns;
    const paper = proofRows(ours, theirs, runs);
    const rows = proofText(ours, theirs, runs);
    // the paper's rows, labels and order
    expect(rows.map((r) => r.label)).toEqual(paper.map((r) => r.label));
    for (const [i, r] of paper.entries()) {
      expect(rows[i].ours.startsWith(r.ours === "-" ? "none" : r.ours)).toBe(true);
      expect(rows[i].theirs.startsWith(r.theirs === "-" ? "none" : r.theirs)).toBe(true);
      expect(rows[i].worse).toBe(r.favours === "ours" ? "theirs" : r.favours === "theirs" ? "ours" : undefined);
    }
    expect(proofText(undefined, undefined)).toEqual([]);
    expect(proofText(ours, undefined).every((r) => r.theirs === "not run yet")).toBe(true);
  });

  it("gives the hero swap the plan's long bridge and the rest the short one", () => {
    const s = replayed();
    const hb = s.plan!.heroBridge!;
    expect(hb).toBeDefined();
    const lines = swapLines(s);
    const hero = lines.filter((l) => l.hero);
    expect(hero).toHaveLength(1);
    expect(hero[0].swap.merchantKey).toBe(hb.merchantKey);
    expect(hero[0].bridge).toBe(hb.text);
    for (const l of lines.filter((x) => !x.hero)) expect(l.bridge).toBe(l.swap.crossDomainNote ?? l.bridge);
  });

  it("folds lines announced as one place before any swap arrives", () => {
    let s = flowReducer(initialFlow, { type: "statement_loaded", statement: parseStatement(csv), personaId: "maya-williamsburg", location: { label: "Williamsburg, Brooklyn, NY" } });
    s = flowReducer(s, { type: "run_requested", mode: "sametaste", ticket: 1 });
    s = flowReducer(s, { type: "event", mode: "sametaste", ticket: 1, event: events[0] });
    const merges = s.run.merges!;
    expect(merges.length).toBeGreaterThan(0);
    const { merchantKey, mergedKeys } = merges[0];
    const keys = [merchantKey, ...mergedKeys];
    const folded = foldMerges(s);
    expect(folded.merchants.some((m) => mergedKeys.includes(m.key))).toBe(false);
    const kept = folded.merchants.find((m) => m.key === merchantKey)!;
    const parts = s.merchants.filter((m) => keys.includes(m.key));
    expect(parts.length).toBe(keys.length);
    expect(kept.count).toBe(parts.reduce((a, m) => a + m.count, 0));
    expect(kept.totalSpend).toBeCloseTo(parts.reduce((a, m) => a + m.totalSpend, 0), 2);
    expect(folded.merchants.length).toBe(s.merchants.length - mergedKeys.length);
    // the finished run prints the same line with the same figures
    const done = foldMerges(replayed());
    expect(done.merchants.find((m) => m.key === merchantKey)?.count).toBe(kept.count);
    const line = swapLines(done).find((l) => l.swap.merchantKey === merchantKey);
    if (line) {
      expect(line.count).toBe(kept.count);
      expect(line.spend).toBeCloseTo(kept.totalSpend, 2);
    }
    expect(sharedMoney(done).statement).toBe(sharedMoney(replayed()).statement);
  });
});
