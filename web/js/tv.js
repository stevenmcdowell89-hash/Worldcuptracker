// Channel — where to watch (brief feature 1). UK broadcaster lookup for a match.
//
// API-Football doesn't carry the UK broadcaster, so it comes from a static, hand-kept
// map (web/data/tvUK.json) populated from the BBC/ITV published schedules:
//   • group games  → keyed by fixture id        (tvUK.fixtures["<id>"])
//   • knockout ties → keyed by slot e.g. R32-M73 (tvUK.knockout["R32-M73"])
// because the BBC/ITV split is by slot/time, not by team.
//
// Fallback rule (strict): no mapping → return null → show nothing. Never guess a
// channel. Local kickoff time is handled elsewhere and is out of scope here.

import { state } from "./data.js";

// match.stage (the API "round" string for knockouts) → slot round code.
const ROUND_CODE = {
  "Round of 32": "R32", "Round of 16": "R16",
  "Quarter-finals": "QF", "Quarter-final": "QF",
  "Semi-finals": "SF", "Semi-final": "SF",
  "Final": "Final", "3rd Place Final": "3P", "Third-place play-off": "3P",
};

/** Slot key for a knockout match, e.g. "R32-M73", or null if not a known round. */
export function slotKey(match) {
  const code = ROUND_CODE[match?.stage];
  return code ? `${code}-M${match.id}` : null;
}

/** UK broadcaster for a match → { channel, stream? } or null (no mapping = show nothing).
 *  Group games resolve by fixture id first (brief), then fall back to team matchup
 *  (`HOME-AWAY`) — how a published BBC/ITV schedule is actually written, and stable
 *  across re-polls when opaque fixture ids change. Knockout ties resolve by slot. */
export function channelFor(match) {
  const tv = state.tvUK;
  if (!tv || !match) return null;
  if (match.group) {
    const byTeams = tv.byTeams || {};
    const h = match.home?.code, a = match.away?.code;
    return (tv.fixtures || {})[String(match.id)]
      || (h && a && (byTeams[`${h}-${a}`] || byTeams[`${a}-${h}`]))
      || null;
  }
  const key = slotKey(match);
  return key ? (tv.knockout || {})[key] || null : null;
}

/** Small inline channel tag for a match row, or "" when unmapped. `stream` adds the
 *  streaming service (iPlayer / ITVX) — used on the match-centre detail screen. */
export function tvTag(match, { stream = false } = {}) {
  const ch = channelFor(match);
  if (!ch) return "";
  const extra = stream && ch.stream ? ` · ${ch.stream}` : "";
  return `<span class="tvtag" title="UK TV">📺 ${ch.channel}${extra}</span>`;
}
