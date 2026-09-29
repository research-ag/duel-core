import Map "mo:core/Map";
import PT "mo:promtracker";

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
    var gamesStarted : ?PT.Counter;
    var activeGames : ?PT.Gauge;
    var roundsPerGame : ?PT.Gauge;
    var matchmakingWaitSecs : ?PT.Gauge;
  };

  public type TableSummary = {
    id : TableId;
    p1Open : Bool;
    p2Open : Bool;
    // Whichever session currently holds a NOT-open seat — `null` for an
    // open seat, or for a seat whose occupant isn't meaningfully "someone
    // to name" (an idle-reclaimable board reported open on both seats
    // instead — see `Registry.openness`'s own doc). Lets a browsing
    // visitor see WHO they'd be facing before they even join, not just
    // that the seat is taken.
    p1Session : ?SessionId;
    p2Session : ?SessionId;
    // Whether this table needs an access code to join — never the code
    // itself (see `Registry.listTables`'s own doc for why: a visitor
    // browsing the lobby has no business learning a code they weren't
    // handed out of band, only that one is required).
    protected : Bool;
    waitingSecs : Nat;
    // This table's own rules variant, set once by its creator (see
    // `Registry.createTable`'s own doc) and never inspected by the engine
    // itself — opaque `Text` a game interprets however it likes inside its
    // own `Spec.init`. A visitor browsing the lobby sees it as plain text
    // (a host's `GamePlugin.formatVariant`, if it supplies one, turns this
    // into display copy) so they can pick a table by its rules before ever
    // joining it — the same reason `protected` is exposed here rather than
    // held back until `join`.
    variant : Text;
  };

  /// The per-caller lobby-scoped screen: either browsing the open-table
  /// list, or seated/staged/playing/debriefing at a specific table —
  /// `view` is exactly the same per-table `View<S>` `status` above
  /// already returns, just labeled with which table it's about.
  public type SessionStatus<S> = {
    #browsing : { tables : [TableSummary] };
    #atTable : { id : TableId; view : View<S> };
  };

  /// What a canister-seated player is handed to decide its move —
  /// `mo:duel-game-core/canister_players`'s call/response counterpart to
  /// `View.inGame`, minus the UI countdown cosmetics, plus a handful of
  /// fields a HUMAN's own screen has no use for but a bot's decision
  /// logic does — see the "simple vs. stateful bots" guidance in
  /// `skills/duel-game-core/references/canister-player-bots.md` for how
  /// these are meant to be used together.
  ///
  /// `tableId` is included because a bot's own `make_move` may be
  /// watching more than one table at once and needs to know which one
  /// this request is about; `gen`/`turn` are the values to echo straight
  /// back on the `registry.submit` the reply drives, though the caller
  /// re-reads both fresh immediately before that call rather than
  /// trusting the copies still closed over from before the bot's own
  /// `await` (see `canister_players.mo`'s own doc for why). `gen` also
  /// doubles as this specific MATCH's own identity: it bumps at every
  /// fresh `stage()` (a join, a takeover, a REMATCH included), so a
  /// board that gets replayed on the very same `tableId` still hands a
  /// bot a `gen` (or, equivalently, a `turn` that's gone back to `0`) it
  /// hasn't seen before — a bot keying its own per-match memory off
  /// `(tableId, gen)` (or just watching for `turn == 0`) never confuses
  /// a rematch with a continuation of the old one. `retryReason` is
  /// `null` on the first ask for a given round; `canister_players.mo`'s
  /// own one-shot retry sets it to the exact rejection text `validate`
  /// returned for the first, illegal reply, so a bot that wants to can
  /// react to specifically WHY its move was rejected rather than just
  /// blindly resubmitting — a bot that ignores it is free to.
  ///
  /// `opponent` is the opposing seat's own `SessionId`, raw and
  /// unnormalized — the same shape `TableSummary.p1Session`/`p2Session`
  /// already hand a browsing lobby, so this exposes nothing a client
  /// couldn't already see elsewhere. For a human opponent (`ii:`/`an:`)
  /// it's a stable, principal-bound identity that reads the SAME across
  /// every table they ever play at, so a bot can key long-lived,
  /// cross-table opponent modeling directly off it with no extra
  /// bridging. For a canister opponent (`cp:`,
  /// `canister_players.mo`'s own `sidForCanister`) it's deliberately
  /// PER-TABLE instead — a bot that wants to model a specific canister
  /// opponent across several boards recovers its stable principal
  /// itself via `CanisterPlayers.principalOfCanisterSession`, the same
  /// special-case a leaderboard host already makes (see
  /// `backend/README.md`'s "Leaderboard" section's own player-identity
  /// note).
  ///
  /// `opponentLastMove` is the opponent's own most recently RESOLVED
  /// move — `null` exactly when `turn == 0` (nobody has moved yet this
  /// match). This is never the CURRENT round's still-pending move
  /// (architecture rule 9's secrecy guarantee is untouched — a pending
  /// move is never in this record either); it's strictly history, from
  /// the round that already resolved into `game` itself.
  ///
  /// `lastRoundDurationNs` is how many nanoseconds the most recently
  /// resolved round/turn took, wall-clock — `null` under the same
  /// `turn == 0` condition. For `#simultaneous` this covers BOTH seats'
  /// combined thinking time (the round resolves only once both moved, so
  /// there's no way to attribute the delay to one side alone); for
  /// `#alternating`, since exactly one seat moves per turn, it's
  /// unambiguously that one mover's own time.
  ///
  /// `complexity` is which of the bot's own declared ways of playing this
  /// seat was seated at (`canister_players.mo`'s "Complexity" section —
  /// opaque text, `"Default"` for a bot that declares none), fixed for
  /// the session's life, so a bot playing on several boards at once can
  /// be "Hard" on one and "Easy" on another with no state of its own. A
  /// bot with one way to play ignores it; one with several should treat
  /// a value it doesn't recognize as its own default rather than trap.
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
      /// Fresh game state for a new match, from this table's own
      /// `variant` (see `Table.variant`'s own doc) — opaque to the
      /// engine, entirely this function's own call to interpret.
      /// Unrecognized text should fall back to a safe default rather
      /// than trap: the engine never validates it, so a game that
      /// doesn't want modes at all just ignores the argument
      /// (`init = func(_ : Text) : S = { ... }`).
      init : (Text) -> S;
      /// null = legal; ?text = rejection reason (returned to the caller,
      /// no move consumed).
      validate : (S, Seat, M) -> ?Text;
      /// Called once both moves are in. Returns the next state and, if
      /// the game is over, the verdict.
      resolve : (S, M, M) -> { state : S; verdict : ?Verdict };
    };
    #alternating : {
      /// Fresh game state for a new match, from this table's own
      /// `variant` — see the `#simultaneous` arm's own doc above.
      init : (Text) -> S;
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
    // When the CURRENT round/turn began — set at match start and reset
    // every time a round resolves; unlike `lastActivity` (bumped by a
    // `#simultaneous` round's first-of-two partial submission as well),
    // this only ever moves at a full resolve, so `now - roundStartedAt`
    // AT the moment of resolve is genuinely that round's own wall-clock
    // length, not just "time since the last activity of any kind" — see
    // `lastRoundDurationNs` below, which freezes exactly that value.
    roundStartedAt : Int;
    // Each seat's own move from the most recently RESOLVED round/turn —
    // distinct from `pending1`/`pending2` (this round's still-secret,
    // not-yet-resolved submissions, hidden from the opponent by
    // construction per architecture rule 9). A resolved move is no
    // longer secret — both players already learned its effect from the
    // round's own outcome — so surfacing it here (to
    // `MoveRequest.opponentLastMove`, for a canister-seated opponent)
    // doesn't reopen that rule. `null` until each seat has made its
    // first move of the match. `#alternating` only ever updates the
    // move-just-made seat's own slot; the other seat's carries over
    // unchanged until their next turn.
    lastMoveP1 : ?M;
    lastMoveP2 : ?M;
    // Wall-clock nanoseconds the most recently resolved round/turn took,
    // frozen at `roundStartedAt`'s own reset until the NEXT round
    // resolves — `null` before the match's first round has resolved
    // (`turn == 0`). For `#simultaneous`, this is the time from the
    // round becoming live until BOTH seats had submitted (so it reflects
    // whichever seat took longer, not one side specifically); for
    // `#alternating`, since only one seat moves per turn, it's squarely
    // that ONE mover's own thinking time.
    lastRoundDurationNs : ?Int;
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
    // This table's own rules variant, supplied once at creation (see
    // `Registry.createTable`'s own doc) and immutable for the table's
    // whole lifetime — a rematch on the same `TableId` (architecture rule
    // 6) reuses it automatically. Read back by `startGame` and handed to
    // `Spec.init`; otherwise opaque to the engine, which never inspects
    // its contents. Surfaced read-only on `TableSummary` (see its own
    // doc) so a browsing visitor can see it before joining.
    variant : Text;

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
    // A `ws.mo` request's `SessionId` doesn't match the caller's own
    // authenticated principal under either reserved, principal-bound
    // namespace (see `Ws.PRINCIPAL_SID_PREFIX`/`Ws.ANON_SID_PREFIX`'s own
    // doc) — including a `SessionId` that names neither namespace at all,
    // since every legal `sid` must be principal-bound. Never produced by
    // `Table`/`Registry` themselves, only by `Ws.onMessage`'s own guard,
    // before the request ever reaches either.
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
