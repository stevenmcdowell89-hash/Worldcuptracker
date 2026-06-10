// Per-match reminders (brief feature 3). A device-local convenience to be nudged
// before a chosen game — NOT a login or following feature. No accounts, no server-side
// per-user identity; it changes nobody else's content.
//
// Two delivery paths, in the brief's priority order:
//   1. PUSH (primary): piggybacks the existing notification system. If this device has
//      a push subscription (the anonymous per-device key), we register the reminder on
//      that subscription's record; the Worker cron fires it ~15 min before kickoff.
//   2. CALENDAR (.ics, secondary): generated client-side, works anywhere — including
//      where push doesn't (notably iOS) — as a reliable fallback.
//
// Bell state itself lives in localStorage (per-device), so the toggle works even with
// push off; enabling push later syncs any pending reminders up.

import { state, teamName, fmtDay, fmtTime } from "./data.js";
import { channelFor } from "./tv.js";

const LS_KEY = "wc26-reminders";
const DEFAULT_LEAD = 15;          // minutes before kickoff

function read() { try { return JSON.parse(localStorage.getItem(LS_KEY) || "{}"); } catch { return {}; } }
function write(o) { try { localStorage.setItem(LS_KEY, JSON.stringify(o)); } catch {} }

export function isSet(id) { return !!read()[id]; }
export function leadFor(id) { return read()[id]?.leadMin ?? DEFAULT_LEAD; }

function matchById(id) { return (state.snap?.matches || []).find((m) => String(m.id) === String(id)); }
function isFuture(m) { return m && m.kickoff && new Date(m.kickoff).getTime() > Date.now(); }

// ── bell UI ──────────────────────────────────────────────────────────────────────
/** A bell toggle for a fixture row / match centre. Only shown for upcoming matches
 *  (no point reminding for a game that has kicked off). Filled when set. */
export function bellButton(match, big = false) {
  if (!isFuture(match)) return "";
  const on = isSet(match.id);
  return `<button class="bell${big ? " big" : ""}${on ? " on" : ""}" data-reminder="${match.id}"
    aria-pressed="${on}" aria-label="${on ? "Remove reminder" : "Remind me 15 minutes before kickoff"}"
    title="${on ? "Reminder set — tap to remove" : "Remind me 15 min before kickoff"}">🔔</button>`;
}

// ── toggle (called from the global click handler) ──────────────────────────────────
export function toggle(id) {
  const m = matchById(id);
  const store = read();
  if (store[id]) {
    delete store[id]; write(store);
    syncServer(m, false);
    return { set: false };
  }
  if (!isFuture(m)) return { set: false };
  store[id] = { leadMin: DEFAULT_LEAD, ts: Date.now() };
  write(store);
  scheduleLocal(m);
  syncServer(m, true);
  return { set: true };
}

// ── push (primary) ─────────────────────────────────────────────────────────────────
async function currentSubscription() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try { const reg = await navigator.serviceWorker.ready; return await reg.pushManager.getSubscription(); }
  catch { return null; }
}
function reminderPayload(m) {
  const ch = channelFor(m);
  return {
    title: "Kicking off soon ⚽",
    body: `${teamName(m.home.code)} v ${teamName(m.away.code)} · ${fmtTime(m.kickoff)}${ch ? ` · ${ch.channel}` : ""}`,
  };
}
// Register/clear the reminder on this device's push-subscription record. No-op (and no
// error surfaced) when push isn't enabled — the .ics fallback still covers the user.
async function syncServer(m, on) {
  if (!m) return;
  const sub = await currentSubscription();
  if (!sub) return;
  const { title, body } = reminderPayload(m);
  try {
    await fetch("/push/reminder", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint, subscription: sub.toJSON(), matchId: String(m.id), kickoff: m.kickoff, leadMin: leadFor(m.id), title, body, on }),
    });
  } catch { /* push is best-effort; .ics is the reliable path */ }
}
// Push up every locally-set reminder (e.g. just after the user enables notifications).
export async function syncAll() {
  const store = read();
  for (const id of Object.keys(store)) await syncServer(matchById(id), true);
}

// ── local notification (best-effort, while the page is open) ───────────────────────
const timers = {};
function scheduleLocal(m) {
  if (!m || typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const fireAt = new Date(m.kickoff).getTime() - leadFor(m.id) * 60000;
  const delay = fireAt - Date.now();
  if (delay <= 0 || delay > 24 * 3600 * 1000) return;     // only arm within the next day
  clearTimeout(timers[m.id]);
  timers[m.id] = setTimeout(() => {
    if (!isSet(m.id)) return;
    const { title, body } = reminderPayload(m);
    try { new Notification(title, { body, tag: `wc26-rem-${m.id}` }); } catch {}
  }, delay);
}
/** Re-arm in-page timers for any still-future reminders (called once on boot). */
export function rearmAll() {
  const store = read();
  for (const id of Object.keys(store)) { const m = matchById(id); if (isFuture(m)) scheduleLocal(m); }
  prunePast();
}
function prunePast() {
  const store = read(); let changed = false;
  for (const id of Object.keys(store)) {
    const m = matchById(id);
    if (m && m.kickoff && new Date(m.kickoff).getTime() < Date.now() - 3 * 3600e3) { delete store[id]; changed = true; }
  }
  if (changed) write(store);
}

// ── calendar (.ics, secondary) ─────────────────────────────────────────────────────
function ics(s) { return String(s).replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n"); }
function dt(d) { return new Date(d).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"); }

export function buildIcs(m) {
  const ch = channelFor(m);
  const start = new Date(m.kickoff);
  const end = new Date(start.getTime() + 2 * 3600 * 1000);   // ~2h including half-time
  const title = `${teamName(m.home.code)} v ${teamName(m.away.code)}`;
  const where = m.venue || (ch ? `${ch.channel}${ch.stream ? ` / ${ch.stream}` : ""}` : "");
  const desc = [m.group ? `Group ${m.group}` : (m.stage || ""), ch ? `Watch: ${ch.channel}${ch.stream ? ` / ${ch.stream}` : ""}` : ""].filter(Boolean).join(" · ");
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//WC26 Tracker//EN", "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:wc26-${m.id}@worldcuptracker`,
    `DTSTAMP:${dt(Date.now())}`,
    `DTSTART:${dt(start)}`,
    `DTEND:${dt(end)}`,
    `SUMMARY:⚽ ${ics(title)}`,
    where ? `LOCATION:${ics(where)}` : "",
    desc ? `DESCRIPTION:${ics(desc)}` : "",
    "BEGIN:VALARM", `TRIGGER:-PT${leadFor(m.id)}M`, "ACTION:DISPLAY", `DESCRIPTION:${ics(title)} kicks off soon`, "END:VALARM",
    "END:VEVENT", "END:VCALENDAR",
  ].filter(Boolean).join("\r\n");
}

export function downloadIcs(id) {
  const m = matchById(id);
  if (!m) return;
  const blob = new Blob([buildIcs(m)], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `WC26-${m.home.code}-${m.away.code}.ics`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The reminder controls for the match centre: bell + "Add to calendar". */
export function reminderControls(match) {
  if (!isFuture(match)) return "";
  return `<div class="remind-bar">
    ${bellButton(match, true)}
    <span class="remind-txt">Remind me <b>15 min</b> before kickoff</span>
    <button class="calbtn" data-ics="${match.id}">＋ Calendar</button>
  </div>`;
}
