import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Time "mo:core/Time";
import Timer "mo:core/Timer";

import TP "mo:duel-game-core";
import Ws "mo:duel-game-core/ws";
import ActorMixin "mo:duel-game-core/actor_mixin";
import CanisterPlayers "mo:duel-game-core/canister_players";
import Registry "mo:duel-game-core/registry";
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
      let p = Principal.fromText(session.trimStart(#text(CanisterPlayers.CP_SID_PREFIX)));
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

  public shared ({ caller }) func create_table_as_canister(seat : TP.Seat, visibility : TP.TableVisibility) : async TP.Res<TP.TableId> {
    await* cpAttached.createTable(caller, seat, visibility);
  };

  public shared ({ caller }) func join_table_as_canister(id : TP.TableId, seat : TP.Seat, code : ?Text) : async TP.Res<TP.JoinOk> {
    await* cpAttached.joinTable(caller, id, seat, code);
  };

  public shared ({ caller }) func leave_as_canister(gen : Nat) : async TP.Res<()> {
    await* cpAttached.leave(caller, gen);
  };

  public shared ({ caller }) func rematch_as_canister() : async TP.Res<TP.RematchOk> {
    await* cpAttached.rematch(caller);
  };

  public shared ({ caller }) func ack_ended_as_canister() : async () {
    await* cpAttached.ackEnded(caller);
  };

  public shared ({ caller }) func claim_win_as_canister(gen : Nat) : async TP.Res<()> {
    await* cpAttached.claimWin(caller, gen);
  };

  public shared ({ caller }) func reset_as_canister(gen : Nat) : async TP.Res<()> {
    await* cpAttached.reset(caller, gen);
  };

};
