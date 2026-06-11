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

```bash
npm run smoke        # render every screen (all phases) in node to catch view errors
```

## Phase evolution (Part B — §11–15)

The tournament's focus shifts over time via one flag, `meta.phase`
(`pre | group | groupFinal | knockout`), derived by the pure `tournamentPhase()` in
`web/js/engine.js`. Phase shifting is **additive only** — it layers context onto the
Matches feed without ever removing a fixture (§1a rule 1):

- **Matches** gains a `Matches | Race for R32` underlined toggle (the right side flashes
  amber + LIVE during `groupFinal`), and accretes inline: a countdown hero (`pre`), the
  embedded Race card (`group`), each group's table under its final games + a prominent
  cut-line card (`groupFinal`), and the bracket (`knockout`).
- **Groups → Race for R32** runs the same phase-driven flash, handing off to the Bracket
  in `knockout`.
- **Bracket** (under More) is two fully-vertical sub-tabs — **Path** (a team's route as a
  spine) and **Bracket** (Top/Bottom-half connected ties) — no horizontal scroll.
- **Stakes** (`Decider / Seeding / Dead rubber`, `stakesFor()` in the engine) tag upcoming
  group fixtures.
- **Notifications** (§14) — web push via the PWA (`web/manifest.webmanifest`, `web/sw.js`),
  three quiet toggles in More → settings. **No login/identity**: the push endpoint is the
  per-device key, stored in KV with that device's prefs. The push crypto (VAPID + RFC 8291
  aes128gcm) is in `worker/push.js`, validated by a round-trip test (`scripts/push.test.js`).
  Inert until VAPID keys are set — generate with `npm run gen:vapid` (see `wrangler.toml`).

## Phase 3 — channel, morning view, reminders

Three additive features on the same snapshot/engine (never hide a fixture, no accounts):

- **Channel (where to watch)** — a UK channel tag on match rows and the match centre
  (stream — iPlayer/ITVX — on the details screen). API-Football doesn't carry the UK
  broadcaster, so it comes from the published BBC/ITV schedules:
  - `web/data/tvUK.json` is the static seed (mirrored to `web/js/tvUK.data.js` for the
    Worker bundle — regenerate both with `npm run gen:tvseed`).
  - **Kept accurate automatically:** the Worker cron re-fetches the schedules source
    (`TV_SOURCE_URL`) **daily** at ~05:00 UK, with a 6-hourly retry while any match in
    the next 48h still lacks a channel — so corrections propagate and the knockout
    TBCs fill in as broadcasters announce splits. Live data overlays the seed in KV;
    `/admin/refresh-tv` forces a check; `/admin/status` shows TV-map health.
  - Matching is conservative (`worker/tv.js`): group games by both team names
    (alias-aware) + UK date; knockouts by round + UK date + kickoff (slots keyed
    `R32-M73` — official FIFA numbering). **No confident match → no tag. Never guess.**
  - Manual escape hatch: `byFixture` (fixture id) / `bySlot` overrides in `tvUK.json`.
- **Morning view (06:00–13:00 UK)** — the Matches tab leads with a catch-up layout
  (`web/js/morning.js` is the pure model): *Last night* (overnight results + the
  qualification flips they caused, computed by reverse-applying results through the
  engine), *Today — the slate* (every match, kickoff/channel/stakes), and *What's at
  stake today* (engine storylines: groups decided today, who can go through/out, the
  cut line). Scales with the phase — full at `groupFinal`, quiet early, reframed as
  advanced/ties for knockout mornings. Reverts to the normal feed after 13:00.
  Dev/demo: append `?morning=1` to `#/matches` to force the window.
- **Per-match reminder** — a bell on fixture rows + the match centre. Push first
  (a one-off nudge 15/30/60 min pre-kickoff, scheduled on the device's anonymous
  push-subscription record via `POST /push/remind` and delivered by the per-minute
  cron — with the channel in the body); a client-generated `.ics` calendar event as
  the works-anywhere fallback. State is per-device (localStorage + the subscription
  record). No accounts.

## Live commentary — two user-selectable feeds

The match centre's **Commentary** tab can carry two independent feeds, and the user
picks which to read (a pill switcher; not one or the other). The switcher only shows
when both are actually present for that match:

- **The Guardian** minute-by-minute (Open Platform liveblog) — timed commentary,
  newest first, key moments flagged. Gated on `GUARDIAN_KEY`.
- **r/soccer** match-thread reactions — the most-upvoted comments from the live thread,
  sorted by score. These are **fan reactions/banter, not minute-by-minute**, and are
  labelled as such in the UI (brief §8 honesty). Gated on Reddit app credentials
  (`REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET`), read-only userless OAuth — no Reddit
  account, no posting. `worker/reddit.js` finds the thread (created-time vs kickoff +
  team-name matching, same approach as the Guardian liveblog discovery) and pulls the
  top comments; the token is cached in KV for the hour. Best-effort: Reddit can
  rate-limit datacenter IPs, so a missing thread is treated as normal, never an error,
  and never blocks the snapshot. Like the Guardian feed, it keeps pulling until just
  after full time (capturing the verdict reactions), then freezes.

Both feeds are inert until their keys are set, and the snapshot carries whichever is
available per match (`commentary*` / `redditCommentary*` — see `shared/types.ts`).

## Status / honesty notes (see brief §8)

- **No xG / xA anywhere.** Deliberate.
- **Annex C** (`web/data/annexC.json`) is **FIFA's real 495-combination allocation**,
  parsed from the official chart (transcribed in `scripts/data/annexc-source.wiki`,
  source: Wikipedia's "2026 FIFA World Cup third-place table" template, which
  reproduces Annex C verbatim) and **validated end-to-end** — every combination is
  checked against the real R32 candidate sets (matches 73–88) by `gen-annexc.js`
  and the test suite. Regenerate with `npm run gen:annexc`.
- Verdict bounds (Qualified/In/Sweating/Out/Eliminated) use a transparent
  best/worst-case method; the interactive scenario board's `resolve()` is exact for
  any concrete set of results. See `web/js/engine.js` header for the precise method
  and its documented approximations.
- The Worker's API-Football league id / season / team ids are marked `VERIFY` — they
  must be confirmed against the live API before deploying (brief §3, §7a).

## Deploy (no CLI — Cloudflare dashboard + Git)

One Worker serves everything: the static `/web` app (Static Assets) **and** the
`/data/latest.json` snapshot from KV. No separate Pages project, same origin, no CORS.
Verified live: league `1`, season `2026`, and all six club team ids are correct.

1. **KV namespace:** Storage & Databases → KV → Create `SNAPSHOT`. Its id is already in
   `wrangler.toml`.
2. **Create the Worker from this repo:** Workers & Pages → Create → Workers → Import a
   repository → pick this repo. Cloudflare reads `wrangler.toml`, builds, and redeploys
   on every push (Cron + KV binding + Static Assets included). Point the build's
   **production branch** at the branch you deploy from.
3. **Secret:** the Worker → Settings → Variables and Secrets → Add → Type `Secret`,
   name `APIFOOTBALL_KEY`. (Optional `FOOTBALLDATA_KEY` for the fallback.)
4. The Cron poller fills KV (baseline every 6h; ~75s while a fixture is live). The
   Worker URL then serves the app, which reads `/data/latest.json` from KV.

The `/web/data/latest.json` mock is shadowed in production (the Worker intercepts that
path and returns KV) but still powers local dev (`npm run dev:web`).
