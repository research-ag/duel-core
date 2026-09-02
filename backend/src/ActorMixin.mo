import Time "mo:core/Time";
import Timer "mo:core/Timer";

import IcWebSocketCdk "mo:ic-websocket-cdk";
import IcWebSocketCdkTypes "mo:ic-websocket-cdk/Types";

import TP ".";

mixin<system>(
  ws : IcWebSocketCdk.IcWebSocket,
  sweepFunc : () -> (),
) {

  public shared ({ caller }) func ws_open(
    args : IcWebSocketCdkTypes.CanisterWsOpenArguments
  ) : async IcWebSocketCdkTypes.CanisterWsOpenResult {
    await ws.ws_open(caller, args);
  };

  public shared ({ caller }) func ws_close(
    args : IcWebSocketCdkTypes.CanisterWsCloseArguments
  ) : async IcWebSocketCdkTypes.CanisterWsCloseResult {
    await ws.ws_close(caller, args);
  };

  /// `msgType` is a plain `Blob`, not the generic `Ws.Msg<S, M>` a
  /// fully-manual wiring would spell out — this mixin holds only the
  /// already-built `ws` (a concrete `IcWebSocketCdk.IcWebSocket`, no
  /// `S`/`M` in sight by this point), and a mixin can't itself carry a
  /// type parameter the way `Ws.attach<S, M>` does. That costs nothing:
  /// the CDK ignores this parameter's VALUE regardless of its declared
  /// type (see `Ws.mo`'s doc header — it exists only to shape the
  /// canister's own Candid interface), so a caller that ever wants the
  /// real message back still gets it with
  /// `from_candid(msgType) : ?Ws.Msg<YourState, YourAction>` — the same
  /// bytes `codec.decode` already reconstructs from `args.msg.content`
  /// on the real, live path. Being a concrete type (not generic) is what
  /// lets `ws_message` live in this mixin at all, alongside the other
  /// three `ws_*` endpoints, instead of every host actor hand-declaring
  /// it outside the mixin.
  public shared ({ caller }) func ws_message(
    args : IcWebSocketCdkTypes.CanisterWsMessageArguments,
    msgType : ?Blob,
  ) : async IcWebSocketCdkTypes.CanisterWsMessageResult {
    await ws.ws_message(caller, args, msgType);
  };

  public shared query ({ caller }) func ws_get_messages(
    args : IcWebSocketCdkTypes.CanisterWsGetMessagesArguments
  ) : async IcWebSocketCdkTypes.CanisterWsGetMessagesResult {
    ws.ws_get_messages(caller, args);
  };

  func startSweeping<system>() {
    ignore Timer.recurringTimer<system>(
      #seconds(30),
      func() : async () { sweepFunc(); },
    );
  };
  startSweeping<system>();

};
