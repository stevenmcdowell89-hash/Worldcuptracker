// Bracket rendering (frontend-only — brief §13). Kept separate from bracket.js
// because that module is pure data and is also bundled into the Worker; this one
// pulls in browser/view helpers and must never be imported server-side.
//
// Two sub-tabs, BOTH fully vertical, no horizontal scroll ever:
//   • Path       — pick a team, see its route as a vertical spine R32 → Final.
//   • Bracket    — Top half / Bottom half toggle; connected ties read top-to-bottom.
// Plus bracketEmbed(): a compact inline version surfaced on the Matches feed during
// the knockout phase (§11), so progression is visible without leaving Matches.

import { state, teamName, flag } from "./data.js";
import { qualifyOutlook } from "./engine.js";

const ROUND_LABEL = { R32: "Round of 32", R16: "Round of 16", QF: "Quarter-finals", SF: "Semi-finals", Final: "Final" };

// Cross-reference the live match (status + score) for a bracket match id.
function liveMatch(snap, id) { return (snap.matches || []).find((x) => x.id === id); }

// Resolve a bracket side {code,label,score,pos,thirdPlaceSlot} into display + state.
function sideView(snap, annexC, s, lm, sideKey) {
  if (!s) return { name: "TBD", placeholder: true };
  if (s.code) {
    const live = lm && (lm.status === "live" || lm.status === "ht");
    const ft = lm && lm.status === "ft";
    const score = lm ? (sideKey === "a" ? lm.home.score : lm.away.score) : s.score;
    const oppScore = lm ? (sideKey === "a" ? lm.away.score : lm.home.score) : null;
    const won = ft && score != null && oppScore != null && score > oppScore;
    const lost = ft && score != null && oppScore != null && score < oppScore;
    const done = snap.meta?.groupStageComplete;
    const locked = done || qualifyOutlook(snap, s.code, annexC).status === "qualified";
    const tag = s.thirdPlaceSlot && !done ? (locked ? "QUALIFIED" : "CURRENT") : "";
    return { code: s.code, name: teamName(s.code), pos: s.pos, score, won, lost, live, ft, tag };
  }
  const third = !!s.thirdPlaceSlot;
  return { name: third ? `3rd ${s.thirdPlaceSlot.join("/")}` : (s.label || "TBD"), placeholder: true, pos: s.pos };
}

function sideHTML(v, sideKey) {
  if (v.placeholder) return `<div class="bx-team ph"><span class="nm">${v.name}</span>${v.pos ? `<span class="bx-pos">${v.pos}</span>` : ""}</div>`;
  const cls = ["bx-team", v.won ? "won" : "", v.lost ? "lost" : "", v.live ? "live" : ""].filter(Boolean).join(" ");
  return `<div class="${cls} clickable" data-nav="team/${v.code}">${flag(v.code)}
    <span class="nm">${v.name}</span>${v.tag ? `<span class="bx-tag ${v.tag === "QUALIFIED" ? "in" : "cur"}">${v.tag}</span>` : ""}
    <span class="sc">${v.score ?? ""}</span></div>`;
}

function tieHTML(snap, annexC, m, opts = {}) {
  const lm = liveMatch(snap, m.id);
  const a = sideView(snap, annexC, m.a, lm, "a");
  const b = sideView(snap, annexC, m.b, lm, "b");
  const status = lm && (lm.status === "live" || lm.status === "ht") ? `<span class="bx-live">${lm.minute || "LIVE"}</span>`
    : lm && lm.status === "ft" ? `<span class="bx-ft">FT</span>` : "";
  const nav = lm ? `data-nav="match/${m.id}"` : "";
  return `<div class="bx ${opts.here ? "here" : ""} clickable" ${nav}>
    <div class="bx-head"><span class="bx-no">${ROUND_LABEL[m.rd] || m.rd} · Match ${m.id}</span>${status}</div>
    ${sideHTML(a, "a")}${sideHTML(b, "b")}
  </div>`;
}

// ── Path: a team's vertical route R32 → Final ──
function teamsInBracket(snap) {
  const codes = new Set();
  for (const m of snap.bracket.matches) for (const s of [m.a, m.b]) if (s?.code) codes.add(s.code);
  return [...codes].sort((x, y) => teamName(x).localeCompare(teamName(y)));
}
function spineFor(snap, code) {
  const byId = Object.fromEntries(snap.bracket.matches.map((m) => [m.id, m]));
  let cur = snap.bracket.matches.find((m) => m.rd === "R32" && (m.a?.code === code || m.b?.code === code));
  const spine = [];
  const seen = new Set();
  while (cur && !seen.has(cur.id)) { seen.add(cur.id); spine.push(cur); cur = cur.next ? byId[cur.next] : null; }
  return spine;
}
function pathView(snap, annexC, sel) {
  const teams = teamsInBracket(snap);
  if (!teams.length) return `<div class="empty"><div class="big">🗺️</div><div class="t">The path opens when the knockouts are set</div><div>Once the group stage finishes, pick a team to trace its route to the final.</div></div>`;
  const code = teams.includes(sel) ? sel : teams[0];
  const picker = `<div class="bx-picker">${teams.map((c) =>
    `<button class="chip-btn ${c === code ? "on" : ""}" data-nav="bracket?v=path&team=${c}" data-replace>${flag(c)} ${c}</button>`).join("")}</div>`;
  const spine = spineFor(snap, code);
  // The current tie = the furthest round this team is actually a named side in.
  let hereIdx = -1;
  spine.forEach((m, i) => { if (m.a?.code === code || m.b?.code === code) hereIdx = i; });
  const rows = spine.map((m, i) => {
    const future = i > hereIdx;
    return `<div class="spine-node ${future ? "future" : ""} ${i === hereIdx ? "here" : ""}">
      <span class="spine-rail"></span>${tieHTML(snap, annexC, m, { here: i === hereIdx })}</div>`;
  }).join("");
  return `${picker}<div class="bx-path">${rows}</div>
    <div class="updated">Solid = decided · highlighted = where they are now · faded = the road ahead.</div>`;
}

// ── Structural: Top / Bottom half, connected, vertical ──
function feedersOf(snap) {
  const fmap = {};
  for (const m of snap.bracket.matches) if (m.next) (fmap[m.next] = fmap[m.next] || []).push(m.id);
  return fmap;
}
// Collect every match feeding (transitively) into rootId, including rootId.
function subtree(snap, fmap, byId, rootId) {
  const out = [];
  const walk = (id) => { const m = byId[id]; if (!m) return; (fmap[id] || []).forEach(walk); out.push(m); };
  walk(rootId);
  return out;
}
function structuralView(snap, annexC, half) {
  const byId = Object.fromEntries(snap.bracket.matches.map((m) => [m.id, m]));
  const fmap = feedersOf(snap);
  const finalM = snap.bracket.matches.find((m) => m.rd === "Final");
  const sfIds = (fmap[finalM?.id] || []);            // the two semi-finals
  const topSf = sfIds[0], botSf = sfIds[1];
  const rootSf = half === "bottom" ? botSf : topSf;
  const toggle = `<div class="tabs split">
    <button class="${half !== "bottom" ? "active" : ""}" data-nav="bracket?v=structural&half=top" data-replace>Top half</button>
    <button class="${half === "bottom" ? "active" : ""}" data-nav="bracket?v=structural&half=bottom" data-replace>Bottom half</button></div>`;
  if (!rootSf) return toggle + `<div class="banner">🔒 The bracket fills in as the knockout rounds are drawn.</div>`;
  const ms = subtree(snap, fmap, byId, rootSf);     // R32 … SF, in bottom-up order
  // group by round, ordered R32 → SF (top-to-bottom read)
  const order = ["R32", "R16", "QF", "SF"];
  const byRound = {};
  for (const m of ms) (byRound[m.rd] = byRound[m.rd] || []).push(m);
  const sections = order.filter((r) => byRound[r]).map((r) =>
    `<div class="day-label">${ROUND_LABEL[r]}</div><div class="bxwrap connected">${byRound[r].map((m) => tieHTML(snap, annexC, m)).join("")}</div>`).join("");
  const finalSec = `<div class="day-label">Final</div><div class="bxwrap">${tieHTML(snap, annexC, finalM)}</div>`;
  return `${toggle}${sections}${finalSec}`;
}

// ── the Bracket screen (under More) ──
export function renderBracket(ctx) {
  const snap = state.snap;
  if (!snap?.bracket) return { title: "Bracket", html: `<div class="empty"><div class="big">🏆</div><div class="t">Bracket not available</div></div>` };
  const knockout = (snap.meta?.phase === "knockout") || snap.meta?.groupStageComplete;
  const view = ctx.query.get("v") || (knockout ? "path" : "structural");
  const tabBar = `<div class="tabs">
    <button data-nav="bracket?v=path" data-replace class="${view === "path" ? "active" : ""}">Path</button>
    <button data-nav="bracket?v=structural" data-replace class="${view === "structural" ? "active" : ""}">Bracket</button></div>`;
  const legend = !snap.meta?.groupStageComplete
    ? `<div class="bx-legend"><span class="bx-tag in">QUALIFIED</span> through · <span class="bx-tag cur">CURRENT</span> leads as it stands</div>` : "";
  const body = view === "path"
    ? pathView(snap, state.annexC, ctx.query.get("team"))
    : structuralView(snap, state.annexC, ctx.query.get("half") || "top");
  return { title: "Bracket", html: tabBar + legend + body };
}

// ── compact inline embed for the Matches feed during knockout (§11) ──
export function bracketEmbed(snap, annexC) {
  if (!snap?.bracket) return "";
  // Show the earliest unfinished round's ties (the "current" knockout round).
  const rounds = snap.bracket.rounds;
  let roundId = rounds[0];
  for (const r of rounds) {
    const ms = snap.bracket.matches.filter((m) => m.rd === r);
    if (ms.some((m) => { const lm = liveMatch(snap, m.id); return !lm || lm.status !== "ft"; })) { roundId = r; break; }
  }
  const ms = snap.bracket.matches.filter((m) => m.rd === roundId);
  const cards = ms.slice(0, 8).map((m) => tieHTML(snap, annexC, m)).join("");
  return `<div class="sec-head"><h2>${ROUND_LABEL[roundId] || roundId}</h2><span class="go" data-nav="bracket">Full bracket ›</span></div>
    <div class="bxwrap embed">${cards}</div>`;
}
