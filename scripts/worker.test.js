// Worker normalisation pipeline test. The live API can't be hit from CI, so we mock
// global.fetch with canned API-Football v3 responses and drive buildSnapshot end to
// end, asserting the snapshot shape the frontend depends on. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot } from "../worker/index.js";

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
  const f = (id, round, st, hId, hCode, aId, aCode, hg, ag, date) => ({
    fixture: { id, date, status: { short: st, elapsed: st === "1H" ? 30 : null }, venue: { name: "Stadium" } },
    league: { round }, teams: { home: { id: hId, code: hCode }, away: { id: aId, code: aCode } }, goals: { home: hg, away: ag },
  });
  // round is "Group Stage - N" with NO group letter — group comes from team membership
  return [
    f(5001, "Group Stage - 2", "FT", 100, "ENG", 102, "SEN", 2, 1, "2026-06-20T16:00:00Z"),   // finished, has detail
    f(5002, "Group Stage - 3", "1H", 110, "ARG", 111, "AUS", 1, 0, "2026-06-25T16:00:00Z"),   // live
    f(5003, "Group Stage - 3", "NS", 100, "ENG", 101, "USA", null, null, "2026-06-26T16:00:00Z"), // scheduled → remaining
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
  globalThis.fetch = async (url) => ({ ok: true, status: 200, json: async () => ({ response: cannedFetch(url) }) });
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

test("remaining fixtures + live match detected", () => {
  assert.equal(snap.remainingFixtures.length, 1);
  assert.equal(snap.remainingFixtures[0].id, "5003");
  assert.ok(snap.matches.some((m) => m.status === "live"));
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

test("bracket built with full structure", () => {
  assert.equal(snap.bracket.matches.filter((m) => m.rd === "R32").length, 16);
  assert.equal(snap.bracket.matches.length, 31);
});
