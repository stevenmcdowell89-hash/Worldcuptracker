// Digest composition — the SINGLE source for "last night's results" and "today's
// matches", surfaced two ways: the morning/midday PUSH digests (worker) and the
// in-app MORNING VIEW (web). Pure and snapshot-only so both sides can't drift
// (brief feature 2: "one source, two surfaces").

/** Finished matches in the overnight catch-up window (default 16h back from `nowMs`),
 *  oldest-first. The same window the ~8am results push uses. */
export function overnightFinished(snap, nowMs = Date.now(), windowH = 16) {
  const since = nowMs - windowH * 3600e3;
  return (snap.matches || [])
    .filter((m) => m.status === "ft" && m.kickoff && Date.parse(m.kickoff) >= since)
    .sort((a, b) => (a.kickoff || "").localeCompare(b.kickoff || ""));
}

/** Every match on a given UK calendar date (`ymd` = "YYYY-MM-DD"), kickoff order.
 *  The morning view shows the full slate (any status); the push filters to scheduled. */
export function matchesOn(snap, ymd) {
  return (snap.matches || [])
    .filter((m) => (m.kickoff || "").slice(0, 10) === ymd)
    .sort((a, b) => (a.kickoff || "").localeCompare(b.kickoff || ""));
}

/** Compact one-line results string for the push digest, e.g. "ENG 2-1 SEN · …". */
export function resultsLine(matches, limit = 8) {
  if (!matches.length) return null;
  return matches.slice(0, limit).map((m) => `${m.home.code} ${m.home.score}-${m.away.score} ${m.away.code}`).join(" · ");
}

/** Compact one-line fixtures string for the push digest, e.g. "ENG v USA · …". */
export function fixturesLine(matches, limit = 8) {
  if (!matches.length) return null;
  return matches.slice(0, limit).map((m) => `${m.home.code} v ${m.away.code}`).join(" · ");
}
