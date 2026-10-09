/// duel-game-core/transport — the REQUIRED client transport. A player is
/// the caller's principal; every table request names its table.
///
/// Data and behaviour are split like promtracker's `Tracker`/`Renderer`:
///   - `State<S, M>` is a plain record (the registry, the lobby's `rev`,
///     presence), declared as an ordinary — stable — actor field. Each
///     table's `rev` lives on its `Table`. The optional bot store
///     (`CanisterPlayers.Store`) and leaderboard (`Leaderboard.Board`)
///     are plain records too.
///   - `Duel<S, M>` is a class wrapping them together with the function
///     values that cannot be stable: the game's `Spec`, the host's
///     `CallBot`, and a custom rating rule. The host rebuilds it on every
///     upgrade (`transient let`).
///
/// Reading is by pure query, with no per-reader record:
///   - `lobby(caller, rev)`: the open tables and the caller's own
///     (`yours`), built only when the lobby's `rev` differs from `rev`.
///   - `table(caller, id, rev)`: the caller's view of table `id`, built
///     only when the table's `rev` differs from `rev`.
/// `rev = 0` means "I hold nothing" and always gets the current state.
///
/// Mutation is by update, one at a time from a client (two in-flight
/// update calls have no ordering guarantee): the lobby methods
/// (create/join/rematch/leave/reset/claimWin/ackEnded) reply with an
/// `Ack` (the table and its `rev` after the call), `submit` with the
/// fresh view of its table. Each bumps its table's `rev`; all but
/// `submit` also bump the lobby's. After every mutation the leaderboard
/// is scored (on a fresh debrief) and canister players are settled.
///
/// Presence only keeps a waiting table open: a client waiting at a table
/// sends `keepAlive` every `KEEP_ALIVE_SECS`, and `sweep` (every
/// `SWEEP_SECS`) clears a waiting table past the idle timeout whose
/// creator went silent for `PRESENCE_TTL_NS`.
///
/// Wiring — the non-generic methods come from `./transport_actor_mixin`
/// (a mixin cannot take type parameters); the host declares the two that
/// carry its `State`/`Action`:
///
///   let state = Transport.new<Rules.State, Rules.Action>();
///   state.registry.setTimeouts(...);
///   transient let duel = Transport.Duel<Rules.State, Rules.Action>(state, Rules.spec(), null, null);
///   include TransportActorMixin<system>(duel.lobby);
///
///   public shared ({ caller }) func duel_submit(tableId : TP.TableId, gen : Nat, turn : Nat, move : Rules.Action) : async Transport.Reply<Rules.State> {
///     duel.reply(caller, tableId, await* duel.submit<system>(caller, tableId, gen, turn, move));
///   };
///
///   public shared query ({ caller }) func duel_table(tableId : TP.TableId, rev : Nat) : async Transport.TableResult<Rules.State> {
///     duel.table(caller, tableId, rev);
///   };

import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Time "mo:core/Time";
import Timer "mo:core/Timer";

import CanisterPlayers "./canister_players";
import Elo "./elo";
import Leaderboard "./leaderboard";
import TP "./lib";
import Registry "./registry";
import Table "./table";

module {

  /// Everything the transport keeps. Stable.
  public type State<S, M> = {
    registry : TP.Registry<S, M>;
    /// Bumped whenever the open-table list or anyone's `yours` may have
    /// changed.
    var lobbyRev : Nat;
    /// Last request per player; only keeps a waiting table open.
    presence : Map.Map<TP.PlayerId, Int>;
  };

  public func new<S, M>() : State<S, M> = {
    registry = Registry.new<S, M>();
    var lobbyRev = 0;
    presence = Map.empty<TP.PlayerId, Int>();
  };

  /// Canister players: the stable store plus the host's `CallBot`.
  public type Bots<S, M> = {
    store : CanisterPlayers.Store;
    call : CanisterPlayers.CallBot<S, M>;
  };

  /// How a finished game is scored. `#elo`: both seats re-rated
  /// (`#claimed`/`#aborted` count as wins). `#best`: the game picks a
  /// seat and a score from the debrief (e.g. a lap time turned into
  /// higher-is-better), kept only when it improves that player's entry.
  public type Rating<S> = {
    #elo : { k : Nat };
    #best : (TP.Debrief<S>) -> ?(TP.Seat, Int);
  };

  public type Scoring<S> = { board : Leaderboard.Board; rating : Rating<S> };

  /// A lobby method's reply: the table it was about and that table's
  /// `rev` after the call. The client polls `table` until it sees a view
  /// at least that new.
  public type Ack = TP.Res<{ tableId : TP.TableId; rev : Nat }>;

  /// One table's view for the caller, at the table's `rev`.
  public type Snapshot<S> = { rev : Nat; view : TP.View<S> };

  /// What `duel_submit` returns.
  public type Reply<S> = { #view : Snapshot<S>; #err : TP.Err };

  /// What `duel_table` returns: `#unchanged` while the table is still at
  /// the `rev` asked with; `#gone` once the table no longer exists.
  public type TableResult<S> = { #unchanged; #changed : Snapshot<S>; #gone };

  /// What `duel_lobby` returns. `yours`: every table the caller has
  /// business at (seated, reserved for, or an unacked notice).
  public type LobbyResult = {
    #unchanged;
    #changed : {
      rev : Nat;
      tables : [TP.TableSummary];
      yours : [TP.TableId];
    };
  };

  /// The non-generic methods, as `./transport_actor_mixin` exposes them.
  public type Lobby = {
    createTable : <system>(Principal, TP.Seat, TP.TableVisibility, Text) -> async* Ack;
    joinTable : <system>(Principal, TP.TableId, TP.Seat, ?Text) -> async* Ack;
    rematch : <system>(Principal, TP.TableId) -> async* Ack;
    leave : <system>(Principal, TP.TableId, Nat) -> async* Ack;
    reset : <system>(Principal, TP.TableId, Nat) -> async* Ack;
    claimWin : <system>(Principal, TP.TableId, Nat) -> async* Ack;
    ackEnded : <system>(Principal, TP.TableId) -> async* Ack;
    keepAlive : (Principal) -> TP.Res<()>;
    lobby : (Principal, Nat) -> LobbyResult;
    sweep : <system>(Int) -> async* ();
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

  public func isPresent<S, M>(state : State<S, M>, player : TP.PlayerId, now : Int) : Bool {
    switch (state.presence.get(player)) {
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
      case (#best pick) switch (pick(d)) {
        case (?(seat, s)) {
          let player = switch (seat) { case (#p1) d.p1; case (#p2) d.p2 };
          ignore Leaderboard.recordIfBetter(board, player, s, now);
        };
        case null {};
      };
    };
  };

  public class Duel<S, M>(
    state : State<S, M>,
    spec : TP.Spec<S, M>,
    bots : ?Bots<S, M>,
    scoring : ?Scoring<S>,
  ) {

    let registry = state.registry;

    func markSeen(player : TP.PlayerId, now : Int) = state.presence.add(player, now);

    func bumpTable(id : TP.TableId) {
      switch (registry.tables.get(id)) {
        case (?t) t.rev += 1;
        case null {};
      };
    };

    func bumpLobby() = state.lobbyRev += 1;

    func tableRev(id : TP.TableId) : Nat {
      switch (registry.tables.get(id)) {
        case (?t) t.rev;
        case null 0;
      };
    };

    /// Bumps table `id`'s `rev` (and the lobby's with `bumpLobbyToo`),
    /// scores a fresh debrief, then settles canister players — the only
    /// await.
    public func afterMutation<system>(now : Int, id : TP.TableId, bumpLobbyToo : Bool) : async* () {
      bumpTable(id);
      if (bumpLobbyToo) bumpLobby();
      switch (scoring, registry.tables.get(id)) {
        case (?sc, ?t) switch (t.phase) {
          case (#debrief d) if (d.since == now) score(sc, d, now);
          case (_) {};
        };
        case (_, _) {};
      };
      switch (botCtx) {
        case (?ctx) await* CanisterPlayers.settle<system, S, M>(ctx, now, id);
        case null {};
      };
    };

    let botCtx : ?CanisterPlayers.Ctx<S, M> = switch (bots) {
      case null null;
      case (?b) ?{
        registry;
        spec;
        store = b.store;
        call = b.call;
        afterMutation = func<system>(now : Int, id : TP.TableId, bumpLobbyToo : Bool) : async* () {
          await* afterMutation<system>(now, id, bumpLobbyToo);
        };
        arm = func<system>(id : TP.TableId, secs : Nat) {
          ignore Timer.setTimer<system>(#seconds secs, func() : async () { await* settleTable<system>(id) });
        };
      };
    };

    func settleTable<system>(id : TP.TableId) : async* () {
      switch (botCtx) {
        case (?ctx) await* CanisterPlayers.settle<system, S, M>(ctx, Time.now(), id);
        case null {};
      };
    };

    /// The shared path of every human mutation: authorize, record
    /// presence, run `op(now, player)` (which returns the table it was
    /// about), fan out.
    func mutate<system>(
      caller : Principal,
      bumpLobbyToo : Bool,
      op : (Int, TP.PlayerId) -> TP.Res<TP.TableId>,
    ) : async* TP.Res<TP.TableId> {
      let ?player = playerOf(caller) else return #err(#unauthorized);
      let now = Time.now();
      markSeen(player, now);
      switch (op(now, player)) {
        case (#err e) #err e;
        case (#ok id) {
          await* afterMutation<system>(now, id, bumpLobbyToo);
          #ok id;
        };
      };
    };

    func ack(r : TP.Res<TP.TableId>) : Ack {
      switch (r) {
        case (#err e) #err e;
        case (#ok id) #ok { tableId = id; rev = tableRev(id) };
      };
    };

    func at<R>(r : TP.Res<R>, id : TP.TableId) : TP.Res<TP.TableId> {
      switch (r) {
        case (#ok _) #ok id;
        case (#err e) #err e;
      };
    };

    public func createTable<system>(caller : Principal, seat : TP.Seat, visibility : TP.TableVisibility, variant : Text) : async* Ack {
      ack(await* mutate<system>(caller, true, func(now : Int, p : TP.PlayerId) : TP.Res<TP.TableId> = registry.createTable(spec, now, p, seat, visibility, variant)));
    };

    public func joinTable<system>(caller : Principal, id : TP.TableId, seat : TP.Seat, code : ?Text) : async* Ack {
      ack(await* mutate<system>(caller, true, func(now : Int, p : TP.PlayerId) : TP.Res<TP.TableId> = at(registry.joinTable(spec, now, p, id, seat, code), id)));
    };

    public func rematch<system>(caller : Principal, id : TP.TableId) : async* Ack {
      ack(await* mutate<system>(caller, true, func(now : Int, p : TP.PlayerId) : TP.Res<TP.TableId> = at(registry.rematch(spec, now, p, id), id)));
    };

    public func leave<system>(caller : Principal, id : TP.TableId, gen : Nat) : async* Ack {
      ack(await* mutate<system>(caller, true, func(now : Int, p : TP.PlayerId) : TP.Res<TP.TableId> = at(registry.leave(now, p, id, gen), id)));
    };

    public func reset<system>(caller : Principal, id : TP.TableId, gen : Nat) : async* Ack {
      ack(await* mutate<system>(caller, true, func(now : Int, p : TP.PlayerId) : TP.Res<TP.TableId> = at(registry.reset(now, p, id, gen), id)));
    };

    public func claimWin<system>(caller : Principal, id : TP.TableId, gen : Nat) : async* Ack {
      ack(await* mutate<system>(caller, true, func(now : Int, p : TP.PlayerId) : TP.Res<TP.TableId> = at(registry.claimWin(spec, now, p, id, gen), id)));
    };

    public func ackEnded<system>(caller : Principal, id : TP.TableId) : async* Ack {
      ack(
        await* mutate<system>(
          caller,
          true,
          func(_ : Int, p : TP.PlayerId) : TP.Res<TP.TableId> {
            registry.ackEnded(p, id);
            #ok id;
          },
        )
      );
    };

    /// Keeps the caller's waiting table open; changes nothing else.
    public func keepAlive(caller : Principal) : TP.Res<()> {
      let ?player = playerOf(caller) else return #err(#unauthorized);
      markSeen(player, Time.now());
      #ok;
    };

    /// Runs a move and returns its error, if any; `reply` turns that into
    /// `duel_submit`'s reply (two steps because an `async*` result must
    /// be a shared type, which the generic `Reply<S>` is not).
    public func submit<system>(caller : Principal, id : TP.TableId, gen : Nat, turn : Nat, move : M) : async* ?TP.Err {
      switch (await* mutate<system>(caller, false, func(now : Int, p : TP.PlayerId) : TP.Res<TP.TableId> = at(registry.submit(spec, now, p, id, gen, turn, move), id))) {
        case (#ok _) null;
        case (#err e) ?e;
      };
    };

    /// Read at `Time.now()`: a canister player may have answered in the
    /// meantime.
    public func reply(caller : Principal, id : TP.TableId, err : ?TP.Err) : Reply<S> {
      switch (err) {
        case (?e) #err e;
        case null switch (registry.tables.get(id)) {
          case null #err(#noSuchTable);
          case (?t) #view { rev = t.rev; view = t.status(spec, Time.now(), caller.toText()) };
        };
      };
    };

    /// The caller's view of table `id`, built only when its `rev` moved.
    public func table(caller : Principal, id : TP.TableId, rev : Nat) : TableResult<S> {
      switch (registry.tables.get(id)) {
        case null #gone;
        case (?t) {
          if (rev != 0 and t.rev == rev) return #unchanged;
          #changed { rev = t.rev; view = t.status(spec, Time.now(), caller.toText()) };
        };
      };
    };

    /// The open tables and the caller's own, built only when the lobby's
    /// `rev` moved.
    public func lobbyOf(caller : Principal, rev : Nat) : LobbyResult {
      if (rev != 0 and state.lobbyRev == rev) return #unchanged;
      let yours = switch (playerOf(caller)) {
        case (?p) registry.tablesOf(p);
        case null [];
      };
      #changed { rev = state.lobbyRev; tables = registry.listTables(Time.now()); yours };
    };

    /// Clears expired tables (a waiting one stays while its creator is
    /// present), bumps the `rev` of every table it changed and the
    /// lobby's when anything changed, prunes presence, then settles
    /// canister players everywhere (the slow fallback).
    public func sweep<system>(now : Int) : async* () {
      func shape(t : TP.Table<S, M>) : (Nat, Nat) {
        let tag = switch (t.phase) {
          case (#empty) 0;
          case (#staging _) 1;
          case (#active _) 2;
          case (#debrief _) 3;
        };
        (tag, t.lastEnded.size());
      };
      let before = Map.empty<TP.TableId, (Nat, Nat)>();
      for ((id, t) in registry.tables.entries()) before.add(id, shape(t));
      registry.sweep(now, func(p) = isPresent(state, p, now));
      for ((p, t) in state.presence.toArray().values()) {
        if (now - t >= PRESENCE_TTL_NS) state.presence.remove(p);
      };
      var changed = false;
      for ((id, old) in before.entries()) {
        switch (registry.tables.get(id)) {
          case (?t) if (shape(t) != old) {
            t.rev += 1;
            changed := true;
          };
          case null changed := true;
        };
      };
      if (changed) bumpLobby();
      switch (botCtx) {
        case (?ctx) await* CanisterPlayers.sweep<system, S, M>(ctx, now);
        case null {};
      };
    };

    /// For `./transport_actor_mixin`: closures over this `Duel`.
    public let lobby : Lobby = {
      createTable = func<system>(c : Principal, seat : TP.Seat, v : TP.TableVisibility, variant : Text) : async* Ack = await* createTable<system>(c, seat, v, variant);
      joinTable = func<system>(c : Principal, id : TP.TableId, seat : TP.Seat, code : ?Text) : async* Ack = await* joinTable<system>(c, id, seat, code);
      rematch = func<system>(c : Principal, id : TP.TableId) : async* Ack = await* rematch<system>(c, id);
      leave = func<system>(c : Principal, id : TP.TableId, gen : Nat) : async* Ack = await* leave<system>(c, id, gen);
      reset = func<system>(c : Principal, id : TP.TableId, gen : Nat) : async* Ack = await* reset<system>(c, id, gen);
      claimWin = func<system>(c : Principal, id : TP.TableId, gen : Nat) : async* Ack = await* claimWin<system>(c, id, gen);
      ackEnded = func<system>(c : Principal, id : TP.TableId) : async* Ack = await* ackEnded<system>(c, id);
      keepAlive;
      lobby = lobbyOf;
      sweep = func<system>(now : Int) : async* () = await* sweep<system>(now);
    };

    /// For `./canister_players_actor_mixin`; `null` without bots.
    public let canisterPlayers : ?CanisterPlayers.Endpoint = switch (botCtx) {
      case (?ctx) ?CanisterPlayers.endpointOf(ctx);
      case null null;
    };
  };
};
