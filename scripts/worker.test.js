// Worker normalisation pipeline test. The live API can't be hit from CI, so we mock
// global.fetch with canned API-Football v3 responses and drive buildSnapshot end to
// end, asserting the snapshot shape the frontend depends on. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot, resultsDigest, todayDigest, fixtureLabel, normPlayer } from "../worker/index.js";

// ── canned API-Football responses keyed by path (+ a little param awareness) ──
const NATIONS = {
  A: [["ENG", 100], ["USA", 101], ["SEN", 102], ["IRN", 103]],
  B: [["ARG", 110], ["AUS", 111], ["POL", 112], ["RSA", 113]],
};
const CODES = { 100: "ENG", 101: "USA", 102: "SEN", 103: "IRN", 110: "ARG", 111: "AUS", 112: "POL", 113: "RSA" };
// /teams (league+season) is the only place codes + logos live (mirrors the real API).
const teamsLeague = () => Object.entries(CODES).map(([id, code]) =>
  ({ team: { id: +id, name: code, code, logo: `https://logo/${code}.png`, national: true } }));
function standings() {
  // standings team objects carry NO code — only {id,name,logo} — exactly like the live API
  const mk = (id, pts, gf, ga) => ({ team: { id, name: CODES[id], logo: `https://logo/${CODES[id]}.png` }, points: pts, goalsDiff: gf - ga,
    all: { played: 2, win: pts >= 4 ? 2 : pts >= 3 ? 1 : 0, draw: pts === 1 ? 1 : 0, lose: pts === 0 ? 2 : 0, goals: { for: gf, against: ga } } });
  const table = [
    [mk(100, 6, 4, 1), mk(101, 3, 3, 2), mk(102, 3, 3, 3), mk(103, 0, 1, 5)].map((r) => ({ ...r, group: "Group A" })),
    [mk(110, 6, 5, 1), mk(111, 3, 2, 2), mk(112, 1, 2, 3), mk(113, 1, 1, 4)].map((r) => ({ ...r, group: "Group B" })),
    // the meta block the live API includes — must be skipped, not treated as a 3rd group
    [{ team: { id: 102, name: "SEN" }, group: "Ranking of third-placed teams", points: 3, all: { played: 2, goals: { for: 3, against: 3 } } }],
  ];
  return [{ league: { standings: table } }];
}
function fixtures() {
  const f = (id, round, st, hId, hCode, aId, aCode, hg, ag, date, pens) => ({
    fixture: { id, date, status: { short: st, elapsed: st === "1H" ? 30 : null }, venue: { name: "Stadium" } },
    league: { round }, teams: { home: { id: hId, code: hCode }, away: { id: aId, code: aCode } }, goals: { home: hg, away: ag },
    score: pens ? { penalty: { home: pens[0], away: pens[1] } } : { penalty: { home: null, away: null } },
  });
  // round is "Group Stage - N" with NO group letter — group comes from team membership
  return [
    f(5001, "Group Stage - 2", "FT", 100, "ENG", 102, "SEN", 2, 1, "2026-06-20T16:00:00Z"),   // finished, has detail
    f(5002, "Group Stage - 3", "1H", 110, "ARG", 111, "AUS", 1, 0, "2026-06-25T16:00:00Z"),   // live
    f(5003, "Group Stage - 3", "NS", 100, "ENG", 101, "USA", null, null, "2026-06-26T16:00:00Z"), // scheduled → remaining
    // knockout: level after ET, decided on penalties (teams outside the group standings)
    f(5004, "Round of 32", "PEN", 900, null, 901, null, 1, 1, "2026-06-29T16:00:00Z", [4, 2]),
  ];
}
const events = (homeAway) => [
  { time: { elapsed: 12 }, team: { id: homeAway[0] }, type: "Goal", detail: "Normal Goal", player: { name: "H. Home" }, assist: { name: "A. Assist" } },
  { time: { elapsed: 70 }, team: { id: homeAway[1] }, type: "Card", detail: "Yellow Card", player: { name: "V. Visitor" } },
];
const statistics = (hId, aId) => [
  { team: { id: hId }, statistics: [{ type: "Ball Possession", value: "55%" }, { type: "Total Shots", value: 12 }, { type: "Shots on Goal", value: 5 }] },
  { team: { id: aId }, statistics: [{ type: "Ball Possession", value: "45%" }, { type: "Total Shots", value: 8 }, { type: "Shots on Goal", value: 3 }] },
];
const lineups = (hId, aId) => [
  { team: { id: aId }, formation: "4-3-3", coach: { name: "Coach A" }, startXI: [{ player: { id: 2001, number: 9, name: "Away Striker", pos: "F", grid: "4:2" } }], substitutes: [] },
  { team: { id: hId }, formation: "4-2-3-1", coach: { name: "Coach H" }, startXI: [{ player: { id: 1001, number: 8, name: "Home Mid", pos: "M", grid: "3:2" } }], substitutes: [] },
];
const fixturePlayers = (hId, aId) => [
  { team: { id: hId }, players: [{ player: { id: 1001, name: "Home Mid" }, statistics: [{ games: { rating: "8.3", minutes: 90 } }] }] },
  { team: { id: aId }, players: [{ player: { id: 2001, name: "Away Striker" }, statistics: [{ games: { rating: "6.9", minutes: 90 } }] }] },
];
const topscorers = [{ player: { id: 1001, name: "Home Mid" }, statistics: [{ team: { id: 100, name: "England" }, goals: { total: 4, assists: 1 } }] }];
const topassists = [{ player: { id: 1001, name: "Home Mid" }, statistics: [{ team: { id: 100, name: "England" }, goals: { total: 4, assists: 3 } }] }];
const topcards = (n) => [{ player: { id: 2001, name: "Away Striker" }, statistics: [{ team: { id: 102, name: "Senegal" }, cards: { yellow: n, red: 0 } }] }];
const teamStats = () => ({ form: "WWL", clean_sheet: { total: 1 }, cards: { yellow: { "0-15": { total: 2 }, "46-60": { total: 1 } }, red: { "76-90": { total: 1 } } } });
function squadFor(teamId) {
  if (teamId === 33) return [{ id: 1001, name: "Home Mid", number: 8, position: "Midfielder" }]; // Man Utd → intersects ENG
  // nation squads
  const allNations = Object.values(NATIONS).flat();
  const n = allNations.find(([, id]) => id === teamId);
  if (n) return [{ id: teamId * 10 + 1, name: `${n[0]} Player`, number: 10, position: "Forward" },
    ...(teamId === 100 ? [{ id: 1001, name: "Home Mid", number: 8, position: "Midfielder" }] : [])];
  return []; // other clubs (Liverpool/Arsenal/etc.) empty in this fixture
}
const playerDeep = (id) => [{
  player: { id: +id, name: "Home Mid", age: 25, position: "Midfielder" },
  statistics: [
    { league: { id: 1, name: "World Cup" }, team: { code: "ENG" }, games: { appearences: 3, minutes: 270, position: "Midfielder", rating: "8.0" }, goals: { total: 2, assists: 1 }, shots: { total: 5 }, passes: { key: 4 }, cards: { yellow: 1, red: 0 } },
    { league: { id: 39, name: "Premier League" }, team: { name: "Manchester United" }, games: { appearences: 30, minutes: 2600, rating: "7.4" }, goals: { total: 9, assists: 7 }, cards: { yellow: 4, red: 0 } },
  ],
}];

function cannedFetch(url) {
  const u = new URL(url);
  const p = u.pathname, q = u.searchParams;
  const team = +q.get("team");
  // Guardian Open Platform (live commentary) — separate host
  if (u.hostname === "content.guardianapis.com") {
    if (p === "/search") return { results: [
      { id: "football/live/2026/spain-v-brazil", type: "liveblog", webTitle: "Spain v Brazil: World Cup 2026 – live", webUrl: "https://www.theguardian.com/y", webPublicationDate: "2026-06-25T13:00:00Z", fields: { liveBloggingNow: "false" } },
      { id: "football/live/2026/argentina-v-australia", type: "liveblog", webTitle: "Argentina v Australia: World Cup 2026 – live", webUrl: "https://www.theguardian.com/x", webPublicationDate: "2026-06-25T15:30:00Z", fields: { liveBloggingNow: "true" } },
    ] };
    // Real Open Platform shape: qualified selectors ("body:latest:30") return blocks
    // under requestedBodyBlocks keyed by the selector — NOT blocks.body (that's only
    // for plain "body"). Mirroring this caught the empty-commentary bug on match day.
    return { content: { webUrl: "https://www.theguardian.com" + p, fields: { liveBloggingNow: "true" },
      blocks: { totalBodyBlocks: 2, requestedBodyBlocks: { "body:latest:30": [
        { firstPublishedDate: "2026-06-25T16:20:00Z", title: "GOAL!", bodyTextSummary: "Argentina lead.", attributes: { keyEvent: true } },
        { firstPublishedDate: "2026-06-25T16:05:00Z", title: "", bodyHtml: "<p>Lively start in New Jersey.</p>", attributes: {} },
      ] } } } };
  }
  const data = {
    "/standings": standings(),
    "/fixtures": fixtures(),
    "/teams": teamsLeague(),
    "/players/topscorers": topscorers,
    "/players/topassists": topassists,
    "/players/topyellowcards": topcards(5),
    "/players/topredcards": topcards(1),
  }[p];
  if (data) return data;
  if (p === "/fixtures/events") return q.get("fixture") === "5002" ? events([110, 111]) : events([100, 102]);
  if (p === "/fixtures/statistics") return q.get("fixture") === "5002" ? statistics(110, 111) : statistics(100, 102);
  if (p === "/fixtures/lineups") return q.get("fixture") === "5002" ? lineups(110, 111) : lineups(100, 102);
  if (p === "/fixtures/players") return fixturePlayers(100, 102);
  if (p === "/teams/statistics") return teamStats();
  if (p === "/players/squads") return [{ players: squadFor(team) }];
  if (p === "/players") return playerDeep(q.get("id"));
  if (p === "/transfers") return [{ transfers: [{ date: "2022-07-01", type: "€", teams: { in: { name: "Manchester United" }, out: { name: "Old Club" } } }] }];
  if (p === "/trophies") return [{ league: "Premier League", season: "2024", place: "Winner" }, { league: "FA Cup", season: "2023", place: "2nd" }];
  return [];
}

let snap;
test("setup: drive buildSnapshot with a mocked API", async () => {
  globalThis.fetch = async (url) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ response: cannedFetch(url) }) });
  snap = await buildSnapshot({ APIFOOTBALL_KEY: "test", WC_LEAGUE_ID: "1", WC_SEASON: "2026" }, null, false);
  assert.ok(snap);
});

test("groups: 'Ranking of third-placed teams' block is skipped (12-group parse)", () => {
  assert.deepEqual(Object.keys(snap.groups).sort(), ["A", "B"]);  // the meta block excluded
  assert.equal(snap.groups.A.length, 4);
});

test("codes resolved via /teams (standings only had ids), and crests exposed", () => {
  assert.equal(snap.groups.A[0].code, "ENG");            // leader, code from directory not id
  Object.values(snap.groups).flat().forEach((r) => assert.match(r.code, /^[A-Z]{3}$/));
  assert.equal(snap.crests.ENG, "https://logo/ENG.png"); // crest image exposed for the frontend
});

test("groups sorted and carry fair-play cards", () => {
  const carded = Object.values(snap.groups).flat().filter((r) => r.yellow > 0);
  assert.ok(carded.length > 0, "fair-play cards populated from /teams/statistics");
  Object.values(snap.groups).flat().forEach((r) => assert.equal(r._id, undefined)); // internal stripped
});

test("third-place race derived for both groups", () => {
  assert.equal(snap.thirdPlaceRace.length, 2);
  snap.thirdPlaceRace.forEach((t) => assert.ok(["qualified", "in", "sweating", "out", "eliminated"].includes(t.status)));
});

test("matches: events mapped to correct side, FT ratings merged", () => {
  const ft = snap.matches.find((m) => m.id === "5001");
  assert.equal(ft.status, "ft");
  assert.ok(ft.lineups, "FT match has lineups");
  const goal = ft.events.find((e) => e.type === "goal");
  const card = ft.events.find((e) => e.type === "yellow");
  assert.equal(goal.side, "h");                          // home team scored
  assert.equal(card.side, "a");                          // away team booked
  const rated = [...(ft.lineups.h?.xi || []), ...(ft.lineups.a?.xi || [])].filter((p) => p.rating != null);
  assert.ok(rated.length > 0, "player ratings merged at FT");
});

test("stoppage time: status.extra → '90+3' minute; event time.extra → '90+2'", async () => {
  globalThis.fetch = async (url) => {
    const p = new URL(url).pathname;
    if (p === "/fixtures") return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ response: [{
      fixture: { id: 8001, date: "2026-06-20T16:00:00Z", status: { short: "2H", elapsed: 90, extra: 3 }, venue: { name: "Stadium" } },
      league: { round: "Group Stage - 1" }, teams: { home: { id: 100, code: "ENG" }, away: { id: 102, code: "SEN" } },
      goals: { home: 1, away: 0 }, score: { penalty: { home: null, away: null } } }] }) };
    if (p === "/fixtures/events") return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ response: [
      { time: { elapsed: 90, extra: 2 }, team: { id: 100 }, type: "Goal", detail: "Normal Goal", player: { name: "Late Winner" } } ] }) };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ response: cannedFetch(url) }) };
  };
  const s = await buildSnapshot({ APIFOOTBALL_KEY: "t", WC_LEAGUE_ID: "1", WC_SEASON: "2026" }, null, false);
  const m = s.matches.find((x) => String(x.id) === "8001");
  assert.equal(m.minute, "90+3'", "clock shows added time, not a frozen 90");
  assert.equal(m.events.find((e) => e.type === "goal").min, "90+2'", "event minute carries added time");
});

test("live match detail keeps last-good when a poll returns empty (no flicker)", async () => {
  // Poll 1: healthy — the live match (5002) has lineups, events, stats.
  globalThis.fetch = async (url) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ response: cannedFetch(url) }) });
  const good = await buildSnapshot({ APIFOOTBALL_KEY: "t", WC_LEAGUE_ID: "1", WC_SEASON: "2026" }, null, false);
  const live1 = good.matches.find((m) => m.status === "live");
  assert.ok(live1?.lineups?.h?.xi?.length && live1.events.length && live1.stats.length, "live match fully detailed on a healthy poll");

  // Poll 2: the per-match detail endpoints come back empty (rate-limit/transient).
  // The live match must keep its lineups/events/stats from the previous snapshot.
  globalThis.fetch = async (url) => {
    const p = new URL(url).pathname;
    const empty = p === "/fixtures/lineups" || p === "/fixtures/events" || p === "/fixtures/statistics";
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ response: empty ? [] : cannedFetch(url) }) };
  };
  const degraded = await buildSnapshot({ APIFOOTBALL_KEY: "t", WC_LEAGUE_ID: "1", WC_SEASON: "2026" }, good, false);
  const live2 = degraded.matches.find((m) => m.status === "live");
  assert.ok(live2.lineups?.h?.xi?.length, "lineups survive an empty poll");
  assert.ok(live2.events.length, "events survive an empty poll");
  assert.ok(live2.stats.length, "stats survive an empty poll");
});

test("remaining fixtures + live match detected", () => {
  assert.equal(snap.remainingFixtures.length, 1);
  assert.equal(snap.remainingFixtures[0].id, "5003");
  assert.ok(snap.matches.some((m) => m.status === "live"));
});

test("penalty shootout: tally captured, knockout slot assigned, group games untouched", () => {
  const ko = snap.matches.find((m) => m.id === "5004");
  assert.equal(ko.status, "ft");                       // PEN = finished
  assert.deepEqual(ko.pens, { h: 4, a: 2 });
  assert.equal(ko.slot, "R32-M73");                    // official FIFA numbering via kickoff order
  const grp = snap.matches.find((m) => m.id === "5001");
  assert.equal(grp.pens, undefined);                   // null penalty block → no pens field
});

test("discipline leaderboard populated", () => {
  assert.ok(snap.discipline.length > 0);
  assert.ok(snap.discipline[0].y >= 0);
});

test("teams: squad, verdict, rank", () => {
  const eng = snap.teams.ENG;
  assert.ok(eng.squad.length > 0, "nation squad fetched");
  assert.ok(["qualified", "in", "sweating", "out", "eliminated"].includes(eng.verdict));
  assert.equal(eng.rank, 1);
  assert.equal(eng._id, undefined);
});

test("Player Watch intersects club squad × nation roster", () => {
  const mu = snap.clubWatch["manchester-united"];
  assert.ok(mu, "Man Utd present");
  assert.ok(mu.players.some((p) => String(p.playerId) === "1001"), "shared player in MU contingent");
  assert.ok("liverpool" in snap.clubWatch);             // empty contingent is valid
});

test("deep player enrichment: tournament + season + career + honours", () => {
  const p = snap.players["1001"];
  assert.ok(p);
  assert.equal(p.tournament.g, 2);
  assert.ok(p.season.some((s) => s.comp === "Premier League"));
  assert.ok(p.career.length > 0);
  assert.ok(p.honours.some((h) => h.title === "Premier League"));   // only "Winner" trophies
  assert.ok(!p.honours.some((h) => h.title === "FA Cup"));          // 2nd place excluded
});

test("pre-kickoff: no World Cup entry → tournament stats are zero, club stats never leak", () => {
  // Mirrors the real pre-kickoff case: /players?season=<WC season> returns several
  // non-World-Cup competitions (a national-team friendly/qualifier that has a few
  // appearances, plus a club row) but NO World Cup league row yet. The tournament
  // block must stay 0 no matter which competition happens to be listed first.
  const resp = [{
    player: { id: 999, name: "Jonathan David", age: 26, position: "Attacker" },
    statistics: [
      { league: { id: 10, name: "Friendlies" }, team: { name: "Canada" }, games: { appearences: 4, position: "Attacker" }, goals: { total: 2, assists: 1 } },
      { league: { id: 135, name: "Serie A" }, team: { name: "Juventus" }, games: { appearences: 35 }, goals: { total: 18, assists: 6 } },
    ],
  }];
  const p = normPlayer(resp, "1", {});             // WC_LEAGUE_ID = "1"
  assert.equal(p.tournament.apps, 0);
  assert.equal(p.tournament.g, 0);
  assert.equal(p.tournament.a, 0);
  assert.ok(p.season.some((s) => s.comp === "Serie A" && s.apps === 35));   // other comps still surface under season[]
});

test("lineups load pre-match once kickoff is imminent (match still 'scheduled')", async () => {
  const soon = new Date(Date.now() + 30 * 60e3).toISOString();   // kickoff in 30 minutes
  globalThis.fetch = async (url) => {
    const p = new URL(url).pathname;
    const resp = p === "/fixtures"
      ? [{ fixture: { id: 7001, date: soon, status: { short: "NS", elapsed: null }, venue: { name: "Stadium" } },
           league: { round: "Group Stage - 1" }, teams: { home: { id: 100, code: "ENG" }, away: { id: 102, code: "SEN" } },
           goals: { home: null, away: null }, score: { penalty: { home: null, away: null } } }]
      : cannedFetch(url);
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ response: resp }) };
  };
  const s = await buildSnapshot({ APIFOOTBALL_KEY: "t", WC_LEAGUE_ID: "1", WC_SEASON: "2026" }, null, false);
  const m = s.matches.find((x) => String(x.id) === "7001");
  assert.ok(m, "imminent scheduled match present");
  assert.equal(m.status, "scheduled");
  assert.ok(m.lineups?.h?.xi?.length, "home XI populated before kickoff");
});

test("bracket built with full structure", () => {
  assert.equal(snap.bracket.matches.filter((m) => m.rd === "R32").length, 16);
  assert.equal(snap.bracket.matches.length, 31);
});

test("team directory survives a /teams outage via the cached copy (no grey-square ids)", async () => {
  const store = new Map();
  const kv = {
    get: async (k, t) => { const v = store.get(k); return v == null ? null : (t === "json" ? JSON.parse(v) : v); },
    put: async (k, v) => { store.set(k, v); },
    list: async () => ({ keys: [] }),
  };
  const env = { APIFOOTBALL_KEY: "t", WC_LEAGUE_ID: "1", WC_SEASON: "2026", SNAPSHOT: kv };
  // Poll 1: /teams healthy → directory (codes + crests) seeded into KV.
  globalThis.fetch = async (url) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ response: cannedFetch(url) }) });
  const good = await buildSnapshot(env, null, false);
  assert.equal(good.crests.ENG, "https://logo/ENG.png");

  // Poll 2: /teams fails (rate-limit/outage). Must reuse the cached directory rather
  // than collapse every team to a bare numeric id with no crest.
  globalThis.fetch = async (url) => {
    if (new URL(url).pathname === "/teams") return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({}) };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ response: cannedFetch(url) }) };
  };
  const degraded = await buildSnapshot(env, good, false);
  assert.equal(degraded.crests.ENG, "https://logo/ENG.png", "crest survived the /teams outage");
  assert.ok(Object.values(degraded.groups).flat().some((r) => r.code === "ENG"), "codes still resolve — not numeric ids");
});

test("guardian commentary attaches to live matches when GUARDIAN_KEY is set", async () => {
  globalThis.fetch = async (url) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ response: cannedFetch(url) }) });
  const s = await buildSnapshot({ APIFOOTBALL_KEY: "t", WC_LEAGUE_ID: "1", WC_SEASON: "2026", GUARDIAN_KEY: "g" }, null, false);
  const live = s.matches.find((m) => m.status === "live");
  assert.ok(live.commentary?.length, "live match has commentary blocks");
  assert.equal(live.commentary[0].title, "GOAL!");           // newest-first
  assert.equal(live.commentary[0].key, true);
  assert.equal(live.commentarySource, "The Guardian");
  assert.match(live.commentaryUrl, /argentina-v-australia/);   // time+name matching beat the 13:00 decoy
});

test("no GUARDIAN_KEY → no commentary (graceful)", async () => {
  globalThis.fetch = async (url) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ response: cannedFetch(url) }) });
  const s = await buildSnapshot({ APIFOOTBALL_KEY: "t", WC_LEAGUE_ID: "1", WC_SEASON: "2026" }, null, false);
  const live = s.matches.find((m) => m.status === "live");
  assert.ok(!live.commentary, "no commentary without a key");
});

test("empty /fixtures with a schedule on record → poll fails (last good kept)", async () => {
  globalThis.fetch = async (url) => ({ ok: true, status: 200, headers: { get: () => null },
    json: async () => ({ response: new URL(url).pathname === "/fixtures" ? [] : cannedFetch(url) }) });
  // a degraded fixtures response must not produce a snapshot that flips the phase
  await assert.rejects(
    buildSnapshot({ APIFOOTBALL_KEY: "t", WC_LEAGUE_ID: "1", WC_SEASON: "2026" }, snap, false),
    /fixtures returned empty/,
  );
});

test("empty /standings with groups on record → poll fails (last good kept)", async () => {
  // API-Football briefly serves an empty standings table while rebuilding after a
  // result; it must not blank out the groups (tables, race, bracket seeding).
  globalThis.fetch = async (url) => ({ ok: true, status: 200, headers: { get: () => null },
    json: async () => ({ response: new URL(url).pathname === "/standings" ? [] : cannedFetch(url) }) });
  await assert.rejects(
    buildSnapshot({ APIFOOTBALL_KEY: "t", WC_LEAGUE_ID: "1", WC_SEASON: "2026" }, snap, false),
    /standings returned empty/,
  );
});

test("tight subrequest budget degrades gracefully (no crash)", async () => {
  globalThis.fetch = async (url) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ response: cannedFetch(url) }) });
  const s = await buildSnapshot({ APIFOOTBALL_KEY: "t", WC_LEAGUE_ID: "1", WC_SEASON: "2026", SUBREQUEST_BUDGET: "5" }, null, false);
  assert.equal(Object.keys(s.groups).length, 2);          // core still works under a tiny budget
  assert.ok(typeof s.meta.squadCount === "number");       // no throw; just fewer enriched
});

// ── push digest copy ──────────────────────────────────────────────────────────
const digestSnap = {
  teams: { MEX: { name: "Mexico" }, RSA: { name: "South Africa" }, FRA: { name: "France" }, ESP: { name: "Spain" } },
  matches: [
    // two scheduled "today" fixtures, deliberately out of kick-off order
    { id: "t2", status: "scheduled", group: "C", kickoff: "2026-06-20T19:00:00Z", home: { code: "FRA" }, away: { code: "ESP" }, tv: { channel: "BBC One" } },
    { id: "t1", status: "scheduled", group: "F", kickoff: "2026-06-20T12:00:00Z", home: { code: "MEX" }, away: { code: "RSA" }, tv: { channel: "ITV1" } },
    // a finished knockout tie in the overnight window, decided on penalties
    { id: "r1", status: "ft", stage: "Round of 16", kickoff: new Date(Date.now() - 3 * 3600e3).toISOString(),
      home: { code: "MEX", score: 1 }, away: { code: "FRA", score: 1 }, pens: { h: 4, a: 3 } },
    // an old finished match, outside the 16h catch-up window — must be excluded
    { id: "r0", status: "ft", group: "A", kickoff: new Date(Date.now() - 40 * 3600e3).toISOString(),
      home: { code: "ESP", score: 2 }, away: { code: "RSA", score: 0 } },
  ],
};

test("fixtureLabel: group letter for the group stage, the round otherwise", () => {
  assert.equal(fixtureLabel({ group: "F", stage: "Group Stage" }), "Group F");
  assert.equal(fixtureLabel({ stage: "Round of 16" }), "Round of 16");
  assert.equal(fixtureLabel({ stage: "Group Stage" }), "");   // no group, nothing to show
});

test("todayDigest: full names, UK kick-off, group + channel, earliest first", () => {
  const d = todayDigest(digestSnap, "2026-06-20");
  assert.equal(d.count, 2);
  const lines = d.body.split("\n");
  assert.match(lines[0], /^13:00 Mexico v South Africa · Group F · ITV1$/);  // 12:00Z → 13:00 BST, sorted ahead
  assert.match(lines[1], /^20:00 France v Spain · Group C · BBC One$/);
});

test("todayDigest: null when nothing is on", () => {
  assert.equal(todayDigest(digestSnap, "2026-07-01"), null);
});

test("resultsDigest: scoreline, penalties, round; old match outside window dropped", () => {
  const d = resultsDigest(digestSnap);
  assert.equal(d.count, 1);
  assert.equal(d.body, "Mexico 1-1 France (4-3 pens) · Round of 16");
});
