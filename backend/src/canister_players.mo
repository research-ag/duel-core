/// duel-game-core/canister_players — lets a CANISTER take a seat and play.
///
/// The game canister calls the player canister's `make_move` and treats
/// the reply as the move; a move never arrives as a separate inbound call
/// (that would reopen the unordered-second-channel race rule 11 closes).
/// A bot's player id is `cp:<principal>:<complexity>` (`idForCanister`),
/// always derived from `msg.caller` — nothing to spoof. `complexity` is
/// the bot's own way of playing, picked at seating time, opaque here,
/// carried on every `MoveRequest`; it also tells two seats of one bot
/// canister apart at the same table.
///
/// `notifyAndApply` is the protocol: build a `MoveRequest` from the
/// table's own status, `await` the host's `CallBot`, re-read `gen`/`step`
/// fresh, `registry.submit`, then the same fan-out `transport.mo` runs
/// (which ends in `settle`). An
/// illegal reply is retried once with `retryReason`; a trap or any other
/// rejection is treated as silence and left to the engine's timeouts.
/// `settle(now, id)` asks a due seat, claims a win for an overdue waiting
/// seat, arms a timer for one not yet overdue, and acks a finished
/// debrief once the other seat is gone or is itself a canister. A seat
/// that becomes due inside another canister's reply is asked from a fresh
/// message (a 0-second timer), never in the same call. `sweep` is the
/// slow full-registry fallback.
///
/// All data is the stable `Store`; `transport.mo`'s `Duel` class binds it
/// with the host's `CallBot` and drives everything here.

import Array "mo:core/Array";
import Int "mo:core/Int";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Order "mo:core/Order";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Time "mo:core/Time";

import Registry "./registry";
import Table "./table";
import T "./types";

module {

  public let CP_ID_PREFIX : Text = "cp:";

  /// What a bot with no declared complexities is listed under, and what
  /// an empty `complexity` argument normalizes to.
  public let DEFAULT_COMPLEXITY : Text = "Default";

  public func normalizeComplexity(complexity : Text) : Text = if (complexity == "") DEFAULT_COMPLEXITY else complexity;

  /// A bot's player id. `complexity` may itself contain `:` (it is the
  /// last segment).
  public func idForCanister(p : Principal.Principal, complexity : Text) : T.PlayerId {
    CP_ID_PREFIX # p.toText() # ":" # normalizeComplexity(complexity);
  };

  // Traps on a non-`cp:` session; every call site checks first.
  func parseSession(session : T.PlayerId) : (Text, Text) {
    let parts = session.trimStart(#text CP_ID_PREFIX).split(#char ':');
    switch (parts.next(), parts.next()) {
      case (?p, ?first) {
        let rest = parts.join(":");
        (p, normalizeComplexity(if (rest == "") first else first # ":" # rest));
      };
      case (_, _) Runtime.trap("malformed cp: session " # session);
    };
  };

  public func principalOfCanisterSession(session : T.PlayerId) : Principal.Principal = Principal.fromText(parseSession(session).0);

  public func complexityOfCanisterSession(session : T.PlayerId) : Text = parseSession(session).1;

  public func isCanisterSession(session : T.PlayerId) : Bool = session.startsWith(#text CP_ID_PREFIX);

  /// A bot's leaderboard key: its player id, so each complexity is rated
  /// separately.
  public func leaderboardKey(p : Principal.Principal, complexity : Text) : Text = idForCanister(p, complexity);

  // ── Bot discovery ────────────────────────────────────────────────────────

  /// `principal` is always `msg.caller` at registration. `complexities`
  /// keeps the declared order and is never empty.
  public type BotInfo = {
    principal : Principal.Principal;
    name : Text;
    complexities : [Text];
    registeredAt : Int;
  };

  /// `elo` is `null` only when the host wires no leaderboard.
  public type BotComplexityEntry = {
    complexity : Text;
    elo : ?Int;
  };

  public type BotEntry = {
    principal : Principal.Principal;
    name : Text;
    complexities : [BotComplexityEntry];
  };

  public type BotDirectory = {
    var bots : Map.Map<Principal.Principal, BotInfo>;
  };

  public func newBotDirectory() : BotDirectory = { var bots = Map.empty() };

  /// Idempotent upsert by `caller`. Keeps declared order, normalizes `""`,
  /// drops duplicates, replaces `[]` with `[DEFAULT_COMPLEXITY]`.
  public func registerBot(d : BotDirectory, caller : Principal.Principal, name : Text, complexities : [Text], now : Int) {
    let seen = List.empty<Text>();
    for (c in complexities.values()) {
      let n = normalizeComplexity(c);
      if (seen.find(func(x : Text) : Bool = x == n) == null) seen.add(n);
    };
    if (seen.isEmpty()) seen.add(DEFAULT_COMPLEXITY);
    d.bots.add(caller, { principal = caller; name; complexities = seen.toArray(); registeredAt = now });
  };

  public func unregisterBot(d : BotDirectory, caller : Principal.Principal) {
    d.bots.remove(caller);
  };

  public func listBots(d : BotDirectory) : [BotInfo] {
    d.bots.toArray().map<(Principal.Principal, BotInfo), BotInfo>(func((_, v)) = v);
  };

  /// Joins each complexity with `scoreOf` and sorts bots by their best
  /// complexity, highest first, unrated last, name as tiebreak. Takes a
  /// function rather than importing `leaderboard.mo`.
  public func rankedBots(bots : [BotInfo], scoreOf : (Principal.Principal, Text) -> ?Int) : [BotEntry] {
    let entries = bots.map(
      func(b : BotInfo) : BotEntry = {
        principal = b.principal;
        name = b.name;
        complexities = b.complexities.map(func(c : Text) : BotComplexityEntry = { complexity = c; elo = scoreOf(b.principal, c) });
      }
    );
    func best(e : BotEntry) : ?Int = e.complexities.foldLeft<BotComplexityEntry, ?Int>(
      null,
      func(acc, c) = switch (acc, c.elo) {
        case (?a, ?x) ?Int.max(a, x);
        case (null, x) x;
        case (a, null) a;
      },
    );
    entries.sort(
      func(a : BotEntry, b : BotEntry) : Order.Order {
        switch (best(a), best(b)) {
          case (?x, ?y) {
            if (x == y) Text.compare(a.name, b.name) else Int.compare(y, x);
          };
          case (?_, null) #less;
          case (null, ?_) #greater;
          case (null, null) Text.compare(a.name, b.name);
        };
      }
    );
  };

  /// Calls a bot's `make_move` — the one thing only the host can do,
  /// since an inter-canister call returning a generic `M` does not
  /// type-check here. Continuation-passing: the host calls `k(?move)` on
  /// a reply, `k(null)` on a trap or rejection.
  public type CallBot<V, M> = <system>(T.PlayerId, T.MoveRequest<V, M>, <system>(?M) -> async* ()) -> async* ();

  /// Everything kept here. Stable.
  public type Store = {
    directory : BotDirectory;
    /// Due seats (`tableId/seat`) with an ask outstanding.
    inFlight : Map.Map<Text, ()>;
    /// Tables settling inside a canister's own reply, counted per reply.
    replying : Map.Map<T.TableId, Nat>;
  };

  public func newStore() : Store = {
    directory = newBotDirectory();
    inFlight = Map.empty<Text, ()>();
    replying = Map.empty<T.TableId, Nat>();
  };

  /// What `settle` and friends need from the transport: the registry and
  /// rules, the host's `CallBot`, and the transport's fan-out after a
  /// mutation made here (which itself ends in `settle`).
  public type Ctx<S, M, V, O> = {
    registry : T.Registry<S, M, O>;
    spec : T.Spec<S, M, V, O>;
    rng : T.Rng;
    store : Store;
    call : CallBot<V, M>;
    afterMutation : <system>(Int, T.TableId, Bool) -> async* ();
    /// Arms a `settle(id)` after `secs` from a fresh message.
    arm : <system>(T.TableId, Nat) -> ();
  };

  func flightKey(id : T.TableId, seat : T.Seat) : Text {
    id.toText() # (switch (seat) { case (#p1) "/p1"; case (#p2) "/p2" });
  };

  func enterReply(store : Store, id : T.TableId) {
    store.replying.add(id, (switch (store.replying.get(id)) { case (?n) n; case null 0 }) + 1);
  };

  func exitReply(store : Store, id : T.TableId) {
    switch (store.replying.get(id)) {
      case (?n) if (n > 1) store.replying.add(id, n - 1 : Nat) else store.replying.remove(id);
      case null {};
    };
  };

  func inGameView<S, M, V, O>(ctx : Ctx<S, M, V, O>, now : Int, id : T.TableId, player : T.PlayerId) : ?{
    seat : T.Seat;
    game : V;
    mode : T.Mode;
    step : Nat;
    gen : Nat;
    youSubmitted : Bool;
    claimWinAvailable : Bool;
    secondsUntilClaimable : Nat;
  } {
    switch (ctx.registry.view(ctx.spec, now, player, id)) {
      case (?#inGame ig) ?{
        seat = ig.seat;
        game = ig.game;
        mode = ig.mode;
        step = ig.step;
        gen = ig.gen;
        youSubmitted = ig.youSubmitted;
        claimWinAvailable = ig.claimWinAvailable;
        secondsUntilClaimable = ig.secondsUntilClaimable;
      };
      case (_) null;
    };
  };

  /// `null` unless `player` is seated in-game at `id` and due to move
  /// (`not youSubmitted` means "due" in either mode). Fields `View`
  /// lacks come from the `Active` record in the same synchronous step.
  func dueRequest<S, M, V, O>(ctx : Ctx<S, M, V, O>, now : Int, id : T.TableId, player : T.PlayerId) : ?T.MoveRequest<V, M> {
    let ?ig = inGameView(ctx, now, id, player) else return null;
    if (ig.youSubmitted) return null;
    switch (ctx.registry.tables.get(id)) {
      case (?t) switch (t.phase) {
        case (#active g) {
          let (opponent, opponentLastMove) = switch (ig.seat) {
            case (#p1) (g.p2, g.lastMoveP2);
            case (#p2) (g.p1, g.lastMoveP1);
          };
          ?{
            tableId = id;
            seat = ig.seat;
            game = ig.game;
            mode = ig.mode;
            step = ig.step;
            gen = ig.gen;
            complexity = complexityOfCanisterSession(player);
            retryReason = null;
            opponent;
            opponentLastMove;
            lastStepDurationNs = g.lastStepDurationNs;
          };
        };
        case (_) null;
      };
      case null null;
    };
  };

  func notifyAndApply<system, S, M, V, O>(ctx : Ctx<S, M, V, O>, id : T.TableId, player : T.PlayerId, req : T.MoveRequest<V, M>) : async* () {
    let key = flightKey(id, req.seat);
    ctx.store.inFlight.add(key, ());

    func tryOnce<system>(triesLeft : Nat, thisReq : T.MoveRequest<V, M>) : async* () {
      await* ctx.call<system>(
        player,
        thisReq,
        func<system>(maybeMove : ?M) : async* () {
          switch (maybeMove) {
            case null {}; // trapped/errored — silence
            case (?move) {
              let now = Time.now();
              // Re-read gen/step fresh: the table may have moved on
              // during the bot's await.
              switch (dueRequest(ctx, now, id, player)) {
                case null {};
                case (?fresh) switch (ctx.registry.submit(ctx.spec, ctx.rng, now, player, id, fresh.gen, fresh.step, move)) {
                  case (#ok _) {
                    enterReply(ctx.store, id);
                    try { await* ctx.afterMutation<system>(now, id, false) } finally {
                      exitReply(ctx.store, id);
                    };
                  };
                  case (#err(#illegalMove reason)) {
                    if (triesLeft > 0) {
                      await* tryOnce<system>(triesLeft - 1 : Nat, { fresh with retryReason = ?reason });
                    };
                  };
                  case (#err _) {}; // table moved on — don't retry
                };
              };
            };
          };
        },
      );
    };

    try { await* tryOnce<system>(1, req) } finally {
      ctx.store.inFlight.remove(key);
    };
  };

  func isDue<S, M, V, O>(ctx : Ctx<S, M, V, O>, now : Int, id : T.TableId, player : T.PlayerId) : Bool {
    switch (inGameView(ctx, now, id, player)) {
      case (?ig) not ig.youSubmitted;
      case null false;
    };
  };

  /// Due when this settle began (`dueAtStart`): ask, or, inside another
  /// canister's reply, arm an immediate wakeup that asks from a fresh
  /// message. A seat that became due since was made due by a mutation
  /// whose own settle covers it. So a canister-vs-canister match
  /// advances one move per message, never inside one call. Waiting and
  /// overdue: claim. Waiting, not yet overdue: arm one wakeup. No-op
  /// outside `#active`.
  func maybeNotify<system, S, M, V, O>(ctx : Ctx<S, M, V, O>, now : Int, id : T.TableId, player : T.PlayerId, dueAtStart : Bool) : async* () {
    if (not isCanisterSession(player)) return;
    let ?ig = inGameView(ctx, now, id, player) else return;
    if (not ig.youSubmitted) {
      if (not dueAtStart) {} else if (ctx.store.replying.get(id) != null) {
        ctx.arm<system>(id, 0);
      } else if (ctx.store.inFlight.get(flightKey(id, ig.seat)) == null) {
        switch (dueRequest(ctx, now, id, player)) {
          case (?req) await* notifyAndApply<system, S, M, V, O>(ctx, id, player, req);
          case null {};
        };
      };
    } else if (ig.claimWinAvailable) {
      switch (ctx.registry.claimWin(ctx.spec, now, player, id, ig.gen)) {
        case (#ok _) await* ctx.afterMutation<system>(now, id, true);
        case (#err _) {};
      };
    } else {
      // `secondsUntilClaimable` rounds down: one more second wakes after
      // the deadline instead of just before it.
      ctx.arm<system>(id, ig.secondsUntilClaimable + 1);
    };
  };

  /// Acks a canister seat's debrief once the partner is no longer a live
  /// participant or is itself a canister (two canister seats would
  /// otherwise deadlock on each other's ack).
  func maybeAckDebrief<system, S, M, V, O>(ctx : Ctx<S, M, V, O>, now : Int, id : T.TableId, t : T.Table<S, M, O>, d : T.Debrief<S>, player : T.PlayerId) : async* () {
    if (not isCanisterSession(player)) return;
    if (t.activeDebriefSeat(d, player) == null) return;
    let partner = if (d.p1 == player) { d.p2 } else { d.p1 };
    let partnerGoneOrCanister = isCanisterSession(partner) or t.activeDebriefSeat(d, partner) == null;
    if (not partnerGoneOrCanister) return;
    switch (ctx.registry.leave(now, player, id, t.gen)) {
      case (#ok _) await* ctx.afterMutation<system>(now, id, true);
      case (#err _) {};
    };
  };

  /// Asks a due canister seat, claims for an overdue one, acks a
  /// finished canister seat's debrief. Run after every mutation.
  public func settle<system, S, M, V, O>(ctx : Ctx<S, M, V, O>, now : Int, id : T.TableId) : async* () {
    switch (ctx.registry.tables.get(id)) {
      case null {};
      case (?t) switch (t.phase) {
        case (#active g) {
          let due1 = isDue(ctx, now, id, g.p1);
          let due2 = isDue(ctx, now, id, g.p2);
          await* maybeNotify<system, S, M, V, O>(ctx, now, id, g.p1, due1);
          await* maybeNotify<system, S, M, V, O>(ctx, now, id, g.p2, due2);
        };
        case (#debrief d) {
          await* maybeAckDebrief<system, S, M, V, O>(ctx, now, id, t, d, d.p1);
          await* maybeAckDebrief<system, S, M, V, O>(ctx, now, id, t, d, d.p2);
        };
        case (_) {};
      };
    };
  };

  /// The slow full-registry fallback.
  public func sweep<system, S, M, V, O>(ctx : Ctx<S, M, V, O>, now : Int) : async* () {
    for ((id, _) in ctx.registry.tables.toArray().values()) {
      await* settle<system, S, M, V, O>(ctx, now, id);
    };
  };

  /// The id `caller` holds at table `id`, read off the phase record (and
  /// `lastEnded`, for `ackEnded`) by principal prefix.
  public func idAt<S, M, O>(registry : T.Registry<S, M, O>, caller : Principal.Principal, id : T.TableId) : ?T.PlayerId {
    let prefix = CP_ID_PREFIX # caller.toText() # ":";
    switch (registry.tables.get(id)) {
      case null null;
      case (?t) {
        let seated : [T.PlayerId] = switch (t.phase) {
          case (#empty) [];
          case (#staging s) [s.session];
          case (#active g) [g.p1, g.p2];
          case (#debrief d) [d.p1, d.p2];
        };
        let ended = t.lastEnded.flatMap<T.Ended, T.PlayerId>(func(e) = [e.p1, e.p2].values());
        seated.concat(ended).find(func(s : T.PlayerId) : Bool = s.startsWith(#text prefix));
      };
    };
  };

  /// The bot-facing methods, as `./canister_players_actor_mixin` exposes
  /// them. No `submit` (a move is only ever the reply to `make_move`) and
  /// no `rematch` (a canister-vs-canister debrief auto-acks; a human's
  /// rematch against a bot is their frontend re-issuing `play`). The
  /// trailing `Text` on `joinTable` is the complexity.
  public type Endpoint = {
    joinTable : <system>(Principal.Principal, T.TableId, T.Seat, ?Text, Text) -> async* T.Res<T.JoinOk>;
    leave : <system>(Principal.Principal, T.TableId, Nat) -> async* T.Res<()>;
    ackEnded : <system>(Principal.Principal, T.TableId) -> async* ();
    claimWin : <system>(Principal.Principal, T.TableId, Nat) -> async* T.Res<()>;
    reset : <system>(Principal.Principal, T.TableId, Nat) -> async* T.Res<()>;
  };

  /// `afterMutation(now, id)` here is the transport's full fan-out
  /// (bumping revs, the leaderboard, `settle`).
  public func endpointOf<S, M, V, O>(ctx : Ctx<S, M, V, O>) : Endpoint = {
    joinTable = func<system>(caller : Principal.Principal, id : T.TableId, seat : T.Seat, code : ?Text, complexity : Text) : async* T.Res<T.JoinOk> {
      let now = Time.now();
      switch (ctx.registry.joinTable(ctx.spec, ctx.rng, now, idForCanister(caller, complexity), id, seat, code)) {
        case (#ok j) {
          await* ctx.afterMutation<system>(now, id, true);
          #ok(j);
        };
        case (#err e) #err(e);
      };
    };
    leave = func<system>(caller : Principal.Principal, id : T.TableId, gen : Nat) : async* T.Res<()> {
      let ?player = idAt(ctx.registry, caller, id) else return #err(#notSeated);
      let now = Time.now();
      switch (ctx.registry.leave(now, player, id, gen)) {
        case (#ok _) {
          await* ctx.afterMutation<system>(now, id, true);
          #ok(());
        };
        case (#err e) #err(e);
      };
    };
    ackEnded = func<system>(caller : Principal.Principal, id : T.TableId) : async* () {
      let ?player = idAt(ctx.registry, caller, id) else return;
      let now = Time.now();
      ctx.registry.ackEnded(player, id);
      await* ctx.afterMutation<system>(now, id, true);
    };
    claimWin = func<system>(caller : Principal.Principal, id : T.TableId, gen : Nat) : async* T.Res<()> {
      let ?player = idAt(ctx.registry, caller, id) else return #err(#notSeated);
      let now = Time.now();
      switch (ctx.registry.claimWin(ctx.spec, now, player, id, gen)) {
        case (#ok _) {
          await* ctx.afterMutation<system>(now, id, true);
          #ok(());
        };
        case (#err e) #err(e);
      };
    };
    reset = func<system>(caller : Principal.Principal, id : T.TableId, gen : Nat) : async* T.Res<()> {
      let ?player = idAt(ctx.registry, caller, id) else return #err(#notSeated);
      let now = Time.now();
      switch (ctx.registry.reset(now, player, id, gen)) {
        case (#ok _) {
          await* ctx.afterMutation<system>(now, id, true);
          #ok(());
        };
        case (#err e) #err(e);
      };
    };
  };
};
