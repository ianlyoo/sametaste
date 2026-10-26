import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { QlooTag } from "../contract";
import { reproofEvent } from "../../eval/reproof-event";
import { PERSONAS, aggregateTransactions, parseCsv } from "../../personas";
import { QlooClient } from "../qloo/client";
import type { QlooEntity } from "../qloo/types";
import { scoreCandidate } from "./candidates";
import { headline, topStyleTags } from "./fingerprint";
import { runAgent } from "./run";
import { evidenceTags, tasteRank } from "./taste-tags";
import { isHonestTwin } from "./tools";

const tag = (id: string, name = id.split(":").at(-1)!.replace(/_/g, " ")): QlooTag => ({ id, name, type: id.split(":").slice(0, 4).join(":") });

describe("taste tags", () => {
  it("drops payments, amenities, services and bare categories; keeps cuisines, genres, styles and vibes", () => {
    const junk = [
      "urn:tag:payments:place:nfc_mobile_payments",
      "urn:tag:payments:place:credit_cards",
      "urn:tag:credit_card:place:mastercard",
      "urn:tag:amenities:place:bar_onsite",
      "urn:tag:amenity:qloo:outdoor_seating",
      "urn:tag:service_type:qloo:delivery",
      "urn:tag:service_options:place:dine_in",
      "urn:tag:parking:place:paid_street_parking",
      "urn:tag:planning:place:accepts_reservations",
      "urn:tag:genre:place:restaurant",
      "urn:tag:genre:place",
      "urn:tag:setting:qloo:urban",
      "urn:tag:time_of_day_fit:qloo:evening",
      "urn:tag:resy:keyword:place:11211",
      "urn:tag:offerings:place:alcohol",
      "urn:tag:offerings:place:vegan_options",
      "urn:tag:ambience:qloo:casual",
      "urn:tag:category:place:coffee",
    ];
    for (const id of junk) expect(tasteRank(id), id).toBeUndefined();
    expect(tasteRank("urn:tag:cuisine:qloo:steakhouse")).toBe(0);
    expect(tasteRank("urn:tag:genre:place:restaurant:italian")).toBe(0);
    expect(tasteRank("urn:tag:style:place:natural_wine")).toBe(0);
    expect(tasteRank("urn:tag:ambience:qloo:lively")).toBe(1);
    expect(tasteRank("urn:tag:offerings:place:small_plates")).toBe(2);
    expect(tasteRank("urn:tag:menu_highlight:qloo:gnocchi")).toBe(3);
  });

  it("puts a swap's shared taste tag first, so 'credit cards' never leads the evidence line", () => {
    const tags = [tag("urn:tag:payments:place:credit_cards"), tag("urn:tag:ambience:qloo:lively"), tag("urn:tag:cuisine:qloo:steakhouse"), tag("urn:tag:decor:qloo:chic")];
    const shared = ["urn:tag:payments:place:credit_cards", "urn:tag:ambience:qloo:lively", "urn:tag:cuisine:qloo:steakhouse"];
    expect(evidenceTags(tags, shared).map((t) => t.name)).toEqual(["steakhouse", "lively", "chic"]);
  });

  it("reads the places' fingerprint from taste tags only, one per name", () => {
    const place = (tags: string[]) => ({ id: tags[0], name: "x", type: "place", tags: tags.map((id) => tag(id, id.endsWith("italian") ? "Italian" : undefined)) }) as unknown as QlooEntity;
    const top = topStyleTags(
      [
        place(["urn:tag:payments:place:nfc_mobile_payments", "urn:tag:genre:place:restaurant", "urn:tag:setting:qloo:urban", "urn:tag:cuisine:qloo:italian", "urn:tag:genre:place:restaurant:italian"]),
        place(["urn:tag:payments:place:nfc_mobile_payments", "urn:tag:ambience:qloo:lively", "urn:tag:cuisine:qloo:peruvian"]),
        place(["urn:tag:payments:place:nfc_mobile_payments", "urn:tag:ambience:qloo:lively"]),
      ],
      5,
    );
    expect(top.map((t) => t.name)).toEqual(["Italian", "peruvian", "lively"]);
    expect(headline([], [{ domain: "movie", entity: { id: "m", name: "Don't Worry, He Won't Get Far on Foot", type: "movie" } }])).toBe("Your taste, read from your statement");
  });

  it("rejects a twin whose only overlap is a payment tag (or another non-taste tag)", () => {
    const place = (id: string, priceLevel: number, tags: string[]) => ({ id, name: id, type: "place", priceLevel, tags: tags.map((t) => tag(t)) }) as unknown as QlooEntity;
    const from = place("from", 3, ["urn:tag:payments:place:credit_cards", "urn:tag:amenities:place:bar_onsite", "urn:tag:genre:place:restaurant", "urn:tag:cuisine:qloo:italian"]);
    const ctx = { merchantKey: "FROM", from, radiusM: 2000, query: "test" };
    const payOnly = scoreCandidate(place("pay", 2, ["urn:tag:payments:place:credit_cards", "urn:tag:amenities:place:bar_onsite", "urn:tag:genre:place:restaurant", "urn:tag:cuisine:qloo:peruvian"]), ctx, "c1");
    expect(payOnly.evidence.sharedTagIds).toEqual([]);
    expect(isHonestTwin(from, payOnly)).toBe(false);
    const real = scoreCandidate(place("real", 2, ["urn:tag:payments:place:credit_cards", "urn:tag:cuisine:qloo:italian"]), ctx, "c2");
    expect(real.evidence.sharedTagIds).toEqual(["urn:tag:cuisine:qloo:italian"]);
    expect(real.evidence.sharedTags?.map((t) => t.name)).toEqual(["italian"]);
    expect(isHonestTwin(from, real)).toBe(true);
  });

  it("records what eval:reproof needs: a fresh run's derived fields recompute to themselves", async () => {
    const p = PERSONAS.find((x) => x.id === "maya-williamsburg")!;
    const req = { location: p.location, merchants: aggregateTransactions(parseCsv(readFileSync(`personas/${p.file}`, "utf8"))) };
    const { events } = await runAgent(req, { scripted: true, qloo: (budget) => new QlooClient({ mock: true, budget }) });
    for (const e of events) expect(reproofEvent(e)).toEqual(e);
    const plan = events.filter((e) => e.type === "plan_ready").at(-1);
    if (plan?.type !== "plan_ready") throw new Error("no plan");
    const fp = plan.plan.fingerprint!;
    expect(fp.sources?.length).toBe(fp.sourceEntityIds.length);
    expect(fp.sources!.every((s) => s.tasteTags.every((t) => tasteRank(t.id) !== undefined))).toBe(true);
    expect(fp.topTags.length).toBeGreaterThan(0);
    for (const s of plan.plan.swaps) {
      expect(s.to.evidence.sharedTags?.map((t) => t.id)).toEqual(s.to.evidence.sharedTagIds);
      expect(s.to.evidence.sharedTagIds!.every((id) => tasteRank(id) !== undefined)).toBe(true);
    }
  });
});
