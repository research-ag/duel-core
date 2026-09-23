import Int "mo:core/Int";
import Map "mo:core/Map";
import Principal "mo:core/Principal";
import Time "mo:core/Time";
import Timer "mo:core/Timer";

import TP "mo:duel-game-core";
import Ws "mo:duel-game-core/ws";
import ActorMixin "mo:duel-game-core/actor_mixin";
import CanisterPlayers "mo:duel-game-core/canister_players";
import CanisterPlayersActorMixin "mo:duel-game-core/canister_players_actor_mixin";
import Registry "mo:duel-game-core/registry";
import Leaderboard "mo:duel-game-core/leaderboard";
import LeaderboardActorMixin "mo:duel-game-core/leaderboard_actor_mixin";
import IcWebSocketCdkTypes "mo:ic-websocket-cdk/Types";
import PT "mo:promtracker";
import Http "mo:promtracker/mixins/http";
import Tracker "mo:promtracker/Tracker"; // enables pt.toValue() dot notation

import BotIface "BotIface";
import Rules "RacingRules";

persistent actor {

  let pt = PT.Tracker.new();
  transient let renderer = PT.Renderer();
  renderer.addValue(PT.allSystemMetrics);
  renderer.addValue(pt.toValue());

  let registry = Registry.new<Rules.State, Rules.Action>(300_000_000_000, 45_000_000_000); // 300s idle timeout, 45s claim-win window, shared by every table
  registry.attachMetrics(pt);

  public query func status(sid : Text) : async TP.SessionStatus<Rules.State> {
    registry.status(Rules.spec(), Time.now(), sid);
  };

  // Best-lap leaderboard: a plain, stable `Leaderboard.Board` this actor
  // owns directly, kept at 50 entries — see `../../backend/README.md`'s
  // "Leaderboard" section. Every board this framework ships sorts
  // highest-score-first, so a lower (better) lap time is converted into a
  // higher-is-better score right here, the one place this game's own
  // notion of "better" is known: one hour of headroom in milliseconds,
  // floored at zero for a race that (implausibly) runs longer.
  // `defaultScore` (the board's 2nd argument) is never actually consulted
  // here: unlike an ELO rating, a lap time is never "computed FROM" a
  // prior score (`recordIfBetter` below decides purely by comparing the
  // NEW score to whatever's on record, or its own capacity check for a
  // brand-new player), so this value is inert — 0 purely because `new`
  // requires SOME `Int`.
  let leaderboard = Leaderboard.new(50, 0);
  let ONE_HOUR_MS : Int = 3_600_000;
  func scoreFromLapMs(ms : Int) : Int = Int.max(0, ONE_HOUR_MS - ms);

  // See `Ws.OnGameStarted`'s own doc: nothing in the engine timestamps
  // when a match started, and `RacingRules.State` can't self-timestamp
  // either (`init` is pure, no `Time`) — so this actor keeps its own
  // small side map, populated the instant a table goes `#active` and
  // consumed (removed) the instant that same table's game ends.
  let raceStarts = Map.empty<TP.TableId, Int>();

  func onGameStarted(id : TP.TableId, _p1 : TP.SessionId, _p2 : TP.SessionId) {
    raceStarts.add(id, Time.now());
  };

  // Normalizes a session id down to a stable per-PLAYER key. `Ws.playerKey`
  // already handles `ii:`/`an:`; a `cp:` canister-player session is
  // deliberately PER-TABLE (`CanisterPlayers.sidForCanister`), so it's
  // special-cased here — the one place this actor already has both
  // `Ws`/`CanisterPlayers` wired — down to the bot's own underlying,
  // stable principal, so one bot's best lap accumulates across every
  // table it races on instead of resetting per board.
  func playerKey(sid : TP.SessionId) : Text {
    if (CanisterPlayers.isCanisterSession(sid)) {
      "cp:" # CanisterPlayers.principalOfCanisterSession(sid).toText();
    } else {
      Ws.playerKey(sid);
    };
  };

  // Fires once per race ending (see `Ws.OnGameEnded`'s own doc). Only a
  // clean `#finished` win records a lap time — a draw (an exact
  // photo-finish tie) has no completed winner, and `#claimed`/`#aborted`
  // mean nobody actually crossed the line either, so neither produces a
  // lap to score. A race with no recorded start (this table's own
  // `onGameStarted` never fired, which shouldn't happen in practice) is
  // silently skipped rather than scored against a made-up baseline.
  func onGameEnded(id : TP.TableId, p1 : TP.SessionId, p2 : TP.SessionId, d : TP.Debrief<Rules.State>) {
    let winner : ?TP.SessionId = switch (d.end) {
      case (#finished(#p1Wins)) ?p1;
      case (#finished(#p2Wins)) ?p2;
      case (_) null; // draw, claimed, or aborted — nobody finished a lap
    };
    switch (winner, raceStarts.get(id)) {
      case (?w, ?startedAt) {
        let lapMs = (d.since - startedAt) / 1_000_000;
        ignore Leaderboard.recordIfBetter(leaderboard, playerKey(w), scoreFromLapMs(lapMs), Time.now());
      };
      case (_, _) {};
    };
    raceStarts.remove(id);
  };

  // Breaks the circular dependency between `attached` and `cpAttached`
  // below — see `mo:duel-game-core/canister_players`'s doc header.
  transient var settleTable : ?((Int, TP.TableId) -> async* ()) = null;
  transient let settle = func(now : Int, id : TP.TableId) : async* () {
    switch (settleTable) {
      case (?f) await* f(now, id);
      case null {};
    };
  };

  transient let wsHub : Ws.Hub = Ws.createHub();
  transient let attached = Ws.attach<system, Rules.State, Rules.Action>(
    Rules.spec(),
    registry,
    wsHub,
    {
      encode = func(m : Ws.Msg<Rules.State, Rules.Action>) : Blob = to_candid (m);
      decode = func(b : Blob) : ?Ws.Msg<Rules.State, Rules.Action> = from_candid (b);
    },
    IcWebSocketCdkTypes.WsInitParams(null, ?65_000),
    ?settle,
    ?onGameEnded,
    ?onGameStarted,
  );
  attached.ws.init<system>();

  // Canister players (Flow 1, self-join — see ../../CLAUDE.md's "Canister
  // players" note).
  transient let cpAttached = CanisterPlayers.attach<Rules.State, Rules.Action>(
    Rules.spec(),
    registry,
    attached.afterMutation,
    func(session : TP.SessionId, req : TP.MoveRequest<Rules.State>, k : (?Rules.Action) -> async* ()) : async* () {
      let p = CanisterPlayers.principalOfCanisterSession(session);
      let bot : BotIface.CanisterPlayer = actor (p.toText());
      try { await* k(?(await bot.make_move(req))) } catch (_) { await* k(null) };
    },
    func(id : TP.TableId, secs : Nat) : async* () {
      ignore Timer.setTimer<system>(#seconds secs, func() : async () { await* settle(Time.now(), id) });
    },
  );
  settleTable := ?cpAttached.settle;

  transient let combinedSweep = func(now : Int) : async* () {
    await* attached.sweep(now);
    await* cpAttached.sweep(now);
  };
  include ActorMixin<system>(attached.ws, combinedSweep);

  include Http(renderer.renderExposition, "/metrics");

  include CanisterPlayersActorMixin(cpAttached);

  // Supplies `get_leaderboard()` (the top 25 best laps, `Entry.score` the
  // STORED, ELO-shaped number — the frontend's own `formatScore` converts
  // it back to a real lap time for display) — no hand-declared query
  // needed.
  include LeaderboardActorMixin(leaderboard, 25);

};
