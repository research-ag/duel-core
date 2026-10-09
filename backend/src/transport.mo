/// duel-game-core/transport — the REQUIRED client transport. A player is
/// the caller's principal; every table request names its table.
///
/// No classes. Two kinds of value:
///   - `Duel<S, M, O>` — all the data: the registry (tables), the
///     lobby's `rev`, presence, and the random-number generator the
///     game's rules draw from. A plain record, declared as an ordinary —
///     stable — actor field. Each table's `rev` lives on its `Table`.
///   - `Env<S, M, V, O>` — the function values that cannot be stable,
///     built by the host from its rules module: the game's `Spec`, and
///     optionally the canister players (their stable `Store` plus the
///     host's `CallBot`) and a leaderboard (its stable `Board` plus a
///     rating). Passed to every function that needs it; never stored in
///     `Duel`.
/// Behaviour is module functions on them, written `duel.submit(env, …)`.
///
/// Type parameters, all chosen by the game's rules module: `S` the full
/// state, `M` one move, `V` what one seat may see of the state (the
/// game's `view`), `O` the table options a creator picks.
///
/// Reading is by pure query, with no per-reader record:
///   - `lobbyView(caller, rev)`: the open tables and the caller's own
///     (`yours`), built only when the lobby's `rev` differs from `rev`.
///   - `table(env, caller, id, rev)`: the caller's view of table `id`,
///     built only when the table's `rev` differs from `rev`.
/// `rev = 0` means "I hold nothing" and always gets the current state.
///
/// Mutation is by update, one at a time from a client (two in-flight
/// update calls have no ordering guarantee): the lobby functions
/// (create/join/rematch/leave/reset/claimWin/ackEnded) answer an `Ack`
/// (the table and its `rev` after the call), `submit` the fresh view of
/// its table. Each bumps its table's `rev`; all but `submit` also bump
/// the lobby's. After every mutation the leaderboard is scored (on a
/// fresh debrief) and canister players are settled.
///
/// Presence only keeps a waiting table open: a client waiting at a table
/// sends `keepAlive` every `KEEP_ALIVE_SECS`, and `sweep` (every
/// `SWEEP_SECS`) clears a waiting table past the idle timeout whose
/// creator went silent for `PRESENCE_TTL_NS`.
///
/// Wiring — the methods whose signatures name none of the game's types
/// come from `./transport_actor_mixin` (a mixin cannot take type
/// parameters), through `duel.lobby(env)`; the host declares the four
/// that do (`duel_create_table`, `duel_lobby`, `duel_submit`,
/// `duel_table`) — see the skill's `templates/Host.mo.template`.

import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Time "mo:core/Time";
import Timer "mo:core/Timer";

import CanisterPlayers "./canister_players";
import Elo "./elo";
import Leaderboard "./leaderboard";
import TP "./lib";
import Registry "./registry";
import Rng "./rng";
import Table "./table";

module {

  /// Everything the transport keeps. Stable.
  public type Duel<S, M, O> = {
    registry : TP.Registry<S, M, O>;
    /// Bumped whenever the open-table list or anyone's `yours` may have
    /// changed.
    var lobbyRev : Nat;
    /// Last request per player; only keeps a waiting table open.
    presence : Map.Map<TP.PlayerId, Int>;
    /// Handed to the rules' `init`/`move`/`resolve`. Seeded from the
    /// clock at install.
    rng : TP.Rng;
  };

  public func new<S, M, O>() : Duel<S, M, O> = {
    registry = Registry.new<S, M, O>();
    var lobbyRev = 0;
    presence = Map.empty<TP.PlayerId, Int>();
    rng = Rng.new(Nat64.fromIntWrap(Time.now()));
  };

  /// Canister players: the stable store plus the host's `CallBot`.
  public type Bots<V, M> = {
    store : CanisterPlayers.Store;
    call : CanisterPlayers.CallBot<V, M>;
  };

  /// How a finished game is scored — a game picks the one that fits.
  /// `#elo`: a rating between players who play against each other; both
  /// seats are re-rated (`#claimed`/`#aborted` count as wins). `#best`:
  /// individual personal bests; the game scores each seat it credits
  /// from the debrief (zero, one or two entries, e.g. a lap time turned
  /// into higher-is-better), each kept only when it improves that
  /// player's entry.
  public type Rating<S> = {
    #elo : { k : Nat };
    #best : (TP.Debrief<S>) -> [(TP.Seat, Int)];
  };

  public type Scoring<S> = { board : Leaderboard.Board; rating : Rating<S> };

  /// The function values a call needs, built by the host from its rules
  /// module (and its bot call); never stored in `Duel`.
  public type Env<S, M, V, O> = {
    spec : TP.Spec<S, M, V, O>;
    bots : ?Bots<V, M>;
    scoring : ?Scoring<S>;
  };

  /// A lobby function's reply: the table it was about and that table's
  /// `rev` after the call. The client polls `table` until it sees a view
  /// at least that new.
  public type Ack = TP.Res<{ tableId : TP.TableId; rev : Nat }>;

  /// One table's view for the caller, at the table's `rev`.
  public type Snapshot<V> = { rev : Nat; view : TP.TableView<V> };

  /// What `duel_submit` returns.
  public type Reply<V> = { #view : Snapshot<V>; #err : TP.Err };

  /// What `duel_table` returns: `#unchanged` while the table is still at
  /// the `rev` asked with; `#gone` once the table no longer exists.
  public type TableResult<V> = { #unchanged; #changed : Snapshot<V>; #gone };

  /// What `duel_lobby` returns. `yours`: every table the caller has
  /// business at (seated, reserved for, or an unacked notice).
  public type LobbyResult<O> = {
    #unchanged;
    #changed : {
      rev : Nat;
      tables : [TP.TableSummary<O>];
      yours : [TP.TableId];
    };
  };

  /// A player is the caller's principal; the anonymous one is refused.
  public func playerOf(caller : Principal) : ?TP.PlayerId {
    if (caller.isAnonymous()) null else ?caller.toText();
  };

  /// How long after its last request a player still counts as present.
  public let PRESENCE_TTL_NS : Int = 60_000_000_000;

  /// How often a client waiting at a table sends `duel_keep_alive`.
  public let KEEP_ALIVE_SECS : Nat = 20;

  /// How often `sweep` runs. A waiting table whose creator went silent
  /// is gone within the idle timeout plus about one interval.
  public let SWEEP_SECS : Nat = 30;

  public func isPresent<S, M, O>(self : Duel<S, M, O>, player : TP.PlayerId, now : Int) : Bool {
    switch (self.presence.get(player)) {
      case (?t) now - t < PRESENCE_TTL_NS;
      case null false;
    };
  };

  /// Applies `rating` to a freshly finished game.
  public func score<S>(scoring : Scoring<S>, d : TP.Debrief<S>, now : Int) {
    let board = scoring.board;
    switch (scoring.rating) {
      case (#elo { k }) {
        let outcome : Elo.Outcome = switch (d.end) {
          case (#finished(#p1Wins)) #aWins;
          case (#finished(#p2Wins)) #bWins;
          case (#finished(#draw)) #draw;
          case (#claimed(#p1)) #aWins;
          case (#claimed(#p2)) #bWins;
          case (#aborted(#p1)) #bWins;
          case (#aborted(#p2)) #aWins;
        };
        let (r1, r2) = Elo.update(Leaderboard.scoreOf(board, d.p1), Leaderboard.scoreOf(board, d.p2), outcome, k);
        Leaderboard.setScore(board, d.p1, r1, now);
        Leaderboard.setScore(board, d.p2, r2, now);
      };
      case (#best pick) {
        for ((seat, s) in pick(d).values()) {
          let player = switch (seat) { case (#p1) d.p1; case (#p2) d.p2 };
          ignore Leaderboard.recordIfBetter(board, player, s, now);
        };
      };
    };
  };

  func markSeen<S, M, O>(self : Duel<S, M, O>, player : TP.PlayerId, now : Int) = self.presence.add(player, now);

  func bumpTable<S, M, O>(self : Duel<S, M, O>, id : TP.TableId) {
    switch (self.registry.tables.get(id)) {
      case (?t) t.rev += 1;
      case null {};
    };
  };

  func tableRev<S, M, O>(self : Duel<S, M, O>, id : TP.TableId) : Nat {
    switch (self.registry.tables.get(id)) {
      case (?t) t.rev;
      case null 0;
    };
  };

  /// The canister players' context for one call, or `null` without bots.
  public func botCtx<S, M, V, O>(self : Duel<S, M, O>, env : Env<S, M, V, O>) : ?CanisterPlayers.Ctx<S, M, V, O> {
    switch (env.bots) {
      case null null;
      case (?b) ?{
        registry = self.registry;
        spec = env.spec;
        rng = self.rng;
        store = b.store;
        call = b.call;
        afterMutation = func<system>(now : Int, id : TP.TableId, bumpLobbyToo : Bool) : async* () {
          await* afterMutation<system, S, M, V, O>(self, env, now, id, bumpLobbyToo);
        };
        arm = func<system>(id : TP.TableId, secs : Nat) {
          ignore Timer.setTimer<system>(#seconds secs, func() : async () { await* settle<system, S, M, V, O>(self, env, Time.now(), id) });
        };
      };
    };
  };

  func settle<system, S, M, V, O>(self : Duel<S, M, O>, env : Env<S, M, V, O>, now : Int, id : TP.TableId) : async* () {
    switch (botCtx(self, env)) {
      case (?ctx) await* CanisterPlayers.settle<system, S, M, V, O>(ctx, now, id);
      case null {};
    };
  };

  /// Bumps table `id`'s `rev` (and the lobby's with `bumpLobbyToo`),
  /// scores a debrief this mutation created, then settles canister
  /// players — the only await.
  public func afterMutation<system, S, M, V, O>(self : Duel<S, M, O>, env : Env<S, M, V, O>, now : Int, id : TP.TableId, bumpLobbyToo : Bool) : async* () {
    bumpTable(self, id);
    if (bumpLobbyToo) self.lobbyRev += 1;
    switch (env.scoring, self.registry.tables.get(id)) {
      case (?sc, ?t) switch (t.phase) {
        // Only the mutation that created it: a canister seat's ack runs in
        // the same message (same `now`) and must not score it again.
        case (#debrief d) if (d.since == now and t.debriefAcked.size() == 0) score(sc, d, now);
        case (_) {};
      };
      case (_, _) {};
    };
    await* settle<system, S, M, V, O>(self, env, now, id);
  };

  /// The shared path of every human mutation: authorize, record
  /// presence, run `op(now, player)` (which returns the table it was
  /// about), fan out.
  func mutate<system, S, M, V, O>(
    self : Duel<S, M, O>,
    env : Env<S, M, V, O>,
    caller : Principal,
    bumpLobbyToo : Bool,
    op : (Int, TP.PlayerId) -> TP.Res<TP.TableId>,
  ) : async* TP.Res<TP.TableId> {
    let ?player = playerOf(caller) else return #err(#unauthorized);
    let now = Time.now();
    markSeen(self, player, now);
    switch (op(now, player)) {
      case (#err e) #err e;
      case (#ok id) {
        await* afterMutation<system, S, M, V, O>(self, env, now, id, bumpLobbyToo);
        #ok id;
      };
    };
  };

  func ack<S, M, O>(self : Duel<S, M, O>, r : TP.Res<TP.TableId>) : Ack {
    switch (r) {
      case (#err e) #err e;
      case (#ok id) #ok { tableId = id; rev = tableRev(self, id) };
    };
  };

  func at<R>(r : TP.Res<R>, id : TP.TableId) : TP.Res<TP.TableId> {
    switch (r) {
      case (#ok _) #ok id;
      case (#err e) #err e;
    };
  };

  /// Opens a table with the caller at `seat`. `#badOptions` when the
  /// game's `checkOptions` rejects `options`.
  public func createTable<system, S, M, V, O>(self : Duel<S, M, O>, env : Env<S, M, V, O>, caller : Principal, seat : TP.Seat, visibility : TP.TableVisibility, options : O) : async* Ack {
    ack(self, await* mutate<system, S, M, V, O>(self, env, caller, true, func(now : Int, p : TP.PlayerId) : TP.Res<TP.TableId> = self.registry.createTable(env.spec, self.rng, now, p, seat, visibility, options)));
  };

  public func joinTable<system, S, M, V, O>(self : Duel<S, M, O>, env : Env<S, M, V, O>, caller : Principal, id : TP.TableId, seat : TP.Seat, code : ?Text) : async* Ack {
    ack(self, await* mutate<system, S, M, V, O>(self, env, caller, true, func(now : Int, p : TP.PlayerId) : TP.Res<TP.TableId> = at(self.registry.joinTable(env.spec, self.rng, now, p, id, seat, code), id)));
  };

  public func rematch<system, S, M, V, O>(self : Duel<S, M, O>, env : Env<S, M, V, O>, caller : Principal, id : TP.TableId) : async* Ack {
    ack(self, await* mutate<system, S, M, V, O>(self, env, caller, true, func(now : Int, p : TP.PlayerId) : TP.Res<TP.TableId> = at(self.registry.rematch(env.spec, self.rng, now, p, id), id)));
  };

  public func leave<system, S, M, V, O>(self : Duel<S, M, O>, env : Env<S, M, V, O>, caller : Principal, id : TP.TableId, gen : Nat) : async* Ack {
    ack(self, await* mutate<system, S, M, V, O>(self, env, caller, true, func(now : Int, p : TP.PlayerId) : TP.Res<TP.TableId> = at(self.registry.leave(now, p, id, gen), id)));
  };

  public func reset<system, S, M, V, O>(self : Duel<S, M, O>, env : Env<S, M, V, O>, caller : Principal, id : TP.TableId, gen : Nat) : async* Ack {
    ack(self, await* mutate<system, S, M, V, O>(self, env, caller, true, func(now : Int, p : TP.PlayerId) : TP.Res<TP.TableId> = at(self.registry.reset(now, p, id, gen), id)));
  };

  public func claimWin<system, S, M, V, O>(self : Duel<S, M, O>, env : Env<S, M, V, O>, caller : Principal, id : TP.TableId, gen : Nat) : async* Ack {
    ack(self, await* mutate<system, S, M, V, O>(self, env, caller, true, func(now : Int, p : TP.PlayerId) : TP.Res<TP.TableId> = at(self.registry.claimWin(env.spec, now, p, id, gen), id)));
  };

  public func ackEnded<system, S, M, V, O>(self : Duel<S, M, O>, env : Env<S, M, V, O>, caller : Principal, id : TP.TableId) : async* Ack {
    ack(
      self,
      await* mutate<system, S, M, V, O>(
        self,
        env,
        caller,
        true,
        func(_ : Int, p : TP.PlayerId) : TP.Res<TP.TableId> {
          self.registry.ackEnded(p, id);
          #ok id;
        },
      ),
    );
  };

  /// Keeps the caller's waiting table open; changes nothing else.
  public func keepAlive<S, M, O>(self : Duel<S, M, O>, caller : Principal) : TP.Res<()> {
    let ?player = playerOf(caller) else return #err(#unauthorized);
    markSeen(self, player, Time.now());
    #ok;
  };

  /// Runs a move and returns its error, if any; `reply` turns that into
  /// `duel_submit`'s reply (two steps because an `async*` result must be
  /// a shared type, which the generic `Reply<V>` is not).
  public func submit<system, S, M, V, O>(self : Duel<S, M, O>, env : Env<S, M, V, O>, caller : Principal, id : TP.TableId, gen : Nat, step : Nat, move : M) : async* ?TP.Err {
    switch (await* mutate<system, S, M, V, O>(self, env, caller, false, func(now : Int, p : TP.PlayerId) : TP.Res<TP.TableId> = at(self.registry.submit(env.spec, self.rng, now, p, id, gen, step, move), id))) {
      case (#ok _) null;
      case (#err e) ?e;
    };
  };

  /// Read at `Time.now()`: a canister player may have answered in the
  /// meantime.
  public func reply<S, M, V, O>(self : Duel<S, M, O>, env : Env<S, M, V, O>, caller : Principal, id : TP.TableId, err : ?TP.Err) : Reply<V> {
    switch (err) {
      case (?e) #err e;
      case null switch (self.registry.tables.get(id)) {
        case null #err(#noSuchTable);
        case (?t) #view {
          rev = t.rev;
          view = t.status(env.spec, Time.now(), caller.toText());
        };
      };
    };
  };

  /// The caller's view of table `id`, built only when its `rev` moved.
  public func table<S, M, V, O>(self : Duel<S, M, O>, env : Env<S, M, V, O>, caller : Principal, id : TP.TableId, rev : Nat) : TableResult<V> {
    switch (self.registry.tables.get(id)) {
      case null #gone;
      case (?t) {
        if (rev != 0 and t.rev == rev) return #unchanged;
        #changed {
          rev = t.rev;
          view = t.status(env.spec, Time.now(), caller.toText());
        };
      };
    };
  };

  /// The open tables and the caller's own, built only when the lobby's
  /// `rev` moved.
  public func lobbyView<S, M, O>(self : Duel<S, M, O>, caller : Principal, rev : Nat) : LobbyResult<O> {
    if (rev != 0 and self.lobbyRev == rev) return #unchanged;
    let yours = switch (playerOf(caller)) {
      case (?p) self.registry.tablesOf(p);
      case null [];
    };
    #changed {
      rev = self.lobbyRev;
      tables = self.registry.listTables(Time.now());
      yours;
    };
  };

  /// Clears expired tables (a waiting one stays while its creator is
  /// present), bumps the `rev` of every table it changed and the
  /// lobby's when anything changed, prunes presence, then settles
  /// canister players everywhere (the slow fallback).
  public func sweep<system, S, M, V, O>(self : Duel<S, M, O>, env : Env<S, M, V, O>, now : Int) : async* () {
    func shape(t : TP.Table<S, M, O>) : (Nat, Nat) {
      let tag = switch (t.phase) {
        case (#empty) 0;
        case (#staging _) 1;
        case (#active _) 2;
        case (#debrief _) 3;
      };
      (tag, t.lastEnded.size());
    };
    let before = Map.empty<TP.TableId, (Nat, Nat)>();
    for ((id, t) in self.registry.tables.entries()) before.add(id, shape(t));
    self.registry.sweep(now, func(p) = isPresent(self, p, now));
    for ((p, t) in self.presence.toArray().values()) {
      if (now - t >= PRESENCE_TTL_NS) self.presence.remove(p);
    };
    var changed = false;
    for ((id, old) in before.entries()) {
      switch (self.registry.tables.get(id)) {
        case (?t) if (shape(t) != old) {
          t.rev += 1;
          changed := true;
        };
        case null changed := true;
      };
    };
    if (changed) self.lobbyRev += 1;
    switch (botCtx(self, env)) {
      case (?ctx) await* CanisterPlayers.sweep<system, S, M, V, O>(ctx, now);
      case null {};
    };
  };

  /// The methods `./transport_actor_mixin` exposes: none of them names
  /// a game type.
  public type Lobby = {
    joinTable : <system>(Principal, TP.TableId, TP.Seat, ?Text) -> async* Ack;
    rematch : <system>(Principal, TP.TableId) -> async* Ack;
    leave : <system>(Principal, TP.TableId, Nat) -> async* Ack;
    reset : <system>(Principal, TP.TableId, Nat) -> async* Ack;
    claimWin : <system>(Principal, TP.TableId, Nat) -> async* Ack;
    ackEnded : <system>(Principal, TP.TableId) -> async* Ack;
    keepAlive : (Principal) -> TP.Res<()>;
    sweep : <system>(Int) -> async* ();
  };

  /// Functions over `self` and `env` for the mixin; no data of their own.
  /// The host keeps the result in a `transient let`.
  public func lobby<S, M, V, O>(self : Duel<S, M, O>, env : Env<S, M, V, O>) : Lobby = {
    joinTable = func<system>(c : Principal, id : TP.TableId, seat : TP.Seat, code : ?Text) : async* Ack = await* joinTable<system, S, M, V, O>(self, env, c, id, seat, code);
    rematch = func<system>(c : Principal, id : TP.TableId) : async* Ack = await* rematch<system, S, M, V, O>(self, env, c, id);
    leave = func<system>(c : Principal, id : TP.TableId, gen : Nat) : async* Ack = await* leave<system, S, M, V, O>(self, env, c, id, gen);
    reset = func<system>(c : Principal, id : TP.TableId, gen : Nat) : async* Ack = await* reset<system, S, M, V, O>(self, env, c, id, gen);
    claimWin = func<system>(c : Principal, id : TP.TableId, gen : Nat) : async* Ack = await* claimWin<system, S, M, V, O>(self, env, c, id, gen);
    ackEnded = func<system>(c : Principal, id : TP.TableId) : async* Ack = await* ackEnded<system, S, M, V, O>(self, env, c, id);
    keepAlive = func(c : Principal) : TP.Res<()> = keepAlive(self, c);
    sweep = func<system>(now : Int) : async* () = await* sweep<system, S, M, V, O>(self, env, now);
  };

  /// The bot-facing functions for `./canister_players_actor_mixin`, or
  /// `null` without bots. The host keeps the result in a `transient let`.
  public func canisterPlayers<S, M, V, O>(self : Duel<S, M, O>, env : Env<S, M, V, O>) : ?CanisterPlayers.Endpoint {
    switch (botCtx(self, env)) {
      case (?ctx) ?CanisterPlayers.endpointOf(ctx);
      case null null;
    };
  };
};
