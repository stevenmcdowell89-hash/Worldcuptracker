// Screen renderers. Each returns an HTML string (or { html, title, mount }).
// Progression intelligence is woven in: the "affects the race" marker on match
// rows, the one-liner on match pages, the verdict chip on team pages (brief §7).

import { state, colour, teamName, player, flag, statusChip, fmtTime, fmtDay, countdown, gd } from "./data.js";

const S = () => state.snap;

// ── shared bits ──
function compactRaceCard() {
  const race = S().thirdPlaceRace || [];
  const window = race.slice(5, 9); // ranks 6–9, straddling the cut at 8 (compact)
  const rows = window.map((t) => {
    const below = t.rank > 8;
    return `<div class="cutrow ${below ? "below" : ""} clickable" data-nav="team/${t.code}">
      <span class="pos">${t.rank}</span>${flag(t.code)}
      <span class="nm">${teamName(t.code)} <span class="grp">${t.group}</span></span>
      <span class="pts">${t.Pts}</span><span class="gd">${gd(t.GD)}</span>
    </div>${t.rank === 8 ? cutLineHTML() : ""}`;
  }).join("");
  return `<div class="racecard">
    <div class="head"><h3>Race for the last 8</h3><span class="go" data-nav="race">Full table ›</span></div>
    <div class="cutlist">${rows}</div>
  </div>`;
}
function cutLineHTML() {
  return `<div class="cutline"><span class="lbl">cut</span><span class="ln"></span><span class="lbl">8th</span></div>`;
}

function matchRow(m) {
  const live = m.status === "live" || m.status === "ht";
  const ft = m.status === "ft";
  let mid;
  if (live) mid = `<span class="score">${m.home.score}–${m.away.score}</span><span class="min">${m.minute || "LIVE"}</span>`;
  else if (ft) mid = `<span class="score">${m.home.score}–${m.away.score}</span><span class="ko">FT</span>`;
  else mid = `<span class="ko">${fmtTime(m.kickoff)}</span>`;
  const stageLabel = m.group ? `Group ${m.group}` : (m.stage && m.stage !== "Group Stage" ? m.stage : "");
  const meta = `<div class="match-meta">
      ${stageLabel ? `<span class="grp-pill">${stageLabel}</span>` : ""}
      ${m.affectsCut ? `<span class="race-tag">● could shape the last-8 race</span>` : ""}
    </div>`;
  return `<div class="match-card">
    <div class="match clickable" data-nav="match/${m.id}">
      <span class="side home"><span class="nm">${teamName(m.home.code)}</span>${flag(m.home.code)}</span>
      <span class="mid">${mid}</span>
      <span class="side away">${flag(m.away.code)}<span class="nm">${teamName(m.away.code)}</span></span>
    </div>${meta}</div>`;
}

// ── Matches (home spine) ──
export function renderMatches() {
  const matches = S().matches || [];
  const live = matches.filter((m) => m.status === "live" || m.status === "ht");
  const upcoming = matches.filter((m) => m.status === "scheduled").sort((a, b) => (a.kickoff || "").localeCompare(b.kickoff || ""));
  const finished = matches.filter((m) => m.status === "ft").sort((a, b) => (b.kickoff || "").localeCompare(a.kickoff || ""));

  const stale = S().meta?.stale ? `<div class="banner">⚠️ Showing the last good update — live data is briefly unavailable.</div>` : "";
  const sec = (label, list) => list.length
    ? `<div class="day-label">${label}</div><div class="section">${list.map(matchRow).join("")}</div>` : "";

  // upcoming grouped by day so the long pre-tournament list stays navigable
  const byDay = Object.entries(upcoming.reduce((acc, m) => {
    const d = fmtDay(m.kickoff); (acc[d] = acc[d] || []).push(m); return acc;
  }, {}));
  const daySec = ([day, list]) => `<div class="day-label">${day}</div><div class="section">${list.map(matchRow).join("")}</div>`;
  // fixtures front and centre: the soonest day first, then the race hook, then the rest
  const firstDay = byDay.slice(0, 1).map(daySec).join("");
  const restDays = byDay.slice(1, 8).map(daySec).join("");

  return `
    ${stale}
    ${sec(live.length ? "● Live" : "", live)}
    ${finished.length ? sec("Latest results", finished.slice(0, 8)) : ""}
    ${firstDay}
    ${compactRaceCard()}
    ${restDays}
    <div class="updated">Updated ${fmtTime(S().meta?.updated)} · ${S().meta?.stage}</div>`;
}

// ── More ──
export function renderMore() {
  return `
    <div class="block">
      <div class="lrow clickable" data-nav="bracket"><span class="nm">🏆 Bracket</span><span class="chev">›</span></div>
      <div class="lrow clickable" data-nav="stats"><span class="nm">📈 Stats — scorers, assists, discipline</span><span class="chev">›</span></div>
    </div>
    <div class="sec-head"><h2>About</h2></div>
    <div class="block">
      <div class="lrow"><span class="nm muted" style="font-weight:500">2026 World Cup tracker. Live scores plus the live third-place race — all in one place. No xG, by design.</span></div>
    </div>
    <div class="updated">Snapshot ${fmtDay(S().meta?.updated)} ${fmtTime(S().meta?.updated)} · source: ${S().meta?.dataSource}</div>`;
}

// ── Groups ──
export function renderGroups() {
  const g = S().groups;
  const tables = Object.keys(g).map((letter) => {
    const rows = g[letter].map((r, i) => {
      const pos = i + 1;
      const statusDot = pos <= 2 ? "in" : (raceStatus(r.code) || "out");
      const cls = pos <= 2 ? `q${pos}` : "";
      return `<tr class="${cls}" data-nav="team/${r.code}">
        <td class="tl team"><span class="qbar" style="background:${pos<=2?'var(--through)':(pos===3?'var(--sweating)':'transparent')}"></span>${flag(r.code)} ${r.code}</td>
        <td>${r.P}</td><td>${r.W}</td><td>${r.D}</td><td>${r.L}</td>
        <td>${gd(r.GD)}</td><td class="pts">${r.Pts}</td></tr>`;
    }).join("");
    return `<div class="sec-head"><h2>Group ${letter}</h2></div>
      <div class="block"><table class="gtable">
        <thead><tr><th class="tl">Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GD</th><th>Pts</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`;
  }).join("");
  return `<div class="banner">● top two through · ● 3rd in the race · ● out</div>${tables}`;
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

// ── Bracket ──
const ROUND_DESC = {
  R32: "Round of 32 — group winners & runners-up + the 8 best third-placed teams",
  R16: "Round of 16", QF: "Quarter-finals", SF: "Semi-finals", Final: "Final",
};
export function renderBracket(ctx) {
  const b = S().bracket;
  const done = S().meta?.groupStageComplete;
  const tab = ctx.query.get("r") || "R32";
  const tabBar = `<div class="tabs">${b.rounds.map((r) =>
    `<button data-nav="bracket?r=${r}" data-replace class="${r === tab ? "active" : ""}">${r}</button>`).join("")}</div>`;
  const banner = !done
    ? `<div class="banner">🔒 Teams are placeholders until the group stage finishes. Third-place slots then resolve via FIFA's Annex C allocation.</div>` : "";

  const teamSide = (s) => {
    if (!s) return `<div class="bx-team ph"><span class="nm">TBD</span></div>`;
    if (s.code) return `<div class="bx-team clickable" data-nav="team/${s.code}">${flag(s.code)}
        <span class="nm">${teamName(s.code)}</span>${s.pos ? `<span class="bx-pos">${s.pos}</span>` : ""}
        <span class="sc">${s.score ?? ""}</span></div>`;
    const third = !!s.thirdPlaceSlot;
    return `<div class="bx-team ph ${third ? "third" : ""}">
        <span class="nm">${third ? "3rd place" : (s.label || "TBD")}</span>
        <span class="bx-pos">${third ? s.thirdPlaceSlot.join("/") : (s.pos || "")}</span></div>`;
  };
  const hasMatch = (id) => (S().matches || []).some((x) => x.id === id);
  const ms = b.matches.filter((m) => m.rd === tab);
  const list = ms.map((m) => `<div class="bx" ${hasMatch(m.id) ? `data-nav="match/${m.id}"` : ""}>
      <div class="bx-head"><span class="bx-no">Match ${m.id}</span></div>
      ${teamSide(m.a)}<div class="bx-v"><span>vs</span></div>${teamSide(m.b)}
    </div>`).join("");

  return { title: "Bracket", html: tabBar + banner +
    `<div class="bx-round">${ROUND_DESC[tab] || tab}</div><div class="bxwrap">${list}</div>` };
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
  const rank = (code) => S().teams?.[code]?.rank ? `#${S().teams[code].rank} FIFA` : "";
  const hero = `<div class="scorehero">
    <div class="teams">
      <div class="t" data-nav="team/${m.home.code}">${flag(m.home.code, "flag")}<span class="nm">${teamName(m.home.code)}</span><span class="rk">${rank(m.home.code)}</span></div>
      <div><div class="sc">${m.home.score ?? "–"} : ${m.away.score ?? "–"}</div></div>
      <div class="t" data-nav="team/${m.away.code}">${flag(m.away.code, "flag")}<span class="nm">${teamName(m.away.code)}</span><span class="rk">${rank(m.away.code)}</span></div>
    </div>
    <div class="status ${live ? "" : "done"}">${statusTxt}${m.venue ? ` · ${m.venue}` : ""}</div>
  </div>`;
  const oneLiner = m.progressionLine
    ? `<div class="oneliner"><span class="tick"></span><p>${m.progressionLine}</p></div>` : "";

  const tabBar = `<div class="tabs">${["facts", "lineup", "stats"].map((t) =>
    `<button data-nav="match/${m.id}?t=${t}" data-replace class="${t === tab ? "active" : ""}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}</div>`;

  let body = "";
  if (tab === "facts") body = matchFacts(m);
  else if (tab === "lineup") body = matchLineup(m);
  else body = matchStats(m);

  return { title: "Match", html: hero + oneLiner + tabBar + body };
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
  const v = t.verdict || raceStatus(code) || "in";
  const tab = ctx.query.get("t") || "overview";

  const hero = `<div class="hero" style="background:linear-gradient(135deg, ${c.primary}, ${c.secondary})">
    <div class="top">${flag(code, "crest")}<div><h1>${t.name}</h1><div class="meta">Group ${t.group}${t.coach && t.coach !== "—" ? ` · ${t.coach}` : ""}</div></div></div>
    <div style="margin-top:10px">${statusChip(v)}</div>
    <div class="agg">
      <div><div class="v">${t.W}-${t.D}-${t.L}</div><div class="k">W-D-L</div></div>
      <div><div class="v">${t.GF}:${t.GA}</div><div class="k">For:Ag</div></div>
      <div><div class="v">${t.possession ?? "–"}%</div><div class="k">Poss</div></div>
      <div><div class="v">${t.cleanSheets ?? 0}</div><div class="k">Clean sh.</div></div>
    </div></div>`;

  const tabBar = `<div class="tabs">${["overview", "matches", "squad"].map((tb) =>
    `<button data-nav="team/${code}?t=${tb}" data-replace class="${tb === tab ? "active" : ""}">${tb[0].toUpperCase() + tb.slice(1)}</button>`).join("")}</div>`;

  let body = "";
  if (tab === "overview") {
    const grp = S().groups[t.group].map((r, i) => `<tr class="${i < 2 ? "q1" : ""}" data-nav="team/${r.code}">
      <td class="tl team">${flag(r.code)} ${r.code}</td><td>${r.P}</td><td>${gd(r.GD)}</td><td class="pts">${r.Pts}</td></tr>`).join("");
    body = `<div class="sec-head"><h2>Group ${t.group}</h2></div><div class="block"><table class="gtable">
      <thead><tr><th class="tl">Team</th><th>P</th><th>GD</th><th>Pts</th></tr></thead><tbody>${grp}</tbody></table></div>`;
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
    </div>` : `<div class="banner">Club-season detail isn't covered for this league — showing tournament stats only.</div>`;

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
