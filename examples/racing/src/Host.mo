import Float "mo:core/Float";
import Int "mo:core/Int";
import Principal "mo:core/Principal";
import Time "mo:core/Time";
import Timer "mo:core/Timer";

import TP "mo:duel-game-core";
import Transport "mo:duel-game-core/transport";
import TransportActorMixin "mo:duel-game-core/transport_actor_mixin";
import CanisterPlayers "mo:duel-game-core/canister_players";
import CanisterPlayersActorMixin "mo:duel-game-core/canister_players_actor_mixin";
import Registry "mo:duel-game-core/registry";
import Leaderboard "mo:duel-game-core/leaderboard";
import LeaderboardActorMixin "mo:duel-game-core/leaderboard_actor_mixin";
import HttpActorMixin "mo:duel-game-core/http_actor_mixin";
import PT "mo:promtracker";
import Tracker "mo:promtracker/Tracker";

import BotIface "BotIface";
import Rules "RacingRules";

actor {

  let pt = PT.Tracker.new();
  transient let renderer = PT.Renderer();
  renderer.addValue(PT.allSystemMetrics);
  renderer.addValue(pt.toValue());

  let registry = Registry.new<Rules.State, Rules.Action>();
  registry.setTimeouts(300_000_000_000, 45_000_000_000); // 300s idle, 45s claim window
  registry.attachMetrics(pt);

  public query func status(sid : Text) : async TP.SessionStatus<Rules.State> {
    registry.status(Rules.spec(), Time.now(), sid);
  };

  // Best-lap leaderboard: a lower lap time is converted to a higher score
  // before storing (boards sort highest-first). `defaultScore` is inert
  // here. See ../../backend/README.md, "Leaderboard".
  let leaderboard = Leaderboard.new(50, 0);
  let ONE_HOUR_MS : Int = 3_600_000;
  func scoreFromLapMs(ms : Int) : Int = Int.max(0, ONE_HOUR_MS - ms);

  // In-game time, not wall clock: each round is `STEP_DURATION_MS` (keep
  // in sync with game-state.service.ts's `stepDuration`), minus the
  // winning car's final-round overshoot (`distanceFromStart / speed`, as
  // a fraction of one round, clamped to [0, 1)).
  let STEP_DURATION_MS : Int = 1000;
  func lapMsFor(car : Rules.CarState, turns : Nat) : Int {
    let overshootSteps = if (car.speed > 0.0) {
      Float.max(0.0, Float.min(0.999, car.distanceFromStart / car.speed));
    } else 0.0;
    Float.nearest((turns.toFloat() - overshootSteps) * STEP_DURATION_MS.toFloat()).toInt();
  };

  // A `cp:` session is per-table; score a bot per principal + complexity.
  func playerKey(sid : TP.SessionId) : Text {
    if (CanisterPlayers.isCanisterSession(sid)) {
      CanisterPlayers.leaderboardKeyOfSession(sid);
    } else {
      Transport.playerKey(sid);
    };
  };

  // Only a clean `#finished` win records a lap.
  func onGameEnded(_id : TP.TableId, p1 : TP.SessionId, p2 : TP.SessionId, d : TP.Debrief<Rules.State>) {
    switch (d.end) {
      case (#finished(#p1Wins)) {
        let lapMs = lapMsFor(d.finalGame.p1, d.turns);
        ignore Leaderboard.recordIfBetter(leaderboard, playerKey(p1), scoreFromLapMs(lapMs), Time.now());
      };
      case (#finished(#p2Wins)) {
        let lapMs = lapMsFor(d.finalGame.p2, d.turns);
        ignore Leaderboard.recordIfBetter(leaderboard, playerKey(p2), scoreFromLapMs(lapMs), Time.now());
      };
      case (_) {};
    };
  };

  // Breaks the cycle between `attached` and `cpAttached`.
  transient var settleTable : ?((Int, TP.TableId) -> async* ()) = null;
  transient let settle = func(now : Int, id : TP.TableId) : async* () {
    switch (settleTable) {
      case (?f) await* f(now, id);
      case null {};
    };
  };

  transient let hub : Transport.Hub = Transport.createHub();
  transient let attached = Transport.attach<Rules.State, Rules.Action>(
    Rules.spec(),
    registry,
    hub,
    ?settle,
    ?onGameEnded,
    null,
  );

  let botDirectory = CanisterPlayers.newBotDirectory();

  transient let cpAttached = CanisterPlayers.attach<Rules.State, Rules.Action>(
    Rules.spec(),
    registry,
    attached.afterMutation,
    true, // `attached` settles through `onSettled`
    func(session : TP.SessionId, req : TP.MoveRequest<Rules.State, Rules.Action>, k : (?Rules.Action) -> async* ()) : async* () {
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
  include TransportActorMixin<system>(attached.lobby, combinedSweep);

  public shared ({ caller }) func duel_submit(sid : Text, gen : Nat, turn : Nat, move : Rules.Action) : async Transport.Reply<Rules.State> {
    attached.reply(sid, await* attached.submit(caller, sid, gen, turn, move));
  };

  public shared query ({ caller }) func duel_poll(sid : Text, rev : Nat) : async Transport.PollResult<Rules.State> {
    attached.poll(caller, sid, rev);
  };

  include HttpActorMixin([
    ("/semantics", func() : Text = Rules.SEMANTICS),
    ("/metrics", renderer.renderExposition),
    ("/track", Rules.trackText),
  ]);

  include CanisterPlayersActorMixin(cpAttached, botDirectory, ?leaderboard);

  include LeaderboardActorMixin(leaderboard, 25);

};
