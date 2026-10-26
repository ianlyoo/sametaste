# SameTaste

Your card statement, same taste, for less.

Drop in a month of card transactions. An agent reads each merchant, finds it on
Qloo's taste graph, and writes a cheaper place you would like just as much
under each line. Say no to a swap and it writes another. The total and the
monthly saving move with every answer.

No login, no sign-up. Everything is in English.

## Try it

Open the app and pick **Maya**, **Dev** or **Sam**: three synthetic New York
statements. Or drop your own CSV on the page. Scroll down the receipt:

1. **Statement**: the lines as printed.
2. **Understood**: what Qloo recognised, and the taste it read from them.
3. **Swaps**: a twin in red pen under each line. Click a red line, or
   "Keep …" in the side panel, to say no. The agent re-plans that one merchant.
4. **Next month**: the planned month and the saving.
5. **Proof**: the same merchants given to a model alone, without Qloo, and how
   many of its picks exist at all.

Direct links: `/?persona=maya`, `/?persona=dev`, `/?persona=sam`.

Keyboard and screen readers: the first Tab stop is "Receipt as text", a plain
table of every line with Keep/Take buttons.

### Your own statement

A CSV with a header row and the columns `date,description,amount`
(`currency` optional; a positive amount is spend):

```csv
date,description,amount,currency
2026-09-08,TST* LILIA - BROOKLYN,160.66,USD
2026-09-09,SQ *BLUE BTL 0423,8.06,USD
```

The file is parsed in the browser. Only merchant names, counts and totals are
sent to the server; dates and single amounts stay on your machine. The app asks for
your neighbourhood once, so twins are near you.

## Run it yourself

Needs Node 24 and npm.

```bash
git clone https://github.com/ianlyoo/sametaste.git
cd sametaste
npm i
cp .env.example .env.local   # then set ANTHROPIC_API_KEY and QLOO_API_KEY, and QLOO_MOCK= (empty)
npm run dev                  # http://localhost:3000
```

It also runs with no keys at all: skip the `.env.local` step (or keep
`QLOO_MOCK=1`) and `npm run dev` uses a scripted agent against bundled
sample Qloo answers; the page shows **Sample Qloo**. The same offline, as a
production build:

```bash
npm run build
AGENT_SCRIPTED=1 QLOO_MOCK=1 npm start
```

A production server with no keys serves only the three sample statements.

The repository holds mock Qloo data only. Qloo's terms allow its responses in
a private server-side cache but not in a public repository, so the recordings
made on live Qloo that the hosted demo replays live in the server's KV store
(`lib/agent/recordings.ts`, served by `GET /api/recording/<persona>`). Without
a store the app replays the bundled mock recordings instead.

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | empty | Claude key for the live agent. |
| `QLOO_API_KEY` | empty | Qloo hackathon key. |
| `QLOO_BASE_URL` | `https://hackathon.api.qloo.com` | Qloo API base. |
| `QLOO_MOCK` | `1` in `.env.example` | `1` uses the bundled sample answers. |
| `AGENT_SCRIPTED` | off | `1` runs the scripted agent instead of Claude. |
| `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_S` | `6`, `600` | Runs per IP per window. |
| `TOTAL_SPEND_CAP_USD`, `DAILY_SPEND_CAP_USD` | `100`, `15` | Hard caps on model spend. |

Never commit `.env.local`.

## Test

```bash
npm test          # vitest: statement parsing, agent, Qloo client, savings, scene layout
npm run lint
```

## How it works

- **Browser** (`lib/client/`): parses the CSV, cleans descriptors
  ("SQ \*BLUE BTL 0423" becomes Blue Bottle Coffee), groups lines by merchant
  and streams the agent's NDJSON events into one state.
- **Agent** (`app/api/agent`, `lib/agent/`): a Claude Sonnet 5.5 tool loop
  (Vercel AI SDK). Its tools: `normalize_merchants` (Haiku 5.5),
  `qloo_search`, `qloo_insights`, `qloo_tags`, `qloo_taste_profile`,
  `ask_user`, `savings_engine`, `propose_swap` and `plan_writer`. It asks
  when a merchant is ambiguous ("Which Joe's did you mean?") and re-plans one
  merchant at a time after a no.
- **Qloo** (`lib/qloo/`): `/search` resolves each merchant to an entity.
  `/v2/insights` with that entity as the signal, your location and a lower
  price level finds the twins. Cross-domain insights (music, film, brands)
  give the taste read shown on "Understood".
- **Savings** (`lib/savings/`): deterministic. Price tier and your own ticket
  size give the estimate. No model does arithmetic.
- **Scene** (`components/scene/`): the receipt, pen and photos in three.js.
  The overlay (`components/counter/`) prints only numbers the paper prints.
- **Proof** (`lib/agent/baseline.ts`): the same merchants go to a model with
  no Qloo, then Qloo `/search` checks whether each pick exists near you and
  whether it is really cheaper.

Contract between browser and server: `lib/contract.ts`.

## Credits and licence

MIT, see `LICENSE`. Scene photos, models and fonts: `public/scene/CREDITS.md`.
Persona statements are invented; see `personas/README.md`.
