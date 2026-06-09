// App shell: one white app bar everywhere, scrolling screen, bottom nav on every
// screen (brief §9). Hash router. Detail pages push with a back arrow.

import { loadAll, state } from "./data.js";
import * as S from "./screens.js";
import { renderRace } from "./race.js";

const TABS = [
  { id: "matches", label: "Matches", ico: "⚽" },
  { id: "race", label: "Race", ico: "📊" },
  { id: "watch", label: "Watch", ico: "★" },
  { id: "bracket", label: "Bracket", ico: "🏆" },
  { id: "more", label: "More", ico: "≡" },
];

// route key -> { render, title, tab, detail }
const ROUTES = {
  matches: { render: S.renderMatches, tab: "matches", top: true },
  race: { render: renderRace, tab: "race", top: true },
  watch: { render: S.renderWatch, tab: "watch", top: true },
  bracket: { render: S.renderBracket, tab: "bracket", top: true },
  more: { render: S.renderMore, tab: "more", top: true },
  groups: { render: S.renderGroups, tab: "more", title: "Groups" },
  stats: { render: S.renderStats, tab: "more", title: "Stats" },
  match: { render: S.renderMatch, tab: "matches", title: "Match" },
  team: { render: S.renderTeam, tab: "matches", title: "" },
  player: { render: S.renderPlayer, tab: "watch", title: "" },
  club: { render: S.renderClub, tab: "watch", title: "" },
};

function parseHash() {
  const raw = (location.hash || "#/matches").slice(2); // drop "#/"
  const [path, query] = raw.split("?");
  const seg = path.split("/").filter(Boolean);
  return { key: seg[0] || "matches", arg: seg[1] || null, query: new URLSearchParams(query || "") };
}

export function navigate(to) { location.hash = "#/" + to; }

const $screen = document.getElementById("screen");
const $appbar = document.getElementById("appbar");
const $nav = document.getElementById("bottomnav");

function renderAppbar(route, ctx) {
  if (route.top) {
    $appbar.innerHTML = `
      <span class="logo">WC<span class="dot">26</span></span>
      <span class="spacer"></span>
      <button class="iconbtn" data-nav="groups" aria-label="Groups">▦</button>
      <button class="iconbtn" data-nav="stats" aria-label="Stats">📈</button>`;
  } else {
    $appbar.innerHTML = `
      <button class="iconbtn back" data-back aria-label="Back">‹</button>
      <span class="title">${ctx.title || route.title || ""}</span>`;
  }
}

function renderNav(activeTab) {
  $nav.innerHTML = TABS.map((t) =>
    `<a data-nav="${t.id}" class="${t.id === activeTab ? "active" : ""}">
       <span class="ico">${t.ico}</span><span>${t.label}</span></a>`).join("");
}

function render() {
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
  $screen.scrollTop = 0;
  window.scrollTo(0, 0);
  if (result.mount) result.mount($screen);
}

// ── global interactions ──
document.addEventListener("click", (e) => {
  const back = e.target.closest("[data-back]");
  if (back) { history.length > 1 ? history.back() : navigate("matches"); return; }
  const nav = e.target.closest("[data-nav]");
  if (nav) { navigate(nav.dataset.nav); return; }
});

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
  // light live tick: re-render Matches/Race minute counters & countdowns
  setInterval(() => {
    const { key } = parseHash();
    if (["matches", "watch"].includes(key)) render();
  }, 30000);
}

boot();
