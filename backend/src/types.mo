import Map "mo:core/Map";

module {

  // ────────────────────────── identities & verdicts ──────────────────────────

  public type TableId = Nat;

  public type TableVisibility = { #open; #code : Text };

  public type SessionId = Text;

  public type Seat = { #p1; #p2 };

  public func otherSeat(s : Seat) : Seat = switch (s) {
    case (#p1) #p2;
    case (#p2) #p1;
  };

  public type Verdict = { #p1Wins; #p2Wins; #draw };

  public type Registry<S, M> = {
    idleTimeoutNs : Int;
    var tables : Map.Map<TableId, Table<S, M>>;
    // This session's current table, if any — cleared once `leave`/
    // `reset`/`ackEnded` returns them to "browsing". Absent = browsing the lobby.
    var bySession : Map.Map<SessionId, TableId>;
    var tableIdNonce : TableId;
  };

  public type TableSummary = {
    id : TableId;
    p1Open : Bool;
    p2Open : Bool;
    waitingSecs : Nat;
  };

  /// The per-caller lobby-scoped screen: either browsing the open-table
  /// list, or seated/staged/playing/debriefing at a specific table —
  /// `view` is exactly the same per-table `View<S>` `status` above
  /// already returns, just labeled with which table it's about.
  public type SessionStatus<S> = {
    #browsing : { tables : [TableSummary] };
    #atTable : { id : TableId; view : View<S> };
  };

  // ────────────────────────── the game plug-in interface ─────────────────────

  /// What a game must supply. `S` = game state, `M` = a player's move.
  /// All three functions must be pure (no shared state, no Time calls) —
  /// the engine owns time and session state.
  public type Spec<S, M> = {
    /// Fresh game state for a new match.
    init : () -> S;
    /// null = legal; ?text = rejection reason (returned to the caller,
    /// no move consumed).
    validate : (S, Seat, M) -> ?Text;
    /// Called once both moves are in. Returns the next state and, if the
    /// game is over, the verdict.
    resolve : (S, M, M) -> { state : S; verdict : ?Verdict };
  };

  // ────────────────────────── session phases ─────────────────────────────────

  public type Staging = {
    seat : Seat; // seat held by `session`
    session : SessionId;
    reservedFor : ?SessionId; // rematch: open seat held for this partner
    since : Int;
  };

  public type Active<S, M> = {
    p1 : SessionId;
    p2 : SessionId;
    game : S;
    pending1 : ?M; // hidden from the opponent by construction:
    pending2 : ?M; //   `status` only exposes Booleans
    turn : Nat;
    lastActivity : Int;
  };

  public type End = {
    #finished : Verdict;
    #aborted : Seat; // this seat left early — both players see it
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

  /// Participants of the most recent game that vanished WITHOUT both of them
  /// seeing a debrief (idle takeover / outsider reset). Drives #endedByOther.
  /// `since` is when the notice was recorded — see `Table.pruneEnded`'s own
  /// doc for why a notice doesn't wait for an ack forever.
  public type Ended = {
    p1 : SessionId;
    p2 : SessionId;
    acked : [SessionId];
    since : Int;
  };

  /// The caller-owned, stable session state. One per global board.
  public type Table<S, M> = {
    idleTimeoutNs : Int;
    visibility : TableVisibility;
    createdBy : SessionId;

    var phase : Phase<S, M>;
    // Match generation: bumped once per new match, at every `stage()` call
    // (a fresh join, a squatter eviction, an idle takeover, a rematch
    // staging). Exposed to the caller via `View` and echoed back on
    // `submit`/`leave`/`reset` (see those functions' own docs) so a
    // request that was actually meant for an OLDER match — most commonly
    // a client-side resend whose original attempt secretly already landed
    // (see `../../frontend/src/ws/gateway-client.ts`'s `_queueResend` doc)
    // — is rejected as `#stale` instead of being silently misapplied to
    // whatever match/round happens to be current by the time it's
    // processed.
    var gen : Nat;
    // One entry per game that vanished without both players seeing a
    // debrief, still missing at least one ack — see `noteEnded`'s own doc
    // for why this must stay a list, not a single slot.
    var lastEnded : [Ended];
    var debriefAcked : [SessionId]; // who has dismissed the CURRENT debrief
  };

  // ────────────────────────── results & errors ───────────────────────────────

  public type Err = {
    #seatTaken;
    #notSeated;
    #alreadySubmitted;
    #illegalMove : Text;
    #wrongPhase : Text;
    #reserved : { secondsLeft : Nat }; // open seat is held for a rematch partner
    #notIdle : { secondsLeft : Nat }; // takeover/reset not allowed yet
    // `submit`/`leave`/`reset` carried a `gen` (or, for `submit`, `turn`)
    // that no longer matches the table's current one — see `Table.gen`'s
    // own doc. The caller's fix is always the same regardless of cause:
    // refetch `status` and act on the real, current view.
    #stale;
    // `Lobby.joinTable` named a `TableId` no table in the registry
    // currently holds — either it never existed or it was already
    // garbage-collected (see `Lobby.gcIfQuiesced`'s own doc).
    #noSuchTable;
    // `Lobby.joinTable` targeted a `#code`-protected table with a
    // missing or wrong `code`, or `Lobby.createTable` itself was asked
    // for a `#code("")` table — an empty code can never be supplied
    // back to `joinTable` to match it, so that table would otherwise be
    // unreachable by construction.
    #badCode;
  };

  public type Res<T> = { #ok : T; #err : Err };

  public type JoinOk = {
    #staged : Seat; // you hold a seat, waiting for an opponent
    #started : Seat; // you completed the pair — game is live
  };

  public type SubmitOk = {
    #waiting; // opponent still deciding
    #roundResolved : Nat; // next turn number
    #gameEnded : { verdict : Verdict; turns : Nat }; // record history from this
  };

  public type RematchOk = { #awaitingPartner; #started };

  /// Per-caller screen. The host renders these; it never derives UI policy
  /// from raw flags.
  public type View<S> = {
    #lobby : { p1Open : Bool; p2Open : Bool; resetAvailable : Bool };
    #busy : { secondsUntilTakeover : Nat };
    #stagingYou : {
      seat : Seat;
      reservedForPartner : Bool;
      secondsUntilReclaimable : Nat;
      gen : Nat; // stamp onto a later `leave`/`reset` — see Table.gen's doc
    };
    // `gen` — stamp onto a later `leave` to decline: see `Table.leave`'s
    // own doc for what declining does (frees the reservation, not the
    // whole board — the requester's own staging survives, now fully open).
    #awaitingRematch : { openSeat : Seat; gen : Nat };
    #inGame : {
      seat : Seat;
      game : S;
      turn : Nat;
      youSubmitted : Bool;
      oppSubmitted : Bool;
      gen : Nat; // stamp onto a later `submit`/`leave`/`reset`
      // Raw countdown to the idle sweep, plus the table's own configured
      // timeout (constant for the table's lifetime, repeated here rather
      // than fetched separately) — together enough for a host's UI to
      // compute its own warning threshold and count the seconds down
      // locally between pushes, the same way `secondsUntilReclaimable`
      // lets a staged occupant do it. No push repeats on a bare tick of
      // the clock (see `ws.mo`'s `sweepAndPush` doc): these two numbers
      // are only ever as fresh as the last real push, so a client ticking
      // them down on its own wall clock is what makes them look alive.
      secondsUntilIdleReset : Nat;
      idleTimeoutSecs : Nat;
    };
    #debrief : {
      seat : Seat;
      end : End;
      turns : Nat;
      finalGame : S;
      gen : Nat; // stamp onto a later `leave`/`reset`
    };
    #endedByOther;
  };

};
