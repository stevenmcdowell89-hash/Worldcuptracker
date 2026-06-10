// Morning view (time-boxed catch-up) — the MODEL. Pure + snapshot-only, so it's
// node-testable; the HTML lives in screens.js (which owns matchRow etc.).
//
// Between 06:00 and 13:00 UK the Matches tab leads with a morning layout:
//   1. Last night — overnight finished results + the qualification changes they
//      caused (verdict flips from the engine, cut-line crossings).
//   2. Today — the full slate in kickoff order (never filtered, never hidden).
//   3. What's at stake today — plain-English storylines from the engine.
// Content scales with the phase: full at groupFinal (the peak), quiet early on,
// reframed for knockout mornings (who advanced / today's ties + who they'd meet).
//
// Everything is composed from the snapshot — the same source as the morning push
// digest (one source, two surfaces). No fabricated content: empty sections vanish.

import { qualifyOutlook, recompute, thirdPlaceTable, spotsMoving, compareGroupRows, GROUP_LETTERS, QUALIFY_COUNT } from "./engine.js";

// ── UK wall clock (the window is UK-time-boxed; kickoffs are ISO/UTC) ──
const UK_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London", hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});
export function ukClock(t = Date.now()) {
  const ms = typeof t === "number" ? t : Date.parse(t || "");
  if (!Number.isFinite(ms)) return null;
  const p = Object.fromEntries(UK_FMT.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: parseInt(p.hour, 10), minute: parseInt(p.minute, 10) };
}
export const MORNING_FROM = 6, MORNING_TO = 13;   // [06:00, 13:00) UK
export function inMorningWindow(now = Date.now()) {
  const uk = ukClock(now);
  return !!uk && uk.hour >= MORNING_FROM && uk.hour < MORNING_TO;
}

const nameOf = (snap, code) => snap.teams?.[code]?.name || code;

// "Last night" = finished games whose kickoff falls after 13:00 UK *yesterday* (the
// end of the previous morning window) — US kickoffs run deep into the UK night, so
// the whole previous evening/overnight programme counts as catch-up material.
function isOvernight(snap, m, now) {
  if (m.status !== "ft" || !m.kickoff) return false;
  const ko = Date.parse(m.kickoff);
  if (!Number.isFinite(ko) || ko > now) return false;
  const ukNow = ukClock(now), ukKo = ukClock(ko);
  if (ukKo.date === ukNow.date) return true;                       // finished earlier today
  const yest = ukClock(now - 24 * 3600e3);
  return ukKo.date === yest.date && ukKo.hour >= MORNING_TO;       // yesterday, post-13:00
}

// ── reverse-apply overnight group results → the "before" state for verdict flips ──
// (Fair-play cards earned in those games can't be unwound — a documented, harmless
// approximation: card tiebreaks rarely flip a verdict overnight.)
export function beforeState(snap, overnight) {
  const groups = {};
  for (const g of Object.keys(snap.groups || {})) groups[g] = snap.groups[g].map((r) => ({ ...r }));
  const remainingFixtures = (snap.remainingFixtures || []).slice();
  for (const m of overnight) {
    if (!m.group || !groups[m.group]) continue;
    const rows = groups[m.group];
    const h = rows.find((r) => r.code === m.home.code), a = rows.find((r) => r.code === m.away.code);
    const hg = m.home.score ?? 0, ag = m.away.score ?? 0;
    if (!h || !a) continue;
    h.P -= 1; a.P -= 1;
    h.GF -= hg; h.GA -= ag; a.GF -= ag; a.GA -= hg;
    h.GD = h.GF - h.GA; a.GD = a.GF - a.GA;
    if (hg > ag) { h.W -= 1; h.Pts -= 3; a.L -= 1; }
    else if (hg < ag) { a.W -= 1; a.Pts -= 3; h.L -= 1; }
    else { h.D -= 1; a.D -= 1; h.Pts -= 1; a.Pts -= 1; }
    remainingFixtures.push({ id: m.id, group: m.group, home: m.home.code, away: m.away.code, kickoff: m.kickoff, affectsThird: true });
  }
  for (const g of Object.keys(groups)) groups[g].sort(compareGroupRows);
  return { groups, remainingFixtures, teams: snap.teams || {} };
}

// Qualification changes the overnight results caused: verdict flips for the teams
// involved + anyone who crossed the third-place cut line. Plain sentences, no spam.
export function overnightFlips(snap, overnight) {
  const groupGames = overnight.filter((m) => m.group);
  if (!groupGames.length) return [];
  const before = beforeState(snap, groupGames);
  const flips = [];
  const seen = new Set();
  const involved = [...new Set(groupGames.flatMap((m) => [m.home.code, m.away.code]))];
  for (const code of involved) {
    const b = qualifyOutlook(before, code).status;
    const n = qualifyOutlook(snap, code).status;
    if (b === n) continue;
    if (n === "qualified") { flips.push(`✅ ${nameOf(snap, code)} are through to the Round of 32.`); seen.add(code); }
    else if (n === "eliminated") { flips.push(`❌ ${nameOf(snap, code)} are out.`); seen.add(code); }
  }
  // cut-line crossings (these can hit teams who didn't even play)
  try {
    const rankOf = (state) => {
      const t = thirdPlaceTable(recompute(state, []));
      return Object.fromEntries(t.map((x) => [x.code, x.rank]));
    };
    const rb = rankOf(before), rn = rankOf(snap);
    for (const code of Object.keys(rn)) {
      if (seen.has(code) || rb[code] == null) continue;
      const wasIn = rb[code] <= QUALIFY_COUNT, isIn = rn[code] <= QUALIFY_COUNT;
      if (wasIn === isIn) continue;
      flips.push(isIn
        ? `↑ ${nameOf(snap, code)} moved above the third-place cut line.`
        : `↓ ${nameOf(snap, code)} dropped below the third-place cut line.`);
    }
  } catch { /* cut-line diff is best-effort */ }
  return flips;
}

// ── section 3: plain-English storylines from the engine ──
function groupStakeLines(snap, annexC, today, phase, todayUkDate) {
  const lines = [];
  // groups that could be settled today: every remaining fixture in the group is today
  const remByGroup = {};
  for (const f of snap.remainingFixtures || []) (remByGroup[f.group] = remByGroup[f.group] || []).push(f);
  for (const g of GROUP_LETTERS) {
    const rem = remByGroup[g];
    if (rem?.length && rem.every((f) => ukClock(f.kickoff)?.date === todayUkDate)) {
      lines.push(`Group ${g} is decided today.`);
    }
  }
  // teams whose fate could move today — the engine's own sentences
  const cap = phase === "groupFinal" ? 6 : 2;     // early group mornings stay quiet
  const codes = [...new Set(today.filter((m) => m.group).flatMap((m) => [m.home.code, m.away.code]))];
  const outlooks = [];
  for (const code of codes) {
    const o = qualifyOutlook(snap, code, annexC);
    if (o.status === "sweating" || o.status === "in" || o.status === "out") outlooks.push(o.line);
  }
  lines.push(...outlooks.slice(0, cap));
  // third-place cut-line jeopardy
  if (phase === "groupFinal") {
    const moving = snap.meta?.spotsMoving ?? spotsMoving(snap);
    if (moving > 0) lines.push(`The third-place cut line is live — ${moving} of the last-8 spot${moving === 1 ? " is" : "s are"} still moving.`);
  }
  return lines;
}

// Knockout mornings: today's ties + where the winner goes next.
function knockoutStakeLines(snap, today) {
  const lines = [];
  const bm = Object.fromEntries((snap.bracket?.matches || []).map((m) => [m.id, m]));
  for (const m of today.filter((x) => !x.group)) {
    const slotNo = /-M(\d+)$/.exec(m.slot || "")?.[1];
    const tie = slotNo && bm[slotNo];
    const next = tie?.next && bm[tie.next];
    let dest = "";
    if (next) {
      const other = [next.a?.label, next.b?.label].find((l) => l && l !== `Winner Match ${slotNo}`);
      dest = other ? ` — the winner meets the ${other.replace(/^Winner Match (\d+)$/, "winner of Match $1")}` : ` — the winner goes to Match ${tie.next}`;
    }
    lines.push(`${nameOf(snap, m.home.code)} v ${nameOf(snap, m.away.code)}${dest}.`);
  }
  return lines;
}

// Who advanced overnight (knockout): winners by score (pens unresolved → skip).
function advancedLines(snap, overnight) {
  const out = [];
  for (const m of overnight.filter((x) => !x.group)) {
    const hs = m.home.score, as = m.away.score;
    if (hs == null || as == null || hs === as) continue;          // pens not modelled — say nothing wrong
    const w = hs > as ? m.home.code : m.away.code;
    out.push(`✅ ${nameOf(snap, w)} advance.`);
  }
  return out;
}

/**
 * The morning model. Returns null outside the 06:00–13:00 UK window (callers can
 * force it for demos/tests). All lists may be empty — render nothing for them.
 */
export function morningModel(snap, annexC, now = Date.now(), force = false) {
  if (!snap || (!force && !inMorningWindow(now))) return null;
  const phase = snap.meta?.phase || "group";
  if (phase === "pre") return null;                              // nothing to catch up on
  const todayUkDate = ukClock(now).date;
  const matches = snap.matches || [];

  const lastNight = matches.filter((m) => isOvernight(snap, m, now))
    .sort((a, b) => (b.kickoff || "").localeCompare(a.kickoff || ""));
  const today = matches.filter((m) => m.status !== "ft" && m.kickoff && ukClock(m.kickoff)?.date === todayUkDate)
    .sort((a, b) => (a.kickoff || "").localeCompare(b.kickoff || ""));

  const flips = phase === "knockout" ? advancedLines(snap, lastNight) : overnightFlips(snap, lastNight);
  const stakes = phase === "knockout"
    ? knockoutStakeLines(snap, today)
    : groupStakeLines(snap, annexC, today, phase, todayUkDate);

  return { phase, date: todayUkDate, lastNight, flips, today, stakes, restDay: !today.length };
}
