// Morning-view model tests: the UK time window, the reverse-applied "before" state,
// engine-driven verdict flips, and section composition. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { inMorningWindow, beforeState, overnightFlips, morningModel, ukClock } from "./morning.js";

// June 2026 = BST (UTC+1): 08:00Z is 09:00 UK.
const at = (iso) => Date.parse(iso);

test("morning window is 06:00–13:00 UK (BST-aware)", () => {
  assert.equal(inMorningWindow(at("2026-06-20T08:00:00Z")), true);    // 09:00 UK
  assert.equal(inMorningWindow(at("2026-06-20T05:30:00Z")), true);    // 06:30 UK
  assert.equal(inMorningWindow(at("2026-06-20T04:30:00Z")), false);   // 05:30 UK
  assert.equal(inMorningWindow(at("2026-06-20T12:30:00Z")), false);   // 13:30 UK
  assert.equal(ukClock(at("2026-06-20T08:00:00Z")).hour, 9);
});

// ── a tiny finished-group world: AAA 9pts, BBB 6, CCC 3, DDD 0 ──
// Overnight game: BBB 2-1 CCC sealed BBB's runners-up spot.
const NOW = at("2026-06-21T08:00:00Z");                                // 09:00 UK
const row = (code, [W, D, L, GF, GA]) =>
  ({ code, name: code, P: W + D + L, W, D, L, GF, GA, GD: GF - GA, Pts: W * 3 + D, yellow: 0, red: 0 });
const snap = () => ({
  meta: { phase: "group", started: true },
  groups: { A: [row("AAA", [3, 0, 0, 6, 1]), row("BBB", [2, 0, 1, 4, 3]), row("CCC", [1, 0, 2, 3, 5]), row("DDD", [0, 0, 3, 1, 5])] },
  remainingFixtures: [],
  teams: { AAA: { name: "Alphaland" }, BBB: { name: "Betaland" }, CCC: { name: "Gammaland" }, DDD: { name: "Deltaland" } },
  matches: [
    { id: "m1", stage: "Group Stage", group: "A", status: "ft", kickoff: new Date(NOW - 7 * 3600e3).toISOString(),
      home: { code: "BBB", score: 2 }, away: { code: "CCC", score: 1 } },                       // last night
    { id: "m0", stage: "Group Stage", group: "A", status: "ft", kickoff: "2026-06-18T19:00:00Z",
      home: { code: "AAA", score: 2 }, away: { code: "DDD", score: 0 } },                       // days ago — not "last night"
    { id: "m2", stage: "Group Stage", group: "B", status: "scheduled", kickoff: "2026-06-21T19:00:00Z",
      home: { code: "AAA", score: null }, away: { code: "BBB", score: null } },                 // today 20:00 UK
    { id: "m3", stage: "Group Stage", group: "B", status: "scheduled", kickoff: "2026-06-22T19:00:00Z",
      home: { code: "CCC", score: null }, away: { code: "DDD", score: null } },                 // tomorrow
  ],
});

test("beforeState exactly reverses an overnight result", () => {
  const s = snap();
  const before = beforeState(s, [s.matches[0]]);
  const bbb = before.groups.A.find((r) => r.code === "BBB");
  const ccc = before.groups.A.find((r) => r.code === "CCC");
  assert.deepEqual([bbb.P, bbb.Pts, bbb.GF, bbb.GA], [2, 3, 2, 2]);
  assert.deepEqual([ccc.P, ccc.Pts, ccc.GF, ccc.GA], [2, 3, 2, 3]);
  assert.equal(before.remainingFixtures.length, 1);                    // the game is pending again
  // the current snapshot was not mutated
  assert.equal(s.groups.A.find((r) => r.code === "BBB").P, 3);
});

test("overnight flips: the result that sealed qualification is reported", () => {
  const s = snap();
  const flips = overnightFlips(s, [s.matches[0]]);
  assert.ok(flips.some((f) => f.includes("Betaland") && f.includes("through")), `expected a BBB flip in: ${flips}`);
});

test("morningModel: window-gated, sections composed, nothing fabricated", () => {
  const s = snap();
  assert.equal(morningModel(s, null, at("2026-06-21T15:00:00Z")), null);   // 16:00 UK — outside
  const mm = morningModel(s, null, NOW);
  assert.ok(mm);
  assert.deepEqual(mm.lastNight.map((m) => m.id), ["m1"]);             // overnight only
  assert.deepEqual(mm.today.map((m) => m.id), ["m2"]);                 // full slate, today only
  assert.equal(mm.restDay, false);
  assert.ok(Array.isArray(mm.stakes));
  // pre-tournament → no morning view
  s.meta.phase = "pre";
  assert.equal(morningModel(s, null, NOW), null);
});

test("morningModel: phase fallback agrees with the app — no meta.phase + started:false → no morning view", () => {
  const s = snap();
  delete s.meta.phase;
  s.meta.started = false;          // screens' phase() would say "pre" — so must we
  assert.equal(morningModel(s, null, NOW), null);
});

test("morningModel: rest day + silent night → empty sections, no content invented", () => {
  const s = snap();
  s.matches = [];                                                       // nothing overnight, nothing today
  const mm = morningModel(s, null, NOW);
  assert.equal(mm.lastNight.length, 0);
  assert.equal(mm.today.length, 0);
  assert.equal(mm.restDay, true);
  assert.equal(mm.flips.length, 0);
});

test("knockout morning: who advanced + today's ties with their onward route", () => {
  const s = snap();
  s.meta.phase = "knockout";
  s.bracket = { rounds: ["R32", "R16"], matches: [
    { id: "73", rd: "R32", a: {}, b: {}, next: "90" },
    { id: "75", rd: "R32", a: {}, b: {}, next: "90" },
    { id: "90", rd: "R16", a: { label: "Winner Match 73" }, b: { label: "Winner Match 75" } },
  ] };
  s.matches = [
    { id: "k0", stage: "Round of 32", status: "ft", kickoff: new Date(NOW - 8 * 3600e3).toISOString(),
      home: { code: "AAA", score: 2 }, away: { code: "DDD", score: 1 } },
    { id: "kp", stage: "Round of 32", status: "ft", kickoff: new Date(NOW - 6 * 3600e3).toISOString(),
      home: { code: "CCC", score: 1 }, away: { code: "DDD", score: 1 }, pens: { h: 3, a: 4 } },   // shootout
    { id: "k1", stage: "Round of 32", status: "scheduled", kickoff: "2026-06-21T19:00:00Z", slot: "R32-M73",
      home: { code: "BBB", score: null }, away: { code: "CCC", score: null } },
  ];
  const mm = morningModel(s, null, NOW);
  assert.ok(mm.flips.some((f) => f.includes("Alphaland") && f.includes("advance")));
  assert.ok(mm.flips.some((f) => f.includes("Deltaland") && f.includes("advance on penalties")), `got: ${mm.flips}`);
  assert.ok(mm.stakes.some((l) => l.includes("Betaland v Gammaland") && l.includes("winner of Match 75")), `got: ${mm.stakes}`);
});
