// Bracket ↔ live-fixture join tests: real knockout fixtures carry API ids, so the
// bracket (FIFA match numbers 73–104) joins through the Worker-assigned slot key.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { state } from "./data.js";
import { liveMatch, bracketEmbed } from "./bracketview.js";

const SNAP = () => ({
  meta: { phase: "knockout", groupStageComplete: true },
  teams: { AAA: { name: "Alphaland" }, BBB: { name: "Betaland" }, CCC: { name: "Gammaland" }, DDD: { name: "Deltaland" } },
  bracket: {
    rounds: ["R32"],
    matches: [
      { id: "73", rd: "R32", a: { code: "AAA", label: "Winner Group A", pos: "1A" }, b: { code: "BBB", label: "Runner-up Group B", pos: "2B" }, next: "90" },
      { id: "74", rd: "R32", a: { code: null, label: "3rd C/D/F" }, b: { code: "DDD", pos: "1E" }, next: "90" },
    ],
  },
  matches: [
    // ft on pens; API id ≠ FIFA number — joined via slot
    { id: "991001", slot: "R32-M73", stage: "Round of 32", status: "ft", kickoff: "2026-06-28T19:00:00Z",
      home: { code: "AAA", score: 1 }, away: { code: "BBB", score: 1 }, pens: { h: 4, a: 2 } },
    // live, and the bracket's a-side is an unresolved third-place placeholder —
    // the real fixture supplies the team
    { id: "991002", slot: "R32-M74", stage: "Round of 32", status: "live", minute: "55'", kickoff: "2026-06-29T19:00:00Z",
      home: { code: "CCC", score: 2 }, away: { code: "DDD", score: 0 } },
  ],
});

// teamName()/flag() read state.snap (data.js) — point it at the same object.
const use = (s) => { state.snap = s; return s; };

test("liveMatch joins bracket ids to fixtures via the slot key", () => {
  const s = use(SNAP());
  assert.equal(liveMatch(s, "73").id, "991001");
  assert.equal(liveMatch(s, "74").id, "991002");
  assert.equal(liveMatch(s, "75"), undefined);
});

test("bracket ties: scores + shootout tally + winner, tap-through to the real fixture", () => {
  const html = bracketEmbed(use(SNAP()), null);
  assert.ok(html.includes('data-nav="match/991001"'), "tie links to the API fixture id");
  assert.ok(html.includes("FT · PENS"));
  assert.ok(html.includes("(4)") && html.includes("(2)"), "per-side shootout tally shown");
  // level on goals → the shootout decides won/lost styling
  assert.match(html, /bx-team won[^>]*>[\s\S]*?Alphaland/);
  assert.match(html, /bx-team lost[^>]*>[\s\S]*?Betaland/);
});

test("a real fixture fills a side the bracket could only label", () => {
  const html = bracketEmbed(use(SNAP()), null);
  assert.ok(html.includes("Gammaland"), "third-place placeholder replaced by the actual team");
  assert.ok(html.includes("55'"), "live minute surfaces on the tie");
});

test("placeholder fixtures (TBD teams) never override a projected side", () => {
  const s = use(SNAP());
  s.matches[1].home.code = "TBD";                      // not in snap.teams
  const html = bracketEmbed(s, null);
  assert.ok(html.includes("3rd C/D/F"), "projection label kept when the fixture has no real team");
});

// keep the module-under-test honest about its data.js dependency in node
test("state import is inert in node (no browser APIs touched)", () => {
  assert.equal(typeof state, "object");
});
