// WC26 Worker — Cron poller + normaliser → Workers KV (brief §2, §3).
//
// Responsibilities:
//   • On a Cron tick, decide (cheaply) whether to poll: 6h baseline, OR ~75s while a
//     fixture is in its live window. The live-gate is derived from kickoff times in
//     the last snapshot, so we never burn API calls overnight.
//   • Poll API-Football, normalise every response into ONE snapshot matching the
//     schema in /shared/types.ts, and write it to KV as `latest.json`.
//   • Fall back to football-data.org (fixtures/standings only) if API-Football errors.
//   • On total failure, keep serving the last good snapshot — never write a broken one.
//   • Serve GET /data/latest.json from KV (Pages can also proxy this).
//
// The shared engine pre-derives the third-place race & verdicts so the snapshot is
// engine-ready and the frontend renders instantly.

import { thirdPlaceTable, recompute, verdicts, compareGroupRows, qualifyOutlook, tournamentPhase, spotsMoving, stakesFor } from "../web/js/engine.js";
import { buildBracket } from "../web/js/bracket.js";
import ANNEXC from "../web/js/annexC.data.js";
import TVSEED from "../web/js/tvUK.data.js";
import { sendWebPush } from "./push.js";
import { mergeListings, annotateTv, fetchTvListings, ukTimeOf, TV_SOURCE_DEFAULT } from "./tv.js";

const API = "https://v3.football.api-sports.io";
const KV_KEY = "latest.json";
const META_KEY = "poll-meta";
const TEAMDIR_KEY = "team-dir";   // last-good team directory (codes/names/crests), reused when /teams hiccups
const STANDINGS_KEY = "standings-cache";   // last-good group tables, reused when /standings serves empty

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Subrequest budget. Cloudflare Workers cap subrequests per invocation (50 on the
// free plan, 1000 on paid). A full poll wants ~110 calls, so we count them and let
// the enrichment steps stop before the cap — squads/stats fill in over several polls
// (squads persist once fetched). Reset at the start of each buildSnapshot.
let SUBREQ = 0, SUBREQ_CAP = 45, RATE_LIMITED = false;
// Enrichment budget = per-invocation cap AND per-minute headroom. The second term is
// vital: enrichment bursts (team stats + deep player drill-ins) must never drain the
// per-minute allowance, or the NEXT poll's critical calls (standings/fixtures/live
// detail, which run first) get rate-limited — that blanked the group tables. Reserve
// MIN_RESERVE calls/min for those; enrichment only spends what's left above it.
const MIN_RESERVE = 40;
const budgetLeft = () => {
  if (RATE_LIMITED) return 0;
  const bySub = SUBREQ_CAP - SUBREQ;
  const byMin = RL.min != null ? RL.min - MIN_RESERVE : bySub;
  return Math.max(0, Math.min(bySub, byMin));
};
// Last-seen rate-limit headers (api-sports): per-minute + per-day. Drives throttling.
let RL = { min: null, minLimit: null, day: null, dayLimit: null };

// Run an async fn over items with bounded concurrency (keeps wall-clock low without
// firing all subrequests at once). Used for the heavy per-team / per-player loops.
async function pmap(items, fn, concurrency = 3) {
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]); }
  });
  await Promise.all(workers);
}

// ── tiny API client (rate-limit aware) ──
// API-Football returns HTTP 200 with {errors:{rateLimit:"..."}} when the per-minute
// cap is exceeded. We back off and retry a few times (the per-minute window resets
// each minute) so a burst of live calls degrades gracefully instead of throwing.
async function apiGet(env, path, params = {}, attempt = 0) {
  if (attempt === 0) SUBREQ++;
  // Self-throttle: if we're about to exhaust the per-minute allowance, wait for the
  // window to roll over. Keeps a full poll under the plan's per-minute cap.
  if (RL.min != null && RL.min <= 1) { await sleep(4000); RL.min = RL.minLimit ?? 5; }
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { "x-apisports-key": env.APIFOOTBALL_KEY } });
  // capture rate-limit headers (case-insensitive)
  const h = (k) => { const v = r.headers.get(k); return v == null ? null : Number(v); };
  const min = h("x-ratelimit-remaining"), minL = h("x-ratelimit-limit");
  const day = h("x-ratelimit-requests-remaining"), dayL = h("x-ratelimit-requests-limit");
  if (min != null) RL.min = min; if (minL != null) RL.minLimit = minL;
  if (day != null) RL.day = day; if (dayL != null) RL.dayLimit = dayL;
  if (!r.ok) {
    if (r.status === 429 && attempt < 3) { await sleep(6500); return apiGet(env, path, params, attempt + 1); }
    throw new Error(`API-Football ${path} → ${r.status}`);
  }
  const body = await r.json();
  if (body.errors && Object.keys(body.errors).length) {
    const msg = JSON.stringify(body.errors);
    if (/ratelimit/i.test(msg)) {
      const perMinute = /per minute|requests per minute/i.test(msg);
      // Per-minute: brief retry (the window resets each minute). If it still fails,
      // skip just THIS call — do NOT trip RATE_LIMITED, which would zero the whole
      // poll's enrichment budget for a limit that recovers within 60s (that quietly
      // starved deep enrichment, so re-enriched stats never landed). Only a per-day
      // limit is unrecoverable this run, so that one stops further enrichment.
      if (perMinute && attempt < 2) { await sleep(6000); return apiGet(env, path, params, attempt + 1); }
      if (!perMinute) RATE_LIMITED = true;
    }
    throw new Error(`API-Football ${path}: ${msg}`);
  }
  return body.response || [];
}

// VERIFY against the live API before deploying (brief §3, §7a).
const CFG = (env) => ({
  league: env.WC_LEAGUE_ID || "1",
  season: env.WC_SEASON || "2026",
  // six configured club team ids for Player Watch — VERIFY each id.
  clubs: {
    "manchester-united": { id: 33, name: "Manchester United" },
    liverpool: { id: 40, name: "Liverpool" },
    arsenal: { id: 42, name: "Arsenal" },
    tottenham: { id: 47, name: "Tottenham Hotspur" },
    "cardiff-city": { id: 43, name: "Cardiff City" },
    juventus: { id: 496, name: "Juventus" },
  },
});

// ── live-gate: is any fixture in its live window right now? ──
function inLiveWindow(snapshot) {
  if (!snapshot) return false;
  const now = Date.now();
  // Knockout matches (no group) can run to extra time + penalties — a normal match is
  // done by ~KO+120, but ET+pens pushes the whistle out to ~KO+180. Give knockouts a
  // longer tail so live polling (scores + commentary) doesn't drop out mid-ET.
  const items = [
    ...(snapshot.matches || []).map((m) => ({ ko: m.kickoff, knockout: !m.group })),
    ...(snapshot.remainingFixtures || []).map((f) => ({ ko: f.kickoff, knockout: false })),
  ].filter((x) => x.ko);
  return items.some(({ ko, knockout }) => {
    const t = new Date(ko).getTime();
    const tail = (knockout ? 240 : 140) * 60e3;   // min after KO; knockout covers ET+pens+wrap-up
    return now >= t - 5 * 60e3 && now <= t + tail;
  });
}

// ── normalisers (API-Football v3 shapes → snapshot schema) ──
// Standings/fixtures team objects carry only {id,name,logo} — no 3-letter code.
// /teams (league+season) DOES carry `code` + `logo`, so we build a directory and
// resolve everything through it.
async function buildTeamDir(env, base) {
  const byId = {}, crests = {};
  try {
    const teams = await apiGet(env, "/teams", base);
    for (const t of teams) {
      const tm = t.team; if (!tm?.id) continue;
      const code = tm.code || String(tm.id);
      byId[tm.id] = { code, name: tm.name, logo: tm.logo };
      if (tm.logo) crests[code] = tm.logo;
    }
  } catch { /* fall back to the cached directory below */ }
  // The team directory is the snapshot's identity layer (codes, names, crests).
  // It's effectively static, so persist it once built and reuse the last good copy
  // whenever /teams hiccups (rate-limit etc.). Without this, a single failed call
  // collapses EVERY team to a bare numeric id with no crest — grey squares + ids.
  if (Object.keys(byId).length) {
    try { await env.SNAPSHOT?.put(TEAMDIR_KEY, JSON.stringify({ byId, crests })); } catch {}
    return { byId, crests };
  }
  try {
    const cached = await env.SNAPSHOT?.get(TEAMDIR_KEY, "json");
    if (cached?.byId && Object.keys(cached.byId).length) return cached;
  } catch {}
  return { byId, crests };
}
const codeOf = (dir, id) => dir.byId[id]?.code || String(id);

function normStandings(resp, dir) {
  // resp[0].league.standings = [[row,...] per group] + a "Ranking of third-placed teams" block
  const groups = {};
  const table = resp?.[0]?.league?.standings || [];
  for (const groupRows of table) {
    // API-Football labels the block "Group A" OR "Group Stage - Group A" (the format
    // it switched to once the tournament was under way). Pull the trailing group letter
    // either way; non-group blocks ("Ranking of third-placed teams", "Group Stage") miss.
    const m = /group\s+([a-l])\s*$/i.exec(groupRows?.[0]?.group || "");
    if (!m) continue;
    const letter = m[1].toUpperCase();
    for (const r of groupRows) {
      const id = r.team?.id;
      const row = {
        code: codeOf(dir, id), name: r.team?.name, _id: id, logo: dir.byId[id]?.logo,
        P: r.all?.played ?? 0, W: r.all?.win ?? 0, D: r.all?.draw ?? 0, L: r.all?.lose ?? 0,
        GF: r.all?.goals?.for ?? 0, GA: r.all?.goals?.against ?? 0,
        GD: r.goalsDiff ?? 0, Pts: r.points ?? 0,
        yellow: 0, red: 0,   // filled from /teams/statistics (fair-play tiebreak)
      };
      row.GD = row.GF - row.GA;
      (groups[letter] = groups[letter] || []).push(row);
    }
  }
  return groups;
}

function normFixtures(resp, dir, idToGroup) {
  // The WC round is "Group Stage - N" (no letter), so the group comes from each
  // team's standings membership (idToGroup). Knockout fixtures have no group.
  const matches = [], remainingFixtures = [];
  for (const f of resp || []) {
    const st = f.fixture?.status?.short;
    const live = ["1H", "2H", "ET", "P", "LIVE", "BT"].includes(st);
    const ht = st === "HT";
    const done = ["FT", "AET", "PEN"].includes(st);
    const home = f.teams?.home, away = f.teams?.away;
    const groupLetter = idToGroup[home?.id] || idToGroup[away?.id];
    const isGroup = !!groupLetter;
    // Knockout placeholders can arrive with no teams assigned yet — keep them honest.
    const hc = home?.id ? codeOf(dir, home.id) : "TBD", ac = away?.id ? codeOf(dir, away.id) : "TBD";
    const base = {
      id: String(f.fixture?.id),
      stage: isGroup ? "Group Stage" : (f.league?.round || "Knockout"),
      group: groupLetter,
      venue: f.fixture?.venue?.name,
      kickoff: f.fixture?.date,
      home: { code: hc, score: f.goals?.home },
      away: { code: ac, score: f.goals?.away },
      _homeId: home?.id, _awayId: away?.id,   // internal: for event home/away mapping
    };
    // Penalty shootout: goals stay level after ET; the decider lives in score.penalty.
    const pen = f.score?.penalty;
    if (pen && pen.home != null && pen.away != null) base.pens = { h: pen.home, a: pen.away };
    if (!done && !live && !ht) {
      base.status = "scheduled";
      if (isGroup) remainingFixtures.push({
        id: base.id, group: groupLetter, home: hc, away: ac, kickoff: base.kickoff, affectsThird: true,
      });
      matches.push(base);
    } else {
      base.status = live ? "live" : ht ? "ht" : "ft";
      // Stoppage time: API-Football holds the clock at 45/90 in `elapsed` and carries
      // the added minutes in `extra` (e.g. elapsed 90, extra 3 → "90+3'").
      if (live || ht) {
        const el = f.fixture?.status?.elapsed, ex = f.fixture?.status?.extra;
        base.minute = st === "P" ? "Pens" : `${el ?? ""}${ex ? "+" + ex : ""}'`;
      }
      matches.push(base);
    }
  }
  return { matches, remainingFixtures };
}

function normEvents(resp, homeId) {
  return (resp || []).map((e) => ({
    min: `${e.time?.elapsed ?? ""}${e.time?.extra ? "+" + e.time.extra : ""}'`,
    side: e.team?.id === homeId ? "h" : "a",   // map to the correct side
    type: e.type === "Goal" ? (e.detail === "Penalty" ? "penalty" : e.detail === "Own Goal" ? "owngoal" : "goal")
      : e.type === "Card" ? (e.detail === "Red Card" ? "red" : "yellow") : e.type === "subst" ? "subst" : "goal",
    player: e.player?.name,
    assist: e.assist?.name || undefined,
    detail: e.detail,
  }));
}

function normStats(resp) {
  // resp = [{team, statistics:[{type,value}]}, {team, statistics:[...]}]
  if (!resp || resp.length < 2) return [];
  const KEEP = ["Ball Possession", "Total Shots", "Shots on Goal", "Passes accurate", "Total passes", "Corner Kicks", "Fouls", "Offsides"];
  const NAME = { "Ball Possession": "Possession", "Total Shots": "Shots", "Shots on Goal": "Shots on target", "Passes accurate": "Pass accuracy", "Total passes": "Passes", "Corner Kicks": "Corners" };
  const map = (t) => Object.fromEntries((t.statistics || []).map((s) => [s.type, s.value]));
  const h = map(resp[0]), a = map(resp[1]);
  const num = (v) => (typeof v === "string" ? parseInt(v) || 0 : v ?? null);
  return KEEP.filter((k) => h[k] != null || a[k] != null).map((k) => ({
    k: NAME[k] || k, h: num(h[k]), a: num(a[k]),
    unit: k.includes("Possession") || k.includes("accurate") ? "%" : undefined,
  }));
}

// ── Player Watch join: club squad × WC nation rosters (brief §7a) ──
async function buildClubWatch(env, cfg, teams, players, remainingFixtures, prevClubWatch = {}) {
  const wcPlayerIds = new Set();
  for (const code of Object.keys(teams)) (teams[code].squad || []).forEach((id) => wcPlayerIds.add(String(id)));
  const clubWatch = {};
  await pmap(Object.entries(cfg.clubs), async ([slug, club]) => {
    // Under a tight budget, keep the previous entry rather than dropping the club.
    if (budgetLeft() <= 1 && prevClubWatch[slug]) { clubWatch[slug] = prevClubWatch[slug]; return; }
    let squad = [];
    try {
      const resp = await apiGet(env, "/players/squads", { team: club.id });
      squad = resp?.[0]?.players || [];
    } catch { /* leave empty — handled cleanly downstream */ }
    const ps = squad.filter((p) => wcPlayerIds.has(String(p.id))).map((p) => {
      const meta = players[String(p.id)] || {};
      const nation = meta.code;
      const fx = remainingFixtures.find((f) => f.home === nation || f.away === nation);
      return {
        playerId: String(p.id), nation, pos: p.position || meta.pos || "", num: p.number,
        nextFixture: fx ? { opponent: fx.home === nation ? fx.away : fx.home, kickoff: fx.kickoff } : undefined,
        tournament: meta.tournament || { apps: 0, min: 0, g: 0, a: 0, yellow: 0, red: 0 },
        nationVerdict: teams[nation]?.verdict || "out",
      };
    });
    let nextAction;
    for (const p of ps) if (p.nextFixture && (!nextAction || p.nextFixture.kickoff < nextAction.kickoff))
      nextAction = { playerId: p.playerId, nation: p.nation, ...p.nextFixture };
    clubWatch[slug] = { name: club.name, players: ps, nextAction };
  }, 5);
  return clubWatch;
}

// ── orchestrate one full poll ──
// liveOnly = true → only the cheap live path (events/stats for in-play fixtures);
// reuses everything else from the previous snapshot. Heavy enrichment runs only on
// the baseline (full) poll, and finalised data is persisted so we fetch it once.
export async function buildSnapshot(env, prev, liveOnly) {
  const cfg = CFG(env);
  const base = { league: cfg.league, season: cfg.season };
  SUBREQ = 0; RATE_LIMITED = false;
  SUBREQ_CAP = parseInt(env.SUBREQUEST_BUDGET || "45", 10);   // < the plan's per-invocation cap

  // Team directory (id → code/name/logo) — standings/fixtures lack the 3-letter code.
  const dir = await buildTeamDir(env, base);

  // Standings + all fixtures (cheap, every poll).
  // API-Football intermittently serves an EMPTY standings table (notably while it
  // rebuilds after a result). The whole app keys off groups — tables, race, bracket
  // seeding and the fixture→group mapping (group letters live ONLY in standings) — so
  // never run on an empty table: cache the last good one in KV (with team _id, before
  // it's stripped for serialisation) and reuse it until the API serves a real table.
  let groups = {};
  try { groups = normStandings(await apiGet(env, "/standings", base), dir); } catch { /* rate-limited/empty → cache below */ }
  if (Object.keys(groups).length) {
    try { await env.SNAPSHOT?.put(STANDINGS_KEY, JSON.stringify(groups)); } catch {}
  } else {
    try { const c = await env.SNAPSHOT?.get(STANDINGS_KEY, "json"); if (c && Object.keys(c).length) groups = c; } catch {}
  }
  const idToGroup = {};
  for (const [g, rows] of Object.entries(groups)) rows.forEach((r) => (idToGroup[r._id] = g));
  const fixturesResp = await apiGet(env, "/fixtures", base);
  // A truncated/empty fixtures response (rate-limit hiccup) must never replace a real
  // schedule: phase, the morning view and the live-gate all key off these kickoffs,
  // and a degraded write flips the app's layout. Fail the poll → keep last good.
  if (!fixturesResp.length && prev?.matches?.length) throw new Error("fixtures returned empty with a schedule on record — keeping the last good snapshot");
  const { matches, remainingFixtures } = normFixtures(fixturesResp, dir, idToGroup);

  // Carry over finalised match detail (events/stats/lineups/ratings never change once
  // FT) so each finished match is fetched exactly once.
  const prevMatch = Object.fromEntries((prev?.matches || []).map((m) => [m.id, m]));
  for (const m of matches) {
    const p = prevMatch[m.id];
    if (!p) continue;
    // The Guardian feed is live-only, so once a match is over keep the commentary we
    // captured (it never changes again) — so you can look back at how the game unfolded.
    if (m.status === "ft" && p.commentary) {
      m.commentaryUrl = p.commentaryUrl; m.commentarySource = p.commentarySource;
      m._guardianId = p._guardianId; m._commentaryClosed = p._commentaryClosed; m._commentaryV = p._commentaryV;
      // Commentary is catch-up material; after 48h drop the blocks (they bloat every
      // snapshot) but keep the link so the UI can point at the Guardian liveblog.
      const aged = Date.now() - Date.parse(m.kickoff || "") > 48 * 3600e3;
      m.commentary = aged ? [] : p.commentary;
    }
    if (m.status === "ft" && p.lineups) {
      m.events = p.events; m.stats = p.stats; m.lineups = p.lineups; m.progressionLine = p.progressionLine; m._final = true;
    }
    // Highlights are sourced once and never change — freeze them (and carry the last-tried
    // stamp so the retry throttle survives across polls) so we don't keep re-searching.
    if (m.status === "ft") { if (p.highlights) m.highlights = p.highlights; if (p._hlTriedAt) m._hlTriedAt = p._hlTriedAt; }
  }
  // Fetch detail: live/HT every poll; newly-finished matches once (incl FT ratings).
  // Keep last-good per field: a single empty/rate-limited response must never blank a
  // live match's lineup (static once published) or wipe its events/stats (which only
  // accumulate) — that caused the lineup/facts to flicker out mid-match between polls.
  for (const m of matches.filter((x) => x.status === "live" || x.status === "ht" || (x.status === "ft" && !x._final))) {
    const p = prevMatch[m.id];
    try { const ev = normEvents(await apiGet(env, "/fixtures/events", { fixture: m.id }), m._homeId); m.events = ev.length ? ev : (p?.events || ev); } catch { m.events = p?.events; }
    try { const stt = normStats(await apiGet(env, "/fixtures/statistics", { fixture: m.id })); m.stats = stt.length ? stt : (p?.stats || stt); } catch { m.stats = p?.stats; }
    try {
      const lu = await apiGet(env, "/fixtures/lineups", { fixture: m.id });
      if (lu?.length) m.lineups = normLineups(lu, m._homeId, m._awayId);
    } catch {}
    if (!m.lineups && p?.lineups) m.lineups = p.lineups;   // lineups don't change mid-match
    if (m.status === "ft") {  // player ratings + per-match stats land at full time
      try { mergePlayerRatings(m, await apiGet(env, "/fixtures/players", { fixture: m.id })); } catch {}
    }
  }

  // Confirmed XIs publish ~1 hr before kickoff, while the match is still "scheduled"
  // (the loop above only covers live/finished games). Fetch lineups for any match whose
  // kickoff is within ~75 min so they show pre-match, and re-fetch each poll to pick up
  // late changes. Skips matches with no kickoff on record or still well in the future.
  const nowMs = Date.now();
  for (const m of matches.filter((x) => x.status === "scheduled")) {
    const koMs = m.kickoff ? new Date(m.kickoff).getTime() : 0;
    if (!koMs || koMs - nowMs > 75 * 60e3) continue;
    try {
      const lu = await apiGet(env, "/fixtures/lineups", { fixture: m.id });
      if (lu?.length) m.lineups = normLineups(lu, m._homeId, m._awayId);
    } catch {}
  }

  // Guardian minute-by-minute (best-effort, gated on a key). Live/HT every poll; and a
  // just-finished match keeps pulling until the liveblog actually closes, so the
  // full-time wrap-up / report is captured. Then it's frozen and never refetched.
  if (env.GUARDIAN_KEY) {
    const now = Date.now();
    for (const m of matches) {
      const liveish = m.status === "live" || m.status === "ht";
      const koMs = m.kickoff ? new Date(m.kickoff).getTime() : 0;
      // Re-fetch a just-finished match until the liveblog closes (12h) — plus a one-shot
      // backfill (within 72h) when its stored commentary predates the current fetch
      // version, to recover games frozen under the old truncated cap. Then frozen for good.
      const within = (h) => koMs && now <= koMs + h * 3600e3;
      const justFinished = m.status === "ft"
        && ((!m._commentaryClosed && within(12)) || (m._commentaryV !== COMMENTARY_V && within(48)));
      if (!liveish && !justFinished) continue;
      try {
        let gid = m._guardianId || prevMatch[m.id]?._guardianId;
        if (!gid) gid = await findLiveblogId(env, dir.byId[m._homeId]?.name, dir.byId[m._awayId]?.name, m.kickoff);
        if (!gid) continue;
        m._guardianId = gid;
        const com = await fetchCommentary(env, gid);
        if (com.blocks.length) { m.commentary = com.blocks; m.commentaryUrl = com.url; m.commentarySource = "The Guardian"; m._commentaryV = COMMENTARY_V; }
        // Liveblog no longer updating → the wrap-up is in; freeze it so we stop polling.
        if (m.status === "ft" && com.live === false) m._commentaryClosed = true;
      } catch { /* commentary is best-effort */ }
    }
  }

  // YouTube match highlights (best-effort, gated on a key). Finished matches only, on FULL
  // polls only — never the ~45s live ticks, which would burn the daily quota — fetched once
  // then frozen (carried over above). Official highlights post ~1–3h after full time, so
  // retry a just-finished match every ~45 min, within a 48h window, until the upload lands.
  // The DAILY round-up is sourced separately and time-gated to the morning window (the only
  // surface that shows it) — see the cron's scheduled() handler.
  if (env.YOUTUBE_API_KEY && !liveOnly) {
    const now = Date.now();
    for (const m of matches) {
      if (m.status !== "ft" || m.highlights) continue;
      const koMs = m.kickoff ? new Date(m.kickoff).getTime() : 0;
      if (koMs && now > koMs + 48 * 3600e3) continue;                 // gave up — the upload never appeared
      if (m._hlTriedAt && now - m._hlTriedAt < 45 * 60e3) continue;   // throttle retries between polls
      m._hlTriedAt = now;
      try {
        const hl = await findHighlights(env, dir.byId[m._homeId]?.name, dir.byId[m._awayId]?.name, m.kickoff);
        if (hl) { m.highlights = hl; delete m._hlTriedAt; }
      } catch { /* highlights are best-effort */ }
    }
  }

  // Has the tournament actually started? (any match played or in play)
  const anyPlayed = matches.some((m) => m.status === "ft" || m.status === "live" || m.status === "ht")
    || Object.values(groups).some((rows) => rows.some((r) => r.P > 0));

  // Baseline-only enrichment (reuse prev when liveOnly).
  let scorers = prev?.scorers || [], assists = prev?.assists || [], discipline = prev?.discipline || [];
  let teams = prev?.teams || {}, players = prev?.players || {}, clubWatch = prev?.clubWatch || {};
  if (!liveOnly) {
    try { scorers = (await apiGet(env, "/players/topscorers", base)).map((s) => normScorer(s, dir)); } catch {}
    try { assists = (await apiGet(env, "/players/topassists", base)).map((s) => normAssist(s, dir)); } catch {}
    try {
      const [y, r] = await Promise.all([
        apiGet(env, "/players/topyellowcards", base).catch(() => []),
        apiGet(env, "/players/topredcards", base).catch(() => []),
      ]);
      discipline = normDiscipline(y, r, dir);
    } catch {}
    ({ teams, players } = buildTeamsAndPlayers(groups, prev));
    // Priority order under the subrequest budget: squads (Watch + team rosters) first
    // — they persist once fetched — then team aggregates, then deep player drill-in.
    try { await ensureNationSquads(env, base, teams, players); } catch {}
    if (anyPlayed) { try { await enrichTeamStats(env, base, teams, groups); } catch {} }   // skip pre-tournament (all zeros)
    // Deep drill-in is ~4 API calls per player. While a match is in play, shrink the
    // batch so the burst can't trip the per-minute limit and starve the live calls
    // (events/stats/lineups) — seen on opening day when an ENRICH_VERSION bump queued
    // every Watch player for re-enrichment mid-match. Full speed between games.
    const liveNow = matches.some((m) => m.status === "live" || m.status === "ht");
    try { await enrichPlayers(env, base, curatedPlayerIds({ scorers, assists, discipline, prev, matches }), players, cfg, dir, liveNow ? 4 : undefined); } catch {}
  }

  // Sort groups with the full rules (now card-aware) so positions + third place are exact.
  for (const g of Object.keys(groups)) groups[g].sort(compareGroupRows);

  // Engine pre-derivation.
  const race = verdicts({ groups, remainingFixtures, teams });
  applyTeamVerdicts(teams, groups, race);
  annotateProgression(matches, groups, remainingFixtures, teams, race, anyPlayed);

  if (!liveOnly) {
    try { clubWatch = await buildClubWatch(env, cfg, teams, players, remainingFixtures, prev?.clubWatch || {}); } catch {}
  }
  let news = prev?.news || [];
  if (!liveOnly) { try { news = await fetchNews(env); } catch {} }   // BBC RSS — refreshed on full polls + the news cadence

  // UK TV channels ("where to watch"): static seed + the daily live overlay from KV
  // (written by the cron's background check). Conservative matching — never a guess.
  let tvLive = null;
  try { tvLive = env.SNAPSHOT ? await env.SNAPSHOT.get("tv-listings", "json") : null; } catch {}
  // The morning catch-up's daily round-up video is sourced by the cron during the morning
  // window (see scheduled()) and stashed in KV — read it back here like the TV listings.
  let dayHighlights = prev?.dayHighlights || null;
  try { if (env.SNAPSHOT) { const dh = await env.SNAPSHOT.get("day-highlights", "json"); if (dh) dayHighlights = dh; } } catch {}
  const tvInfo = annotateTv(matches, teams, {
    listings: mergeListings(TVSEED.listings, tvLive?.listings || []),
    byFixture: TVSEED.byFixture, bySlot: TVSEED.bySlot,
  });

  for (const m of matches) { delete m._homeId; delete m._awayId; delete m._final; }  // strip internals
  for (const g of Object.keys(groups)) groups[g].forEach((r) => delete r._id);
  for (const t of Object.values(teams)) delete t._id;

  const groupStageComplete = remainingFixtures.length === 0;
  let bracket = prev?.bracket || buildBracket(groups, ANNEXC, { groupStageComplete: false });
  try { bracket = buildBracket(groups, ANNEXC, { groupStageComplete }); } catch {}

  const squadCount = Object.values(teams).reduce((n, t) => n + (t.squad?.length || 0), 0);
  const engineSnap = { groups, remainingFixtures, teams };
  // Phase is time-based off the real fixture schedule (matches carry the kickoffs).
  const phase = tournamentPhase({ ...engineSnap, matches });  // pre | group | groupFinal | knockout (§11)
  const moving = anyPlayed ? spotsMoving(engineSnap) : 0;    // sweating thirds — drives the §12 flash copy
  return {
    meta: { stage: matches.some((m) => m.status === "live") ? "Group Stage" : (prev?.meta?.stage || "Group Stage"),
            updated: new Date().toISOString(), groupStageComplete, dataSource: "api-football",
            started: anyPlayed,   // false ⇒ tournament not under way; suppress definitive narratives
            phase, spotsMoving: moving,
            tv: { mapped: tvInfo.mapped, checked: tvLive?.at || null },   // channel-map health
            squadCount },   // 0 ⇒ nation squads not published yet (pre-tournament), not a bug
    groups,
    thirdPlaceRace: race,
    remainingFixtures,
    matches,
    bracket,
    scorers, assists, discipline,
    teams, players, clubWatch, news,
    crests: dir.crests,           // code -> official crest/flag image URL
    dayHighlights,                // the day's official round-up video (morning catch-up); null until sourced
  };
}

function normScorer(s, dir) {
  const st = s.statistics?.[0];
  return { playerId: s.player?.id, code: codeOf(dir, st?.team?.id), name: s.player?.name, team: st?.team?.name, g: st?.goals?.total ?? 0, a: st?.goals?.assists ?? 0 };
}
function normAssist(s, dir) {
  const st = s.statistics?.[0];
  return { playerId: s.player?.id, code: codeOf(dir, st?.team?.id), name: s.player?.name, team: st?.team?.name, a: st?.goals?.assists ?? 0, g: st?.goals?.total ?? 0 };
}
function normLineups(resp, homeId, awayId) {
  const side = (L) => L && ({
    formation: L.formation, coach: L.coach?.name,
    xi: (L.startXI || []).map((p) => ({ num: p.player?.number, name: p.player?.name, pos: p.player?.pos, grid: p.player?.grid, playerId: p.player?.id })),
    subs: (L.substitutes || []).map((p) => ({ num: p.player?.number, name: p.player?.name, pos: p.player?.pos, playerId: p.player?.id })),
  });
  // map by team id rather than assuming array order
  const h = (resp || []).find((L) => L.team?.id === homeId) || resp?.[0];
  const a = (resp || []).find((L) => L.team?.id === awayId) || resp?.[1];
  return { h: side(h), a: side(a) };
}
// Per-team discipline from the top-yellow / top-red leaderboards (for the Stats tab).
function normDiscipline(yellowResp, redResp, dir) {
  const byTeam = {};
  const bump = (st, field) => {
    const t = st?.team; if (!t) return;
    const code = codeOf(dir, t.id);
    const row = (byTeam[code] = byTeam[code] || { code, team: t.name, y: 0, r: 0 });
    row[field] += st?.cards?.[field === "y" ? "yellow" : "red"] ?? 0;
  };
  (yellowResp || []).forEach((p) => bump(p.statistics?.[0], "y"));
  (redResp || []).forEach((p) => bump(p.statistics?.[0], "r"));
  return Object.values(byTeam).sort((a, b) => b.y + b.r * 3 - (a.y + a.r * 3));
}
function buildTeamsAndPlayers(groups, prev) {
  const teams = {}, players = prev?.players || {};
  for (const [g, rows] of Object.entries(groups)) {
    rows.forEach((r) => {
      const p = prev?.teams?.[r.code];
      teams[r.code] = {
        code: r.code, name: r.name, _id: r._id, group: g, P: r.P, W: r.W, D: r.D, L: r.L, GF: r.GF, GA: r.GA,
        coach: p?.coach || "—", possession: p?.possession, cleanSheets: p?.cleanSheets,
        form: p?.form || [], squad: p?.squad || [], verdict: p?.verdict,
      };
    });
  }
  return { teams, players };
}

// ── FT player ratings → merge into that match's lineup (brief §8: ratings at FT) ──
function mergePlayerRatings(m, resp) {
  if (!m.lineups || !resp?.length) return;
  const ratingById = {};
  for (const team of resp) for (const p of team.players || []) {
    const st = p.statistics?.[0];
    if (p.player?.id != null && st?.games?.rating != null) ratingById[p.player.id] = parseFloat(st.games.rating);
  }
  for (const sideKey of ["h", "a"]) {
    const L = m.lineups[sideKey]; if (!L) continue;
    [...(L.xi || []), ...(L.subs || [])].forEach((pl) => {
      if (pl.playerId != null && ratingById[pl.playerId] != null) pl.rating = ratingById[pl.playerId];
    });
  }
}

// ── /teams/statistics per nation → aggregates + fair-play cards on group rows ──
function sumCardBuckets(obj) {
  return Object.values(obj || {}).reduce((s, b) => s + (b?.total || 0), 0);
}
async function enrichTeamStats(env, base, teams, groups) {
  const rowByCode = {};
  for (const rows of Object.values(groups)) for (const r of rows) rowByCode[r.code] = r;
  const todo = Object.values(teams).filter((t) => t._id).slice(0, Math.max(0, budgetLeft() - 2));
  await pmap(todo, async (t) => {
    try {
      const s = await apiGet(env, "/teams/statistics", { ...base, team: t._id });
      const st = Array.isArray(s) ? s[0] : s;     // /teams/statistics returns an object
      if (!st) return;
      const y = sumCardBuckets(st.cards?.yellow), r = sumCardBuckets(st.cards?.red);
      t.cleanSheets = st.clean_sheet?.total ?? t.cleanSheets;
      t.formStr = st.form || t.formStr;
      if (rowByCode[t.code]) { rowByCode[t.code].yellow = y; rowByCode[t.code].red = r; }
    } catch { /* leave defaults */ }
  });
}

// ── nation squads (fetched once, then persisted) → teams[].squad + clubWatch join ──
async function ensureNationSquads(env, base, teams, players) {
  const todo = Object.values(teams)
    .filter((t) => t._id && !(t.squad && t.squad.length))   // missing squads only (persisted)
    .slice(0, Math.max(0, budgetLeft() - 2));
  await pmap(todo, async (t) => {
    try {
      const resp = await apiGet(env, "/players/squads", { team: t._id });
      const squad = resp?.[0]?.players || [];
      t.squad = squad.map((p) => p.id);
      // seed a light player record so Player Watch + pages have a name even before deep enrichment
      for (const p of squad) {
        const id = String(p.id);
        players[id] = players[id] || {
          name: p.name, code: t.code, pos: p.position || "", num: p.number,
          tournament: { apps: 0, min: 0, g: 0, a: 0, shots: 0, keyPasses: 0, yellow: 0, red: 0 },
          season: [], career: [], honours: [],
        };
        if (!players[id].code) players[id].code = t.code;
      }
    } catch { /* nation squad not published yet — fine */ }
  });
}

// Which players are worth a deep drill-in? Leaderboards + Player-Watch + recent XIs.
function curatedPlayerIds({ scorers, assists, discipline, prev, matches }) {
  const ids = new Set();
  (scorers || []).forEach((s) => s.playerId && ids.add(String(s.playerId)));
  (assists || []).forEach((s) => s.playerId && ids.add(String(s.playerId)));
  for (const club of Object.values(prev?.clubWatch || {})) for (const p of club.players || []) ids.add(String(p.playerId));
  for (const m of matches || []) for (const sideKey of ["h", "a"]) {
    const L = m.lineups?.[sideKey];
    (L?.xi || []).forEach((p) => p.playerId && ids.add(String(p.playerId)));
  }
  return ids;
}

// ── deep player drill-in: club-season stats + transfers + trophies ──
// Bump ENRICH_VERSION to force re-enrichment of already-flagged players after a fix.
const ENRICH_VERSION = 4;
const ZERO_TOURNAMENT = { apps: 0, min: 0, g: 0, a: 0, shots: 0, keyPasses: 0, yellow: 0, red: 0 };
async function enrichPlayers(env, base, ids, players, cfg, dir, cap = 18) {   // small batch/poll; fills over polls
  // European club seasons (2025-26) are filed under the START year (2025) in the API,
  // so club stats live under (WC season - 1), NOT the WC season.
  const clubSeason = String(Number(env.CLUB_SEASON || base.season) - (env.CLUB_SEASON ? 0 : 1));
  const todo = [...ids].filter((id) => players[id]?._enriched !== ENRICH_VERSION)
    .slice(0, Math.min(cap, Math.floor(Math.max(0, budgetLeft() - 6) / 3)));   // ~3 subrequests each
  await pmap(todo, async (id) => {
    const existing = players[id];
    try {
      const wc = normPlayer(await apiGet(env, "/players", { id, season: base.season }), cfg.league, dir) || {};   // WC tournament stats
      const club = normPlayerClub(await apiGet(env, "/players", { id, season: clubSeason })) || {};               // club-season stats + bio
      let career = existing?.career || [], honours = existing?.honours || [];
      try {
        const tr = await apiGet(env, "/transfers", { player: id });
        const list = tr?.[0]?.transfers || [];
        career = list.map((x) => ({ from: x.teams?.out?.name, to: x.teams?.in?.name, year: new Date(x.date).getFullYear() })).filter((c) => c.to);
      } catch {}
      try {
        const tro = await apiGet(env, "/trophies", { player: id });
        honours = (tro || []).filter((x) => /winner/i.test(x.place || "")).map((x) => ({ title: x.league, year: x.season }));
      } catch {}
      const rec = {
        name: club.name || wc.name || existing?.name,
        age: club.age ?? wc.age, pos: club.pos || wc.pos || existing?.pos,
        club: club.club, league: club.league,
        code: wc.code || existing?.code,                       // nation, from squad seed / WC entry
        // WC aggregate (0 until the player's nation has played). When the API has no
        // WC row yet, normPlayer returns null → zero it; never carry a previous value
        // forward, or pre-fix club numbers that leaked into `tournament` would persist.
        tournament: wc.tournament || ZERO_TOURNAMENT,
        season: club.season || [],
      };
      players[id] = { ...(existing || {}), ...rec, career, honours, _enriched: ENRICH_VERSION };
    } catch { /* skip this player this round */ }
  });
}
// Build bio + per-competition club-season stats from a /players?season=<club season>.
function normPlayerClub(resp) {
  const p = resp?.[0]; if (!p) return null;
  const stats = (p.statistics || []).filter((s) => s.league?.name);
  const main = stats.slice().sort((a, b) => (b.games?.appearences || 0) - (a.games?.appearences || 0))[0] || {};
  return {
    name: p.player?.name, age: p.player?.age, pos: main.games?.position || p.player?.position,
    club: main.team?.name, league: main.league?.name,
    season: stats.map((s) => ({
      comp: s.league?.name, apps: s.games?.appearences ?? 0, g: s.goals?.total ?? 0, a: s.goals?.assists ?? 0,
      yellow: s.cards?.yellow ?? 0, red: s.cards?.red ?? 0, min: s.games?.minutes ?? 0,
      rating: s.games?.rating ? parseFloat(s.games.rating) : undefined,
    })),
  };
}
export function normPlayer(resp, leagueId, dir) {
  const p = resp?.[0]; if (!p) return null;
  const stats = p.statistics || [];
  // Tournament stats come ONLY from the World Cup league entry. Before kickoff (or
  // any time a player has no WC competition row yet) there is no such entry — leave
  // the tournament block empty so it reads 0, rather than falling back to stats[0],
  // which is a club competition and would leak club apps/goals into "tournament".
  const wc = stats.find((s) => String(s.league?.id) === String(leagueId)) || {};
  const club = stats.find((s) => String(s.league?.id) !== String(leagueId));
  const season = stats.filter((s) => String(s.league?.id) !== String(leagueId)).map((s) => ({
    comp: s.league?.name, apps: s.games?.appearences ?? 0, g: s.goals?.total ?? 0, a: s.goals?.assists ?? 0,
    yellow: s.cards?.yellow ?? 0, red: s.cards?.red ?? 0, min: s.games?.minutes ?? 0, rating: s.games?.rating ? parseFloat(s.games.rating) : undefined,
  }));
  return {
    name: p.player?.name, code: wc.team?.id ? codeOf(dir, wc.team.id) : "", pos: wc.games?.position || p.player?.position,
    age: p.player?.age, club: club?.team?.name, league: club?.league?.name,
    tournament: {
      apps: wc.games?.appearences ?? 0, min: wc.games?.minutes ?? 0, g: wc.goals?.total ?? 0, a: wc.goals?.assists ?? 0,
      shots: wc.shots?.total ?? 0, keyPasses: wc.passes?.key ?? 0, yellow: wc.cards?.yellow ?? 0, red: wc.cards?.red ?? 0,
      rating: wc.games?.rating ? parseFloat(wc.games.rating) : undefined,
    },
    season,
  };
}

// ── verdict chips: 3rd-place contenders from the engine; top-2 / 4th by position ──
function applyTeamVerdicts(teams, groups, race) {
  const byCode = Object.fromEntries(race.map((t) => [t.code, t.status]));
  for (const [g, rows] of Object.entries(groups)) {
    rows.forEach((r, i) => {
      const t = teams[r.code]; if (!t) return;
      t.rank = i + 1;
      t.verdict = byCode[r.code] || (i <= 1 ? "in" : "out");
    });
  }
}

// ── woven-in progression: flag a group match only when it can actually decide a
// team's qualification, and only once the tournament is under way. The one-liner uses
// the full qualification outlook (top-two OR third place), not just the third-place race. ──
function annotateProgression(matches, groups, remainingFixtures, teams, race, anyPlayed) {
  // meta.started lets the engine's played===0 narratives distinguish "live but no
  // results yet" from genuinely pre-tournament — without it the opening match's
  // one-liner reads "the group stage hasn't kicked off" while the game is in play.
  const engineSnap = { groups, remainingFixtures, teams, meta: { started: anyPlayed } };
  const outlookCache = {};
  const outlook = (code) => (outlookCache[code] = outlookCache[code] || qualifyOutlook(engineSnap, code, ANNEXC));
  // A match can only "decide" qualification once there are RESULTS to build on. Before
  // the first group result every team reads "sweating", which would stamp the cut
  // marker on every game and print a one-sided "all to play for" line for the home
  // side. Gate the progression intel on real results, not merely a match being live.
  const anyResults = Object.values(groups).some((rows) => rows.some((r) => (r.P || 0) > 0));
  for (const m of matches) {
    m.affectsCut = false;
    if (!anyResults || m.stage !== "Group Stage" || m.status === "ft") continue;
    const codes = [m.home.code, m.away.code];
    // "On the line" = a side's place is genuinely undecided (not already through/out).
    const live = codes.map(outlook).filter((o) => o.status === "sweating" || o.status === "in" || o.status === "out");
    m.affectsCut = live.length > 0;
    if (m.affectsCut && (m.status === "live" || m.status === "ht")) {
      const focus = codes.find((c) => outlook(c).status === "sweating") || codes[0];
      m.progressionLine = outlook(focus).line;
    }
    // Stakes tag (brief §15) — only meaningful for an upcoming group fixture.
    if (m.status === "scheduled" && m.stage === "Group Stage") {
      try { m.stakes = stakesFor(engineSnap, m.id); } catch { m.stakes = null; }
    }
  }
}

// ── news: BBC Sport World Cup RSS → headlines in the snapshot (no API quota cost) ──
function parseNews(xml) {
  const items = [];
  const pick = (block, tag) => {
    const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(block);
    return r ? r[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").trim() : "";
  };
  const re = /<item>([\s\S]*?)<\/item>/g; let m;
  while ((m = re.exec(xml)) && items.length < 24) {
    const b = m[1];
    const img = (/<media:thumbnail[^>]*url="([^"]+)"/.exec(b) || [])[1] || null;
    const title = pick(b, "title");
    if (title) items.push({ title, summary: pick(b, "description"), link: pick(b, "link"), published: pick(b, "pubDate"), image: img, source: "BBC Sport" });
  }
  return items;
}
async function fetchNews(env) {
  const url = env.NEWS_RSS || "https://feeds.bbci.co.uk/sport/football/world-cup/rss.xml";
  const r = await fetch(url, { headers: { "user-agent": "wc26-tracker/1.0", accept: "application/rss+xml,text/xml" } });
  if (!r.ok) throw new Error(`news ${r.status}`);
  return parseNews(await r.text());
}

// ── live commentary: Guardian Open Platform MBM liveblog → timestamped blocks ──
// Free tier (text + metadata), separate from the API-Football quota. Gated on
// GUARDIAN_KEY; attribution + link back are required and surfaced in the UI.
const GUARDIAN = "https://content.guardianapis.com";
const COMMENTARY_V = 2;   // bump to force one re-fetch of frozen commentary after a fetch change
const stripHtml = (s) => (s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
async function guardianGet(env, path, params = {}) {
  const url = new URL(GUARDIAN + path);
  url.searchParams.set("api-key", env.GUARDIAN_KEY);
  url.searchParams.set("format", "json");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Guardian ${path} ${r.status}`);
  return (await r.json()).response || {};
}
// Find the minute-by-minute liveblog for a fixture. Primary signal is PUBLICATION
// TIME vs kickoff (WC kickoffs are mostly staggered, and a match's MBM publishes
// around kickoff); team-name + "live now" only disambiguate the few concurrent slots.
async function findLiveblogId(env, home, away, kickoffIso) {
  const koMs = Date.parse(kickoffIso || "");
  const day = (d) => new Date(d).toISOString().slice(0, 10);
  const fromDay = isNaN(koMs) ? undefined : day(koMs - 864e5);   // ±1 day window
  const toDay = isNaN(koMs) ? undefined : day(koMs + 864e5);
  const params = { tag: "tone/minutebyminute", section: "football", "order-by": "newest", "page-size": "40", "show-fields": "liveBloggingNow" };
  if (fromDay) { params["from-date"] = fromDay; params["to-date"] = toDay; }
  const res = await guardianGet(env, "/search", params);
  const results = (res.results || []).filter((r) => r.type === "liveblog");
  if (!results.length) return null;

  const lower = (s) => (s || "").toLowerCase();
  const tokens = [home, away].filter(Boolean).map((n) => lower(n).split(/\s+/).pop()).filter((t) => t.length > 2);
  const nameHit = (title) => tokens.some((t) => lower(title).includes(t));

  let best = null, bestScore = Infinity;
  for (const r of results) {
    const pub = Date.parse(r.webPublicationDate || "");
    let score = (isNaN(pub) || isNaN(koMs)) ? 6 * 36e5 : Math.abs(pub - koMs);   // closeness to kickoff
    if (nameHit(r.webTitle)) score -= 3 * 36e5;                                   // strong: a team name appears
    if (r.fields?.liveBloggingNow === "true") score -= 1 * 36e5;                  // mild: still live
    if (score < bestScore) { bestScore = score; best = r; }
  }
  // accept only a confident match: within ~4h of kickoff, or a name matched outright
  return best && (bestScore < 4 * 36e5 || nameHit(best.webTitle)) ? best.id : null;
}
// Pull the timestamped commentary blocks for a liveblog id. 200 covers a full match
// (incl. extra time + pre-match build-up); "latest:30" only reached back ~35 minutes,
// which truncated the feed mid-match.
async function fetchCommentary(env, id) {
  const SEL = "body:latest:200";
  const res = await guardianGet(env, "/" + id, { "show-blocks": SEL, "show-fields": "liveBloggingNow" });
  const c = res.content || {};
  // Qualified selectors ("body:latest:N") come back under blocks.requestedBodyBlocks
  // keyed by the selector — blocks.body is only populated for plain "body".
  const raw = c.blocks?.requestedBodyBlocks?.[SEL] || c.blocks?.body || [];
  const blocks = raw.map((b) => ({
    at: b.firstPublishedDate || b.publishedDate || b.createdDate || "",
    title: (b.title || "").trim(),
    text: b.bodyTextSummary || stripHtml(b.bodyHtml),
    key: !!(b.attributes && b.attributes.keyEvent),
  })).filter((b) => b.text);
  blocks.sort((a, b) => (b.at || "").localeCompare(a.at || ""));
  return { url: c.webUrl || null, live: c.fields?.liveBloggingNow === "true", blocks };
}

// ── highlights: official match + daily round-up videos (YouTube Data API v3) ──
// Best-effort, gated on YOUTUBE_API_KEY. Free quota (10k units/day; search.list = 100
// units ⇒ ~100 searches/day, far more than a match day needs) and separate from the
// API-Football budget. We never trust a raw search hit: a result must read as a
// highlights video that names BOTH teams and was published after kickoff, and we boost
// FIFA + the broadcasters YouTube named as 2026 media partners — so we surface the
// official upload, not a fan re-cut. Frozen once captured (carried over per poll).
const YOUTUBE = "https://www.googleapis.com/youtube/v3";
const HIGHLIGHTS_V = 1;   // bump to force one re-fetch of frozen highlights after a change
// Match channelTitle case-insensitively — robust to YouTube channel-id churn (a
// hardcoded UC… id silently rots), and the official partners all brand their channel.
const HL_OFFICIAL = ["fifa", "bbc sport", "fox soccer", "fox sports", "telemundo", "tudn", "tsn", "espn", "sbs", "optus sport", "dazn"];
const ytOfficial = (channelTitle) => { const c = (channelTitle || "").toLowerCase(); return HL_OFFICIAL.some((o) => c.includes(o)); };

async function youtubeSearch(env, q, params = {}) {
  const url = new URL(YOUTUBE + "/search");
  url.searchParams.set("key", env.YOUTUBE_API_KEY);
  url.searchParams.set("part", "snippet");
  url.searchParams.set("type", "video");
  url.searchParams.set("videoEmbeddable", "true");   // only videos we can actually embed
  url.searchParams.set("maxResults", "10");
  url.searchParams.set("q", q);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`YouTube /search ${r.status}`);
  return (await r.json()).items || [];
}

// Score a result set and return the best official MATCH highlight (or null). Pure, so
// the scoring is unit-tested (scripts/worker.test.js) without touching the network.
export function pickHighlight(items, home, away, koMs) {
  const lower = (s) => (s || "").toLowerCase();
  const tok = (n) => lower(n).split(/\s+/).pop();   // last word of a team name (e.g. "South Korea" → "korea")
  const ht = tok(home), at = tok(away);
  let best = null, bestScore = -Infinity;
  for (const it of items || []) {
    const title = lower(it.snippet?.title);
    if (!/highlight/.test(title)) continue;                          // must be a highlights video
    if (!(ht.length > 2 && title.includes(ht)) || !(at.length > 2 && title.includes(at))) continue;  // names BOTH teams
    const pub = Date.parse(it.snippet?.publishedAt || "");
    if (!isNaN(pub) && !isNaN(koMs) && pub < koMs) continue;         // pre-kickoff ⇒ a previous edition
    let score = 0;
    if (ytOfficial(it.snippet?.channelTitle)) score += 5;           // official / broadcast partner
    if (!isNaN(pub) && !isNaN(koMs)) score += Math.max(0, 3 - (pub - koMs) / (24 * 3600e3));  // sooner after KO scores higher
    if (score > bestScore) { bestScore = score; best = it; }
  }
  return best ? { id: best.id?.videoId, title: best.snippet?.title, channel: best.snippet?.channelTitle } : null;
}

async function findHighlights(env, home, away, kickoffIso) {
  if (!home || !away) return null;
  const koMs = Date.parse(kickoffIso || "");
  const items = await youtubeSearch(env, `${home} vs ${away} highlights World Cup 2026`, {
    order: "relevance", ...(isNaN(koMs) ? {} : { publishedAfter: new Date(koMs).toISOString() }),
  });
  const hit = pickHighlight(items, home, away, koMs);
  return hit && hit.id ? { ...hit, source: "youtube", v: HIGHLIGHTS_V } : null;
}

// The day's official round-up (one per match day, for the morning catch-up) — stricter
// than a match search: an official channel AND a round-up signal in the title, so we
// never mistake a single tie's highlights for the whole day.
async function findDayHighlights(env, dateIso) {
  const koMs = Date.parse(dateIso);
  const after = isNaN(koMs) ? undefined : new Date(koMs - 6 * 3600e3).toISOString();
  const items = await youtubeSearch(env, "FIFA World Cup 2026 matchday highlights all the goals", {
    order: "date", ...(after ? { publishedAfter: after } : {}),
  });
  const roundup = /(match\s?day|round[\s-]?up|all the goals|every goal|today at the|recap|day \d)/i;
  for (const it of items) {
    const title = it.snippet?.title || "";
    if (!ytOfficial(it.snippet?.channelTitle)) continue;
    if (!/highlight|goals|recap/i.test(title) || !roundup.test(title)) continue;
    return { id: it.id?.videoId, title, channel: it.snippet?.channelTitle, date: dateIso, source: "youtube", v: HIGHLIGHTS_V };
  }
  return null;
}

// ── football-data.org fallback (fixtures/standings only — resilience, never primary) ──
async function fallbackSnapshot(env, prev) {
  if (!env.FOOTBALLDATA_KEY) return null;
  try {
    const r = await fetch("https://api.football-data.org/v4/competitions/WC/standings", {
      headers: { "X-Auth-Token": env.FOOTBALLDATA_KEY },
    });
    if (!r.ok) return null;
    // Minimal: keep prev structure, just refresh meta + standings if we can map them.
    return { ...(prev || {}), meta: { ...(prev?.meta || {}), updated: new Date().toISOString(), dataSource: "football-data", stale: true } };
  } catch { return null; }
}

async function readSnapshot(env) { return (await env.SNAPSHOT.get(KV_KEY, "json")) || null; }
async function writeSnapshot(env, snap) { await env.SNAPSHOT.put(KV_KEY, JSON.stringify(snap)); }

// Background full poll (used by /admin/refresh). Writes the snapshot + a small
// "refresh-status" summary so the next request can report what happened.
// Background full poll. Returns a summary AND writes it to "refresh-status". Holds a
// short lock so concurrent triggers don't stack and blow the API per-minute limit.
async function runRefresh(env) {
  const lock = await env.SNAPSHOT.get("refresh-lock");
  if (lock && Date.now() - +lock < 120000) return { busy: true, note: "A refresh is already running — try again in ~30s." };
  await env.SNAPSHOT.put("refresh-lock", String(Date.now()), { expirationTtl: 120 });
  try {
    const snap = await buildSnapshot(env, await readSnapshot(env), false);
    await writeSnapshot(env, snap);
    const meta = (await env.SNAPSHOT.get(META_KEY, "json")) || {};
    await env.SNAPSHOT.put(META_KEY, JSON.stringify({ ...meta, lastFull: Date.now(), lastLive: Date.now() }));
    const clubWatch = Object.fromEntries(Object.entries(snap.clubWatch || {}).map(([k, c]) => [k, c.players.length]));
    const summary = {
      ok: true, finished: new Date().toISOString(), groups: Object.keys(snap.groups).length,
      matches: snap.matches.length, remaining: snap.remainingFixtures.length,
      squadCount: snap.meta.squadCount, players: Object.keys(snap.players || {}).length,
      subrequests: SUBREQ, budget: SUBREQ_CAP, clubWatch,
    };
    await env.SNAPSHOT.put("refresh-status", JSON.stringify(summary));
    return summary;
  } catch (e) {
    const err = { ok: false, finished: new Date().toISOString(), error: e.message, subrequests: SUBREQ };
    await env.SNAPSHOT.put("refresh-status", JSON.stringify(err));
    return err;
  } finally {
    await env.SNAPSHOT.delete("refresh-lock");
  }
}

// ── notifications (brief §14) ────────────────────────────────────────────────────
// Web push via the PWA. The push endpoint is the per-device key — no login/identity.
// Subscriptions live in KV under "push:<hash>" with that device's prefs. The whole
// feature is inert unless VAPID keys are configured.
const PUSH_PREFIX = "push:";
const pushEnabled = (env) => !!(env.VAPID_JWK && env.VAPID_PUBLIC_KEY);

async function hashKey(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function storeSubscription(env, subscription, prefs) {
  const id = await hashKey(subscription.endpoint);
  // A prefs re-sync must not wipe the device's per-match reminders (feature 3).
  const existing = await env.SNAPSHOT.get(PUSH_PREFIX + id, "json");
  await env.SNAPSHOT.put(PUSH_PREFIX + id, JSON.stringify({
    subscription, prefs: prefs || { results: true, today: true, qual: true },
    reminders: existing?.reminders || {}, updated: Date.now(),
  }));
  return id;
}
async function removeSubscription(env, endpoint) {
  await env.SNAPSHOT.delete(PUSH_PREFIX + (await hashKey(endpoint)));
}
async function listSubscriptions(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.SNAPSHOT.list({ prefix: PUSH_PREFIX, cursor });
    for (const k of page.keys) { const v = await env.SNAPSHOT.get(k.name, "json"); if (v) out.push({ key: k.name, ...v }); }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out;
}
// Send one notification to every subscriber opted into `prefKey`. Prunes dead subs.
async function broadcast(env, prefKey, notif) {
  const subs = await listSubscriptions(env);
  for (const s of subs) {
    if (s.prefs && s.prefs[prefKey] === false) continue;
    try {
      const res = await sendWebPush(s.subscription, notif, env);
      if (res.status === 404 || res.status === 410) await env.SNAPSHOT.delete(s.key);  // gone
    } catch (e) { console.error("push send failed:", e.message); }
  }
}
// UK wall-clock parts (digests + the waking-hours gate for qualification alerts).
function ukParts() {
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour12: false, hour: "2-digit", year: "numeric", month: "2-digit", day: "2-digit" });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { hour: parseInt(p.hour, 10) % 24, date: `${p.year}-${p.month}-${p.day}` };
}
// Mark a once-per-day job as done; returns true the first time it's called for `date`.
async function claimDaily(env, key, date) {
  if ((await env.SNAPSHOT.get(key)) === date) return false;
  await env.SNAPSHOT.put(key, date);
  return true;
}
// ── notification copy helpers ────────────────────────────────────────────────
// Digests and reminders read better with the full nation name, where the fixture
// sits in the draw, and the UK kick-off time — so each push carries the context the
// app would, not just two three-letter codes. Push bodies render "\n", so we give
// every fixture its own line rather than cramming them onto one " · "-joined row.

// Full nation name from the snapshot directory, falling back to the 3-letter code.
export const teamName = (snap, code) => snap?.teams?.[code]?.name || code;
// Where a fixture sits: "Group F" in the group stage, else the knockout round as the
// API already names it ("Round of 16", "Quarter-finals", …). "" when we can't tell.
export function fixtureLabel(m) {
  if (m.group) return `Group ${m.group}`;
  return m.stage && m.stage !== "Group Stage" ? m.stage : "";
}

// Verdict flips between two snapshots (brief §14): qualified / eliminated / cut-line
// crossings. Batched into one line per group so simultaneous flips don't spam.
export function detectFlips(prev, snap) {
  if (!prev?.teams) return [];
  const interesting = (v) => v === "qualified" || v === "eliminated";
  const byGroup = {};
  for (const [code, t] of Object.entries(snap.teams || {})) {
    const was = prev.teams[code]?.verdict;
    const now = t.verdict;
    if (!now || now === was) continue;
    if (interesting(now) || interesting(was)) {
      const name = t.name || code;
      const phrase = now === "qualified" ? `${name} qualify` : now === "eliminated" ? `${name} are out` : `${name}: ${now}`;
      (byGroup[t.group || "?"] = byGroup[t.group || "?"] || []).push(phrase);
    }
  }
  return Object.entries(byGroup).map(([g, list]) => `Group ${g}: ${list.join(", ")}`);
}
// Overnight results, one line each: "Mexico 2-1 South Africa (4-3 pens) · Group F".
// Earliest kick-off first; returns { count, body } or null when nothing's finished.
export function resultsDigest(snap) {
  const since = Date.now() - 16 * 3600e3;   // overnight catch-up window
  const ft = (snap.matches || [])
    .filter((m) => m.status === "ft" && m.kickoff && new Date(m.kickoff).getTime() >= since)
    .sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
  if (!ft.length) return null;
  const lines = ft.slice(0, 8).map((m) => {
    const where = fixtureLabel(m);
    const pens = m.pens ? ` (${m.pens.h}-${m.pens.a} pens)` : "";
    return `${teamName(snap, m.home.code)} ${m.home.score}-${m.away.score} ${teamName(snap, m.away.code)}${pens}${where ? ` · ${where}` : ""}`;
  });
  if (ft.length > 8) lines.push(`+${ft.length - 8} more`);
  return { count: ft.length, body: lines.join("\n") };
}
// Today's fixtures, one line each: "13:00 Mexico v South Africa · Group F · ITV1".
// Earliest kick-off first; returns { count, body } or null when there's nothing on.
export function todayDigest(snap, date) {
  const today = (snap.matches || [])
    .filter((m) => m.status === "scheduled" && (m.kickoff || "").slice(0, 10) === date)
    .sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
  if (!today.length) return null;
  const lines = today.slice(0, 8).map((m) => {
    const where = fixtureLabel(m);
    const tv = m.tv?.channel ? ` · ${m.tv.channel}` : "";
    return `${ukTimeOf(m.kickoff)} ${teamName(snap, m.home.code)} v ${teamName(snap, m.away.code)}${where ? ` · ${where}` : ""}${tv}`;
  });
  if (today.length > 8) lines.push(`+${today.length - 8} more`);
  return { count: today.length, body: lines.join("\n") };
}

// ── per-match reminders (feature 3) ──────────────────────────────────────────────
// Device-local convenience: a one-off push ~N minutes before a chosen kickoff. The
// reminder rides on the anonymous push subscription record (no accounts). The cron
// runs every minute; this sweep is cheap — it only lists devices when a kickoff is
// actually inside the reminder window.
const REMINDER_MAX_LEAD = 180, REMINDER_DEFAULT_LEAD = 15;
const clampLead = (l) => Math.min(REMINDER_MAX_LEAD, Math.max(5, parseInt(l, 10) || REMINDER_DEFAULT_LEAD));

async function runReminders(env, snap) {
  if (!pushEnabled(env) || !snap) return;
  const now = Date.now();
  const inWindow = (snap.matches || []).some((m) => {
    if (m.status !== "scheduled" && m.status !== "live") return false;
    const t = Date.parse(m.kickoff || "");
    return Number.isFinite(t) && now >= t - (REMINDER_MAX_LEAD + 5) * 60e3 && now <= t + 10 * 60e3;
  });
  if (!inWindow) return;                                // nothing imminent — skip the KV list
  const name = (c) => snap.teams?.[c]?.name || c;
  for (const s of await listSubscriptions(env)) {
    const rem = s.reminders || {};
    let changed = false, gone = false;
    for (const [fid, r] of Object.entries(rem)) {
      const ko = Date.parse(r.at || "");
      if (!Number.isFinite(ko) || now > ko + 10 * 60e3) { delete rem[fid]; changed = true; continue; }   // stale — prune
      if (r.sent || now < ko - clampLead(r.lead) * 60e3) continue;
      const m = (snap.matches || []).find((x) => x.id === fid);
      let body;
      if (m) {
        const where = fixtureLabel(m);
        const tv = m.tv?.channel ? ` · ${m.tv.channel}` : "";
        const venue = m.venue ? `\n${m.venue}` : "";
        body = `${name(m.home.code)} v ${name(m.away.code)}${where ? ` · ${where}` : ""}\n${ukTimeOf(m.kickoff)} UK${tv}${venue}`;
      } else {
        body = `Kick-off at ${ukTimeOf(r.at)} UK`;
      }
      try {
        const res = await sendWebPush(s.subscription, { title: "⏰ Kick-off soon", body, tag: "wc26-rem-" + fid, url: "/#/match/" + fid }, env);
        if (res.status === 404 || res.status === 410) { await env.SNAPSHOT.delete(s.key); gone = true; break; }
      } catch (e) { console.error("reminder send failed:", e.message); }
      r.sent = true; changed = true;                    // one shot — never re-send
    }
    if (changed && !gone) {
      const { key, ...rec } = s;
      await env.SNAPSHOT.put(key, JSON.stringify({ ...rec, reminders: rem }));
    }
  }
}

// ── UK TV map: the automated background check (feature 1) ────────────────────────
// Re-fetches the published BBC/ITV schedules, stores the parsed listings in KV, and
// immediately re-annotates the current snapshot (no API-Football cost) so a changed
// or newly-announced channel reaches clients without waiting for the next poll.
async function refreshTvListings(env) {
  try {
    const listings = await fetchTvListings(env);
    const at = new Date().toISOString();
    await env.SNAPSHOT.put("tv-listings", JSON.stringify({ at, source: env.TV_SOURCE_URL || TV_SOURCE_DEFAULT, listings }));
    let mapped = null;
    const snap = await readSnapshot(env);
    if (snap) {
      const info = annotateTv(snap.matches, snap.teams, {
        listings: mergeListings(TVSEED.listings, listings),
        byFixture: TVSEED.byFixture, bySlot: TVSEED.bySlot,
      });
      mapped = info.mapped;
      snap.meta = { ...snap.meta, updated: at, tv: { mapped, checked: at } };
      await writeSnapshot(env, snap);
    }
    const summary = { ok: true, at, listings: listings.length, withChannel: listings.filter((l) => l.channel).length, mapped };
    await env.SNAPSHOT.put("tv-status", JSON.stringify(summary));
    return summary;
  } catch (e) {
    // keep last-good listings; the seed still covers the baseline
    const err = { ok: false, at: new Date().toISOString(), error: e.message };
    await env.SNAPSHOT.put("tv-status", JSON.stringify(err));
    return err;
  }
}

async function runNotifications(env, prev, snap) {
  if (!pushEnabled(env)) return;                       // feature off until keys are set
  const { hour, date } = ukParts();
  const waking = hour >= 8 && hour < 23;

  // Qualification moments — live verdict flips, waking hours only (overnight folds
  // into the morning digest).
  if (waking) {
    const flips = detectFlips(prev, snap);
    if (flips.length) await broadcast(env, "qual", { title: "Qualification update", body: flips.join(" · "), tag: "wc26-qual", url: "/#/groups?t=race" });
  }
  // Morning results digest (~8am UK) + the overnight catch-up.
  if (hour === 8 && await claimDaily(env, "digest-results", date)) {
    const d = resultsDigest(snap);
    if (d) await broadcast(env, "results", { title: d.count === 1 ? "Last night's result" : `Last night's results · ${d.count} games`, body: d.body, tag: "wc26-results", url: "/#/matches" });
  }
  // Today's matches (~midday UK).
  if (hour === 12 && await claimDaily(env, "digest-today", date)) {
    const d = todayDigest(snap, date);
    if (d) await broadcast(env, "today", { title: d.count === 1 ? "1 match today" : `${d.count} matches today`, body: d.body, tag: "wc26-today", url: "/#/matches" });
  }
}

export default {
  // Cron entrypoint.
  async scheduled(event, env, ctx) {
    const work = (async () => {
      await env.SNAPSHOT.put("cron-tick", new Date().toISOString());   // heartbeat: proves the cron is firing
      const prev = await readSnapshot(env);
      const meta = (await env.SNAPSHOT.get(META_KEY, "json")) || { lastFull: 0, lastLive: 0 };
      const now = Date.now();
      const baselineMs = (parseInt(env.BASELINE_INTERVAL_MIN || "360", 10)) * 60e3;
      const liveMs = (parseInt(env.LIVE_INTERVAL_SEC || "75", 10)) * 1e3;
      const live = inLiveWindow(prev);

      // Per-match reminders (feature 3): a cheap sweep on every tick — it exits
      // immediately unless a kickoff is inside the reminder window.
      try { await runReminders(env, prev); } catch (e) { console.error("reminders failed:", e.message); }

      // UK TV map (feature 1): check the published schedules once a day (~TV_REFRESH_HOUR
      // UK), plus a 6-hourly retry while any match in the next 48h still lacks a channel —
      // so corrections propagate and knockout gaps fill in as broadcasters announce.
      try {
        const tvHour = parseInt(env.TV_REFRESH_HOUR || "5", 10);
        const uk = ukParts();
        const gapSoon = (prev?.matches || []).some((m) => {
          if (m.status !== "scheduled" || m.tv) return false;
          const t = Date.parse(m.kickoff || "");
          return Number.isFinite(t) && t > now && t - now < 48 * 3600e3;
        });
        const dueDaily = uk.hour >= tvHour && await claimDaily(env, "tv-daily", uk.date);
        const dueRetry = gapSoon && now - (meta.lastTv || 0) >= 6 * 3600e3;
        if (dueDaily || dueRetry) {
          await refreshTvListings(env);
          meta.lastTv = now;
          await env.SNAPSHOT.put(META_KEY, JSON.stringify(meta));
        }
      } catch (e) { console.error("tv refresh failed:", e.message); }

      // Daily highlights round-up for the morning catch-up (feature: highlights). The
      // official round-up surfaces overnight / early morning, so search ONLY inside the
      // morning window (05:00–13:00 UK — a touch before the 06:00 view opens, until it
      // closes at 13:00, mirroring morning.js): a video that only lands at 14:00 is useless
      // to that surface. Retry ~every 30 min until found, then it's frozen for the day.
      // Stashed in KV (read back in buildSnapshot); the patch below also surfaces it at once
      // rather than waiting for the next baseline poll.
      try {
        const uk = ukParts();
        if (env.YOUTUBE_API_KEY && uk.hour >= 5 && uk.hour < 13) {
          const have = await env.SNAPSHOT.get("day-highlights", "json");
          if (have?.date !== uk.date && now - (meta.lastHighlights || 0) >= 30 * 60e3) {
            meta.lastHighlights = now;
            await env.SNAPSHOT.put(META_KEY, JSON.stringify(meta));
            const dh = await findDayHighlights(env, uk.date);   // tagged with date: uk.date
            if (dh) {
              await env.SNAPSHOT.put("day-highlights", JSON.stringify(dh));
              if (prev) {   // surface it immediately, not on the next baseline poll
                prev.dayHighlights = dh;
                prev.meta = { ...prev.meta, updated: new Date().toISOString() };
                await writeSnapshot(env, prev);
              }
            }
          }
        }
      } catch (e) { console.error("highlights refresh failed:", e.message); }

      // Enrichment backlog → catch up every few minutes until squads + Watch-player
      // profiles are all loaded, then fall back to the 6h baseline.
      const backlog = (() => {
        if (!prev || !(prev.meta?.squadCount > 0)) return true;
        const players = prev.players || {};
        for (const club of Object.values(prev.clubWatch || {}))
          for (const p of club.players || []) if (players[String(p.playerId)]?._enriched !== ENRICH_VERSION) return true;
        return false;
      })();
      const effectiveBaseline = backlog ? 4 * 60e3 : baselineMs;   // 4 min while catching up

      const newsMs = (parseInt(env.NEWS_INTERVAL_MIN || "30", 10)) * 60e3;
      const dueFull = now - meta.lastFull >= effectiveBaseline;
      const dueLive = live && now - meta.lastLive >= liveMs;
      const dueNews = now - (meta.lastNews || 0) >= newsMs;
      if (!dueFull && !dueLive) {
        // No data poll due — but keep the news fresh on its own ~30-min cadence (cheap,
        // no API-Football quota, doesn't touch lastFull/lastLive).
        if (dueNews && prev) {
          try {
            prev.news = await fetchNews(env);
            // Bump meta.updated: the frontend only repaints an open tab when it changes,
            // so without this fresh headlines sit unseen until the next full/live poll.
            prev.meta = { ...prev.meta, updated: new Date().toISOString() };
            await writeSnapshot(env, prev);
            await env.SNAPSHOT.put(META_KEY, JSON.stringify({ ...meta, lastNews: now }));
          } catch {}
        }
        return;
      }

      // Never let polls stack. Cron fires every minute, but a poll that runs into
      // per-minute 429s sleeps/retries and can run well past 60s — without a lock the
      // next ticks pile concurrent full polls on top (each ~75 calls once the
      // tournament is live), which is exactly what exhausts the per-minute allowance
      // and starves the live calls. Same pattern as runRefresh's refresh-lock; the
      // TTL caps the damage if an invocation dies without releasing.
      const pollLock = await env.SNAPSHOT.get("poll-lock");
      if (pollLock && now - +pollLock < 150000) return;
      await env.SNAPSHOT.put("poll-lock", String(now), { expirationTtl: 180 });
      try {
        const snap = await buildSnapshot(env, prev, !dueFull /* liveOnly when only the live tick is due */);
        await writeSnapshot(env, snap);
        await env.SNAPSHOT.put(META_KEY, JSON.stringify({ ...meta, lastFull: dueFull ? now : meta.lastFull, lastLive: now, lastNews: dueFull ? now : (meta.lastNews || 0) }));
        await env.SNAPSHOT.put("cron-status", JSON.stringify({ ok: true, at: new Date().toISOString(), kind: dueFull ? "full" : "live", squadCount: snap.meta.squadCount, subrequests: SUBREQ }));
        // Push: digests + verdict-flip alerts, diffing the previous snapshot (§14).
        try { await runNotifications(env, prev, snap); } catch (e) { console.error("notify failed:", e.message); }
      } catch (err) {
        console.error("poll failed:", err.message);
        await env.SNAPSHOT.put("cron-status", JSON.stringify({ ok: false, at: new Date().toISOString(), error: err.message }));
        const fb = await fallbackSnapshot(env, prev);
        if (fb) await writeSnapshot(env, fb);
        // else: keep last good — never overwrite with a broken snapshot.
      } finally {
        await env.SNAPSHOT.delete("poll-lock");
      }
    })();
    ctx.waitUntil(work);
  },

  // Serves the snapshot from KV and the static frontend (Static Assets binding).
  // run_worker_first=true means every request lands here, so /data/latest.json is
  // returned from KV (not the static mock) before falling through to the app.
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";   // tolerate trailing slashes
    if (path === "/data/latest.json") {
      const snap = await env.SNAPSHOT.get(KV_KEY);
      if (!snap) return new Response(JSON.stringify({ error: "no snapshot yet" }), { status: 503, headers: { "content-type": "application/json" } });
      return new Response(snap, {
        headers: { "content-type": "application/json", "cache-control": "public, max-age=30" },
      });
    }
    if (path === "/healthz") return new Response("ok");

    // Current deployment id — the frontend polls this to detect a new build and
    // surface a refresh (so an open tab isn't stuck on stale code). Changes on every
    // deploy via the version-metadata binding; falls back to "dev" if unbound.
    if (path === "/version") {
      const vm = env.CF_VERSION_METADATA;
      const version = (vm && (vm.id || vm.tag)) || "dev";
      return new Response(JSON.stringify({ version }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }

    // ── Web push subscription endpoints (brief §14) ──
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
    if (path === "/push/vapidPublicKey") {
      if (!pushEnabled(env)) return json({ enabled: false }, 404);
      return json({ enabled: true, key: env.VAPID_PUBLIC_KEY });
    }
    if (path === "/push/subscribe" && request.method === "POST") {
      if (!pushEnabled(env)) return json({ error: "push not configured" }, 503);
      try {
        const { subscription, prefs } = await request.json();
        if (!subscription?.endpoint || !subscription?.keys?.p256dh) return json({ error: "bad subscription" }, 400);
        const id = await storeSubscription(env, subscription, prefs);
        return json({ ok: true, id });
      } catch (e) { return json({ error: e.message }, 400); }
    }
    if (path === "/push/unsubscribe" && request.method === "POST") {
      try {
        const { endpoint } = await request.json();
        if (endpoint) await removeSubscription(env, endpoint);
        return json({ ok: true });
      } catch (e) { return json({ error: e.message }, 400); }
    }
    // Per-match reminder (feature 3): set/clear a one-off pre-kickoff nudge on this
    // device's anonymous subscription record. No accounts — the endpoint is the key.
    if (path === "/push/remind" && request.method === "POST") {
      if (!pushEnabled(env)) return json({ error: "push not configured" }, 503);
      try {
        const { endpoint, fixtureId, kickoff, lead, on } = await request.json();
        if (!endpoint || !fixtureId) return json({ error: "endpoint and fixtureId required" }, 400);
        const key = PUSH_PREFIX + (await hashKey(endpoint));
        const rec = await env.SNAPSHOT.get(key, "json");
        if (!rec) return json({ error: "no subscription for this device — enable notifications first" }, 404);
        rec.reminders = rec.reminders || {};
        if (on === false) delete rec.reminders[String(fixtureId)];
        else {
          if (!Number.isFinite(Date.parse(kickoff || ""))) return json({ error: "bad kickoff" }, 400);
          rec.reminders[String(fixtureId)] = { at: kickoff, lead: clampLead(lead) };
        }
        await env.SNAPSHOT.put(key, JSON.stringify(rec));
        return json({ ok: true, reminders: Object.keys(rec.reminders).length });
      } catch (e) { return json({ error: e.message }, 400); }
    }

    // Read-only health view: last cron run, last manual refresh, poll timing, and the
    // API daily quota (the usual cause of a stuck refresh). One API call.
    if (path === "/admin/status") {
      const [cron, refresh, pm, tick, tvStatus] = await Promise.all([
        env.SNAPSHOT.get("cron-status", "json"), env.SNAPSHOT.get("refresh-status", "json"), env.SNAPSHOT.get(META_KEY, "json"), env.SNAPSHOT.get("cron-tick"),
        env.SNAPSHOT.get("tv-status", "json"),
      ]);
      let quota = null;
      try {
        const s = await apiGet(env, "/status", {}); const o = Array.isArray(s) ? s[0] : s;
        quota = { plan: o?.subscription?.plan, requestsToday: o?.requests?.current, dailyLimit: o?.requests?.limit_day,
          perMinuteLimit: RL.minLimit, perMinuteRemaining: RL.min };
      } catch (e) { quota = { error: e.message, perMinuteLimit: RL.minLimit }; }
      const ago = (t) => (t ? Math.round((Date.now() - new Date(t).getTime()) / 60000) + "m ago" : "never");
      // sample an actual stored Watch player so we can see what enrichment produced
      let samplePlayer = null;
      try {
        const snap = await readSnapshot(env);
        const club = snap?.clubWatch?.["manchester-united"] || Object.values(snap?.clubWatch || {}).find((c) => c.players?.length);
        const pid = club?.players?.[0]?.playerId;
        const p = pid && snap?.players?.[String(pid)];
        if (p) samplePlayer = { id: pid, name: p.name, club: p.club, league: p.league, age: p.age,
          seasonRows: (p.season || []).length, careerRows: (p.career || []).length, honours: (p.honours || []).length,
          enrichedVersion: p._enriched, tournamentG: p.tournament?.g };
      } catch (e) { samplePlayer = { error: e.message }; }
      // TV-map health: last schedules check + how many upcoming matches lack a channel.
      let tv = tvStatus ? { ...tvStatus, when: ago(tvStatus.at) } : { note: "no live check yet — running on the bundled seed" };
      try {
        const snap = await readSnapshot(env);
        const upcoming = (snap?.matches || []).filter((m) => m.status === "scheduled");
        tv = { ...tv, upcomingMapped: upcoming.filter((m) => m.tv).length, upcomingTotal: upcoming.length };
      } catch {}
      return new Response(JSON.stringify({
        now: new Date().toISOString(), quota,
        cronHeartbeat: tick ? ago(tick) : "NEVER — cron is not firing (check dashboard Triggers)",
        lastCron: cron ? { ...cron, when: ago(cron.at) } : "no full/live poll yet",
        lastRefresh: refresh ? { ...refresh, when: ago(refresh.finished) } : "none",
        tv,
        pollMeta: pm ? { lastFull: ago(pm.lastFull && new Date(pm.lastFull).toISOString()), lastLive: ago(pm.lastLive && new Date(pm.lastLive).toISOString()) } : null,
        samplePlayer, enrichVersionExpected: ENRICH_VERSION,
      }, null, 2), { headers: { "content-type": "application/json" } });
    }

    // Probe whether /players/squads returns data for a national team vs a club, so we
    // can tell "squads not published yet" from "endpoint not returning nationals".
    if (path === "/debug/squad") {
      if (env.DEBUG_TOKEN && url.searchParams.get("t") !== env.DEBUG_TOKEN) {
        return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "content-type": "application/json" } });
      }
      const base = { league: CFG(env).league, season: CFG(env).season };
      const out = {};
      try {
        const dir = await buildTeamDir(env, base);
        const ids = Object.keys(dir.byId);
        const nationId = +(url.searchParams.get("team") || ids[0]);
        out.nationProbed = { id: nationId, code: dir.byId[nationId]?.code };
        try {
          const r = await apiGet(env, "/players/squads", { team: nationId });
          out.nationSquad = { count: r?.[0]?.players?.length || 0, sample: (r?.[0]?.players || []).slice(0, 3).map((p) => ({ id: p.id, name: p.name })) };
        } catch (e) { out.nationSquadError = e.message; }
        try {
          const r = await apiGet(env, "/players/squads", { team: 33 }); // Man Utd (club) — known to have a squad
          out.club33Squad = { count: r?.[0]?.players?.length || 0, sample: (r?.[0]?.players || []).slice(0, 3).map((p) => ({ id: p.id, name: p.name })) };
        } catch (e) { out.club33SquadError = e.message; }
        // alternative source: /players?team=&season= (paginated; players with appearances)
        try {
          const r = await apiGet(env, "/players", { team: nationId, season: base.season });
          out.nationPlayersEndpoint = { count: r.length };
        } catch (e) { out.nationPlayersError = e.message; }
      } catch (e) { out.error = e.message; }
      return new Response(JSON.stringify(out, null, 2), { headers: { "content-type": "application/json" } });
    }

    // Trigger a full poll. The build runs to completion via waitUntil even if the
    // client disconnects (writing KV + refresh-status); if the client stays connected
    // it also gets the summary directly. Re-hit to read the last result any time.
    if (path === "/admin/refresh") {
      if (env.DEBUG_TOKEN && url.searchParams.get("t") !== env.DEBUG_TOKEN) {
        return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "content-type": "application/json" } });
      }
      const work = runRefresh(env);
      ctx.waitUntil(work);
      let res; try { res = await work; } catch (e) { res = { ok: false, error: String(e && e.message || e) }; }
      return new Response(JSON.stringify(res, null, 2), { headers: { "content-type": "application/json" } });
    }

    // Force the TV-schedules check now (same job the cron runs daily). Token-gated.
    if (path === "/admin/refresh-tv") {
      if (env.DEBUG_TOKEN && url.searchParams.get("t") !== env.DEBUG_TOKEN) return json({ error: "forbidden" }, 403);
      return json(await refreshTvListings(env));
    }

    // Fire a test push to every stored subscription (ignores per-device prefs) so you
    // can verify the whole VAPID → encryption → delivery chain on demand. Token-gated
    // (set DEBUG_TOKEN as a secret; pass ?t=…). Prunes any dead subscriptions it finds.
    if (path === "/admin/test-push") {
      if (env.DEBUG_TOKEN && url.searchParams.get("t") !== env.DEBUG_TOKEN) return json({ error: "forbidden" }, 403);
      if (!pushEnabled(env)) return json({ error: "push not configured — set VAPID_JWK + VAPID_PUBLIC_KEY first" }, 503);
      const subs = await listSubscriptions(env);
      const notif = { title: "WC26 — test", body: "Push is working 🎉", tag: "wc26-test", url: "/#/matches" };
      let sent = 0, pruned = 0, failed = 0;
      for (const s of subs) {
        try {
          const res = await sendWebPush(s.subscription, notif, env);
          if (res.status === 404 || res.status === 410) { await env.SNAPSHOT.delete(s.key); pruned++; }
          else if (res.ok) sent++;
          else failed++;
        } catch { failed++; }
      }
      return json({ ok: true, subscriptions: subs.length, sent, pruned, failed });
    }

    // Everything else: the static /web app. Force revalidation so a deploy reaches
    // already-loaded browsers (the assets aren't content-hashed).
    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    out.headers.set("cache-control", "no-cache");
    return out;
  },
};
