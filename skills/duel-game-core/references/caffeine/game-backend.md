# caffeine.ai: the game's backend

The host actor, its four game-typed methods and the migration that
creates its stable fields, after `references/caffeine/game.md`. Stable
fields get no value where they are declared (Caffeine's migration
chain refuses one, M0250): the first migration creates them. Keep
Caffeine's `MixinAuthorization` (its lint requires it) and `Expose`.

`src/backend/main.mo`:

```motoko
import Registry "mo:duel-game-core/registry";
import Transport "mo:duel-game-core/transport";
import TransportActorMixin "mo:duel-game-core/transport_actor_mixin";
import HttpActorMixin "mo:duel-game-core/http_actor_mixin";
// import CanisterPlayers "mo:duel-game-core/canister_players"; // BOTS
// import CanisterPlayersActorMixin "mo:duel-game-core/canister_players_actor_mixin"; // BOTS
// import Leaderboard "mo:duel-game-core/leaderboard"; // LEADERBOARD
// import LeaderboardActorMixin "mo:duel-game-core/leaderboard_actor_mixin"; // LEADERBOARD
import AccessControl "mo:caffeineai-authorization/access-control";
import MixinAuthorization "mo:caffeineai-authorization/MixinAuthorization";
import Expose "mo:caffeineai-oql/Expose";
import PT "mo:promtracker";
import Tracker "mo:promtracker/Tracker";

// import BotIface "lib/BotIface"; // BOTS
import Rules "lib/Rules";
import DuelApi "mixins/DuelApi";

actor {
  let accessControlState : AccessControl.AccessControlState;
  include MixinAuthorization(accessControlState, null);
  include Expose({ entities = [] });

  let pt : PT.Tracker;
  transient let renderer = PT.Renderer();
  renderer.addValue(PT.allSystemMetrics);
  renderer.addValue(pt.toValue());

  let duel : Transport.Duel<Rules.State, Rules.Action, Rules.Options>;
  duel.registry.setTimeouts(90_000_000_000, 60_000_000_000);
  duel.registry.attachMetrics(pt);

  // let bots : CanisterPlayers.Store; // BOTS
  // let leaderboard : Leaderboard.Board; // LEADERBOARD

  transient let env : Transport.Env<Rules.State, Rules.Action, Rules.View, Rules.Options> = {
    spec = Rules.spec;
    bots = null; // BOTS: ?{ store = bots; call = BotIface.callBot }
    scoring = null; // LEADERBOARD: ?{ board = leaderboard; rating = #elo { k = 32 } }
    sweeper = Transport.sweeper();
  };

  include TransportActorMixin<system>(duel.lobby(env));
  include DuelApi(duel, env);
  // include CanisterPlayersActorMixin(duel.canisterPlayers(env), bots.directory, null); // BOTS; ?leaderboard with LEADERBOARD
  // include LeaderboardActorMixin(leaderboard, 25); // LEADERBOARD
  include HttpActorMixin([
    ("/semantics", func() : Text = Rules.SEMANTICS),
    ("/metrics", renderer.renderExposition),
  ]);
};

```

`Registry` and `Tracker` look unused, but `duel.registry.setTimeouts`
and `pt.toValue()` need them. The timeouts (90 s idle, 60 s before the
waiting seat may claim the win) run on every upgrade. Add no other
public method for a game operation: the transport is the only path.

`src/backend/mixins/DuelApi.mo`, the four methods whose types name the
game's own:

```motoko
import TP "mo:duel-game-core";
import Transport "mo:duel-game-core/transport";

import Rules "../lib/Rules";

mixin (
  duel : Transport.Duel<Rules.State, Rules.Action, Rules.Options>,
  env : Transport.Env<Rules.State, Rules.Action, Rules.View, Rules.Options>,
) {
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
};

```

`src/backend/migrations/00000000_000000.mo` creates every stable field.
Caffeine's lint refuses a relative import in a migration, so the rules'
`State`, `Action` and `Options` (and every type they use) are copied
in; engine types may come from `mo:duel-game-core`. Here for
rock-paper-scissors:

```motoko
import AccessControl "mo:caffeineai-authorization/access-control";
import Transport "mo:duel-game-core/transport";
// import CanisterPlayers "mo:duel-game-core/canister_players"; // BOTS
// import Leaderboard "mo:duel-game-core/leaderboard"; // LEADERBOARD
import PT "mo:promtracker";

module {
  // lib/Rules.mo's types, copied.
  type Variant = { #classic; #well };
  type Options = { variant : Variant; winsNeeded : Nat };
  type Action = { #rock; #paper; #scissors; #well };
  type Round = { p1Action : Action; p2Action : Action };
  type State = {
    p1Score : Nat;
    p2Score : Nat;
    lastRound : ?Round;
    variant : Variant;
    winsNeeded : Nat;
  };

  public type OldActor = {};
  public type NewActor = {
    accessControlState : AccessControl.AccessControlState;
    pt : PT.Tracker;
    duel : Transport.Duel<State, Action, Options>;
    // bots : CanisterPlayers.Store; // BOTS
    // leaderboard : Leaderboard.Board; // LEADERBOARD
  };

  public func migration(_ : OldActor) : NewActor {
    {
      accessControlState = AccessControl.initState();
      pt = PT.Tracker.new();
      duel = Transport.new<State, Action, Options>();
      // bots = CanisterPlayers.newStore(); // BOTS
      // leaderboard = Leaderboard.new(50, 1200); // LEADERBOARD
    };
  };
};

```

**Bot support and a leaderboard**, only when the user asks. Bot support
lets canister players (bots built by anyone) take a seat; a bot is a
canister of its own and another app. "Add bots" can mean either: when
the words do not settle it, ask. Bot support is every line marked
BOTS, in both files, and `src/backend/lib/BotIface.mo` from
`templates/BotIface.mo.template` with `__RULES_MODULE__` set to
`Rules`. A leaderboard is every line marked LEADERBOARD; with both, the
`CanisterPlayersActorMixin` line passes `?leaderboard`. Elo fits a game
where the players beat each other. For a score of one's own (a best
time), `rating = #best f`, where `f : TP.Debrief<Rules.State> -> [(TP.Seat, Int)]`
credits a higher-is-better score to the seats it names. Turned on after
the first build, they are a migration of their own
(`references/caffeine/changes.md`).
