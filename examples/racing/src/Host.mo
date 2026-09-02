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
  transient let ws = Ws.attach<Rules.State, Rules.Action>(
    Rules.spec(),
    table,
    wsHub,
    {
      encode = func(m : Ws.Msg<Rules.State, Rules.Action>) : Blob = to_candid (m);
      decode = func(b : Blob) : ?Ws.Msg<Rules.State, Rules.Action> = from_candid (b);
    },
    IcWebSocketCdkTypes.WsInitParams(null, ?65_000),
  );
  ws.init<system>();

  include ActorMixin<system>(
    ws,
    func() = TP.sweep(table, Time.now()),
  );

};
