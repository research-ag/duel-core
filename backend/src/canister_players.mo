/// duel-game-core/canister_players — lets a CANISTER take a seat and play.
///
/// The game canister calls the player canister's `make_move` and treats
/// the reply as the move; a move never arrives as a separate inbound call
/// (that would reopen the unordered-second-channel race rule 11 closes).
/// Identity is a third sid namespace, `cp:<principal>:<tableId>:<complexity>`
/// (`sidForCanister`), always derived from `msg.caller` — nothing to
/// spoof — and one session per board, so one canister may sit at many
/// tables. `complexity` is the bot's own way of playing this seat, picked
/// at seating time, opaque here, carried on every `MoveRequest`.
///
/// `notifyAndApply` is the protocol: build a `MoveRequest` from the
/// table's own status, `await` the host's `callBot`, re-read `gen`/`turn`
/// fresh, `registry.submit`, then the same fan-out `transport.mo` runs. An
/// illegal reply is retried once with `retryReason`; a trap or any other
/// rejection is treated as silence and left to the engine's timeouts.
/// `settle(now, id)` asks a due seat, claims a win for an overdue waiting
/// seat, arms `armClaimCheck` for one not yet overdue, and acks a finished
/// debrief once the other seat is gone or is itself a canister. A seat
/// that becomes due inside another canister's reply is asked from a fresh
/// message (`armClaimCheck(id, 0)`), never in the same call. `sweep` is
/// the slow full-registry fallback.
///
/// See `../README.md`, "Canister players", for the host wiring (the
/// `settle` indirection between `Transport.attach` and `attach` here) and bot
/// discovery.

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

  public let CP_SID_PREFIX : Text = "cp:";

  /// What a bot with no declared complexities is listed under, and what
  /// an empty `complexity` argument normalizes to.
  public let DEFAULT_COMPLEXITY : Text = "Default";

  public func normalizeComplexity(complexity : Text) : Text = if (complexity == "") DEFAULT_COMPLEXITY else complexity;

  /// Duplicates `Transport.sidFor`'s shape rather than importing
  /// `transport.mo`. `complexity` may itself
  /// contain `:` (it is the last segment).
  public func sidForCanister(p : Principal.Principal, tableId : T.TableId, complexity : Text) : T.SessionId {
    CP_SID_PREFIX # p.toText() # ":" # tableId.toText() # ":" # normalizeComplexity(complexity);
  };

  // Traps on a non-`cp:` session; every call site checks first.
  func parseSession(session : T.SessionId) : (Text, Text) {
    let parts = session.trimStart(#text CP_SID_PREFIX).split(#char ':');
    switch (parts.next(), parts.next()) {
      case (?p, ?_) (p, normalizeComplexity(parts.join(":")));
      case (_, _) Runtime.trap("malformed cp: session " # session);
    };
  };

  public func principalOfCanisterSession(session : T.SessionId) : Principal.Principal = Principal.fromText(parseSession(session).0);

  public func complexityOfCanisterSession(session : T.SessionId) : Text = parseSession(session).1;

  public func isCanisterSession(session : T.SessionId) : Bool = session.startsWith(#text CP_SID_PREFIX);

  /// Per-bot, per-complexity leaderboard key (`cp:<principal>:<complexity>`),
  /// since a `cp:` session itself is per-table. Shared by `rankedBots` and
  /// every host's `playerKey`.
  public func leaderboardKey(p : Principal.Principal, complexity : Text) : Text = CP_SID_PREFIX # p.toText() # ":" # normalizeComplexity(complexity);

  public func leaderboardKeyOfSession(session : T.SessionId) : Text {
    let (p, complexity) = parseSession(session);
    CP_SID_PREFIX # p # ":" # complexity;
  };

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

  /// No `submit` (a move is only ever the reply to `make_move`) and no
  /// `rematch` (a canister-vs-canister debrief auto-acks; a human's
  /// rematch against a bot is their frontend re-issuing `play`).
  /// `leave`/`ackEnded`/`claimWin`/`reset` take an explicit `tableId`.
  /// The trailing `Text` on `createTable`/`joinTable` is the complexity.
  public type Attached = {
    createTable : (Principal.Principal, T.Seat, T.TableVisibility, Text, Text) -> async* T.Res<T.TableId>;
    joinTable : (Principal.Principal, T.TableId, T.Seat, ?Text, Text) -> async* T.Res<T.JoinOk>;
    leave : (Principal.Principal, T.TableId, Nat) -> async* T.Res<()>;
    ackEnded : (Principal.Principal, T.TableId) -> async* ();
    claimWin : (Principal.Principal, T.TableId, Nat) -> async* T.Res<()>;
    reset : (Principal.Principal, T.TableId, Nat) -> async* T.Res<()>;
    settle : (Int, T.TableId) -> async* ();
    sweep : (Int) -> async* ();
  };

  /// `callBot` is continuation-passing (Motoko rejects `async M` for a
  /// generic `M`): the host calls `k(?move)` on success, `k(null)` on a
  /// trap. `armClaimCheck(id, secs)` schedules one future `settle` — a
  /// host hook because only an actor holds `Timer.setTimer`'s `<system>`;
  /// `secs` is `0` for a canister seat that became due inside another
  /// canister's reply.
  /// `afterMutationSettles` says who owns settlement after a mutation
  /// made here: `true` when `afterMutation` itself ends in this module's
  /// `settle` (`Transport.Attached.afterMutation` with `onSettled` wired
  /// to it); `false` makes this module settle the table itself.
  public func attach<S, M>(
    spec : T.Spec<S, M>,
    registry : T.Registry<S, M>,
    afterMutation : (Int, T.SessionId, ?T.TableId, Bool) -> async* (),
    afterMutationSettles : Bool,
    callBot : (T.SessionId, T.MoveRequest<S, M>, (?M) -> async* ()) -> async* (),
    armClaimCheck : (T.TableId, Nat) -> async* (),

  ) : Attached {

    // Prevents asking the same due seat twice while an ask is pending.
    let inFlight = Map.empty<Text, ()>();
    func flightKey(id : T.TableId, seat : T.Seat) : Text {
      id.toText() # (switch (seat) { case (#p1) "/p1"; case (#p2) "/p2" });
    };

    // Tables settling inside a canister's own reply, counted per reply.
    let replying = Map.empty<T.TableId, Nat>();
    func enterReply(id : T.TableId) {
      replying.add(id, (switch (replying.get(id)) { case (?n) n; case null 0 }) + 1);
    };
    func exitReply(id : T.TableId) {
      switch (replying.get(id)) {
        case (?n) if (n > 1) replying.add(id, n - 1 : Nat) else replying.remove(id);
        case null {};
      };
    };

    /// `null` unless `session` is seated in-game and due to move
    /// (`not youSubmitted` means "due" in either mode). Fields `View`
    /// lacks come from the `Active` record in the same synchronous step.
    func dueRequest(now : Int, id : T.TableId, session : T.SessionId) : ?T.MoveRequest<S, M> {
      switch (registry.status(spec, now, session)) {
        case (#atTable { view = #inGame ig }) {
          if (ig.youSubmitted) { null } else {
            switch (registry.tables.get(id)) {
              case null null;
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
                    turn = ig.turn;
                    gen = ig.gen;
                    complexity = complexityOfCanisterSession(session);
                    retryReason = null;
                    opponent;
                    opponentLastMove;
                    lastRoundDurationNs = g.lastRoundDurationNs;
                  };
                };
                case (_) null;
              };
            };
          };
        };
        case (_) null;
      };
    };

    func notifyAndApply(id : T.TableId, session : T.SessionId, req : T.MoveRequest<S, M>) : async* () {
      let key = flightKey(id, req.seat);
      inFlight.add(key, ());

      func tryOnce(triesLeft : Nat, thisReq : T.MoveRequest<S, M>) : async* () {
        await* callBot(
          session,
          thisReq,
          func(maybeMove : ?M) : async* () {
            switch (maybeMove) {
              case null {}; // trapped/errored — silence
              case (?move) {
                let now = Time.now();
                // Re-read gen/turn fresh: the table may have moved on
                // during the bot's await.
                switch (dueRequest(now, id, session)) {
                  case null {};
                  case (?fresh) switch (registry.submit(spec, now, session, fresh.gen, fresh.turn, move)) {
                    case (#ok _) {
                      enterReply(id);
                      await* afterMutation(now, session, ?id, false);
                      await* settleUnlessOwned(now, id);
                      exitReply(id);
                    };
                    case (#err(#illegalMove reason)) {
                      if (triesLeft > 0) {
                        await* tryOnce(triesLeft - 1 : Nat, { fresh with retryReason = ?reason });
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

      await* tryOnce(1, req);
      inFlight.remove(key);
    };

    func isDue(now : Int, session : T.SessionId) : Bool {
      switch (registry.status(spec, now, session)) {
        case (#atTable { view = #inGame ig }) not ig.youSubmitted;
        case (_) false;
      };
    };

    /// Due when this settle began (`dueAtStart`): ask, or, inside another
    /// canister's reply, arm an immediate wakeup that asks from a fresh
    /// message. A seat that became due since was made due by a mutation
    /// whose own settle covers it. So a canister-vs-canister match
    /// advances one move per message, never inside one call. Waiting and
    /// overdue: claim. Waiting, not yet overdue: arm one wakeup. No-op
    /// outside `#active`.
    func maybeNotify(now : Int, id : T.TableId, session : T.SessionId, dueAtStart : Bool) : async* () {
      if (not isCanisterSession(session)) return;
      switch (registry.status(spec, now, session)) {
        case (#atTable { view = #inGame ig }) {
          if (not ig.youSubmitted) {
            if (not dueAtStart) {} else if (replying.get(id) != null) {
              await* armClaimCheck(id, 0);
            } else if (inFlight.get(flightKey(id, ig.seat)) == null) {
              switch (dueRequest(now, id, session)) {
                case (?req) await* notifyAndApply(id, session, req);
                case null {};
              };
            };
          } else if (ig.claimWinAvailable) {
            switch (registry.claimWin(spec, now, session, ig.gen)) {
              case (#ok _) await* afterMutation(now, session, ?id, true);
              case (#err _) {};
            };
          } else {
            await* armClaimCheck(id, ig.secondsUntilClaimable);
          };
        };
        case (_) {};
      };
    };

    /// Acks a canister seat's debrief once the partner is no longer a live
    /// participant or is itself a canister (two canister seats would
    /// otherwise deadlock on each other's ack).
    func maybeAckDebrief(now : Int, id : T.TableId, t : T.Table<S, M>, d : T.Debrief<S>, session : T.SessionId) : async* () {
      if (not isCanisterSession(session)) return;
      if (t.activeDebriefSeat(d, session) == null) return;
      let partner = if (d.p1 == session) { d.p2 } else { d.p1 };
      let partnerGoneOrCanister = isCanisterSession(partner) or t.activeDebriefSeat(d, partner) == null;
      if (not partnerGoneOrCanister) return;
      switch (registry.leave(now, session, t.gen)) {
        case (#ok _) await* afterMutation(now, session, ?id, true);
        case (#err _) {};
      };
    };

    func maybeSettleBoth(now : Int, id : T.TableId) : async* () {
      switch (registry.tables.get(id)) {
        case null {};
        case (?t) switch (t.phase) {
          case (#active g) {
            let due1 = isDue(now, g.p1);
            let due2 = isDue(now, g.p2);
            await* maybeNotify(now, id, g.p1, due1);
            await* maybeNotify(now, id, g.p2, due2);
          };
          case (#debrief d) {
            await* maybeAckDebrief(now, id, t, d, d.p1);
            await* maybeAckDebrief(now, id, t, d, d.p2);
          };
          case (_) {};
        };
      };
    };

    func settleUnlessOwned(now : Int, id : T.TableId) : async* () {
      if (not afterMutationSettles) await* maybeSettleBoth(now, id);
    };

    /// The session `caller` holds at board `id`, read off the phase record
    /// (and `lastEnded`, for `ackEnded`) by principal + tableId prefix.
    func sessionAt(caller : Principal.Principal, id : T.TableId) : ?T.SessionId {
      let prefix = CP_SID_PREFIX # caller.toText() # ":" # id.toText() # ":";
      switch (registry.tables.get(id)) {
        case null null;
        case (?t) {
          let seated : [T.SessionId] = switch (t.phase) {
            case (#empty) [];
            case (#staging s) [s.session];
            case (#active g) [g.p1, g.p2];
            case (#debrief d) [d.p1, d.p2];
          };
          let ended = t.lastEnded.flatMap<T.Ended, T.SessionId>(func(e) = [e.p1, e.p2].values());
          seated.concat(ended).find(func(s : T.SessionId) : Bool = s.startsWith(#text prefix));
        };
      };
    };

    {
      // No `await*` between `peekNextTableId` and `createTable`.
      createTable = func(caller : Principal.Principal, seat : T.Seat, visibility : T.TableVisibility, variant : Text, complexity : Text) : async* T.Res<T.TableId> {
        let now = Time.now();
        let id = registry.peekNextTableId();
        let session = sidForCanister(caller, id, complexity);
        switch (registry.createTable(spec, now, session, seat, visibility, variant)) {
          case (#ok gotId) {
            await* afterMutation(now, session, ?gotId, true);
            #ok(gotId);
          };
          case (#err e) #err(e);
        };
      };

      joinTable = func(caller : Principal.Principal, id : T.TableId, seat : T.Seat, code : ?Text, complexity : Text) : async* T.Res<T.JoinOk> {
        let session = sidForCanister(caller, id, complexity);
        let now = Time.now();
        switch (registry.joinTable(spec, now, session, id, seat, code)) {
          case (#ok j) {
            await* afterMutation(now, session, ?id, true);
            await* settleUnlessOwned(Time.now(), id);
            #ok(j);
          };
          case (#err e) #err(e);
        };
      };

      leave = func(caller : Principal.Principal, tableId : T.TableId, gen : Nat) : async* T.Res<()> {
        switch (sessionAt(caller, tableId)) {
          case null #err(#notSeated);
          case (?session) {
            let now = Time.now();
            switch (registry.leave(now, session, gen)) {
              case (#ok _) {
                await* afterMutation(now, session, ?tableId, true);
                #ok(());
              };
              case (#err e) #err(e);
            };
          };
        };
      };

      ackEnded = func(caller : Principal.Principal, tableId : T.TableId) : async* () {
        switch (sessionAt(caller, tableId)) {
          case null {};
          case (?session) {
            let now = Time.now();
            registry.ackEnded(session);
            await* afterMutation(now, session, ?tableId, true);
          };
        };
      };

      claimWin = func(caller : Principal.Principal, tableId : T.TableId, gen : Nat) : async* T.Res<()> {
        switch (sessionAt(caller, tableId)) {
          case null #err(#notSeated);
          case (?session) {
            let now = Time.now();
            switch (registry.claimWin(spec, now, session, gen)) {
              case (#ok _) {
                await* afterMutation(now, session, ?tableId, true);
                #ok(());
              };
              case (#err e) #err(e);
            };
          };
        };
      };

      reset = func(caller : Principal.Principal, tableId : T.TableId, gen : Nat) : async* T.Res<()> {
        switch (sessionAt(caller, tableId)) {
          case null #err(#notSeated);
          case (?session) {
            let now = Time.now();
            switch (registry.reset(now, session, gen)) {
              case (#ok _) {
                await* afterMutation(now, session, ?tableId, true);
                #ok(());
              };
              case (#err e) #err(e);
            };
          };
        };
      };

      settle = maybeSettleBoth;

      sweep = func(now : Int) : async* () {
        for ((id, _) in registry.tables.toArray().values()) {
          await* maybeSettleBoth(now, id);
        };
      };
    };
  };
};
