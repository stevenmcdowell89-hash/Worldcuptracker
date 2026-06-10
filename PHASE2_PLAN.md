# Phase 2 — Build plan (Part B of the brief, §11–15)

Phase 1 (the Part A core, §1–10) is live in `main`: the Matches/Groups/News/Watch/More
IA, the client-side progression engine, the third-place Race (a Groups sub-tab), Annex C,
the bracket, the Watch club tracker, and the Worker poller.

Phase 2 is the **phase-evolution layer**: the tournament's focus shifts over time by
*adding* the right components inline onto the Matches feed, never removing a fixture
(§1a rule 1). Plus stakes tags and push notifications.

## The single new primitive: a `phase` flag

The Worker derives one flag, `meta.phase ∈ pre | group | groupFinal | knockout`, from the
snapshot. It is computed by a **pure, shared** function (`tournamentPhase()` in
`web/js/engine.js`) so the Worker, the mock generator, and the frontend agree, and so the
frontend can recompute it offline.

```
pre        … no group game has kicked off yet
group      … group stage under way, not every group on its last round
groupFinal … every group with games left has ≤2 remaining (the final-matchday window)
knockout   … no group fixtures remain (group stage complete)
```

Also written to `meta`: `spotsMoving` (count of `sweating` thirds — drives the flash copy).

## Work items

### 1. Phase flag + stakes (engine, pure & tested)  →  `web/js/engine.js`
- `tournamentPhase(snapshot)` — the rule above.
- `stakesFor(snapshot, fixtureId)` → `decider | seeding | dead` (§15): run the fixture's
  W/D/L through `resolve()` holding other remaining games at a draw, then diff.
  - **Decider** — either team's R32 qualification (top-2 *or* the third-place cut) changes
    across outcomes.
  - **Seeding** — both teams qualify in every outcome, but a team's final group position
    (1st↔2nd↔3rd) changes (the proxy for "final position / R32 opponent").
  - **Dead rubber** — nothing at stake.
  Exact when goal-margins are set; approximate on plain W/D/L — labelled accordingly.
- Worker writes `meta.phase`, `meta.spotsMoving`, and `stakes` onto each scheduled group
  match; the mock + `shared/types.ts` are updated to match. New unit tests in
  `web/js/engine.test.js` (pre/group/groupFinal/knockout; decider/seeding/dead).

### 2. Matches tab — phase embedding + `Matches | Race for R32` toggle (§11)  →  `web/js/screens.js`
- Top **underlined two-tab split** (same control as Groups, *not* a pill) appears once the
  race is relevant (`group`/`groupFinal`). Left "Matches" default; right "Race for R32"
  **flashes** when live (`groupFinal`: amber label, red live dot + LIVE badge, glowing
  underline). Routed as `#/matches?v=race` → renders the existing `raceContent()`; the feed
  keeps its inline race card too.
- Feed accretion (additive only):
  - `pre` — countdown hero + "N players from your clubs are at the World Cup" nudge above
    the opening fixtures.
  - `group` — fixture feed + embedded Race-for-R32 card (teaser → firming).
  - `groupFinal` — each group's **table interleaved beneath that group's final games** +
    a prominent cut-line race card + **stakes tags** on fixtures.
  - `knockout` — KO fixtures lead + the **bracket Path view embedded** inline.

### 3. Groups — phase-driven Race flash (§12)  →  `web/js/screens.js`, `web/styles.css`
- `group` → "Race for R32" sub-tab **dormant** (plain, optional "opens …" hint).
- `groupFinal` → **live**: amber label, red live dot + LIVE badge, glowing amber underline,
  thin amber flashbar under the tabs ("the cut line is live, N spots moving").
- `knockout` → a day or two of the same flash but **handing off to the Bracket** (a banner
  pointing at it); Tables remain as final standings.

### 4. Bracket — vertical Path + connected half views (§13)  →  `web/js/screens.js`, `web/styles.css`
Replace the flat round-tab list. Two sub-tabs, **both fully vertical, no horizontal scroll**:
- **Path** (default once `knockout`) — pick a team, see its route as a vertical spine
  R32→R16→QF→SF→Final; played rounds behind a green tick, current tie "you are here",
  future rounds dashed projections.
- **Bracket** (structural) — **Top half / Bottom half** toggle; ties connected with a `]`
  merge into the next-round slot (winners bold, losers greyed), read top-to-bottom.
- Keep QUALIFIED vs CURRENT third-place tagging until Annex C locks.

### 5. Notifications — web push PWA (§14)  →  new `web/sw.js`, `web/manifest.webmanifest`, Worker endpoints
- PWA install: `manifest.webmanifest` + a service worker handling `push`/`notificationclick`.
- Subscribe in More → settings; the push endpoint is the per-device key, stored in KV with
  that device's prefs (**no login/identity**, §14).
- Worker endpoints: `GET /push/vapidPublicKey`, `POST /push/subscribe`, `POST /push/unsubscribe`.
- Three toggles, quiet defaults: morning **results digest** (~8am UK), **today's matches**
  (~midday UK), **qualification moments** (verdict flips, waking hours, batched per group).
- Cron drives digests; qualification alerts reuse the engine's verdict-flip detection by
  diffing the previous snapshot's `thirdPlaceRace`/team verdicts against the new one.
- Web push from the Worker is implemented with Web Crypto (VAPID JWT + aes128gcm payload
  encryption). VAPID keys are Worker secrets. Built **last** — it depends on stable
  verdict-flip detection and the digest snapshots.

## Sequencing & safety
Each item is a self-contained commit on `claude/phase-2-planning-cjbgm4`, tests kept green
(`npm test`), mock regenerated (`npm run gen:mock`) so the whole thing is demoable offline.
Nothing removes a fixture or an existing surface — Phase 2 is strictly additive (§1a rule 1).
Notifications ship last and degrade gracefully (no VAPID keys ⇒ the settings simply hide).
