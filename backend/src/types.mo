import Map "mo:core/Map";
import PT "mo:promtracker";

module {

  public type TableId = Nat;

  public type TableVisibility = { #open; #code : Text };

  public type SessionId = Text;

  public type Seat = { #p1; #p2 };

  public func otherSeat(s : Seat) : Seat = switch (s) {
    case (#p1) #p2;
    case (#p2) #p1;
  };

  public type Verdict = { #p1Wins; #p2Wins; #draw };

  /// Candid-friendly tag reported on `View.#inGame` (a `Spec` itself,
  /// holding functions, can never be serialized).
  public type Mode = { #simultaneous; #alternating };

  public type Registry<S, M> = {
    /// Mutable so a host can re-apply them on every upgrade (a stable
    /// `Registry` skips `Registry.new`); see `Registry.setTimeouts`.
    var idleTimeoutNs : Int;
    var claimTimeoutNs : Int;
    var tables : Map.Map<TableId, Table<S, M>>;
    /// A session's current table; absent = browsing.
    var bySession : Map.Map<SessionId, TableId>;
    var tableIdNonce : TableId;
    var gamesStarted : ?PT.Counter;
    var activeGames : ?PT.Gauge;
    var roundsPerGame : ?PT.Gauge;
    var matchmakingWaitSecs : ?PT.Gauge;
  };

  public type TableSummary = {
    id : TableId;
    p1Open : Bool;
    p2Open : Bool;
    /// Occupant of a NOT-open seat, if there is someone to name.
    p1Session : ?SessionId;
    p2Session : ?SessionId;
    /// Needs an access code — never the code itself.
    protected : Bool;
    waitingSecs : Nat;
    /// Opaque rules variant set by the creator; shown to browsing visitors.
    variant : Text;
  };

  public type SessionStatus<S> = {
    #browsing : { tables : [TableSummary] };
    #atTable : { id : TableId; view : View<S> };
  };

  /// What a canister-seated player is asked with. `gen` also identifies
  /// the match (bumps on every stage, rematch included). `retryReason`
  /// is `validate`'s text on the one retry after an illegal reply.
  /// `opponent` is the raw opposing `SessionId` (stable across tables for
  /// a human, per-table for a `cp:` canister). `opponentLastMove` and
  /// `lastRoundDurationNs` describe the last RESOLVED round and are
  /// `null` when `turn == 0`. `complexity` is the way of playing this
  /// seat was seated at. See `../README.md`, "Canister players".
  public type MoveRequest<S, M> = {
    tableId : TableId;
    seat : Seat;
    game : S;
    mode : Mode;
    turn : Nat;
    gen : Nat;
    complexity : Text;
    retryReason : ?Text;
    opponent : SessionId;
    opponentLastMove : ?M;
    lastRoundDurationNs : ?Int;
  };

  /// What a game supplies: pure functions, never stored (passed on every
  /// call). `init` receives the table's opaque `variant` text and must
  /// fall back safely on anything unrecognized. `validate`: `null` =
  /// legal, `?text` = rejection. `#alternating`'s `resolve` takes the one
  /// seat on turn; the engine rejects off-turn submissions itself.
  public type Spec<S, M> = {
    #simultaneous : {
      init : (Text) -> S;
      validate : (S, Seat, M) -> ?Text;
      resolve : (S, M, M) -> { state : S; verdict : ?Verdict };
    };
    #alternating : {
      init : (Text) -> S;
      validate : (S, Seat, M) -> ?Text;
      resolve : (S, Seat, M) -> { state : S; verdict : ?Verdict };
    };
  };

  public type Staging = {
    seat : Seat;
    session : SessionId;
    reservedFor : ?SessionId; // rematch: open seat held for this partner
    since : Int;
  };

  public type Active<S, M> = {
    p1 : SessionId;
    p2 : SessionId;
    game : S;
    pending1 : ?M; // hidden from the opponent; `status` exposes Booleans only
    pending2 : ?M;
    turn : Nat;
    lastActivity : Int;
    /// Reset only on a full resolve (unlike `lastActivity`), so
    /// `now - roundStartedAt` at resolve time is the round's own length.
    roundStartedAt : Int;
    /// Each seat's move from the most recently RESOLVED round.
    lastMoveP1 : ?M;
    lastMoveP2 : ?M;
    lastRoundDurationNs : ?Int;
  };

  public type End = {
    #finished : Verdict;
    #aborted : Seat; // this seat left early
    #claimed : Seat; // this seat claimed the win after `claimTimeoutNs`
  };

  public type Debrief<S> = {
    p1 : SessionId;
    p2 : SessionId;
    end : End;
    turns : Nat;
    finalGame : S;
    since : Int;
  };

  public type Phase<S, M> = {
    #empty;
    #staging : Staging;
    #active : Active<S, M>;
    #debrief : Debrief<S>;
  };

  /// A game that vanished without both players seeing a debrief; drives
  /// `#endedByOther` until acked or pruned.
  public type Ended = {
    p1 : SessionId;
    p2 : SessionId;
    acked : [SessionId];
    since : Int;
  };

  public type Table<S, M> = {
    var idleTimeoutNs : Int;
    var claimTimeoutNs : Int;
    visibility : TableVisibility;
    createdBy : SessionId;
    /// Immutable for the table's lifetime; handed to `Spec.init`.
    variant : Text;

    var phase : Phase<S, M>;
    /// Match generation, bumped at every `stage()`. Echoed back on
    /// `submit`/`leave`/`reset`/`claimWin` so a stale replay is `#stale`.
    var gen : Nat;
    var lastEnded : [Ended];
    var debriefAcked : [SessionId];
  };

  public type Err = {
    #seatTaken;
    #notSeated;
    #alreadySubmitted;
    #notYourTurn; // `#alternating` only
    #illegalMove : Text;
    #wrongPhase : Text;
    #reserved : { secondsLeft : Nat };
    #notIdle : { secondsLeft : Nat };
    #notOverdue : { secondsLeft : Nat };
    #stale; // `gen`/`turn` no longer current — refetch `status`
    #noSuchTable;
    #badCode; // wrong/missing code, or `createTable` with `#code("")`
    #unauthorized; // `ws.mo`: sid not bound to the caller's principal
  };

  public type Res<T> = { #ok : T; #err : Err };

  public type JoinOk = {
    #staged : Seat;
    #started : Seat;
  };

  public type SubmitOk = {
    #waiting;
    #roundResolved : Nat; // next turn number
    #gameEnded : { verdict : Verdict; turns : Nat };
  };

  public type RematchOk = { #awaitingPartner; #started };

  /// Per-caller screen; a host renders these, never re-derives policy.
  public type View<S> = {
    #lobby : { p1Open : Bool; p2Open : Bool; resetAvailable : Bool };
    #busy : { secondsUntilTakeover : Nat };
    #stagingYou : {
      seat : Seat;
      reservedForPartner : Bool;
      secondsUntilReclaimable : Nat;
      gen : Nat;
      /// Includes a `#code` table's own code — only ever on the sole
      /// occupant's view of their own table.
      visibility : TableVisibility;
    };
    #awaitingRematch : { openSeat : Seat; gen : Nat };
    #inGame : {
      seat : Seat;
      game : S;
      turn : Nat;
      mode : Mode;
      /// `#simultaneous`: locked in this round. `#alternating`: on turn.
      /// Either way the waiting seat is `youSubmitted and not oppSubmitted`.
      youSubmitted : Bool;
      oppSubmitted : Bool;
      gen : Nat;
      /// Countdowns are as fresh as the last push; clients tick locally.
      secondsUntilIdleReset : Nat;
      idleTimeoutSecs : Nat;
      claimWinAvailable : Bool;
      secondsUntilClaimable : Nat;
      claimTimeoutSecs : Nat;
    };
    #debrief : {
      seat : Seat;
      end : End;
      turns : Nat;
      finalGame : S;
      gen : Nat;
    };
    #endedByOther;
  };

};
