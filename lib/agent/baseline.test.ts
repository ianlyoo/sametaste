import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { ProofSide, QlooEntityRef } from "../contract";
import { PERSONAS, aggregateTransactions, parseCsv } from "../../personas";
import { CallBudget, QlooClient } from "../qloo/client";
import { haversineM } from "../qloo/geo";
import { nearestBranch } from "./baseline";
import { findHood, inClaimedHood, zipOf } from "./hoods";
import { proofRows } from "./proof-rows";
import { runAgent } from "./run";

vi.setConfig({ testTimeout: 20_000 });

const MAYA = { lat: 40.7081, lon: -73.9571, radiusM: 2500 };

/** The model-alone picks of the d1bd0d8 live Maya recording (name-matched branches), as Qloo placed them. */
const recorded = new Map<string, { ref: QlooEntityRef; hood: string }>(
  (
    [
      ["Lucali", "Carroll Gardens", "Lucali", "575 Henry St Brooklyn, NY 11231", 40.681826, -74.0003184],
      ["Trader Joe's", "Cobble Hill", "Trader Joe's", "142 E 14th St New York, NY 10003", 40.733371, -73.9878966],
      ["Brooklyn Boulders", "Gowanus", "Brooklyn Boulders Queensbridge", "23-10 41st Ave Queens, NY 11101", 40.7526405, -73.9400914],
      ["Randolph Beer", "Williamsburg", "Randolph Beer WBURG", "104 S 4th St Brooklyn, NY 11249", 40.7119581, -73.9634955],
      ["Pio Pio", "Williamsburg", "Pio Pio", "282 Kings Hwy Brooklyn, NY 11223", 40.605, -73.9802778],
      ["Dig", "Williamsburg", "DIG", "16 E 23rd St New York, NY 10010", 40.7407465, -73.9883108],
      ["Variety Coffee Roasters", "Williamsburg", "Variety Coffee Roasters", "261 7th Ave New York, NY 10001", 40.7452152, -73.9945269],
      ["Sweatshop", "Williamsburg", "The Sweatshop", "262 Meserole St Brooklyn, NY 11206", 40.7084226, -73.9380588],
    ] as const
  ).map(([pick, hood, name, address, lat, lon]) => [pick, { ref: { id: name, name, type: "place", address, lat, lon, priceLevel: 2 }, hood }]),
);

const raw = (e: QlooEntityRef) => ({
  entity_id: e.id,
  name: e.name,
  types: ["urn:entity:place"],
  location: { lat: e.lat, lon: e.lon },
  properties: { address: e.address, price_level: e.priceLevel },
});

/**
 * A /search that serves `places` matching the query, in the order given (Qloo ranks by relevance, not distance),
 * within filter.radius unless `ignoreRadius`.
 */
function fakeSearch(places: QlooEntityRef[], opts: { ignoreRadius?: boolean } = {}) {
  const calls: number[] = [];
  const fetch = vi.fn(async (url: string) => {
    const u = new URL(url);
    const [lat, lon] = u.searchParams.get("filter.location")!.split(",").map(Number);
    const miles = Number(u.searchParams.get("filter.radius"));
    calls.push(miles);
    const q = u.searchParams.get("query")!.toLowerCase();
    const results = places
      .filter((p) => p.name.toLowerCase().includes(q.split(" ")[0]))
      .filter((p) => opts.ignoreRadius || haversineM(lat, lon, p.lat!, p.lon!) <= miles * 1609.344)
      .map(raw);
    return new Response(JSON.stringify({ success: true, results }), { status: 200, headers: { "content-type": "application/json" } });
  });
  return { qloo: new QlooClient({ mock: false, apiKey: "test-key", baseUrl: "https://q.example", fetch: fetch as unknown as typeof globalThis.fetch, cache: false }), calls };
}

describe("the model's picks at their nearest branch (contract 1.6)", () => {
  const far = recorded.get("Trader Joe's")!.ref; // 142 E 14th St, Manhattan: 3.8 km from Maya
  const nearBranch: QlooEntityRef = { id: "tj-williamsburg", name: "Trader Joe's", type: "place", address: "200 N 5th St Brooklyn, NY 11211", lat: 40.7165, lon: -73.9585, priceLevel: 2 };

  it("takes a chain's branch near the user, though Qloo lists a far one first", async () => {
    const { qloo, calls } = fakeSearch([far, nearBranch], { ignoreRadius: true });
    const b = await nearestBranch(qloo, "Trader Joe's", MAYA);
    expect(b.hit?.id).toBe("tj-williamsburg");
    expect(b.distanceKm).toBeCloseTo(0.94, 1);
    expect(b.searchedKm).toBe(2.5);
    expect(calls).toEqual([1.55]);
    expect(inClaimedHood("Williamsburg", b.hit!)).toBe(true);
  });

  it("widens only while nothing lies inside the radius, and a far pick stays far", async () => {
    const { qloo, calls } = fakeSearch([far]);
    const b = await nearestBranch(qloo, "Trader Joe's", MAYA);
    expect(b.hit?.id).toBe(far.id);
    expect(b.distanceKm).toBe(3.83);
    expect(b.searchedKm).toBe(10);
    expect(calls).toEqual([1.55, 6.21]);
    expect(inClaimedHood(recorded.get("Trader Joe's")!.hood, b.hit!)).toBe(false); // the model said Cobble Hill
  });

  it("a match Qloo returns beyond the radius asked does not stop the search", async () => {
    const pioPio = recorded.get("Pio Pio")!.ref; // Kings Hwy: 11.6 km
    const { qloo, calls } = fakeSearch([pioPio], { ignoreRadius: true });
    const b = await nearestBranch(qloo, "Pio Pio", MAYA);
    expect(b).toMatchObject({ distanceKm: 11.63, searchedKm: 24 });
    expect(calls).toEqual([1.55, 6.21, 14.91]);
  });

  it("not found after the widest radius; and the budget can stop the widening", async () => {
    const none = fakeSearch([]);
    expect(await nearestBranch(none.qloo, "Peter Luger Burger", MAYA)).toEqual({ hit: undefined, distanceKm: undefined, searchedKm: 24 });
    const capped = fakeSearch([far]);
    const b = await nearestBranch(capped.qloo, "Trader Joe's", MAYA, { canWiden: () => false });
    expect(b).toEqual({ hit: undefined, distanceKm: undefined, searchedKm: 2.5 });
    expect(capped.calls).toHaveLength(1);
  });

  it("reads the claimed neighbourhood from the recorded addresses", () => {
    const check = (name: string) => inClaimedHood(recorded.get(name)!.hood, recorded.get(name)!.ref);
    expect(["Lucali", "Brooklyn Boulders", "Randolph Beer", "Pio Pio", "Dig", "Variety Coffee Roasters", "Sweatshop"].map(check)).toEqual([true, false, true, false, false, false, true]);
    expect(zipOf("575 Henry St Brooklyn, NY 11231")).toBe("11231");
    expect(findHood("East Williamsburg, Brooklyn")?.name).toBe("East Williamsburg");
    expect(findHood("Bedford-Stuyvesant")?.name).toBe("Bed-Stuy");
    // no ZIP: the name in the address (the mock), else the distance from the centre
    expect(inClaimedHood("Williamsburg", { address: "12 Grand St (synthetic), Williamsburg, New York, NY" })).toBe(true);
    expect(inClaimedHood("Williamsburg", { lat: 40.7135, lon: -73.9605 })).toBe(true);
    expect(inClaimedHood("Williamsburg", { lat: 40.6795, lon: -73.9992 })).toBe(false);
    // a street named for another neighbourhood: the ZIP decides
    expect(inClaimedHood("Greenpoint", { address: "39-10 Greenpoint Ave Queens, NY 11104" })).toBe(false);
    expect(inClaimedHood("online", { address: "x" })).toBeUndefined();
    expect(inClaimedHood("Lincoln Park, Chicago", { address: "1 W Fullerton Ave Chicago, IL 60614" })).toBeUndefined();
  });

  it("a mock run measures the model's picks at their nearest branch, within the call budget", async () => {
    const p = PERSONAS.find((x) => x.id === "maya-williamsburg")!;
    const req = { mode: "llm_only" as const, location: p.location, merchants: aggregateTransactions(parseCsv(readFileSync(`personas/${p.file}`, "utf8"))) };
    let budget: CallBudget | undefined;
    const { events } = await runAgent(req, { scripted: true, qloo: (b) => ((budget = b), new QlooClient({ mock: true, budget: b, cache: false })) });
    const ev = events.find((e) => e.type === "baseline_ready");
    if (ev?.type !== "baseline_ready" || !ev.proof) throw new Error("no proof");
    const proof = ev.proof;
    expect(proof.nearestBranch).toBe(true);
    expect(proof.perMerchant.every((x) => x.searchedKm !== undefined && x.claimedHood)).toBe(true);
    expect(proof.near).toBe(proof.perMerchant.filter((x) => x.distanceKm !== undefined && x.distanceKm <= 1.5).length);
    expect(proof.whereChecked).toBeGreaterThan(0);
    expect(proof.tasteScored).toBe(proof.picks);
    expect(budget!.used).toBeLessThanOrEqual(budget!.max);
  });
});

const side = (o: Partial<ProofSide>): ProofSide => ({ of: 9, picks: 9, tasteScored: 0, sharedTags: 0, cheaper: 0, monthlySavings: 0, qlooMock: false, perMerchant: [], ...o });

describe("the proof rows with the model's spread", () => {
  const ours = side({ picks: 5, exists: 5, near: 5, medianDistanceKm: 0.8, tasteLink: 0.94, tasteScored: 5, cheaper: 5, priced: 5, monthlySavings: 433.9, kept: 3, waiting: 1 });
  const run = (o: Partial<ProofSide>) => side({ exists: 8, near: 1, medianDistanceKm: 4.6, whereSaid: 3, whereChecked: 9, tasteLink: 0.94, tasteScored: 4, cheaper: 5, priced: 6, monthlySavings: 415.57, ...o });

  it("cheaper, taste link, near you first; no multiple under 1.5x", () => {
    const rows = proofRows(ours, run({}));
    expect(rows.map((r) => r.key)).toEqual(["cheaper", "taste", "near", "month", "exists", "where", "kept"]);
    expect(rows.map((r) => [r.label, r.ours, r.theirs])).toEqual([
      ["cheaper", "5 of 5 picks", "5 of 9 picks, 6 priced"],
      ["taste link", "0.94 (n=5)", "0.94 (n=4)"],
      ["near you", "5 of 5 picks, median 0.8 km", "1 of 9 picks, median 4.6 km"],
      ["a month", "−$433.90", "−$415.57"],
      ["found on Qloo", "5 of 5 picks", "8 of 9 picks"],
      ["where it said", "checked on Qloo", "3 of 9 picks"],
      ["kept", "3 lines, no cheaper twin; 1 waiting for you", "-"],
    ]);
    expect(rows.find((r) => r.key === "month")!.note).toBeUndefined();
    expect(rows.find((r) => r.key === "taste")!.note).toBe("a tie");
    expect(rows.find((r) => r.key === "near")!.favours).toBe("ours");
    expect(proofRows(ours, run({ monthlySavings: 96.2 })).find((r) => r.key === "month")!.note).toBe("4.5x");
  });

  it("prints the model's range over its runs, and a verdict only where every run agrees", () => {
    const runs = [run({}), run({ near: 3, medianDistanceKm: 1.6, whereSaid: 5, whereChecked: 8, monthlySavings: 96.2, cheaper: 2, priced: 4, tasteLink: 0.9 }), run({ near: 2, monthlySavings: 180 })];
    const rows = proofRows(ours, runs[0], runs);
    const r = Object.fromEntries(rows.map((x) => [x.key, x]));
    expect(r.near.theirs).toBe("1–3 of 9 picks, median 1.6–4.6 km");
    expect(r.where.theirs).toBe("3–5 of 9 picks, 0–1 not checked");
    expect(r.cheaper.theirs).toBe("2–5 of 9 picks, 4–6 priced");
    expect(r.month.theirs).toBe("−$96 to −$416");
    expect(r.month.note).toBeUndefined(); // 1.04x on one run
    expect(r.month.favours).toBe("ours");
    expect(r.taste.theirs).toBe("0.90–0.94 (n=4)");
    expect(r.taste.favours).toBe("tie");
    // one run alone prints as before
    expect(proofRows(ours, runs[0], [runs[0]]).find((x) => x.key === "month")!.theirs).toBe("−$415.57");
  });
});
