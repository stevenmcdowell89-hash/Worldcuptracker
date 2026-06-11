// Data layer + view helpers. The frontend ONLY reads the KV snapshot
// (data/latest.json) — it never calls a data API directly (brief §2).

export const state = {
  snap: null,        // the snapshot
  colours: {},       // teamColours.json
  annexC: null,      // annexC.json
  scenario: new Map(),  // fixtureId -> { outcome:'W'|'D'|'L', hg?, ag?, exact }
};

const j = (r) => { if (!r.ok) throw new Error(r.status); return r.json(); };

export async function loadAll() {
  // last-good behaviour: if the snapshot fetch fails we still try to render
  // whatever we have; the Worker guarantees a last-good snapshot in production.
  const [snap, colours, annexC] = await Promise.all([
    fetch("data/latest.json", { cache: "no-store" }).then(j),
    fetch("data/teamColours.json").then(j).catch(() => ({})),
    fetch("data/annexC.json").then(j).catch(() => null),
  ]);
  state.snap = snap;
  state.colours = colours;
  state.annexC = annexC;
  return state;
}

// ── team identity helpers ──
export function colour(code) {
  return state.colours[code] || { primary: "#3A3F4B", secondary: "#1F222B", text: "#FFFFFF" };
}
export function teamName(code) {
  const t = state.snap?.teams?.[code];
  return (t && t.name) || code;
}
export function player(id) { return state.snap?.players?.[String(id)]; }

/** Crest/flag for a team. Prefers the official crest image from the snapshot
 *  (`crests` map, written by the Worker); falls back to a dependency-free two-tone
 *  block from the nation's kit colours so it still works offline / on the mock. */
export function flag(code, cls = "flag") {
  const url = state.snap?.crests?.[code];
  if (url) return `<span class="${cls}" style="background-image:url('${url}');background-size:cover;background-position:center" title="${code}" aria-label="${code}"></span>`;
  const c = colour(code);
  const bg = `linear-gradient(135deg, ${c.primary} 0 52%, ${c.secondary} 52% 100%)`;
  return `<span class="${cls}" style="background:${bg}" title="${code}" aria-label="${code}"></span>`;
}

/** Live match minute that keeps moving between data polls. The worker refreshes
 *  roughly once a minute (cron granularity), so a static minute skips values;
 *  render the anchor (minute + when the snapshot was built) and let app.js's 1s
 *  UI ticker advance it locally. HT and "Pens" pass through untouched. */
export function liveMinute(m) {
  const n = parseInt(m.minute);
  if (m.status !== "live" || !Number.isFinite(n)) return m.minute || "LIVE";
  // Stoppage time (e.g. "90+3'") is authoritative from the worker — show it verbatim
  // and don't local-tick it (we can't know how much added time there'll be). Local
  // ticking only fills in normal play, where it holds at 45'/90' until the worker
  // takes over with the added-time value.
  if (String(m.minute).includes("+")) return m.minute;
  return `<span data-livemin="${n}" data-anchor="${state.snap?.meta?.updated || ""}">${n}'</span>`;
}

// ── status helpers ──
// "out" = currently below the qualification cut but still mathematically alive;
// "eliminated" = actually out. Keep these visibly distinct (label + colour).
export const STATUS_LABEL = {
  qualified: "Qualified", in: "In", sweating: "Sweating", out: "Below cut", eliminated: "Out",
};
export function statusChip(status, withDot = true) {
  const lbl = STATUS_LABEL[status] || status;
  return `<span class="chip st-${status}">${withDot ? '<span class="d"></span>' : ""}${lbl}</span>`;
}

// ── time helpers ──
export function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
export function fmtDay(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}
export function countdown(iso) {
  if (!iso) return "";
  const ms = new Date(iso) - Date.now();
  if (ms <= 0) return "now";
  const h = Math.floor(ms / 3.6e6), m = Math.floor((ms % 3.6e6) / 6e4);
  const d = Math.floor(h / 24);
  if (d >= 1) return `${d}d ${h % 24}h ${m}m`;
  if (h >= 1) return `${h}h ${m}m`;
  return `${m}m`;
}

export function gd(n) { return n > 0 ? `+${n}` : `${n}`; }

export function timeAgo(iso) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (isNaN(ms)) return "";
  const m = Math.floor(ms / 6e4), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  return `${d}d ago`;
}
