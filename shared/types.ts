// Snapshot schema for WC26 Tracker (KV `latest.json`).
//
// The Worker normalises every upstream API response into ONE Snapshot object and
// writes it to KV. The frontend and the progression engine consume ONLY this.
// These types are documentation + a contract; the runtime engine is plain JS
// (web/js/engine.js) so the static site needs no build step.

export type Verdict = "qualified" | "in" | "sweating" | "out" | "eliminated";
export type GroupLetter =
  | "A" | "B" | "C" | "D" | "E" | "F"
  | "G" | "H" | "I" | "J" | "K" | "L";
export type Stage =
  | "Group Stage" | "Round of 32" | "Round of 16"
  | "Quarter-final" | "Semi-final" | "Final";
export type MatchStatus = "scheduled" | "live" | "ht" | "ft";
export type Side = "h" | "a";
/** Tournament phase, drives the §11 Matches-feed evolution + the §12 Race flash. */
export type Phase = "pre" | "group" | "groupFinal" | "knockout";
/** Stakes label for an upcoming group fixture (§15). */
export type Stakes = "decider" | "seeding" | "dead";

export interface Meta {
  stage: Stage;
  updated: string;            // ISO-8601 of the snapshot
  groupStageComplete: boolean;
  dataSource: "api-football" | "football-data" | "mock";
  stale?: boolean;            // true when serving last-good after upstream failure
  started?: boolean;          // any match played/in-play yet
  phase?: Phase;              // derived by tournamentPhase() — the phase-evolution flag
  spotsMoving?: number;       // count of "sweating" thirds — the §12 flashbar count
  squadCount?: number;        // total players across nation squads (0 ⇒ not published yet)
}

/** A row in a group table. GD is stored but always === GF - GA. */
export interface GroupRow {
  code: string;               // FIFA 3-letter code, the primary key for a team
  name: string;
  P: number; W: number; D: number; L: number;
  GF: number; GA: number; GD: number; Pts: number;
  yellow: number; red: number;   // disciplinary, for fair-play tiebreak
}

export type Groups = Record<GroupLetter, GroupRow[]>;

export interface ThirdPlaceEntry {
  code: string;
  group: GroupLetter;
  Pts: number; GD: number; GF: number;
  disc: number;               // disciplinary points (fair play), lower is better
  rank: number;               // 1..12
  status: Verdict;
}

/** A group-stage match not yet played — the engine's input space. */
export interface RemainingFixture {
  id: string;
  group: GroupLetter;
  home: string;               // team code
  away: string;               // team code
  kickoff: string;            // ISO
  affectsThird: boolean;      // surfaced on the scenario board
}

export interface MatchEvent {
  min: string;                // "12'"
  side: Side;
  type: "goal" | "owngoal" | "penalty" | "yellow" | "red" | "subst";
  player: string;
  assist?: string;
  detail?: string;
}

export interface StatRow { k: string; h: number | null; a: number | null; unit?: string; }

export interface LineupPlayer {
  num: number; name: string; pos: string;
  rating?: number;            // lands at FT only
  sub?: number;               // minute subbed off, if any
  playerId?: number;
  grid?: string;              // "4:2" row:col for the pitch
}
export interface SideLineup { formation: string; coach?: string; xi: LineupPlayer[]; subs: LineupPlayer[]; }

export interface Match {
  id: string;
  stage: Stage | "R32" | "R16" | "QF" | "SF" | "Final" | "Group Stage";
  status: MatchStatus;
  minute?: string;            // "67'" while live
  kickoff?: string;           // ISO
  venue?: string;
  group?: GroupLetter;
  home: { code: string; score: number | null };
  away: { code: string; score: number | null };
  affectsCut?: boolean;       // woven-in marker: result affects the last-8 race
  stakes?: Stakes | null;     // §15 tag on an upcoming group fixture
  progressionLine?: string;   // "as it stands, this draw sends Australia through"
  events?: MatchEvent[];
  stats?: StatRow[];
  lineups?: { h?: SideLineup; a?: SideLineup };
}

export interface BracketMatch {
  id: string;
  rd: "R32" | "R16" | "QF" | "SF" | "Final";
  slot?: string;              // e.g. "r32-1"
  a?: { code: string | null; score?: number | null; label?: string };
  b?: { code: string | null; score?: number | null; label?: string };
  next?: string;              // id of the slot the winner feeds
  thirdPlaceSlot?: GroupLetter | null;  // if a side is a 3rd-place placeholder
}
export interface Bracket {
  rounds: ("R32" | "R16" | "QF" | "SF" | "Final")[];
  matches: BracketMatch[];
}

export interface ScorerRow { playerId: number; code: string; name: string; team: string; g: number; a: number; }
export interface AssistRow { playerId: number; code: string; name: string; team: string; a: number; g: number; }
export interface DisciplineRow { code: string; team: string; y: number; r: number; }

export interface TeamForm { o: string; r: string; w: boolean | null; }
export interface Team {
  code: string; name: string; rank?: number; group: GroupLetter; coach?: string;
  P: number; W: number; D: number; L: number; GF: number; GA: number;
  possession?: number; cleanSheets?: number;
  form: TeamForm[];
  squad: number[];            // playerIds
  verdict?: Verdict;
}
export type Teams = Record<string, Team>;

export interface PlayerSeasonRow {
  comp: string; apps: number; g: number; a: number;
  yellow: number; red: number; min: number;
  shots?: number; keyPasses?: number; rating?: number;
}
export interface Player {
  name: string; code: string; pos: string; age?: number; num?: number;
  club?: string; league?: string; crest?: string;
  tournament: { apps: number; min: number; g: number; a: number; shots?: number; keyPasses?: number; yellow: number; red: number; rating?: number };
  season: PlayerSeasonRow[];
  career?: { from: string; to: string; year: number }[];   // transfers
  honours?: { title: string; year: number }[];             // trophies
}
export type Players = Record<string, Player>;

export interface ClubWatchPlayer {
  playerId: string; nation: string; pos: string; num?: number;
  nextFixture?: { opponent: string; kickoff: string };
  tournament: { apps: number; min: number; g: number; a: number; yellow: number; red: number };
  nationVerdict: Verdict;
}
export interface ClubWatchEntry {
  name: string; crest?: string;
  nextAction?: { playerId: string; nation: string; opponent: string; kickoff: string };
  players: ClubWatchPlayer[];   // empty array is valid (e.g. Cardiff City)
}
export type ClubWatch = Record<string, ClubWatchEntry>;

export interface Snapshot {
  meta: Meta;
  groups: Groups;
  thirdPlaceRace: ThirdPlaceEntry[];
  remainingFixtures: RemainingFixture[];
  matches: Match[];
  bracket: Bracket;
  scorers: ScorerRow[];
  assists: AssistRow[];
  discipline: DisciplineRow[];
  teams: Teams;
  players: Players;
  clubWatch: ClubWatch;
}

// --- Engine I/O (web/js/engine.js) ---

/** A hypothetical or actual result for a remaining fixture. */
export interface Result {
  id: string;                 // fixture id
  home: string; away: string;
  hg: number; ag: number;     // goals; engine also accepts W/D/L via helper
  exact?: boolean;            // true when user set a scoreline, false for W/D/L-only
}

export interface ResolveOutput {
  groupTables: Groups;
  thirdPlaceTable: ThirdPlaceEntry[];
  qualifiers: string[];                 // 8 codes
  annexCSlots: Record<string, string>;  // groupLetter -> R32 slot id
}

// --- Static UK TV map (web/data/tvUK.json) — channel feature (phase 3, feature 1) ---
// Not part of the snapshot: a hand-kept static file from the BBC/ITV schedules.
export interface TVChannel { channel: string; stream?: string; }   // e.g. "BBC One" / "iPlayer"
export interface TVUK {
  fixtures: Record<string, TVChannel>;   // key = group-game fixture id
  knockout: Record<string, TVChannel>;   // key = slot, e.g. "R32-M73"
}

// --- Push device record (KV "push:<sha256(endpoint)>") — phase 3, feature 3 ---
// The push subscription endpoint is the anonymous per-device key (no accounts). Prefs
// and per-match reminders ride along with it.
export interface PushReminder { kickoff: string; leadMin: number; title?: string; body?: string; sentAt?: number; }
export interface PushRecord {
  subscription: unknown;                 // the browser PushSubscription JSON
  prefs: { results: boolean; today: boolean; qual: boolean };
  reminders?: Record<string, PushReminder>;   // key = match id
  updated: number;
}
