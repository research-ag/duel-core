import Array "mo:core/Array";
import Int "mo:core/Int";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Option "mo:core/Option";
import Text "mo:core/Text";

import PT "mo:promtracker";
import Tracker "mo:promtracker/Tracker";

import Table "./table";
import T "./types";

/// Many independent `Table`s behind one `Registry`. Every operation names
/// its table by id (except `createTable`, which makes one) and delegates
/// to `Table`; no game logic is reimplemented. A player may be at up to
/// `MAX_TABLES_PER_PLAYER` tables at once; which ones is read off the
/// tables themselves (`tablesOf`), never stored separately.
module {

  public type Registry<S, M, O> = T.Registry<S, M, O>;

  /// Caps how many tables one player holds, so nobody hogs the lobby.
  public let MAX_TABLES_PER_PLAYER : Nat = 3;

  /// Starts at 90s idle / 60s claim; a host overrides them with
  /// `setTimeouts` on the next line.
  public func new<S, M, O>() : Registry<S, M, O> = {
    var idleTimeoutNs = 90_000_000_000;
    var claimTimeoutNs = 60_000_000_000;
    var tables = Map.empty<T.TableId, T.Table<S, M, O>>();
    var tableIdNonce = 1;
    var gamesStarted = null;
    var activeGames = null;
    var roundsPerGame = null;
    var matchmakingWaitSecs = null;
  };

  /// Re-applies the timeouts to the registry and every existing table.
  /// A host calls it right after declaring its stable `registry` so the
  /// numbers in the source win on every upgrade, not only on first
  /// install. See `../README.md`, "Timeouts survive upgrades".
  public func setTimeouts<S, M, O>(self : Registry<S, M, O>, idleTimeoutNs : Int, claimTimeoutNs : Int) {
    self.idleTimeoutNs := idleTimeoutNs;
    self.claimTimeoutNs := claimTimeoutNs;
    for (t in self.tables.values()) {
      t.setTimeouts(idleTimeoutNs, claimTimeoutNs);
    };
  };

  public func attachMetrics<S, M, O>(self : Registry<S, M, O>, pt : PT.Tracker) {
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

  func recordActiveGames<S, M, O>(self : Registry<S, M, O>) {
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
        g.update(n);
      };
    };
  };

  func bumpGamesStarted<S, M, O>(self : Registry<S, M, O>) {
    switch (self.gamesStarted) {
      case null {};
      case (?c) c.add(1);
    };
  };

  func recordRoundsPerGame<S, M, O>(self : Registry<S, M, O>, t : T.Table<S, M, O>) {
    switch (self.roundsPerGame) {
      case null {};
      case (?g) switch (t.phase) {
        case (#debrief d) g.update(d.steps);
        case (_) {};
      };
    };
  };

  func stagingSince<S, M, O>(t : T.Table<S, M, O>) : ?Int = switch (t.phase) {
    case (#staging st) ?st.since;
    case (_) null;
  };

  func recordMatchmakingWait<S, M, O>(self : Registry<S, M, O>, now : Int, since : ?Int) {
    switch (self.matchmakingWaitSecs, since) {
      case (?g, ?s) {
        let waited = now - s;
        g.update(if (waited <= 0) { 0 } else { waited.toNat() / 1_000_000_000 });
      };
      case (_, _) {};
    };
  };

  /// How a table looks to a not-yet-seated visitor, per phase — the same
  /// outsider view `Table.status` computes, minus the per-session
  /// `unackedEnded` check. `null` = not joinable right now. This is what
  /// keeps an idle-abandoned table in ANY phase reachable via `listTables`.
  /// Only the `#staging` branch names an occupant.
  func openness<S, M, O>(t : T.Table<S, M, O>, now : Int) : ?{
    p1Open : Bool;
    p2Open : Bool;
    p1Session : ?T.PlayerId;
    p2Session : ?T.PlayerId;
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
        if (st.reservedFor.isSome() and not t.isExpired(st.since, now)) {
          null;
        } else {
          let p1Open = st.seat != #p1;
          let p2Open = st.seat != #p2;
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

  /// Drops an `#empty` table with no outstanding `#endedByOther` notice.
  func gcIfQuiesced<S, M, O>(reg : Registry<S, M, O>, id : T.TableId, t : T.Table<S, M, O>) {
    switch (t.phase) {
      case (#empty) {
        if (t.lastEnded.size() == 0) {
          reg.tables.remove(id);
        };
      };
      case (_) {};
    };
  };

  /// Whether `player` has business at `t`: seated, holding an unacked
  /// `#endedByOther` notice (in any phase — an idle takeover re-stages
  /// the table under them), or named by a rematch reservation.
  public func isMine<S, M, O>(t : T.Table<S, M, O>, player : T.PlayerId) : Bool {
    if (t.isStillSeated(player) or t.unackedEnded(player)) return true;
    switch (t.phase) {
      case (#staging st) st.reservedFor == ?player;
      case (_) false;
    };
  };

  /// Every table `player` has business at, by id.
  public func tablesOf<S, M, O>(self : Registry<S, M, O>, player : T.PlayerId) : [T.TableId] {
    let mine = List.empty<T.TableId>();
    for ((id, t) in self.tables.entries()) {
      if (isMine(t, player)) mine.add(id);
    };
    mine.toArray();
  };

  func atCapacity<S, M, O>(reg : Registry<S, M, O>, player : T.PlayerId) : ?T.Err {
    if (tablesOf(reg, player).size() >= MAX_TABLES_PER_PLAYER) {
      ?#tooManyTables { max = MAX_TABLES_PER_PLAYER };
    } else null;
  };

  func withTable<S, M, O, R>(
    reg : Registry<S, M, O>,
    id : T.TableId,
    op : (T.Table<S, M, O>) -> T.Res<R>,
  ) : T.Res<R> {
    switch (reg.tables.get(id)) {
      case null #err(#noSuchTable);
      case (?t) op(t);
    };
  };

  func gcById<S, M, O>(reg : Registry<S, M, O>, id : T.TableId) {
    switch (reg.tables.get(id)) {
      case (?t) gcIfQuiesced(reg, id, t);
      case null {};
    };
  };

  /// Every table with an open seat, protected ones flagged but never
  /// carrying their code.
  public func listTables<S, M, O>(self : Registry<S, M, O>, now : Int) : [T.TableSummary<O>] {
    let withSummaries = self.tables.filterMap<T.TableId, T.Table<S, M, O>, T.TableSummary<O>>(
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
            options = t.options;
          };
        };
      },
    );
    withSummaries.toArray().map<(T.TableId, T.TableSummary<O>), T.TableSummary<O>>(func((_, v)) = v);
  };

  /// The id the next `createTable`/`createTableReserving` will assign —
  /// a pure peek, valid only with no `await` before that call.
  public func peekNextTableId<S, M, O>(self : Registry<S, M, O>) : T.TableId = self.tableIdNonce;

  /// `#badCode` for `#code("")` (unreachable by construction, since
  /// `joinTable` sends no code for an empty field); `#badOptions` when
  /// the game's `checkOptions` rejects `options`; `#tooManyTables` at the
  /// cap.
  public func createTable<S, M, V, O>(
    self : Registry<S, M, O>,
    spec : T.Spec<S, M, V, O>,
    rng : T.Rng,
    now : Int,
    session : T.PlayerId,
    seat : T.Seat,
    visibility : T.TableVisibility,
    options : O,
  ) : T.Res<T.TableId> {
    switch (visibility) {
      case (#code c) { if (c.size() == 0) return #err(#badCode) };
      case (#open) {};
    };
    switch (Table.checkOptions(spec, options)) {
      case (?why) return #err(#badOptions why);
      case null {};
    };
    switch (atCapacity(self, session)) { case (?e) return #err e; case null {} };
    let id = self.tableIdNonce;
    let t = Table.new<S, M, O>(self.idleTimeoutNs, self.claimTimeoutNs, visibility, session, options);
    switch (t.join(spec, rng, now, session, seat)) {
      case (#err e) #err(e); // unreachable on a brand-new table
      case (#ok _) {
        self.tableIdNonce += 1;
        self.tables.add(id, t);
        #ok(id);
      };
    };
  };

  /// Seats both `session` and `reservedFor` atomically; the table lands in
  /// `#active`. Rejects a self-reservation and a `reservedFor` busy
  /// elsewhere.
  public func createTableReserving<S, M, V, O>(
    self : Registry<S, M, O>,
    spec : T.Spec<S, M, V, O>,
    rng : T.Rng,
    now : Int,
    session : T.PlayerId,
    seat : T.Seat,
    visibility : T.TableVisibility,
    reservedFor : T.PlayerId,
    options : O,
  ) : T.Res<T.TableId> {
    switch (visibility) {
      case (#code c) { if (c.size() == 0) return #err(#badCode) };
      case (#open) {};
    };
    switch (Table.checkOptions(spec, options)) {
      case (?why) return #err(#badOptions why);
      case null {};
    };
    if (reservedFor == session) {
      return #err(#wrongPhase("cannot reserve yourself for the other seat"));
    };
    switch (atCapacity(self, session)) { case (?e) return #err e; case null {} };
    switch (atCapacity(self, reservedFor)) {
      case (?e) return #err e;
      case null {};
    };
    let id = self.tableIdNonce;
    let t = Table.new<S, M, O>(self.idleTimeoutNs, self.claimTimeoutNs, visibility, session, options);
    t.stage(now, session, seat, ?reservedFor);
    let otherSeat = switch (seat) { case (#p1) #p2; case (#p2) #p1 };
    switch (t.join(spec, rng, now, reservedFor, otherSeat)) {
      case (#err e) return #err(e); // unreachable — the staging is reserved for exactly this session
      case (#ok _) {};
    };
    self.tableIdNonce += 1;
    self.tables.add(id, t);
    bumpGamesStarted(self);
    recordMatchmakingWait(self, now, ?now);
    recordActiveGames(self);
    #ok(id);
  };

  public func joinTable<S, M, V, O>(
    self : Registry<S, M, O>,
    spec : T.Spec<S, M, V, O>,
    rng : T.Rng,
    now : Int,
    session : T.PlayerId,
    id : T.TableId,
    seat : T.Seat,
    code : ?Text,
  ) : T.Res<T.JoinOk> {
    let t = switch (self.tables.get(id)) {
      case (?t) switch (t.visibility) {
        case (#code c) { if (code != ?c) return #err(#badCode) else { t } };
        case (#open) t;
      };
      case null return #err(#noSuchTable);
    };
    if (not isMine(t, session)) {
      switch (atCapacity(self, session)) {
        case (?e) return #err e;
        case null {};
      };
    };
    let waitSince = stagingSince(t);
    switch (t.join(spec, rng, now, session, seat)) {
      case (#err e) #err(e);
      case (#ok j) {
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

  public func submit<S, M, V, O>(
    self : Registry<S, M, O>,
    spec : T.Spec<S, M, V, O>,
    rng : T.Rng,
    now : Int,
    session : T.PlayerId,
    id : T.TableId,
    gen : Nat,
    step : Nat,
    move : M,
  ) : T.Res<T.SubmitOk> = withTable<S, M, O, T.SubmitOk>(
    self,
    id,
    func(t) {
      let r = t.submit(spec, rng, now, session, gen, step, move);
      switch (r) {
        case (#ok(#gameEnded _)) {
          recordActiveGames(self);
          recordRoundsPerGame(self, t);
        };
        case (_) {};
      };
      r;
    },
  );

  public func rematch<S, M, V, O>(self : Registry<S, M, O>, spec : T.Spec<S, M, V, O>, rng : T.Rng, now : Int, session : T.PlayerId, id : T.TableId) : T.Res<T.RematchOk> = withTable<S, M, O, T.RematchOk>(
    self,
    id,
    func(t) {
      let waitSince = stagingSince(t);
      let r = t.rematch(spec, rng, now, session);
      switch (r) {
        case (#ok(#started)) {
          bumpGamesStarted(self);
          recordActiveGames(self);
          recordMatchmakingWait(self, now, waitSince);
        };
        case (_) {};
      };
      r;
    },
  );

  public func claimWin<S, M, V, O>(self : Registry<S, M, O>, spec : T.Spec<S, M, V, O>, now : Int, session : T.PlayerId, id : T.TableId, gen : Nat) : T.Res<()> = withTable<S, M, O, ()>(
    self,
    id,
    func(t) {
      let r = t.claimWin(spec, now, session, gen);
      switch (r) {
        case (#ok _) {
          recordActiveGames(self);
          recordRoundsPerGame(self, t);
        };
        case (#err _) {};
      };
      r;
    },
  );

  /// An abort (leaving a live game) keeps the leaver at the table so they
  /// still see the shared `#aborted` debrief; only a staging walkout or a
  /// debrief ack lets the table go.
  func isAbort<S, M, O>(t : T.Table<S, M, O>) : Bool = switch (t.phase) {
    case (#active _) true;
    case (_) false;
  };

  public func leave<S, M, O>(self : Registry<S, M, O>, now : Int, session : T.PlayerId, id : T.TableId, gen : Nat) : T.Res<()> = withTable<S, M, O, ()>(
    self,
    id,
    func(t) {
      let abort = isAbort(t);
      let r = t.leave(now, session, gen);
      switch (r) {
        case (#ok _) {
          if (abort) {
            recordActiveGames(self);
            recordRoundsPerGame(self, t);
          } else {
            gcById(self, id);
          };
        };
        case (#err _) {};
      };
      r;
    },
  );

  public func reset<S, M, O>(self : Registry<S, M, O>, now : Int, session : T.PlayerId, id : T.TableId, gen : Nat) : T.Res<()> = withTable<S, M, O, ()>(
    self,
    id,
    func(t) {
      let abort = isAbort(t);
      let r = t.reset(now, session, gen);
      switch (r) {
        case (#ok _) {
          if (abort) {
            recordActiveGames(self);
            recordRoundsPerGame(self, t);
          } else {
            gcById(self, id);
          };
        };
        case (#err _) {};
      };
      r;
    },
  );

  /// Acking an `#endedByOther` notice is the "return to lobby" action.
  public func ackEnded<S, M, O>(self : Registry<S, M, O>, session : T.PlayerId, id : T.TableId) {
    switch (self.tables.get(id)) {
      case (?t) {
        t.ackEnded(session);
        gcIfQuiesced(self, id, t);
      };
      case null {};
    };
  };

  /// `player`'s view of table `id`.
  public func view<S, M, V, O>(self : Registry<S, M, O>, spec : T.Spec<S, M, V, O>, now : Int, player : T.PlayerId, id : T.TableId) : ?T.TableView<V> {
    switch (self.tables.get(id)) {
      case (?t) ?t.status(spec, now, player);
      case null null;
    };
  };

  /// Snapshots the table list first: GC mutates `tables` in place.
  /// `isPresent` keeps a waiting occupant's staging alive; see
  /// `Table.sweep`.
  public func sweep<S, M, O>(self : Registry<S, M, O>, now : Int, isPresent : T.PlayerId -> Bool) {
    for ((id, t) in self.tables.toArray().values()) {
      t.sweep(now, isPresent);
      gcIfQuiesced(self, id, t);
    };
    recordActiveGames(self);
  };
};
