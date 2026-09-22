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
  );
  attached.ws.init<system>();

  // `attached.sweep` (not a bare `TP.sweep(table, Time.now())`) pushes a
  // fresh view to every session the idle sweep just evicted — see
  // `Ws.Attached`'s own doc.
  include ActorMixin<system>(attached.ws, attached.sweep);

  include Http(renderer.renderExposition, "/metrics");

  // Canister players (Flow 1, self-join — see ../../CLAUDE.md's "Canister
  // players" note): lets a bot canister, e.g. `Bot.mo`, take a seat and
  // play via the `*_as_canister` methods below, reusing `attached`'s own
  // push fan-out (`afterMutation`) so a human opponent learns about a
  // bot's move in real time, same as `ws.mo` itself. `callBot` is where
  // the actual inter-canister call lives — the one place able to
  // `try`/`catch` it, since `Rules.Action` is concrete here (see
  // `CanisterPlayers.attach`'s own doc for why that can't live inside the
  // module itself).
  transient let cpAttached = CanisterPlayers.attach<Rules.State, Rules.Action>(
    Rules.spec(),
    registry,
    attached.afterMutation,
    func(session : TP.SessionId, req : TP.MoveRequest<Rules.State>, k : (?Rules.Action) -> async* ()) : async* () {
      let p = Principal.fromText(Text.trimStart(session, #text(CanisterPlayers.CP_SID_PREFIX)));
      let bot : BotIface.CanisterPlayer = actor (Principal.toText(p));
      try { await* k(?(await bot.make_move(req))) } catch (_) { await* k(null) };
    },
  );

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

  // Alongside the existing 30s idle-sweep timer (wired inside
  // `ActorMixin` above): a much faster tick asking every due canister
  // seat for its next move. `ws.mo` stays completely unchanged — see
  // `canister_players.mo`'s own doc on why this lives here instead.
  ignore Timer.recurringTimer<system>(
    #seconds(3),
    func() : async () { await* cpAttached.nudge(Time.now()) },
  );

};
