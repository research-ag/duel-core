import Time "mo:core/Time";

import TP "mo:duel-game-core";
import Ws "mo:duel-game-core/Ws";
import ActorMixin "mo:duel-game-core/ActorMixin";
import IcWebSocketCdkTypes "mo:ic-websocket-cdk/Types";

import Rules "RacingRules";

persistent actor {

  let table : TP.Table<Rules.State, Rules.Action> = TP.create(60_000_000_000); // 60 s idle timeout

  public query func status(sid : Text) : async TP.View<Rules.State> {
    TP.status(table, Time.now(), sid);
  };

  transient let wsHub : Ws.Hub = Ws.createHub();
  transient let attached = Ws.attach<system, Rules.State, Rules.Action>(
    Rules.spec(),
    table,
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
