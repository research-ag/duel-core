import Map "mo:core/Map";
import PT "mo:promtracker";

import Rng "./rng";

module {

  public type TableId = Nat;

  public type TableVisibility = { #open; #code : Text };

  public type PlayerId = Text;

  public type Seat = { #p1; #p2 };

  public func otherSeat(s : Seat) : Seat = switch (s) {
    case (#p1) #p2;
    case (#p2) #p1;
  };

  public type Verdict = { #p1Wins; #p2Wins; #draw };

  /// Candid-friendly tag reported on `View.#inGame` (a `Spec` itself,
  /// holding functions, can never be serialized).
  public type Mode = { #simultaneous; #turnBased };

  /// The table's random-number generator, handed to `init`/`move`/
  /// `resolve`. See `./rng`.
  public type Rng = Rng.Rng;

  public type Registry<S, M, O> = {
    /// Mutable so a host can re-apply them on every upgrade (a stable
    /// `Registry` skips `Registry.new`); see `Registry.setTimeouts`.
    var idleTimeoutNs : Int;
    var claimTimeoutNs : Int;
    var tables : Map.Map<TableId, Table<S, M, O>>;
    var tableIdNonce : TableId;
    var gamesStarted : ?PT.Counter;
    var activeGames : ?PT.Gauge;
    var roundsPerGame : ?PT.Gauge;
    var matchmakingWaitSecs : ?PT.Gauge;
  };

  public type TableSummary<O> = {
    id : TableId;
    p1Open : Bool;
    p2Open : Bool;
    /// Occupant of a NOT-open seat, if there is someone to name.
    p1Session : ?PlayerId;
    p2Session : ?PlayerId;
    /// Needs an access code — never the code itself.
    protected : Bool;
    waitingSecs : Nat;
    /// The rules options the creator picked; shown to browsing visitors.
    options : O;
  };

  /// What a canister-seated player is asked with. `gen` also identifies
  /// the match (bumps on every stage, rematch included). `retryReason`
  /// is `validate`'s text on the one retry after an illegal reply.
  /// `opponent` is the raw opposing `PlayerId` (stable across tables for
  /// a human, per-table for a `cp:` canister). `opponentLastMove` and
  /// `lastStepDurationNs` describe the last RESOLVED step and are
  /// `null` when `step == 0`. `complexity` is the way of playing this
  /// seat was seated at. See `../README.md`, "Canister players".
  public type MoveRequest<V, M> = {
    tableId : TableId;
    seat : Seat;
    /// What this seat may see: the game's `view` of the state.
    game : V;
    mode : Mode;
    step : Nat;
    gen : Nat;
    complexity : Text;
    retryReason : ?Text;
    opponent : PlayerId;
    opponentLastMove : ?M;
    lastStepDurationNs : ?Int;
  };

  /// What a game supplies: its functions, never stored (passed on every
  /// call inside the transport's `Env`). Four types: `S` the full game
  /// state, `M` one action, `V` what one seat may see of the state, `O`
  /// the table's options (picked by its creator).
  ///   - `checkOptions(o)`: `null` = sensible, `?text` = why not; a table
  ///     with options it rejects is never opened.
  ///   - `init(o, rng)`: the fresh state for a match on a table with
  ///     options `o`.
  ///   - `view(s, seat, over)`: what `seat` may see of `s` — the full
  ///     state minus anything hidden from that seat. `over` is true once
  ///     the game has ended (a verdict, a leave or a claim), for the
  ///     debrief's final view. Every view a client or a bot receives goes
  ///     through it.
  ///   - `#turnBased`: one seat acts at a time, and the rules decide whose
  ///     turn it is — `toMove(s)` — so a turn may take several actions, an
  ///     action may grant another turn, and the order is the game's own.
  ///     `move(s, seat, m, rng)` checks and applies one action of the seat
  ///     on turn: `#err text` (the reason, shown to the player and to a
  ///     bot as `retryReason`) or `#ok` with the next state and, if the
  ///     game ended, the verdict.
  ///   - `#simultaneous`: both seats act every step. `validate(s, seat,
  ///     m)` only checks a submission (`null` = legal, `?text` = why
  ///     not); once both are in, `resolve(s, m1, m2, rng)` applies them.
  public type Spec<S, M, V, O> = {
    #turnBased : {
      checkOptions : (O) -> ?Text;
      init : (O, Rng) -> S;
      toMove : (S) -> Seat;
      move : (S, Seat, M, Rng) -> {
        #ok : { state : S; verdict : ?Verdict };
        #err : Text;
      };
      view : (S, Seat, Bool) -> V;
    };
    #simultaneous : {
      checkOptions : (O) -> ?Text;
      init : (O, Rng) -> S;
      validate : (S, Seat, M) -> ?Text;
      resolve : (S, M, M, Rng) -> { state : S; verdict : ?Verdict };
      view : (S, Seat, Bool) -> V;
    };
  };

  public type Staging = {
    seat : Seat;
    session : PlayerId;
    reservedFor : ?PlayerId; // rematch: open seat held for this partner
    since : Int;
  };

  public type Active<S, M> = {
    p1 : PlayerId;
    p2 : PlayerId;
    game : S;
    pending1 : ?M; // hidden from the opponent; `status` exposes Booleans only
    pending2 : ?M;
    /// Applied actions (`#turnBased`) or resolved rounds
    /// (`#simultaneous`); stamped by clients for replay safety. Not the
    /// game's own notion of a turn, which lives in its state.
    step : Nat;
    lastActivity : Int;
    /// Reset only on a full resolve (unlike `lastActivity`), so
    /// `now - stepStartedAt` at resolve time is the step's own length.
    stepStartedAt : Int;
    /// Each seat's move from the most recently RESOLVED step.
    lastMoveP1 : ?M;
    lastMoveP2 : ?M;
    lastStepDurationNs : ?Int;
  };

  public type End = {
    #finished : Verdict;
    #aborted : Seat; // this seat left early
    #claimed : Seat; // this seat claimed the win after `claimTimeoutNs`
  };

  public type Debrief<S> = {
    p1 : PlayerId;
    p2 : PlayerId;
    end : End;
    steps : Nat;
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
    p1 : PlayerId;
    p2 : PlayerId;
    acked : [PlayerId];
    since : Int;
  };

  public type Table<S, M, O> = {
    var idleTimeoutNs : Int;
    var claimTimeoutNs : Int;
    visibility : TableVisibility;
    createdBy : PlayerId;
    /// Immutable for the table's lifetime; handed to `Spec.init`.
    options : O;

    var phase : Phase<S, M>;
    /// Match generation, bumped at every `stage()`. Echoed back on
    /// `submit`/`leave`/`reset`/`claimWin` so a stale replay is `#stale`.
    var gen : Nat;
    var lastEnded : [Ended];
    var debriefAcked : [PlayerId];
    /// Bumped on every change to the table (by `transport.mo`); a client
    /// polling with the `rev` it holds gets `#unchanged` until it moves.
    var rev : Nat;
  };

  public type Err = {
    #seatTaken;
    #notSeated;
    #alreadySubmitted;
    #notYourTurn; // `#turnBased` only
    #illegalMove : Text;
    #wrongPhase : Text;
    #reserved : { secondsLeft : Nat };
    #notIdle : { secondsLeft : Nat };
    #notOverdue : { secondsLeft : Nat };
    #stale; // `gen`/`step` no longer current — refetch the view
    #noSuchTable;
    #badCode; // wrong/missing code, or `createTable` with `#code("")`
    #unauthorized; // the anonymous principal
    #tooManyTables : { max : Nat }; // already at `max` tables
    #badOptions : Text; // `Spec.checkOptions` rejected the table's options
  };

  public type Res<T> = { #ok : T; #err : Err };

  public type JoinOk = {
    #staged : Seat;
    #started : Seat;
  };

  public type SubmitOk = {
    #waiting;
    #stepped : Nat; // the next step number
    #gameEnded : { verdict : Verdict; steps : Nat };
  };

  public type RematchOk = { #awaitingPartner; #started };

  /// Per-caller screen; a host renders these, never re-derives policy.
  public type TableView<V> = {
    #lobby : { p1Open : Bool; p2Open : Bool; resetAvailable : Bool };
    #busy : { secondsUntilTakeover : Nat };
    #stagingYou : {
      seat : Seat;
      reservedForPartner : Bool;
      gen : Nat;
      /// Includes a `#code` table's own code — only ever on the sole
      /// occupant's view of their own table.
      visibility : TableVisibility;
    };
    #awaitingRematch : { openSeat : Seat; gen : Nat };
    #inGame : {
      seat : Seat;
      game : V;
      step : Nat;
      mode : Mode;
      /// `#turnBased`: the seat on turn (`toMove`); `null` in
      /// `#simultaneous`, where both act every step.
      toMove : ?Seat;
      /// `#simultaneous`: locked in this step. `#turnBased`: not on turn.
      /// Either way the waiting seat is `youSubmitted and not oppSubmitted`.
      youSubmitted : Bool;
      oppSubmitted : Bool;
      gen : Nat;
      /// Countdowns are as fresh as the last view; clients tick locally.
      secondsUntilIdleReset : Nat;
      idleTimeoutSecs : Nat;
      claimWinAvailable : Bool;
      secondsUntilClaimable : Nat;
      claimTimeoutSecs : Nat;
    };
    #debrief : {
      seat : Seat;
      end : End;
      steps : Nat;
      finalGame : V;
      gen : Nat;
    };
    #endedByOther;
  };

};
