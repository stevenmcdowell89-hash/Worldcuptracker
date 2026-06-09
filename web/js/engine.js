// WC26 progression engine — THE USP.
//
// Pure, dependency-free ES module. Runs in the browser (Pages) AND is bundled into
// the Worker at build time (single source of truth). No API calls, ever — it
// operates only on the KV snapshot + a set of hypothetical results.
//
// 2026 format (hardcoded on purpose): 12 groups of 4. Top 2 of every group go
// through (24 teams). The best 8 of the 12 third-placed teams fill the rest → 32.
//
// ── Third-place ranking order (brief §5.1, exact) ──
//   points → goal difference → goals scored → fewer disciplinary points (fair play)
//          → drawing of lots.
// We model disciplinary points as yellow*1 + red*3 (lower is better). "Drawing of
// lots" is made deterministic by falling back to alphabetical code so the UI never
// shows a random/unstable order.
//
// ── What is exact vs approximate ──
//   resolve(): EXACT. Given concrete scorelines for the remaining fixtures it
//     recomputes tables, re-sorts and re-ranks deterministically. This powers the
//     interactive scenario board (the signature moving-cut-line interaction).
//   verdicts(): a transparent best/worst-case bound (not probabilities, per §5.3).
//     It projects each contender's own remaining games to extremes (±5 goal swing
//     to dominate GD/GF tiebreaks) and compares pairwise against rivals' extremes.
//     Documented approximations: it does not model a third-placed team climbing to
//     2nd / dropping to 4th inside its own group, nor group head-to-head tiebreaks.
//     For an exact answer to any specific question, set the scoreline on the board.

export const GROUP_LETTERS = ["A","B","C","D","E","F","G","H","I","J","K","L"];
export const QUALIFY_COUNT = 8;          // best 8 of 12 thirds advance
const BIG = 5;                           // goal swing used for best/worst bounds

// ── disciplinary (fair-play) points: lower is better ──
export function discPoints(row) {
  return (row.yellow || 0) * 1 + (row.red || 0) * 3;
}

// ── group sort: Pts → GD → GF → fewer disc → code (lots) ──
export function compareGroupRows(a, b) {
  if (b.Pts !== a.Pts) return b.Pts - a.Pts;
  if (b.GD !== a.GD) return b.GD - a.GD;
  if (b.GF !== a.GF) return b.GF - a.GF;
  const da = discPoints(a), db = discPoints(b);
  if (da !== db) return da - db;          // fewer disciplinary points ranks higher
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}

// ── third-place sort: Pts → GD → GF → fewer disc → code (lots) ──
export function compareThird(a, b) {
  if (b.Pts !== a.Pts) return b.Pts - a.Pts;
  if (b.GD !== a.GD) return b.GD - a.GD;
  if (b.GF !== a.GF) return b.GF - a.GF;
  if (a.disc !== b.disc) return a.disc - b.disc;
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}

function cloneGroups(groups) {
  const out = {};
  for (const g of Object.keys(groups)) out[g] = groups[g].map((r) => ({ ...r }));
  return out;
}

/** Build a Result {id,home,away,hg,ag,exact} from a W/D/L outcome with a default
 *  margin. W/D/L results are "likely" (exact:false); a set scoreline is exact. */
export function resultFromWDL(fixture, outcome) {
  const map = { W: [1, 0], D: [1, 1], L: [0, 1] };
  const [hg, ag] = map[outcome] || [0, 0];
  return { id: fixture.id, home: fixture.home, away: fixture.away, hg, ag, exact: false };
}

/** Apply one result to a (cloned) group table, mutating the two team rows. */
function applyResult(tables, res) {
  for (const g of Object.keys(tables)) {
    const rows = tables[g];
    const h = rows.find((r) => r.code === res.home);
    const a = rows.find((r) => r.code === res.away);
    if (!h || !a) continue;               // result belongs to a different group
    h.P += 1; a.P += 1;
    h.GF += res.hg; h.GA += res.ag;
    a.GF += res.ag; a.GA += res.hg;
    h.GD = h.GF - h.GA; a.GD = a.GF - a.GA;
    if (res.hg > res.ag) { h.W += 1; h.Pts += 3; a.L += 1; }
    else if (res.hg < res.ag) { a.W += 1; a.Pts += 3; h.L += 1; }
    else { h.D += 1; a.D += 1; h.Pts += 1; a.Pts += 1; }
    return;
  }
}

/** Recompute and re-sort all group tables after applying `results`. */
export function recompute(snapshot, results = []) {
  const tables = cloneGroups(snapshot.groups);
  for (const res of results) applyResult(tables, res);
  for (const g of Object.keys(tables)) tables[g].sort(compareGroupRows);
  return tables;
}

/** From sorted group tables, build the ranked 12-team third-place table. */
export function thirdPlaceTable(tables) {
  const thirds = [];
  for (const g of GROUP_LETTERS) {
    const rows = tables[g];
    if (!rows || rows.length < 3) continue;
    const t = rows[2];                    // 3rd-placed team (tables are pre-sorted)
    thirds.push({
      code: t.code, group: g,
      Pts: t.Pts, GD: t.GD, GF: t.GF, disc: discPoints(t),
    });
  }
  thirds.sort(compareThird);
  thirds.forEach((t, i) => (t.rank = i + 1));
  return thirds;
}

/** The 8 third-placed codes that advance, given a ranked third-place table. */
export function qualifiersFrom(thirdTable) {
  return thirdTable.slice(0, QUALIFY_COUNT).map((t) => t.code);
}

/** Annex C: map the set of 8 qualifying groups → R32 slot per group letter. */
export function annexCSlots(qualifyingGroups, annexC) {
  if (!annexC) return {};
  const key = [...qualifyingGroups].sort().join("");
  const entry = annexC.combinations ? annexC.combinations[key] : annexC[key];
  return entry || {};
}

/**
 * resolve() — EXACT. The core scenario function (brief §5.2).
 * @param {Snapshot} snapshot
 * @param {Result[]} results  concrete results for some/all remaining fixtures
 * @param {object}   annexC   loaded annexC.json (optional)
 */
export function resolve(snapshot, results = [], annexC = null) {
  const groupTables = recompute(snapshot, results);
  const third = thirdPlaceTable(groupTables);
  const qualifiers = qualifiersFrom(third);
  const groups = third.slice(0, QUALIFY_COUNT).map((t) => t.group);
  return {
    groupTables,
    thirdPlaceTable: third,
    qualifiers,
    annexCSlots: annexCSlots(groups, annexC),
  };
}

// ── verdicts ──────────────────────────────────────────────────────────────────

function thirdLineFor(snapshot, code) {
  for (const g of GROUP_LETTERS) {
    const row = (snapshot.groups[g] || []).find((r) => r.code === code);
    if (row) return { code, group: g, Pts: row.Pts, GD: row.GD, GF: row.GF, disc: discPoints(row) };
  }
  return null;
}

function remainingCountFor(snapshot, code) {
  return snapshot.remainingFixtures.filter((f) => f.home === code || f.away === code).length;
}

const project = {
  win:  (l, n) => ({ ...l, Pts: l.Pts + 3 * n, GD: l.GD + BIG * n, GF: l.GF + BIG * n }),
  draw: (l, n) => ({ ...l, Pts: l.Pts + 1 * n }),
  loss: (l, n) => ({ ...l, GD: l.GD - BIG * n }),
};

function rankAmong(line, others) {
  // 1 + number of `others` that rank strictly above `line`
  let above = 0;
  for (const o of others) if (compareThird(o, line) < 0) above += 1;
  return above + 1;
}

/**
 * verdicts() — best/worst-case bounds → one of the 5 states per contender.
 * Returns the 12 third-placed teams ranked, each tagged:
 *   qualified | in | sweating | out | eliminated   (brief §5.3)
 */
export function verdicts(snapshot) {
  const contenders = GROUP_LETTERS
    .map((g) => {
      const rows = snapshot.groups[g];
      return rows && rows.length >= 3 ? { ...thirdLineFor(snapshot, rows.slice().sort(compareGroupRows)[2].code) } : null;
    })
    .filter(Boolean);

  // current + extreme projections, keyed by code
  const rem = {}, cur = {}, best = {}, worst = {};
  for (const c of contenders) {
    const n = remainingCountFor(snapshot, c.code);
    rem[c.code] = n;
    cur[c.code] = { ...c };
    best[c.code] = project.win(c, n);
    worst[c.code] = project.loss(c, n);
  }

  const out = contenders.map((c) => {
    const others = contenders.filter((o) => o.code !== c.code);
    const rivalsNow = others.map((o) => cur[o.code]);
    const curRank = rankAmong(cur[c.code], rivalsNow);
    // best rank: us at best, rivals at worst (fewest rivals above us)
    const bestRank = rankAmong(best[c.code], others.map((o) => worst[o.code]));
    // worst rank: us at worst, rivals at best (most rivals above us)
    const worstRank = rankAmong(worst[c.code], others.map((o) => best[o.code]));
    // own next result against static rivals — the fragility signal for in/sweating/out
    const winRank = rankAmong(best[c.code], rivalsNow);
    const loseRank = rankAmong(worst[c.code], rivalsNow);

    let status;
    if (worstRank <= QUALIFY_COUNT) status = "qualified";        // safe in every outcome
    else if (bestRank > QUALIFY_COUNT) status = "eliminated";    // gone in every outcome
    else if (curRank <= QUALIFY_COUNT && loseRank <= QUALIFY_COUNT) status = "in";   // holds even on a bad day
    else if (curRank <= QUALIFY_COUNT) status = "sweating";      // in now, a slip drops them
    else if (winRank <= QUALIFY_COUNT) status = "sweating";      // out now, a result lifts them
    else status = "out";                                         // alive but need help elsewhere

    return {
      code: c.code, group: c.group, Pts: c.Pts, GD: c.GD, GF: c.GF, disc: c.disc,
      rank: 0, status, bestRank, worstRank, curRank,
    };
  });

  out.sort(compareThird);
  out.forEach((t, i) => (t.rank = i + 1));
  return out;
}

// ── plain English (brief §5.5) ──────────────────────────────────────────────────

const NAME = (snapshot, code) =>
  (snapshot.teams && snapshot.teams[code] && snapshot.teams[code].name) || code;

/** Build a full result set: T's own next fixture set to `outcome`, every other
 *  remaining fixture defaulted to a draw (the neutral "as it stands" baseline). */
function scenarioFor(snapshot, fixture, outcome) {
  const results = [];
  const own = resultFromWDL(fixture, fixture.home === fixture._teamHome ? outcome : outcome);
  // outcome is from the contender's perspective; flip if contender is the away side
  if (fixture._asAway) {
    const flip = { W: "L", D: "D", L: "W" }[outcome];
    results.push(resultFromWDL(fixture, flip));
  } else {
    results.push(resultFromWDL(fixture, outcome));
  }
  for (const f of snapshot.remainingFixtures) {
    if (f.id === fixture.id) continue;
    results.push(resultFromWDL(f, "D"));
  }
  return results;
}

function qualifiesWith(snapshot, fixture, outcome, annexC) {
  const code = fixture._contender;
  const results = scenarioFor(snapshot, fixture, outcome);
  const tables = recompute(snapshot, results);
  // direct qualification: finish top-2 of the group
  for (const g of GROUP_LETTERS) {
    const idx = tables[g].findIndex((r) => r.code === code);
    if (idx === 0 || idx === 1) return true;
    if (idx >= 0) break;
  }
  return qualifiersFrom(thirdPlaceTable(tables)).includes(code);
}

/**
 * plainEnglish() — a single human sentence for one contender (brief §5.5).
 * Tests the contender's own next result (W/D/L) against everyone else drawing.
 */
export function plainEnglish(snapshot, code, annexC = null) {
  const name = NAME(snapshot, code);
  const fx = snapshot.remainingFixtures.find((f) => f.home === code || f.away === code);
  const v = verdicts(snapshot).find((t) => t.code === code);

  if (!fx) {
    if (!v) return `${name} are not in the third-place race.`;
    if (v.status === "qualified") return `${name} are through — nothing left to play.`;
    if (v.status === "eliminated") return `${name} are out.`;
    return `${name} have finished their group and must wait on other results.`;
  }

  const opp = fx.home === code ? fx.away : fx.home;
  const oppName = NAME(snapshot, opp);
  const ctx = { ...fx, _contender: code, _asAway: fx.away === code };

  const win = qualifiesWith(snapshot, ctx, "W", annexC);
  const draw = qualifiesWith(snapshot, ctx, "D", annexC);
  const loss = qualifiesWith(snapshot, ctx, "L", annexC);

  if (win && draw && loss) return `${name} are already through whatever happens against ${oppName}.`;
  if (win && draw && !loss) return `${name} go through with a draw against ${oppName}; defeat could send them home.`;
  if (win && !draw && !loss) return `${name} must beat ${oppName} to go through.`;
  if (!win && !draw && !loss) return `${name} are out — even beating ${oppName} would not be enough on these results.`;
  if (win && !draw && loss) return `${name} control their fate against ${oppName}, but it is tight on goal difference.`;
  if (!win && draw && loss) return `${name} are better off not winning — an odd one, watch the goal-difference swing.`;
  return `${name}: result against ${oppName} is decisive — every outcome changes the picture.`;
}

export default { resolve, verdicts, plainEnglish, recompute, thirdPlaceTable, qualifiersFrom, annexCSlots, resultFromWDL, GROUP_LETTERS, QUALIFY_COUNT };
