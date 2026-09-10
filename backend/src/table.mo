import Array "mo:core/Array";
import Int "mo:core/Int";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Option "mo:core/Option";
import Text "mo:core/Text";

import T "./types";

module {

  public type Table<S, M> = T.Table<S, M>;

  public func new<S, M>(idleTimeoutNs : Int, visibility : T.TableVisibility, createdBy : T.SessionId) : Table<S, M> = {
    idleTimeoutNs;
    visibility;
    createdBy;
    var phase = #empty;
    var gen = 0;
    var lastEnded = [];
    var debriefAcked = [];
  };

  public func isExpired<S, M>(self : Table<S, M>, since : Int, now : Int) : Bool = now - since >= self.idleTimeoutNs;

  public func secsLeft<S, M>(self : Table<S, M>, since : Int, now : Int) : Nat {
    let left = self.idleTimeoutNs - (now - since);
    if (left <= 0) { 0 } else { left.toNat() / 1_000_000_000 };
  };

  /// Like `Debrief.seat`, but a session that already acknowledged THIS
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
  public func activeDebriefSeat<S, M>(self : Table<S, M>, d : T.Debrief<S>, session : T.SessionId) : ?T.Seat {
    if (member(self.debriefAcked, session)) { null } else {
      getSessionSeat(d, session);
    };
  };

  /// A game vanished without a debrief for these players — remember them so
  /// `status` can show #endedByOther until they acknowledge. Appends rather
  /// than replacing: this table's board is free again (`#empty`) the
  /// instant this runs, so an entirely different pair can join, play, and
  /// EVEN THIS SAME WAY vanish again before the first pair ever comes back
  /// to ack — a single `?Ended` slot would silently drop the earlier
  /// pair's notice the moment the second one landed. Skips recording an
  /// entry that's already fully acked (the pre-acked-debrief-takeover
  /// case) — nothing downstream ever needs one.
  public func noteEnded<S, M>(self : Table<S, M>, p1 : T.SessionId, p2 : T.SessionId, acked : [T.SessionId]) {
    if (member(acked, p1) and member(acked, p2)) return;
    self.lastEnded := self.lastEnded.concat([{ p1; p2; acked }]);
  };

  public func unackedEnded<S, M>(self : Table<S, M>, session : T.SessionId) : Bool {
    for (e in self.lastEnded.values()) {
      if ((e.p1 == session or e.p2 == session) and not member(e.acked, session)) {
        return true;
      };
    };
    false;
  };

  /// `null` if `gen` still matches the table's current match generation;
  /// `?#stale` otherwise. See `Table.gen`'s own doc for what this guards
  /// against — call this before doing anything else in an operation that
  /// takes a caller-supplied `gen`.
  public func checkGen<S, M>(self : Table<S, M>, gen : Nat) : ?T.Err = if (gen == self.gen) {
    null;
  } else { ?#stale };

  public func stage<S, M>(self : Table<S, M>, now : Int, session : T.SessionId, seat : T.Seat, reservedFor : ?T.SessionId) {
    self.gen += 1;
    self.phase := #staging { seat; session; reservedFor; since = now };
  };

  public func startGame<S, M>(self : Table<S, M>, spec : T.Spec<S, M>, now : Int, st : T.Staging, joiner : T.SessionId) {
    let (p1, p2) = switch (st.seat) {
      case (#p1) (st.session, joiner);
      case (#p2) (joiner, st.session);
    };
    self.phase := #active {
      p1;
      p2;
      game = spec.init();
      pending1 = null;
      pending2 = null;
      turn = 0;
      lastActivity = now;
    };
  };

  public func enterDebrief<S, M>(self : Table<S, M>, now : Int, p1 : T.SessionId, p2 : T.SessionId, end : T.End, turns : Nat, finalGame : S) {
    self.debriefAcked := [];
    self.phase := #debrief { p1; p2; end; turns; finalGame; since = now };
  };

  // ────────────────────────── operations ─────────────────────────────────────

  /// Claim a seat. Handles: fresh joins, seat switching while staging alone,
  /// idempotent re-joins, reservation enforcement (with expiry), squatter
  /// eviction, idle takeover of a dead game, and fresh starts over an expired
  /// debrief. A veteran joining from their own debrief starts a rematch
  /// staging (equivalent to `rematch`, but lets them pick a different seat).
  public func join<S, M>(self : Table<S, M>, spec : T.Spec<S, M>, now : Int, session : T.SessionId, seat : T.Seat) : T.Res<T.JoinOk> {
    switch (self.phase) {

      case (#empty) {
        self.stage(now, session, seat, null);
        #ok(#staged(seat));
      };

      case (#staging st) {
        if (st.session == session) {
          if (st.seat == seat) { #ok(#staged(seat)) } // idempotent re-click
          else {
            // switch seats while alone; keep any reservation
            self.phase := #staging {
              seat;
              session;
              reservedFor = st.reservedFor;
              since = now;
            };
            #ok(#staged(seat));
          };
        } else if (st.seat == seat) {
          // seat held by someone else — evict only if the staging expired
          if (self.isExpired(st.since, now)) {
            self.stage(now, session, seat, null);
            #ok(#staged(seat));
          } else { #err(#seatTaken) };
        } else {
          // the open seat
          switch (st.reservedFor) {
            case (?p) {
              if (p != session and not self.isExpired(st.since, now)) {
                return #err(#reserved { secondsLeft = self.secsLeft(st.since, now) });
              };
            };
            case null {};
          };
          self.startGame(spec, now, st, session);
          #ok(#started(seat));
        };
      };

      case (#active g) {
        if (Option.isSome(getSessionSeat(g, session))) {
          #err(#wrongPhase("you are already in the running game"));
        } else if (self.isExpired(g.lastActivity, now)) {
          // idle takeover: the abandoned game evaporates; its players will
          // see #endedByOther until they acknowledge
          self.noteEnded(g.p1, g.p2, []);
          self.stage(now, session, seat, null);
          #ok(#staged(seat));
        } else {
          #err(#notIdle { secondsLeft = self.secsLeft(g.lastActivity, now) });
        };
      };

      case (#debrief d) {
        switch (self.activeDebriefSeat(d, session)) {
          case (?_) {
            // veteran: joining from the debrief = starting a rematch staging,
            // with a free choice of seat; the partner gets the reservation.
            // (A session that already acked THIS debrief via `leave` falls
            // through to `case null` below instead — having said "I'm
            // done here", clicking a lobby seat shouldn't quietly turn
            // into a rematch with the old partner.)
            let partner = if (d.p1 == session) d.p2 else d.p1;
            self.stage(now, session, seat, ?partner);
            #ok(#staged(seat));
          };
          case null {
            if (self.isExpired(d.since, now)) {
              // window over; debriefed players already saw their result
              self.noteEnded(d.p1, d.p2, [d.p1, d.p2]);
              self.stage(now, session, seat, null);
              #ok(#staged(seat));
            } else {
              #err(#notIdle { secondsLeft = self.secsLeft(d.since, now) });
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
  public func rematch<S, M>(self : Table<S, M>, spec : T.Spec<S, M>, now : Int, session : T.SessionId) : T.Res<T.RematchOk> {
    switch (self.phase) {

      case (#debrief d) {
        // A session that already acked THIS debrief via `leave` is
        // treated as no longer a participant (see activeDebriefSeat's
        // doc) — #notSeated below, same as any other outsider, rather
        // than silently reviving a rematch with the old partner after
        // they said they were done.
        switch (self.activeDebriefSeat(d, session)) {
          case (?mySeat) {
            let partner = if (d.p1 == session) d.p2 else d.p1;
            self.stage(now, session, mySeat, ?partner);
            #ok(#awaitingPartner);
          };
          case null #err(#notSeated);
        };
      };

      case (#staging st) {
        if (st.session == session) { #ok(#awaitingPartner) } // idempotent
        else if (st.reservedFor == ?session) {
          self.startGame(spec, now, st, session);
          #ok(#started);
        } else {
          #err(#wrongPhase("another player is staging a game"));
        };
      };

      case (#active g) {
        if (Option.isSome(getSessionSeat(g, session))) {
          #err(#wrongPhase("your game is already running"));
        } else { #err(#notSeated) };
      };

      case (#empty) #err(#wrongPhase("no finished game to rematch"));
    };
  };

  /// Submit this round's move. `gen`/`turn` must match the match/round the
  /// caller last observed (see `Table.gen`'s own doc) — this is what lets
  /// a resent move whose original attempt secretly already resolved THIS
  /// round (or ended the match entirely) come back `#stale` instead of
  /// being replayed against whatever round/match happens to be current by
  /// the time the resend is processed. Within the SAME round, a duplicate
  /// submission is separately rejected via `#alreadySubmitted`, without
  /// consuming the turn; legality is enforced via `spec.validate` for both
  /// players. Resolves the round once both moves are in.
  public func submit<S, M>(self : Table<S, M>, spec : T.Spec<S, M>, now : Int, session : T.SessionId, gen : Nat, turn : Nat, move : M) : T.Res<T.SubmitOk> {
    switch (self.checkGen(gen)) {
      case (?e) return #err(e);
      case null {};
    };
    switch (self.phase) {
      case (#active g) {
        if (turn != g.turn) return #err(#stale);
        let mySeat = switch (getSessionSeat(g, session)) {
          case (?s) s;
          case null return #err(#notSeated);
        };
        let myPending = switch (mySeat) {
          case (#p1) g.pending1;
          case (#p2) g.pending2;
        };
        switch (myPending) {
          case (?_) return #err(#alreadySubmitted);
          case null {};
        };
        switch (spec.validate(g.game, mySeat, move)) {
          case (?why) return #err(#illegalMove(why));
          case null {};
        };

        let g2 : T.Active<S, M> = {
          p1 = g.p1;
          p2 = g.p2;
          game = g.game;
          pending1 = switch (mySeat) { case (#p1) ?move; case (#p2) g.pending1 };
          pending2 = switch (mySeat) { case (#p2) ?move; case (#p1) g.pending2 };
          turn = g.turn;
          lastActivity = now;
        };
        self.phase := #active(g2);

        switch (g2.pending1, g2.pending2) {
          case (?m1, ?m2) {
            let r = spec.resolve(g2.game, m1, m2);
            let turns = g2.turn + 1;
            switch (r.verdict) {
              case (?v) {
                self.enterDebrief(now, g2.p1, g2.p2, #finished(v), turns, r.state);
                #ok(#gameEnded { verdict = v; turns });
              };
              case null {
                self.phase := #active {
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
  ///
  /// `gen` must match the match the caller last observed (see `Table.gen`'s
  /// own doc) in every phase but `#empty` — without this, a resent `leave`
  /// whose original attempt secretly already landed (emptying a staging,
  /// aborting a game, or acking a debrief) can resurface after the SAME
  /// session has since started a brand-new match (most plausibly a
  /// same-partner rematch) and silently wipe/abort/ack THAT one instead,
  /// with no error at all — session identity alone can't tell an old
  /// match's leave apart from a new one's. `#empty` skips the check: there
  /// is nothing there for a stale leave to damage, and it must stay
  /// callable unconditionally to keep this idempotent.
  public func leave<S, M>(self : Table<S, M>, now : Int, session : T.SessionId, gen : Nat) : T.Res<()> {
    switch (self.phase) {

      case (#staging st) {
        switch (self.checkGen(gen)) {
          case (?e) return #err(e);
          case null {};
        };
        if (st.session == session) {
          self.phase := #empty;
          #ok(());
        } else { #err(#notSeated) };
      };

      case (#active g) {
        switch (self.checkGen(gen)) {
          case (?e) return #err(e);
          case null {};
        };
        switch (getSessionSeat(g, session)) {
          case (?mySeat) {
            self.enterDebrief(now, g.p1, g.p2, #aborted(mySeat), g.turn, g.game);
            #ok(());
          };
          case null #err(#notSeated);
        };
      };

      case (#debrief d) {
        switch (self.checkGen(gen)) {
          case (?e) return #err(e);
          case null {};
        };
        switch (getSessionSeat(d, session)) {
          case (?_) {
            self.debriefAcked := pushAck(self.debriefAcked, session);
            if (member(self.debriefAcked, d.p1) and member(self.debriefAcked, d.p2)) {
              self.phase := #empty; // both are done — free the board early
              self.debriefAcked := [];
            };
            #ok(());
          };
          case null #err(#notSeated);
        };
      };

      case (#empty) #ok(());
    };
  };

  /// Reset the board. Participants get leave-semantics (`gen`-checked, see
  /// `leave`'s own doc — a stale participant reset is exactly as dangerous
  /// as a stale `leave`, since this delegates straight to it); outsiders
  /// are gated by the idle timeout instead (with a countdown in the error
  /// until then) and never checked against `gen` — "free this board if
  /// it's been idle long enough" is valid no matter how stale the request
  /// making that observation is, since it's re-verified against the
  /// CURRENT `expired(...)` right here, not against any state the caller
  /// captured earlier.
  public func reset<S, M>(self : Table<S, M>, now : Int, session : T.SessionId, gen : Nat) : T.Res<()> {
    switch (self.phase) {
      case (#empty) #ok(());

      case (#staging st) {
        if (st.session == session) {
          switch (self.checkGen(gen)) {
            case (?e) return #err(e);
            case null {};
          };
          self.phase := #empty;
          #ok(());
        } else if (self.isExpired(st.since, now)) {
          self.phase := #empty;
          #ok(());
        } else { #err(#notIdle { secondsLeft = self.secsLeft(st.since, now) }) };
      };

      case (#active g) {
        if (Option.isSome(getSessionSeat(g, session))) {
          self.leave(now, session, gen); // participant reset = abort with shared debrief
        } else if (self.isExpired(g.lastActivity, now)) {
          self.noteEnded(g.p1, g.p2, []);
          self.phase := #empty;
          #ok(());
        } else {
          #err(#notIdle { secondsLeft = self.secsLeft(g.lastActivity, now) });
        };
      };

      case (#debrief d) {
        if (Option.isSome(getSessionSeat(d, session))) {
          self.leave(now, session, gen);
        } else if (self.isExpired(d.since, now)) {
          self.noteEnded(d.p1, d.p2, [d.p1, d.p2]); // they saw their debrief
          self.phase := #empty;
          #ok(());
        } else {
          #err(#notIdle { secondsLeft = self.secsLeft(d.since, now) });
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
  public func sweep<S, M>(self : Table<S, M>, now : Int) {
    switch (self.phase) {
      case (#empty) {};
      case (#staging st) {
        if (self.isExpired(st.since, now)) { self.phase := #empty };
      };
      case (#active g) {
        if (self.isExpired(g.lastActivity, now)) {
          self.noteEnded(g.p1, g.p2, []);
          self.phase := #empty;
        };
      };
      case (#debrief d) {
        if (self.isExpired(d.since, now)) {
          self.noteEnded(d.p1, d.p2, [d.p1, d.p2]); // they already saw it
          self.phase := #empty;
        };
      };
    };
  };

  /// Acknowledge an #endedByOther notice (host wires this to "return to
  /// base"). Only ever touches THIS session's own entry (if any) — a
  /// board can carry more than one still-pending notice at once, see
  /// `noteEnded`'s own doc — and drops that entry for good once every
  /// participant it names has acked it.
  public func ackEnded<S, M>(self : Table<S, M>, session : T.SessionId) {
    self.lastEnded := self.lastEnded.filterMap(
      func(e) {
        if (e.p1 != session and e.p2 != session) { return ?e };
        let acked = pushAck(e.acked, session);
        if (member(acked, e.p1) and member(acked, e.p2)) { null } else {
          ?{ p1 = e.p1; p2 = e.p2; acked };
        };
      }
    );
  };

  /// The one truthful, per-caller status view. Pure — safe as a query.
  public func status<S, M>(self : Table<S, M>, now : Int, session : T.SessionId) : T.View<S> {
    switch (self.phase) {

      case (#empty) {
        if (self.unackedEnded(session)) { #endedByOther } else {
          #lobby { p1Open = true; p2Open = true; resetAvailable = false };
        };
      };

      case (#staging st) {
        if (st.session == session) {
          // This branch never checks `self.isExpired(st.since, now)` — the
          // seat stays #stagingYou for its own occupant no matter how
          // idle it's gone (only a THIRD PARTY's `join` actually evicts
          // it, below). `secondsUntilReclaimable` is how that occupant
          // learns they're on a clock at all — without it, a host's UI
          // has nothing to warn "waiting for an opponent" with, and the
          // seat can vanish out from under them with no notice.
          #stagingYou {
            seat = st.seat;
            reservedForPartner = Option.isSome(st.reservedFor);
            secondsUntilReclaimable = self.secsLeft(st.since, now);
            gen = self.gen;
          };
        } else if (st.reservedFor == ?session) {
          #awaitingRematch { openSeat = T.otherSeat(st.seat) };
        } else if (self.unackedEnded(session)) {
          #endedByOther;
        } else {
          let ex = self.isExpired(st.since, now);
          if (Option.isSome(st.reservedFor) and not ex) {
            #busy { secondsUntilTakeover = self.secsLeft(st.since, now) };
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
        switch (getSessionSeat(g, session)) {
          case (?mySeat) {
            #inGame {
              seat = mySeat;
              game = g.game;
              turn = g.turn;
              youSubmitted = Option.isSome(switch (mySeat) { case (#p1) g.pending1; case (#p2) g.pending2 });
              oppSubmitted = Option.isSome(switch (mySeat) { case (#p1) g.pending2; case (#p2) g.pending1 });
              gen = self.gen;
            };
          };
          case null {
            if (self.unackedEnded(session)) { #endedByOther } else if (self.isExpired(g.lastActivity, now)) {
              #lobby { p1Open = true; p2Open = true; resetAvailable = true };
            } else {
              #busy {
                secondsUntilTakeover = self.secsLeft(g.lastActivity, now);
              };
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
        switch (self.activeDebriefSeat(d, session)) {
          case (?mySeat) {
            #debrief {
              seat = mySeat;
              end = d.end;
              turns = d.turns;
              finalGame = d.finalGame;
              gen = self.gen;
            };
          };
          case null {
            if (self.unackedEnded(session)) { #endedByOther } else if (self.isExpired(d.since, now)) {
              #lobby { p1Open = true; p2Open = true; resetAvailable = true };
            } else {
              #busy { secondsUntilTakeover = self.secsLeft(d.since, now) };
            };
          };
        };
      };
    };
  };

  func getSessionSeat<S, M>(phase : T.Active<S, M> or T.Debrief<S>, session : T.SessionId) : ?T.Seat {
    if (phase.p1 == session) { ?#p1 } else if (phase.p2 == session) { ?#p2 } else {
      null;
    };
  };

  func pushAck(xs : [T.SessionId], x : T.SessionId) : [T.SessionId] {
    for (y in xs.values()) { if (y == x) return xs };
    xs.concat([x]);
  };

  func member(xs : [T.SessionId], x : T.SessionId) : Bool {
    for (y in xs.values()) { if (y == x) return true };
    false;
  };

};
