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

  /// Whether a game resolves a round from both seats' moves at once
  /// (`#simultaneous`) or one seat at a time, in order (`#alternating`).
  /// A plain, Candid-friendly tag — never carries the game's own
  /// functions (that's `Spec`, below); it exists purely so `View.#inGame`
  /// can report it to a client (see `Spec`'s own doc for why `Spec`
  /// itself can never be serialized).
  public type Mode = { #simultaneous; #alternating };

  public type Registry<S, M> = {
    idleTimeoutNs : Int;
    claimTimeoutNs : Int;
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
  /// Every function in either arm must be pure (no shared state, no Time
  /// calls) — the engine owns time and session state. Tagged by `Mode`:
  /// a game picks exactly one arm and implements only its shape — there
  /// is no "unused" function to stub out either way. Never stored (see
  /// architecture rule 1); passed fresh on every engine call, same as
  /// before this variant existed.
  ///
  /// `#simultaneous` resolves a round once BOTH seats have submitted —
  /// `resolve` takes both moves at once, exactly as this type always
  /// worked. `#alternating` resolves the instant the seat currently on
  /// turn submits theirs — `resolve` takes that ONE seat and move; the
  /// engine tracks whose turn it is on its own (from the match's own
  /// round counter — see `Table.toMove`'s own doc), so a game's own `S`
  /// never needs a turn flag of its own. See
  /// `skills/duel-game-core/references/alternating-turn-games.md` (or,
  /// in this repo, `examples/checkers/src/CheckersRules.mo`) for a
  /// worked `#alternating` game.
  public type Spec<S, M> = {
    #simultaneous : {
      /// Fresh game state for a new match.
      init : () -> S;
      /// null = legal; ?text = rejection reason (returned to the caller,
      /// no move consumed).
      validate : (S, Seat, M) -> ?Text;
      /// Called once both moves are in. Returns the next state and, if
      /// the game is over, the verdict.
      resolve : (S, M, M) -> { state : S; verdict : ?Verdict };
    };
    #alternating : {
      /// Fresh game state for a new match.
      init : () -> S;
      /// null = legal; ?text = rejection reason (returned to the caller,
      /// no move consumed). Called only for the seat currently on turn —
      /// the engine itself rejects an off-turn submission before this
      /// ever runs (`Err.#notYourTurn`).
      validate : (S, Seat, M) -> ?Text;
      /// Called the instant the on-turn seat's move is in. Returns the
      /// next state and, if the game is over, the verdict.
      resolve : (S, Seat, M) -> { state : S; verdict : ?Verdict };
    };
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
    // this seat claimed victory: they'd submitted their move, the
    // opponent hadn't, and `claimTimeoutNs` elapsed since — see
    // `Table.claimWin`'s own doc.
    #claimed : Seat;
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
    // How long a submitted move may sit pending against an opponent's
    // silence before its own submitter may claim the win outright — see
    // `Table.claimWin`'s own doc. Independent of `idleTimeoutNs` (which
    // governs the much longer, no-visitor-required full-board eviction
    // sweep still runs regardless) and normally set well below it, so a
    // player stuck waiting on a truly gone opponent has a real choice to
    // make before the board is simply reclaimed out from under them.
    claimTimeoutNs : Int;
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
    // `submit` on an `#alternating`-mode table from the seat NOT
    // currently on turn (see `Table.toMove`'s own doc) — never produced
    // for a `#simultaneous` table, where either seat may submit anytime.
    #notYourTurn;
    #illegalMove : Text;
    #wrongPhase : Text;
    #reserved : { secondsLeft : Nat }; // open seat is held for a rematch partner
    #notIdle : { secondsLeft : Nat }; // takeover/reset not allowed yet
    // `claimWin` called before `claimTimeoutNs` has elapsed since the
    // caller's own move went in with the opponent's still pending — see
    // `Table.claimWin`'s own doc.
    #notOverdue : { secondsLeft : Nat };
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
    // A `ws.mo` request claimed a `SessionId` in the reserved
    // principal-bound namespace (see `Ws.sidForPrincipal`'s own doc) that
    // doesn't match the caller's own authenticated principal — never
    // produced by `Table`/`Registry` themselves, only by `Ws.onMessage`'s
    // own guard, before the request ever reaches either.
    #unauthorized;
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
      // This table's own visibility — a `#code` table's own access code
      // included, so its creator/occupant can actually share table #
      // + code with a friend, the one thing a "Protected" table exists
      // to do. Safe to echo back here specifically because this is the
      // SOLE occupant's own view of their OWN table — nobody else's
      // `View` ever carries this.
      visibility : TableVisibility;
    };
    // `gen` — stamp onto a later `leave` to decline: see `Table.leave`'s
    // own doc for what declining does (frees the reservation, not the
    // whole board — the requester's own staging survives, now fully open).
    #awaitingRematch : { openSeat : Seat; gen : Nat };
    #inGame : {
      seat : Seat;
      game : S;
      turn : Nat;
      // This table's own mode — lets a host's UI show turn-accurate
      // copy ("Your turn" vs "Opponent has locked in") without a
      // separate lookup. Constant for the table's lifetime.
      mode : Mode;
      // `#simultaneous`: whether you/the opponent has locked in a move
      // THIS round (the round resolves once both are true). `#alternating`:
      // whether it's currently on YOU/the OPPONENT to move — i.e. exactly
      // one of the two is true at any time. Either way, "you're the
      // WAITING seat" (the one who may `claimWin`) is precisely
      // `youSubmitted and not oppSubmitted` — see `claimWinAvailable`
      // below, whose formula is unchanged between modes because of this.
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
      // Whether you may `claimWin` right now: you've submitted this
      // round's move, your opponent hasn't, and `claimTimeoutNs` has
      // elapsed since — already fully decided here, same as every other
      // View field, so a host's UI never has to reconstruct this gate
      // itself from `youSubmitted`/`oppSubmitted`/a raw countdown.
      claimWinAvailable : Bool;
      // Countdown to `claimWinAvailable` turning true, ticking down the
      // same way `secondsUntilIdleReset` does — meaningful only while
      // `youSubmitted` and not `oppSubmitted`; harmless (just unused) for
      // a host's UI otherwise, same as that pattern's own `#stagingYou`
      // analogue (`secondsUntilReclaimable`).
      secondsUntilClaimable : Nat;
      // This table's own configured claim-win window, in whole seconds —
      // constant for the table's lifetime, mirroring `idleTimeoutSecs`.
      claimTimeoutSecs : Nat;
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
