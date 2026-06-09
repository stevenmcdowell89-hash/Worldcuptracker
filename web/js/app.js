// App shell: one white app bar everywhere, scrolling screen, bottom nav on every
// screen (brief §9). Hash router. Detail pages push with a back arrow.

import { loadAll, state } from "./data.js";
import * as S from "./screens.js";
import { renderRace } from "./race.js";

const TABS = [
  { id: "matches", label: "Matches", ico: "⚽" },
  { id: "groups", label: "Groups", ico: "▦" },
  { id: "race", label: "Race", ico: "📊" },
  { id: "watch", label: "Watch", ico: "★" },
  { id: "more", label: "More", ico: "≡" },
];

// route key -> { render, title, tab, top }
// top:true → primary tab (logo app bar). Otherwise a pushed detail page (back arrow).
const ROUTES = {
  matches: { render: S.renderMatches, tab: "matches", top: true },
  groups: { render: S.renderGroups, tab: "groups", top: true },
  race: { render: renderRace, tab: "race", top: true },
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
  if (route.top) {
    $appbar.innerHTML = `
      <span class="logo">WC<span class="dot">26</span></span>
      <span class="spacer"></span>
      <button class="iconbtn" data-nav="stats" aria-label="Stats">📈</button>`;
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
  $screen.innerHTML = `<div class="empty"><div class="big">⚽</div><div class="t">Loading…</div></div>`;
  try {
    await loadAll();
  } catch (e) {
    $screen.innerHTML = `<div class="empty"><div class="big">📡</div><div class="t">Couldn't load the snapshot</div><div>Showing nothing rather than something broken. Retry shortly.</div></div>`;
    return;
  }
  render();
  // Auto-refresh only while something is live: re-fetch the snapshot and re-render
  // the data screens (so the score/minute update). Idle browsing isn't disturbed.
  setInterval(async () => {
    const live = (state.snap?.matches || []).some((m) => m.status === "live" || m.status === "ht");
    if (!live) return;
    try { await loadAll(); } catch { return; }
    const { key } = parseHash();
    if (["matches", "race", "watch", "match"].includes(key)) render({ animate: false });
  }, 45000);
}

boot();
