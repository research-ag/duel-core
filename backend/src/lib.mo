/// ═══════════════════════════════════════════════════════════════════════════
/// duel-game-core — a generic 2-player global-board session engine.
///
/// Game-agnostic core for any turn-based, simultaneous-reveal 2-player game:
///
///   • two players join a single global board (seats #p1 / #p2)
///   • rounds: each seated player submits one move; when both are in, the
///     game's `resolve` runs and either continues the game or ends it
///   • a finished game puts BOTH players in a #debrief (win / lose / draw)
///   • a player may LEAVE early: both players get a special debrief
///     (`end = #aborted seat`) instead of the game silently vanishing
///   • during the debrief, either previous player can request a REMATCH;
///     two simultaneous rematch requests converge race-free (see below)
///   • `leave` from a debrief dismisses it for YOU specifically — your own
///     `status`/`join`/`rematch` stop treating you as a participant of it
///     immediately, even though the underlying phase legitimately stays
///     #debrief until your partner also leaves (or it expires), so their
///     own rematch option isn't cut short by your exit
///   • after `idleTimeoutNs` of inactivity, third parties may take over:
///     claim a squatted staging seat, reset a dead game, or start fresh
///     over an expired debrief — or a host may call `sweep` on its own
///     periodic timer to free an abandoned board even with no visitor
///     around to trigger that lazily
///   • every session gets one truthful `status` view — including the
///     proactive #endedByOther notice when a game was ripped away
///
/// ── How a host actor wires it ──────────────────────────────────────────────
///
///   import TP "mo:duel-game-core";
///   import Rules "YourGameRules"; // any module implementing TP.Spec<S, M>
///   import Time "mo:core/Time";
///
///   persistent actor {
///     let table : TP.Table<Rules.State, Rules.Action> =   // implicitly stable
///       TP.create(60_000_000_000); // 60 s idle timeout
///
///     public func join(sid : Text, seat : TP.Seat) : async TP.Res<TP.JoinOk> {
///       TP.join(Rules.spec(), table, Time.now(), sid, seat)
///     };
///     public func submit(sid : Text, a : Rules.Action) : async TP.Res<TP.SubmitOk> {
///       TP.submit(Rules.spec(), table, Time.now(), sid, a)
///     };
///     // …leave / rematch / reset / status the same way.
///   };
///
/// `Table<S, M>` is a stable type whenever the game's state `S` and move `M`
/// are stable types. The `Spec` (functions) is passed on every call and never
/// stored, so the engine survives upgrades with no migration gymnastics.
///
/// `mo:duel-game-core/Session` is an optional mixin that splices five of
/// the seven entry points above (`join`/`rematch`/`leave`/`reset`/
/// `ackEnded`, plus the idle-sweep timer) straight into a host actor via
/// `include Session<system>(...)` — `submit`/`status` stay hand-written as
/// shown above either way, since their Candid types are game-specific and
/// Motoko mixins can't be generic. See `backend/README.md`'s "Session
/// mixin" section for the full before/after and `src/Session.mo`'s doc
/// header for why.
///
/// ── Design guarantees (each maps to a bug class found in the wild) ─────────
///
///   1. RACE-FREE REMATCH. `rematch` from #debrief stages a new game with the
///      open seat RESERVED for the partner; the partner's own `rematch` (or
///      `join`) call pattern-matches that staging and seats them. Because the
///      actor serializes update messages, two simultaneous rematch clicks
///      always execute as create-then-join — nobody can be stranded.
///   2. NO GHOST LOBBIES. Every phase carries its own timestamp (`since` /
///      `lastActivity`), stamped at creation — a first joiner who vanishes is
///      evictable after the timeout, not squatting forever.
///   3. SERVER-SIDE LEGALITY. The engine calls `spec.validate` on every
///      submitted move for BOTH players — a game plugged in here cannot be
///      cheated by a client bypassing UI button states.
///   4. NO SILENT ENDINGS. Aborting yields a shared #aborted debrief; an idle
///      takeover records the evicted players so `status` shows them
///      #endedByOther until they acknowledge (`ackEnded` / any re-entry).
///   5. LEAVE MEANS LEFT. `status`/`join`/`rematch` all treat a session that
///      already acked its own debrief (via `leave`) as no longer a
///      participant of it, even while the phase itself lingers in #debrief
///      for the still-deciding partner. Without this, "Return to lobby"
///      kept showing that same player the identical #debrief screen (with
///      live Rematch/Leave buttons) until the partner ALSO left — visually
///      indistinguishable from the button doing nothing at all.
///
/// Alternating-turn games: this engine is simultaneous-reveal. Model strictly
/// alternating games with a pass-move convention — include a #pass move, have
/// `validate` force the off-turn player to #pass (track whose turn in `S`),
/// and let `resolve` apply the single real move.
/// ═══════════════════════════════════════════════════════════════════════════

import Array "mo:core/Array"; // enables [T].concat dot notation
import Int "mo:core/Int"; // enables Int.toNat dot notation

module {

  // ────────────────────────── identities & verdicts ──────────────────────────

  public type SessionId = Text;

  public type Seat = { #p1; #p2 };

  public type Verdict = { #p1Wins; #p2Wins; #draw };

  public func otherSeat(s : Seat) : Seat = switch (s) {
    case (#p1) #p2;
    case (#p2) #p1;
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
    seat : Seat;              // seat held by `session`
    session : SessionId;
    reservedFor : ?SessionId; // rematch: open seat held for this partner
    since : Int;
  };

  public type Active<S, M> = {
    p1 : SessionId;
    p2 : SessionId;
    game : S;
    pending1 : ?M;            // hidden from the opponent by construction:
    pending2 : ?M;            //   `status` only exposes Booleans
    turn : Nat;
    lastActivity : Int;
  };

  public type End = {
    #finished : Verdict;
    #aborted : Seat;          // this seat left early — both players see it
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
  public type Ended = {
    p1 : SessionId;
    p2 : SessionId;
    acked : [SessionId];
  };

  /// The caller-owned, stable session state. One per global board.
  public type Table<S, M> = {
    idleTimeoutNs : Int;
    var phase : Phase<S, M>;
    var seq : Nat;                    // match counter (a new staging = new match)
    var lastEnded : ?Ended;
    var debriefAcked : [SessionId];   // who has dismissed the CURRENT debrief
  };

  public func create<S, M>(idleTimeoutNs : Int) : Table<S, M> = {
    idleTimeoutNs;
    var phase = #empty;
    var seq = 0;
    var lastEnded = null;
    var debriefAcked = [];
  };

  // ────────────────────────── results & errors ───────────────────────────────

  public type Err = {
    #seatTaken;
    #notSeated;
    #alreadySubmitted;
    #illegalMove : Text;
    #wrongPhase : Text;
    #reserved : { secondsLeft : Nat }; // open seat is held for a rematch partner
    #notIdle : { secondsLeft : Nat };  // takeover/reset not allowed yet
  };

  public type Res<T> = { #ok : T; #err : Err };

  public type JoinOk = {
    #staged : Seat;   // you hold a seat, waiting for an opponent
    #started : Seat;  // you completed the pair — game is live
  };

  public type SubmitOk = {
    #waiting;                                        // opponent still deciding
    #roundResolved : Nat;                            // next turn number
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
    };
    #awaitingRematch : { openSeat : Seat };
    #inGame : {
      seat : Seat;
      game : S;
      turn : Nat;
      youSubmitted : Bool;
      oppSubmitted : Bool;
    };
    #debrief : { seat : Seat; end : End; turns : Nat; finalGame : S };
    #endedByOther;
  };

  // ────────────────────────── small helpers ──────────────────────────────────

  func isSome<X>(o : ?X) : Bool = switch (o) { case (?_) true; case null false };

  func push(xs : [SessionId], x : SessionId) : [SessionId] {
    for (y in xs.values()) { if (y == x) return xs };
    xs.concat([x]);
  };

  func member(xs : [SessionId], x : SessionId) : Bool {
    for (y in xs.values()) { if (y == x) return true };
    false;
  };

  func expired<S, M>(t : Table<S, M>, since : Int, now : Int) : Bool =
    now - since >= t.idleTimeoutNs;

  func secsLeft<S, M>(t : Table<S, M>, since : Int, now : Int) : Nat {
    let left = t.idleTimeoutNs - (now - since);
    if (left <= 0) { 0 } else { left.toNat() / 1_000_000_000 };
  };

  func seatIn<S, M>(g : Active<S, M>, session : SessionId) : ?Seat {
    if (g.p1 == session) { ?#p1 } else if (g.p2 == session) { ?#p2 } else { null };
  };

  func seatInDebrief<S>(d : Debrief<S>, session : SessionId) : ?Seat {
    if (d.p1 == session) { ?#p1 } else if (d.p2 == session) { ?#p2 } else { null };
  };

  /// Like `seatInDebrief`, but a session that already acknowledged THIS
  /// debrief (via `leave` — see its own doc) no longer counts as a
  /// participant, even though the table's `phase` can still legitimately
  /// be `#debrief` (it lingers until the OTHER participant also leaves,
  /// or it expires, so a still-deciding partner keeps their rematch
  /// option open). Used by every debrief-phase operation EXCEPT `leave`
  /// itself (which must stay callable, idempotently, to ack in the first
  /// place — see `push`'s dedup). Without this, a session that clicked
  /// "leave" kept seeing the exact same `#debrief` view from `status`
  /// until the partner also left, with no sign their own click had done
  /// anything — indistinguishable from the button not working at all.
  func activeDebriefSeat<S, M>(t : Table<S, M>, d : Debrief<S>, session : SessionId) : ?Seat {
    if (member(t.debriefAcked, session)) { null } else { seatInDebrief(d, session) };
  };

  /// A game vanished without a debrief for these players — remember them so
  /// `status` can show #endedByOther until they acknowledge.
  func noteEnded<S, M>(t : Table<S, M>, p1 : SessionId, p2 : SessionId, acked : [SessionId]) {
    t.lastEnded := ?{ p1; p2; acked };
  };

  func unackedEnded<S, M>(t : Table<S, M>, session : SessionId) : Bool {
    switch (t.lastEnded) {
      case (?e) (e.p1 == session or e.p2 == session) and not member(e.acked, session);
      case null false;
    };
  };

  func stage<S, M>(t : Table<S, M>, now : Int, session : SessionId, seat : Seat, reservedFor : ?SessionId) {
    t.seq += 1;
    t.phase := #staging { seat; session; reservedFor; since = now };
  };

  func startGame<S, M>(spec : Spec<S, M>, t : Table<S, M>, now : Int, st : Staging, joiner : SessionId) {
    let (p1, p2) = switch (st.seat) {
      case (#p1) (st.session, joiner);
      case (#p2) (joiner, st.session);
    };
    t.phase := #active {
      p1; p2;
      game = spec.init();
      pending1 = null;
      pending2 = null;
      turn = 0;
      lastActivity = now;
    };
  };

  func enterDebrief<S, M>(t : Table<S, M>, now : Int, p1 : SessionId, p2 : SessionId, end : End, turns : Nat, finalGame : S) {
    t.debriefAcked := [];
    t.phase := #debrief { p1; p2; end; turns; finalGame; since = now };
  };

  // ────────────────────────── operations ─────────────────────────────────────

  /// Claim a seat. Handles: fresh joins, seat switching while staging alone,
  /// idempotent re-joins, reservation enforcement (with expiry), squatter
  /// eviction, idle takeover of a dead game, and fresh starts over an expired
  /// debrief. A veteran joining from their own debrief starts a rematch
  /// staging (equivalent to `rematch`, but lets them pick a different seat).
  public func join<S, M>(spec : Spec<S, M>, t : Table<S, M>, now : Int, session : SessionId, seat : Seat) : Res<JoinOk> {
    switch (t.phase) {

      case (#empty) {
        stage(t, now, session, seat, null);
        #ok(#staged(seat));
      };

      case (#staging st) {
        if (st.session == session) {
          if (st.seat == seat) { #ok(#staged(seat)) } // idempotent re-click
          else {
            // switch seats while alone; keep any reservation
            t.phase := #staging { seat; session; reservedFor = st.reservedFor; since = now };
            #ok(#staged(seat));
          };
        } else if (st.seat == seat) {
          // seat held by someone else — evict only if the staging expired
          if (expired(t, st.since, now)) {
            stage(t, now, session, seat, null);
            #ok(#staged(seat));
          } else { #err(#seatTaken) };
        } else {
          // the open seat
          switch (st.reservedFor) {
            case (?p) {
              if (p != session and not expired(t, st.since, now)) {
                return #err(#reserved { secondsLeft = secsLeft(t, st.since, now) });
              };
            };
            case null {};
          };
          startGame(spec, t, now, st, session);
          #ok(#started(seat));
        };
      };

      case (#active g) {
        if (isSome(seatIn(g, session))) {
          #err(#wrongPhase("you are already in the running game"));
        } else if (expired(t, g.lastActivity, now)) {
          // idle takeover: the abandoned game evaporates; its players will
          // see #endedByOther until they acknowledge
          noteEnded(t, g.p1, g.p2, []);
          stage(t, now, session, seat, null);
          #ok(#staged(seat));
        } else {
          #err(#notIdle { secondsLeft = secsLeft(t, g.lastActivity, now) });
        };
      };

      case (#debrief d) {
        switch (activeDebriefSeat(t, d, session)) {
          case (?_) {
            // veteran: joining from the debrief = starting a rematch staging,
            // with a free choice of seat; the partner gets the reservation.
            // (A session that already acked THIS debrief via `leave` falls
            // through to `case null` below instead — having said "I'm
            // done here", clicking a lobby seat shouldn't quietly turn
            // into a rematch with the old partner.)
            let partner = if (d.p1 == session) d.p2 else d.p1;
            stage(t, now, session, seat, ?partner);
            #ok(#staged(seat));
          };
          case null {
            if (expired(t, d.since, now)) {
              // window over; debriefed players already saw their result
              noteEnded(t, d.p1, d.p2, [d.p1, d.p2]);
              stage(t, now, session, seat, null);
              #ok(#staged(seat));
            } else {
              #err(#notIdle { secondsLeft = secsLeft(t, d.since, now) });
            };
          };
        };
      };
    };
  };

  /// One-click rematch. From a debrief (as a participant): stages a new game
  /// on your previous seat with the open seat reserved for your partner.
  /// From a staging reserved for you: seats you and starts the game.
  /// Two simultaneous calls serialize into create-then-join — race-free.
  public func rematch<S, M>(spec : Spec<S, M>, t : Table<S, M>, now : Int, session : SessionId) : Res<RematchOk> {
    switch (t.phase) {

      case (#debrief d) {
        // A session that already acked THIS debrief via `leave` is
        // treated as no longer a participant (see activeDebriefSeat's
        // doc) — #notSeated below, same as any other outsider, rather
        // than silently reviving a rematch with the old partner after
        // they said they were done.
        switch (activeDebriefSeat(t, d, session)) {
          case (?mySeat) {
            let partner = if (d.p1 == session) d.p2 else d.p1;
            stage(t, now, session, mySeat, ?partner);
            #ok(#awaitingPartner);
          };
          case null #err(#notSeated);
        };
      };

      case (#staging st) {
        if (st.session == session) { #ok(#awaitingPartner) } // idempotent
        else if (st.reservedFor == ?session) {
          startGame(spec, t, now, st, session);
          #ok(#started);
        } else {
          #err(#wrongPhase("another player is staging a game"));
        };
      };

      case (#active g) {
        if (isSome(seatIn(g, session))) {
          #err(#wrongPhase("your game is already running"));
        } else { #err(#notSeated) };
      };

      case (#empty) #err(#wrongPhase("no finished game to rematch"));
    };
  };

  /// Submit this round's move. Duplicate submissions are rejected without
  /// consuming the turn; legality is enforced via `spec.validate` for both
  /// players. Resolves the round once both moves are in.
  public func submit<S, M>(spec : Spec<S, M>, t : Table<S, M>, now : Int, session : SessionId, move : M) : Res<SubmitOk> {
    switch (t.phase) {
      case (#active g) {
        let mySeat = switch (seatIn(g, session)) {
          case (?s) s;
          case null return #err(#notSeated);
        };
        let myPending = switch (mySeat) { case (#p1) g.pending1; case (#p2) g.pending2 };
        switch (myPending) {
          case (?_) return #err(#alreadySubmitted);
          case null {};
        };
        switch (spec.validate(g.game, mySeat, move)) {
          case (?why) return #err(#illegalMove(why));
          case null {};
        };

        let g2 : Active<S, M> = {
          p1 = g.p1;
          p2 = g.p2;
          game = g.game;
          pending1 = switch (mySeat) { case (#p1) ?move; case (#p2) g.pending1 };
          pending2 = switch (mySeat) { case (#p2) ?move; case (#p1) g.pending2 };
          turn = g.turn;
          lastActivity = now;
        };
        t.phase := #active(g2);

        switch (g2.pending1, g2.pending2) {
          case (?m1, ?m2) {
            let r = spec.resolve(g2.game, m1, m2);
            let turns = g2.turn + 1;
            switch (r.verdict) {
              case (?v) {
                enterDebrief(t, now, g2.p1, g2.p2, #finished(v), turns, r.state);
                #ok(#gameEnded { verdict = v; turns });
              };
              case null {
                t.phase := #active {
                  p1 = g2.p1;
                  p2 = g2.p2;
                  game = r.state;
                  pending1 = null;
                  pending2 = null;
                  turn = turns;
                  lastActivity = now;
                };
                #ok(#roundResolved(turns));
              };
            };
          };
          case (_) #ok(#waiting);
        };
      };
      case (_) #err(#wrongPhase("no game is running"));
    };
  };

  /// Leave. From your own staging: the board empties. From a live game: BOTH
  /// players land in a special `#aborted` debrief — the partner is told, in
  /// debrief form, that you left. From a debrief: acknowledges it for you;
  /// when both participants have left, the board frees early.
  public func leave<S, M>(t : Table<S, M>, now : Int, session : SessionId) : Res<()> {
    switch (t.phase) {

      case (#staging st) {
        if (st.session == session) {
          t.phase := #empty;
          #ok(());
        } else { #err(#notSeated) };
      };

      case (#active g) {
        switch (seatIn(g, session)) {
          case (?mySeat) {
            enterDebrief(t, now, g.p1, g.p2, #aborted(mySeat), g.turn, g.game);
            #ok(());
          };
          case null #err(#notSeated);
        };
      };

      case (#debrief d) {
        switch (seatInDebrief(d, session)) {
          case (?_) {
            t.debriefAcked := push(t.debriefAcked, session);
            if (member(t.debriefAcked, d.p1) and member(t.debriefAcked, d.p2)) {
              t.phase := #empty; // both are done — free the board early
              t.debriefAcked := [];
            };
            #ok(());
          };
          case null #err(#notSeated);
        };
      };

      case (#empty) #ok(());
    };
  };

  /// Reset the board. Participants get leave-semantics; outsiders are gated
  /// by the idle timeout (with a countdown in the error until then).
  public func reset<S, M>(t : Table<S, M>, now : Int, session : SessionId) : Res<()> {
    switch (t.phase) {
      case (#empty) #ok(());

      case (#staging st) {
        if (st.session == session or expired(t, st.since, now)) {
          t.phase := #empty;
          #ok(());
        } else { #err(#notIdle { secondsLeft = secsLeft(t, st.since, now) }) };
      };

      case (#active g) {
        if (isSome(seatIn(g, session))) {
          leave(t, now, session); // participant reset = abort with shared debrief
        } else if (expired(t, g.lastActivity, now)) {
          noteEnded(t, g.p1, g.p2, []);
          t.phase := #empty;
          #ok(());
        } else {
          #err(#notIdle { secondsLeft = secsLeft(t, g.lastActivity, now) });
        };
      };

      case (#debrief d) {
        if (isSome(seatInDebrief(d, session))) {
          leave(t, now, session);
        } else if (expired(t, d.since, now)) {
          noteEnded(t, d.p1, d.p2, [d.p1, d.p2]); // they saw their debrief
          t.phase := #empty;
          #ok(());
        } else {
          #err(#notIdle { secondsLeft = secsLeft(t, d.since, now) });
        };
      };
    };
  };

  /// Frees an idle board with no visitor required to trigger it — the same
  /// eviction rule `join`/`reset` already apply to an outsider, just
  /// callable with no session at all. Meant to be driven by a host's own
  /// periodic timer (see README's wiring example): in a 2-player casual
  /// game there is often nobody left to poll an abandoned board and
  /// trigger the lazy, visitor-driven eviction those two functions do, so
  /// without this a board both players walked away from just sits
  /// occupied forever instead of freeing itself.
  public func sweep<S, M>(t : Table<S, M>, now : Int) {
    switch (t.phase) {
      case (#empty) {};
      case (#staging st) {
        if (expired(t, st.since, now)) { t.phase := #empty };
      };
      case (#active g) {
        if (expired(t, g.lastActivity, now)) {
          noteEnded(t, g.p1, g.p2, []);
          t.phase := #empty;
        };
      };
      case (#debrief d) {
        if (expired(t, d.since, now)) {
          noteEnded(t, d.p1, d.p2, [d.p1, d.p2]); // they already saw it
          t.phase := #empty;
        };
      };
    };
  };

  /// Acknowledge an #endedByOther notice (host wires this to "return to base").
  public func ackEnded<S, M>(t : Table<S, M>, session : SessionId) {
    switch (t.lastEnded) {
      case (?e) {
        if (e.p1 == session or e.p2 == session) {
          t.lastEnded := ?{ p1 = e.p1; p2 = e.p2; acked = push(e.acked, session) };
        };
      };
      case null {};
    };
  };

  /// The one truthful, per-caller status view. Pure — safe as a query.
  public func status<S, M>(t : Table<S, M>, now : Int, session : SessionId) : View<S> {
    switch (t.phase) {

      case (#empty) {
        if (unackedEnded(t, session)) { #endedByOther } else {
          #lobby { p1Open = true; p2Open = true; resetAvailable = false };
        };
      };

      case (#staging st) {
        if (st.session == session) {
          // This branch never checks `expired(t, st.since, now)` — the
          // seat stays #stagingYou for its own occupant no matter how
          // idle it's gone (only a THIRD PARTY's `join` actually evicts
          // it, below). `secondsUntilReclaimable` is how that occupant
          // learns they're on a clock at all — without it, a host's UI
          // has nothing to warn "waiting for an opponent" with, and the
          // seat can vanish out from under them with no notice.
          #stagingYou {
            seat = st.seat;
            reservedForPartner = isSome(st.reservedFor);
            secondsUntilReclaimable = secsLeft(t, st.since, now);
          };
        } else if (st.reservedFor == ?session) {
          #awaitingRematch { openSeat = otherSeat(st.seat) };
        } else if (unackedEnded(t, session)) {
          #endedByOther;
        } else {
          let ex = expired(t, st.since, now);
          if (isSome(st.reservedFor) and not ex) {
            #busy { secondsUntilTakeover = secsLeft(t, st.since, now) };
          } else {
            #lobby {
              p1Open = st.seat != #p1 or ex;
              p2Open = st.seat != #p2 or ex;
              resetAvailable = ex;
            };
          };
        };
      };

      case (#active g) {
        switch (seatIn(g, session)) {
          case (?mySeat) {
            #inGame {
              seat = mySeat;
              game = g.game;
              turn = g.turn;
              youSubmitted = isSome(switch (mySeat) { case (#p1) g.pending1; case (#p2) g.pending2 });
              oppSubmitted = isSome(switch (mySeat) { case (#p1) g.pending2; case (#p2) g.pending1 });
            };
          };
          case null {
            if (unackedEnded(t, session)) { #endedByOther }
            else if (expired(t, g.lastActivity, now)) {
              #lobby { p1Open = true; p2Open = true; resetAvailable = true };
            } else {
              #busy { secondsUntilTakeover = secsLeft(t, g.lastActivity, now) };
            };
          };
        };
      };

      case (#debrief d) {
        // activeDebriefSeat (not plain seatInDebrief): once THIS session
        // has acked its own debrief (see `leave`), it falls through to
        // `case null` below exactly like a non-participant — otherwise
        // "Return to lobby" kept showing the SAME #debrief view (nothing
        // about d.p1/d.p2 membership changed) until the partner also
        // left, giving no sign the click had done anything.
        switch (activeDebriefSeat(t, d, session)) {
          case (?mySeat) {
            #debrief { seat = mySeat; end = d.end; turns = d.turns; finalGame = d.finalGame };
          };
          case null {
            if (unackedEnded(t, session)) { #endedByOther }
            else if (expired(t, d.since, now)) {
              #lobby { p1Open = true; p2Open = true; resetAvailable = true };
            } else {
              #busy { secondsUntilTakeover = secsLeft(t, d.since, now) };
            };
          };
        };
      };
    };
  };
};
