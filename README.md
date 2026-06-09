# WC26 Tracker

A mobile-first web app for the **2026 FIFA World Cup**. Two jobs:

1. A clean, FotMob-grade live-scores + match experience.
2. **Live third-place qualification & progression tracking** — the unique value.

The progression intelligence is woven into the everyday surfaces (match rows, match
pages, team pages), not siloed in one tab.

> Single-tournament product. The 2026 structure (12 groups of 4, best-8-of-12
> third-placed teams advance) is hardcoded on purpose — it gets retired afterwards.

## Architecture

```
API-Football ──poll (Cron)──▶ Worker ──normalise──▶ Workers KV (latest.json)
                                                          │
                                            Cloudflare Pages frontend
                                            fetch('/data/latest.json')
```

The frontend **only ever reads the KV snapshot** — it never calls the data API
directly. User count is irrelevant to API limits (only poll frequency matters), and
if the API dies the last good snapshot keeps serving. The **progression/scenario
engine runs client-side** on that snapshot — zero extra API calls.

## Repo layout

```
/worker          # Cron poller + normaliser → KV (Cloudflare Worker)
/web             # Pages frontend (static; reads snapshot, runs scenario engine)
/web/js          # frontend modules; engine.js is the canonical shared engine
/web/data        # latest.json (mock), annexC.json, teamColours.json
/shared          # snapshot TypeScript types (documentation)
/scripts         # gen-mock.js — regenerates the mock snapshot
wrangler.toml
```

**Note on the engine location:** the brief suggests `/shared/engine`. To keep the
Pages site fully static with no build step, the canonical engine lives at
`web/js/engine.js` (served directly to the browser). The Worker imports the *same
file* at bundle time (`worker/index.js` → `../web/js/engine.js`), so there is still
a single source of truth. `/shared` holds the TypeScript snapshot types.

## Develop

```bash
npm install          # only dev deps (wrangler); engine/app have zero runtime deps
npm test             # run the engine unit tests (node --test)
npm run gen:mock     # regenerate web/data/latest.json
npm run dev:web      # serve /web locally (python http.server)
npm run dev:worker   # wrangler dev for the Worker
```

Open the local web server and you get the full app running against the mock
snapshot. Everything (Matches, Race, Watch, Bracket, More + detail pages) works
offline against `web/data/latest.json`.

## Status / honesty notes (see brief §8)

- **No xG / xA anywhere.** Deliberate.
- **Annex C** (`web/data/annexC.json`) ships with the full 495-combination *structure*
  but a **placeholder slot mapping** — it must be replaced with FIFA's official
  allocation chart before going live. The code flags this.
- Verdict bounds (Qualified/In/Sweating/Out/Eliminated) use a transparent
  best/worst-case method; the interactive scenario board's `resolve()` is exact for
  any concrete set of results. See `web/js/engine.js` header for the precise method
  and its documented approximations.
- The Worker's API-Football league id / season / team ids are marked `VERIFY` — they
  must be confirmed against the live API before deploying (brief §3, §7a).

## Deploy (outline)

1. Create a KV namespace, put its id in `wrangler.toml`.
2. Set the `APIFOOTBALL_KEY` secret: `wrangler secret put APIFOOTBALL_KEY`.
3. `wrangler deploy` (Worker + Cron).
4. Create a Pages project pointing at `/web` as the output dir; add the
   `/data/latest.json` route so it reads the KV snapshot (Pages Function included).
