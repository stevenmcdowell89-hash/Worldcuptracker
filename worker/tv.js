// UK TV channel mapping ("where to watch") + the automated daily refresh.
//
// API-Football does not carry the UK broadcaster, so the channel comes from the
// BBC/ITV published schedules:
//   • SEED  — web/data/tvUK.json (mirrored to web/js/tvUK.data.js for bundling),
//     parsed from the published listings at build time (`npm run gen:tvseed`).
//   • LIVE  — a daily background job (worker/index.js cron) re-fetches the same
//     published listings (TV_SOURCE_URL), re-parses, and stores them in KV
//     ("tv-listings"). Live entries override the seed, so corrections propagate
//     and knockout gaps fill in automatically as broadcasters announce splits.
//
// Matching is deliberately conservative — NEVER guess a channel (brief, feature 1):
//   • group games: both team names must match (alias-aware) on the same UK date;
//   • knockout games: round + UK date + kickoff time (±45 min) — team names are
//     usually TBC in listings until the slot resolves, but the slot's broadcast
//     assignment is known, which is exactly what we want;
//   • per-id / per-slot overrides (tvUK.json byFixture/bySlot) win over everything,
//     as the manual escape hatch. Group games key by fixture id, knockout by slot
//     (e.g. "R32-M73") since the broadcaster split is by slot/time, not team.
//
// Everything here is pure + dependency-free (node-testable); only fetchTvListings
// touches the network.

// ── UK wall-clock helpers ──
const UK_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London", hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});
function ukClock(iso) {
  const t = typeof iso === "number" ? iso : Date.parse(iso || "");
  if (!Number.isFinite(t)) return null;
  const p = Object.fromEntries(UK_FMT.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
export const ukDateOf = (iso) => ukClock(iso)?.date || null;
export const ukTimeOf = (iso) => ukClock(iso)?.time || null;

// ── team-name matching (alias-aware, accent/punctuation-proof) ──
// Listings names (BBC/ITV style) vs API-Football names don't always agree.
const ALIAS_GROUPS = [
  ["usa", "unitedstates", "us"],
  ["southkorea", "korearepublic", "korea"],
  ["ivorycoast", "cotedivoire"],
  ["czechrepublic", "czechia"],
  ["bosniaherzegovina", "bosniaandherzegovina", "bosnia"],
  ["drcongo", "congodr", "congokinshasa"],
  ["turkey", "turkiye"],
  ["capeverde", "caboverde", "capeverdeislands"],
  ["iran", "iranislamicrepublic", "irislamicrepublic"],
  ["uae", "unitedarabemirates"],
  ["saudiarabia", "ksa"],
  ["newzealand", "nz"],
];
const ALIAS = {};
for (const g of ALIAS_GROUPS) for (const n of g) ALIAS[n] = g[0];
export function normTeam(name) {
  const n = String(name || "").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")   // strip accents (Curaçao → curacao)
    .replace(/[^a-z]/g, "");                            // strip spaces/hyphens/dots
  return ALIAS[n] || n;
}
export const sameTeam = (a, b) => !!a && !!b && normTeam(a) === normTeam(b);

// ── round normalisation (listings + API-Football both → R32/R16/QF/SF/3P/F) ──
// Order matters: "Quarter-finals"/"Semi-finals"/"Third Place Final" all contain "final".
export function normRound(s) {
  const t = String(s || "").toLowerCase();
  const grp = /group\s+([a-l])\b/.exec(t);
  if (grp) return { type: "group", group: grp[1].toUpperCase() };
  if (/round of 32|1\/16/.test(t)) return { type: "ko", rd: "R32" };
  if (/round of 16|1\/8/.test(t)) return { type: "ko", rd: "R16" };
  if (/quarter/.test(t)) return { type: "ko", rd: "QF" };
  if (/semi/.test(t)) return { type: "ko", rd: "SF" };
  if (/third|3rd|play[- ]?off/.test(t)) return { type: "ko", rd: "3P" };
  if (/final/.test(t)) return { type: "ko", rd: "F" };
  if (/group/.test(t)) return { type: "group", group: null };   // "Group Stage - 2" (no letter)
  return null;
}

// ── listings parser (live-footballontv.com markup, verified 2026-06-10) ──
// <div class="fixture-date">Thursday 11th June 2026</div>
// <div class="fixture"><div class="fixture__time">20:00</div>
//   <div class="fixture__teams">Mexico v South Africa</div>
//   <div class="fixture__competition">FIFA World Cup 2026&nbsp;Group A</div>
//   <div class="fixture__channel">…<span class="channel-pill">ITV1</span>…</div></div>
const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
function parseUkDate(text) {
  const m = /(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\s+(\d{4})/i.exec(text || "");
  if (!m || !MONTHS[m[2].toLowerCase()]) return null;
  return `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, "0")}-${String(+m[1]).padStart(2, "0")}`;
}
// Linear channels we tag on the row; players/streams shown on the details screen.
const LINEAR = ["BBC One", "BBC Two", "BBC Three", "BBC Four", "ITV1", "ITV2", "ITV3", "ITV4"];
const STREAMS = ["BBC iPlayer", "ITVX"];
function pickChannel(pills) {
  const channel = pills.find((p) => LINEAR.includes(p)) || null;
  const stream = pills.find((p) => STREAMS.includes(p)) || null;
  // a stream-only broadcast still has a "channel" for the tag (e.g. ITVX exclusive)
  return { channel: channel || stream, stream };
}

export function parseListings(html, competitionRe = /world cup/i) {
  const flat = String(html || "").replace(/\s+/g, " ");
  const out = [];
  const dateParts = flat.split(/<div class="fixture-date">/).slice(1);
  for (const part of dateParts) {
    const date = parseUkDate(part.slice(0, part.indexOf("<")));
    if (!date) continue;
    const fxRe = /<div class="fixture">\s*<div class="fixture__time">([^<]*)<\/div>\s*<div class="fixture__teams">([^<]*)<\/div>\s*<div class="fixture__competition">(.*?)<\/div>\s*<div class="fixture__channel">(.*?)<\/div>\s*<\/div>\s*<\/div>/g;
    let m;
    while ((m = fxRe.exec(part))) {
      const decode = (s) => s.replace(/&nbsp;/g, " ").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim();
      const comp = decode(m[3]);
      if (!competitionRe.test(comp)) continue;
      const round = normRound(comp.replace(/.*world cup\s*\d*/i, "")) || normRound(comp);
      const teamsTxt = decode(m[2]);
      const vs = /^(.*?)\s+v\s+(.*)$/i.exec(teamsTxt);
      const pills = [...m[4].matchAll(/channel-pill[^>]*>([^<]+)</g)].map((x) => x[1].trim())
        .filter((p) => p && p.toUpperCase() !== "TBC");
      const { channel, stream } = pickChannel(pills);
      out.push({
        date, time: (m[1] || "").trim() || null,
        home: vs ? vs[1].trim() : null, away: vs ? vs[2].trim() : null,
        round: round?.type === "group" ? `Group ${round.group || "?"}` : (round?.rd || null),
        channel, stream,
      });
    }
  }
  return out;
}

// ── merge: live listings override the seed (corrections + filled gaps win) ──
// Identity = same UK date + (both team names | round+time). A live entry with no
// channel never wipes a seeded channel — absence of data is not a correction.
function listingKey(l) {
  if (l.home && l.away) return `${l.date}|${[normTeam(l.home), normTeam(l.away)].sort().join("v")}`;
  return `${l.date}|${l.round || "?"}|${l.time || "?"}`;
}
export function mergeListings(seed = [], live = []) {
  const map = new Map(seed.map((l) => [listingKey(l), l]));
  for (const l of live) {
    const k = listingKey(l);
    const prev = map.get(k);
    if (prev && !l.channel && prev.channel) continue;   // never downgrade to unknown
    map.set(k, l);
  }
  return [...map.values()];
}

// ── knockout slot assignment: official FIFA match numbers, chronological per round ──
// 2026: R32 = 73–88, R16 = 89–96, QF = 97–100, SF = 101–102, 3P = 103, F = 104.
// FIFA numbers knockout matches in kickoff order within each round, so ordering the
// API fixtures by kickoff reproduces the official numbering. Slot key: "R32-M73".
const ROUND_START = { R32: 73, R16: 89, QF: 97, SF: 101, "3P": 103, F: 104 };
export function assignKnockoutSlots(matches) {
  const byRound = {};
  for (const m of matches) {
    if (m.group) continue;                              // group games key by fixture id
    if (m._synthetic) continue;                         // seeded blank placeholder — no real match number to claim
    const r = normRound(m.stage);
    if (!r || r.type !== "ko" || !m.kickoff) continue;
    (byRound[r.rd] = byRound[r.rd] || []).push(m);
  }
  const slots = {};
  for (const [rd, list] of Object.entries(byRound)) {
    list.sort((a, b) => (a.kickoff || "").localeCompare(b.kickoff || "") || String(a.id).localeCompare(String(b.id)));
    list.forEach((m, i) => { slots[m.id] = `${rd}-M${ROUND_START[rd] + i}`; });
  }
  return slots;
}

// ── annotate the snapshot's matches with { channel, stream } ──
// Precedence: byFixture[id] → bySlot[slot] → matched listing. No match → nothing.
const minsOf = (hhmm) => { const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || ""); return m ? +m[1] * 60 + +m[2] : null; };
function findListing(m, listings, teams) {
  const uk = ukClock(m.kickoff);
  if (!uk) return null;
  const nameOf = (code) => teams?.[code]?.name || code;
  const h = nameOf(m.home?.code), a = nameOf(m.away?.code);
  // 1) both team names on the same UK date (order-insensitive) — group + resolved KO
  let hit = listings.find((l) => l.date === uk.date && l.home && l.away &&
    ((sameTeam(l.home, h) && sameTeam(l.away, a)) || (sameTeam(l.home, a) && sameTeam(l.away, h))));
  if (hit) return hit;
  // 2) knockout: round + UK date + nearest kickoff time (≤45 min) — names often TBC
  const r = m.group ? null : normRound(m.stage);
  if (r?.type === "ko") {
    const t = minsOf(uk.time);
    const cands = listings.filter((l) => l.date === uk.date && l.round === r.rd && (!l.home || !l.away));
    let best = null, bestD = 46;
    for (const l of cands) {
      const lt = minsOf(l.time);
      const d = lt == null || t == null ? 0 : Math.abs(lt - t);
      if (d < bestD) { bestD = d; best = l; }
    }
    return best;
  }
  return null;
}

export function annotateTv(matches, teams, tvData) {
  const { listings = [], byFixture = {}, bySlot = {} } = tvData || {};
  const slots = assignKnockoutSlots(matches || []);
  let mapped = 0;
  for (const m of matches || []) {
    if (slots[m.id]) m.slot = slots[m.id];
    const over = byFixture[m.id] || (m.slot && bySlot[m.slot]);
    const hit = over || findListing(m, listings, teams);
    if (hit && hit.channel) {
      m.tv = { channel: hit.channel };
      if (hit.stream) m.tv.stream = hit.stream;
      mapped++;
    } else {
      delete m.tv;                                      // never guess; show nothing
    }
  }
  return { mapped, total: (matches || []).length };
}

// ── live fetch (the daily background check) ──
export const TV_SOURCE_DEFAULT = "https://www.live-footballontv.com/live-world-cup-football-on-tv.html";
export async function fetchTvListings(env) {
  const url = (env && env.TV_SOURCE_URL) || TV_SOURCE_DEFAULT;
  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (wc26-tracker; tv-schedule check)", accept: "text/html" } });
  if (!r.ok) throw new Error(`tv listings ${r.status}`);
  const listings = parseListings(await r.text());
  if (!listings.length) throw new Error("tv listings parsed empty — markup may have changed");
  return listings;
}
