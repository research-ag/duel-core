import Time "mo:core/Time";
import Timer "mo:core/Timer";

import IcWebSocketCdk "mo:ic-websocket-cdk";
import IcWebSocketCdkTypes "mo:ic-websocket-cdk/Types";

import TP ".";

/// The four `ws_*` Candid methods plus the idle-sweep timer. `sweepFunc`
/// should be `Ws.Attached.sweep`, which pushes to the sessions it evicts.
mixin <system>(
  ws : IcWebSocketCdk.IcWebSocket,
  sweepFunc : (Int) -> async* (),
) {

  public shared ({ caller }) func ws_open(
    args : IcWebSocketCdkTypes.CanisterWsOpenArguments
  ) : async IcWebSocketCdkTypes.CanisterWsOpenResult {
    await* ws.ws_open(caller, args);
  };

  public shared ({ caller }) func ws_close(
    args : IcWebSocketCdkTypes.CanisterWsCloseArguments
  ) : async IcWebSocketCdkTypes.CanisterWsCloseResult {
    await* ws.ws_close(caller, args);
  };

  public shared ({ caller }) func ws_message(
    args : IcWebSocketCdkTypes.CanisterWsMessageArguments,
    msgType : ?Blob,
  ) : async IcWebSocketCdkTypes.CanisterWsMessageResult {
    await* ws.ws_message(caller, args, msgType);
  };

  public shared query ({ caller }) func ws_get_messages(
    args : IcWebSocketCdkTypes.CanisterWsGetMessagesArguments
  ) : async IcWebSocketCdkTypes.CanisterWsGetMessagesResult {
    ws.ws_get_messages(caller, args);
  };

  func startSweeping<system>() {
    ignore Timer.recurringTimer<system>(
      #seconds(300),
      func() : async () { await* sweepFunc(Time.now()) },
    );
  };
  startSweeping<system>();

};
