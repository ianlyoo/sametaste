import { describe, expect, it } from "vitest";
import type { CrossDomainAffinity, ProofSide, Swap } from "../contract";
import { reproofEvent } from "../../eval/reproof-event";
import { SNAPSHOTS } from "../../personas/snapshots";
import { KEPT_REASON, keptCounts, proofRows } from "./proof-rows";
import { heroBridge } from "./tools";

const side = (o: Partial<ProofSide>): ProofSide => ({ of: 9, picks: 9, tasteScored: 0, sharedTags: 0, cheaper: 0, monthlySavings: 0, qlooMock: false, perMerchant: [], ...o });

describe("the proof rows (contract 1.6)", () => {
  it("counts each side over its own picks, cheaper first", () => {
    const ours = side({ picks: 5, exists: 5, near: 5, medianDistanceKm: 0.8, tasteLink: 0.93, tasteScored: 5, cheaper: 5, priced: 5, monthlySavings: 431.7, kept: 3, waiting: 1 });
    const theirs = side({ picks: 9, exists: 8, near: 2, medianDistanceKm: 4.5, whereSaid: 3, whereChecked: 9, tasteLink: 0.943, tasteScored: 2, cheaper: 2, priced: 4, monthlySavings: 96.2 });
    const rows = proofRows(ours, theirs);
    expect(rows.map((r) => r.key)).toEqual(["cheaper", "taste", "near", "month", "exists", "where", "kept"]);
    expect(rows.map((r) => [r.ours, r.theirs])).toEqual([
      ["5 of 5 picks", "2 of 9 picks, 4 priced"],
      ["0.93 (n=5)", "0.94 (n=2)"],
      ["5 of 5 picks, median 0.8 km", "2 of 9 picks, median 4.5 km"],
      ["−$431.70", "−$96.20"],
      ["5 of 5 picks", "8 of 9 picks"],
      ["checked on Qloo", "3 of 9 picks"],
      ["3 lines, no cheaper twin; 1 waiting for you", "-"],
    ]);
    expect(rows.map((r) => r.favours)).toEqual(["ours", "tie", "ours", "ours", "ours", undefined, undefined]);
    expect(rows.find((r) => r.key === "month")!.note).toBe("4.5x");
    expect(rows.find((r) => r.key === "taste")!.note).toBe("a tie");
    expect(rows.some((r) => /shared/i.test(r.label))).toBe(false);
  });

  it("still shows a row that favours the model", () => {
    const rows = proofRows(side({ picks: 4, tasteLink: 0.7, tasteScored: 4, cheaper: 4, monthlySavings: 50 }), side({ tasteLink: 0.9, tasteScored: 9, cheaper: 9, monthlySavings: 80 }));
    expect(rows.find((r) => r.key === "month")!.favours).toBe("theirs");
    expect(rows.find((r) => r.key === "taste")!.favours).toBe("theirs");
    expect(rows.find((r) => r.key === "exists")!.ours).toBe("not checked");
    expect(rows.find((r) => r.key === "kept")!.ours).toBe("-");
  });

  it("counts lines kept on purpose apart from open questions and gaps", () => {
    const u = (reason: string) => ({ merchantKey: reason, name: reason, reason });
    expect(keptCounts([u(KEPT_REASON.cheapest), u(KEPT_REASON.noTwin), u(KEPT_REASON.waiting), u(KEPT_REASON.ambiguous), u(KEPT_REASON.unchecked)])).toEqual({ kept: 2, waiting: 2 });
  });

  it("picks the hero swap by its best-known bridge entity, else the best saving's first", () => {
    const cd = (name: string, popularity?: number): CrossDomainAffinity => ({ domain: "artist", entity: { id: name, name, type: "artist", popularity }, affinity: 0.9 });
    const swap = (crossDomain: CrossDomainAffinity[], monthlySavings = 100, from = "Lilia", to = "Leo") =>
      ({ id: from, merchantKey: from.toUpperCase(), status: "proposed", from: { name: from }, to: { entity: { name: to }, evidence: { crossDomain } }, savings: { monthlySavings } }) as unknown as Swap;
    expect(heroBridge([swap([cd("Obscure Band", 0.4), cd("Taylor Swift", 0.99)])])!.text).toBe("Fans of Lilia and Leo both love Taylor Swift");
    expect(heroBridge([swap([cd("First One"), cd("Second One")])])!.text).toBe("Fans of Lilia and Leo both love First One");
    // across swaps: a smaller saving with a better-known bridge is the hero
    const hero = heroBridge([swap([cd("Dark Polo Gang", 0.85)], 162), swap([cd("Eater", 0.99), cd("The Infatuation", 0.97)], 87, "Peter Luger", "St. Anselm")])!;
    expect(hero).toEqual({ swapId: "Peter Luger", merchantKey: "PETER LUGER", text: "Fans of Peter Luger and St. Anselm both love Eater" });
    // no popularity anywhere: the best saving's first entity
    expect(heroBridge([swap([cd("Small")], 10, "A", "B"), swap([cd("Big")], 50, "C", "D")])!.text).toBe("Fans of C and D both love Big");
    // a famous name that can't fit on the paper gives way to the next one
    expect(heroBridge([swap([cd("Short Name", 0.5), cd("A Very Long Entity Name That Will Never Fit On One Receipt Line", 0.99)])])!.text).toContain("Short Name");
  });

  it("the recorded fixtures match what the code computes from their own measurements", () => {
    for (const snap of Object.values(SNAPSHOTS)) {
      const all = [...snap.sametaste, ...snap.llm_only, ...Object.values(snap.replans).flat()];
      for (const e of all) expect(reproofEvent(e)).toEqual(e);
      const plan = snap.sametaste.findLast((e) => e.type === "plan_ready");
      const p = plan?.type === "plan_ready" ? plan.plan.proof : undefined;
      if (p) expect(p.picks + (p.kept ?? 0) + (p.waiting ?? 0)).toBeLessThanOrEqual(p.of);
    }
  });
});
