// Shared domain types for the generic session engine's client — mirror
// the TwoPlayer engine's own Candid shapes (see idl.ts's
// buildEngineTypes and ../../backend/src/lib.mo). Every type here except
// a seat tag's own two literals and the generic `S` (a game's own State
// shape) is fixed by the engine; a game only ever supplies `S` (and its
// own `Action` type, opaque to this package — see `GamePlugin.idlTypes`).
//
// These are the JS shapes Candid variants/records actually decode to
// (e.g. a `Seat` is `{p1: null}`, not the string `"p1"`) — `tag()`/
// `val()` in render.ts are what turn one into the other.

import type { IDL } from "@icp-sdk/core/candid";
import type { Principal } from "@icp-sdk/core/principal";

/// A seat tag on its own, as it appears once `tag()` has unwrapped a
/// `Seat` variant — what `GamePlugin.seatLabel`/`renderBoard`/
/// `renderActions` actually receive.
export type SeatTag = "p1" | "p2";

export type Seat = { p1: null } | { p2: null };

/// Whether a table resolves a round from both seats at once
/// (`#simultaneous`) or one seat at a time, in turn (`#alternating`) —
/// see `InGameView.mode`'s own doc.
export type Mode = { simultaneous: null } | { alternating: null };

export type Verdict = { p1Wins: null } | { p2Wins: null } | { draw: null };

/// `claimed`: this seat claimed the win because the opponent's move sat
/// pending past the table's own claim-win window — see
/// `InGameView.claimWinAvailable`'s own doc.
export type End = { finished: Verdict } | { aborted: Seat } | { claimed: Seat };

/// Every engine-level `Err` variant (see errText() in render.ts) — never
/// a game's own `illegalMove` reason text, which the engine already
/// returns as free text from the game's own `validate`.
export type EngineErr =
  | { seatTaken: null }
  | { notSeated: null }
  | { alreadySubmitted: null }
  // A `submit` on a `#alternating` table from the seat NOT currently on
  // turn — see lib.mo's `Table.toMove` doc. Never produced for a
  // `#simultaneous` table.
  | { notYourTurn: null }
  | { illegalMove: string }
  | { wrongPhase: string }
  | { reserved: { secondsLeft: bigint } }
  | { notIdle: { secondsLeft: bigint } }
  // A `claimWin` sent before the opponent's move has sat pending long
  // enough — see lib.mo's `Table.claimWin` doc.
  | { notOverdue: { secondsLeft: bigint } }
  // A `submit`/`leave`/`reset` carried a `gen` (or, for `submit`, `turn`)
  // that no longer matches the table's current one — see lib.mo's
  // `Table.gen` doc. Handled the same way as `alreadySubmitted` (see
  // gateway-client.ts's `_isRetryAmbiguousError`): refetch `status`
  // instead of surfacing this as a failure.
  | { stale: null }
  // `joinTable` named a `TableId` no table in the registry currently
  // holds — never existed, or already garbage-collected.
  | { noSuchTable: null }
  // `joinTable` targeted a code-protected table with a missing or
  // wrong code.
  | { badCode: null }
  // The request's `sid` claimed the reserved principal-bound namespace
  // (see `identity.ts`'s `sidForPrincipal`) but didn't match the caller's
  // own authenticated principal — see `ws.mo`'s `onMessage` guard. Never
  // produced for a plain, non-`"ii:"` sid.
  | { unauthorized: null };

/// A table's numeric id — assigned sequentially, never reused even once
/// a table is garbage-collected (see registry.mo's `Registry`).
export type TableId = bigint;

/// Both `open` and `code` tables are discoverable via a `browsing`
/// status (see `TableSummary.protected`) — a `code` table's own code is
/// never part of that listing though, only ever echoed back to its own
/// occupant (see `StagingYouView.visibility`); joining one needs the code
/// itself, shared with a friend out of band.
export type Visibility = { open: null } | { code: string };

export interface TableSummary {
  id: TableId;
  p1Open: boolean;
  p2Open: boolean;
  /// Whichever session currently holds a NOT-open seat — `[]` for an
  /// open seat, or for a seat with nobody in particular to name (an
  /// idle-reclaimable board reports both seats open instead — see
  /// registry.mo's `Registry.openness` doc). Lets a browsing visitor see
  /// who they'd be facing before joining. The Candid `opt text` array
  /// shape (`[] | [string]`), not a bare `null` — same convention as
  /// every other `opt` field this package's IDL declares (e.g.
  /// `WsRequest.joinTable.code`); a plain `null` here doesn't decode from
  /// nor encode into `IDL.Opt(IDL.Text)` at all.
  p1Session: [] | [string];
  p2Session: [] | [string];
  /// Whether this table needs an access code to join — never the code
  /// itself, which stays known only to the table's own occupant (see
  /// `StagingYouView.visibility`).
  protected: boolean;
  waitingSecs: bigint;
  /// This table's own rules variant, set once by its creator and never
  /// inspected by the engine — opaque text a game interprets however it
  /// likes inside its own backend `init`. `""` for a game with no modes
  /// of its own. `render.ts`'s `renderBrowsing` shows this via
  /// `GamePlugin.formatVariant`, if the plugin supplies one; a plugin
  /// that supplies neither `variantChoices` nor `formatVariant` shows no
  /// variant text at all.
  variant: string;
}

export interface BrowsingStatus {
  tables: TableSummary[];
}

export interface AtTableStatus<S = unknown> {
  id: TableId;
  view: View<S>;
}

/// The per-caller lobby-scoped screen — either browsing the open-table
/// list, or seated/staged/playing/debriefing at a specific table (`view`
/// is exactly the same per-table `View<S>` below, just labeled with
/// which table it's about). What `status(sid)` returns, and what every
/// `#view` push carries. Mirrors `TP.SessionStatus<S>` on the backend.
export type Status<S = unknown> = { browsing: BrowsingStatus } | { atTable: AtTableStatus<S> };

export interface LobbyView {
  p1Open: boolean;
  p2Open: boolean;
  resetAvailable: boolean;
}

export interface BusyView {
  secondsUntilTakeover: bigint;
}

export interface StagingYouView {
  seat: Seat;
  reservedForPartner: boolean;
  secondsUntilReclaimable: bigint;
  /// Stamp onto a later `leave`/`reset` — see lib.mo's `Table.gen` doc.
  gen: bigint;
  /// This table's own visibility — a `#code` table's own access code
  /// included, since the whole point of "Protected" is for its creator
  /// to be able to share table # + code with a friend. Only ever present
  /// on YOUR OWN staging: nobody else's `View` carries another table's
  /// code (see render.ts's `renderStagingYou`).
  visibility: Visibility;
}

export interface AwaitingRematchView {
  openSeat: Seat;
  /// Stamp onto a later `leave` to decline — see lib.mo's `Table.gen` doc.
  gen: bigint;
}

export interface InGameView<S = unknown> {
  seat: Seat;
  game: S;
  turn: bigint;
  /// This table's own mode, constant for its lifetime — lets `render.ts`
  /// show turn-accurate copy ("Your turn" vs "Opponent has locked in")
  /// without a separate lookup.
  mode: Mode;
  /// `#simultaneous`: whether you/the opponent has locked in a move THIS
  /// round. `#alternating`: whether it's currently on you/the opponent
  /// to move (exactly one of the two is true at any time). Either way,
  /// "you're the WAITING seat" — the one who may `claimWin` — is
  /// precisely `youSubmitted && !oppSubmitted`, so `claimWinAvailable`
  /// below needs no mode-specific formula of its own.
  youSubmitted: boolean;
  oppSubmitted: boolean;
  /// Stamp onto a later `submit`/`leave`/`reset`.
  gen: bigint;
  /// Raw countdown to the idle sweep, as of this push — only as fresh as
  /// the last push landed (see ws.mo's `sweepAndPush` doc: nothing pushes
  /// on a bare tick of the clock), so render.ts ticks it down locally on
  /// the browser's own wall clock between pushes rather than showing it
  /// frozen.
  secondsUntilIdleReset: bigint;
  /// The table's own configured idle timeout, in whole seconds — constant
  /// for the table's lifetime. Lets the UI derive its own warning
  /// threshold instead of a game hardcoding a copy of this number.
  idleTimeoutSecs: bigint;
  /// Whether you may claim the win right now: you've submitted this
  /// round's move, your opponent hasn't, and the table's own
  /// `claimTimeoutNs` has elapsed since — already fully decided by the
  /// engine (see lib.mo's `Table.claimWin` doc), never derived here from
  /// the other fields.
  claimWinAvailable: boolean;
  /// Countdown to `claimWinAvailable` turning true — meaningful only
  /// while `youSubmitted` and not `oppSubmitted`; ticks down the same way
  /// `secondsUntilIdleReset` does.
  secondsUntilClaimable: bigint;
  /// This table's own configured claim-win window, in whole seconds —
  /// constant for the table's lifetime, mirroring `idleTimeoutSecs`.
  claimTimeoutSecs: bigint;
}

export interface DebriefView<S = unknown> {
  seat: Seat;
  end: End;
  turns: bigint;
  finalGame: S;
  /// Stamp onto a later `leave`/`reset`.
  gen: bigint;
}

/// The per-caller status view — already encodes which screen to show
/// (see render.ts's `renderView`, a straight switch on this tag). `S` is
/// a game's own State shape, opaque to everything but a `GamePlugin`.
export type View<S = unknown> =
  | { lobby: LobbyView }
  | { busy: BusyView }
  | { stagingYou: StagingYouView }
  | { awaitingRematch: AwaitingRematchView }
  | { inGame: InGameView<S> }
  | { debrief: DebriefView<S> }
  | { endedByOther: null };

/// One player's entry on a `mo:duel-game-core/leaderboard` `Board` —
/// mirrors that module's own `Entry` exactly. Every board this framework
/// ships sorts highest-`score`-first, always: a game whose own metric
/// runs the other way (e.g. `examples/racing`'s best lap time, lower is
/// better) converts it to a higher-is-better score on the BACKEND before
/// it's ever stored — see `GamePlugin.formatScore`'s own doc for how a
/// game converts it back for display.
export interface LeaderboardEntry {
  player: string;
  score: bigint;
  updatedAt: bigint;
}

/// One self-registered bot, as returned by `list_bots()` — mirrors
/// `mo:duel-game-core/canister_players`'s own `BotEntry` exactly. `elo` is
/// `opt int` (`[]` only when this host wires no leaderboard at all — see
/// that type's own doc); a leaderboard-backed host with a never-played
/// bot still returns `[score]` (the leaderboard's own default rating),
/// never `[]`.
export interface BotInfo {
  principal: Principal;
  name: string;
  elo: [] | [bigint];
}

/// A game's plugin contract — see ../README.md's "The GamePlugin
/// contract" section. `S` is the game's own State shape; only
/// `renderBoard`/`renderActions` ever see it, and only `idlTypes` ever
/// sees its Candid `Action` type (opaque here — never a JS shape this
/// package inspects, only forwards).
export interface GamePlugin<S = unknown> {
  /// Candid types for this game's move and state, given the same
  /// `{ IDL }` the Candid tooling passes to an idlFactory.
  idlTypes(args: { IDL: typeof IDL }): { Action: IDL.Type; State: IDL.Type };
  seatLabel(seat: SeatTag): string;
  /// Renders one `LeaderboardEntry.score` for display — the library owns
  /// the leaderboard's layout (rank, truncated player id, this string),
  /// the game owns what a score MEANS. Optional: the default (used by
  /// `renderLeaderboard` in render.ts when a plugin omits this) is just
  /// the plain integer, already correct for a game whose score IS an ELO
  /// rating with nothing to invert. A game whose backend instead stores a
  /// converted score (`examples/racing`'s best lap time, stored as
  /// `3,600,000 − lapMs` — see `../../backend/README.md`'s "Leaderboard"
  /// section) supplies the inverse here, e.g.
  /// `score => mmss(3_600_000n - score)`,
  /// so the panel reads "1:38.204", never the padded number the board
  /// actually sorts on.
  formatScore?(score: bigint): string;
  /// `yourTurn` is `true` while `mySeat` currently has a move to make
  /// (mirrors whether `renderActions` gets called this same render —
  /// see its own doc), `false` while waiting on the opponent, and
  /// `undefined` for a finished debrief's final-state render (no turn to
  /// speak of). Only present so a game whose own interaction lives ON
  /// the board itself (clickable squares, e.g.) — rather than in a
  /// separate `renderActions` panel — can gate that interactivity
  /// correctly; a plugin that keeps board and actions strictly separate
  /// (the common case, and every OTHER existing example) can ignore
  /// this parameter entirely.
  renderBoard(gameState: S, mySeat: SeatTag, oppSeat: SeatTag, yourTurn?: boolean): string;
  /// Called only while `mySeat` currently has a move to make (never
  /// while waiting on the opponent, never for a debrief) — see
  /// `renderBoard`'s own `yourTurn` doc for the mirror-image signal
  /// there. May return an empty string if a game puts all of its
  /// interaction directly on the board instead of a separate panel.
  renderActions(gameState: S, mySeat: SeatTag): string;
  /// The rules-variant choices this game offers, if any — each `key` is
  /// the raw `Text` a table creator's pick sends as `WsRequest.createTable
  /// .variant` (and, on the backend, what `Spec.init(variant)` receives).
  /// Optional: a game with no modes of its own supplies neither this nor
  /// `formatVariant`, and `renderBrowsing`'s "Start a new table" section
  /// shows no picker at all (the same as before this contract existed).
  /// When supplied, the FIRST entry is the default selection.
  variantChoices?(): { key: string; label: string }[];
  /// Turns a stored `TableSummary.variant`/`WsRequest.createTable.variant`
  /// key into display text for a browsing visitor — e.g. `"well" =>
  /// "Well"`. Optional, same as `variantChoices`; a plugin that supplies
  /// one but not the other still gets a picker/label from whichever it
  /// did supply (the other side just falls back to plain text / no
  /// picker).
  formatVariant?(variant: string): string;
}

/// The wire request shape — mirrors `Ws.Request<M>` on the backend.
/// `action` (inside `submit`) is a game's own `Action` Candid value,
/// opaque here. `submit`/`leave`/`reset` carry the `gen` (and, for
/// `submit`, `turn`) the caller last saw in a `View` — see lib.mo's
/// `Table.gen` doc for why: a stale value there is rejected as `#stale`
/// instead of being replayed against whatever match/round is current.
/// There's no separate "list tables" request — a `status` reply already
/// carries the open-table list whenever the caller isn't at a table (see
/// `Status`).
export type WsRequest<A = unknown> =
  | { createTable: { seat: Seat; visibility: Visibility; variant: string } }
  | { joinTable: { id: TableId; seat: Seat; code: [] | [string] } }
  | { submit: { gen: bigint; turn: bigint; move: A } }
  | { rematch: null }
  | { leave: { gen: bigint } }
  | { reset: { gen: bigint } }
  // Claim the win once `InGameView.claimWinAvailable` is true — purely
  // optional, never required or automatic.
  | { claimWin: { gen: bigint } }
  | { ackEnded: null }
  | { status: null };

/// What a settled call/push resolves to — either a fresh status or a
/// rejection. Never both.
export type WsPayload<S = unknown> = { view: Status<S> } | { err: EngineErr };

/// The standard WebSocket-like surface `app.ts`'s `start()` requires —
/// see app.ts's own header for what "WebSocket-like" means here and why
/// there's no fallback transport. `request()` is optional: when present
/// (`GatewayWs` always provides it), `start()` uses it to correlate a
/// call's own response instead of settling off the shared `onmessage`
/// stream — see app.ts's "Calls" section.
export interface DuelWs<S = unknown, A = unknown> {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: WsPayload<S> }) => void) | null;
  onerror: ((ev: { error?: Error }) => void) | null;
  onclose: (() => void) | null;
  send(msg: { req: { sid: string; req: WsRequest<A> } }): void;
  request?(sid: string, req: WsRequest<A>): Promise<WsPayload<S>>;
}
