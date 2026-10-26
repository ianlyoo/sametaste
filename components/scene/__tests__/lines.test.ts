import { twinMonthly } from "../model";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AgentEventSchema, type ProofSide } from "../../../lib/contract";
import { flowReducer, initialFlow, savingsTotals, type FlowState } from "../../../lib/client/flow";
import { parseStatement } from "../../../lib/client/statement";
import { proofRows } from "../../../lib/agent/proof-rows";
import { buildLayout, collectPriors, proofSentence, RED, sceneLabels, totals, type Prior } from "../lines";
import { deriveReceipt } from "../model";

const base = `${__dirname}/../../../public/scene/demo`;
const csv = readFileSync(`${base}/maya.csv`, "utf8");
const events = readFileSync(`${base}/maya.sametaste.ndjson`, "utf8").split("\n").filter(Boolean).map((l) => AgentEventSchema.parse(JSON.parse(l)));
const baseline = readFileSync(`${base}/maya.llm_only.ndjson`, "utf8").split("\n").filter(Boolean).map((l) => AgentEventSchema.parse(JSON.parse(l)));
// the tracked recording is mock Qloo (no live Qloo data in the repo); the checks on live venues and the model's runs apply to a live one
const live = events[0]?.type === "run_started" && events[0].qlooMock === false;

function loaded(): FlowState {
  return flowReducer(initialFlow, { type: "statement_loaded", statement: parseStatement(csv), personaId: "maya-williamsburg", location: { label: "Williamsburg, Brooklyn, NY" } });
}
function replay(n = events.length): FlowState {
  let s = flowReducer(loaded(), { type: "run_requested", mode: "sametaste", ticket: 1 });
  for (const event of events.slice(0, n)) s = flowReducer(s, { type: "event", mode: "sametaste", ticket: 1, event });
  return s;
}

describe("buildLayout", () => {
  it("prints the statement first, nothing else", () => {
    const lay = buildLayout(loaded());
    expect(lay.ours[0]).toEqual({ t: "head", text: "SAMETASTE" });
    expect(lay.ours[1].text).toBe("TASTE READ WITH QLOO");
    expect(lay.ours[2].text).toBe("MAYA, WILLIAMSBURG. SEPTEMBER 2026, 59 LINES");
    expect(lay.ours[4].text).toMatch(/MOST HONEST TASTE PROFILE/);
    expect(lay.tasteStart).toBeNull();
    expect(lay.nextStart).toBeNull();
    expect(lay.pens).toHaveLength(0);
    expect(lay.ours.filter((l) => l.t === "row")).toHaveLength(23); // B's 22 rows + "37 MORE LINES"
    expect(lay.ours.filter((l) => l.t === "row").at(-1)?.name).toBe("37 MORE LINES");
    expect(lay.ours.some((l) => l.where)).toBe(false);
    const spend = parseStatement(csv).transactions.filter((t) => t.amount > 0).reduce((a, t) => a + t.amount, 0);
    expect(lay.statementTotal).toBeCloseTo(spend, 2);
    expect(lay.ours.find((l) => l.t === "total")?.v).toBe("$" + spend.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    expect(sceneLabels(loaded()).month).toBe("SEPTEMBER 2026");
    expect(sceneLabels(loaded()).nextMonth).toBe("OCTOBER");
  });

  it("reserves a pen line per taste merchant once merchants are resolved, with rent set aside", () => {
    const upto = events.findIndex((e) => e.type === "merchants_resolved") + 1;
    const lay = buildLayout(replay(upto));
    expect(lay.tasteStart).not.toBeNull();
    const merged = new Set(replay(upto).run.merges.flatMap((m) => m.mergedKeys)); // announced in run_started (contract 1.3)
    expect(lay.pens.length).toBe(Object.values(replay(upto).resolutions).filter((r) => r.status !== "skipped" && !merged.has(r.merchantKey)).length);
    expect(lay.pens.length).toBeGreaterThanOrEqual(8);
    expect(lay.pens.every((t) => t.status === "waiting" && t.text === "" && t.evidence === "" && !t.bridge)).toBe(true);
    expect(lay.ours.filter((l) => l.t === "ev")).toHaveLength(lay.pens.length); // one evidence line per taste line; the other notes ride the tip (round 5)
    expect(lay.ours.find((l) => l.k === "SET ASIDE")?.v).toMatch(/RENT/);
  });

  it("writes a twin under each swapped line and appends the next-month block when the plan is in", () => {
    const s = replay();
    const lay = buildLayout(s);
    const n = s.swaps.length;
    const mergedKeys = new Set(s.swaps.flatMap((x) => x.mergedKeys ?? []));
    expect(lay.pens.filter((t) => t.status === "proposed")).toHaveLength(n);
    expect(lay.pens).toHaveLength(n + (s.plan?.unswapped.length ?? 0));
    expect(lay.pens.find((t) => t.swapId === s.swaps[0].id)!.text).toMatch(new RegExp(`^→ ${s.swaps[0].to.entity.name} {3}\\$`));
    expect(lay.nextStart).not.toBeNull();
    expect(lay.savedLi).not.toBeNull();
    expect(lay.ours.filter((l) => l.t === "swap")).toHaveLength(0); // no twin list in the next-month block
    const ev0 = s.swaps[0].to.evidence;
    expect(lay.pens.find((t) => t.swapId === s.swaps[0].id)!.evidence).toMatch(new RegExp(`^QLOO ${ev0.affinity!.toFixed(2)} {3}[A-Z ]+ {3}${ev0.distanceKm!.toFixed(1)} KM {3}\\$+→\\$+$`));
    // one hero bridge is hand-written (the plan's, else the first swap's); every other twin gets a short printed "ALSO LOVE"
    const hero = lay.pens.filter((t) => t.bridge);
    expect(hero).toHaveLength(1);
    expect(hero[0].bridge!.text).toMatch(/both love|fans also love/);
    expect(hero[0].bridge!.text.length).toBeLessThanOrEqual(84);
    const also = lay.pens.filter((t) => t.status === "proposed" && !t.bridge);
    expect(also.length).toBe(n - 1);
    expect(also.every((t) => /^ALSO LOVE: /.test(t.also) && t.also.length <= 40 && t.alsoLi == null)).toBe(true); // kept for the tip, not printed on the paper (round 5)
    expect(also.every((t) => t.tip.includes("Also love: "))).toBe(true);
    expect(also.every((t) => !t.also.includes(t.name.toUpperCase()))).toBe(true); // no merchant names repeated
    expect(also.every((t) => t.also.split("ALSO LOVE").length === 2)).toBe(true); // the note's own "Also love:" prefix is not doubled
    expect(lay.pens.find((t) => t.swapId === s.swaps[0].id)!.text).toMatch(new RegExp(`\\$${twinMonthly(s.swaps[0]).toFixed(2).replace(".", "\\.")}$`)); // the twin's own monthly price
    for (const mk of mergedKeys) expect(lay.ours.some((l) => l.key === mk)).toBe(false); // merged descriptors are one line
    expect(lay.pens[0].tip.length).toBeLessThanOrEqual(120);
    expect(lay.pens.every((t) => t.tip.length <= 120)).toBe(true);
    const photos = lay.pens.map((t) => t.photo).filter(Boolean);
    expect(new Set(photos).size).toBe(photos.length); // no photo twice
    // the reader's own places get B's polaroids too, each photo once across both kinds
    const orig = lay.pens.map((t) => t.fromPhoto).filter(Boolean);
    if (live) {
      expect(lay.pens.find((t) => /Quinoa Kitchen/.test(t.text))?.photo).toBe("quinoa"); // health food: a bowl, the salad being Sweetgreen's own
      expect(lay.pens.find((t) => /Have & Meyer/.test(t.text))?.photo).toBe("cocktail"); // natural wine on its tags (The Four Horsemen has the wine photo)
      expect(lay.pens.find((t) => /Leo/.test(t.text))?.photo).toBe("pasta2"); // Italian on its tags (Lilia has the first pasta photo)
      expect(lay.pens.find((t) => /Aurora Brooklyn/.test(t.text))?.photo).toBeNull(); // comfort food, small plates: no photo honestly matches; ceviche is Llama Inn's
      expect(lay.pens.find((t) => /St\. Anselm/.test(t.text))?.photo).toBe("steak2"); // the steakhouse's twin, same taste one tier down
      expect(lay.pens.find((t) => t.key === "PETER LUGER STEAK HOUSE")?.fromPhoto).toBe("steak");
      expect(lay.pens.find((t) => t.key === "WHOLE FOODS")?.fromPhoto).toBe("grocery");
      expect(lay.pens.find((t) => t.key === "EQUINOX")?.fromPhoto).toBeNull();
    }
    expect(new Set([...photos, ...orig]).size).toBe(photos.length + orig.length);
    expect(lay.ours.some((l) => l.t === "note" && / · /.test(l.text ?? ""))).toBe(false);
    const tot = totals(s);
    expect(tot.saving).toBeCloseTo(savingsTotals(s).monthly, 2);
    expect(tot.saving).toBeCloseTo(s.plan!.totals.monthlySavings, 2);
    expect(tot.before).toBeCloseTo(s.plan!.totals.monthlyBefore, 2);
    expect(lay.ours.find((l) => l.t === "total" && l.k === "A MONTH")?.v).toBe("−$" + tot.saving.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    expect(deriveReceipt(s).saving).toBeCloseTo(tot.saving, 2);
  });

  it("marks a rejected line as re-planning and drops it from the next-month block", () => {
    const s = replay();
    const r = flowReducer(s, { type: "reject", swapId: s.swaps[0].id });
    const lay = buildLayout(r);
    const pen = lay.pens.find((t) => t.key === s.swaps[0].merchantKey)!; // pens run in paper order, not in the order the swaps came
    expect(pen.status).toBe("replanning");
    expect(pen.seq).toMatch(/:x$/);
    expect(lay.ours.find((l) => l.k === "SWAPS KEPT")?.v).toBe(`${s.swaps.length - 1} OF ${s.swaps.length}`);
    expect(totals(r).saving).toBeCloseTo(savingsTotals(r).monthly, 2);
  });

  it("lays the model-alone receipt's blank paper while it is asked for: its header, then as many lines as the answer will most likely have, blank", () => {
    const asked = flowReducer(replay(), { type: "run_requested", mode: "llm_only", ticket: 2 });
    const lay = buildLayout(asked);
    expect(asked.baseline.status).toBe("running");
    expect(lay.theirsAsking).toBe(true);
    expect(lay.theirsReady).toBe(false);
    expect(lay.theirs.slice(0, 3).map((l) => l.t)).toEqual(["head", "sub", "dots"]);
    expect(lay.theirs[1].text).toBe(`THE SAME ${lay.pens.length} MERCHANTS, NO QLOO`);
    expect(lay.theirs.slice(3).every((l) => !l.text && !l.name && !l.v)).toBe(true); // nothing printed past the header
    let s = asked; for (const event of baseline) s = flowReducer(s, { type: "event", mode: "llm_only", ticket: 2, event });
    const done = buildLayout(s);
    expect(done.theirsAsking).toBe(false);
    // the paper keeps its place when the answer comes: its "A MONTH" line within a line of the blank one's (the proof's rows are the model's runs')
    if (s.baseline.suggestions.length === lay.pens.length) expect(Math.abs((done.theirsTotalLi ?? 0) - (lay.theirsTotalLi ?? -9))).toBeLessThanOrEqual(1);
  });

  it("prints the model-alone receipt from the baseline: its checks before the proof is in, the recorded proof (every run) once it is", () => {
    let s = flowReducer(replay(), { type: "run_requested", mode: "llm_only", ticket: 2 });
    for (const event of baseline) s = flowReducer(s, { type: "event", mode: "llm_only", ticket: 2, event });
    const sug = s.baseline.suggestions;
    // the proof comes with the fixture's baseline_ready; whether the flow keeps it or /demo hands it over, the layout reads data.baseline.proof / proofRuns
    const ready = baseline.find((e) => e.type === "baseline_ready");
    const theirs = ready?.type === "baseline_ready" ? ready.proof : undefined, runs = ready?.type === "baseline_ready" ? ready.proofRuns : undefined;
    const before = buildLayout({ ...s, baseline: { ...s.baseline, proof: undefined, proofRuns: undefined } });
    expect(before.theirsReady).toBe(true);
    const checked = sug.filter((x) => x.verification !== "pending_key");
    expect(before.theirs.find((l) => l.k === "EXISTS")?.v).toBe(checked.length ? `${sug.filter((x) => x.existsInQloo).length} OF ${checked.length}` : "NOT CHECKED");
    expect(before.theirsTotalLi).not.toBeNull();
    expect(theirs).toBeDefined(); // the live recording carries the model's side (contract 1.3) and its runs (1.6)
    if (live) expect(runs?.length).toBeGreaterThan(1);
    const lay = buildLayout({ ...s, baseline: { ...s.baseline, proof: theirs, proofRuns: runs } });
    const rows = proofRows(s.plan!.proof!, theirs!, runs);
    const kv = (k: string) => lay.theirs.find((l) => l.k === k.toUpperCase());
    for (const r of rows.filter((x) => x.theirs !== "-")) expect(kv(r.label)?.v).toBe(r.theirs.toUpperCase() + (r.note && r.key !== "month" ? `, ${r.note.toUpperCase()}` : "")); // the paper prints proofRows' values, in its order
    expect(lay.theirs.filter((l) => rows.some((r) => l.k === r.label.toUpperCase())).map((l) => l.k)).toEqual(rows.filter((x) => x.theirs !== "-").map((r) => r.label.toUpperCase()));
    if (runs && runs.length > 1) expect(kv("a month")?.v).toMatch(/ TO /); // the spread over the runs
    expect(lay.theirs.some((l) => l.k === "EXISTS")).toBe(false);
    expect(lay.theirsTotalLi).toBe(lay.theirs.findIndex((l) => l.k === "A MONTH"));
  });

  it("keeps a rejected twin as a scribble line above its replacement", () => {
    let s = replay();
    const first = s.swaps[0];
    s = flowReducer(s, { type: "reject", swapId: first.id });
    const priors: Record<string, Prior> = {};
    collectPriors(s, priors);
    expect(priors[first.merchantKey]?.swapId).toBe(first.id);
    let lay = buildLayout(s, priors);
    const pen0 = lay.pens.find((t) => t.key === first.merchantKey)!;
    expect(pen0.status).toBe("replanning");
    expect(pen0.prior).toBeUndefined(); // still the same swap: the pen scribbles its own line
    const replans = JSON.parse(readFileSync(`${base}/maya.replans.json`, "utf8")) as Record<string, string[]>;
    const again = (replans[first.id] ?? []).map((l) => AgentEventSchema.parse(JSON.parse(l)));
    expect(again.length).toBeGreaterThan(0);
    s = flowReducer(s, { type: "run_requested", mode: "sametaste", ticket: 3 });
    for (const event of again) s = flowReducer(s, { type: "event", mode: "sametaste", ticket: 3, event });
    collectPriors(s, priors);
    lay = buildLayout(s, priors);
    const pen = lay.pens.find((t) => t.key === first.merchantKey)!;
    expect(pen.swapId).not.toBe(first.id);
    expect(pen.status).toBe("proposed");
    expect(pen.prior?.text).toBe(`→ ${first.to.entity.name}   $${twinMonthly(first).toFixed(2)}`);
    expect(pen.prior?.seq).toBe(`${first.merchantKey}:${first.id}:x`);
    expect(pen.prior!.li).toBe(pen.li - 1); // its own line, right above the replacement
    expect(lay.ours[pen.prior!.li].t).toBe("pen");
  });

  it("prints the measured proof (contract 1.6) from proofRows() on both receipts, in its order, the model's side as a range over its runs, the losing side in red", () => {
    let s = flowReducer(replay(), { type: "run_requested", mode: "llm_only", ticket: 2 });
    for (const event of baseline) s = flowReducer(s, { type: "event", mode: "llm_only", ticket: 2, event });
    const side = (o: Partial<ProofSide>): ProofSide => ({ of: 9, picks: 9, exists: 9, tasteLink: 0.84, tasteScored: 9, sharedTags: 8, cheaper: 9, monthlySavings: 612.4, qlooMock: false, perMerchant: [], ...o });
    // a live Maya day: 5 picks over 9 lines, 3 kept and 1 waiting, against two model-alone runs of 9 picks
    const ours = side({ picks: 5, exists: 5, tasteLink: 0.93, tasteScored: 5, cheaper: 5, priced: 5, kept: 3, waiting: 1, monthlySavings: 431.7, near: 5, medianDistanceKm: 0.69 });
    const runs = [
      side({ exists: 8, tasteLink: 0.94, tasteScored: 2, cheaper: 2, priced: 4, monthlySavings: 96.2, near: 6, medianDistanceKm: 1.32, whereSaid: 7, whereChecked: 7, nearestBranch: true }),
      side({ exists: 9, tasteLink: 0.86, tasteScored: 4, cheaper: 4, priced: 5, monthlySavings: 213, near: 3, medianDistanceKm: 1.62, whereSaid: 6, whereChecked: 9, nearestBranch: true }),
    ];
    const lay = buildLayout({ ...s, plan: { ...s.plan!, proof: ours }, baseline: { ...s.baseline, proof: runs[0], proofRuns: runs } });
    const order = (L: typeof lay.ours) => { const i = L.findIndex((l) => l.k === "CHEAPER"); return L.slice(i, i + 7).filter((l) => l.t === "kv" || l.t === "total").map((l) => l.k); };
    expect(order(lay.ours)).toEqual(["CHEAPER", "TASTE LINK", "NEAR YOU", "A MONTH", "FOUND ON QLOO", "WHERE IT SAID", "KEPT"]); // proofRows' order (agent 6b629d7): what holds in every run first
    expect(order(lay.theirs)).toEqual(["CHEAPER", "TASTE LINK", "NEAR YOU", "A MONTH", "FOUND ON QLOO", "WHERE IT SAID"]); // a model alone keeps no line on purpose: no row, not a dash
    const kv = (L: typeof lay.ours, k: string) => L.find((l) => l.k === k);
    expect(lay.ours[lay.savedLi!].k).toBe("A MONTH"); // the camera lines both receipts up on the month line
    expect(lay.theirsTotalLi).toBe(lay.theirs.findIndex((l) => l.k === "A MONTH"));
    expect(kv(lay.ours, "NEAR YOU")?.v).toBe("5 OF 5 PICKS, MEDIAN 0.7 KM");
    expect(kv(lay.theirs, "NEAR YOU")?.v).toBe("3–6 OF 9 PICKS, MEDIAN 1.3–1.6 KM");
    expect(kv(lay.theirs, "NEAR YOU")?.color).toBe(RED);
    expect(kv(lay.ours, "WHERE IT SAID")?.v).toBe("CHECKED ON QLOO");
    expect(kv(lay.theirs, "WHERE IT SAID")?.v).toBe("6–7 OF 9 PICKS, 0–2 NOT CHECKED");
    expect(kv(lay.theirs, "WHERE IT SAID")?.color).toBeUndefined();
    expect(proofSentence(ours, runs[0], runs)).toEqual({ ours: "5 of 5", what: "near you", theirs: "3–6 of 9" }); // the one-line Proof caption on / and /demo (v5): the near-you row, without the picks and the median
    expect(kv(lay.ours, "CHEAPER")?.v).toBe("5 OF 5 PICKS");
    expect(kv(lay.theirs, "CHEAPER")?.v).toBe("2–4 OF 9 PICKS, 4–5 PRICED");
    expect(kv(lay.theirs, "CHEAPER")?.color).toBe(RED);
    expect(kv(lay.ours, "A MONTH")?.v).toBe("−$431.70, 2.0X OR MORE"); // the multiple is our claim, the least over the runs: our side only
    expect(kv(lay.theirs, "A MONTH")?.v).toBe("−$96 TO −$213");
    expect(kv(lay.theirs, "A MONTH")?.color).toBe(RED);
    expect(kv(lay.ours, "TASTE LINK")?.v).toBe("0.93 (N=5)"); // a tie on one run, ours on the other: no verdict, no note
    expect(kv(lay.theirs, "TASTE LINK")?.v).toBe("0.86–0.94 (N=2–4)");
    expect(kv(lay.theirs, "TASTE LINK")?.color).toBeUndefined();
    expect(kv(lay.ours, "FOUND ON QLOO")?.v).toBe("5 OF 5 PICKS");
    expect(kv(lay.theirs, "FOUND ON QLOO")?.v).toBe("8–9 OF 9 PICKS");
    expect(kv(lay.theirs, "FOUND ON QLOO")?.color).toBeUndefined(); // the runs disagree
    expect(kv(lay.ours, "KEPT")?.v).toBe("3 LINES, NO CHEAPER TWIN; 1 WAITING FOR YOU");
    expect(lay.ours.some((l) => l.k === "SHARED TAGS" || l.k === "SAVED" || l.k === "EXISTS")).toBe(false); // off the paper since 1.4
    // every row one line: a label and value too long for the row print at the small size, on the same baseline
    for (const L of [lay.ours, lay.theirs]) for (const l of L.filter((x) => x.t === "kv" && x.v?.includes("PICKS"))) expect(!!l.small).toBe((l.k!.length + l.v!.length + 2) > 50);
    // one run, a month's ratio under 1.5: no multiple
    const one = buildLayout({ ...s, plan: { ...s.plan!, proof: ours }, baseline: { ...s.baseline, proof: side({ monthlySavings: 325.19 }), proofRuns: undefined } });
    expect(kv(one.ours, "A MONTH")?.v).toBe("−$431.70");
    expect(kv(one.theirs, "A MONTH")?.v).toBe("−$325.19");
  });
});
