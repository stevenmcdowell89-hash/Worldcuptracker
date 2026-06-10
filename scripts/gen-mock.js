// Generates web/data/latest.json — a realistic mid-tournament snapshot used to build
// and demo the whole frontend offline (brief §10 step 2). Internally consistent:
// the third-place race and verdicts are produced by the real engine.
//
//   node scripts/gen-mock.js
//
// Scenario: group stage, final matchday in progress. Each team has played 2, has 1
// left, so the third-place race is live and the scenario board has real input.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verdicts, thirdPlaceTable, recompute, compareGroupRows, spotsMoving, stakesFor } from "../web/js/engine.js";
import { buildBracket } from "../web/js/bracket.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = pathResolve(__dirname, "../web/data/latest.json");

const NAMES = {
  MEX:"Mexico",CRO:"Croatia",CMR:"Cameroon",KSA:"Saudi Arabia",
  CAN:"Canada",BEL:"Belgium",MAR:"Morocco",JPN:"Japan",
  USA:"United States",ENG:"England",SEN:"Senegal",IRN:"Iran",
  ARG:"Argentina",AUS:"Australia",POL:"Poland",RSA:"South Africa",
  FRA:"France",SUI:"Switzerland",KOR:"South Korea",GHA:"Ghana",
  BRA:"Brazil",SRB:"Serbia",ECU:"Ecuador",TUN:"Tunisia",
  ESP:"Spain",URU:"Uruguay",EGY:"Egypt",QAT:"Qatar",
  GER:"Germany",COL:"Colombia",CRC:"Costa Rica",UZB:"Uzbekistan",
  POR:"Portugal",CIV:"Ivory Coast",JOR:"Jordan",PAN:"Panama",
  ITA:"Italy",DEN:"Denmark",PAR:"Paraguay",CPV:"Cape Verde",
  NED:"Netherlands",MLI:"Mali",NZL:"New Zealand",HON:"Honduras",
  NGA:"Nigeria",SCO:"Scotland",AUT:"Austria",CUW:"Curaçao",
};

// group letter -> 4 team codes (seeded strongest first)
const GROUPS = {
  A:["MEX","CRO","CMR","KSA"], B:["BEL","CAN","MAR","JPN"],
  C:["ENG","USA","SEN","IRN"], D:["ARG","AUS","POL","RSA"],
  E:["FRA","SUI","KOR","GHA"], F:["BRA","SRB","ECU","TUN"],
  G:["ESP","URU","EGY","QAT"], H:["GER","COL","CRC","UZB"],
  I:["POR","CIV","JOR","PAN"], J:["ITA","DEN","PAR","CPV"],
  K:["NED","MLI","NZL","HON"], L:["NGA","SCO","AUT","CUW"],
};

// Per-team line after 2 matches: [W,D,L,GF,GA,yellow,red].
// Tuned so most groups are decided at the top but the 3rd spot is alive.
const LINES = {
  MEX:[2,0,0,5,2,3,0], CRO:[1,0,1,3,3,4,0], CMR:[1,0,1,2,3,5,1], KSA:[0,0,2,1,3,4,0],
  BEL:[1,1,0,4,2,2,0], CAN:[1,1,0,3,1,3,0], MAR:[1,0,1,2,2,3,0], JPN:[0,0,2,1,5,5,0],
  ENG:[2,0,0,4,1,1,0], USA:[1,0,1,3,2,4,0], SEN:[1,0,1,3,3,6,1], IRN:[0,0,2,1,5,5,0],
  ARG:[2,0,0,6,1,2,0], AUS:[1,0,1,2,2,4,0], POL:[0,1,1,2,3,3,0], RSA:[0,1,1,1,5,5,0],
  FRA:[2,0,0,5,1,2,0], SUI:[1,0,1,3,2,3,0], KOR:[1,0,1,2,2,4,0], GHA:[0,0,2,2,7,6,1],
  BRA:[2,0,0,4,0,1,0], SRB:[0,1,1,2,3,5,0], ECU:[1,1,0,3,1,2,0], TUN:[0,0,2,1,6,5,0],
  ESP:[1,1,0,4,2,2,0], URU:[1,1,0,3,2,3,0], EGY:[0,1,1,2,3,4,0], QAT:[0,0,2,1,5,4,0],
  GER:[2,0,0,5,2,2,0], COL:[1,0,1,3,2,3,0], CRC:[0,1,1,2,4,5,0], UZB:[0,1,1,2,4,4,1],
  POR:[2,0,0,4,1,1,0], CIV:[1,0,1,3,3,5,0], JOR:[0,1,1,2,3,4,0], PAN:[0,1,1,1,3,5,1],
  ITA:[1,1,0,3,1,2,0], DEN:[1,1,0,3,2,3,0], PAR:[0,1,1,1,2,5,0], CPV:[0,1,1,2,4,4,0],
  NED:[2,0,0,4,1,1,0], MLI:[1,0,1,2,2,4,0], NZL:[0,1,1,1,3,3,0], HON:[0,1,1,2,3,5,0],
  NGA:[1,1,0,4,2,3,1], SCO:[1,0,1,2,2,4,0], AUT:[1,0,1,3,3,3,0], CUW:[0,1,1,2,4,9,1],
};

function row(code) {
  const [W,D,L,GF,GA,y,r] = LINES[code];
  return { code, name: NAMES[code], P: W+D+L, W, D, L, GF, GA, GD: GF-GA, Pts: W*3+D, yellow: y, red: r };
}

// Build groups, each sorted by the engine's group rules.
const groups = {};
for (const [g, codes] of Object.entries(GROUPS)) groups[g] = codes.map(row);

// Remaining matchday-3 fixtures: pair (seed0 v seed3) and (seed1 v seed2).
// Anchored a couple of hours from "now" so the now-relative phase-3 surfaces (morning
// view, today's slate, reminder countdowns) all demo against the snapshot. Production
// regenerates from the live schedule; this is just the dev/demo vehicle.
const baseDay = new Date(Date.now() + 2 * 3600e3);
// "Last night" anchor (~yesterday evening UK) for the finished games that feed the
// morning view's first section.
const lastNight = (() => { const d = new Date(); d.setUTCHours(19, 0, 0, 0); return new Date(d.getTime() - 24 * 3600e3); })();
let fxN = 0;
const remainingFixtures = [];
for (const [g, codes] of Object.entries(GROUPS)) {
  const pairs = [[codes[0], codes[3]], [codes[1], codes[2]]];
  pairs.forEach((p, i) => {
    const ko = new Date(baseDay.getTime() + (Object.keys(GROUPS).indexOf(g) * 6 + i * 3) * 3600e3);
    remainingFixtures.push({
      id: `f${++fxN}`, group: g, home: p[0], away: p[1],
      kickoff: ko.toISOString(), affectsThird: true,
    });
  });
}

const snapshotForEngine = { groups, remainingFixtures, teams: {} };
const third = thirdPlaceTable(recompute(snapshotForEngine, []));
const race = verdicts(snapshotForEngine);

// ── matches: a few live + finished (with full detail) + the scheduled MD3 set ──
const matches = [];

// LIVE: Group A — Mexico v Saudi Arabia (the host, affects the cut)
matches.push({
  id: "mA1", stage: "Group Stage", group: "A", status: "live", minute: "67'",
  kickoff: new Date(Date.now() - 67 * 6e4).toISOString(), venue: "Estadio Azteca, Mexico City",
  home: { code: "MEX", score: 2 }, away: { code: "KSA", score: 1 },
  affectsCut: true,
  progressionLine: "As it stands, this win keeps Croatia sweating for the last third-place spot.",
  events: [
    { min: "12'", side: "h", type: "goal", player: "S. Giménez", assist: "H. Lozano" },
    { min: "34'", side: "a", type: "goal", player: "S. Al-Dawsari" },
    { min: "41'", side: "h", type: "yellow", player: "E. Álvarez" },
    { min: "58'", side: "h", type: "goal", player: "S. Giménez", assist: "O. Pineda" },
    { min: "63'", side: "h", type: "subst", player: "R. Jiménez", detail: "S. Giménez" },
  ],
  stats: [
    { k: "Possession", h: 58, a: 42, unit: "%" },
    { k: "Shots", h: 14, a: 7 }, { k: "Shots on target", h: 6, a: 3 },
    { k: "Big chances", h: 3, a: 1 }, { k: "Passes", h: 512, a: 388 },
    { k: "Pass accuracy", h: 88, a: 81, unit: "%" }, { k: "Corners", h: 7, a: 2 },
    { k: "Fouls", h: 9, a: 13 }, { k: "Offsides", h: 2, a: 1 },
  ],
  commentarySource: "The Guardian",
  commentaryUrl: "https://www.theguardian.com/football/live",
  commentary: [
    { at: new Date(Date.now() - 2 * 6e4).toISOString(), title: "GOAL!", text: "Mexico 2-1 Saudi Arabia. Giménez gets his second, turning in Pineda's low cross at the near post. The Azteca erupts.", key: true },
    { at: new Date(Date.now() - 9 * 6e4).toISOString(), title: "", text: "Saudi Arabia are growing into this. Al-Dawsari drifts inside and curls one just over — a warning to the hosts.", key: false },
    { at: new Date(Date.now() - 22 * 6e4).toISOString(), title: "GOAL!", text: "1-1. Al-Dawsari levels from the spot after a clumsy challenge by Álvarez, sending Ochoa the wrong way.", key: true },
  ],
  lineups: {
    h: { formation: "4-3-3", coach: "Javier Aguirre", xi: [
      { num: 1, name: "G. Ochoa", pos: "GK", grid: "1:1" },
      { num: 2, name: "J. Sánchez", pos: "RB", grid: "2:4" },
      { num: 15, name: "C. Montes", pos: "CB", grid: "2:3" },
      { num: 3, name: "C. Vásquez", pos: "CB", grid: "2:2" },
      { num: 23, name: "J. Gallardo", pos: "LB", grid: "2:1" },
      { num: 4, name: "E. Álvarez", pos: "CM", grid: "3:3" },
      { num: 16, name: "O. Pineda", pos: "CM", grid: "3:2" },
      { num: 8, name: "L. Chávez", pos: "CM", grid: "3:1" },
      { num: 22, name: "H. Lozano", pos: "RW", grid: "4:3" },
      { num: 9, name: "S. Giménez", pos: "ST", rating: 8.4, sub: 63, playerId: 123, grid: "4:2" },
      { num: 11, name: "A. Vega", pos: "LW", grid: "4:1" },
    ], subs: [ { num: 19, name: "R. Jiménez", pos: "ST", playerId: 140 } ] },
    a: { formation: "4-2-3-1", coach: "Hervé Renard", xi: [
      { num: 21, name: "M. Al-Owais", pos: "GK", grid: "1:1" },
      { num: 13, name: "Y. Al-Shahrani", pos: "LB", grid: "2:1" },
      { num: 5, name: "A. Al-Bulayhi", pos: "CB", grid: "2:2" },
      { num: 3, name: "A. Al-Amri", pos: "CB", grid: "2:3" },
      { num: 2, name: "S. Abdulhamid", pos: "RB", grid: "2:4" },
      { num: 7, name: "S. Al-Faraj", pos: "CM", grid: "3:2" },
      { num: 14, name: "A. Otayf", pos: "CM", grid: "3:3" },
      { num: 10, name: "S. Al-Dawsari", pos: "LW", rating: 7.6, playerId: 201, grid: "4:1" },
      { num: 8, name: "A. Al-Malki", pos: "AM", grid: "4:2" },
      { num: 18, name: "N. Al-Ghannam", pos: "RW", grid: "4:3" },
      { num: 9, name: "F. Al-Buraikan", pos: "ST", grid: "5:2" },
    ], subs: [] },
  },
});

// LIVE: Group D — Argentina v South Africa
matches.push({
  id: "mD1", stage: "Group Stage", group: "D", status: "live", minute: "39'",
  kickoff: new Date(Date.now() - 39 * 6e4).toISOString(), venue: "MetLife Stadium, New Jersey",
  home: { code: "ARG", score: 1 }, away: { code: "RSA", score: 0 },
  affectsCut: true,
  progressionLine: "Australia go through as it stands; a South Africa goal would reopen it.",
  events: [ { min: "22'", side: "h", type: "goal", player: "J. Álvarez", assist: "L. Messi" } ],
  stats: [
    { k: "Possession", h: 64, a: 36, unit: "%" }, { k: "Shots", h: 9, a: 3 },
    { k: "Shots on target", h: 4, a: 1 }, { k: "Big chances", h: 2, a: 0 },
    { k: "Corners", h: 5, a: 1 }, { k: "Fouls", h: 6, a: 11 },
  ],
  lineups: { h: { formation: "4-4-2", coach: "Lionel Scaloni", xi: [], subs: [] } },
});

// FINISHED (matchday 2) with player ratings — for the post-match panel
matches.push({
  id: "mC0", stage: "Group Stage", group: "C", status: "ft", minute: "FT",
  kickoff: lastNight.toISOString(), venue: "AT&T Stadium, Dallas",
  home: { code: "ENG", score: 2 }, away: { code: "SEN", score: 1 },
  affectsCut: false,
  events: [
    { min: "18'", side: "h", type: "goal", player: "H. Kane", assist: "B. Saka" },
    { min: "44'", side: "a", type: "goal", player: "S. Mané" },
    { min: "71'", side: "h", type: "goal", player: "J. Bellingham", assist: "C. Palmer" },
    { min: "80'", side: "a", type: "yellow", player: "I. Gueye" },
  ],
  stats: [
    { k: "Possession", h: 55, a: 45, unit: "%" }, { k: "Shots", h: 13, a: 9 },
    { k: "Shots on target", h: 5, a: 4 }, { k: "Big chances", h: 3, a: 2 },
    { k: "Passes", h: 487, a: 401 }, { k: "Pass accuracy", h: 86, a: 82, unit: "%" },
    { k: "Corners", h: 6, a: 4 }, { k: "Fouls", h: 10, a: 12 }, { k: "Offsides", h: 1, a: 3 },
  ],
  lineups: {
    h: { formation: "4-2-3-1", coach: "Thomas Tuchel", xi: [
      { num: 1, name: "J. Pickford", pos: "GK", rating: 7.0, grid: "1:1" },
      { num: 2, name: "K. Walker", pos: "RB", rating: 6.8, grid: "2:4" },
      { num: 5, name: "J. Stones", pos: "CB", rating: 7.2, grid: "2:3" },
      { num: 6, name: "M. Guéhi", pos: "CB", rating: 7.4, grid: "2:2" },
      { num: 3, name: "L. Shaw", pos: "LB", rating: 6.9, grid: "2:1" },
      { num: 4, name: "D. Rice", pos: "CM", rating: 7.6, grid: "3:3" },
      { num: 8, name: "J. Bellingham", pos: "CM", rating: 8.3, playerId: 150, grid: "3:1" },
      { num: 7, name: "B. Saka", pos: "RW", rating: 7.9, playerId: 151, grid: "4:3" },
      { num: 10, name: "C. Palmer", pos: "AM", rating: 7.7, playerId: 152, grid: "4:2" },
      { num: 11, name: "P. Foden", pos: "LW", rating: 7.1, sub: 75, grid: "4:1" },
      { num: 9, name: "H. Kane", pos: "ST", rating: 8.1, playerId: 153, grid: "5:2" },
    ], subs: [ { num: 20, name: "J. Grealish", pos: "LW", rating: 6.6, playerId: 154 } ] },
    a: { formation: "4-3-3", coach: "Pape Thiaw", xi: [
      { num: 16, name: "É. Mendy", pos: "GK", rating: 6.5, grid: "1:1" },
      { num: 10, name: "S. Mané", pos: "LW", rating: 7.8, playerId: 170, grid: "4:1" },
    ], subs: [] },
  },
});

// Another overnight result (Group F) so "Last night" has a couple of games. Brazil
// beat Serbia — consistent with the group ledger (Brazil won both, Serbia dropped one).
matches.push({
  id: "mF0", stage: "Group Stage", group: "F", status: "ft", minute: "FT",
  kickoff: new Date(lastNight.getTime() + 2.5 * 3600e3).toISOString(), venue: "Hard Rock Stadium, Miami",
  home: { code: "BRA", score: 2 }, away: { code: "SRB", score: 0 }, affectsCut: false,
  events: [
    { min: "27'", side: "h", type: "goal", player: "Vinícius Jr", assist: "Raphinha" },
    { min: "69'", side: "h", type: "goal", player: "Rodrygo" },
  ],
});

// Scheduled matchday-3 fixtures become "scheduled" matches.
for (const f of remainingFixtures) {
  if (matches.some(m => m.group === f.group && (m.home.code === f.home || m.away.code === f.away) && m.status !== "scheduled")) {
    // skip the pairing we already promoted to live for groups A and D
    if ((f.group === "A" && f.home === "MEX") || (f.group === "D" && f.home === "ARG")) continue;
  }
  matches.push({
    id: f.id, stage: "Group Stage", group: f.group, status: "scheduled", kickoff: f.kickoff,
    home: { code: f.home, score: null }, away: { code: f.away, score: null },
    affectsCut: true, stakes: stakesFor(snapshotForEngine, f.id),
  });
}

// ── bracket: the real 2026 structure, from the shared module (web/js/bracket.js),
// so the demo and the Worker can't drift. Group-position sides resolve to the
// current leader/runner-up; third-place slots show their FIFA candidate set (they
// resolve via Annex C once the group stage completes). ──
const annexC = JSON.parse(readFileSync(pathResolve(__dirname, "../web/data/annexC.json"), "utf8"));
const sortedGroups = {};
for (const g of Object.keys(groups)) sortedGroups[g] = groups[g].slice().sort(compareGroupRows);
const bracket = buildBracket(sortedGroups, annexC, { groupStageComplete: false });

// ── leaderboards ──
const scorers = [
  { playerId:153, code:"ENG", name:"H. Kane", team:"England", g:4, a:1 },
  { playerId:123, code:"MEX", name:"S. Giménez", team:"Mexico", g:3, a:1 },
  { playerId:300, code:"FRA", name:"K. Mbappé", team:"France", g:3, a:2 },
  { playerId:301, code:"BRA", name:"Vinícius Jr", team:"Brazil", g:3, a:0 },
  { playerId:150, code:"ENG", name:"J. Bellingham", team:"England", g:2, a:2 },
  { playerId:302, code:"ARG", name:"J. Álvarez", team:"Argentina", g:2, a:1 },
  { playerId:170, code:"SEN", name:"S. Mané", team:"Senegal", g:2, a:1 },
  { playerId:303, code:"POR", name:"C. Ronaldo", team:"Portugal", g:2, a:0 },
];
const assists = [
  { playerId:304, code:"ARG", name:"L. Messi", team:"Argentina", a:3, g:1 },
  { playerId:300, code:"FRA", name:"K. Mbappé", team:"France", a:2, g:3 },
  { playerId:151, code:"ENG", name:"B. Saka", team:"England", a:2, g:1 },
  { playerId:152, code:"ENG", name:"C. Palmer", team:"England", a:2, g:1 },
];
const discipline = [
  { code:"CUW", team:"Curaçao", y:9, r:1 },
  { code:"GHA", team:"Ghana", y:6, r:1 },
  { code:"SEN", team:"Senegal", y:6, r:1 },
  { code:"CMR", team:"Cameroon", y:5, r:1 },
  { code:"NGA", team:"Nigeria", y:3, r:1 },
];

// ── teams: one entry per nation, with a verdict chip ──
const verdictByCode = Object.fromEntries(race.map(t => [t.code, t.status]));
function groupVerdict(g, code) {
  const sorted = groups[g].slice().sort((a,b)=> b.Pts-a.Pts || b.GD-a.GD || b.GF-a.GF);
  const pos = sorted.findIndex(r => r.code === code);
  if (verdictByCode[code]) return verdictByCode[code];   // 3rd-place contenders
  if (pos <= 1) return "in";                             // currently top two
  return "out";                                          // currently 4th
}
const teams = {};
for (const [g, codes] of Object.entries(GROUPS)) {
  codes.forEach((code, i) => {
    const r = groups[g].find(x => x.code === code);
    teams[code] = {
      code, name: NAMES[code], group: g, rank: 12 + i,
      coach: "—", P: r.P, W: r.W, D: r.D, L: r.L, GF: r.GF, GA: r.GA,
      possession: 50 + ((r.GD) * 2), cleanSheets: Math.max(0, r.W - (r.GA>0?1:0)),
      form: [{ o: codes[(i+1)%4], r: `${r.GF>1?2:1}-0`, w: r.W>0 }, { o: codes[(i+2)%4], r: "1-1", w: r.D>0?null:false }],
      squad: [], verdict: groupVerdict(g, code),
    };
  });
}

// ── players: detail the notable + club-watch players ──
const players = {
  "123": { name:"Santiago Giménez", code:"MEX", pos:"Striker", age:25, num:9, club:"AC Milan", league:"Serie A",
    tournament:{apps:3,min:248,g:3,a:1,shots:13,keyPasses:4,yellow:1,red:0,rating:7.9},
    season:[ {comp:"Serie A",apps:31,g:14,a:3,yellow:5,red:0,min:2510,shots:78,keyPasses:21,rating:7.1} ],
    career:[ {from:"Cruz Azul",to:"Feyenoord",year:2022},{from:"Feyenoord",to:"AC Milan",year:2025} ],
    honours:[ {title:"Eredivisie",year:2023},{title:"KNVB Cup",year:2024} ] },
  "150": { name:"Jude Bellingham", code:"ENG", pos:"Midfielder", age:22, num:8, club:"Real Madrid", league:"La Liga",
    tournament:{apps:3,min:270,g:2,a:2,shots:9,keyPasses:7,yellow:1,red:0,rating:8.0},
    season:[ {comp:"La Liga",apps:33,g:18,a:9,yellow:6,red:1,min:2820,shots:92,keyPasses:55,rating:7.8},
             {comp:"Champions League",apps:11,g:5,a:3,yellow:2,red:0,min:980,rating:7.9} ],
    career:[ {from:"Birmingham City",to:"Borussia Dortmund",year:2020},{from:"Borussia Dortmund",to:"Real Madrid",year:2023} ],
    honours:[ {title:"La Liga",year:2024},{title:"Champions League",year:2024} ] },
  "151": { name:"Bukayo Saka", code:"ENG", pos:"Winger", age:24, num:7, club:"Arsenal", league:"Premier League",
    tournament:{apps:3,min:255,g:1,a:2,shots:8,keyPasses:9,yellow:0,red:0,rating:7.6},
    season:[ {comp:"Premier League",apps:34,g:13,a:11,yellow:4,red:0,min:2890,rating:7.7} ],
    career:[], honours:[ {title:"FA Cup",year:2020} ] },
  "153": { name:"Harry Kane", code:"ENG", pos:"Striker", age:32, num:9, club:"Bayern Munich", league:"Bundesliga",
    tournament:{apps:3,min:270,g:4,a:1,shots:14,keyPasses:5,yellow:0,red:0,rating:8.2},
    season:[ {comp:"Bundesliga",apps:32,g:31,a:8,yellow:3,red:0,min:2810,rating:8.1} ],
    career:[ {from:"Tottenham Hotspur",to:"Bayern Munich",year:2023} ],
    honours:[ {title:"Bundesliga",year:2025} ] },
  "300": { name:"Kylian Mbappé", code:"FRA", pos:"Forward", age:27, num:10, club:"Real Madrid", league:"La Liga",
    tournament:{apps:3,min:265,g:3,a:2,shots:15,keyPasses:6,yellow:0,red:0,rating:8.3},
    season:[ {comp:"La Liga",apps:32,g:27,a:6,yellow:2,red:0,min:2700,rating:8.0} ],
    career:[ {from:"Monaco",to:"Paris Saint-Germain",year:2018},{from:"Paris Saint-Germain",to:"Real Madrid",year:2024} ],
    honours:[ {title:"World Cup",year:2018},{title:"La Liga",year:2025} ] },
  "201": { name:"Salem Al-Dawsari", code:"KSA", pos:"Winger", age:34, num:10, club:"Al-Hilal", league:"Saudi Pro League",
    tournament:{apps:3,min:270,g:1,a:1,shots:7,keyPasses:5,yellow:1,red:0,rating:7.2},
    season:[ {comp:"Saudi Pro League",apps:28,g:10,a:7,yellow:3,red:0,min:2400,rating:7.4} ],
    career:[], honours:[ {title:"AFC Champions League",year:2021} ] },
  "400": { name:"Bruno Fernandes", code:"POR", pos:"Midfielder", age:31, num:8, club:"Manchester United", league:"Premier League",
    tournament:{apps:3,min:270,g:1,a:2,shots:10,keyPasses:11,yellow:1,red:0,rating:7.5},
    season:[ {comp:"Premier League",apps:35,g:9,a:13,yellow:8,red:1,min:3050,rating:7.5} ],
    career:[ {from:"Sporting CP",to:"Manchester United",year:2020} ], honours:[ {title:"FA Cup",year:2024} ] },
  "401": { name:"Casemiro", code:"BRA", pos:"Midfielder", age:34, num:5, club:"Manchester United", league:"Premier League",
    tournament:{apps:2,min:180,g:0,a:0,shots:2,keyPasses:1,yellow:1,red:0,rating:6.9},
    season:[ {comp:"Premier League",apps:24,g:3,a:1,yellow:9,red:1,min:1980,rating:6.8} ],
    career:[ {from:"Real Madrid",to:"Manchester United",year:2022} ], honours:[ {title:"Champions League",year:2022} ] },
  "402": { name:"Virgil van Dijk", code:"NED", pos:"Defender", age:34, num:4, club:"Liverpool", league:"Premier League",
    tournament:{apps:2,min:180,g:1,a:0,shots:3,keyPasses:1,yellow:0,red:0,rating:7.6},
    season:[ {comp:"Premier League",apps:36,g:4,a:1,yellow:3,red:0,min:3240,rating:7.6} ],
    career:[ {from:"Southampton",to:"Liverpool",year:2018} ], honours:[ {title:"Premier League",year:2025} ] },
  "403": { name:"Alexis Mac Allister", code:"ARG", pos:"Midfielder", age:27, num:20, club:"Liverpool", league:"Premier League",
    tournament:{apps:2,min:190,g:1,a:1,shots:4,keyPasses:6,yellow:1,red:0,rating:7.7},
    season:[ {comp:"Premier League",apps:33,g:6,a:7,yellow:5,red:0,min:2700,rating:7.5} ],
    career:[ {from:"Brighton",to:"Liverpool",year:2023} ], honours:[ {title:"World Cup",year:2022} ] },
  "404": { name:"Cristian Romero", code:"ARG", pos:"Defender", age:28, num:13, club:"Tottenham Hotspur", league:"Premier League",
    tournament:{apps:2,min:180,g:0,a:0,shots:1,keyPasses:0,yellow:2,red:0,rating:7.1},
    season:[ {comp:"Premier League",apps:30,g:3,a:1,yellow:10,red:1,min:2640,rating:7.2} ],
    career:[ {from:"Atalanta",to:"Tottenham Hotspur",year:2022} ], honours:[ {title:"World Cup",year:2022} ] },
  "405": { name:"Heung-min Son", code:"KOR", pos:"Forward", age:33, num:7, club:"Tottenham Hotspur", league:"Premier League",
    tournament:{apps:2,min:180,g:1,a:1,shots:6,keyPasses:4,yellow:0,red:0,rating:7.4},
    season:[ {comp:"Premier League",apps:34,g:11,a:9,yellow:2,red:0,min:2900,rating:7.4} ],
    career:[ {from:"Bayer Leverkusen",to:"Tottenham Hotspur",year:2015} ], honours:[] },
  "406": { name:"Dušan Vlahović", code:"SRB", pos:"Striker", age:26, num:9, club:"Juventus", league:"Serie A",
    tournament:{apps:2,min:165,g:1,a:0,shots:7,keyPasses:2,yellow:1,red:0,rating:6.8},
    season:[ {comp:"Serie A",apps:31,g:16,a:3,yellow:6,red:0,min:2500,rating:7.0} ],
    career:[ {from:"Fiorentina",to:"Juventus",year:2022} ], honours:[ {title:"Coppa Italia",year:2024} ] },
};

// ── Player Watch: 6 configured clubs × WC nation rosters (precomputed) ──
function nextFixtureFor(code) {
  const f = remainingFixtures.find(x => x.home === code || x.away === code);
  if (!f) return undefined;
  return { opponent: f.home === code ? f.away : f.home, kickoff: f.kickoff };
}
function watchPlayer(pid) {
  const p = players[pid];
  return {
    playerId: pid, nation: p.code, pos: p.pos, num: p.num,
    nextFixture: nextFixtureFor(p.code),
    tournament: { apps:p.tournament.apps, min:p.tournament.min, g:p.tournament.g, a:p.tournament.a, yellow:p.tournament.yellow, red:p.tournament.red },
    nationVerdict: teams[p.code] ? teams[p.code].verdict : "out",
  };
}
function clubEntry(name, crest, pids) {
  const ps = pids.map(watchPlayer);
  // club-level next action = soonest fixture across the club's players
  let next;
  for (const p of ps) {
    if (p.nextFixture && (!next || p.nextFixture.kickoff < next.kickoff)) {
      next = { playerId: p.playerId, nation: p.nation, opponent: p.nextFixture.opponent, kickoff: p.nextFixture.kickoff };
    }
  }
  return { name, crest, nextAction: next, players: ps };
}
const clubWatch = {
  "manchester-united": clubEntry("Manchester United", "", ["400","401"]),
  "liverpool": clubEntry("Liverpool", "", ["402","403"]),
  "arsenal": clubEntry("Arsenal", "", ["151"]),
  "tottenham": clubEntry("Tottenham Hotspur", "", ["404","405"]),
  "cardiff-city": clubEntry("Cardiff City", "", []),   // valid empty state
  "juventus": clubEntry("Juventus", "", ["406"]),
};

const news = [
  { title: "Mexico hold off Saudi Arabia in Azteca opener", summary: "Santiago Giménez's brace settles a nervy hosts' opener as the 2026 World Cup gets under way.", link: "https://www.bbc.com/sport/football", published: new Date(Date.now() - 35 * 6e4).toISOString(), image: null, source: "BBC Sport" },
  { title: "Argentina cruise as Messi pulls the strings", summary: "Holders Argentina look ominous after a comfortable win in New Jersey.", link: "https://www.bbc.com/sport/football", published: new Date(Date.now() - 3 * 36e5).toISOString(), image: null, source: "BBC Sport" },
  { title: "Third-place race: who's still in the hunt?", summary: "With the final group games to come, the eight best third-placed spots are wide open.", link: "https://www.bbc.com/sport/football", published: new Date(Date.now() - 6 * 36e5).toISOString(), image: null, source: "BBC Sport" },
];

const snapshot = {
  meta: {
    stage: "Group Stage", updated: new Date().toISOString(), groupStageComplete: false,
    dataSource: "mock", started: true,
    // Phase is time-based on real data; the mock is a static "final group matchday"
    // demo (results baked in, kickoffs in the future), so pin it rather than compute it.
    phase: "groupFinal",
    spotsMoving: spotsMoving(snapshotForEngine),
  },
  groups: sortedGroups,
  thirdPlaceRace: race,
  remainingFixtures,
  matches,
  bracket,
  scorers, assists, discipline,
  teams, players, clubWatch, news,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(snapshot, null, 2));
console.log(`Wrote ${OUT}`);
console.log(`Third-place race: ${race.map(t => `${t.code}(${t.status})`).join(", ")}`);
