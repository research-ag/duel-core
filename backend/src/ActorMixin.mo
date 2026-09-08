import Time "mo:core/Time";
import Timer "mo:core/Timer";

import IcWebSocketCdk "mo:ic-websocket-cdk";
import IcWebSocketCdkTypes "mo:ic-websocket-cdk/Types";

import TP ".";

mixin<system>(
  ws : IcWebSocketCdk.IcWebSocket,
  // `(Int) -> async* ()`, not `() -> ()`: the idle-sweep hook a host actor
  // wires here is expected to be `Ws.Attached.sweep` (see that module's
  // own doc), which pushes a fresh view to every session it just evicted
  // — a bare, synchronous `TP.sweep(table, Time.now())` would silently
  // leave a still-connected tab showing a stale view with no way to be
  // told its game just ended by the idle sweep instead of a live push.
  // This mixin supplies `now` itself (via `Time.now()` below), the same
  // exception to "the engine owns time" that `Ws.mo` already documents
  // for itself: it plays the host's own role, same as any host actor
  // wiring a plain `Time.now()` into a call would. `async*`/`await*`
  // (not plain `async`/`await`), same as `Ws.Attached.sweep` itself: the
  // recurring timer below is the one genuine message boundary here —
  // `sweepFunc`'s own body reaches that same boundary via `await*`
  // without paying for a second one of its own. See `Ws.mo`'s doc on
  // `pushTo` for why this matters.
  sweepFunc : (Int) -> async* (),
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
      func() : async () { await* sweepFunc(Time.now()); },
    );
  };
  startSweeping<system>();

};
