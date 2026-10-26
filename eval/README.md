# eval: NYC benchmark and go/no-go gate

A fixed set of 40 New York merchants (`merchants.ts`, public names, synthetic
card descriptors) run through two systems, both scored by Qloo:

| metric | meaning |
|---|---|
| resolve rate | SameTaste matched the descriptor to the right business via `/search` |
| hallucination rate | suggestions `/search` cannot find near NYC |
| cheaper hit rate | merchants with a real suggestion at a lower `price_level` |
| taste match | mean Qloo affinity of the real suggestion to the original (same insights query for both systems) |
| monthly savings | savings engine on a fixed visit profile (`VISITS_PER_MONTH`) |

"LLM alone" gets the same cleaned name and category and answers from memory;
SameTaste uses the agent's own `findTwins` (insights, one price level down).
The alias table in the normaliser is off by default here, so resolve rate
does not lean on aliases written for these merchants (`--aliases` turns it on).

```
npm run eval:bench                 # live Qloo when QLOO_API_KEY is set, else mock
npm run eval:bench -- --mock       # force the mock
npm run eval:bench -- --live-llm   # live LLM baseline + normaliser (spend-capped)
npm run eval:gate                  # 10/27 gate on the live summary: exit 0 GO, 1 NO-GO, 2 no result
```

Outputs: `eval/results/benchmark.<mock|live>.summary.json` (aggregates only,
`BenchmarkSummary` in `lib/contract.ts`, for the UI) and
`.scratch/eval/benchmark.<mode>.detail.json` (per merchant, contains Qloo
data, never committed). Mock numbers come from a synthetic world and prove
nothing.
