// Reference host actor, wired exactly as the duel-game-core README shows.
//
// Exposes the plain 7-method surface every client actually uses —
// `frontend/app.js`'s push-shaped `ws` (see duel-game-core/ws.js) calls
// these directly, on a fast interval, there is no separate polling mode
// any more. Also exposes the optional WebSocket push transport
// (mo:duel-game-core/Ws) as pure add-on methods that forward into the
// SAME `table`/`Rules.spec()`, kept here purely as a complete reference
// for anyone wiring a REAL external Gateway-backed client against it —
// this example's own frontend never calls them. See
// ../../../backend/README.md's "Optional: real-time push" section for
// the full design.
import TP "mo:duel-game-core";
import Ws "mo:duel-game-core/Ws";
import Rules "Duel007Rules";
import IcWebSocketCdkTypes "mo:ic-websocket-cdk/Types";
import Time "mo:core/Time";

persistent actor {
  // Implicitly stable under `persistent actor` (moc 1.x); mutation happens
  // through the record's inner `var` fields, so `let` suffices.
  let table : TP.Table<Rules.State, Rules.Action> =
    TP.create(60_000_000_000); // 60 s idle timeout

  public func join(sid : Text, seat : TP.Seat) : async TP.Res<TP.JoinOk> {
    TP.join(Rules.spec(), table, Time.now(), sid, seat);
  };
  public func submit(sid : Text, a : Rules.Action) : async TP.Res<TP.SubmitOk> {
    TP.submit(Rules.spec(), table, Time.now(), sid, a);
  };
  public func rematch(sid : Text) : async TP.Res<TP.RematchOk> {
    TP.rematch(Rules.spec(), table, Time.now(), sid);
  };
  public func leave(sid : Text) : async TP.Res<()> {
    TP.leave(table, Time.now(), sid);
  };
  public func reset(sid : Text) : async TP.Res<()> {
    TP.reset(table, Time.now(), sid);
  };
  public func ackEnded(sid : Text) : async () {
    TP.ackEnded(table, sid);
  };
  public query func status(sid : Text) : async TP.View<Rules.State> {
    TP.status(table, Time.now(), sid);
  };

  // ── Optional: real-time push over WebSocket ─────────────────────────────

  // Both hold live connection/handler state (closures, in-memory maps) that
  // cannot be a stable type — `transient` rebuilds them fresh on every
  // upgrade, same as the CDK's own internal state does. Browser clients
  // reconnect on their own after a canister upgrade drops them; no game
  // state is lost, since `table` (the only stable state that matters) is
  // untouched by any of this.
  transient let wsHub : Ws.Hub = Ws.createHub();
  transient let ws = Ws.attach<Rules.State, Rules.Action>(
    Rules.spec(),
    table,
    wsHub,
    {
      encode = func(m : Ws.Msg<Rules.State, Rules.Action>) : Blob = to_candid (m);
      decode = func(b : Blob) : ?Ws.Msg<Rules.State, Rules.Action> = from_candid (b);
    },
    IcWebSocketCdkTypes.WsInitParams(null, null),
  );
  ws.init<system>(); // starts the CDK's keep-alive/ack timers

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
    msgType : ?Ws.Msg<Rules.State, Rules.Action>,
  ) : async IcWebSocketCdkTypes.CanisterWsMessageResult {
    await ws.ws_message(caller, args, msgType);
  };
  public shared query ({ caller }) func ws_get_messages(
    args : IcWebSocketCdkTypes.CanisterWsGetMessagesArguments
  ) : async IcWebSocketCdkTypes.CanisterWsGetMessagesResult {
    ws.ws_get_messages(caller, args);
  };

  // IC timers don't survive an upgrade on their own — reschedule them.
  system func postupgrade() {
    ws.init<system>();
  };
};
