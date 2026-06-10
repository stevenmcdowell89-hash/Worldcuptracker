// UK TV channel mapping tests: listings parser (real live-footballontv.com markup),
// seed/live merge, knockout slot assignment, and conservative snapshot annotation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseListings, mergeListings, assignKnockoutSlots, annotateTv, normTeam, normRound, ukDateOf, ukTimeOf } from "../worker/tv.js";

// Markup captured from the live source (2026-06-10) — the parser contract.
const pill = (t) => `<span class="channel-pill" style="background-color: #127b60;border: 0;">${t}</span>`;
const fixture = (time, teams, comp, pills) =>
  `<div class="fixture"><div class="fixture__time">${time}</div><div class="fixture__teams">${teams}  </div><div class="fixture__competition">${comp}</div><div class="fixture__channel"><div class="span3 channels">${pills.map(pill).join("")}</div></div></div>`;
const HTML = `
<div class="fixture-date">Thursday 11th June 2026</div>
${fixture("20:00", "Mexico v South Africa", "FIFA World Cup 2026&nbsp;Group A", ["ITV1", "STV", "ITVX", "STV Player"])}
${fixture("19:00", "Arsenal v Chelsea", "Premier League", ["Sky Sports"])}
<div class="anchor"><a id="2026Jun12"></a></div>
<div class="fixture-date">Friday 12th June 2026</div>
${fixture("02:00", "USA v Paraguay", "FIFA World Cup 2026&nbsp;Group D", ["BBC One", "BBC iPlayer", "BBC Sport Website"])}
${fixture("20:00", "Bosnia-Herzegovina v Qatar", "FIFA World Cup 2026&nbsp;Group B", ["ITV4", "ITVX"])}
<div class="fixture-date">Sunday 28th June 2026</div>
${fixture("20:00", "TBC", "FIFA World Cup 2026&nbsp;Round of 32", ["TBC"])}
`;

test("parser: extracts WC fixtures only, with date/time/teams/round/channel/stream", () => {
  const l = parseListings(HTML);
  assert.equal(l.length, 4);                                   // Premier League excluded
  assert.deepEqual(l[0], { date: "2026-06-11", time: "20:00", home: "Mexico", away: "South Africa", round: "Group A", channel: "ITV1", stream: "ITVX" });
  assert.equal(l[1].channel, "BBC One");
  assert.equal(l[1].stream, "BBC iPlayer");                    // BBC Sport Website ignored
  assert.equal(l[2].channel, "ITV4");                          // linear preferred over ITVX
  // knockout TBC: round + time survive, no teams, no guessed channel
  assert.deepEqual(l[3], { date: "2026-06-28", time: "20:00", home: null, away: null, round: "R32", channel: null, stream: null });
});

test("team normalisation: aliases + accents", () => {
  assert.equal(normTeam("Côte d'Ivoire"), normTeam("Ivory Coast"));
  assert.equal(normTeam("USA"), normTeam("United States"));
  assert.equal(normTeam("Korea Republic"), normTeam("South Korea"));
  assert.equal(normTeam("Curaçao"), normTeam("Curacao"));
  assert.equal(normTeam("Türkiye"), normTeam("Turkey"));
  assert.notEqual(normTeam("South Africa"), normTeam("South Korea"));
});

test("round normalisation: order-sensitive ('Quarter-finals' is not the final)", () => {
  assert.deepEqual(normRound("FIFA World Cup 2026 Group A"), { type: "group", group: "A" });
  assert.deepEqual(normRound("Quarter-finals"), { type: "ko", rd: "QF" });
  assert.deepEqual(normRound("3rd Place Final"), { type: "ko", rd: "3P" });
  assert.deepEqual(normRound("Final"), { type: "ko", rd: "F" });
  assert.deepEqual(normRound("Group Stage - 2"), { type: "group", group: null });
});

test("merge: live overrides seed; an empty live entry never wipes a known channel", () => {
  const seed = [
    { date: "2026-06-11", time: "20:00", home: "Mexico", away: "South Africa", round: "Group A", channel: "ITV1", stream: "ITVX" },
    { date: "2026-06-28", time: "20:00", home: null, away: null, round: "R32", channel: null, stream: null },
  ];
  const live = [
    { date: "2026-06-11", time: "20:00", home: "South Africa", away: "Mexico", round: "Group A", channel: null, stream: null },  // unknown — must not downgrade
    { date: "2026-06-28", time: "20:00", home: null, away: null, round: "R32", channel: "BBC One", stream: "BBC iPlayer" },      // gap filled
  ];
  const merged = mergeListings(seed, live);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((l) => l.home === "Mexico").channel, "ITV1");
  assert.equal(merged.find((l) => !l.home).channel, "BBC One");
});

test("knockout slots: official FIFA numbering, chronological within each round", () => {
  const matches = [
    { id: "b", stage: "Round of 32", kickoff: "2026-06-29T17:00:00Z" },
    { id: "a", stage: "Round of 32", kickoff: "2026-06-28T19:00:00Z" },
    { id: "f", stage: "Final", kickoff: "2026-07-19T19:00:00Z" },
    { id: "g", stage: "Group Stage", group: "A", kickoff: "2026-06-11T19:00:00Z" },
  ];
  const slots = assignKnockoutSlots(matches);
  assert.equal(slots.a, "R32-M73");
  assert.equal(slots.b, "R32-M74");
  assert.equal(slots.f, "F-M104");
  assert.equal(slots.g, undefined);                            // group games key by fixture id
});

test("annotate: name+date match for groups; never guess when unknown", () => {
  const teams = { MEX: { name: "Mexico" }, RSA: { name: "South Africa" }, USA: { name: "USA" }, PAR: { name: "Paraguay" } };
  const listings = [
    { date: "2026-06-11", time: "20:00", home: "Mexico", away: "South Africa", round: "Group A", channel: "ITV1", stream: "ITVX" },
  ];
  const matches = [
    // 19:00Z = 20:00 UK (BST) on the same UK date
    { id: "1", stage: "Group Stage", group: "A", kickoff: "2026-06-11T19:00:00Z", home: { code: "MEX" }, away: { code: "RSA" } },
    { id: "2", stage: "Group Stage", group: "D", kickoff: "2026-06-13T01:00:00Z", home: { code: "USA" }, away: { code: "PAR" } },
  ];
  const info = annotateTv(matches, teams, { listings });
  assert.deepEqual(matches[0].tv, { channel: "ITV1", stream: "ITVX" });
  assert.equal(matches[1].tv, undefined);                      // no listing → show nothing
  assert.equal(info.mapped, 1);
});

test("annotate: knockout matches by round + UK date + nearest time (teams TBC)", () => {
  const listings = [
    { date: "2026-06-28", time: "20:00", home: null, away: null, round: "R32", channel: "BBC One", stream: "BBC iPlayer" },
    { date: "2026-06-28", time: "23:59", home: null, away: null, round: "R32", channel: "ITV1", stream: "ITVX" },
  ];
  const matches = [
    { id: "k1", stage: "Round of 32", kickoff: "2026-06-28T19:00:00Z", home: { code: "TBD" }, away: { code: "TBD" } },  // 20:00 UK
    { id: "k2", stage: "Round of 32", kickoff: "2026-06-28T15:00:00Z", home: { code: "TBD" }, away: { code: "TBD" } },  // 16:00 UK — >45min from both
  ];
  annotateTv(matches, {}, { listings });
  assert.equal(matches[0].slot, "R32-M74");                    // 2nd chronologically that round
  assert.deepEqual(matches[0].tv, { channel: "BBC One", stream: "BBC iPlayer" });
  assert.equal(matches[1].tv, undefined);                      // no confident match → nothing
});

test("annotate: byFixture and bySlot overrides win", () => {
  const matches = [
    { id: "1", stage: "Group Stage", group: "A", kickoff: "2026-06-11T19:00:00Z", home: { code: "MEX" }, away: { code: "RSA" } },
    { id: "k1", stage: "Round of 32", kickoff: "2026-06-28T19:00:00Z", home: { code: "TBD" }, away: { code: "TBD" } },
  ];
  annotateTv(matches, {}, {
    listings: [{ date: "2026-06-11", time: "20:00", home: "Mexico", away: "South Africa", round: "Group A", channel: "ITV1", stream: "ITVX" }],
    byFixture: { 1: { channel: "BBC Two", stream: "BBC iPlayer" } },
    bySlot: { "R32-M73": { channel: "ITV4", stream: "ITVX" } },
  });
  assert.equal(matches[0].tv.channel, "BBC Two");
  assert.equal(matches[1].tv.channel, "ITV4");
});

test("UK wall-clock helpers (BST in June)", () => {
  assert.equal(ukDateOf("2026-06-13T01:00:00Z"), "2026-06-13");  // 02:00 UK
  assert.equal(ukTimeOf("2026-06-13T01:00:00Z"), "02:00");
  assert.equal(ukDateOf("2026-06-13T23:30:00Z"), "2026-06-14");  // rolls to the next UK day
});
