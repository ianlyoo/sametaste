import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentRequest } from "../../contract";
import { AgentHttpError, AgentStreamError, streamAgent } from "../stream";
import { ev, fakeFetch, ndjson, plan, swap } from "./fixtures";

const req: AgentRequest = {
  location: { label: "Williamsburg, Brooklyn, NY" },
  merchants: [{ key: "LILIA", rawMerchant: "TST* LILIA", count: 3, totalSpend: 336 }],
};

async function collect(f: typeof fetch, onUnknown?: (v: unknown) => void) {
  const out: AgentEvent[] = [];
  for await (const e of streamAgent(req, { fetch: f, onUnknown })) out.push(e);
  return out;
}

describe("streamAgent", () => {
  it("yields events across arbitrary chunk boundaries and stops at done", async () => {
    const s = swap("s1", "LILIA", "Leo");
    const text = ndjson([ev.started(), ev.step("a", "started"), ev.swap(s), ev.plan(plan([s])), ev.done()]) + '{"after":"done"}\n';
    const chunks = text.match(/[\s\S]{1,7}/g)!;
    const capture: { body?: unknown } = {};
    const out = await collect(fakeFetch(chunks, { capture }));
    expect(out.map((e) => e.type)).toEqual(["run_started", "tool_step", "swap_proposed", "plan_ready", "done"]);
    expect(capture.body).toMatchObject({ version: 1, mode: "sametaste", merchants: [{ key: "LILIA", currency: "USD" }] });
  });

  it("accepts a final line without a trailing newline", async () => {
    const text = ndjson([ev.started()]) + JSON.stringify(ev.done());
    expect((await collect(fakeFetch([text]))).map((e) => e.type)).toEqual(["run_started", "done"]);
  });

  it("skips unknown event types (newer contract) and reports them", async () => {
    const seen: unknown[] = [];
    const text = ndjson([ev.started()]) + '{"type":"future_event","runId":"r1","seq":9,"ts":"x"}\n' + ndjson([ev.done()]);
    const out = await collect(fakeFetch([text]), (v) => seen.push(v));
    expect(out).toHaveLength(2);
    expect(seen).toHaveLength(1);
  });

  it("throws on a stream cut before done", async () => {
    await expect(collect(fakeFetch([ndjson([ev.started()])]))).rejects.toMatchObject({ code: "truncated" });
  });

  it("throws on non-JSON lines", async () => {
    await expect(collect(fakeFetch(["<html>oops</html>\n"]))).rejects.toBeInstanceOf(AgentStreamError);
  });

  it("maps HTTP errors and keeps the server message", async () => {
    const err = await collect(fakeFetch(['{"message":"Slow down"}'], { status: 429 })).catch((e) => e);
    expect(err).toBeInstanceOf(AgentHttpError);
    expect(err).toMatchObject({ status: 429, retryable: true, message: "Slow down" });
    const bad = await collect(fakeFetch(["nope"], { status: 400 })).catch((e) => e);
    expect(bad).toMatchObject({ status: 400, retryable: false });
  });

  it("rejects invalid requests before sending", async () => {
    const f = fakeFetch([]);
    const it = streamAgent({ ...req, merchants: [] }, { fetch: f });
    await expect(it.next()).rejects.toThrow();
  });
});
