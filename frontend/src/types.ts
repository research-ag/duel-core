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

export type End = { finished: Verdict } | { aborted: Seat };

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
  | { notIdle: { secondsLeft: bigint } };

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
}

export interface AwaitingRematchView {
  openSeat: Seat;
}

export interface InGameView<S = unknown> {
  seat: Seat;
  game: S;
  turn: bigint;
  youSubmitted: boolean;
  oppSubmitted: boolean;
}

export interface DebriefView<S = unknown> {
  seat: Seat;
  end: End;
  turns: bigint;
  finalGame: S;
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
/// opaque here.
export type WsRequest<A = unknown> =
  | { join: Seat }
  | { submit: A }
  | { rematch: null }
  | { leave: null }
  | { reset: null }
  | { ackEnded: null }
  | { status: null };

/// What a settled call/push resolves to — either a fresh view or a
/// rejection. Never both.
export type WsPayload<S = unknown> = { view: View<S> } | { err: EngineErr };

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
