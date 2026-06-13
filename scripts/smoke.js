// Renders every screen against the real mock snapshot in node (no browser) to catch
// runtime errors in the view layer. Run: node scripts/smoke.js
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { state } from "../web/js/data.js";
import * as S from "../web/js/screens.js";
import { renderRace } from "../web/js/race.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
state.snap = JSON.parse(readFileSync(`${root}/web/data/latest.json`, "utf8"));
state.colours = JSON.parse(readFileSync(`${root}/web/data/teamColours.json`, "utf8"));
state.annexC = JSON.parse(readFileSync(`${root}/web/data/annexC.json`, "utf8"));

const q = (s = "") => ({ query: new URLSearchParams(s) });
const cases = [
  ["Matches", () => S.renderMatches(q())],
  ["Matches(race)", () => S.renderMatches(q("v=race"))],
  ["More", () => S.renderMore(q())],
  ["Results", () => S.renderResults(q())],
  ["News", () => S.renderNews(q())],
  ["Groups(race)", () => S.renderGroups({ forceTab: "race", ...q() })],
  ["Groups", () => S.renderGroups(q())],
  ["Stats", () => S.renderStats(q("t=discipline"))],
  ["Bracket(path)", () => S.renderBracket(q("v=path"))],
  ["Bracket(struct)", () => S.renderBracket(q("v=structural&half=bottom"))],
  ["Watch", () => S.renderWatch(q())],
  ["Club(MU)", () => S.renderClub({ arg: "manchester-united", ...q() })],
  ["Club(empty)", () => S.renderClub({ arg: "cardiff-city", ...q() })],
  ["Match(live)", () => S.renderMatch({ arg: "mA1", ...q("t=lineup") })],
  ["Match(commentary)", () => S.renderMatch({ arg: "mA1", ...q("t=commentary") })],
  ["Match(stats)", () => S.renderMatch({ arg: "mC0", ...q("t=stats") })],
  ["Match(scheduled)", () => S.renderMatch({ arg: "f2", ...q() })],   // reminder card + channel line
  ["Team", () => S.renderTeam({ arg: "ARG", ...q() })],
  ["Player", () => S.renderPlayer({ arg: "150", ...q() })],
  ["Race", () => renderRace(q())],
];

let fail = 0;
const run = (name, fn) => {
  try {
    const out = fn();
    const html = typeof out === "string" ? out : out.html;
    if (!html || html.length < 20) throw new Error("empty output");
    console.log(`ok   ${name.padEnd(16)} ${html.length} chars`);
  } catch (e) { fail++; console.error(`FAIL ${name}: ${e.message}`); }
};
for (const [name, fn] of cases) run(name, fn);

// Exercise the Matches feed under every phase (the §11 layouts must all render).
const realPhase = state.snap.meta.phase;
for (const ph of ["pre", "group", "groupFinal", "knockout"]) {
  state.snap.meta.phase = ph;
  run(`Matches(${ph})`, () => S.renderMatches(q()));
  run(`Groups(${ph})`, () => S.renderGroups(q()));
}
state.snap.meta.phase = realPhase;

// Morning catch-up (feature 2): force the window at 09:00 UK on the slate's first
// day so the layout exercises "last night" + "today" + "at stake" deterministically.
const slateDay = state.snap.remainingFixtures[0].kickoff.slice(0, 10);
const morningNow = Date.parse(`${slateDay}T08:00:00Z`);   // 09:00 UK in June (BST)
for (const ph of ["group", "groupFinal", "knockout"]) {
  state.snap.meta.phase = ph;
  run(`Morning(${ph})`, () => S.renderMatches({ now: morningNow, query: new URLSearchParams("morning=1") }));
}
state.snap.meta.phase = realPhase;

console.log(fail ? `\n${fail} failed` : "\nAll screens render.");
process.exit(fail ? 1 : 0);
