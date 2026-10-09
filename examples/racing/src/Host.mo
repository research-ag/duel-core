import Float "mo:core/Float";
import Int "mo:core/Int";

import TP "mo:duel-game-core";
import Registry "mo:duel-game-core/registry";
import Transport "mo:duel-game-core/transport";
import TransportActorMixin "mo:duel-game-core/transport_actor_mixin";
import CanisterPlayers "mo:duel-game-core/canister_players";
import CanisterPlayersActorMixin "mo:duel-game-core/canister_players_actor_mixin";
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

  // Stable data: the tables, the bots, the best laps.
  let duel = Transport.new<Rules.State, Rules.Action, Rules.Options>();
  duel.registry.setTimeouts(300_000_000_000, 45_000_000_000); // 300s idle, 45s claim window
  duel.registry.attachMetrics(pt);
  let bots = CanisterPlayers.newStore();
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

  // Only a clean `#finished` win records a lap: the winner's (a photo
  // finish credits whoever crossed — the loser has no lap time).
  func bestLap(d : TP.Debrief<Rules.State>) : [(TP.Seat, Int)] {
    switch (d.end) {
      case (#finished(#p1Wins)) [(#p1, scoreFromLapMs(lapMsFor(d.finalGame.p1, d.steps)))];
      case (#finished(#p2Wins)) [(#p2, scoreFromLapMs(lapMsFor(d.finalGame.p2, d.steps)))];
      case (_) [];
    };
  };

  // The function values the framework calls: the rules, the bot call,
  // the rating. Rebuilt on every upgrade.
  transient let env : Transport.Env<Rules.State, Rules.Action, Rules.View, Rules.Options> = {
    spec = Rules.spec;
    bots = ?{ store = bots; call = BotIface.callBot };
    scoring = ?{ board = leaderboard; rating = #best bestLap };
  };

  include TransportActorMixin<system>(duel.lobby(env));

  public shared ({ caller }) func duel_create_table(seat : TP.Seat, visibility : TP.TableVisibility, options : Rules.Options) : async Transport.Ack {
    await* duel.createTable<system, Rules.State, Rules.Action, Rules.View, Rules.Options>(env, caller, seat, visibility, options);
  };

  public shared query ({ caller }) func duel_lobby(rev : Nat) : async Transport.LobbyResult<Rules.Options> {
    duel.lobbyView(caller, rev);
  };

  public shared ({ caller }) func duel_submit(tableId : TP.TableId, gen : Nat, step : Nat, action : Rules.Action) : async Transport.Reply<Rules.View> {
    duel.reply(env, caller, tableId, await* duel.submit<system, Rules.State, Rules.Action, Rules.View, Rules.Options>(env, caller, tableId, gen, step, action));
  };

  public shared query ({ caller }) func duel_table(tableId : TP.TableId, rev : Nat) : async Transport.TableResult<Rules.View> {
    duel.table(env, caller, tableId, rev);
  };

  include HttpActorMixin([
    ("/semantics", func() : Text = Rules.SEMANTICS),
    ("/metrics", renderer.renderExposition),
    ("/track", Rules.trackText),
  ]);

  include CanisterPlayersActorMixin(duel.canisterPlayers(env), bots.directory, ?leaderboard);

  include LeaderboardActorMixin(leaderboard, 25);

};
