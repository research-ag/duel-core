// Reference host actor, wired exactly as the duel-game-core README shows.
//
// The ONLY way to mutate game state is `mo:duel-game-core/Ws`'s
// `ws_message` — there is no plain `join`/`submit`/`rematch`/`leave`/
// `reset`/`ackEnded` Candid method on this actor at all, and no fallback:
// `frontend/src/duel/duel-app.js`'s `ws` (see duel-game-core/ws.js) talks
// to the ws_* methods below directly — this tab registers itself as its
// own WS Gateway and polls its own messages, no external relay process
// involved — and the frontend's own gameplay loop
// (lobby-connection.service.ts) SHARES that exact same connection rather
// than running a second one — there is only ever one communication
// channel to this canister, and it's the only entry point a client has.
// `status` stays a plain public `query` — side-effect-free, so it carries
// no race risk, and useful for tooling/tests that don't want a WS
// handshake. See ../../../backend/README.md's "Real-time push" section
// for the full design and ../../../backend/src/Ws.mo's doc header for why
// a direct update call is exactly the race this closes.
import TP "mo:duel-game-core";
import Ws "mo:duel-game-core/Ws";
import Rules "RacingRules";
import IcWebSocketCdkTypes "mo:ic-websocket-cdk/Types";
import Time "mo:core/Time";
import Timer "mo:core/Timer";

persistent actor {
  // Implicitly stable under `persistent actor` (moc 1.x); mutation happens
  // through the record's inner `var` fields, so `let` suffices.
  let table : TP.Table<Rules.State, Rules.Action> =
    TP.create(60_000_000_000); // 60 s idle timeout

  public query func status(sid : Text) : async TP.View<Rules.State> {
    TP.status(table, Time.now(), sid);
  };

  // Frees an abandoned board on its own — with only 2 players, there's
  // often nobody left to visit the board and trigger the lazy,
  // visitor-driven eviction TP.join/TP.reset already do (see
  // TP.sweep's own doc comment in lib.mo). Timers don't survive an
  // upgrade, so restart in `postupgrade` too.
  func startSweeping<system>() {
    ignore Timer.recurringTimer<system>(
      #seconds(30),
      func() : async () { TP.sweep(table, Time.now()) },
    );
  };
  startSweeping<system>();

  // ── Real-time push over WebSocket ────────────────────────────────────────

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
    // 65s: the fastest legal ack interval above the CDK's hardcoded 60s
    // keep-alive timeout (send_ack_interval_ms must exceed it) — keeps
    // the involuntary-disappearance detection floor as tight as the
    // dependency allows (~60-120s; see Ws.mo's doc header).
    IcWebSocketCdkTypes.WsInitParams(null, ?65_000),
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
    startSweeping<system>();
  };
};
