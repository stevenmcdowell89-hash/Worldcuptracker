// Screen renderers. Each returns an HTML string (or { html, title, mount }).
// Progression intelligence is woven in: the "affects the race" marker on match
// rows, the one-liner on match pages, the verdict chip on team pages (brief §7).

import { state, colour, teamName, player, flag, statusChip, fmtTime, fmtDay, countdown, gd, timeAgo } from "./data.js";
import { qualifyOutlook } from "./engine.js";
import { raceContent } from "./race.js";
import { bracketEmbed, renderBracket } from "./bracketview.js";
import { notificationsCardHTML, mountNotifications } from "./notifications.js";
export { renderBracket };   // the Bracket screen now lives in bracketview.js (vertical Path/structural, §13)

const S = () => state.snap;
// The phase flag (brief §11). Falls back to a sensible value if an old snapshot
// predates it, so the frontend still works offline against either.
function phase() {
  const m = S().meta || {};
  if (m.phase) return m.phase;
  if (m.started === false) return "pre";
  if (m.groupStageComplete) return "knockout";
  return "group";
}

// ── shared bits ──
function compactRaceCard(prominent = false) {
  const race = S().thirdPlaceRace || [];
  const window = race.slice(prominent ? 4 : 5, prominent ? 10 : 9); // wider window when it's the peak
  const moving = S().meta?.spotsMoving ?? race.filter((t) => t.status === "sweating").length;
  const rows = window.map((t) => {
    const below = t.rank > 8;
    return `<div class="cutrow ${below ? "below" : ""} clickable" data-nav="team/${t.code}">
      <span class="pos">${t.rank}</span>${flag(t.code)}
      <span class="nm">${teamName(t.code)} <span class="grp">${t.group}</span></span>
      ${statusChip(t.status, false)}
      <span class="pts">${t.Pts}</span><span class="gd">${gd(t.GD)}</span>
    </div>${t.rank === 8 ? cutLineHTML() : ""}`;
  }).join("");
  const head = prominent
    ? `<h3><span class="livedot"></span>Race for the last 8 — LIVE</h3><span class="go" data-nav="groups?t=race">Full table ›</span>`
    : `<h3>Third-place race <span class="faint" style="font-weight:600;text-transform:none">· 8 of 12 reach R32</span></h3><span class="go" data-nav="groups?t=race">Full table ›</span>`;
  return `<div class="racecard ${prominent ? "prominent" : ""}">
    <div class="head">${head}</div>
    ${prominent && moving ? `<div class="race-sub">The cut line is live — ${moving} spot${moving === 1 ? "" : "s"} still moving.</div>` : ""}
    <div class="cutlist">${rows}</div>
  </div>`;
}
function cutLineHTML() {
  return `<div class="cutline"><span class="lbl">cut</span><span class="ln"></span><span class="lbl">8th</span></div>`;
}

const STAKE = {
  decider: { cls: "decider", lbl: "Decider" },
  seeding: { cls: "seeding", lbl: "Seeding" },
  dead: { cls: "dead", lbl: "Dead rubber" },
};
function matchRow(m, opts = {}) {
  const live = m.status === "live" || m.status === "ht";
  const ft = m.status === "ft";
  let mid;
  if (live) mid = `<span class="score">${m.home.score}–${m.away.score}</span><span class="min">${m.minute || "LIVE"}</span>`;
  else if (ft) mid = `<span class="score">${m.home.score}–${m.away.score}</span><span class="ko">FT</span>`;
  else mid = `<span class="ko">${fmtTime(m.kickoff)}</span>`;
  const stageLabel = m.group ? `Group ${m.group}` : (m.stage && m.stage !== "Group Stage" ? m.stage : "");
  const st = opts.showStakes && m.status === "scheduled" && m.stakes && STAKE[m.stakes];
  const tags = [
    stageLabel ? `<span class="grp-pill">${stageLabel}</span>` : "",
    m.affectsCut && !st ? `<span class="stake decider">Affects the last-8 race</span>` : "",
    st ? `<span class="stake ${st.cls}">${st.lbl}</span>` : "",
  ].filter(Boolean).join("");
  const meta = tags ? `<div class="match-meta">${tags}</div>` : "";
  return `<div class="match-card">
    <div class="match clickable" data-nav="match/${m.id}">
      <span class="side home"><span class="nm">${teamName(m.home.code)}</span>${flag(m.home.code)}</span>
      <span class="mid">${mid}</span>
      <span class="side away">${flag(m.away.code)}<span class="nm">${teamName(m.away.code)}</span></span>
    </div>${meta}</div>`;
}

// The Matches | Race-for-R32 top split (§11). Underlined two-tab style (NOT a pill).
// The right side flashes when the race is live (groupFinal).
function matchesToggle(view) {
  const live = phase() === "groupFinal";
  const raceCls = (view === "race" ? "active " : "") + (live ? "flash" : "");
  return `<div class="tabs split">
    <button data-nav="matches" data-replace class="${view === "matches" ? "active" : ""}">Matches</button>
    <button data-nav="matches?v=race" data-replace class="${raceCls}">
      ${live ? '<span class="livedot"></span>' : ""}Race for R32${live ? ' <span class="livebadge">LIVE</span>' : ""}
    </button></div>`;
}

// Pre-tournament hero: countdown to the opening match (§11). The club/player-watch
// piece is deliberately kept out of here — it lives only on the Watch tab (§1a rule 3).
function preHero(upcoming) {
  const first = upcoming[0];
  const cd = first ? `<div class="pre-count" data-countdown="${first.kickoff}">${countdown(first.kickoff)}</div>
      <div class="pre-fix">${teamName(first.home.code)} v ${teamName(first.away.code)} · ${fmtDay(first.kickoff)}</div>` : "";
  return `<div class="prehero">
    <div class="pre-kicker">2026 FIFA World Cup</div>
    ${cd}
  </div>`;
}

// ── Matches (home spine) — accretes phase-relevant context inline (§11) ──
export function renderMatches(ctx = {}) {
  const view = ctx.query?.get("v") || "matches";
  const ph = phase();
  const raceRelevant = ph === "group" || ph === "groupFinal";
  const toggle = raceRelevant ? matchesToggle(view) : "";
  // The Race view of the Matches tab reuses the canonical Race content (§11).
  if (view === "race" && raceRelevant) return toggle + raceContent();

  const matches = S().matches || [];
  const live = matches.filter((m) => m.status === "live" || m.status === "ht");
  const upcoming = matches.filter((m) => m.status === "scheduled").sort((a, b) => (a.kickoff || "").localeCompare(b.kickoff || ""));
  const finished = matches.filter((m) => m.status === "ft").sort((a, b) => (b.kickoff || "").localeCompare(a.kickoff || ""));

  const stale = S().meta?.stale ? `<div class="banner">⚠️ Showing the last good update — live data is briefly unavailable.</div>` : "";
  const showStakes = ph === "group" || ph === "groupFinal";
  const sec = (label, list, o) => list.length
    ? `<div class="day-label">${label}</div><div class="section">${list.map((m) => matchRow(m, o)).join("")}</div>` : "";

  const liveSec = sec(live.length ? "● Live" : "", live, { showStakes });
  const resultsSec = finished.length ? sec("Latest results", finished.slice(0, 8)) : "";
  const head = `${stale}${liveSec}${resultsSec}`;
  const foot = `<div class="updated">Updated ${fmtTime(S().meta?.updated)} · ${S().meta?.stage}</div>`;

  // ── PRE: countdown hero + clubs nudge above the opening fixtures ──
  if (ph === "pre") {
    const byDay = upcomingByDay(upcoming);
    return `${stale}${preHero(upcoming)}${resultsSec}${byDay.map(daySec).join("")}${foot}`;
  }

  // ── GROUP FINAL: interleave each group's table beneath that group's final games ──
  if (ph === "groupFinal") {
    const byGroup = {};
    for (const m of upcoming) (byGroup[m.group || "—"] = byGroup[m.group || "—"] || []).push(m);
    const groupBlocks = Object.keys(byGroup).sort().map((g) => {
      const fixtures = byGroup[g].map((m) => matchRow(m, { showStakes })).join("");
      const table = S().groups?.[g]
        ? `<div class="block embed-table">${groupTableHTML(g)}</div>` : "";
      return `<div class="day-label">Group ${g} · final games</div><div class="section">${fixtures}</div>${table}`;
    }).join("");
    return `${toggle}${head}${compactRaceCard(true)}${groupBlocks}${foot}`;
  }

  // ── KNOCKOUT: KO fixtures lead, then the bracket embedded inline (§11/§13) ──
  if (ph === "knockout") {
    const byDay = upcomingByDay(upcoming);
    return `${head}${byDay.map(daySec).join("")}${bracketEmbed(S(), state.annexC)}${foot}`;
  }

  // ── GROUP (everyday): feed with the race card embedded once it has meaning ──
  const byDay = upcomingByDay(upcoming);
  const started = S().meta?.started !== false && (S().thirdPlaceRace || []).some((t) => t.Pts > 0);
  const firstDay = byDay.slice(0, 1).map(daySec).join("");
  const restDays = byDay.slice(1).map(daySec).join("");
  return `${toggle}${head}${firstDay}${started ? compactRaceCard() : ""}${restDays}${foot}`;
}

function upcomingByDay(upcoming) {
  return Object.entries(upcoming.reduce((acc, m) => {
    const d = fmtDay(m.kickoff); (acc[d] = acc[d] || []).push(m); return acc;
  }, {}));
}
function daySec([day, list]) {
  const showStakes = phase() === "group" || phase() === "groupFinal";
  return `<div class="day-label">${day}</div><div class="section">${list.map((m) => matchRow(m, { showStakes })).join("")}</div>`;
}

// ── More ──
export function renderMore() {
  const html = `
    <div class="block">
      <div class="lrow clickable" data-nav="bracket"><span class="nm">🏆 Bracket</span><span class="chev">›</span></div>
      <div class="lrow clickable" data-nav="stats"><span class="nm">📈 Stats — scorers, assists, discipline</span><span class="chev">›</span></div>
    </div>
    ${notificationsCardHTML()}
    <div class="sec-head"><h2>About</h2></div>
    <div class="block">
      <div class="lrow"><span class="nm muted" style="font-weight:500">2026 World Cup tracker. Live scores plus the live third-place race — all in one place. No xG, by design.</span></div>
    </div>
    <div class="updated">Snapshot ${fmtDay(S().meta?.updated)} ${fmtTime(S().meta?.updated)} · source: ${S().meta?.dataSource}</div>`;
  return { html, mount: (root) => { mountNotifications(root).catch(() => {}); } };
}

// ── News (BBC Sport World Cup headlines; tap opens the article) ──
export function renderNews() {
  // Most-recent first. Items without a parseable date sort to the bottom.
  const news = (S().news || []).slice().sort((a, b) => (Date.parse(b.published) || 0) - (Date.parse(a.published) || 0));
  if (!news.length) return emptyState("📰", "No headlines yet", "World Cup news from BBC Sport will appear here.");
  const cards = news.map((n) => `<a class="newscard" href="${n.link}" target="_blank" rel="noopener noreferrer">
      ${n.image ? `<span class="newsimg" style="background-image:url('${n.image}')"></span>` : ""}
      <span class="newstxt">
        <span class="newstitle">${n.title}</span>
        ${n.summary ? `<span class="newssum">${n.summary}</span>` : ""}
        <span class="newsmeta">${n.source || "News"} · ${timeAgo(n.published)}</span>
      </span></a>`).join("");
  return `<div class="newslist">${cards}</div><div class="updated">Headlines from BBC Sport — tap to read the full story.</div>`;
}

// ── Groups ──
function groupTableHTML(letter, highlight = []) {
  const rows = (S().groups[letter] || []).map((r, i) => {
    const pos = i + 1;
    const cls = (pos <= 2 ? `q${pos}` : "") + (highlight.includes(r.code) ? " hl" : "");
    const bar = pos <= 2 ? "var(--through)" : (pos === 3 ? "var(--sweating)" : "transparent");
    return `<tr class="${cls}" data-nav="team/${r.code}">
      <td class="tl team"><span class="qbar" style="background:${bar}"></span>${flag(r.code)} ${r.code}</td>
      <td>${r.P}</td><td>${r.W}</td><td>${r.D}</td><td>${r.L}</td>
      <td>${gd(r.GD)}</td><td class="pts">${r.Pts}</td></tr>`;
  }).join("");
  return `<table class="gtable">
    <thead><tr><th class="tl">Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GD</th><th>Pts</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

// Groups screen with two sub-tabs: the 12 tables, and the third-place Race (both are
// group-stage concerns). The Race route deep-links straight to the Race sub-tab.
export function renderGroups(ctx = {}) {
  const tab = ctx.forceTab || ctx.query?.get("t") || "tables";
  // Phase-driven flash (§12): dormant in `group`, LIVE in `groupFinal`, hands off to
  // the Bracket in `knockout`. Indigo stays chrome; the live race uses amber jeopardy.
  const ph = phase();
  const live = ph === "groupFinal";
  const handoff = ph === "knockout";
  const raceCls = (tab === "race" ? "active " : "") + (live || handoff ? "flash" : "");
  const raceLabel = (live ? '<span class="livedot"></span>' : "") + "Race for R32" + (live ? ' <span class="livebadge">LIVE</span>' : "");
  const tabBar = `<div class="tabs">
    <button data-nav="groups?t=tables" data-replace class="${tab === "tables" ? "active" : ""}">Tables</button>
    <button data-nav="groups?t=race" data-replace class="${raceCls}">${raceLabel}</button></div>`;
  const moving = S().meta?.spotsMoving ?? 0;
  const flashbar = live
    ? `<div class="flashbar"><span class="livedot"></span>The cut line is live — ${moving} spot${moving === 1 ? "" : "s"} still moving.</div>` : "";
  const handoffBar = handoff
    ? `<div class="flashbar clickable" data-nav="bracket"><span class="livedot"></span>The third-place race is settled — follow it into the bracket ›</div>` : "";

  if (tab === "race") return { title: "Groups", html: tabBar + flashbar + handoffBar + raceContent() };
  const tables = Object.keys(S().groups).map((letter) =>
    `<div class="sec-head"><h2>Group ${letter}</h2></div><div class="block">${groupTableHTML(letter)}</div>`).join("");
  return { title: "Groups", html: tabBar + flashbar + handoffBar + `<div class="banner">● top two through · ● 3rd in the race · ● out</div>${tables}` };
}
function raceStatus(code) {
  const t = (S().thirdPlaceRace || []).find((x) => x.code === code);
  return t ? t.status : null;
}

// ── Stats ──
export function renderStats(ctx) {
  const tab = ctx.query.get("t") || "scorers";
  const tabBar = `<div class="tabs">
    ${["scorers", "assists", "discipline"].map((t) =>
      `<button data-nav="stats?t=${t}" data-replace class="${t === tab ? "active" : ""}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}</div>`;
  let list = "";
  if (tab === "scorers") {
    list = (S().scorers || []).map((p, i) => `<div class="lrow clickable" data-nav="player/${p.playerId}">
      <span class="pos faint" style="width:18px;text-align:center;font-weight:700">${i + 1}</span>${flag(p.code)}
      <span class="nm">${p.name}<div class="sub">${p.team}${p.a ? ` · ${p.a} assists` : ""}</div></span>
      <span class="val">${p.g}</span></div>`).join("");
  } else if (tab === "assists") {
    list = (S().assists || []).map((p, i) => `<div class="lrow clickable" data-nav="player/${p.playerId}">
      <span class="pos faint" style="width:18px;text-align:center;font-weight:700">${i + 1}</span>${flag(p.code)}
      <span class="nm">${p.name}<div class="sub">${p.team}</div></span><span class="val">${p.a}</span></div>`).join("");
  } else {
    list = (S().discipline || []).map((d) => `<div class="lrow" data-nav="team/${d.code}">${flag(d.code)}
      <span class="nm">${d.team}</span>
      <span class="sub" style="color:var(--sweating)">▮ ${d.y}</span>
      <span class="sub" style="color:var(--out)">▮ ${d.r}</span></div>`).join("");
  }
  return { title: "Stats", html: tabBar + `<div class="section">${list}</div>` };
}

// ── Watch (club tracker) ──
export function renderWatch() {
  const cw = S().clubWatch || {};
  const total = Object.values(cw).reduce((s, c) => s + c.players.length, 0);
  const squadsLoaded = (S().meta?.squadCount ?? 0) > 0;
  // If no nation squads are loaded yet, it's a pre-tournament data state, not "no players".
  const banner = (!total && !squadsLoaded)
    ? `<div class="banner">📋 World Cup squads are confirmed just before kickoff. Your clubs' players will appear here automatically once nations submit their 26-man lists.</div>`
    : "";
  const cards = Object.entries(cw).map(([id, club]) => {
    const n = club.players.length;
    return `<button class="clubbtn" data-nav="club/${id}">
      <span class="badge ${n ? "" : "zero"}">${n}</span>
      <span class="crest">${club.name.split(" ").map((w) => w[0]).slice(0, 2).join("")}</span>
      <span class="name">${club.name}</span>
      <span class="sub">${n ? `${n} at the World Cup` : (squadsLoaded ? "None at this World Cup" : "Squad pending")}</span>
    </button>`;
  }).join("");
  return `${banner}<div class="sec-head"><h2>Your clubs</h2></div><div class="clubgrid">${cards}</div>
    <div class="updated">Players who made a 2026 squad, across every nation.</div>`;
}

export function renderClub(ctx) {
  const club = S().clubWatch?.[ctx.arg];
  if (!club) return { title: "Club", html: emptyState("Club not found", "Pick a club from Watch.") };
  if (!club.players.length) {
    const squadsLoaded = (S().meta?.squadCount ?? 0) > 0;
    return { title: club.name, html: squadsLoaded
      ? emptyState("⚽", `No ${club.name} players at this World Cup`, "None of their players made a 2026 squad.")
      : emptyState("📋", "Squads not confirmed yet", `${club.name}'s World Cup players will appear once nations submit their squads, just before kickoff.`) };
  }
  const na = club.nextAction;
  const naName = na ? (player(na.playerId)?.name || "") : "";
  const next = na ? `<div class="nextaction"><span class="clock">⏱</span>
    <span class="txt"><div class="t0">First ${club.name} player in action</div>
      <div class="t1">${naName ? naName + " — " : ""}${teamName(na.nation)} vs ${teamName(na.opponent)}</div>
      <div class="t2">${fmtDay(na.kickoff)} · ${fmtTime(na.kickoff)}</div></span>
    <span class="cd">${countdown(na.kickoff)}</span></div>` : "";

  const rows = club.players.map((p) => {
    const elim = p.nationVerdict === "eliminated";   // only grey out the genuinely eliminated
    const nf = p.nextFixture ? `Next: ${teamName(p.nation)} vs ${teamName(p.nextFixture.opponent)} · ${countdown(p.nextFixture.kickoff)}` : "Awaiting fixtures";
    const pl = player(p.playerId);
    return `<div class="watchp ${elim ? "elim" : ""} clickable" data-nav="player/${p.playerId}">
      ${flag(p.nation)}
      <div><div class="nm">${pl?.name || p.playerId}</div>
        <div class="meta">${teamName(p.nation)} · ${p.pos}${p.num ? ` · #${p.num}` : ""}</div>
        <div class="stat">${p.tournament.apps} apps · ${p.tournament.g}G ${p.tournament.a}A · ${nf}</div></div>
      ${statusChip(p.nationVerdict)}</div>`;
  }).join("");
  return { title: club.name, html: next + `<div class="sec-head"><h2>Contingent</h2></div><div class="section">${rows}</div>` };
}

// ── Match centre ──
export function renderMatch(ctx) {
  const m = (S().matches || []).find((x) => x.id === ctx.arg);
  if (!m) return { title: "Match", html: emptyState("Match not found") };
  const tab = ctx.query.get("t") || "facts";
  const live = m.status === "live" || m.status === "ht";
  const statusTxt = live ? (m.minute || "LIVE") : m.status === "ft" ? "Full time" : `${fmtDay(m.kickoff)} · ${fmtTime(m.kickoff)}`;
  const groupStarted = m.group && (S().groups[m.group] || []).some((r) => r.P > 0);
  const pos = (code) => {   // current group position, once games are played (not a FIFA ranking)
    if (!groupStarted) return "";
    const i = (S().groups[m.group] || []).findIndex((r) => r.code === code);
    return i >= 0 ? ["1st", "2nd", "3rd", "4th"][i] : "";
  };
  const ctxLabel = m.group ? `Group ${m.group}` : (m.stage && m.stage !== "Group Stage" ? m.stage : "");
  const hero = `<div class="scorehero">
    <div class="teams">
      <div class="t" data-nav="team/${m.home.code}">${flag(m.home.code, "flag")}<span class="nm">${teamName(m.home.code)}</span><span class="rk">${pos(m.home.code)}</span></div>
      <div><div class="sc">${m.home.score ?? "–"} : ${m.away.score ?? "–"}</div></div>
      <div class="t" data-nav="team/${m.away.code}">${flag(m.away.code, "flag")}<span class="nm">${teamName(m.away.code)}</span><span class="rk">${pos(m.away.code)}</span></div>
    </div>
    <div class="status ${live ? "" : "done"}">${statusTxt}${ctxLabel ? ` · ${ctxLabel}` : ""}${m.venue ? ` · ${m.venue}` : ""}</div>
  </div>`;
  const oneLiner = m.progressionLine
    ? `<div class="oneliner"><span class="tick"></span><p>${m.progressionLine}</p></div>` : "";

  const hasCommentary = (m.commentary && m.commentary.length) || live;
  const tabs = [];
  if (hasCommentary) tabs.push("live");
  tabs.push("facts", "lineup", "stats");
  if (m.group) tabs.push("group");
  const defaultTab = hasCommentary && m.commentary?.length ? "live" : "facts";
  const cur = ctx.query.get("t") || defaultTab;
  const label = { live: "Live", facts: "Facts", lineup: "Lineup", stats: "Stats", group: "Group" };
  const tabBar = `<div class="tabs">${tabs.map((t) =>
    `<button data-nav="match/${m.id}?t=${t}" data-replace class="${t === cur ? "active" : ""}">${label[t]}</button>`).join("")}</div>`;

  let body = "";
  if (cur === "live") body = matchCommentary(m);
  else if (cur === "facts") body = matchFacts(m);
  else if (cur === "lineup") body = matchLineup(m);
  else if (cur === "group" && m.group) body = `<div class="sec-head"><h2>Group ${m.group}</h2></div><div class="block">${groupTableHTML(m.group, [m.home.code, m.away.code])}</div>`;
  else body = matchStats(m);

  return { title: "Match", html: hero + oneLiner + tabBar + body };
}

// Live minute-by-minute commentary (The Guardian). Newest first; key moments flagged.
function matchCommentary(m) {
  // Newest first (defensive — the Worker already sorts, but guarantee it in the view).
  const blocks = (m.commentary || []).slice().sort((a, b) => (b.at || "").localeCompare(a.at || ""));
  if (!blocks.length) return emptyState("🎙️", "No commentary yet", "Minute-by-minute updates appear here once the match is under way.");
  const rows = blocks.map((b) => `<div class="cmt ${b.key ? "key" : ""}">
      <div class="cmt-head">${b.at ? `<span class="cmt-time">${fmtTime(b.at)}</span>` : ""}${b.title ? `<span class="cmt-title">${b.title}</span>` : ""}</div>
      <p>${b.text}</p></div>`).join("");
  const credit = m.commentaryUrl
    ? `<div class="updated">Live commentary via <a href="${m.commentaryUrl}" target="_blank" rel="noopener noreferrer" style="color:var(--brand);font-weight:700">The Guardian</a></div>`
    : `<div class="updated">Live commentary via ${m.commentarySource || "The Guardian"}</div>`;
  return `<div class="section cmts">${rows}</div>${credit}`;
}

function matchFacts(m) {
  if (!m.events?.length) return emptyState("📋", "No key events yet");
  const rows = m.events.map((e) => {
    const ico = { goal: "⚽", owngoal: "⚽", penalty: "⚽", yellow: "🟨", red: "🟥", subst: "🔁" }[e.type] || "•";
    const txt = e.type === "subst" ? `${e.player} <span class="faint">↑ ${e.detail || ""}</span>`
      : `${e.player}${e.assist ? ` <span class="faint">(${e.assist})</span>` : ""}`;
    const align = e.side === "h" ? "" : "flex-direction:row-reverse;text-align:right";
    return `<div class="lrow" style="${align}"><span style="width:34px;text-align:center">${ico}</span>
      <span class="nm">${txt}</span><span class="sub">${e.min}</span></div>`;
  }).join("");
  return `<div class="section">${rows}</div>`;
}

function matchStats(m) {
  if (!m.stats?.length) return emptyState("📊", "Stats appear once the match is under way");
  const ch = colour(m.home.code).primary, ca = colour(m.away.code).primary;
  const rows = m.stats.map((s) => {
    const h = s.h ?? 0, a = s.a ?? 0, tot = h + a || 1;
    const hp = (h / tot) * 100;
    const unit = s.unit || "";
    return `<div class="statline"><div class="lbl"><span>${h}${unit}</span><span class="k">${s.k}</span><span>${a}${unit}</span></div>
      <div class="statbar"><span class="h" style="width:${hp}%;background:${ch}"></span><span class="a" style="width:${100 - hp}%;background:${ca}"></span></div></div>`;
  }).join("");
  return `<div class="section">${rows}</div><div class="updated">Shot-quality stats carry the story — no xG, by design.</div>`;
}

function matchLineup(m) {
  const ft = m.status === "ft";
  if (!m.lineups?.h?.xi?.length) {
    return emptyState("👥", "Lineups confirmed ~1 hr before kickoff", ft ? "" : "Check back closer to the match.");
  }
  const renderSide = (L, code) => {
    if (!L?.xi?.length) return "";
    // group XI into formation rows by the leading grid number
    const rows = {};
    L.xi.forEach((p) => { const r = (p.grid || "1:1").split(":")[0]; (rows[r] = rows[r] || []).push(p); });
    const pitch = Object.keys(rows).sort().map((r) => `<div class="formrow">${rows[r].map((p) =>
      `<div class="player-dot" ${p.playerId ? `data-nav="player/${p.playerId}"` : ""}>
        <span class="circ">${p.num}${p.rating != null ? `<span class="rt">${p.rating.toFixed(1)}</span>` : ""}</span>
        <span class="nm">${p.name.split(" ").slice(-1)[0]}</span></div>`).join("")}</div>`).join("");
    const subs = (L.subs || []).map((p) => `<span class="sub" data-nav="${p.playerId ? `player/${p.playerId}` : ""}">${p.num} ${p.name}${p.rating != null ? ` (${p.rating.toFixed(1)})` : ""}</span>`).join(" · ");
    return `<div class="formhead"><span class="f">${L.formation}</span><span class="c">${L.coach || ""}</span></div>
      <div class="pitch" style="background:linear-gradient(${colour(code).primary}22, #1b6b3c)">${pitch}</div>
      ${subs ? `<div class="lrow"><span class="sub" style="font-weight:600">Subs: ${subs}</span></div>` : ""}`;
  };
  return renderSide(m.lineups.h, m.home.code) + (m.lineups.a?.xi?.length ? renderSide(m.lineups.a, m.away.code) : "");
}

// ── Team page ──
export function renderTeam(ctx) {
  const code = ctx.arg;
  const t = S().teams?.[code];
  if (!t) return { title: code, html: emptyState("Team not found") };
  const c = colour(code);
  const outlook = qualifyOutlook(S(), code, state.annexC);
  const v = outlook.status;
  const tab = ctx.query.get("t") || "overview";

  const hero = `<div class="hero" style="background:linear-gradient(135deg, ${c.primary}, ${c.secondary})">
    <div class="top">${flag(code, "crest")}<div><h1>${t.name}</h1><div class="meta">Group ${t.group}${t.coach && t.coach !== "—" ? ` · ${t.coach}` : ""}</div></div></div>
    <div style="margin-top:10px">${statusChip(v)}</div>
    <div class="hero-outlook">${outlook.line}</div>
    <div class="agg">
      <div><div class="v">${t.W}-${t.D}-${t.L}</div><div class="k">W-D-L</div></div>
      <div><div class="v">${t.GF}:${t.GA}</div><div class="k">For:Ag</div></div>
      <div><div class="v">${t.possession ?? "–"}%</div><div class="k">Poss</div></div>
      <div><div class="v">${t.cleanSheets ?? 0}</div><div class="k">Clean sh.</div></div>
    </div></div>`;

  const tabBar = `<div class="tabs">${["overview", "group", "matches", "squad"].map((tb) =>
    `<button data-nav="team/${code}?t=${tb}" data-replace class="${tb === tab ? "active" : ""}">${tb[0].toUpperCase() + tb.slice(1)}</button>`).join("")}</div>`;

  let body = "";
  if (tab === "overview") {
    const ms = (S().matches || []).filter((m) => m.home.code === code || m.away.code === code)
      .sort((a, b) => (a.kickoff || "").localeCompare(b.kickoff || ""));
    body = `<div class="sec-head"><h2>Group ${t.group}</h2></div><div class="block">${groupTableHTML(t.group, [code])}</div>`
      + (ms.length ? `<div class="sec-head"><h2>Fixtures</h2></div><div class="section">${ms.map(matchRow).join("")}</div>` : "");
  } else if (tab === "group") {
    body = `<div class="sec-head"><h2>Group ${t.group}</h2></div><div class="block">${groupTableHTML(t.group, [code])}</div>
      <div class="updated">Top two qualify directly · 3rd may reach the R32 via the best-thirds places.</div>`;
  } else if (tab === "matches") {
    const ms = (S().matches || []).filter((m) => m.home.code === code || m.away.code === code);
    body = ms.length ? `<div class="section">${ms.map(matchRow).join("")}</div>` : emptyState("No matches");
  } else {
    const sq = (t.squad || []);
    body = sq.length
      ? `<div class="section">${sq.map((id) => { const p = player(id); return p ? `<div class="lrow clickable" data-nav="player/${id}"><span class="nm">${p.name}</span><span class="sub">${p.pos}</span></div>` : ""; }).join("")}</div>`
      : emptyState("👥", "Squad list not loaded", "Rosters finalise just before the tournament.");
  }
  return { title: t.name, html: hero + tabBar + body };
}

// ── Player page ──
export function renderPlayer(ctx) {
  const p = player(ctx.arg);
  if (!p) return { title: "Player", html: emptyState("Player not found") };
  const c = colour(p.code);
  const tour = p.tournament || {};
  const stat = (v, k) => `<div><div class="v">${v}</div><div class="k">${k}</div></div>`;
  const hero = `<div class="hero" style="background:linear-gradient(135deg, ${c.primary}, ${c.secondary})">
    <div class="top">${flag(p.code, "crest")}<div><h1>${p.name}</h1>
      <div class="meta">${p.pos}${p.num ? ` · #${p.num}` : ""}${p.age ? ` · ${p.age}` : ""}${p.club ? ` · ${p.club}` : ""}</div></div></div></div>`;

  const tournament = `<div class="sec-head"><h2>This tournament</h2></div>
    <div class="hero" style="background:#15161B"><div class="agg" style="flex-wrap:wrap;gap:18px 24px">
      ${stat(tour.apps ?? 0, "Apps")}${stat(tour.min ?? 0, "Mins")}${stat(tour.g ?? 0, "Goals")}
      ${stat(tour.a ?? 0, "Assists")}${stat(tour.shots ?? "–", "Shots")}${stat(tour.keyPasses ?? "–", "Key passes")}
      ${stat(tour.yellow ?? 0, "Yellow")}${stat(tour.red ?? 0, "Red")}${tour.rating != null ? stat(tour.rating, "Rating") : ""}
    </div></div>`;

  const season = (p.season || []).length ? `<div class="sec-head"><h2>Club &amp; season</h2></div><div class="block">
    ${p.season.map((s) => `<div class="lrow"><span class="nm">${s.comp}</span>
      <span class="sub">${s.apps} apps · ${s.g}G ${s.a}A · ${s.yellow}🟨${s.red ? ` ${s.red}🟥` : ""}${s.rating ? ` · ${s.rating}` : ""}</span></div>`).join("")}
    </div>` : (p._enriched
      ? `<div class="banner">No club-season data for ${p.name || "this player"} — their domestic league isn't covered by the data feed.</div>`
      : `<div class="banner">Loading club &amp; season stats…</div>`);

  const career = (p.career || []).length ? `<div class="sec-head"><h2>Career</h2></div><div class="block">
    ${p.career.map((t) => `<div class="lrow"><span class="nm">${t.from} → ${t.to}</span><span class="sub">${t.year}</span></div>`).join("")}</div>` : "";
  const honours = (p.honours || []).length ? `<div class="sec-head"><h2>Honours</h2></div><div class="block">
    ${p.honours.map((h) => `<div class="lrow"><span class="nm">🏆 ${h.title}</span><span class="sub">${h.year}</span></div>`).join("")}</div>` : "";

  return { title: p.name, html: hero + tournament + season + career + honours + `<div class="updated">No xG — counting stats only, by design.</div>` };
}

function emptyState(big, t, sub = "") {
  if (!t) { t = big; big = "🤔"; }
  return `<div class="empty"><div class="big">${big}</div><div class="t">${t}</div>${sub ? `<div>${sub}</div>` : ""}</div>`;
}
