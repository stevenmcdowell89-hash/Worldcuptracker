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

import { thirdPlaceTable, recompute, verdicts, compareGroupRows, plainEnglish } from "../web/js/engine.js";
import { buildBracket } from "../web/js/bracket.js";
import ANNEXC from "../web/js/annexC.data.js";

const API = "https://v3.football.api-sports.io";
const KV_KEY = "latest.json";
const META_KEY = "poll-meta";

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// ── tiny API client (rate-limit aware) ──
// API-Football returns HTTP 200 with {errors:{rateLimit:"..."}} when the per-minute
// cap is exceeded. We back off and retry a few times (the per-minute window resets
// each minute) so a burst of live calls degrades gracefully instead of throwing.
async function apiGet(env, path, params = {}, attempt = 0) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { "x-apisports-key": env.APIFOOTBALL_KEY } });
  if (!r.ok) {
    if (r.status === 429 && attempt < 3) { await sleep(6500); return apiGet(env, path, params, attempt + 1); }
    throw new Error(`API-Football ${path} → ${r.status}`);
  }
  const body = await r.json();
  if (body.errors && Object.keys(body.errors).length) {
    const msg = JSON.stringify(body.errors);
    if (/ratelimit/i.test(msg) && attempt < 3) { await sleep(6500); return apiGet(env, path, params, attempt + 1); }
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
  const all = [
    ...(snapshot.matches || []).map((m) => m.kickoff),
    ...(snapshot.remainingFixtures || []).map((f) => f.kickoff),
  ].filter(Boolean);
  // a match is "live-ish" from 5 min before KO to 140 min after
  return all.some((iso) => {
    const ko = new Date(iso).getTime();
    return now >= ko - 5 * 60e3 && now <= ko + 140 * 60e3;
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
async function buildClubWatch(env, cfg, teams, players, remainingFixtures) {
  const wcPlayerIds = new Set();
  for (const code of Object.keys(teams)) (teams[code].squad || []).forEach((id) => wcPlayerIds.add(String(id)));
  const clubWatch = {};
  for (const [slug, club] of Object.entries(cfg.clubs)) {
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
  }
  return clubWatch;
}

// ── orchestrate one full poll ──
// liveOnly = true → only the cheap live path (events/stats for in-play fixtures);
// reuses everything else from the previous snapshot. Heavy enrichment runs only on
// the baseline (full) poll, and finalised data is persisted so we fetch it once.
export async function buildSnapshot(env, prev, liveOnly) {
  const cfg = CFG(env);
  const base = { league: cfg.league, season: cfg.season };

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
    if (m.status === "ft" && p?.lineups) {
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
    try { await enrichTeamStats(env, base, teams, groups); } catch {}   // aggregates + fair-play cards
    try { await ensureNationSquads(env, base, teams, players); } catch {}  // squads (once) → clubWatch + team squad
    try { await enrichPlayers(env, base, curatedPlayerIds({ scorers, assists, discipline, prev, matches }), players, cfg, dir); } catch {}
  }

  // Sort groups with the full rules (now card-aware) so positions + third place are exact.
  for (const g of Object.keys(groups)) groups[g].sort(compareGroupRows);

  // Engine pre-derivation.
  const race = verdicts({ groups, remainingFixtures, teams });
  applyTeamVerdicts(teams, groups, race);
  annotateProgression(matches, groups, remainingFixtures, teams, race);

  if (!liveOnly) {
    try { clubWatch = await buildClubWatch(env, cfg, teams, players, remainingFixtures); } catch {}
  }
  for (const m of matches) { delete m._homeId; delete m._awayId; delete m._final; }  // strip internals
  for (const g of Object.keys(groups)) groups[g].forEach((r) => delete r._id);
  for (const t of Object.values(teams)) delete t._id;

  const groupStageComplete = remainingFixtures.length === 0;
  let bracket = prev?.bracket || buildBracket(groups, ANNEXC, { groupStageComplete: false });
  try { bracket = buildBracket(groups, ANNEXC, { groupStageComplete }); } catch {}

  const squadCount = Object.values(teams).reduce((n, t) => n + (t.squad?.length || 0), 0);
  return {
    meta: { stage: matches.some((m) => m.status === "live") ? "Group Stage" : (prev?.meta?.stage || "Group Stage"),
            updated: new Date().toISOString(), groupStageComplete, dataSource: "api-football",
            squadCount },   // 0 ⇒ nation squads not published yet (pre-tournament), not a bug
    groups,
    thirdPlaceRace: race,
    remainingFixtures,
    matches,
    bracket,
    scorers, assists, discipline,
    teams, players, clubWatch,
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
  for (const t of Object.values(teams)) {
    if (!t._id) continue;
    try {
      const s = await apiGet(env, "/teams/statistics", { ...base, team: t._id });
      const st = Array.isArray(s) ? s[0] : s;     // /teams/statistics returns an object
      if (!st) continue;
      const y = sumCardBuckets(st.cards?.yellow), r = sumCardBuckets(st.cards?.red);
      t.cleanSheets = st.clean_sheet?.total ?? t.cleanSheets;
      t.formStr = st.form || t.formStr;
      if (rowByCode[t.code]) { rowByCode[t.code].yellow = y; rowByCode[t.code].red = r; }
    } catch { /* leave defaults */ }
  }
}

// ── nation squads (fetched once, then persisted) → teams[].squad + clubWatch join ──
async function ensureNationSquads(env, base, teams, players) {
  for (const t of Object.values(teams)) {
    if (!t._id || (t.squad && t.squad.length)) continue;   // already have it
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
  }
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

// ── deep player drill-in: stats per competition + bio + transfers + trophies ──
// Profiles/transfers/trophies are static-ish → fetched once per player and persisted.
// Capped per poll so cost stays bounded; the set fills in over successive polls.
async function enrichPlayers(env, base, ids, players, cfg, dir, cap = 25) {
  let budget = cap;
  for (const id of ids) {
    if (budget <= 0) break;
    const existing = players[id];
    if (existing?._enriched) continue;       // done already (persisted)
    budget--;
    try {
      const statsResp = await apiGet(env, "/players", { id, season: base.season });
      const rec = normPlayer(statsResp, cfg.league, dir) || {};
      if (!rec.code && existing?.code) rec.code = existing.code;   // keep nation code from squad seed
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
      players[id] = { ...(existing || {}), ...rec, career, honours, _enriched: true };
    } catch { /* skip this player this round */ }
  }
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

// ── woven-in progression: mark group matches that move the last-8 race + one-liner ──
function annotateProgression(matches, groups, remainingFixtures, teams, race) {
  const contender = new Set(race.map((t) => t.code));
  const posByCode = {};
  for (const rows of Object.values(groups)) rows.forEach((r, i) => (posByCode[r.code] = i + 1));
  const engineSnap = { groups, remainingFixtures, teams };
  for (const m of matches) {
    if (m.stage !== "Group Stage") continue;
    const codes = [m.home.code, m.away.code];
    const affects = codes.some((c) => contender.has(c) || posByCode[c] >= 3 || posByCode[c] === 2);
    m.affectsCut = affects;
    if (affects && (m.status === "live" || m.status === "ht")) {
      const focus = codes.find((c) => contender.has(c)) || codes.find((c) => posByCode[c] >= 3) || codes[0];
      try { m.progressionLine = plainEnglish(engineSnap, focus, ANNEXC); } catch {}
    }
  }
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

export default {
  // Cron entrypoint.
  async scheduled(event, env, ctx) {
    const work = (async () => {
      const prev = await readSnapshot(env);
      const meta = (await env.SNAPSHOT.get(META_KEY, "json")) || { lastFull: 0, lastLive: 0 };
      const now = Date.now();
      const baselineMs = (parseInt(env.BASELINE_INTERVAL_MIN || "360", 10)) * 60e3;
      const liveMs = (parseInt(env.LIVE_INTERVAL_SEC || "75", 10)) * 1e3;
      const live = inLiveWindow(prev);

      const dueFull = now - meta.lastFull >= baselineMs;
      const dueLive = live && now - meta.lastLive >= liveMs;
      if (!dueFull && !dueLive) return; // cheap skip — no API calls

      try {
        const snap = await buildSnapshot(env, prev, !dueFull /* liveOnly when only the live tick is due */);
        await writeSnapshot(env, snap);
        await env.SNAPSHOT.put(META_KEY, JSON.stringify({
          lastFull: dueFull ? now : meta.lastFull,
          lastLive: now,
        }));
      } catch (err) {
        console.error("poll failed:", err.message);
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
  async fetch(request, env) {
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
    // Everything else: the static /web app.
    return env.ASSETS.fetch(request);
  },
};
