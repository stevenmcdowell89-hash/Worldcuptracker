// Shared, static 2026 knockout bracket (matches 73–104) + third-place resolver.
// Used by BOTH the Worker (real data) and scripts/gen-mock.js (demo) so the two can
// never drift. Match ids === official FIFA match numbers.
//
// The eight R32 third-place slots and their candidate group sets come straight from
// the official schedule; the resolver uses Annex C (web/data/annexC.json) to fill
// them once the group stage is complete. See scripts/gen-annexc.js.

import { thirdPlaceTable, qualifiersFrom, annexCSlots } from "./engine.js";

// [type, arg]: win = group winner, run = runner-up, tp = third-place candidate set
const R32_DEF = [
  { id: "73", a: ["run", "A"], b: ["run", "B"] },
  { id: "74", a: ["win", "E"], b: ["tp", ["A", "B", "C", "D", "F"]] },
  { id: "75", a: ["win", "F"], b: ["run", "C"] },
  { id: "76", a: ["win", "C"], b: ["run", "F"] },
  { id: "77", a: ["win", "I"], b: ["tp", ["C", "D", "F", "G", "H"]] },
  { id: "78", a: ["run", "E"], b: ["run", "I"] },
  { id: "79", a: ["win", "A"], b: ["tp", ["C", "E", "F", "H", "I"]] },
  { id: "80", a: ["win", "L"], b: ["tp", ["E", "H", "I", "J", "K"]] },
  { id: "81", a: ["win", "D"], b: ["tp", ["B", "E", "F", "I", "J"]] },
  { id: "82", a: ["win", "G"], b: ["tp", ["A", "E", "H", "I", "J"]] },
  { id: "83", a: ["run", "K"], b: ["run", "L"] },
  { id: "84", a: ["win", "H"], b: ["run", "J"] },
  { id: "85", a: ["win", "B"], b: ["tp", ["E", "F", "G", "I", "J"]] },
  { id: "86", a: ["win", "J"], b: ["run", "H"] },
  { id: "87", a: ["win", "K"], b: ["tp", ["D", "E", "I", "J", "L"]] },
  { id: "88", a: ["run", "D"], b: ["run", "G"] },
];
const PAIRS = {
  R16: [[74, 77], [73, 75], [83, 84], [81, 82], [76, 78], [79, 80], [86, 88], [85, 87]],
  QF: [[89, 90], [93, 94], [91, 92], [95, 96]],
  SF: [[97, 98], [99, 100]],
  Final: [[101, 102]],
};
const START = { R16: 89, QF: 97, SF: 101, Final: 104 };

/**
 * Build the bracket from current (sorted) group tables.
 * @param groups  sorted group tables {A:[rows…],…}
 * @param annexC  loaded annexC.json (may be null)
 * @param opts.groupStageComplete  when true, third-place slots resolve to real teams
 */
export function buildBracket(groups, annexC, opts = {}) {
  const done = !!opts.groupStageComplete;
  const code = (g, pos) => groups?.[g]?.[pos]?.code || null;

  // resolve third-place group → R32 slot via Annex C (only meaningful once complete)
  let slotByGroup = {};            // groupLetter -> matchId
  let thirdCodeByGroup = {};       // groupLetter -> third-placed team code
  if (done) {
    const third = thirdPlaceTable(groups);
    const qualGroups = third.slice(0, 8).map((t) => t.group);
    slotByGroup = annexCSlots(qualGroups, annexC);   // group -> matchId
    third.forEach((t) => (thirdCodeByGroup[t.group] = t.code));
  }
  const groupForSlot = Object.fromEntries(Object.entries(slotByGroup).map(([g, m]) => [m, g]));

  const sideFor = (def, matchId) => {
    const [type, arg] = def;
    if (type === "win") return { code: code(arg, 0), label: `Winner Group ${arg}`, pos: `1${arg}` };
    if (type === "run") return { code: code(arg, 1), label: `Runner-up Group ${arg}`, pos: `2${arg}` };
    // third-place slot
    const g = groupForSlot[matchId];
    if (done && g) return { code: thirdCodeByGroup[g] || null, label: `3rd Group ${g}`, pos: `3${g}`, thirdPlaceSlot: arg };
    return { code: null, label: `3rd ${arg.join("/")}`, thirdPlaceSlot: arg };
  };

  const matches = R32_DEF.map((m) => ({ id: m.id, rd: "R32", a: sideFor(m.a, m.id), b: sideFor(m.b, m.id) }));
  for (const rd of ["R16", "QF", "SF", "Final"]) {
    PAIRS[rd].forEach((pair, i) => matches.push({
      id: String(START[rd] + i), rd,
      a: { code: null, label: `Winner Match ${pair[0]}` },
      b: { code: null, label: `Winner Match ${pair[1]}` },
    }));
  }
  // wire "next" pointers
  const nextOf = {};
  for (const rd of ["R16", "QF", "SF", "Final"]) PAIRS[rd].forEach((pair, i) =>
    pair.forEach((src) => (nextOf[src] = String(START[rd] + i))));
  matches.forEach((m) => { if (nextOf[+m.id]) m.next = nextOf[+m.id]; });

  return { rounds: ["R32", "R16", "QF", "SF", "Final"], matches };
}
