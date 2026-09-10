import Time "mo:core/Time";

import TP "mo:duel-game-core";
import Ws "mo:duel-game-core/Ws";
import ActorMixin "mo:duel-game-core/actor_mixin";
import IcWebSocketCdkTypes "mo:ic-websocket-cdk/Types";
import Registry "mo:duel-game-core/registry";

import Rules "Duel007Rules";

persistent actor {
  // A lobby of tables, not one fixed board — anyone may open a new table
  // (open, or access-code protected) and the same canister routes every
  // move to the right one. See `mo:duel-game-core`'s own doc header.
  let registry = Registry.new<Rules.State, Rules.Action>(60_000_000_000); // 60 s idle timeout, shared by every table

  public query func status(sid : Text) : async TP.SessionStatus<Rules.State> {
    registry.status(Time.now(), sid);
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
};
