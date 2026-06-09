// Race tab — THE USP (brief §5, §7). Verdicts + the live moving cut line, the
// interactive scenario board, the plain-English generator, and the Annex C → R32
// hand-off. The engine runs client-side on the snapshot; zero API calls.

import { state, teamName, flag, statusChip, gd, fmtTime } from "./data.js";
import { resolve, verdicts, plainEnglish, resultFromWDL, QUALIFY_COUNT } from "./engine.js";

const S = () => state.snap;
const DEF = { W: [1, 0], D: [1, 1], L: [0, 1] };

// ── share state (URL hash) ──
function encodeScenario() {
  return [...state.scenario.entries()]
    .map(([id, v]) => `${id}~${v.hg}-${v.ag}${v.exact ? "!" : ""}`).join(",");
}
function decodeScenario(str) {
  state.scenario.clear();
  if (!str) return;
  for (const part of str.split(",")) {
    const m = part.match(/^(.+?)~(\d+)-(\d+)(!)?$/);
    if (!m) continue;
    state.scenario.set(m[1], { hg: +m[2], ag: +m[3], exact: !!m[4] });
  }
}

function results() {
  const out = [];
  for (const [id, v] of state.scenario) {
    const fx = S().remainingFixtures.find((f) => f.id === id);
    if (!fx) continue;
    out.push({ id, home: fx.home, away: fx.away, hg: v.hg, ag: v.ag, exact: v.exact });
  }
  return out;
}
function outcomeOf(v) { return v.hg > v.ag ? "W" : v.hg < v.ag ? "L" : "D"; }

// The display reacts to the scenario (cut list + plain-English + Annex C). The
// board (inputs) is built separately so typing a scoreline never rebuilds inputs.
function buildDisplay() {
  const out = resolve(S(), results(), state.annexC);
  const baseVerdict = Object.fromEntries(verdicts(S()).map((t) => [t.code, t.status]));
  const table = out.thirdPlaceTable;

  // cut list with the dashed line after the 8th place — the signature element
  const rows = table.map((t) => {
    const below = t.rank > QUALIFY_COUNT;
    const line = t.rank === QUALIFY_COUNT ? cutLine() : "";
    return `<div class="cutrow ${below ? "below" : ""}" data-code="${t.code}">
        <span class="pos">${t.rank}</span>${flag(t.code)}
        <span class="nm">${teamName(t.code)} <span class="grp">${t.group}</span></span>
        <span class="pts">${t.Pts}</span><span class="gd">${gd(t.GD)}</span>
      </div>${line}`;
  }).join("");
  const cutCard = `<div class="racecard"><div class="head"><h3>Best 8 of 12 advance</h3>
      <span class="go" style="color:var(--muted)">3rd places</span></div>
      <div class="cutlist" id="cutlist">${rows}</div></div>`;

  const note = state.scenario.size
    ? `<div class="updated">Live what-if · ${[...state.scenario.values()].some((v) => v.exact) ? "some exact scorelines" : "W/D/L only (likely)"}</div>`
    : `<div class="updated">Set results in the board below and watch teams cross the cut line.</div>`;

  // plain-English: the teams on the bubble (sweating), or the top contenders
  const focus = table.filter((t) => baseVerdict[t.code] === "sweating").slice(0, 5);
  const peList = (focus.length ? focus : table.slice(6, 9)).map((t) => `
    <div class="pe"><div class="who">${flag(t.code)}<span class="nm">${teamName(t.code)}</span>${statusChip(baseVerdict[t.code] || "in")}</div>
      <p>${plainEnglish(S(), t.code, state.annexC)}</p></div>`).join("");
  const peCard = `<div class="sec-head"><h2>What does my team need?</h2></div><div class="block">${peList}</div>`;

  return cutCard + note + peCard + annexCHandoff(out);
}

function buildBoard() {
  const fixtures = S().remainingFixtures.filter((f) => f.affectsThird);
  const board = fixtures.map((f) => {
    const v = state.scenario.get(f.id);
    const sel = v ? outcomeOf(v) : null;
    const pill = (o) => `<button class="${sel === o ? "on" : ""}" data-wdl="${f.id}:${o}">${o}</button>`;
    const exact = v?.exact ? `<span class="exact">exact</span>` : "";
    return `<div class="fx" data-fx="${f.id}">
        <div><span class="teams">${teamName(f.home)} v ${teamName(f.away)}</span><span class="grp">${f.group}</span> ${exact}</div>
        <span class="wdl">${pill("W")}${pill("D")}${pill("L")}</span>
      </div>
      <div class="scorebox">
        <input type="number" min="0" max="20" inputmode="numeric" data-score="${f.id}:h" value="${v ? v.hg : ""}" aria-label="${f.home} goals" />
        <span class="x">–</span>
        <input type="number" min="0" max="20" inputmode="numeric" data-score="${f.id}:a" value="${v ? v.ag : ""}" aria-label="${f.away} goals" />
        <span class="sub faint" style="margin-left:8px">set a scoreline for exact goal-difference</span>
      </div>`;
  }).join("");
  return `<div class="sec-head"><h2>Scenario board <span class="faint" style="font-weight:600;text-transform:none;letter-spacing:0">· ${state.scenario.size} set</span></h2></div>
    <div class="scn">${board}
      <div class="scn-actions"><button class="btn" data-act="reset">Reset</button><button class="btn primary" data-act="share">Share scenario</button></div>
    </div>`;
}

function cutLine() {
  return `<div class="cutline" id="theline"><span class="lbl">qualify</span><span class="ln"></span><span class="lbl">eliminated</span></div>`;
}

function annexCHandoff(out) {
  const done = S().meta?.groupStageComplete;
  const qualifiedGroups = out.thirdPlaceTable.slice(0, QUALIFY_COUNT).map((t) => t.group);
  const slots = out.annexCSlots || {};
  const placeholderWarn = state.annexC?.placeholder
    ? `<div class="banner">⚠️ Annex C slot mapping is a placeholder — replace with FIFA's official chart before relying on the R32 opponent.</div>` : "";
  if (!Object.keys(slots).length) {
    return `<div class="sec-head"><h2>Round of 32 slots</h2></div><div class="banner">🔒 Slots lock after the final group games. Set a full scenario to preview the third-place matchups.</div>`;
  }
  const rows = qualifiedGroups.map((g) => {
    const slot = slots[g];
    const code = out.thirdPlaceTable.find((t) => t.group === g)?.code;
    const wg = state.annexC?.slotWinner?.[slot];               // host group winner of that slot
    const oppCode = wg ? S().groups[wg]?.[0]?.code : null;     // current leader ("as it stands")
    const opp = wg ? `Winner Group ${wg}${oppCode ? ` · ${teamName(oppCode)}` : ""}` : slot;
    return `<div class="lrow">${flag(code)}<span class="nm">${teamName(code)} <span class="grp faint">3rd ${g}</span></span>
      <span class="sub">→ Match ${slot} · vs ${opp}</span></div>`;
  }).join("");
  const head = done ? "Round of 32 slots" : "Round of 32 slots (projected)";
  return `${placeholderWarn}<div class="sec-head"><h2>${head}</h2></div><div class="block">${rows}</div>`;
}

// ── render + mount (handlers + FLIP animation across the cut line) ──
export function renderRace(ctx) {
  decodeScenario(ctx.query.get("s"));
  return {
    title: "Race",
    html: `<div id="race-display">${buildDisplay()}</div><div id="race-board">${buildBoard()}</div>`,
    mount: (container) => {
      const display = container.querySelector("#race-display");
      const board = container.querySelector("#race-board");

      const syncUrl = () =>
        history.replaceState(null, "", `#/race${state.scenario.size ? `?s=${encodeScenario()}` : ""}`);

      // Rebuild the display with a FLIP animation so teams visibly slide across the
      // dashed cut line (the signature interaction).
      const updateDisplay = () => {
        const before = {};
        display.querySelectorAll(".cutrow").forEach((r) => (before[r.dataset.code] = r.getBoundingClientRect().top));
        display.innerHTML = buildDisplay();
        display.querySelectorAll(".cutrow").forEach((r) => {
          const delta = before[r.dataset.code] - r.getBoundingClientRect().top;
          if (delta) {
            r.style.transform = `translateY(${delta}px)`;
            r.classList.add("moved");
            requestAnimationFrame(() => { r.style.transform = ""; });
            setTimeout(() => r.classList.remove("moved"), 600);
          }
        });
        syncUrl();
      };

      // Update one fixture's pill highlight in place (keeps input focus while typing).
      const syncPills = (id) => {
        const v = state.scenario.get(id);
        const sel = v ? outcomeOf(v) : null;
        board.querySelectorAll(`[data-wdl^="${id}:"]`).forEach((b) =>
          b.classList.toggle("on", b.dataset.wdl.split(":")[1] === sel));
      };

      board.addEventListener("click", (e) => {
        const wdl = e.target.closest("[data-wdl]");
        if (wdl) {
          const [id, o] = wdl.dataset.wdl.split(":");
          const [hg, ag] = DEF[o];
          state.scenario.set(id, { hg, ag, exact: false });
          board.innerHTML = buildBoard();
          updateDisplay();
          return;
        }
        const act = e.target.closest("[data-act]")?.dataset.act;
        if (act === "reset") { state.scenario.clear(); board.innerHTML = buildBoard(); updateDisplay(); return; }
        if (act === "share") {
          const url = location.origin + location.pathname + `#/race${state.scenario.size ? `?s=${encodeScenario()}` : ""}`;
          (navigator.clipboard?.writeText(url) || Promise.reject())
            .then(() => window.dispatchEvent(new CustomEvent("wc-toast", { detail: "Scenario link copied" })))
            .catch(() => window.dispatchEvent(new CustomEvent("wc-toast", { detail: "Copy this URL to share" })));
          return;
        }
      });

      board.addEventListener("input", (e) => {
        const sb = e.target.closest("[data-score]");
        if (!sb) return;
        const [id, sidekey] = sb.dataset.score.split(":");
        const cur = state.scenario.get(id) || { hg: 0, ag: 0 };
        const val = Math.max(0, Math.min(20, parseInt(sb.value || "0", 10) || 0));
        const next = { hg: cur.hg ?? 0, ag: cur.ag ?? 0, exact: true };
        if (sidekey === "h") next.hg = val; else next.ag = val;
        state.scenario.set(id, next);
        syncPills(id);            // keep focus in the input
        updateDisplay();
      });
    },
  };
}
