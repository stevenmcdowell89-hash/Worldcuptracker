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

import { thirdPlaceTable, recompute, verdicts } from "../web/js/engine.js";

const API = "https://v3.football.api-sports.io";
const KV_KEY = "latest.json";
const META_KEY = "poll-meta";

// ── tiny API client ──
async function apiGet(env, path, params = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { "x-apisports-key": env.APIFOOTBALL_KEY } });
  if (!r.ok) throw new Error(`API-Football ${path} → ${r.status}`);
  const body = await r.json();
  if (body.errors && Object.keys(body.errors).length) {
    throw new Error(`API-Football ${path}: ${JSON.stringify(body.errors)}`);
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
function normStandings(resp) {
  // resp[0].league.standings = [[row,...] per group]
  const groups = {};
  const table = resp?.[0]?.league?.standings || [];
  for (const groupRows of table) {
    for (const r of groupRows) {
      const letter = (r.group || "Group ?").replace(/^Group\s+/i, "").trim().toUpperCase();
      const row = {
        code: r.team?.code || String(r.team?.id),
        name: r.team?.name,
        P: r.all?.played ?? 0, W: r.all?.win ?? 0, D: r.all?.draw ?? 0, L: r.all?.lose ?? 0,
        GF: r.all?.goals?.for ?? 0, GA: r.all?.goals?.against ?? 0,
        GD: r.goalsDiff ?? 0, Pts: r.points ?? 0,
        yellow: 0, red: 0,   // filled from discipline aggregation if available
      };
      row.GD = row.GF - row.GA;
      (groups[letter] = groups[letter] || []).push(row);
    }
  }
  return groups;
}

function normFixtures(resp) {
  // Split into played/live matches and not-yet-played remaining group fixtures.
  const matches = [], remainingFixtures = [];
  for (const f of resp || []) {
    const st = f.fixture?.status?.short;
    const live = ["1H", "2H", "ET", "P", "LIVE"].includes(st);
    const ht = st === "HT";
    const done = ["FT", "AET", "PEN"].includes(st);
    const home = f.teams?.home, away = f.teams?.away;
    const isGroup = (f.league?.round || "").toLowerCase().includes("group");
    const groupLetter = (f.league?.round?.match(/Group\s+([A-L])/i) || [])[1]?.toUpperCase();
    const base = {
      id: String(f.fixture?.id),
      stage: isGroup ? "Group Stage" : f.league?.round,
      group: groupLetter,
      venue: f.fixture?.venue?.name,
      kickoff: f.fixture?.date,
      home: { code: home?.code || String(home?.id), score: f.goals?.home },
      away: { code: away?.code || String(away?.id), score: f.goals?.away },
    };
    if (!done && !live && !ht) {
      base.status = "scheduled";
      if (isGroup && groupLetter) {
        remainingFixtures.push({
          id: base.id, group: groupLetter, home: base.home.code, away: base.away.code,
          kickoff: base.kickoff, affectsThird: true,
        });
      }
      matches.push(base);
    } else {
      base.status = live ? "live" : ht ? "ht" : "ft";
      if (live || ht) base.minute = (f.fixture?.status?.elapsed ?? "") + "'";
      matches.push(base);
    }
  }
  return { matches, remainingFixtures };
}

function normEvents(resp) {
  return (resp || []).map((e) => ({
    min: `${e.time?.elapsed ?? ""}'`,
    side: "h", // caller fixes side by comparing team id; left as h by default
    _teamId: e.team?.id,
    type: e.type === "Goal" ? "goal" : e.type === "Card" ? (e.detail === "Red Card" ? "red" : "yellow") : e.type === "subst" ? "subst" : "goal",
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
async function buildSnapshot(env, prev, liveOnly) {
  const cfg = CFG(env);
  const base = { league: cfg.league, season: cfg.season };

  // Standings + all fixtures (cheap, run every poll).
  const groups = normStandings(await apiGet(env, "/standings", base));
  for (const g of Object.keys(groups)) groups[g].sort((a, b) => b.Pts - a.Pts || b.GD - a.GD || b.GF - a.GF);
  const { matches, remainingFixtures } = normFixtures(await apiGet(env, "/fixtures", base));

  // Live detail only for in-play fixtures (events/stats/lineups).
  for (const m of matches.filter((x) => x.status === "live" || x.status === "ht")) {
    try { m.events = normEvents(await apiGet(env, "/fixtures/events", { fixture: m.id })); } catch {}
    try { m.stats = normStats(await apiGet(env, "/fixtures/statistics", { fixture: m.id })); } catch {}
    try {
      const lu = await apiGet(env, "/fixtures/lineups", { fixture: m.id });
      if (lu?.length) m.lineups = normLineups(lu);
    } catch {}
  }

  // Leaderboards + teams/players only on a full (baseline) poll — reuse prev when liveOnly.
  let scorers = prev?.scorers || [], assists = prev?.assists || [], discipline = prev?.discipline || [];
  let teams = prev?.teams || {}, players = prev?.players || {};
  if (!liveOnly) {
    try { scorers = (await apiGet(env, "/players/topscorers", base)).map(normScorer); } catch {}
    try { assists = (await apiGet(env, "/players/topassists", base)).map(normAssist); } catch {}
    ({ teams, players } = buildTeamsAndPlayers(groups, prev));
  }

  // Engine pre-derivation (engine-ready snapshot).
  const snapForEngine = { groups, remainingFixtures, teams };
  const race = verdicts(snapForEngine);

  // Player Watch precompute (no per-user calls).
  let clubWatch = prev?.clubWatch || {};
  if (!liveOnly) {
    try { clubWatch = await buildClubWatch(env, cfg, teams, players, remainingFixtures); } catch {}
  }

  const groupStageComplete = remainingFixtures.length === 0;
  return {
    meta: { stage: matches.find((m) => m.status === "live") ? "Group Stage" : (prev?.meta?.stage || "Group Stage"),
            updated: new Date().toISOString(), groupStageComplete, dataSource: "api-football" },
    groups,
    thirdPlaceRace: race,
    remainingFixtures,
    matches,
    bracket: prev?.bracket || { rounds: ["R32", "R16", "QF", "SF", "Final"], matches: [] },
    scorers, assists, discipline,
    teams, players, clubWatch,
  };
}

function normScorer(s) {
  const st = s.statistics?.[0];
  return { playerId: s.player?.id, code: st?.team?.code || "", name: s.player?.name, team: st?.team?.name, g: st?.goals?.total ?? 0, a: st?.goals?.assists ?? 0 };
}
function normAssist(s) {
  const st = s.statistics?.[0];
  return { playerId: s.player?.id, code: st?.team?.code || "", name: s.player?.name, team: st?.team?.name, a: st?.goals?.assists ?? 0, g: st?.goals?.total ?? 0 };
}
function normLineups(resp) {
  const side = (L) => ({
    formation: L.formation, coach: L.coach?.name,
    xi: (L.startXI || []).map((p) => ({ num: p.player?.number, name: p.player?.name, pos: p.player?.pos, grid: p.player?.grid, playerId: p.player?.id })),
    subs: (L.substitutes || []).map((p) => ({ num: p.player?.number, name: p.player?.name, pos: p.player?.pos, playerId: p.player?.id })),
  });
  return { h: side(resp[0]), a: resp[1] ? side(resp[1]) : undefined };
}
function buildTeamsAndPlayers(groups, prev) {
  const teams = {}, players = prev?.players || {};
  for (const [g, rows] of Object.entries(groups)) {
    rows.forEach((r) => {
      teams[r.code] = {
        code: r.code, name: r.name, group: g, P: r.P, W: r.W, D: r.D, L: r.L, GF: r.GF, GA: r.GA,
        form: prev?.teams?.[r.code]?.form || [], squad: prev?.teams?.[r.code]?.squad || [],
        verdict: prev?.teams?.[r.code]?.verdict,
      };
    });
  }
  return { teams, players };
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

// ── debug/admin helpers (temporary — used to verify ids, then removed) ──
function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}
// Optional guard: if DEBUG_TOKEN is set, require ?t=<token>. Never exposes the API key.
function guarded(env, url) {
  if (!env.DEBUG_TOKEN) return true;
  return url.searchParams.get("t") === env.DEBUG_TOKEN;
}

// Probes the live API to confirm the World Cup league id + 2026 season and the six
// club team ids, WITHOUT trusting the configured guesses. Returns only public
// metadata (ids, names, seasons) — the key is never echoed.
async function debugProbe(env) {
  if (!env.APIFOOTBALL_KEY) return jsonResp({ error: "APIFOOTBALL_KEY secret not set on this Worker" }, 400);
  const cfg = CFG(env);
  const out = { configured: { league: cfg.league, season: cfg.season, clubs: cfg.clubs }, findings: {} };

  // 1) World Cup league + which seasons it covers
  try {
    const leagues = await apiGet(env, "/leagues", { search: "World Cup" });
    out.findings.worldCupLeagues = leagues
      .filter((l) => /world cup/i.test(l.league?.name) && /world|international/i.test(l.country?.name || "World"))
      .slice(0, 8)
      .map((l) => ({ id: l.league?.id, name: l.league?.name, type: l.league?.type,
        country: l.country?.name, seasons: (l.seasons || []).map((s) => s.year) }));
    const wc = out.findings.worldCupLeagues.find((l) => /^fifa world cup$/i.test(l.name)) || out.findings.worldCupLeagues[0];
    out.findings.suggestedLeagueId = wc?.id ?? null;
    out.findings.seasonAvailable = wc ? wc.seasons.includes(Number(cfg.season)) : null;
  } catch (e) { out.findings.leaguesError = e.message; }

  // 2) confirm each configured club id, and suggest the id if the name doesn't match
  out.findings.clubs = {};
  for (const [slug, club] of Object.entries(cfg.clubs)) {
    const entry = { configuredId: club.id, expectedName: club.name };
    try {
      const byId = await apiGet(env, "/teams", { id: club.id });
      entry.idResolvesTo = byId?.[0]?.team?.name ?? null;
      entry.match = entry.idResolvesTo && entry.idResolvesTo.toLowerCase().includes(club.name.split(" ")[0].toLowerCase());
      if (!entry.match) {
        const byName = await apiGet(env, "/teams", { search: club.name });
        entry.suggestions = (byName || []).slice(0, 4).map((t) => ({ id: t.team?.id, name: t.team?.name, country: t.team?.country }));
      }
    } catch (e) { entry.error = e.message; }
    out.findings.clubs[slug] = entry;
  }
  return jsonResp(out);
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

  // Serve the snapshot (Pages can proxy /data/latest.json here).
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/data/latest.json") {
      const snap = await env.SNAPSHOT.get(KV_KEY);
      if (!snap) return new Response(JSON.stringify({ error: "no snapshot yet" }), { status: 503, headers: { "content-type": "application/json" } });
      return new Response(snap, {
        headers: { "content-type": "application/json", "cache-control": "public, max-age=30", "access-control-allow-origin": "*" },
      });
    }
    if (url.pathname === "/healthz") return new Response("ok");

    // TEMPORARY id-verification endpoint (remove after ids are locked in).
    if (url.pathname === "/debug") {
      if (!guarded(env, url)) return jsonResp({ error: "forbidden (set ?t=<DEBUG_TOKEN>)" }, 403);
      return debugProbe(env);
    }
    // Force a full poll now (don't wait for cron / live-gate) to seed KV. Guarded.
    if (url.pathname === "/admin/refresh") {
      if (!guarded(env, url)) return jsonResp({ error: "forbidden (set ?t=<DEBUG_TOKEN>)" }, 403);
      try {
        const snap = await buildSnapshot(env, await readSnapshot(env), false);
        await writeSnapshot(env, snap);
        await env.SNAPSHOT.put(META_KEY, JSON.stringify({ lastFull: Date.now(), lastLive: Date.now() }));
        return jsonResp({ ok: true, updated: snap.meta.updated, groups: Object.keys(snap.groups).length,
          matches: snap.matches.length, remaining: snap.remainingFixtures.length,
          thirdPlaceRace: snap.thirdPlaceRace.map((t) => `${t.code}:${t.status}`) });
      } catch (e) { return jsonResp({ ok: false, error: e.message }, 500); }
    }

    return new Response("WC26 Worker", { status: 200 });
  },
};
