// Engine unit tests — run with: npm test  (node --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  discPoints, compareGroupRows, compareThird, recompute, thirdPlaceTable,
  qualifiersFrom, resolve, verdicts, plainEnglish, resultFromWDL, annexCSlots, qualifyOutlook,
  tournamentPhase, stakesFor,
} from "./engine.js";

function gr(code, Pts, GD, GF, y = 0, r = 0) {
  return { code, name: code, P: 2, W: 0, D: 0, L: 0, GF, GA: GF - GD, GD, Pts, yellow: y, red: r };
}

test("discPoints: yellow=1, red=3, lower is fewer", () => {
  assert.equal(discPoints({ yellow: 2, red: 0 }), 2);
  assert.equal(discPoints({ yellow: 1, red: 1 }), 4);
});

test("group sort: Pts → GD → GF → fewer disc → code", () => {
  const rows = [gr("BBB", 3, 0, 2), gr("AAA", 3, 0, 2), gr("CCC", 6, 1, 3), gr("DDD", 3, 1, 1)];
  rows.sort(compareGroupRows);
  assert.deepEqual(rows.map((r) => r.code), ["CCC", "DDD", "AAA", "BBB"]);
});

test("fair-play breaks an otherwise exact tie", () => {
  const clean = gr("CLN", 3, 0, 2, 1, 0);   // 1 disc pt
  const dirty = gr("DRT", 3, 0, 2, 4, 1);   // 7 disc pts
  assert.ok(compareGroupRows(clean, dirty) < 0);  // cleaner ranks higher
});

// A tiny 2-group fixture where C and F fight for the single 3rd-place spot we test.
function miniSnapshot() {
  return {
    groups: {
      A: [gr("A1", 6, 4, 5), gr("A2", 4, 1, 3), gr("A3", 3, 0, 2), gr("A4", 0, -5, 1)],
      B: [gr("B1", 6, 3, 4), gr("B2", 6, 2, 3), gr("B3", 1, -1, 2), gr("B4", 1, -4, 1)],
    },
    remainingFixtures: [
      { id: "f1", group: "A", home: "A3", away: "A4", kickoff: "", affectsThird: true },
      { id: "f2", group: "B", home: "B3", away: "B4", kickoff: "", affectsThird: true },
    ],
    teams: { A3: { name: "Team A3" }, B3: { name: "Team B3" } },
  };
}

test("recompute applies a result and re-sorts", () => {
  const s = miniSnapshot();
  const tables = recompute(s, [{ id: "f1", home: "A3", away: "A4", hg: 3, ag: 0 }]);
  const a3 = tables.A.find((r) => r.code === "A3");
  assert.equal(a3.Pts, 6);
  assert.equal(a3.GD, 3);
  // A3 now has 6 pts and should sit above A2 (4 pts) → 2nd in group
  assert.equal(tables.A.findIndex((r) => r.code === "A3"), 1);
});

test("thirdPlaceTable picks the 3rd row of each sorted group and ranks them", () => {
  const s = miniSnapshot();
  const third = thirdPlaceTable(recompute(s, []));
  assert.equal(third.length, 2);
  // A3 (3 pts) ranks above B3 (1 pt)
  assert.deepEqual(third.map((t) => t.code), ["A3", "B3"]);
  assert.equal(third[0].rank, 1);
});

test("resolve is deterministic and exact for concrete scorelines", () => {
  const s = miniSnapshot();
  const out1 = resolve(s, [{ id: "f2", home: "B3", away: "B4", hg: 5, ag: 0 }]);
  const out2 = resolve(s, [{ id: "f2", home: "B3", away: "B4", hg: 5, ag: 0 }]);
  assert.deepEqual(out1.thirdPlaceTable, out2.thirdPlaceTable);
  // B3 winning 5-0 (now 4 pts, GD+3) stays 3rd in B (B1/B2 on 6) and leapfrogs
  // A3 (3 pts) at the TOP of the third-place table.
  assert.equal(out1.thirdPlaceTable[0].code, "B3");
});

test("scoreline margin matters, not just W/D/L (GD tiebreak)", () => {
  const s = miniSnapshot();
  // Compare goal difference of the winner across two margins, via the recomputed table.
  const narrow = recompute(s, [{ id: "f1", home: "A3", away: "A4", hg: 1, ag: 0 }]);
  const wide = recompute(s, [{ id: "f1", home: "A3", away: "A4", hg: 5, ag: 0 }]);
  const gdNarrow = narrow.A.find((r) => r.code === "A3").GD;
  const gdWide = wide.A.find((r) => r.code === "A3").GD;
  assert.ok(gdWide > gdNarrow, "a bigger win must yield a bigger goal difference");
});

test("verdicts return all 12 thirds ranked with a valid state each", () => {
  const s = miniSnapshot();
  const v = verdicts(s);
  const states = new Set(["qualified", "in", "sweating", "out", "eliminated"]);
  assert.equal(v.length, 2);
  for (const t of v) assert.ok(states.has(t.status));
  assert.equal(v[0].rank, 1);
});

test("qualifiersFrom returns at most 8 codes", () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ code: `T${i}`, Pts: 12 - i, GD: 0, GF: 0, disc: 0 }));
  assert.equal(qualifiersFrom(many).length, 8);
});

test("plainEnglish produces a sentence mentioning the team", () => {
  const s = miniSnapshot();
  const sentence = plainEnglish(s, "A3");
  assert.equal(typeof sentence, "string");
  assert.ok(sentence.includes("A3") || sentence.includes("Team A3"));
});

test("annexCSlots looks up by sorted group key", () => {
  const annexC = { combinations: { ABCDEFGH: { A: "r32-1", B: "r32-2" } } };
  const slots = annexCSlots(["H", "A", "C", "B", "E", "D", "G", "F"], annexC);
  assert.equal(slots.A, "r32-1");
});

// ── qualification outlook: whole-picture narrative across real scenarios ──
const rem = (id, g, h, a) => ({ id, group: g, home: h, away: a, kickoff: "", affectsThird: true });
const gr0 = (code) => ({ code, name: code, P: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0, GD: 0, Pts: 0, yellow: 0, red: 0 });

test("outlook: pre-tournament is honest, no false certainty", () => {
  const s = { groups: { A: ["AA", "BB", "CC", "DD"].map(gr0) }, remainingFixtures: [rem("f1", "A", "AA", "BB")], teams: { AA: { name: "Argentina" } } };
  const o = qualifyOutlook(s, "AA");
  assert.match(o.line, /hasn't kicked off|all to play for/);
});

test("outlook: clinched top two → through", () => {
  const s = {
    groups: { A: [gr("AA", 6, 3, 5), gr("BB", 6, 2, 4), gr("CC", 0, -2, 1), gr("DD", 0, -3, 0)] },
    remainingFixtures: [rem("f1", "A", "AA", "BB"), rem("f2", "A", "CC", "DD")], teams: {},
  };
  const o = qualifyOutlook(s, "AA");
  assert.equal(o.status, "qualified");
  assert.match(o.line, /Round of 32|through/i);
});

test("outlook: can't be caught from the bottom → eliminated", () => {
  const s = {
    groups: { A: [gr("BB", 6, 3, 5), gr("CC", 6, 2, 4), gr("DD", 4, 1, 3), gr("AA", 0, -6, 0)] },
    remainingFixtures: [rem("f1", "A", "AA", "BB"), rem("f2", "A", "CC", "DD")], teams: {},
  };
  const o = qualifyOutlook(s, "AA");
  assert.equal(o.status, "eliminated");
  assert.match(o.line, /can no longer/i);
});

test("outlook: a draw is enough → 'in' and the sentence says so", () => {
  // AA draw vs CC always keeps a top-3 spot, but a defeat (with DD beating BB) drops
  // AA to last → not yet guaranteed, so the honest line is "a draw is enough".
  const s = {
    groups: { A: [gr("BB", 6, 3, 5), gr("AA", 4, 1, 3), gr("CC", 3, 0, 2), gr("DD", 3, 0, 2)] },
    remainingFixtures: [rem("f1", "A", "AA", "CC"), rem("f2", "A", "BB", "DD")], teams: {},
  };
  const o = qualifyOutlook(s, "AA");
  assert.equal(o.status, "in");
  assert.match(o.line, /draw/i);
});

test("outlook: finished group winner is stated definitively", () => {
  const s = {
    groups: { A: [gr("AA", 7, 4, 6), gr("BB", 4, 1, 3), gr("CC", 4, 0, 2), gr("DD", 1, -5, 1)] },
    remainingFixtures: [], teams: {},
  };
  const o = qualifyOutlook(s, "AA");
  assert.equal(o.status, "qualified");
  assert.match(o.line, /won Group A/i);
});

test("resultFromWDL gives default margins and flags non-exact", () => {
  const fx = { id: "f1", home: "X", away: "Y" };
  assert.deepEqual(resultFromWDL(fx, "W"), { id: "f1", home: "X", away: "Y", hg: 1, ag: 0, exact: false });
  assert.deepEqual(resultFromWDL(fx, "D"), { id: "f1", home: "X", away: "Y", hg: 1, ag: 1, exact: false });
});

// ── phase flag (brief §11) ──
test("phase: no games played → pre", () => {
  const s = { groups: { A: ["AA", "BB", "CC", "DD"].map(gr0) }, remainingFixtures: [rem("f1", "A", "AA", "BB")] };
  assert.equal(tournamentPhase(s), "pre");
});

test("phase: games played, a group still mid-stage (4 games left) → group", () => {
  // A is on its last round (2 games left), but B is only one round in (4 left).
  const s = {
    groups: {
      A: [gr("AA", 6, 3, 5), gr("BB", 3, 0, 3), gr("CC", 3, 0, 2), gr("DD", 0, -3, 0)],
      B: ["B1", "B2", "B3", "B4"].map(gr0),
    },
    remainingFixtures: [
      rem("f1", "A", "AA", "BB"), rem("f2", "A", "CC", "DD"),
      rem("f3", "B", "B1", "B2"), rem("f4", "B", "B3", "B4"),
      rem("f5", "B", "B1", "B3"), rem("f6", "B", "B2", "B4"),
    ],
  };
  assert.equal(tournamentPhase(s), "group");
});

test("phase: every group down to its last round → groupFinal", () => {
  const s = {
    groups: { A: [gr("AA", 6, 3, 5), gr("BB", 3, 0, 3), gr("CC", 3, 0, 2), gr("DD", 0, -3, 0)] },
    remainingFixtures: [rem("f1", "A", "AA", "BB"), rem("f2", "A", "CC", "DD")],
  };
  assert.equal(tournamentPhase(s), "groupFinal");
});

test("phase: no group fixtures remain → knockout", () => {
  const s = {
    groups: { A: [gr("AA", 7, 4, 6), gr("BB", 4, 1, 3), gr("CC", 4, 0, 2), gr("DD", 1, -5, 1)] },
    remainingFixtures: [],
  };
  assert.equal(tournamentPhase(s), "knockout");
});

// ── stakes (brief §15) ──
test("stakes: a result that flips a side's qualification → decider", () => {
  // AA locked 1st. CC v DD play off for 2nd: the loser drops to 4th (out) behind BB(4),
  // so the result decides qualification → decider.
  const s = {
    groups: { A: [gr("AA", 6, 4, 6), gr("BB", 4, 0, 2), gr("CC", 3, 0, 2), gr("DD", 3, 0, 2)] },
    remainingFixtures: [rem("f1", "A", "CC", "DD")],
  };
  assert.equal(stakesFor(s, "f1"), "decider");
});

test("stakes: both already safe but the result swaps seeding → seeding", () => {
  // AA & BB both on 6 pts (top two locked: CC/DD can't catch them), they meet on the
  // last day; the winner finishes 1st, the loser 2nd → seeding, not a decider.
  const s = {
    groups: { A: [gr("AA", 6, 3, 5), gr("BB", 6, 3, 5), gr("CC", 0, -3, 1), gr("DD", 0, -3, 1)] },
    remainingFixtures: [rem("f1", "A", "AA", "BB")],
  };
  assert.equal(stakesFor(s, "f1"), "seeding");
});
