// Client-side mirrors of the engine's Candid shapes (see idl.ts and
// ../../backend/src/types.mo), as they actually decode: a `Seat` is
// `{p1: null}`, not `"p1"`; `tag()`/`val()` in render.ts unwrap them.
// Only `S` (a game's State) and the opaque `Action` are game-supplied.

import type { IDL } from "@icp-sdk/core/candid";
import type { Principal } from "@icp-sdk/core/principal";

export type SeatTag = "p1" | "p2";

export type Seat = { p1: null } | { p2: null };

export type Mode = { simultaneous: null } | { alternating: null };

export type Verdict = { p1Wins: null } | { p2Wins: null } | { draw: null };

export type End = { finished: Verdict } | { aborted: Seat } | { claimed: Seat };

export type EngineErr =
  | { seatTaken: null }
  | { notSeated: null }
  | { alreadySubmitted: null }
  | { notYourTurn: null }
  | { illegalMove: string }
  | { wrongPhase: string }
  | { reserved: { secondsLeft: bigint } }
  | { notIdle: { secondsLeft: bigint } }
  | { notOverdue: { secondsLeft: bigint } }
  // Stale `gen`/`turn` — refetch `status` instead of surfacing it.
  | { stale: null }
  | { noSuchTable: null }
  | { badCode: null }
  | { unauthorized: null };

/// Sequential, never reused.
export type TableId = bigint;

/// A `code` table's code is never part of a listing, only echoed back to
/// its own occupant (`StagingYouView.visibility`).
export type Visibility = { open: null } | { code: string };

export interface TableSummary {
  id: TableId;
  p1Open: boolean;
  p2Open: boolean;
  /// Occupant of a NOT-open seat, in Candid `opt` array shape.
  p1Session: [] | [string];
  p2Session: [] | [string];
  protected: boolean;
  waitingSecs: bigint;
  /// Opaque rules variant; "" for a game without variants.
  variant: string;
}

export interface BrowsingStatus {
  tables: TableSummary[];
}

export interface AtTableStatus<S = unknown> {
  id: TableId;
  view: View<S>;
}

/// What `status(sid)` returns and every `#view` push carries.
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
  gen: bigint;
  visibility: Visibility;
}

export interface AwaitingRematchView {
  openSeat: Seat;
  gen: bigint;
}

export interface InGameView<S = unknown> {
  seat: Seat;
  game: S;
  turn: bigint;
  mode: Mode;
  /// `#simultaneous`: locked in this round. `#alternating`: on turn.
  /// Either way the waiting seat is `youSubmitted && !oppSubmitted`.
  youSubmitted: boolean;
  oppSubmitted: boolean;
  gen: bigint;
  /// Countdowns are as fresh as the last push; app.ts ticks them locally.
  secondsUntilIdleReset: bigint;
  idleTimeoutSecs: bigint;
  claimWinAvailable: boolean;
  secondsUntilClaimable: bigint;
  claimTimeoutSecs: bigint;
}

export interface DebriefView<S = unknown> {
  seat: Seat;
  end: End;
  turns: bigint;
  finalGame: S;
  gen: bigint;
}

export type View<S = unknown> =
  | { lobby: LobbyView }
  | { busy: BusyView }
  | { stagingYou: StagingYouView }
  | { awaitingRematch: AwaitingRematchView }
  | { inGame: InGameView<S> }
  | { debrief: DebriefView<S> }
  | { endedByOther: null };

/// Mirrors `Leaderboard.Entry`. Boards sort highest-first; a game with a
/// lower-is-better metric converts on the backend and inverts in
/// `GamePlugin.formatScore`.
export interface LeaderboardEntry {
  player: string;
  score: bigint;
  updatedAt: bigint;
}

/// One of a bot's ways of playing with its rating; `elo` is `[]` only when
/// the host wires no leaderboard.
export interface BotComplexity {
  complexity: string;
  elo: [] | [bigint];
}

/// Mirrors `CanisterPlayers.BotEntry`. `complexities` is never empty and
/// keeps the bot's declared order.
export interface BotInfo {
  principal: Principal;
  name: string;
  complexities: BotComplexity[];
}

/// See ../README.md, "The GamePlugin contract".
export interface GamePlugin<S = unknown> {
  idlTypes(args: { IDL: typeof IDL }): { Action: IDL.Type; State: IDL.Type };
  seatLabel(seat: SeatTag): string;
  /// Optional: renders a leaderboard `score`. Default is the plain
  /// integer; a game storing a converted score inverts it here.
  formatScore?(score: bigint): string;
  /// `yourTurn` is true while `mySeat` may move, false while waiting,
  /// undefined for a debrief — for a game whose interaction lives on the
  /// board itself.
  renderBoard(gameState: S, mySeat: SeatTag, oppSeat: SeatTag, yourTurn?: boolean): string;
  /// Called only while `mySeat` may move. May return "".
  renderActions(gameState: S, mySeat: SeatTag): string;
  /// Optional: the board as it will look once `move` lands, drawn while
  /// the submit is in flight; null draws the board as it is. Display only,
  /// never sent anywhere. See `withLocalMove` in client.ts.
  applyLocal?(gameState: S, mySeat: SeatTag, move: unknown): S | null;
  /// Optional: rules variants; the first is the default, each `key` is
  /// what the backend's `Spec.init(variant)` receives.
  variantChoices?(): { key: string; label: string }[];
  /// Optional: a stored variant key -> display text.
  formatVariant?(variant: string): string;
}

/// Mirrors `Transport.Request<M>`. `submit`/`leave`/`reset`/`claimWin` carry the
/// last-seen `gen` (and `turn`); a stale value is rejected as `#stale`.
export type WsRequest<A = unknown> =
  | { createTable: { seat: Seat; visibility: Visibility; variant: string } }
  | { joinTable: { id: TableId; seat: Seat; code: [] | [string] } }
  | { submit: { gen: bigint; turn: bigint; move: A } }
  | { rematch: null }
  | { leave: { gen: bigint } }
  | { reset: { gen: bigint } }
  | { claimWin: { gen: bigint } }
  | { ackEnded: null }
  | { status: null }
  | { bye: null };

export type WsPayload<S = unknown> = { view: Status<S> } | { err: EngineErr };

/// The WebSocket-like surface `start()` requires. `request()` is optional;
/// when present (`DuelTransport`), `start()` settles each call off its own
/// reply. `send()` must accept a message at any time (the client asks for
/// its first status at construction); `onopen` fires on every confirmed
/// (re)link, and a relink makes the client ask again. `onconnecting`
/// (optional) fires when the link is lost and being redone; `onclose`
/// only when it is over for good. `queryStatus()` (optional) answers a
/// status without the link, for a first paint.
export interface DuelWs<S = unknown, A = unknown> {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: WsPayload<S> }) => void) | null;
  onerror: ((ev: { error?: Error }) => void) | null;
  onclose: (() => void) | null;
  onconnecting?: (() => void) | null;
  send(msg: { req: { sid: string; req: WsRequest<A> } }): void;
  request?(sid: string, req: WsRequest<A>): Promise<WsPayload<S>>;
  queryStatus?(sid: string): Promise<Status<S>>;
}
