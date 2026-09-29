import Array "mo:core/Array";
import Int "mo:core/Int";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Option "mo:core/Option";
import Text "mo:core/Text";

import PT "mo:promtracker";
import Tracker "mo:promtracker/Tracker";

import Table "./table";
import T "./types";

/// A multi-table extension of the single-`Table`: many
/// independent boards, each identified by a `TableId`, created and
/// discovered through one shared `Registry`. Every function here is a
/// thin router — it resolves which `Table` a call is actually about
/// (by `TableId`, for `createTable`/`joinTable`; by looking up the
/// caller's own current table otherwise) and delegates straight into
/// the matching operation above; no game state or legality is
/// reimplemented in this module. A host actor wires `Ws.attach` to a
/// `Registry` (see `../README.md`'s "Real-time push" section) instead
/// of a bare `Table` — that's the only thing that changes in how a
/// game gets plugged in; `Spec`'s `init`/`validate`/`resolve` don't
/// know or care how many tables exist.
///
/// A game that genuinely wants exactly one fixed board can still use
/// `create`/`join`/`submit`/... directly above — `Lobby` is built on
/// top of them, not a replacement for them.
module {

  public type Registry<S, M> = T.Registry<S, M>;

  public func new<S, M>(idleTimeoutNs : Int, claimTimeoutNs : Int) : Registry<S, M> = {
    idleTimeoutNs;
    claimTimeoutNs;
    var tables = Map.empty<T.TableId, T.Table<S, M>>();
    var bySession = Map.empty<T.SessionId, T.TableId>();
    var tableIdNonce = 1;
    var gamesStarted = null;
    var activeGames = null;
    var roundsPerGame = null;
    var matchmakingWaitSecs = null;
  };

  public func attachMetrics<S, M>(self : Registry<S, M>, pt : PT.Tracker) {
    if (self.gamesStarted.isNull()) {
      self.gamesStarted := ?pt.newCounter("games_started", []);
    };
    if (self.activeGames.isNull()) {
      self.activeGames := ?pt.newGauge("active_games", [], []);
    };
    if (self.roundsPerGame.isNull()) {
      self.roundsPerGame := ?pt.newGauge("rounds_per_game", [], []);
    };
    if (self.matchmakingWaitSecs.isNull()) {
      self.matchmakingWaitSecs := ?pt.newGauge("matchmaking_wait_seconds", [], []);
    };
  };

  // ────────────────────── internal helpers ──────────────────────────────

  func recordActiveGames<S, M>(self : Registry<S, M>) {
    switch (self.activeGames) {
      case null {};
      case (?g) {
        var n = 0;
        for (t in self.tables.values()) {
          switch (t.phase) {
            case (#active _) n += 1;
            case (_) {};
          };
        };
        PT.Gauge.update(g, n);
      };
    };
  };

  func bumpGamesStarted<S, M>(self : Registry<S, M>) {
    switch (self.gamesStarted) {
      case null {};
      case (?c) PT.Counter.add(c, 1);
    };
  };

  func recordRoundsPerGame<S, M>(self : Registry<S, M>, t : T.Table<S, M>) {
    switch (self.roundsPerGame) {
      case null {};
      case (?g) switch (t.phase) {
        case (#debrief d) PT.Gauge.update(g, d.turns);
        case (_) {};
      };
    };
  };

  func stagingSince<S, M>(t : T.Table<S, M>) : ?Int = switch (t.phase) {
    case (#staging st) ?st.since;
    case (_) null;
  };

  func recordMatchmakingWait<S, M>(self : Registry<S, M>, now : Int, since : ?Int) {
    switch (self.matchmakingWaitSecs, since) {
      case (?g, ?s) {
        let waited = now - s;
        PT.Gauge.update(g, if (waited <= 0) { 0 } else { waited.toNat() / 1_000_000_000 });
      };
      case (_, _) {};
    };
  };

  /// Whether (and since when) a table would present an open seat to a
  /// generic, not-yet-seated visitor right now — the same outsider
  /// view `status` above already computes per phase, minus the
  /// per-session `unackedEnded` check (meaningless for a listing
  /// nobody has "asked" about yet). `null` = not currently joinable
  /// (occupied, or reserved/idle-but-not-yet-expired). This is what
  /// keeps an idle-abandoned table — in ANY phase — reachable through
  /// `listTables`, not just a table whose id a visitor already
  /// happens to know: without it, "no ghost lobbies" would silently
  /// stop applying to every table but the one you already have a link
  /// to. `p1Session`/`p2Session` name whichever session currently holds a
  /// NOT-open seat — only ever non-null out of the `#staging` branch
  /// below (the one phase `listTables` surfaces with exactly one seat
  /// genuinely taken by a specific, still-there occupant); every other
  /// branch reports both seats open with nobody in particular to name
  /// (an idle-reclaimable board resets to a clean slate, not "join the
  /// ghost who's still technically listed here").
  func openness<S, M>(t : T.Table<S, M>, now : Int) : ?{
    p1Open : Bool;
    p2Open : Bool;
    p1Session : ?T.SessionId;
    p2Session : ?T.SessionId;
    since : Int;
  } {
    switch (t.phase) {
      case (#empty) ?{
        p1Open = true;
        p2Open = true;
        p1Session = null;
        p2Session = null;
        since = now;
      };
      case (#staging st) {
        let ex = t.isExpired(st.since, now);
        if (st.reservedFor.isSome() and not ex) { null } else {
          let p1Open = st.seat != #p1 or ex;
          let p2Open = st.seat != #p2 or ex;
          ?{
            p1Open;
            p2Open;
            p1Session = if (p1Open) null else ?st.session;
            p2Session = if (p2Open) null else ?st.session;
            since = st.since;
          };
        };
      };
      case (#active g) {
        if (t.isExpired(g.lastActivity, now)) {
          ?{
            p1Open = true;
            p2Open = true;
            p1Session = null;
            p2Session = null;
            since = g.lastActivity;
          };
        } else { null };
      };
      case (#debrief d) {
        if (t.isExpired(d.since, now)) {
          ?{
            p1Open = true;
            p2Open = true;
            p1Session = null;
            p2Session = null;
            since = d.since;
          };
        } else { null };
      };
    };
  };

  func waitingSecs(since : Int, now : Int) : Nat {
    let elapsed = now - since;
    if (elapsed <= 0) { 0 } else { elapsed.toNat() / 1_000_000_000 };
  };

  /// A table that's quiesced (`#empty`, and nobody is still owed an
  /// `#endedByOther` notice) carries no state worth keeping around —
  /// drop it from the registry so ids don't accumulate forever. Skipped
  /// otherwise: an `#empty` table can still owe an ack (see `noteEnded`'s
  /// own doc) — cleared by that ack, or eventually by `Table.pruneEnded`
  /// (driven by the periodic `sweep` a host wires, same as this GC check
  /// itself) once nobody's plausibly still coming back to give one. Until
  /// either happens, this table keeps resurfacing through `listTables`
  /// looking freshly opened — see `openness`'s `#empty` branch.
  func gcIfQuiesced<S, M>(reg : Registry<S, M>, id : T.TableId, t : T.Table<S, M>) {
    switch (t.phase) {
      case (#empty) {
        if (t.lastEnded.size() == 0) {
          reg.tables.remove(id);
        };
      };
      case (_) {};
    };
  };

  func alreadyAtATable<S, M>(reg : Registry<S, M>, session : T.SessionId) : Bool = reg.bySession.get(session).isSome();

  /// Drops `session`'s `bySession` mapping if the table it points to no
  /// longer considers them seated `now` (`Table.isStillSeated`) — see
  /// that function's own doc for the ways a phase transition can move on
  /// without ever routing through `leave`/`reset`/`ackEnded`. Without
  /// this, `alreadyAtATable` reports `true` forever once that happens
  /// (even past the table itself getting GC'd out of `reg.tables`
  /// entirely), permanently refusing every later `createTable`/
  /// `joinTable` for that session. Called at the top of both — the only
  /// two ops that gate on `alreadyAtATable` — so a session that's
  /// actually free to start something new isn't refused over
  /// bookkeeping the phase itself already left behind.
  func releaseIfStale<S, M>(reg : Registry<S, M>, session : T.SessionId, now : Int) {
    switch (reg.bySession.get(session)) {
      case null {};
      case (?id) switch (reg.tables.get(id)) {
        case null reg.bySession.remove(session); // stale mapping onto an already-GC'd table
        case (?t) {
          if (not t.isStillSeated(now, session)) {
            reg.bySession.remove(session);
            gcIfQuiesced(reg, id, t);
          };
        };
      };
    };
  };

  /// Resolves `session`'s current table (if any) and runs `op` against
  /// it — the shared shape every routed mutating call below follows.
  func withTable<S, M, T>(
    reg : Registry<S, M>,
    session : T.SessionId,
    op : (T.Table<S, M>) -> T.Res<T>,
  ) : T.Res<T> {
    switch (reg.bySession.get(session)) {
      case null #err(#notSeated);
      case (?id) switch (reg.tables.get(id)) {
        case null #err(#notSeated); // stale mapping onto an already-GC'd table
        case (?t) op(t);
      };
    };
  };

  /// Clears `session`'s own table mapping after a successful `leave`/
  /// `reset` — see `leave`'s own doc below — and GCs that table if
  /// this was the last thing keeping it around.
  func returnToLobby<S, M>(reg : Registry<S, M>, session : T.SessionId) {
    switch (reg.bySession.get(session)) {
      case null {};
      case (?id) {
        reg.bySession.remove(session);
        switch (reg.tables.get(id)) {
          case (?t) gcIfQuiesced(reg, id, t);
          case null {};
        };
      };
    };
  };

  // ────────────────────── operations ─────────────────────────────────────

  /// Lists every table with at least one open seat right now — a
  /// `#code`-protected table included, just flagged `protected = true`
  /// and never carrying its own code (that stays known only to its own
  /// occupant, via their own `#stagingYou` view — see `View`'s own doc):
  /// a browsing visitor can see a protected table exists, that it needs a
  /// code, and who (if anyone) is already seated on it, but has to be
  /// handed the code itself out of band before `joinTable` will actually
  /// seat them on it.
  public func listTables<S, M>(self : Registry<S, M>, now : Int) : [T.TableSummary] {
    let withSummaries = Map.filterMap<T.TableId, T.Table<S, M>, T.TableSummary>(
      self.tables,
      Nat.compare,
      func(id, t) {
        switch (openness(t, now)) {
          case null null;
          case (?o) ?{
            id;
            p1Open = o.p1Open;
            p2Open = o.p2Open;
            p1Session = o.p1Session;
            p2Session = o.p2Session;
            protected = t.visibility != #open;
            waitingSecs = waitingSecs(o.since, now);
            variant = t.variant;
          };
        };
      },
    );
    withSummaries.toArray().map<(T.TableId, T.TableSummary), T.TableSummary>(func((_, v)) = v);
  };

  /// The `TableId` the next `createTable`/`createTableReserving` call on
  /// this registry will assign — a pure, side-effect-free peek at
  /// `tableIdNonce` (as safe to call as `status`; see architecture rule
  /// 8), not a reservation. Exists so a caller that needs to derive
  /// something FROM a table's id — `canister_players.mo`'s own
  /// `sidForCanister`, keyed per board rather than per caller, is the one
  /// user today — can compute that derivation before the id is otherwise
  /// knowable, i.e. before `createTable` itself returns. Only valid to
  /// rely on with no `await`/`await*` between this call and the
  /// `createTable` call it's paired with: this registry is single-
  /// threaded within one update call, but nothing stops another table
  /// being created in between two separate messages.
  public func peekNextTableId<S, M>(self : Registry<S, M>) : T.TableId = self.tableIdNonce;

  /// Create a fresh table and seat `session` in `seat` on it. Rejects
  /// with `#badCode` for a `#code("")` visibility — an empty access code
  /// isn't just pointless, it's unreachable BY CONSTRUCTION: `joinTable`
  /// below sends no code at all whenever its own code field is empty, so
  /// an empty stored code could never be matched — the table would sit
  /// protected and staged forever with nobody, not even a friend told
  /// the table number, able to join it. Rejects with `#wrongPhase` if
  /// `session` already has unfinished business at another table (a live
  /// seat, an open debrief, an unacked `#endedByOther` notice) — leave/
  /// ack that first. `variant` is this table's own rules variant (see
  /// `Table.variant`'s own doc) — opaque to the registry, stored as-is
  /// and handed to `Spec.init` once the match actually starts; a game
  /// with no modes of its own simply ignores whatever text arrives here.
  public func createTable<S, M>(
    self : Registry<S, M>,
    spec : T.Spec<S, M>,
    now : Int,
    session : T.SessionId,
    seat : T.Seat,
    visibility : T.TableVisibility,
    variant : Text,
  ) : T.Res<T.TableId> {
    switch (visibility) {
      case (#code c) { if (c.size() == 0) return #err(#badCode) };
      case (#open) {};
    };
    releaseIfStale(self, session, now);
    if (alreadyAtATable(self, session)) {
      return #err(#wrongPhase("you are already at another table"));
    };
    let id = self.tableIdNonce;
    let t = Table.new<S, M>(self.idleTimeoutNs, self.claimTimeoutNs, visibility, session, variant);
    switch (t.join(spec, now, session, seat)) {
      case (#err e) #err(e); // unreachable on a brand-new table; kept for exhaustiveness
      case (#ok _) {
        self.tableIdNonce += 1;
        self.tables.add(id, t);
        self.bySession.add(session, id);
        #ok(id);
      };
    };
  };

  /// Flow 2, "eager dual-seat assignment" (see `../../CLAUDE.md`'s
  /// "Canister players" note): like `createTable` above, but ALSO seats
  /// `reservedFor` in the other seat atomically, in this SAME call — the
  /// table lands directly in `#active`, with no second `joinTable` call
  /// needed from either side (contrast plain `createTable` plus
  /// `Table.stage`'s own `reservedFor` widening, which only RESERVES the
  /// other seat for someone to claim later). Shares `createTable`'s own
  /// validation (`#badCode`/`#wrongPhase` for `session` already being
  /// elsewhere); ADDITIONALLY rejects with `#wrongPhase` if `reservedFor`
  /// is `session` itself (nothing here can atomically seat one session
  /// against itself) or if `reservedFor` already has unfinished business
  /// at another table — the exact same one-table-at-a-time invariant
  /// `releaseIfStale`/`alreadyAtATable` already enforce for `session`,
  /// just checked for the OTHER seat's own occupant too, since this
  /// function is the one place seating them doesn't go through
  /// `joinTable`'s own guard.
  public func createTableReserving<S, M>(
    self : Registry<S, M>,
    spec : T.Spec<S, M>,
    now : Int,
    session : T.SessionId,
    seat : T.Seat,
    visibility : T.TableVisibility,
    reservedFor : T.SessionId,
    variant : Text,
  ) : T.Res<T.TableId> {
    switch (visibility) {
      case (#code c) { if (c.size() == 0) return #err(#badCode) };
      case (#open) {};
    };
    if (reservedFor == session) {
      return #err(#wrongPhase("cannot reserve yourself for the other seat"));
    };
    releaseIfStale(self, session, now);
    if (alreadyAtATable(self, session)) {
      return #err(#wrongPhase("you are already at another table"));
    };
    releaseIfStale(self, reservedFor, now);
    if (alreadyAtATable(self, reservedFor)) {
      return #err(#wrongPhase("the other seat's own session is already at another table"));
    };
    let id = self.tableIdNonce;
    let t = Table.new<S, M>(self.idleTimeoutNs, self.claimTimeoutNs, visibility, session, variant);
    t.stage(now, session, seat, ?reservedFor);
    let otherSeat = switch (seat) { case (#p1) #p2; case (#p2) #p1 };
    switch (t.join(spec, now, reservedFor, otherSeat)) {
      case (#err e) return #err(e); // unreachable — a fresh staging reserved for exactly this session always accepts its own reservation; kept for exhaustiveness
      case (#ok _) {};
    };
    self.tableIdNonce += 1;
    self.tables.add(id, t);
    self.bySession.add(session, id);
    self.bySession.add(reservedFor, id);
    bumpGamesStarted(self);
    recordMatchmakingWait(self, now, ?now); // staged and started in the same instant — zero wait, recorded for consistency with joinTable's own accounting
    recordActiveGames(self);
    #ok(id);
  };

  /// Join a specific table by id. Covers every case plain `join` above
  /// does (switching seats while alone staging, a veteran rejoining
  /// from their own debrief to start a rematch, idle takeover of an
  /// abandoned table) — `code` is only inspected for a `#code`
  /// -protected table, and must match exactly.
  public func joinTable<S, M>(
    self : Registry<S, M>,
    spec : T.Spec<S, M>,
    now : Int,
    session : T.SessionId,
    id : T.TableId,
    seat : T.Seat,
    code : ?Text,
  ) : T.Res<T.JoinOk> {
    releaseIfStale(self, session, now);
    if (alreadyAtATable(self, session)) {
      return #err(#wrongPhase("you are already at another table"));
    };
    let t = switch (self.tables.get(id)) {
      case (?t) switch (t.visibility) {
        case (#code c) { if (code != ?c) return #err(#badCode) else { t } };
        case (#open) t;
      };
      case null return #err(#noSuchTable);
    };
    let waitSince = stagingSince(t);
    switch (t.join(spec, now, session, seat)) {
      case (#err e) #err(e);
      case (#ok j) {
        self.bySession.add(session, id);
        switch (j) {
          case (#started _) {
            bumpGamesStarted(self);
            recordMatchmakingWait(self, now, waitSince);
          };
          case (#staged _) {};
        };
        recordActiveGames(self);
        #ok(j);
      };
    };
  };

  public func submit<S, M>(
    self : Registry<S, M>,
    spec : T.Spec<S, M>,
    now : Int,
    session : T.SessionId,
    gen : Nat,
    turn : Nat,
    move : M,
  ) : T.Res<T.SubmitOk> = withTable<S, M, T.SubmitOk>(
    self,
    session,
    func(t) {
      let r = t.submit(spec, now, session, gen, turn, move);
      switch (r) {
        case (#ok(#gameEnded _)) {
          recordActiveGames(self); // #active -> #debrief
          recordRoundsPerGame(self, t);
        };
        case (_) {};
      };
      r;
    },
  );

  public func rematch<S, M>(self : Registry<S, M>, spec : T.Spec<S, M>, now : Int, session : T.SessionId) : T.Res<T.RematchOk> = withTable<S, M, T.RematchOk>(
    self,
    session,
    func(t) {
      let waitSince = stagingSince(t);
      let r = t.rematch(spec, now, session);
      switch (r) {
        case (#ok(#started)) {
          // #staging -> #active
          bumpGamesStarted(self);
          recordActiveGames(self);
          recordMatchmakingWait(self, now, waitSince);
        };
        case (_) {};
      };
      r;
    },
  );

  public func claimWin<S, M>(self : Registry<S, M>, spec : T.Spec<S, M>, now : Int, session : T.SessionId, gen : Nat) : T.Res<()> = withTable<S, M, ()>(
    self,
    session,
    func(t) {
      let r = t.claimWin(spec, now, session, gen);
      switch (r) {
        case (#ok _) {
          recordActiveGames(self); // #active -> #debrief
          recordRoundsPerGame(self, t);
        };
        case (#err _) {};
      };
      r;
    },
  );

  /// Whether a `leave`/`reset` call about to run against `t` is the
  /// ABORT case — leaving a live game — rather than a plain staging
  /// walkout or a debrief ack. Decided from the phase BEFORE the call:
  /// `leave`'s own `#active` branch turns it INTO a shared `#aborted`
  /// debrief in that same step, and the leaver is deliberately NOT
  /// auto-acked by it (see plain `leave`'s own doc / architecture rule
  /// 7 "no silent endings") — they still see that debrief themselves,
  /// same as their opponent, so `session` must stay mapped to this
  /// table for their own next `status` to resolve it. Only a call that
  /// ISN'T an abort (a solo staging walkout, or a genuine debrief ack)
  /// returns `session` to "browsing".
  func isAbort<S, M>(t : T.Table<S, M>) : Bool = switch (t.phase) {
    case (#active _) true;
    case (_) false;
  };

  public func leave<S, M>(self : Registry<S, M>, now : Int, session : T.SessionId, gen : Nat) : T.Res<()> = withTable<S, M, ()>(
    self,
    session,
    func(t) {
      let abort = isAbort(t);
      let r = t.leave(now, session, gen);
      switch (r) {
        case (#ok _) {
          if (abort) {
            recordActiveGames(self); // #active -> #debrief
            recordRoundsPerGame(self, t);
          } else {
            returnToLobby(self, session);
          };
        };
        case (#err _) {};
      };
      r;
    },
  );

  public func reset<S, M>(self : Registry<S, M>, now : Int, session : T.SessionId, gen : Nat) : T.Res<()> = withTable<S, M, ()>(
    self,
    session,
    func(t) {
      let abort = isAbort(t);
      let r = t.reset(now, session, gen);
      switch (r) {
        case (#ok _) {
          if (abort) {
            recordActiveGames(self); // #active -> #debrief/#empty
            recordRoundsPerGame(self, t);
          } else {
            returnToLobby(self, session);
          };
        };
        case (#err _) {};
      };
      r;
    },
  );

  /// Same as plain `ackEnded` above, except it ALSO returns `session`
  /// to "browsing" — acking an `#endedByOther` notice IS the "return
  /// to lobby" action, so it should hand the session back to the
  /// browsable list, not leave it pointed at the table it just left.
  public func ackEnded<S, M>(self : Registry<S, M>, session : T.SessionId) {
    switch (self.bySession.get(session)) {
      case null {};
      case (?id) switch (self.tables.get(id)) {
        case (?t) t.ackEnded(session);
        case null {};
      };
    };
    returnToLobby(self, session);
  };

  public func status<S, M>(self : Registry<S, M>, spec : T.Spec<S, M>, now : Int, session : T.SessionId) : T.SessionStatus<S> {
    switch (self.bySession.get(session)) {
      case (?id) switch (self.tables.get(id)) {
        case (?t) #atTable({ id; view = t.status(spec, now, session) });
        case null #browsing({ tables = listTables(self, now) }); // stale mapping onto an already-GC'd table
      };
      case null #browsing({ tables = listTables(self, now) });
    };
  };

  /// Idle-eviction across every table in the registry — see plain
  /// `sweep` above for what it does per table. Meant to be driven by a
  /// host's own periodic timer, same as `sweep` itself. Snapshots the
  /// table list into a plain array first: table GC below mutates
  /// `reg.tables` in place, and doing that while an iterator over the
  /// same live `Map` is still walking it is not something to rely on.
  public func sweep<S, M>(self : Registry<S, M>, now : Int) {
    for ((id, t) in self.tables.toArray().values()) {
      t.sweep(now);
      gcIfQuiesced(self, id, t);
    };
    recordActiveGames(self); // idle eviction can drop an #active table too
  };
};
