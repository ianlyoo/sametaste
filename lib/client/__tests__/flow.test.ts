import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../contract";
import { buildRequest, canGo, flowReducer, initialFlow, planSwaps, qlooCalls, reviewComplete, type FlowAction, type FlowState } from "../flow";
import { pumpRun } from "../runner";
import { parseStatement } from "../statement";
import { ev, fakeFetch, ndjson, plan, swap } from "./fixtures";

const CSV = "date,merchant,amount\n2026-09-01,TST* LILIA 4410,112.40\n2026-09-03,SQ *BLUE BOTTLE COFFEE,6.80\n2026-09-30,Lilia,100";
const LOC = { label: "Williamsburg, Brooklyn, NY" };

const reduce = (s: FlowState, ...as: FlowAction[]) => as.reduce(flowReducer, s);
const loaded = () => reduce(initialFlow, { type: "statement_loaded", statement: parseStatement(CSV), personaId: "maya", location: LOC });
const events = (s: FlowState, ticket: number, list: AgentEvent[], mode: "sametaste" | "llm_only" = "sametaste") =>
  reduce(s, ...list.map((event) => ({ type: "event" as const, mode, ticket, event })));

describe("flow reducer", () => {
  it("loads a statement into local merchants and categories", () => {
    const s = loaded();
    expect(s.step).toBe("categories");
    expect(s.merchants.map((m) => [m.key, m.count, m.totalSpend])).toEqual([
      ["LILIA", 2, 212.4],
      ["BLUE BOTTLE COFFEE", 1, 6.8],
    ]);
    expect(s.categories[0].total).toBe(212.4);
  });

  it("guards navigation", () => {
    expect(canGo(initialFlow, "swaps")).toBe(false);
    expect(reduce(initialFlow, { type: "go", step: "plan" }).step).toBe("upload");
    const s = loaded();
    expect(reduce(s, { type: "go", step: "swaps" }).step).toBe("swaps");
    expect(canGo(s, "plan")).toBe(false);
    expect(canGo({ ...s, location: undefined }, "swaps")).toBe(false);
  });

  it("runs, collects steps, swaps and plan, and drops stale events", () => {
    const a = swap("s1", "LILIA", "Leo", 186);
    const b = swap("s2", "BLUE BOTTLE COFFEE", "Variety Coffee", 52);
    let s = reduce(loaded(), { type: "run_requested", mode: "sametaste", ticket: 1 });
    s = events(s, 1, [ev.started(), ev.step("x", "started"), ev.step("x", "finished", 4), ev.swap(a), ev.swap(b)]);
    s = events(s, 0, [ev.swap(swap("old", "OLD", "Stale"))]);
    s = events(s, 1, [ev.plan(plan([a, b])), ev.done()]);
    expect(s.run.status).toBe("done");
    expect(s.run.steps).toHaveLength(1);
    expect(s.run.steps[0].state).toBe("finished");
    expect(qlooCalls(s.run)).toBe(9);
    expect(s.swaps.map((x) => x.to.entity.name)).toEqual(["Leo", "Variety Coffee"]);
    expect(canGo(s, "plan")).toBe(true);
  });

  it("reject records feedback, then the replacement takes the same slot; accepted swaps survive the re-plan", () => {
    const a = swap("s1", "LILIA", "Leo", 186);
    const b = swap("s2", "BLUE BOTTLE COFFEE", "Variety Coffee", 52);
    let s = events(reduce(loaded(), { type: "run_requested", mode: "sametaste", ticket: 1 }), 1, [ev.started(), ev.swap(a), ev.swap(b), ev.plan(plan([a, b])), ev.done()]);
    s = reduce(s, { type: "accept", swapId: "s2" }, { type: "reject", swapId: "s1", reason: "too far" });
    expect(s.replanning).toEqual(["LILIA"]);
    expect(s.feedback).toEqual([
      { swapId: "s2", merchantKey: "BLUE BOTTLE COFFEE", candidateEntityId: "e-Variety Coffee", verdict: "accept" },
      { swapId: "s1", merchantKey: "LILIA", candidateEntityId: "e-Leo", verdict: "reject", reason: "too far" },
    ]);
    const req = buildRequest(s);
    expect(req.feedback).toHaveLength(2);
    expect(req.previousPlan?.swaps.map((x) => x.status)).toEqual(["rejected", "accepted"]);
    expect(req.personaId).toBeUndefined(); // a re-plan always runs live
    expect(JSON.stringify(req)).not.toContain("4410");

    s = reduce(s, { type: "run_requested", mode: "sametaste", ticket: 2 });
    expect(s.run.steps).toEqual([]); // no steps were in the first run; feed is kept, not reset
    const fini = swap("s3", "LILIA", "Fini Pizza", 171);
    const echoed = { ...b, status: "proposed" as const };
    s = events(s, 2, [ev.started("r2"), ev.swap(fini), ev.plan(plan([fini, echoed])), ev.done("complete", "r2")]);
    expect(s.swaps.map((x) => [x.to.entity.name, x.status])).toEqual([
      ["Fini Pizza", "proposed"],
      ["Variety Coffee", "accepted"],
    ]);
    expect(s.replanning).toEqual([]);
    expect(planSwaps(s).map((x) => x.id)).toEqual(["s2"]);
    s = reduce(s, { type: "accept", swapId: "s3" });
    expect(reviewComplete(s)).toBe(true);
    s = reduce(s, { type: "undo", swapId: "s3" });
    // the reject of s1 stays, so the server never re-proposes Leo
    expect(s.feedback.map((f) => f.swapId)).toEqual(["s2", "s1"]);
  });

  it("keeps the v1.1 taste fingerprint", () => {
    const s = events(reduce(loaded(), { type: "run_requested", mode: "sametaste", ticket: 1 }), 1, [ev.started(), ev.fingerprint()]);
    expect(s.fingerprint?.headline).toBe("Natural-wine bars, indie folk");
  });

  it("handles questions and answers", () => {
    let s = events(reduce(loaded(), { type: "run_requested", mode: "sametaste", ticket: 1 }), 1, [ev.started(), ev.question(), ev.done("awaiting_answer")]);
    expect(s.question?.id).toBe("q1");
    expect(s.run.doneReason).toBe("awaiting_answer");
    s = reduce(s, { type: "answer", answer: { questionId: "q1", optionId: "a" } });
    expect(s.question).toBeUndefined();
    expect(buildRequest(s).answers).toEqual([{ questionId: "q1", optionId: "a" }]);
  });

  it("keeps the baseline run separate", () => {
    let s = reduce(loaded(), { type: "run_requested", mode: "sametaste", ticket: 1 }, { type: "run_requested", mode: "llm_only", ticket: 2 });
    s = events(s, 2, [ev.started("b1", "llm_only"), ev.baseline(), ev.done("complete", "b1")], "llm_only");
    expect(s.baseline.suggestions[0].suggestedName).toBe("Bella Napoli");
    expect(s.baseline.status).toBe("done");
    expect(s.run.status).toBe("running");
    const req = buildRequest(s, "llm_only");
    expect(req.mode).toBe("llm_only");
    expect(req.feedback).toBeUndefined();
  });

  it("surfaces errors from the stream and from done(error)", () => {
    let s = events(reduce(loaded(), { type: "run_requested", mode: "sametaste", ticket: 1 }), 1, [ev.started(), ev.error(), ev.done("error")]);
    expect(s.run.status).toBe("error");
    expect(s.run.error).toEqual({ code: "qloo_error", message: "Qloo timed out", retryable: true });
    s = reduce(s, { type: "run_failed", mode: "sametaste", ticket: 0, error: { code: "x", message: "stale", retryable: true } });
    expect(s.run.error?.code).toBe("qloo_error");
  });

  it("a new statement resets the flow but keeps tickets", () => {
    let s = reduce(loaded(), { type: "run_requested", mode: "sametaste", ticket: 5 });
    s = reduce(s, { type: "statement_loaded", statement: parseStatement(CSV) });
    expect(s.run.status).toBe("idle");
    expect(s.run.ticket).toBe(5);
    // loaded() is a persona; its place does not carry over to a new statement
    expect(s.location).toBeUndefined();
    expect(reduce(s, { type: "reset" }).step).toBe("upload");
  });
});

describe("pumpRun", () => {
  it("drives a full run through the reducer", async () => {
    let s = loaded();
    const a = swap("s1", "LILIA", "Leo");
    const f = fakeFetch([ndjson([ev.started(), ev.swap(a), ev.plan(plan([a])), ev.done()])]);
    await pumpRun(buildRequest(s), "sametaste", 1, (x) => (s = flowReducer(s, x)), { fetch: f });
    expect(s.run.status).toBe("done");
    expect(s.plan?.id).toBe("p1");
  });

  it("turns HTTP and network failures into run errors", async () => {
    let s = loaded();
    await pumpRun(buildRequest(s), "sametaste", 1, (x) => (s = flowReducer(s, x)), { fetch: fakeFetch(["{}"], { status: 429 }) });
    expect(s.run.error).toMatchObject({ code: "rate_limited", retryable: true });
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await pumpRun(buildRequest(s), "sametaste", 2, (x) => (s = flowReducer(s, x)), { fetch: down });
    expect(s.run.error).toMatchObject({ code: "network" });
  });

  it("stays silent when aborted", async () => {
    let s = loaded();
    const ac = new AbortController();
    ac.abort();
    const f = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return new Response("");
    }) as typeof fetch;
    await pumpRun(buildRequest(s), "sametaste", 1, (x) => (s = flowReducer(s, x)), { fetch: f, signal: ac.signal });
    expect(s.run.status).toBe("running");
    expect(s.run.error).toBeUndefined();
  });
});
