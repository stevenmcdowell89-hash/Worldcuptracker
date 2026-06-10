// Morning view (brief feature 2) — a time-of-day overlay that leads the Matches tab
// between 06:00 and 13:00 UK, then reverts to the normal feed after 13:00. It's
// separate from the tournament phase, but its content scales with the phase.
//
// Three sections, composed ENTIRELY from the snapshot (same source as the morning
// push digest — see digest.js): 1) last night's results + the verdict flips they
// caused, 2) today's full slate (kickoff · channel · stakes — never filtered), 3) a
// few plain-English "what's at stake today" storylines from the engine.

import { state, teamName, flag, fmtTime, statusChip } from "./data.js";
import { qualifyOutlook, verdictFlips, resultOf } from "./engine.js";
import { channelFor } from "./tv.js";
import { matchesOn } from "./digest.js";
import { bellButton } from "./reminders.js";

const S = () => state.snap;

const STAKE = {
  decider: { cls: "decider", lbl: "Decider" },
  seeding: { cls: "seeding", lbl: "Seeding" },
  dead: { cls: "dead", lbl: "Dead rubber" },
};

// ── UK wall-clock helpers ──────────────────────────────────────────────────────────
function ukParts(date = new Date()) {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, hour: parseInt(p.hour, 10) % 24 };
}
export function ukDay(date) { return ukParts(date).ymd; }
function shiftDay(ymd, delta) {
  const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** 06:00 ≤ now < 13:00 UK. */
export function isMorningWindow(now = new Date()) { const h = ukParts(now).hour; return h >= 6 && h < 13; }

/** Show the morning layout? Wall-clock by default; `?morning=1`/`0` forces it on/off
 *  (handy for testing and for demoing against the fixed-date mock). */
export function shouldShowMorning(ctx) {
  const q = ctx?.query?.get?.("morning");
  if (q === "1") return true;
  if (q === "0") return false;
  return isMorningWindow();
}

// "Today" for the view. Wall-clock today when the snapshot actually has matches then;
// otherwise (a fixed-date mock, or a stale snapshot) gracefully anchor to the
// snapshot's current action so the view is never wrongly empty. In production these
// coincide — live/scheduled matches are dated to the real today.
function todayYmd(now = new Date()) {
  const snap = S(), wall = ukDay(now);
  const ms = snap.matches || [];
  if (ms.some((m) => m.kickoff && ukDay(new Date(m.kickoff)) === wall)) return wall;
  const live = ms.find((m) => (m.status === "live" || m.status === "ht") && m.kickoff);
  if (live) return ukDay(new Date(live.kickoff));
  const up = ms.filter((m) => m.status === "scheduled" && m.kickoff).sort((a, b) => a.kickoff.localeCompare(b.kickoff))[0];
  if (up) return ukDay(new Date(up.kickoff));
  return wall;
}

// Finished games from "last night": the UK day before today, plus any in the small
// hours of today. Robust to whatever time the user opens the app (the 8am push uses a
// 16h window — the same games, selected for the view's flexible open-time).
function lastNightFinished(today) {
  const prev = shiftDay(today, -1);
  return (S().matches || [])
    .filter((m) => {
      if (m.status !== "ft" || !m.kickoff) return false;
      const p = ukParts(new Date(m.kickoff));
      return p.ymd === prev || (p.ymd === today && p.hour < 6);
    })
    .sort((a, b) => (a.kickoff || "").localeCompare(b.kickoff || ""));
}

// ── section 1: last night ──────────────────────────────────────────────────────────
const FLIP = {
  qualified: { ico: "✅", txt: (n) => `${n} qualified` },
  eliminated: { ico: "❌", txt: (n) => `${n} are out` },
  intoCut: { ico: "▲", txt: (n) => `${n} moved into the top-8 cut` },
  outOfCut: { ico: "▼", txt: (n) => `${n} dropped below the cut` },
};
function lastNightSection(today) {
  const fin = lastNightFinished(today);
  if (!fin.length) return "";                       // hidden entirely if nothing overnight
  const results = fin.map((m) => `<div class="mn-result clickable" data-nav="match/${m.id}">
      <span class="mn-side">${teamName(m.home.code)}${flag(m.home.code)}</span>
      <span class="mn-score">${m.home.score}–${m.away.score}</span>
      <span class="mn-side away">${flag(m.away.code)}${teamName(m.away.code)}</span>
    </div>`).join("");

  const flips = verdictFlips(S(), fin.map(resultOf).filter(Boolean));
  const flipRows = flips.map((f) => {
    const d = FLIP[f.kind]; if (!d) return "";
    return `<div class="mn-flip clickable" data-nav="team/${f.code}"><span class="ic">${d.ico}</span><span>${d.txt(teamName(f.code))}</span></div>`;
  }).filter(Boolean).join("");
  const changes = flipRows
    ? `<div class="mn-sub">What changed overnight</div><div class="mn-flips">${flipRows}</div>` : "";

  return `<div class="mn-sec"><div class="mn-h"><h3>Last night</h3><span class="sub">what you missed</span></div>
    <div class="section">${results}</div>${changes}</div>`;
}

// ── section 2: today's slate (full list, never filtered) ────────────────────────────
function slateSection(today) {
  const list = matchesOn(S(), today);
  if (!list.length) return "";
  const rows = list.map((m) => {
    const live = m.status === "live" || m.status === "ht";
    const ft = m.status === "ft";
    const when = live ? `<span class="min">${m.minute || "LIVE"}</span>` : ft ? `<span class="ko">FT</span>` : `<span class="ko">${fmtTime(m.kickoff)}</span>`;
    const ch = channelFor(m);
    const st = m.stakes && STAKE[m.stakes];
    const tags = [
      ch ? `<span class="tvtag">📺 ${ch.channel}</span>` : "",
      st ? `<span class="stake ${st.cls}">${st.lbl}</span>` : "",
    ].filter(Boolean).join("");
    return `<div class="mn-slate">
      <div class="mn-slate-top clickable" data-nav="match/${m.id}">
        <span class="when">${when}</span>
        <span class="teams">${flag(m.home.code)}${teamName(m.home.code)} <span class="v">v</span> ${teamName(m.away.code)}${flag(m.away.code)}</span>
        ${bellButton(m)}
      </div>
      ${tags ? `<div class="mn-slate-tags">${tags}</div>` : ""}
    </div>`;
  }).join("");
  return `<div class="mn-sec"><div class="mn-h"><h3>Today</h3><span class="sub">the slate · ${list.length} game${list.length === 1 ? "" : "s"}</span></div>
    <div class="section">${rows}</div></div>`;
}

// ── section 3: what's at stake today (phase-scaled) ─────────────────────────────────
function atStakeSection(today, ph) {
  const todays = matchesOn(S(), today).filter((m) => m.group);
  if (!todays.length) return "";

  // Groups whose remaining fixtures are all today → settled tonight.
  const rem = S().remainingFixtures || [];
  const groupsToday = [...new Set(todays.map((m) => m.group))];
  const settledToday = groupsToday.filter((g) => {
    const gr = rem.filter((f) => f.group === g);
    return gr.length > 0 && gr.every((f) => (f.kickoff || "").slice(0, 10) === today);
  });

  // Per-team storylines from the engine, for the undecided teams playing today.
  const seen = new Set(), lines = [];
  for (const m of todays) {
    for (const code of [m.home.code, m.away.code]) {
      if (seen.has(code)) continue; seen.add(code);
      const o = qualifyOutlook(S(), code, state.annexC);
      if (o.status === "sweating" || o.status === "in" || o.status === "out") lines.push({ code, ...o });
    }
  }
  // Phase scaling: in early `group` mornings the race isn't meaningful yet — only
  // surface this section if today genuinely decides something (a decider on the slate
  // or a group settling). In `groupFinal` it's the peak and always shows.
  const decisive = settledToday.length > 0 || todays.some((m) => m.stakes === "decider");
  if (ph !== "groupFinal" && !decisive) return "";
  if (!settledToday.length && !lines.length) return "";

  const settledHtml = settledToday.sort().map((g) =>
    `<div class="mn-stake"><span class="ic">🔓</span><span><b>Group ${g}</b> is settled today.</span></div>`).join("");
  const lineHtml = lines.slice(0, 6).map((o) =>
    `<div class="mn-stake clickable" data-nav="team/${o.code}">${flag(o.code)}<span>${o.line}</span>${statusChip(o.status, false)}</div>`).join("");

  return `<div class="mn-sec"><div class="mn-h"><h3>What's at stake today</h3></div>
    <div class="section">${settledHtml}${lineHtml}</div></div>`;
}

// ── compose ─────────────────────────────────────────────────────────────────────────
function prettyDate(ymd) {
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
}

export function morningView(ph = "group", now = new Date()) {
  const today = todayYmd(now);
  const s1 = lastNightSection(today);
  const s2 = slateSection(today);
  const s3 = atStakeSection(today, ph);

  // A rest day with nothing on either side → a minimal view, no fabricated content.
  if (!s1 && !s2) {
    return `<div class="morning"><div class="mn-hd">Good morning</div>
      <div class="empty"><div class="big">☕</div><div class="t">A quiet morning</div>
      <div>No World Cup games today — back to the action soon.</div></div></div>`;
  }
  return `<div class="morning"><div class="mn-hd">Good morning <span>· ${prettyDate(today)}</span></div>${s1}${s2}${s3}</div>`;
}
