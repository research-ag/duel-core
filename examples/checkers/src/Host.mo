// Host actor for checkers. This file barely ever changes between games —
// it forwards `status` as a plain query and wires `mo:duel-game-core/ws`
// for every mutating call. Copy verbatim; the only per-game line is the
// `Rules` import. Wires a multi-table LOBBY, not a single fixed board —
// anyone may open a table (open, or access-code protected to share with
// a friend out of band), and any number run independently and
// simultaneously; this game's own code never has to know or care.

import Principal "mo:core/Principal";
import Time "mo:core/Time";
import Timer "mo:core/Timer";

import TP "mo:duel-game-core";
import Registry "mo:duel-game-core/registry";
import Ws "mo:duel-game-core/ws";
import ActorMixin "mo:duel-game-core/actor_mixin";
import CanisterPlayers "mo:duel-game-core/canister_players";
import CanisterPlayersActorMixin "mo:duel-game-core/canister_players_actor_mixin";
import IcWebSocketCdkTypes "mo:ic-websocket-cdk/Types";
import PT "mo:promtracker";
import Http "mo:promtracker/mixins/http";
import Tracker "mo:promtracker/Tracker"; // enables pt.toValue() dot notation

import BotIface "BotIface";
import Rules "CheckersRules";

persistent actor {
  let pt = PT.Tracker.new();
  transient let renderer = PT.Renderer();
  renderer.addValue(PT.allSystemMetrics);
  renderer.addValue(pt.toValue());

  let registry : TP.Registry<Rules.State, Rules.Action> = Registry.new(60_000_000_000, 15_000_000_000); // 60s idle timeout, 15s claim-win window, per table
  registry.attachMetrics(pt);

  public query func status(sid : Text) : async TP.SessionStatus<Rules.State> {
    registry.status(Rules.spec(), Time.now(), sid);
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
};
