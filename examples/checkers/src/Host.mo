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
import Rules "CheckersRules";

actor {
  let pt = PT.Tracker.new();
  transient let renderer = PT.Renderer();
  renderer.addValue(PT.allSystemMetrics);
  renderer.addValue(pt.toValue());

  // Stable data: the tables, the bots, the ratings.
  let state = Transport.new<Rules.State, Rules.Action>();
  state.registry.setTimeouts(90_000_000_000, 60_000_000_000); // 90s idle, 60s claim window
  state.registry.attachMetrics(pt);
  let bots = CanisterPlayers.newStore();
  let leaderboard = Leaderboard.new(50, 1200); // Elo, starting at 1200

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
    ?{ board = leaderboard; rating = #elo { k = 32 } },
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
  ]);

  include CanisterPlayersActorMixin(duel.canisterPlayers, bots.directory, ?leaderboard);

  include LeaderboardActorMixin(leaderboard, 25);
};
