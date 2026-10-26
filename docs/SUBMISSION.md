# SameTaste

Your card statement, same taste, for less.

- **Live demo:** https://qloo-sametaste.vercel.app (no login, hosted on Vercel)
- **Code:** https://github.com/ianlyoo/sametaste (MIT license, `LICENSE`)

## What it does

Drop in a month of card transactions and SameTaste prints them as a receipt.
An agent finds each merchant on Qloo and writes a twin in red pen under it: a
place near you that people with your taste love as much, for less. Click a red
line to say no and it writes another. The receipt ends with next month,
planned.

Maya's live run (a sample statement, Williamsburg): 5 swaps, $431.27 a month
less out of $2,077.95 (20.8%). 3 lines are kept because no cheaper twin shares
her taste, and 1 waits for her answer. One swap explains itself with Qloo's
graph: "Fans of Peter Luger Steak House and St. Anselm both love Eater".

## Technological Implementation

Finding a cheaper place is easy. Finding a cheaper place *you* would choose
is a taste question, and Qloo answers it.

- **Resolve:** messy descriptors ("TST\* LILIA - BROOKLYN") are cleaned in
  the browser and by Claude Haiku 5.5, then Qloo `/search` maps each to an
  entity near the user. When two fit, the agent asks ("Which Joe's?").
- **Twin:** Qloo Insights for places, with the merchant as the taste signal,
  the user's location, and a lower price level. The search widens when
  nothing comes back. The taste tags a twin shares with the original are
  printed under it.
- **Taste read:** cross-domain Insights (music, film, brands) show what the
  statement says about you.
- **Agent:** a Claude Sonnet 5.5 tool loop (Vercel AI SDK) with nine typed
  tools, four of them Qloo calls. After a no it re-plans that one merchant.
- **Money:** a deterministic engine (price tier × your ticket × visits). No
  model does arithmetic.
- **Proof:** the same merchants go to the model alone, with no Qloo, 5 times.
  Each of its picks is resolved to its nearest real branch, then both sides
  are scored with the same Qloo calls and the same engine:

| Maya | SameTaste | Model alone, 5 runs |
| --- | --- | --- |
| Near you (≤ 1.5 km) | 5 of 5, median 0.7 km | 3–6 of 9, 1.3–1.6 km |
| Cheaper | 5 of 5 picks | 2–4 of 9 |
| Taste link (Qloo affinity) | 0.93 | 0.85–0.90 |
| A month | −$431 | −$213 to −$472 |

  The monthly saving overlaps: a model alone can save as much in a good run.
  The claim is that SameTaste is same taste, nearby and actually cheaper,
  every run.
- **Guards:** rate limit, call caps, daily and total spend caps. Qloo
  responses are cached server-side only.

## Design

One object, one gesture. The app is a receipt on a counter (three.js); you
scroll down it and the agent's work appears as pen on paper. Every number is
printed on the receipt, and the overlay repeats only those. A no is a click on
the red line; a question is a paper slip. It works on a phone, and a full text
version (the first Tab stop) works by keyboard.

## Potential Impact

When money is tight, eating out, coffee and classes go first, and cheaper
replacements found by hand rarely feel the same. SameTaste keeps the taste and
lowers the price, from a statement people already have, with no quiz or
account. Banks and card issuers hold that statement and could offer it in
their apps; card-linked offers could pay per redirected visit.

## Quality of the Idea

Budget apps say "spend less"; recommendation apps say "try this". SameTaste
starts from what you already chose with your own money. The statement is the
taste signal, and Qloo's graph makes the twin a twin rather than a cheaper
guess.

## Privacy

The statement is parsed in the browser. Only merchant names, counts and totals are
sent; nothing is stored.

## Testing instructions for judges

1. Open https://qloo-sametaste.vercel.app. No login.
2. Click **Maya** and scroll. The twins are written in red (this first pass
   replays Maya's recorded live run).
3. Click a red written line to say no. That re-plan, like any answer to a
   question, runs the live agent.
4. Scroll on to the plan and the proof.
5. Optional: drop your own CSV (`date,description,amount`).

If the spend cap is reached the page says so; recorded runs still play.

## Built with

TypeScript, Next.js 16, React 19, three.js, Tailwind CSS 4, Vercel AI SDK,
Claude Sonnet 5.5 and Haiku 5.5, Qloo Insights API, zod, vitest. Hosted on
Vercel.
