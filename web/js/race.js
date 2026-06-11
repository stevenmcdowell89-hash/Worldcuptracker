// Race tab — the progression USP (brief §5, §7), read-only. The full third-place
// table with the cut line, the plain-English "what does my team need?" generator,
// and the Annex C → R32 hand-off. The engine runs client-side on the snapshot.
//
// (The interactive scenario board was removed — the live cut line + plain-English
// already tell the story without the what-if complexity.)

import { state, teamName, flag, statusChip, gd } from "./data.js";
import { resolve, verdicts, qualifyOutlook, QUALIFY_COUNT } from "./engine.js";

const S = () => state.snap;

function cutLine() {
  return `<div class="cutline"><span class="lbl">qualify</span><span class="ln"></span><span class="lbl">eliminated</span></div>`;
}

function annexCHandoff(out) {
  const done = S().meta?.groupStageComplete;
  const qualifiedGroups = out.thirdPlaceTable.slice(0, QUALIFY_COUNT).map((t) => t.group);
  const slots = out.annexCSlots || {};
  if (!Object.keys(slots).length) {
    return `<div class="sec-head"><h2>Round of 32 slots</h2></div><div class="banner">🔒 The eight third-place slots lock once the final group games are played.</div>`;
  }
  const rows = qualifiedGroups.map((g) => {
    const slot = slots[g];
    const code = out.thirdPlaceTable.find((t) => t.group === g)?.code;
    const wg = state.annexC?.slotWinner?.[slot];               // host group winner of that slot
    const oppCode = wg ? S().groups[wg]?.[0]?.code : null;     // current leader ("as it stands")
    const opp = wg ? `Winner Group ${wg}${oppCode ? ` · ${teamName(oppCode)}` : ""}` : slot;
    return `<div class="lrow clickable" data-nav="team/${code}">${flag(code)}<span class="nm">${teamName(code)} <span class="grp faint">3rd ${g}</span></span>
      <span class="sub">→ Match ${slot} · vs ${opp}</span></div>`;
  }).join("");
  const head = done ? "Round of 32 slots" : "Round of 32 slots (projected)";
  return `<div class="sec-head"><h2>${head}</h2></div><div class="block">${rows}</div>`;
}

// Full Race tab (kept for deep-links). The content also embeds as a sub-tab of Groups.
export function renderRace() { return { title: "Race", html: raceContent() }; }

export function raceContent() {
  // "Started" must flip at the first WHISTLE, not the first final whistle: points stay
  // 0 until a game finishes, so gate on the worker's meta.started (true once any match
  // is live/ht/ft). The points check remains as a fallback for snapshots without meta.
  const started = S().meta?.started === true || S().thirdPlaceRace?.some((t) => t.Pts > 0);
  const out = resolve(S(), [], state.annexC);
  const byStatus = Object.fromEntries(verdicts(S()).map((t) => [t.code, t.status]));
  const table = out.thirdPlaceTable;

  const preBanner = !started
    ? `<div class="banner">⚽ The group stage hasn't kicked off yet — all 12 third-placed spots are wide open. This race updates live once games begin.</div>` : "";

  // full 12-team third-place table with the dashed cut line after 8th (clickable rows)
  const rows = table.map((t) => {
    const below = t.rank > QUALIFY_COUNT;
    const line = t.rank === QUALIFY_COUNT ? cutLine() : "";
    return `<div class="cutrow ${below ? "below" : ""} clickable" data-nav="team/${t.code}">
        <span class="pos">${t.rank}</span>${flag(t.code)}
        <span class="nm">${teamName(t.code)} <span class="grp">${t.group}</span></span>
        <span class="pts">${t.Pts}</span><span class="gd">${gd(t.GD)}</span>
      </div>${line}`;
  }).join("");
  const cutCard = `<div class="sec-head"><h2>Third-place race</h2><span class="faint" style="font-size:12px;font-weight:600">8 of 12 reach the R32</span></div>
      <div class="racecard"><div class="head"><h3>The 12 third-placed teams</h3>
      <span class="go" style="color:var(--muted)">best 8 go through</span></div>
      <div class="cutlist">${rows}</div></div>
      <div class="updated">${started ? "Ranked by points, then goal difference, goals scored, fair play. The dashed line is the cut." : "Provisional order — no games played yet."}</div>`;

  // "What does my team need?" — full qualification outlook (top-2 OR third place),
  // worded honestly. Shown for the teams whose place is genuinely undecided.
  const all = [];
  for (const g of Object.keys(S().groups)) for (const r of S().groups[g]) {
    const o = qualifyOutlook(S(), r.code, state.annexC);
    if (o.status === "sweating" || o.status === "in" || o.status === "out") all.push({ code: r.code, ...o });
  }
  const peList = (all.length ? all.slice(0, 10) : table.slice(5, 9).map((t) => ({ code: t.code, ...qualifyOutlook(S(), t.code, state.annexC) })))
    .map((o) => `<div class="pe"><div class="who clickable" data-nav="team/${o.code}">${flag(o.code)}<span class="nm">${teamName(o.code)}</span>${started ? statusChip(o.status) : ""}</div>
      <p>${o.line}</p></div>`).join("");
  const peCard = `<div class="sec-head"><h2>What does my team need?</h2></div><div class="block">${peList}</div>`;

  return preBanner + cutCard + peCard + annexCHandoff(out);
}
