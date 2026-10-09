import Float "mo:core/Float";
import Int "mo:core/Int";
import Principal "mo:core/Principal";

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
  let state = Transport.new<Rules.State, Rules.Action>();
  state.registry.setTimeouts(300_000_000_000, 45_000_000_000); // 300s idle, 45s claim window
  state.registry.attachMetrics(pt);
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

  // Only a clean `#finished` win records a lap.
  func bestLap(d : TP.Debrief<Rules.State>) : ?(TP.Seat, Int) {
    switch (d.end) {
      case (#finished(#p1Wins)) ?(#p1, scoreFromLapMs(lapMsFor(d.finalGame.p1, d.turns)));
      case (#finished(#p2Wins)) ?(#p2, scoreFromLapMs(lapMsFor(d.finalGame.p2, d.turns)));
      case (_) null;
    };
  };

  // Asks a seated bot canister for its move.
  func callBot<system>(bot : TP.PlayerId, req : TP.MoveRequest<Rules.State, Rules.Action>, k : <system>(?Rules.Action) -> async* ()) : async* () {
    let b : BotIface.CanisterPlayer = actor (CanisterPlayers.principalOfCanisterSession(bot).toText());
    try { await* k<system>(?(await b.make_move(req))) } catch (_) {
      await* k<system>(null);
    };
  };

  // The stable data plus the functions that cannot be stable.
  transient let duel = Transport.Duel<Rules.State, Rules.Action>(
    state,
    Rules.spec(),
    ?{ store = bots; call = callBot },
    ?{ board = leaderboard; rating = #best bestLap },
  );

  include TransportActorMixin<system>(duel.lobby);

  public shared ({ caller }) func duel_submit(tableId : TP.TableId, gen : Nat, turn : Nat, move : Rules.Action) : async Transport.Reply<Rules.State> {
    duel.reply(caller, tableId, await* duel.submit<system>(caller, tableId, gen, turn, move));
  };

  public shared query ({ caller }) func duel_table(tableId : TP.TableId, rev : Nat) : async Transport.TableResult<Rules.State> {
    duel.table(caller, tableId, rev);
  };

  include HttpActorMixin([
    ("/semantics", func() : Text = Rules.SEMANTICS),
    ("/metrics", renderer.renderExposition),
    ("/track", Rules.trackText),
  ]);

  include CanisterPlayersActorMixin(duel.canisterPlayers, bots.directory, ?leaderboard);

  include LeaderboardActorMixin(leaderboard, 25);

};
