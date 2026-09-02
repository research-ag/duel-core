// Reference host actor, wired exactly as the duel-game-core README shows.
//
// Exposes the plain 7-method surface (join/submit/rematch/leave/reset/
// ackEnded/status) AND the 4 ws_* methods `mo:duel-game-core/Ws` forwards
// into the SAME `table`/`Rules.spec()`. `frontend/app.js`'s `ws` (see
// duel-game-core/ws.js) talks to the ws_* methods directly — this tab
// registers itself as its own WS Gateway and polls its own messages, no
// external relay process involved — for genuine canister-driven push and
// real close-detection-driven disappearance handling; see
// ../../../backend/README.md's "Real-time push" section for the full
// design. The plain 7 methods stay exposed too: `mo:duel-game-core/Ws`
// dispatches to them for every actual mutation (rule 11 — no second code
// path), and they're a game's fallback surface for
// `duel-game-core/ws/poller.js`'s dependency-free `PollingWs` if ever
// needed.
import TP "mo:duel-game-core";
import Ws "mo:duel-game-core/Ws";
import Rules "Duel007Rules";
import IcWebSocketCdkTypes "mo:ic-websocket-cdk/Types";
import Time "mo:core/Time";
import Timer "mo:core/Timer";

persistent actor {
  // Implicitly stable under `persistent actor` (moc 1.x); mutation happens
  // through the record's inner `var` fields, so `let` suffices.
  let table : TP.Table<Rules.State, Rules.Action> =
    TP.create(60_000_000_000); // 60 s idle timeout

  // Frees an abandoned board on its own — with only 2 players, there's
  // often nobody left to visit the board and trigger the lazy,
  // visitor-driven eviction `join`/`reset` already do below. Timers
  // don't survive an upgrade, so restart in `postupgrade` too (see the
  // bottom of this actor, alongside `ws.init<system>()`).
  func startSweeping<system>() {
    ignore Timer.recurringTimer<system>(#seconds(30), func() : async () {
      TP.sweep(table, Time.now());
    });
  };
  startSweeping<system>();

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
