import { describe, expect, it } from "vitest";
import { initialFlow } from "../flow";
import { parseStatement } from "../statement";
import { affinityRows, baselineScore, nextMonth, printerLine, statementPeriod, whoLabel } from "../view";

describe("view helpers", () => {
  it("names the statement period", () => {
    expect(statementPeriod(parseStatement("date,merchant,amount\n2026-10-01,A,1\n2026-10-30,B,2"))).toBe("October");
    expect(statementPeriod(parseStatement("date,merchant,amount\n2026-09-14,A,1\n2026-10-12,B,2"))).toBe("Sep 14 – Oct 12");
    expect(nextMonth(parseStatement("date,merchant,amount\n2026-12-01,A,1"))).toBe("January");
  });

  it("labels who the statement belongs to", () => {
    expect(whoLabel({ personaId: "maya-williamsburg" })).toBe("Maya, Williamsburg");
    expect(whoLabel({ location: { label: "Astoria, Queens, NY" } })).toBe("Astoria");
    expect(whoLabel({})).toBeUndefined();
  });

  it("prints the latest status, else the last step", () => {
    const run = { ...initialFlow.run, status: "running" as const, steps: [{ stepId: "a", tool: "qloo_search" as const, state: "finished" as const, summary: "Found Lilia", qlooCalls: 2 }] };
    expect(printerLine(run)).toEqual({ text: "Found Lilia", qloo: 2 });
    expect(printerLine({ ...run, statusMessage: "Looking for twins" }).text).toBe("Looking for twins");
  });

  it("groups affinities by domain", () => {
    const e = (name: string) => ({ id: name, name, type: "artist" as const });
    const fingerprint = {
      sourceEntityIds: [],
      sourceNames: [],
      topTags: [],
      headline: "",
      affinities: [
        { domain: "artist" as const, entity: e("Phoebe Bridgers") },
        { domain: "movie" as const, entity: e("Past Lives") },
        { domain: "artist" as const, entity: e("Japanese Breakfast") },
        { domain: "artist" as const, entity: e("Big Thief") },
      ],
    };
    expect(affinityRows({ fingerprint })).toEqual([
      { domain: "Music", names: ["Phoebe Bridgers", "Japanese Breakfast"] },
      { domain: "Film", names: ["Past Lives"] },
    ]);
  });

  it("scores the model-alone picks", () => {
    const b = (existsInQloo: boolean, cheaper?: boolean) => ({ merchantKey: "k", fromName: "f", suggestedName: "s", existsInQloo, cheaper });
    expect(baselineScore([b(false), b(true, false), b(true, true), b(true)])).toEqual({ total: 4, missing: 1, notCheaper: 1, wrong: 2 });
  });
});

describe("evidence", () => {
  it("prints Qloo's case for a twin", async () => {
    const { swap } = await import("./fixtures");
    const { evidenceLine, bridgeLine } = await import("../view");
    const sw = swap("s1", "LILIA", "Leo");
    sw.from.name = "Lilia";
    sw.to.evidence = {
      ...sw.to.evidence,
      affinity: 0.819,
      distanceKm: 0.49,
      fromPriceLevel: 3,
      priceLevel: 2,
      tags: [{ id: "t:italian", name: "italian", type: "style" }, { id: "t:pizza", name: "pizza", type: "style" }],
      sharedTagIds: ["t:italian"],
      crossDomain: [{ domain: "artist", entity: { id: "a", name: "Phoebe Bridgers", type: "artist" } }],
    };
    expect(evidenceLine(sw)).toBe("Qloo .82, italian, 0.5 km, $$$ to $$");
    expect(bridgeLine(sw)).toBe("Lilia fans also love Phoebe Bridgers");
    // contract 1.2: the swap's own bridge wins
    sw.crossDomainNote = "Fans of Lilia and Leo both love Phoebe Bridgers";
    expect(bridgeLine(sw)).toBe("Fans of Lilia and Leo both love Phoebe Bridgers");
  });
});
