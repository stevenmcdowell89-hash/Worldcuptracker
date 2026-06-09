// Engine unit tests — run with: npm test  (node --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  discPoints, compareGroupRows, compareThird, recompute, thirdPlaceTable,
  qualifiersFrom, resolve, verdicts, plainEnglish, resultFromWDL, annexCSlots,
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

test("resultFromWDL gives default margins and flags non-exact", () => {
  const fx = { id: "f1", home: "X", away: "Y" };
  assert.deepEqual(resultFromWDL(fx, "W"), { id: "f1", home: "X", away: "Y", hg: 1, ag: 0, exact: false });
  assert.deepEqual(resultFromWDL(fx, "D"), { id: "f1", home: "X", away: "Y", hg: 1, ag: 1, exact: false });
});
