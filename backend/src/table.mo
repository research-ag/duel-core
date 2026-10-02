import Array "mo:core/Array";
import Int "mo:core/Int";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Option "mo:core/Option";
import Text "mo:core/Text";

import T "./types";

module {

  public type Table<S, M> = T.Table<S, M>;

  public func new<S, M>(idleTimeoutNs : Int, claimTimeoutNs : Int, visibility : T.TableVisibility, createdBy : T.SessionId, variant : Text) : Table<S, M> = {
    var idleTimeoutNs = idleTimeoutNs;
    var claimTimeoutNs = claimTimeoutNs;
    visibility;
    createdBy;
    variant;
    var phase = #empty;
    var gen = 0;
    var lastEnded = [];
    var debriefAcked = [];
  };

  public func setTimeouts<S, M>(self : Table<S, M>, idleTimeoutNs : Int, claimTimeoutNs : Int) {
    self.idleTimeoutNs := idleTimeoutNs;
    self.claimTimeoutNs := claimTimeoutNs;
  };

  public func isExpired<S, M>(self : Table<S, M>, since : Int, now : Int) : Bool = now - since >= self.idleTimeoutNs;

  public func claimOverdue<S, M>(self : Table<S, M>, since : Int, now : Int) : Bool = now - since >= self.claimTimeoutNs;

  func secsLeftFor(timeoutNs : Int, since : Int, now : Int) : Nat {
    let left = timeoutNs - (now - since);
    if (left <= 0) { 0 } else { left.toNat() / 1_000_000_000 };
  };

  public func secsLeft<S, M>(self : Table<S, M>, since : Int, now : Int) : Nat = secsLeftFor(self.idleTimeoutNs, since, now);

  public func claimSecsLeft<S, M>(self : Table<S, M>, since : Int, now : Int) : Nat = secsLeftFor(self.claimTimeoutNs, since, now);

  /// Whose turn on an `#alternating` table: p1 at `turn == 0`, then
  /// alternating. Derived, never stored.
  public func toMove(turn : Nat) : T.Seat = if (turn % 2 == 0) #p1 else #p2;

  public func idleTimeoutSecs<S, M>(self : Table<S, M>) : Nat = self.idleTimeoutNs.toNat() / 1_000_000_000;

  public func claimTimeoutSecs<S, M>(self : Table<S, M>) : Nat = self.claimTimeoutNs.toNat() / 1_000_000_000;

  /// A session that already acked THIS debrief is no longer a participant
  /// (rule 12, "leave means left"), even while the phase lingers for the
  /// partner. Used by every debrief-phase operation except `leave` itself.
  public func activeDebriefSeat<S, M>(self : Table<S, M>, d : T.Debrief<S>, session : T.SessionId) : ?T.Seat {
    if (member(self.debriefAcked, session)) { null } else {
      getSessionSeat(d, session);
    };
  };

  /// The partner to reserve a rematch seat for — `null` if they already
  /// acked, so the staging opens unreserved instead of waiting forever.
  func rematchPartner<S, M>(self : Table<S, M>, d : T.Debrief<S>, session : T.SessionId) : ?T.SessionId {
    let partner = if (d.p1 == session) d.p2 else d.p1;
    if (member(self.debriefAcked, partner)) { null } else { ?partner };
  };

  /// Appends (a freed board can host another vanished pair before the
  /// first acks); skips an entry that is already fully acked.
  public func noteEnded<S, M>(self : Table<S, M>, now : Int, p1 : T.SessionId, p2 : T.SessionId, acked : [T.SessionId]) {
    if (member(acked, p1) and member(acked, p2)) return;
    self.lastEnded := self.lastEnded.concat([{ p1; p2; acked; since = now }]);
  };

  public func unackedEnded<S, M>(self : Table<S, M>, session : T.SessionId) : Bool {
    for (e in self.lastEnded.values()) {
      if ((e.p1 == session or e.p2 == session) and not member(e.acked, session)) {
        return true;
      };
    };
    false;
  };

  /// Whether `session` still has unfinished business here — what
  /// `Registry.releaseIfStale` uses to drop a `bySession` mapping the
  /// phase itself already moved past.
  public func isStillSeated<S, M>(self : Table<S, M>, session : T.SessionId) : Bool {
    switch (self.phase) {
      case (#empty) self.unackedEnded(session);
      case (#staging st) st.session == session;
      case (#active g) getSessionSeat(g, session).isSome();
      case (#debrief d) self.activeDebriefSeat(d, session).isSome();
    };
  };

  /// Drops notices nobody is plausibly coming back to ack; otherwise one
  /// dangling entry pins an `#empty` table in the registry forever.
  func pruneEnded<S, M>(self : Table<S, M>, now : Int) {
    self.lastEnded := self.lastEnded.filter(func(e) = now - e.since < self.idleTimeoutNs * 10);
  };

  public func checkGen<S, M>(self : Table<S, M>, gen : Nat) : ?T.Err = if (gen == self.gen) {
    null;
  } else { ?#stale };

  public func stage<S, M>(self : Table<S, M>, now : Int, session : T.SessionId, seat : T.Seat, reservedFor : ?T.SessionId) {
    self.gen += 1;
    self.phase := #staging { seat; session; reservedFor; since = now };
  };

  func initOf<S, M>(spec : T.Spec<S, M>, variant : Text) : S = switch (spec) {
    case (#simultaneous simSpec) simSpec.init(variant);
    case (#alternating turnSpec) turnSpec.init(variant);
  };

  public func startGame<S, M>(self : Table<S, M>, spec : T.Spec<S, M>, now : Int, st : T.Staging, joiner : T.SessionId) {
    let (p1, p2) = switch (st.seat) {
      case (#p1) (st.session, joiner);
      case (#p2) (joiner, st.session);
    };
    self.phase := #active {
      p1;
      p2;
      game = initOf(spec, self.variant);
      pending1 = null;
      pending2 = null;
      turn = 0;
      lastActivity = now;
      roundStartedAt = now;
      lastMoveP1 = null;
      lastMoveP2 = null;
      lastRoundDurationNs = null;
    };
  };

  public func enterDebrief<S, M>(self : Table<S, M>, now : Int, p1 : T.SessionId, p2 : T.SessionId, end : T.End, turns : Nat, finalGame : S) {
    self.debriefAcked := [];
    self.phase := #debrief { p1; p2; end; turns; finalGame; since = now };
  };

  /// Claim a seat: fresh join, seat switch while staging alone, idempotent
  /// re-join, reservation enforcement, idle takeover of a game or an
  /// expired debrief, or (for a debrief participant) a rematch staging
  /// with a free choice of seat. A staged seat is never taken over: only
  /// `sweep` frees it.
  public func join<S, M>(self : Table<S, M>, spec : T.Spec<S, M>, now : Int, session : T.SessionId, seat : T.Seat) : T.Res<T.JoinOk> {
    switch (self.phase) {

      case (#empty) {
        self.stage(now, session, seat, null);
        #ok(#staged(seat));
      };

      case (#staging st) {
        if (st.session == session) {
          if (st.seat == seat) { #ok(#staged(seat)) } else {
            self.phase := #staging {
              seat;
              session;
              reservedFor = st.reservedFor;
              since = now;
            };
            #ok(#staged(seat));
          };
        } else if (st.seat == seat) { #err(#seatTaken) } else {
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
        if (getSessionSeat(g, session).isSome()) {
          #err(#wrongPhase("you are already in the running game"));
        } else if (self.isExpired(g.lastActivity, now)) {
          self.noteEnded(now, g.p1, g.p2, []);
          self.stage(now, session, seat, null);
          #ok(#staged(seat));
        } else {
          #err(#notIdle { secondsLeft = self.secsLeft(g.lastActivity, now) });
        };
      };

      case (#debrief d) {
        switch (self.activeDebriefSeat(d, session)) {
          case (?_) {
            self.stage(now, session, seat, self.rematchPartner(d, session));
            #ok(#staged(seat));
          };
          case null {
            if (self.isExpired(d.since, now)) {
              self.noteEnded(now, d.p1, d.p2, [d.p1, d.p2]); // they already saw it
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

  /// From a debrief: stage a rematch on your previous seat, reserved for
  /// the partner unless they already left. From a staging reserved for
  /// you: start the game. Two simultaneous calls serialize into
  /// create-then-join.
  public func rematch<S, M>(self : Table<S, M>, spec : T.Spec<S, M>, now : Int, session : T.SessionId) : T.Res<T.RematchOk> {
    switch (self.phase) {

      case (#debrief d) {
        switch (self.activeDebriefSeat(d, session)) {
          case (?mySeat) {
            self.stage(now, session, mySeat, self.rematchPartner(d, session));
            #ok(#awaitingPartner);
          };
          case null #err(#notSeated);
        };
      };

      case (#staging st) {
        if (st.session == session) { #ok(#awaitingPartner) } else if (st.reservedFor == ?session) {
          self.startGame(spec, now, st, session);
          #ok(#started);
        } else {
          #err(#wrongPhase("another player is staging a game"));
        };
      };

      case (#active g) {
        if (getSessionSeat(g, session).isSome()) {
          #err(#wrongPhase("your game is already running"));
        } else { #err(#notSeated) };
      };

      case (#empty) #err(#wrongPhase("no finished game to rematch"));
    };
  };

  /// `gen`/`turn` must match what the caller last observed, so a resend
  /// whose original already resolved this round comes back `#stale`.
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
        switch (spec) {

          case (#simultaneous simSpec) {
            let myPending = switch (mySeat) {
              case (#p1) g.pending1;
              case (#p2) g.pending2;
            };
            switch (myPending) {
              case (?_) return #err(#alreadySubmitted);
              case null {};
            };
            switch (simSpec.validate(g.game, mySeat, move)) {
              case (?why) return #err(#illegalMove(why));
              case null {};
            };

            let g2 : T.Active<S, M> = {
              p1 = g.p1;
              p2 = g.p2;
              game = g.game;
              pending1 = switch (mySeat) {
                case (#p1) ?move;
                case (#p2) g.pending1;
              };
              pending2 = switch (mySeat) {
                case (#p2) ?move;
                case (#p1) g.pending2;
              };
              turn = g.turn;
              lastActivity = now;
              roundStartedAt = g.roundStartedAt;
              lastMoveP1 = g.lastMoveP1;
              lastMoveP2 = g.lastMoveP2;
              lastRoundDurationNs = g.lastRoundDurationNs;
            };
            self.phase := #active(g2);

            switch (g2.pending1, g2.pending2) {
              case (?m1, ?m2) {
                let r = simSpec.resolve(g2.game, m1, m2);
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
                      roundStartedAt = now;
                      lastMoveP1 = ?m1;
                      lastMoveP2 = ?m2;
                      lastRoundDurationNs = ?(now - g2.roundStartedAt);
                    };
                    #ok(#roundResolved(turns));
                  };
                };
              };
              case (_) #ok(#waiting);
            };
          };

          // Resolves immediately; `pending1`/`pending2` stay `null`.
          case (#alternating turnSpec) {
            if (mySeat != toMove(g.turn)) return #err(#notYourTurn);
            switch (turnSpec.validate(g.game, mySeat, move)) {
              case (?why) return #err(#illegalMove(why));
              case null {};
            };

            let r = turnSpec.resolve(g.game, mySeat, move);
            let turns = g.turn + 1;
            switch (r.verdict) {
              case (?v) {
                self.enterDebrief(now, g.p1, g.p2, #finished(v), turns, r.state);
                #ok(#gameEnded { verdict = v; turns });
              };
              case null {
                self.phase := #active {
                  p1 = g.p1;
                  p2 = g.p2;
                  game = r.state;
                  pending1 = null;
                  pending2 = null;
                  turn = turns;
                  lastActivity = now;
                  roundStartedAt = now;
                  lastMoveP1 = switch (mySeat) {
                    case (#p1) ?move;
                    case (#p2) g.lastMoveP1;
                  };
                  lastMoveP2 = switch (mySeat) {
                    case (#p2) ?move;
                    case (#p1) g.lastMoveP2;
                  };
                  lastRoundDurationNs = ?(now - g.roundStartedAt);
                };
                #ok(#roundResolved(turns));
              };
            };
          };
        };
      };
      case (_) #err(#wrongPhase("no game is running"));
    };
  };

  /// The waiting seat ends the match with `#claimed` once the opponent's
  /// move has been pending past `claimTimeoutNs`. `resolve` is not run;
  /// the game state stays as it was. Never automatic.
  public func claimWin<S, M>(self : Table<S, M>, spec : T.Spec<S, M>, now : Int, session : T.SessionId, gen : Nat) : T.Res<()> {
    switch (self.checkGen(gen)) {
      case (?e) return #err(e);
      case null {};
    };
    switch (self.phase) {
      case (#active g) {
        let mySeat = switch (getSessionSeat(g, session)) {
          case (?s) s;
          case null return #err(#notSeated);
        };
        switch (spec) {
          case (#simultaneous _) {
            let (myPending, oppPending) = switch (mySeat) {
              case (#p1) (g.pending1, g.pending2);
              case (#p2) (g.pending2, g.pending1);
            };
            if (myPending.isNull()) {
              return #err(#wrongPhase("submit your own move before you can claim a win"));
            };
            if (oppPending.isSome()) {
              return #err(#wrongPhase("your opponent already moved"));
            };
          };
          case (#alternating _) {
            if (mySeat == toMove(g.turn)) {
              return #err(#wrongPhase("it's your turn to move — only the waiting player may claim"));
            };
          };
        };
        if (not self.claimOverdue(g.lastActivity, now)) {
          return #err(#notOverdue { secondsLeft = self.claimSecsLeft(g.lastActivity, now) });
        };
        self.enterDebrief(now, g.p1, g.p2, #claimed(mySeat), g.turn, g.game);
        #ok(());
      };
      case (_) #err(#wrongPhase("no game is running"));
    };
  };

  /// Own staging: empties the board. A staging reserved for you: declines
  /// (clears just the reservation). Live game: shared `#aborted` debrief.
  /// Debrief: acks it for you; the board frees once both have acked.
  /// `gen`-checked in every phase but `#empty`, so a stale resend can't
  /// wipe a newer match the same session later started.
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
        } else if (st.reservedFor == ?session) {
          self.phase := #staging {
            seat = st.seat;
            session = st.session;
            reservedFor = null;
            since = st.since;
          };
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
              self.phase := #empty;
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

  /// Participants get `leave` semantics (`gen`-checked); outsiders are
  /// gated by the idle timeout and never checked against `gen`, and can't
  /// reset a staging at all.
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
        } else { #err(#seatTaken) };
      };

      case (#active g) {
        if (getSessionSeat(g, session).isSome()) {
          self.leave(now, session, gen);
        } else if (self.isExpired(g.lastActivity, now)) {
          self.noteEnded(now, g.p1, g.p2, []);
          self.phase := #empty;
          #ok(());
        } else {
          #err(#notIdle { secondsLeft = self.secsLeft(g.lastActivity, now) });
        };
      };

      case (#debrief d) {
        if (getSessionSeat(d, session).isSome()) {
          self.leave(now, session, gen);
        } else if (self.isExpired(d.since, now)) {
          self.noteEnded(now, d.p1, d.p2, [d.p1, d.p2]);
          self.phase := #empty;
          #ok(());
        } else {
          #err(#notIdle { secondsLeft = self.secsLeft(d.since, now) });
        };
      };
    };
  };

  /// Idle eviction with no visitor required, plus `pruneEnded`. Driven by
  /// the host's periodic timer. A staging survives while its occupant
  /// `isPresent`; a game or debrief is evicted regardless.
  public func sweep<S, M>(self : Table<S, M>, now : Int, isPresent : T.SessionId -> Bool) {
    switch (self.phase) {
      case (#empty) {};
      case (#staging st) {
        if (self.isExpired(st.since, now) and not isPresent(st.session)) {
          self.phase := #empty;
        };
      };
      case (#active g) {
        if (self.isExpired(g.lastActivity, now)) {
          self.noteEnded(now, g.p1, g.p2, []);
          self.phase := #empty;
        };
      };
      case (#debrief d) {
        if (self.isExpired(d.since, now)) {
          self.noteEnded(now, d.p1, d.p2, [d.p1, d.p2]);
          self.phase := #empty;
        };
      };
    };
    self.pruneEnded(now);
  };

  /// Acks this session's own `#endedByOther` notice; the entry is dropped
  /// once every participant it names has acked.
  public func ackEnded<S, M>(self : Table<S, M>, session : T.SessionId) {
    self.lastEnded := self.lastEnded.filterMap(
      func(e) {
        if (e.p1 != session and e.p2 != session) { return ?e };
        let acked = pushAck(e.acked, session);
        if (member(acked, e.p1) and member(acked, e.p2)) { null } else {
          ?{ p1 = e.p1; p2 = e.p2; acked; since = e.since };
        };
      }
    );
  };

  /// Pure — safe as a query. Takes `spec` only to report `mode` and the
  /// per-mode meaning of `youSubmitted`/`oppSubmitted`.
  public func status<S, M>(self : Table<S, M>, spec : T.Spec<S, M>, now : Int, session : T.SessionId) : T.View<S> {
    switch (self.phase) {

      case (#empty) {
        if (self.unackedEnded(session)) { #endedByOther } else {
          #lobby { p1Open = true; p2Open = true; resetAvailable = false };
        };
      };

      case (#staging st) {
        if (st.session == session) {
          #stagingYou {
            seat = st.seat;
            reservedForPartner = st.reservedFor.isSome();
            gen = self.gen;
            visibility = self.visibility;
          };
        } else if (st.reservedFor == ?session) {
          #awaitingRematch { openSeat = T.otherSeat(st.seat); gen = self.gen };
        } else if (self.unackedEnded(session)) {
          #endedByOther;
        } else {
          if (st.reservedFor.isSome() and not self.isExpired(st.since, now)) {
            #busy { secondsUntilTakeover = self.secsLeft(st.since, now) };
          } else {
            #lobby {
              p1Open = st.seat != #p1;
              p2Open = st.seat != #p2;
              resetAvailable = false;
            };
          };
        };
      };

      case (#active g) {
        switch (getSessionSeat(g, session)) {
          case (?mySeat) {
            let mode : T.Mode = switch (spec) {
              case (#simultaneous _) #simultaneous;
              case (#alternating _) #alternating;
            };
            let (youSubmitted, oppSubmitted) = switch (spec) {
              case (#simultaneous _) (
                (switch (mySeat) { case (#p1) g.pending1; case (#p2) g.pending2 }).isSome(),
                (switch (mySeat) { case (#p1) g.pending2; case (#p2) g.pending1 }).isSome(),
              );
              case (#alternating _) {
                let onTurn = mySeat == toMove(g.turn);
                (not onTurn, onTurn);
              };
            };
            #inGame {
              seat = mySeat;
              game = g.game;
              turn = g.turn;
              mode;
              youSubmitted;
              oppSubmitted;
              gen = self.gen;
              secondsUntilIdleReset = self.secsLeft(g.lastActivity, now);
              idleTimeoutSecs = self.idleTimeoutSecs();
              claimWinAvailable = youSubmitted and not oppSubmitted and self.claimOverdue(g.lastActivity, now);
              secondsUntilClaimable = self.claimSecsLeft(g.lastActivity, now);
              claimTimeoutSecs = self.claimTimeoutSecs();
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
