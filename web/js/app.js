// App shell: one white app bar everywhere, scrolling screen, bottom nav on every
// screen (brief §9). Hash router. Detail pages push with a back arrow.

import { loadAll, state, countdown } from "./data.js";
import * as S from "./screens.js";
import { registerServiceWorker } from "./notifications.js";
import * as R from "./reminders.js";

const TABS = [
  { id: "matches", label: "Matches", ico: "⚽" },
  { id: "groups", label: "Groups", ico: "▦" },
  { id: "news", label: "News", ico: "📰" },
  { id: "watch", label: "Watch", ico: "★" },
  { id: "more", label: "More", ico: "≡" },
];

// route key -> { render, title, tab, top }
// top:true → primary tab (logo app bar). Otherwise a pushed detail page (back arrow).
const ROUTES = {
  matches: { render: S.renderMatches, tab: "matches", top: true },
  groups: { render: S.renderGroups, tab: "groups", top: true },
  // Race lives as a sub-tab of Groups; the /race deep-link opens that sub-tab.
  race: { render: (ctx) => S.renderGroups({ ...ctx, forceTab: "race" }), tab: "groups", top: true },
  news: { render: S.renderNews, tab: "news", top: true },
  watch: { render: S.renderWatch, tab: "watch", top: true },
  more: { render: S.renderMore, tab: "more", top: true },
  bracket: { render: S.renderBracket, tab: "more", title: "Bracket" },
  stats: { render: S.renderStats, tab: "more", title: "Stats" },
  match: { render: S.renderMatch, tab: "matches", title: "Match" },
  team: { render: S.renderTeam, tab: "groups", title: "" },
  player: { render: S.renderPlayer, tab: "watch", title: "" },
  club: { render: S.renderClub, tab: "watch", title: "" },
};

function parseHash() {
  const raw = (location.hash || "#/matches").slice(2); // drop "#/"
  const [path, query] = raw.split("?");
  const seg = path.split("/").filter(Boolean);
  return { key: seg[0] || "matches", arg: seg[1] || null, query: new URLSearchParams(query || "") };
}

// replace:true swaps the current history entry instead of pushing — used for sub-tab
// switches inside a detail page so Back exits the page rather than cycling its tabs.
export function navigate(to, replace = false) {
  const url = "#/" + to;
  if (replace) { history.replaceState(null, "", url); render(); }
  else if (("#/" + to) === location.hash) { render(); }
  else { location.hash = url; }   // triggers hashchange → render
}

const $screen = document.getElementById("screen");
const $appbar = document.getElementById("appbar");
const $nav = document.getElementById("bottomnav");

function renderAppbar(route, ctx) {
  $appbar.classList.toggle("top", !!route.top);   // top-level bars get the brand gradient
  if (route.top) {
    $appbar.innerHTML = `
      <span class="logo"><span class="wc">WC</span><span class="yr">26</span>
        <span class="masthead"><b>World Cup</b><i>2026 · Live</i></span></span>
      <span class="spacer"></span>
      <button class="iconbtn" data-nav="stats" aria-label="Stats">
        <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 20V11M12 20V4M19 20v-6"/></svg>
      </button>`;
  } else {
    $appbar.innerHTML = `
      <button class="iconbtn back" data-back aria-label="Back">‹</button>
      <span class="title">${ctx.title || route.title || ""}</span>`;
  }
}

function renderNav(activeTab) {
  $nav.innerHTML = TABS.map((t) =>
    `<button type="button" data-nav="${t.id}" class="${t.id === activeTab ? "active" : ""}">
       <span class="ico">${t.ico}</span><span>${t.label}</span></button>`).join("");
}

function render(opts = {}) {
  const { key, arg, query } = parseHash();
  const route = ROUTES[key] || ROUTES.matches;
  const ctx = { arg, query, title: route.title };
  let out;
  try {
    out = route.render(ctx);
  } catch (e) {
    console.error(e);
    out = `<div class="empty"><div class="big">⚠️</div><div class="t">Something went wrong</div><div>${e.message}</div></div>`;
  }
  const result = typeof out === "string" ? { html: out } : out;
  ctx.title = result.title || ctx.title;
  renderAppbar(route, ctx);
  renderNav(route.tab);
  $screen.innerHTML = result.html;
  $screen.scrollTop = 0;                 // scroll the content area only (not the window)
  if (opts.animate !== false && $screen.animate) {   // visible enter transition (WAAPI is reliable)
    $screen.animate(
      [{ opacity: 0, transform: `translateX(${navDir * 26}px)` }, { opacity: 1, transform: "none" }],
      { duration: 260, easing: "cubic-bezier(.2,.75,.25,1)" },
    );
    navDir = 1;
  }
  if (result.mount) result.mount($screen);
}

// ── global interactions ──
let navDir = 1;   // 1 = forward (slide in from right), -1 = back (from left)
document.addEventListener("click", (e) => {
  // Reminder bell / calendar — handled before nav, since the bell can sit inside a
  // tappable (data-nav) row and must not also navigate (brief feature 3).
  const bell = e.target.closest("[data-reminder]");
  if (bell) {
    const r = R.toggle(bell.dataset.reminder);
    bell.classList.toggle("on", r.set); bell.setAttribute("aria-pressed", String(r.set));
    toast(r.set ? "Reminder set · 15 min before kickoff" : "Reminder removed");
    return;
  }
  const cal = e.target.closest("[data-ics]");
  if (cal) { R.downloadIcs(cal.dataset.ics); toast("Calendar event downloaded"); return; }
  const back = e.target.closest("[data-back]");
  if (back) { navDir = -1; history.length > 1 ? history.back() : navigate("matches"); return; }
  const nav = e.target.closest("[data-nav]");
  if (nav) { navDir = 1; navigate(nav.dataset.nav, nav.hasAttribute("data-replace")); return; }
});
window.addEventListener("popstate", () => { navDir = -1; });

window.addEventListener("hashchange", render);
window.addEventListener("wc-toast", (e) => toast(e.detail));

export function toast(msg) {
  let t = document.querySelector(".toast");
  if (!t) { t = document.createElement("div"); t.className = "toast"; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add("show");
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove("show"), 1600);
}

async function boot() {
  registerServiceWorker();   // PWA install + push receiver (brief §14); no-op if unsupported
  $screen.innerHTML = `<div class="empty"><div class="big">⚽</div><div class="t">Loading…</div></div>`;
  try {
    await loadAll();
  } catch (e) {
    $screen.innerHTML = `<div class="empty"><div class="big">📡</div><div class="t">Couldn't load the snapshot</div><div>Showing nothing rather than something broken. Retry shortly.</div></div>`;
    return;
  }
  render();
  R.rearmAll();        // re-arm in-page reminder timers for still-future games (feature 3)
  R.syncAll();         // push any locally-set reminders up if this device has a subscription
  lastUpdated = state.snap?.meta?.updated;
  bootVersion = await fetchVersion();   // the deployed build this page loaded with

  // Always poll the KV snapshot (cheap, no API cost) so newly-live matches are picked
  // up and scores/minute stay fresh without a manual reload. Re-render in place only
  // when the snapshot actually changed, preserving scroll so browsing isn't disturbed.
  setInterval(tick, 30000);
  // Tick any live countdowns (e.g. the pre-tournament hero) every second so the
  // minutes actually move between data polls.
  setInterval(() => {
    document.querySelectorAll("[data-countdown]").forEach((el) => { el.textContent = countdown(el.dataset.countdown); });
  }, 1000);
  // When the tab is re-shown, refresh immediately and apply any pending code update.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { applyUpdate(); tick(); } });
  window.addEventListener("hashchange", applyUpdate);   // navigating? take the new build now
}

// ── live refresh + self-update ──
let bootVersion = null, updatePending = false, lastUpdated = null;
const LIVE_ROUTES = ["matches", "race", "watch", "match", "groups", "news", "team", "player"];

async function fetchVersion() {
  try { const r = await fetch("/version", { cache: "no-store" }); return r.ok ? (await r.json()).version : bootVersion; }
  catch { return bootVersion; }
}
// Reload to pick up a freshly-deployed build (only when visible, to avoid yanking the
// page mid-read). After reload, bootVersion matches again, so this fires at most once.
function applyUpdate() { if (updatePending && !document.hidden) location.reload(); }

async function tick() {
  try {
    await loadAll();
    const u = state.snap?.meta?.updated;
    if (u !== lastUpdated) {                       // only re-render when data really changed
      lastUpdated = u;
      const { key } = parseHash();
      if (LIVE_ROUTES.includes(key)) {
        const y = $screen.scrollTop;               // preserve scroll across the re-render
        render({ animate: false });
        $screen.scrollTop = y;
      }
    }
  } catch { /* keep last-good on a transient failure */ }

  const v = await fetchVersion();                  // detect a new deploy
  if (bootVersion && v && v !== bootVersion && !updatePending) { updatePending = true; showUpdateBar(); }
}

function showUpdateBar() {
  if (document.getElementById("updbar")) return;
  const bar = document.createElement("button");
  bar.id = "updbar"; bar.className = "updbar";
  bar.innerHTML = `<span class="d"></span> New version available — tap to refresh`;
  bar.onclick = () => location.reload();
  document.body.appendChild(bar);
}

boot();
