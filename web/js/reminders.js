// Per-match reminders (feature 3) — a device-local convenience, NO accounts.
//
//   • Push (primary): a one-off notification ~15 min (configurable) before kickoff,
//     scheduled server-side on this device's anonymous push-subscription record
//     (POST /push/remind). The Worker's per-minute cron delivers it.
//   • Calendar (secondary): a client-generated .ics event — works anywhere,
//     including where push doesn't (e.g. iOS Safari without Add-to-Home-Screen).
//   • State: localStorage marks which fixtures this device has a bell on.

import { state, teamName } from "./data.js";
import { pushSupported, currentSubscription, enablePush, loadPrefs } from "./notifications.js";

const LS_REMS = "wc26-reminders";
const LS_LEAD = "wc26-reminder-lead";
export const LEAD_OPTIONS = [15, 30, 60];

function loadRems() { try { return JSON.parse(localStorage.getItem(LS_REMS) || "{}"); } catch { return {}; } }
function saveRems(r) { try { localStorage.setItem(LS_REMS, JSON.stringify(r)); } catch {} }
export function hasReminder(fixtureId) { return !!loadRems()[fixtureId]; }
export function reminderLead() {
  const l = parseInt((typeof localStorage !== "undefined" && localStorage.getItem(LS_LEAD)) || "", 10);
  return LEAD_OPTIONS.includes(l) ? l : 15;
}
export function setReminderLead(l) { try { localStorage.setItem(LS_LEAD, String(l)); } catch {} }

const toast = (msg) => { try { window.dispatchEvent(new CustomEvent("wc-toast", { detail: msg })); } catch {} };

// ── bell button (fixture rows + match centre) ──
const BELL_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>`;
export function bellHTML(m) {
  if (m.status !== "scheduled" || !m.kickoff) return "";
  const on = hasReminder(m.id);
  return `<button type="button" class="bellbtn ${on ? "on" : ""}" data-remind="${m.id}"
    aria-label="${on ? "Remove reminder" : "Remind me before kick-off"}" aria-pressed="${on}">${BELL_SVG}</button>`;
}
function paintBells(fixtureId) {
  const on = hasReminder(fixtureId);
  document.querySelectorAll(`[data-remind="${CSS.escape(fixtureId)}"]`).forEach((el) => {
    el.classList.toggle("on", on);
    el.setAttribute("aria-pressed", String(on));
  });
  const status = document.querySelector(`[data-remind-status="${CSS.escape(fixtureId)}"]`);
  if (status) status.textContent = on ? `On — ${reminderLead()} min before kick-off` : "Off";
}

// ── .ics fallback (title, kickoff, channel/venue when known) ──
const icsEsc = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/[,;]/g, "\\$&").replace(/\n/g, "\\n");
const icsTime = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
export function icsFor(m) {
  const ko = Date.parse(m.kickoff);
  const title = `${teamName(m.home.code)} v ${teamName(m.away.code)} — World Cup 2026`;
  const bits = [m.tv ? `On ${m.tv.channel}${m.tv.stream ? ` / ${m.tv.stream}` : ""}` : "", m.group ? `Group ${m.group}` : (m.stage || "")].filter(Boolean);
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//WC26 Tracker//EN", "BEGIN:VEVENT",
    `UID:wc26-${m.id}@wc26-tracker`, `DTSTAMP:${icsTime(Date.now())}`,
    `DTSTART:${icsTime(ko)}`, `DTEND:${icsTime(ko + 2 * 3600e3)}`,
    `SUMMARY:${icsEsc(title)}`,
    bits.length ? `DESCRIPTION:${icsEsc(bits.join(" · "))}` : "",
    m.venue ? `LOCATION:${icsEsc(m.venue)}` : "",
    "BEGIN:VALARM", `TRIGGER:-PT${reminderLead()}M`, "ACTION:DISPLAY", `DESCRIPTION:${icsEsc(title)}`, "END:VALARM",
    "END:VEVENT", "END:VCALENDAR"].filter(Boolean).join("\r\n");
}
export function downloadIcs(m) {
  const blob = new Blob([icsFor(m)], { type: "text/calendar" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${m.home.code}-v-${m.away.code}.ics`.toLowerCase();
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ── server sync ──
async function postRemind(sub, m, on) {
  const r = await fetch("/push/remind", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: sub.endpoint, fixtureId: m.id, kickoff: m.kickoff, lead: reminderLead(), on }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `remind ${r.status}`);
}

// ── the tap (rows + match centre share this via [data-remind]) ──
export async function handleReminderTap(fixtureId, el) {
  const m = (state.snap?.matches || []).find((x) => x.id === fixtureId);
  if (!m) return;
  const rems = loadRems();

  if (rems[fixtureId]) {                                  // toggle OFF
    delete rems[fixtureId]; saveRems(rems); paintBells(fixtureId);
    try { const sub = await currentSubscription(); if (sub) await postRemind(sub, m, false); } catch {}
    toast("Reminder removed");
    return;
  }

  // toggle ON — push first, .ics as the works-anywhere fallback
  if (el) el.disabled = true;
  try {
    if (pushSupported() && Notification.permission !== "denied") {
      let sub = await currentSubscription().catch(() => null);
      if (!sub) sub = await enablePush(loadPrefs());      // one prompt; reuses the §14 flow
      await postRemind(sub, m, true);
      rems[fixtureId] = { at: m.kickoff, lead: reminderLead() };
      saveRems(rems); paintBells(fixtureId);
      toast(`Reminder set — ${reminderLead()} min before kick-off`);
      return;
    }
    throw new Error("push unavailable");
  } catch {
    // push refused/unavailable → calendar fallback still delivers the nudge
    try {
      downloadIcs(m);
      rems[fixtureId] = { at: m.kickoff, lead: reminderLead(), ics: true };
      saveRems(rems); paintBells(fixtureId);
      toast("Push unavailable — added a calendar event instead");
    } catch { toast("Couldn't set a reminder"); }
  } finally { if (el) el.disabled = false; }
}

// Lead selector + calendar button in the match centre (event delegation — screens
// re-render freely, so nothing needs re-mounting).
export function initReminderControls() {
  document.addEventListener("change", async (e) => {
    const sel = e.target.closest("[data-remlead]");
    if (!sel) return;
    setReminderLead(parseInt(sel.value, 10));
    // a reminder already set on this fixture? re-sync the new lead to the server
    const fid = sel.dataset.remlead;
    if (fid && hasReminder(fid)) {
      const m = (state.snap?.matches || []).find((x) => x.id === fid);
      const rems = loadRems();
      rems[fid] = { ...rems[fid], lead: reminderLead() };
      saveRems(rems); paintBells(fid);
      try { const sub = await currentSubscription(); if (sub && m) await postRemind(sub, m, true); } catch {}
    }
  });
}

// The match-centre reminder card (scheduled matches only).
export function reminderCardHTML(m) {
  if (m.status !== "scheduled" || !m.kickoff) return "";
  const on = hasReminder(m.id);
  const lead = reminderLead();
  const opts = LEAD_OPTIONS.map((l) => `<option value="${l}" ${l === lead ? "selected" : ""}>${l} min before</option>`).join("");
  return `<div class="block remcard">
    <div class="lrow">
      <span class="nm">Match reminder<div class="sub" data-remind-status="${m.id}">${on ? `On — ${lead} min before kick-off` : "Off"}</div></span>
      <button type="button" class="bellbtn big ${on ? "on" : ""}" data-remind="${m.id}" aria-pressed="${on}" aria-label="Toggle reminder">${BELL_SVG}</button>
    </div>
    <div class="lrow">
      <span class="nm sub-label">Nudge me</span>
      <select class="remlead" data-remlead="${m.id}">${opts}</select>
    </div>
    <div class="lrow clickable" data-ics="${m.id}">
      <span class="nm">📅 Add to calendar<div class="sub">An .ics event — works without notifications</div></span>
      <span class="chev">›</span>
    </div>
  </div>`;
}
