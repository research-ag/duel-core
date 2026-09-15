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

/// A seat tag on its own, as it appears once `tag()` has unwrapped a
/// `Seat` variant — what `GamePlugin.seatLabel`/`renderBoard`/
/// `renderActions` actually receive.
export type SeatTag = "p1" | "p2";

export type Seat = { p1: null } | { p2: null };

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

/// `open` tables are discoverable via a `browsing` status; a `code`
/// table is never listed — reachable only by its `TableId` AND its
/// code, both shared with a friend out of band.
export type Visibility = { open: null } | { code: string };

export interface TableSummary {
  id: TableId;
  p1Open: boolean;
  p2Open: boolean;
  waitingSecs: bigint;
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
  renderBoard(gameState: S, mySeat: SeatTag, oppSeat: SeatTag): string;
  renderActions(gameState: S, mySeat: SeatTag): string;
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
  | { createTable: { seat: Seat; visibility: Visibility } }
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
