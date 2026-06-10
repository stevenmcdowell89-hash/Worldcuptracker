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
  ["More", () => S.renderMore(q())],
  ["News", () => S.renderNews(q())],
  ["Groups(race)", () => S.renderGroups({ forceTab: "race", ...q() })],
  ["Groups", () => S.renderGroups(q())],
  ["Stats", () => S.renderStats(q("t=discipline"))],
  ["Bracket", () => S.renderBracket(q("r=R32"))],
  ["Watch", () => S.renderWatch(q())],
  ["Club(MU)", () => S.renderClub({ arg: "manchester-united", ...q() })],
  ["Club(empty)", () => S.renderClub({ arg: "cardiff-city", ...q() })],
  ["Match(live)", () => S.renderMatch({ arg: "mA1", ...q("t=lineup") })],
  ["Match(commentary)", () => S.renderMatch({ arg: "mA1", ...q("t=live") })],
  ["Match(stats)", () => S.renderMatch({ arg: "mC0", ...q("t=stats") })],
  ["Team", () => S.renderTeam({ arg: "ARG", ...q() })],
  ["Player", () => S.renderPlayer({ arg: "150", ...q() })],
  ["Race", () => renderRace(q())],
];

let fail = 0;
for (const [name, fn] of cases) {
  try {
    const out = fn();
    const html = typeof out === "string" ? out : out.html;
    if (!html || html.length < 20) throw new Error("empty output");
    console.log(`ok   ${name.padEnd(14)} ${html.length} chars`);
  } catch (e) {
    fail++;
    console.error(`FAIL ${name}: ${e.message}`);
  }
}
console.log(fail ? `\n${fail} failed` : "\nAll screens render.");
process.exit(fail ? 1 : 0);
