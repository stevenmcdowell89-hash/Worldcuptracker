// Phase 3 unit tests (channel map, morning-view composition, reminders). Pure logic
// only — the view layer is covered by scripts/smoke.js. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { state } from "../web/js/data.js";
import { resultOf, withoutResults, verdictFlips, recompute } from "../web/js/engine.js";
import { channelFor, slotKey } from "../web/js/tv.js";
import { overnightFinished, matchesOn, resultsLine, fixturesLine } from "../web/js/digest.js";
import { buildIcs } from "../web/js/reminders.js";
import { isMorningWindow, ukDay } from "../web/js/morning.js";

// ── engine: reconstruct the picture before a result (morning view) ──
test("withoutResults subtracts a result and restores it to the fixtures", () => {
  const snap = {
    groups: { A: [
      { code: "X", P: 1, W: 1, D: 0, L: 0, GF: 2, GA: 1, GD: 1, Pts: 3, yellow: 0, red: 0 },
      { code: "Y", P: 1, W: 0, D: 0, L: 1, GF: 1, GA: 2, GD: -1, Pts: 0, yellow: 0, red: 0 },
    ] },
    remainingFixtures: [],
  };
  const res = { id: "x", group: "A", home: "X", away: "Y", hg: 2, ag: 1 };
  const before = withoutResults(snap, [res]);
  const bx = before.groups.A.find((r) => r.code === "X");
  const by = before.groups.A.find((r) => r.code === "Y");
  assert.deepEqual([bx.P, bx.W, bx.Pts, bx.GF, bx.GA], [0, 0, 0, 0, 0]);
  assert.deepEqual([by.P, by.L, by.Pts, by.GF, by.GA], [0, 0, 0, 0, 0]);
  assert.ok(before.remainingFixtures.some((f) => f.id === "x"));     // restored as still-to-play

  // re-applying the result returns the original totals (exact inverse)
  const after = recompute(before, [res]);
  const ax = after.A.find((r) => r.code === "X");
  assert.deepEqual([ax.P, ax.W, ax.Pts, ax.GF, ax.GA, ax.GD], [1, 1, 3, 2, 1, 1]);
});

test("resultOf only yields finished group matches with a score", () => {
  assert.equal(resultOf({ id: "1", stage: "Round of 32", home: { code: "X", score: 1 }, away: { code: "Y", score: 0 } }), null); // no group
  assert.equal(resultOf({ id: "1", group: "A", home: { code: "X", score: null }, away: { code: "Y", score: 1 } }), null);        // no score
  const r = resultOf({ id: "9", group: "A", home: { code: "X", score: 2 }, away: { code: "Y", score: 1 } });
  assert.deepEqual([r.id, r.group, r.home, r.away, r.hg, r.ag], ["9", "A", "X", "Y", 2, 1]);
});

test("verdictFlips is empty with no results and returns an array on the mock", () => {
  assert.deepEqual(verdictFlips({ groups: {}, remainingFixtures: [] }, []), []);
});

// ── feature 1: channel map ──
test("channelFor: group by fixture id, knockout by slot, else null (never guess)", () => {
  state.tvUK = { fixtures: { f2: { channel: "ITV4", stream: "ITVX" } }, knockout: { "R32-M73": { channel: "BBC One" } } };
  assert.equal(channelFor({ id: "f2", group: "A" }).channel, "ITV4");
  assert.equal(channelFor({ id: "73", stage: "Round of 32" }).channel, "BBC One");
  assert.equal(channelFor({ id: "zzz", group: "A" }), null);      // unmapped group game → nothing
  assert.equal(channelFor({ id: "99", stage: "Round of 32" }), null); // unmapped knockout → nothing
  assert.equal(slotKey({ id: "73", stage: "Round of 32" }), "R32-M73");
  assert.equal(slotKey({ id: "5", group: "A", stage: "Group Stage" }), null);
});

// ── feature 2: shared digest selection (one source, two surfaces) ──
test("digest: overnight window, today's slate, and the compact lines", () => {
  const now = Date.parse("2026-06-25T08:00:00Z");
  const snap = { matches: [
    { id: "a", status: "ft", kickoff: "2026-06-24T20:00:00Z", home: { code: "X", score: 2 }, away: { code: "Y", score: 1 } },
    { id: "b", status: "ft", kickoff: "2026-06-20T20:00:00Z", home: { code: "P", score: 0 }, away: { code: "Q", score: 0 } }, // too old
    { id: "c", status: "scheduled", kickoff: "2026-06-25T16:00:00Z", home: { code: "M", score: null }, away: { code: "N", score: null } },
  ] };
  const overnight = overnightFinished(snap, now);
  assert.deepEqual(overnight.map((m) => m.id), ["a"]);
  assert.equal(resultsLine(overnight), "X 2-1 Y");
  const today = matchesOn(snap, "2026-06-25");
  assert.deepEqual(today.map((m) => m.id), ["c"]);
  assert.equal(fixturesLine(today), "M v N");
  assert.equal(resultsLine([]), null);
});

// ── feature 2: morning window (UK wall-clock, BST in summer) ──
test("isMorningWindow: 06:00 ≤ UK hour < 13:00", () => {
  assert.equal(isMorningWindow(new Date("2026-06-20T05:30:00+01:00")), false);
  assert.equal(isMorningWindow(new Date("2026-06-20T06:00:00+01:00")), true);
  assert.equal(isMorningWindow(new Date("2026-06-20T12:59:00+01:00")), true);
  assert.equal(isMorningWindow(new Date("2026-06-20T13:00:00+01:00")), false);
  assert.equal(ukDay(new Date("2026-06-20T00:30:00+01:00")), "2026-06-20");
});

// ── feature 3: .ics generation ──
test("buildIcs: a valid VEVENT with a 15-minute alarm and the channel", () => {
  state.snap = { matches: [], teams: { X: { name: "Xland" }, Y: { name: "Yland" } } };
  state.tvUK = { fixtures: { f2: { channel: "BBC One", stream: "iPlayer" } } };
  const m = { id: "f2", group: "A", kickoff: "2026-12-31T18:00:00Z", home: { code: "X" }, away: { code: "Y" }, venue: "Wembley" };
  const ics = buildIcs(m);
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /BEGIN:VEVENT/);
  assert.match(ics, /DTSTART:20261231T180000Z/);
  assert.match(ics, /SUMMARY:⚽ Xland v Yland/);
  assert.match(ics, /BEGIN:VALARM/);
  assert.match(ics, /TRIGGER:-PT15M/);
  assert.match(ics, /Watch: BBC One \/ iPlayer/);
});
