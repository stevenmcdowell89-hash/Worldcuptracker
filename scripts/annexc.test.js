// Integration test for the REAL Annex C data + engine. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve as r } from "node:path";
import { fileURLToPath } from "node:url";
import { resolve, annexCSlots, thirdPlaceTable, recompute } from "../web/js/engine.js";

const root = r(dirname(fileURLToPath(import.meta.url)), "..");
const annexC = JSON.parse(readFileSync(`${root}/web/data/annexC.json`, "utf8"));
const snap = JSON.parse(readFileSync(`${root}/web/data/latest.json`, "utf8"));

const CANDIDATES = {
  "74": ["A","B","C","D","F"], "77": ["C","D","F","G","H"], "79": ["C","E","F","H","I"],
  "80": ["E","H","I","J","K"], "81": ["B","E","F","I","J"], "82": ["A","E","H","I","J"],
  "85": ["E","F","G","I","J"], "87": ["D","E","I","J","L"],
};

test("annexC.json: 495 verified combinations from FIFA's chart", () => {
  assert.equal(Object.keys(annexC.combinations).length, 495);
  assert.equal(annexC.verified, true);
  assert.ok(!annexC.placeholder, "must not be the placeholder data");
});

test("annexC matches the two known reference rows verbatim", () => {
  // Row 1: thirds from E,F,G,H,I,J,K,L
  assert.deepEqual(annexC.combinations["EFGHIJKL"],
    { E: "79", J: "85", I: "81", F: "74", H: "82", G: "77", L: "87", K: "80" });
  // Row 45: thirds from C,D,E,F,G,H,I,J
  assert.deepEqual(annexC.combinations["CDEFGHIJ"],
    { C: "79", G: "85", J: "81", D: "74", H: "82", F: "77", E: "87", I: "80" });
});

test("every one of the 495 combinations is a valid perfect matching", () => {
  for (const [key, mapping] of Object.entries(annexC.combinations)) {
    const groups = Object.keys(mapping).sort().join("");
    assert.equal(groups, key, `mapping groups must equal the key ${key}`);
    const slots = Object.values(mapping);
    assert.equal(new Set(slots).size, 8, `key ${key}: 8 distinct slots`);
    for (const [g, slot] of Object.entries(mapping)) {
      assert.ok(CANDIDATES[slot]?.includes(g), `key ${key}: 3${g} not eligible for match ${slot}`);
    }
  }
});

test("engine.resolve threads a full scenario into real R32 slots", () => {
  // Set every remaining fixture to a concrete home win, then resolve.
  const results = snap.remainingFixtures.map((f) => ({ id: f.id, home: f.home, away: f.away, hg: 2, ag: 0, exact: true }));
  const out = resolve(snap, results, annexC);
  assert.equal(out.qualifiers.length, 8);
  const slots = out.annexCSlots;
  assert.equal(Object.keys(slots).length, 8, "8 qualifying groups mapped");
  const used = Object.values(slots);
  assert.equal(new Set(used).size, 8, "8 distinct R32 matches");
  for (const [g, slot] of Object.entries(slots)) {
    assert.ok(CANDIDATES[slot]?.includes(g), `3${g} ineligible for match ${slot}`);
  }
});

test("annexCSlots is order-independent on the qualifying group set", () => {
  const a = annexCSlots(["A","B","C","D","E","F","G","H"], annexC);
  const b = annexCSlots(["H","G","F","E","D","C","B","A"], annexC);
  assert.deepEqual(a, b);
  assert.equal(Object.keys(a).length, 8);
});
