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
import { sendWebPush } from "./push.js";
import { overnightFinished, matchesOn, resultsLine, fixturesLine } from "../web/js/digest.js";

const API = "https://v3.football.api-sports.io";
const KV_KEY = "latest.json";
const META_KEY = "poll-meta";

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Subrequest budget. Cloudflare Workers cap subrequests per invocation (50 on the
// free plan, 1000 on paid). A full poll wants ~110 calls, so we count them and let
// the enrichment steps stop before the cap — squads/stats fill in over several polls
// (squads persist once fetched). Reset at the start of each buildSnapshot.
let SUBREQ = 0, SUBREQ_CAP = 45, RATE_LIMITED = false;
const budgetLeft = () => (RATE_LIMITED ? 0 : SUBREQ_CAP - SUBREQ);   // stop enrichment once throttled
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
      // Per-minute: brief retry (window resets each minute). Per-day: don't bother —
      // it won't recover, so fail fast and stop further enrichment this run.
      if (/per minute|requests per minute/i.test(msg) && attempt < 2) { await sleep(6000); return apiGet(env, path, params, attempt + 1); }
      RATE_LIMITED = true;
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
  } catch { /* fall back to ids below */ }
  return { byId, crests };
}
const codeOf = (dir, id) => dir.byId[id]?.code || String(id);

function normStandings(resp, dir) {
  // resp[0].league.standings = [[row,...] per group] + a "Ranking of third-placed teams" block
  const groups = {};
  const table = resp?.[0]?.league?.standings || [];
  for (const groupRows of table) {
    const letter = (groupRows?.[0]?.group || "").replace(/^Group\s+/i, "").trim().toUpperCase();
    if (!/^[A-L]$/.test(letter)) continue;          // skip "Ranking of third-placed teams" etc.
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
    const hc = codeOf(dir, home?.id), ac = codeOf(dir, away?.id);
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
    if (!done && !live && !ht) {
      base.status = "scheduled";
      if (isGroup) remainingFixtures.push({
        id: base.id, group: groupLetter, home: hc, away: ac, kickoff: base.kickoff, affectsThird: true,
      });
      matches.push(base);
    } else {
      base.status = live ? "live" : ht ? "ht" : "ft";
      if (live || ht) base.minute = (f.fixture?.status?.elapsed ?? "") + "'";
      matches.push(base);
    }
  }
  return { matches, remainingFixtures };
}

function normEvents(resp, homeId) {
  return (resp || []).map((e) => ({
    min: `${e.time?.elapsed ?? ""}'`,
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
  const groups = normStandings(await apiGet(env, "/standings", base), dir);
  const idToGroup = {};
  for (const [g, rows] of Object.entries(groups)) rows.forEach((r) => (idToGroup[r._id] = g));
  const { matches, remainingFixtures } = normFixtures(await apiGet(env, "/fixtures", base), dir, idToGroup);

  // Carry over finalised match detail (events/stats/lineups/ratings never change once
  // FT) so each finished match is fetched exactly once.
  const prevMatch = Object.fromEntries((prev?.matches || []).map((m) => [m.id, m]));
  for (const m of matches) {
    const p = prevMatch[m.id];
    if (!p) continue;
    // The Guardian feed is live-only, so once a match is over keep the commentary we
    // captured (it never changes again) — so you can look back at how the game unfolded.
    if (m.status === "ft" && p.commentary) {
      m.commentary = p.commentary; m.commentaryUrl = p.commentaryUrl; m.commentarySource = p.commentarySource;
      m._guardianId = p._guardianId; m._commentaryClosed = p._commentaryClosed;
    }
    if (m.status === "ft" && p.lineups) {
      m.events = p.events; m.stats = p.stats; m.lineups = p.lineups; m.progressionLine = p.progressionLine; m._final = true;
    }
  }
  // Fetch detail: live/HT every poll; newly-finished matches once (incl FT ratings).
  for (const m of matches.filter((x) => x.status === "live" || x.status === "ht" || (x.status === "ft" && !x._final))) {
    try { m.events = normEvents(await apiGet(env, "/fixtures/events", { fixture: m.id }), m._homeId); } catch {}
    try { m.stats = normStats(await apiGet(env, "/fixtures/statistics", { fixture: m.id })); } catch {}
    try {
      const lu = await apiGet(env, "/fixtures/lineups", { fixture: m.id });
      if (lu?.length) m.lineups = normLineups(lu, m._homeId, m._awayId);
    } catch {}
    if (m.status === "ft") {  // player ratings + per-match stats land at full time
      try { mergePlayerRatings(m, await apiGet(env, "/fixtures/players", { fixture: m.id })); } catch {}
    }
  }

  // Guardian minute-by-minute (best-effort, gated on a key). Live/HT every poll; and a
  // just-finished match keeps pulling until the liveblog actually closes, so the
  // full-time wrap-up / report is captured. Then it's frozen and never refetched.
  if (env.GUARDIAN_KEY) {
    const now = Date.now();
    for (const m of matches) {
      const liveish = m.status === "live" || m.status === "ht";
      const koMs = m.kickoff ? new Date(m.kickoff).getTime() : 0;
      const justFinished = m.status === "ft" && !m._commentaryClosed && koMs && now <= koMs + 12 * 3600e3;
      if (!liveish && !justFinished) continue;
      try {
        let gid = m._guardianId || prevMatch[m.id]?._guardianId;
        if (!gid) gid = await findLiveblogId(env, dir.byId[m._homeId]?.name, dir.byId[m._awayId]?.name, m.kickoff);
        if (!gid) continue;
        m._guardianId = gid;
        const com = await fetchCommentary(env, gid);
        if (com.blocks.length) { m.commentary = com.blocks; m.commentaryUrl = com.url; m.commentarySource = "The Guardian"; }
        // Liveblog no longer updating → the wrap-up is in; freeze it so we stop polling.
        if (m.status === "ft" && com.live === false) m._commentaryClosed = true;
      } catch { /* commentary is best-effort */ }
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
    try { await enrichPlayers(env, base, curatedPlayerIds({ scorers, assists, discipline, prev, matches }), players, cfg, dir); } catch {}
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
            squadCount },   // 0 ⇒ nation squads not published yet (pre-tournament), not a bug
    groups,
    thirdPlaceRace: race,
    remainingFixtures,
    matches,
    bracket,
    scorers, assists, discipline,
    teams, players, clubWatch, news,
    crests: dir.crests,           // code -> official crest/flag image URL
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
const ENRICH_VERSION = 2;
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
        tournament: wc.tournament || existing?.tournament,     // WC aggregate (0 until games played)
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
function normPlayer(resp, leagueId, dir) {
  const p = resp?.[0]; if (!p) return null;
  const stats = p.statistics || [];
  const wc = stats.find((s) => String(s.league?.id) === String(leagueId)) || stats[0] || {};
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
  const engineSnap = { groups, remainingFixtures, teams };
  const outlookCache = {};
  const outlook = (code) => (outlookCache[code] = outlookCache[code] || qualifyOutlook(engineSnap, code, ANNEXC));
  for (const m of matches) {
    m.affectsCut = false;
    if (!anyPlayed || m.stage !== "Group Stage" || m.status === "ft") continue;
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
// Pull the latest timestamped commentary blocks for a liveblog id.
async function fetchCommentary(env, id) {
  const res = await guardianGet(env, "/" + id, { "show-blocks": "body:latest:30", "show-fields": "liveBloggingNow" });
  const c = res.content || {};
  const blocks = (c.blocks?.body || []).map((b) => ({
    at: b.firstPublishedDate || b.publishedDate || b.createdDate || "",
    title: (b.title || "").trim(),
    text: b.bodyTextSummary || stripHtml(b.bodyHtml),
    key: !!(b.attributes && b.attributes.keyEvent),
  })).filter((b) => b.text);
  blocks.sort((a, b) => (b.at || "").localeCompare(a.at || ""));
  return { url: c.webUrl || null, live: c.fields?.liveBloggingNow === "true", blocks: blocks.slice(0, 30) };
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
    await env.SNAPSHOT.put(META_KEY, JSON.stringify({ lastFull: Date.now(), lastLive: Date.now() }));
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
  const existing = await env.SNAPSHOT.get(PUSH_PREFIX + id, "json");   // preserve this device's reminders
  await env.SNAPSHOT.put(PUSH_PREFIX + id, JSON.stringify({
    subscription, prefs: prefs || existing?.prefs || { results: true, today: true, qual: true },
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

// Per-match reminders (brief feature 3) — fire ~leadMin before kickoff to the single
// device that set it (the push endpoint is that device's key — no accounts). Runs
// every tick, not hour-gated. Marks each sent once, prunes stale/past ones and dead subs.
async function sendDueReminders(env) {
  const now = Date.now();
  const subs = await listSubscriptions(env);
  for (const s of subs) {
    const rem = s.reminders;
    if (!rem || !Object.keys(rem).length) continue;
    let changed = false, dead = false;
    for (const [mid, r] of Object.entries(rem)) {
      const ko = Date.parse(r.kickoff);
      if (!Number.isFinite(ko) || now >= ko + 30 * 60e3) { delete rem[mid]; changed = true; continue; }  // past/stale
      if (r.sentAt) continue;
      if (now < ko - (r.leadMin || 15) * 60e3) continue;          // not yet in the lead window
      try {
        const res = await sendWebPush(s.subscription, {
          title: r.title || "Kicking off soon ⚽", body: r.body || "Your match starts soon",
          tag: `wc26-rem-${mid}`, url: `/#/match/${mid}`,
        }, env);
        if (res.status === 404 || res.status === 410) { await env.SNAPSHOT.delete(s.key); dead = true; break; }
      } catch (e) { console.error("reminder send failed:", e.message); }
      r.sentAt = now; changed = true;
    }
    if (dead) continue;
    if (changed) await env.SNAPSHOT.put(s.key, JSON.stringify({ subscription: s.subscription, prefs: s.prefs, reminders: rem, updated: Date.now() }));
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
// Verdict flips between two snapshots (brief §14): qualified / eliminated / cut-line
// crossings. Batched into one line per group so simultaneous flips don't spam.
function detectFlips(prev, snap) {
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
// Digests reuse the SAME composition as the in-app morning view (web/js/digest.js) —
// one source, two surfaces (brief feature 2).
function resultsDigest(snap) {
  return resultsLine(overnightFinished(snap));
}
function todayDigest(snap, date) {
  return fixturesLine(matchesOn(snap, date).filter((m) => m.status === "scheduled"));
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
    const body = resultsDigest(snap);
    if (body) await broadcast(env, "results", { title: "Last night's results", body, tag: "wc26-results", url: "/#/matches" });
  }
  // Today's matches (~midday UK).
  if (hour === 12 && await claimDaily(env, "digest-today", date)) {
    const body = todayDigest(snap, date);
    if (body) await broadcast(env, "today", { title: "Today's matches", body, tag: "wc26-today", url: "/#/matches" });
  }
  // Per-match reminders — close to kickoff, any time of day (brief feature 3).
  await sendDueReminders(env);
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
          try { prev.news = await fetchNews(env); await writeSnapshot(env, prev);
            await env.SNAPSHOT.put(META_KEY, JSON.stringify({ ...meta, lastNews: now })); } catch {}
        }
        return;
      }

      try {
        const snap = await buildSnapshot(env, prev, !dueFull /* liveOnly when only the live tick is due */);
        await writeSnapshot(env, snap);
        await env.SNAPSHOT.put(META_KEY, JSON.stringify({ lastFull: dueFull ? now : meta.lastFull, lastLive: now, lastNews: dueFull ? now : (meta.lastNews || 0) }));
        await env.SNAPSHOT.put("cron-status", JSON.stringify({ ok: true, at: new Date().toISOString(), kind: dueFull ? "full" : "live", squadCount: snap.meta.squadCount, subrequests: SUBREQ }));
        // Push: digests + verdict-flip alerts, diffing the previous snapshot (§14).
        try { await runNotifications(env, prev, snap); } catch (e) { console.error("notify failed:", e.message); }
      } catch (err) {
        console.error("poll failed:", err.message);
        await env.SNAPSHOT.put("cron-status", JSON.stringify({ ok: false, at: new Date().toISOString(), error: err.message }));
        const fb = await fallbackSnapshot(env, prev);
        if (fb) await writeSnapshot(env, fb);
        // else: keep last good — never overwrite with a broken snapshot.
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
    // Per-match reminder: set/clear a reminder on this device's subscription record
    // (brief feature 3). The client also keeps local state + offers an .ics fallback.
    if (path === "/push/reminder" && request.method === "POST") {
      if (!pushEnabled(env)) return json({ error: "push not configured" }, 503);
      try {
        const { endpoint, subscription, matchId, kickoff, leadMin, title, body, on } = await request.json();
        const ep = endpoint || subscription?.endpoint;
        if (!ep || !matchId) return json({ error: "bad request" }, 400);
        const id = await hashKey(ep);
        let rec = await env.SNAPSHOT.get(PUSH_PREFIX + id, "json");
        // Allow setting a reminder in the same gesture as enabling push: create the
        // record if the client sent its subscription and we don't have one yet.
        if (!rec && subscription?.endpoint && subscription?.keys?.p256dh) rec = { subscription, prefs: { results: true, today: true, qual: true }, reminders: {} };
        if (!rec) return json({ error: "no subscription" }, 404);
        rec.reminders = rec.reminders || {};
        if (on === false) delete rec.reminders[matchId];
        else rec.reminders[matchId] = { kickoff, leadMin: leadMin || 15, title, body };
        rec.updated = Date.now();
        await env.SNAPSHOT.put(PUSH_PREFIX + id, JSON.stringify(rec));
        return json({ ok: true });
      } catch (e) { return json({ error: e.message }, 400); }
    }

    // Read-only health view: last cron run, last manual refresh, poll timing, and the
    // API daily quota (the usual cause of a stuck refresh). One API call.
    if (path === "/admin/status") {
      const [cron, refresh, pm, tick] = await Promise.all([
        env.SNAPSHOT.get("cron-status", "json"), env.SNAPSHOT.get("refresh-status", "json"), env.SNAPSHOT.get(META_KEY, "json"), env.SNAPSHOT.get("cron-tick"),
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
      return new Response(JSON.stringify({
        now: new Date().toISOString(), quota,
        cronHeartbeat: tick ? ago(tick) : "NEVER — cron is not firing (check dashboard Triggers)",
        lastCron: cron ? { ...cron, when: ago(cron.at) } : "no full/live poll yet",
        lastRefresh: refresh ? { ...refresh, when: ago(refresh.finished) } : "none",
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
