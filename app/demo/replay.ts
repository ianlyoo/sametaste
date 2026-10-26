/**
 * A `fetch` that answers `POST /api/agent` from a recorded run, so the demo
 * runs without the agent. The recording comes from GET /api/recording/:persona
 * (the live one from the server's KV, else the bundled mock one), answering
 * exactly the requests `useAgentFlow` builds: the SameTaste run, the LLM-only
 * baseline, and one re-plan per swap (`replans`, keyed by the rejected swap id).
 */
import type { AgentRequest, ProofSide } from "@/lib/contract";

// the taste entities (place, artist, movie, ...) stream by the hundred on a live day; they tick, the story beats wait
const DELAY: Record<string, number> = { swap_proposed: 1100, tool_step: 260, status: 320, message: 240, plan_ready: 700, merchants_resolved: 500, taste_fingerprint: 500, baseline_ready: 600, done: 100, run_started: 80 };
const ENTITY_DELAY = 60;

/** `base`: the recording route (/api/recording); `personaId`: the sample persona's id. */
export function makeDemoFetch(base: string, personaId: string, instant: boolean, hooks: { onBaselineProof?: (p: ProofSide, runs?: ProofSide[]) => void } = {}): typeof fetch {
  const cache = new Map<string, Promise<string>>();
  const text = (part: "sametaste" | "llm_only" | "replans") => {
    let p = cache.get(part);
    if (!p) {
      p = fetch(`${base}/${encodeURIComponent(personaId)}?part=${part}`).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`recording ${part}: HTTP ${r.status}`))));
      p.catch(() => cache.delete(part)); // a failed load is retried on the next request
      cache.set(part, p);
    }
    return p;
  };
  return async (_input, init) => {
    const req = JSON.parse(String(init?.body ?? "{}")) as AgentRequest;
    let lines: string[];
    if (req.mode === "llm_only") lines = (await text("llm_only")).split("\n").filter(Boolean);
    else {
      const rejected = (req.feedback ?? []).filter((f) => f.verdict === "reject").map((f) => f.swapId);
      const open = rejected.filter((id) => req.previousPlan?.swaps.some((s) => s.id === id && s.status === "rejected"));
      if (open.length) {
        const replans = JSON.parse(await text("replans")) as Record<string, string[]>;
        const id = open[open.length - 1];
        lines = replans[id] ?? [JSON.stringify({ type: "run_started", mode: "sametaste", qlooMock: false, fromCache: false, runId: "demo", seq: 0, ts: new Date().toISOString() }), JSON.stringify({ type: "done", reason: "complete", usage: { toolTurns: 0, qlooCalls: 0, costUsd: 0 }, runId: "demo", seq: 1, ts: new Date().toISOString() })];
      } else lines = (await text("sametaste")).split("\n").filter(Boolean);
    }
    const enc = new TextEncoder();
    let cancelled = false;
    init?.signal?.addEventListener("abort", () => { cancelled = true; });
    const stream = new ReadableStream<Uint8Array>({
      async start(ctl) {
        for (const l of lines) {
          if (cancelled) break;
          let type = "";
          try { const ev = JSON.parse(l) as { type: string; proof?: ProofSide; proofRuns?: ProofSide[] }; type = ev.type; if (type === "baseline_ready" && ev.proof) hooks.onBaselineProof?.(ev.proof, ev.proofRuns); } catch { /* keep going */ }
          if (!instant) await new Promise((r) => setTimeout(r, DELAY[type] ?? ENTITY_DELAY));
          if (cancelled) break;
          ctl.enqueue(enc.encode(l + "\n"));
        }
        ctl.close();
      },
      cancel() { cancelled = true; },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson" } });
  };
}
