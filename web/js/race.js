// Race tab — the progression USP (brief §5, §7), read-only. The full third-place
// table with the cut line, the plain-English "what does my team need?" generator,
// and the Annex C → R32 hand-off. The engine runs client-side on the snapshot.
//
// (The interactive scenario board was removed — the live cut line + plain-English
// already tell the story without the what-if complexity.)

import { state, teamName, flag, statusChip, gd } from "./data.js";
import { resolve, verdicts, plainEnglish, QUALIFY_COUNT } from "./engine.js";

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

export function renderRace() {
  const out = resolve(S(), [], state.annexC);
  const byStatus = Object.fromEntries(verdicts(S()).map((t) => [t.code, t.status]));
  const table = out.thirdPlaceTable;

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
  const cutCard = `<div class="racecard"><div class="head"><h3>Race for the last 8</h3>
      <span class="go" style="color:var(--muted)">best 8 of 12 advance</span></div>
      <div class="cutlist">${rows}</div></div>
      <div class="updated">The 12 group third-placed teams, ranked. The dashed line is the cut.</div>`;

  // plain-English: teams on the bubble first, else the teams nearest the line
  const focus = table.filter((t) => byStatus[t.code] === "sweating").slice(0, 6);
  const peList = (focus.length ? focus : table.slice(5, 9)).map((t) => `
    <div class="pe"><div class="who clickable" data-nav="team/${t.code}">${flag(t.code)}<span class="nm">${teamName(t.code)}</span>${statusChip(byStatus[t.code] || "in")}</div>
      <p>${plainEnglish(S(), t.code, state.annexC)}</p></div>`).join("");
  const peCard = `<div class="sec-head"><h2>What does my team need?</h2></div><div class="block">${peList}</div>`;

  return { title: "Race", html: cutCard + peCard + annexCHandoff(out) };
}
