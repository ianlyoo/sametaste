import { describe, expect, it } from "vitest";
import { isBundledPersona, recordedEvents } from "../../agent/handler";
import { SNAPSHOTS } from "../../../personas/snapshots";
import { AgentRequestSchema } from "../../contract";
import { prepareRequest } from "../stream";
import { buildRequest, flowReducer, initialFlow, statementKey, toLocalKeys } from "../flow";
import { PERSONA_PRESETS, personaPayload } from "../personas";
import { parseStatement } from "../statement";
import { formatMoney } from "../format";
import { toWire } from "../merchants";
import { deriveReceipt } from "@/components/scene/model";
import { ev, plan, swap } from "./fixtures";

describe("persona presets", () => {
  it("lists the three bundled personas", () => {
    expect(PERSONA_PRESETS.map((p) => p.name)).toEqual(["Maya", "Dev", "Sam"]);
    expect(PERSONA_PRESETS[0].place).toBe("Williamsburg");
  });

  it.each(PERSONA_PRESETS.map((p) => p.id))("%s parses in the browser and sends the server's own merchants", (id) => {
    const p = personaPayload(id)!;
    const s = flowReducer(initialFlow, {
      type: "statement_loaded",
      statement: parseStatement(p.csv),
      personaId: id,
      location: p.location,
      wire: p.merchants,
    });
    expect(s.statement!.transactions.length).toBeGreaterThan(10);
    const req = buildRequest(s, "sametaste");
    expect(req.merchants).toEqual(p.merchants);
    expect(req.personaId).toBe(id);
    expect(isBundledPersona(AgentRequestSchema.parse(prepareRequest(req)))).toBe(true);
  });

  it("an uploaded statement sends the browser aggregation", () => {
    const p = personaPayload(PERSONA_PRESETS[0].id)!;
    const s = flowReducer(initialFlow, { type: "statement_loaded", statement: parseStatement(p.csv), location: p.location });
    expect(buildRequest(s, "sametaste").merchants).toEqual(s.merchants.map(toWire));
  });
});

describe("server keys", () => {
  const id = PERSONA_PRESETS[0].id;
  const load = () => {
    const p = personaPayload(id)!;
    return flowReducer(initialFlow, { type: "statement_loaded", statement: parseStatement(p.csv), personaId: id, location: p.location, wire: p.merchants });
  };

  it("swaps from the snapshot land on their receipt lines; re-plans send local keys", () => {
    let s = load();
    const serverKey = s.wireMerchants!.find((m) => /LILIA/.test(m.key))!.key;
    expect(serverKey).not.toBe("LILIA");
    const sw = swap("s1", serverKey, "Leo", 100);
    s = flowReducer(s, { type: "run_requested", mode: "sametaste", ticket: 1 });
    for (const e of [ev.swap(sw), ev.plan(plan([sw])), ev.done()]) s = flowReducer(s, { type: "event", mode: "sametaste", ticket: 1, event: e });
    expect(s.swaps[0].merchantKey).toBe("LILIA");
    expect(s.plan!.swaps[0].merchantKey).toBe("LILIA");
    const rows = deriveReceipt(s).rows.filter((r) => r.twin);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.name === "Lilia" && r.twin!.name === "Leo")).toBe(true);

    s = flowReducer(s, { type: "reject", swapId: "s1" });
    const req = buildRequest(s, "sametaste");
    expect(req.merchants.some((m) => m.key === "LILIA")).toBe(true);
    expect(req.feedback![0].merchantKey).toBe("LILIA");
    expect(buildRequest(s, "llm_only").merchants).toEqual(s.wireMerchants);
  });
});

describe("recorded replay", () => {
  const maya = PERSONA_PRESETS[0].id;
  const wire = (r: ReturnType<typeof buildRequest>) => AgentRequestSchema.parse(prepareRequest(r));

  it("serves the first pass only; a reject or an answer goes to the live agent", () => {
    const p = personaPayload(maya)!;
    let s = flowReducer(initialFlow, { type: "statement_loaded", statement: parseStatement(p.csv), personaId: maya, location: p.location, wire: p.merchants });
    expect(recordedEvents(wire(buildRequest(s, "sametaste")))).toBeDefined();
    s = flowReducer(s, { type: "run_requested", mode: "sametaste", ticket: 1 });
    for (const e of SNAPSHOTS[maya].sametaste) s = flowReducer(s, { type: "event", mode: "sametaste", ticket: 1, event: e });
    expect(s.plan).toBeDefined();

    const rejected = flowReducer(s, { type: "reject", swapId: s.swaps[0].id });
    const req = buildRequest(rejected, "sametaste");
    expect(req.personaId).toBeUndefined();
    expect(req.feedback?.[0].verdict).toBe("reject");
    expect(recordedEvents(wire(req))).toBeUndefined();
    expect(isBundledPersona(wire(req))).toBe(false);

    const answered = buildRequest({ ...s, answers: [{ questionId: "q1", optionId: "a" }] }, "sametaste");
    expect(answered.personaId).toBeUndefined();
    expect(buildRequest(rejected, "llm_only").personaId).toBe(maya);
  });
});

describe("after a persona", () => {
  it("an upload does not inherit the persona's place", () => {
    const p = personaPayload(PERSONA_PRESETS[0].id)!;
    let s = flowReducer(initialFlow, { type: "statement_loaded", statement: parseStatement(p.csv), personaId: PERSONA_PRESETS[0].id, location: p.location, wire: p.merchants });
    s = flowReducer(s, { type: "statement_loaded", statement: parseStatement(p.csv) });
    expect(s.location).toBeUndefined();
    expect(s.wireMerchants).toBeUndefined();
    s = flowReducer(s, { type: "set_location", location: { label: "Astoria" } });
    s = flowReducer(s, { type: "statement_loaded", statement: parseStatement(p.csv) });
    expect(s.location).toEqual({ label: "Astoria" });
  });
});

describe("formatMoney", () => {
  it("formats with a true minus", () => {
    expect(formatMoney(1757.734)).toBe("$1,757.73");
    expect(formatMoney(-12)).toBe("−$12.00");
    expect(formatMoney(240, "USD", { cents: false })).toBe("$240");
  });
});

describe("contract 1.2 merged lines", () => {
  it("maps mergedKeys to local keys and never lists a line as merged into itself", () => {
    const sw = { ...swap("s1", "SQ BLUE BTL 0423", "Copper Otter Coffee"), mergedKeys: ["SQ BLUE BOTTLE COFFE", "SQ BLUE BTL 0423B"] };
    const map = { "SQ BLUE BTL 0423": "BLUE BTL", "SQ BLUE BOTTLE COFFE": "BLUE BOTTLE COFFE", "SQ BLUE BTL 0423B": "BLUE BTL" };
    const out = toLocalKeys(ev.swap(sw), map);
    expect(out.type === "swap_proposed" && out.swap.merchantKey).toBe("BLUE BTL");
    expect(out.type === "swap_proposed" && out.swap.mergedKeys).toEqual(["BLUE BOTTLE COFFE"]);
    const solo = toLocalKeys(ev.swap({ ...sw, mergedKeys: ["SQ BLUE BTL 0423B"] }), map);
    expect(solo.type === "swap_proposed" && "mergedKeys" in solo.swap).toBe(false);
  });
});

describe("server keys from another normaliser", () => {
  it("map to the one statement line they were cut from", () => {
    const p = PERSONA_PRESETS.find((x) => x.id === "dev-flatiron")!;
    const payload = personaPayload(p.id)!;
    const s = flowReducer(initialFlow, { type: "statement_loaded", statement: parseStatement(payload.csv), personaId: p.id, location: p.location, wire: payload.merchants });
    const local = (raw: string) => s.merchants.find((m) => m.rawMerchant.toUpperCase().includes(raw))?.key;
    expect(statementKey(s, "DEATH &")).toBe(local("DEATH & CO"));
    expect(statementKey(s, "SWEETGREEN NYC 8TH")).toBe(local("SWEETGREEN NYC 8TH"));
    expect(statementKey(s, "TST* SWEETGREEN FLATIRON")).toBe(local("SWEETGREEN NYC 8TH")); // payment prefix off; one local line for both
    expect(statementKey(s, local("DEATH & CO")!)).toBeUndefined(); // already local
    expect(statementKey(s, "NOWHERE AT ALL")).toBeUndefined();
    const ev = toLocalKeys({ type: "run_started", mode: "sametaste", qlooMock: true, fromCache: true, merges: [{ merchantKey: "SWEETGREEN NYC 8TH", mergedKeys: ["SWEETGREEN FLATIRON"] }], runId: "r", seq: 0, ts: "2026-10-22T00:00:00.000Z" }, s.keyMap ?? {}, (k) => statementKey(s, k));
    // both descriptors are one local line already, so nothing is left to merge
    expect(ev.type === "run_started" && ev.merges).toEqual([]);
  });
});
