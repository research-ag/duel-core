/// ═══════════════════════════════════════════════════════════════════════════
/// duel-game-core/Ws — OPTIONAL real-time push transport, built on the
/// `ic-websocket-cdk` package (a browser <-> canister WebSocket relayed by
/// an off-chain Gateway, e.g. `wss://gateway.icws.io` — the IC itself has
/// no native WebSocket support).
///
/// This module is layered ON TOP of the pure engine (`lib.mo`), never
/// merged into it: `lib.mo` stays free of `Time`, actor context, and every
/// dependency but `core`. `Ws.mo` is the only place in this package that
/// imports `ic-websocket-cdk` (and, transitively, the legacy `mo:base`
/// that CDK itself is built on) — a host actor that never imports
/// `mo:duel-game-core/Ws` never compiles any of that in.
///
/// ── What it does ────────────────────────────────────────────────────────
///
/// The engine's identity is a client-chosen `SessionId` (Text), decoupled
/// from any IC principal on purpose (see `../README.md`/`../../frontend`'s
/// `sid` — one per browser tab). A WebSocket connection, however, is keyed
/// by the caller's principal (each browser tab signs with its own identity,
/// generated or supplied by `ic-websocket-js`). `Hub` bridges the two: it
/// learns `sid <-> principal` from the `sid` every inbound `Msg` carries,
/// and forgets it on `ws_close`.
///
/// Every mutating request re-uses the plain engine operations (`TP.join`,
/// `TP.submit`, ...) with `Time.now()` — nothing about game state or
/// legality is reimplemented here — then pushes a fresh `TP.View` to every
/// connected participant of the affected match (both seats, so an
/// opponent's screen updates the instant a round resolves, not on their
/// next poll).
///
/// ── How a host actor wires it ──────────────────────────────────────────
///
///   import IcWebSocketCdk "mo:ic-websocket-cdk";
///   import IcWebSocketCdkTypes "mo:ic-websocket-cdk/Types";
///   import Ws "mo:duel-game-core/Ws";
///
///   let hub : Ws.Hub = Ws.createHub();
///   let ws = Ws.attach<Rules.State, Rules.Action>(
///     Rules.spec(),
///     table,
///     hub,
///     {
///       encode = func(m) = to_candid (m);
///       decode = func(b) = from_candid (b);
///     },
///     IcWebSocketCdkTypes.WsInitParams(null, null),
///   );
///   ws.init<system>();          // (re)start the CDK's ack timers
///
///   public shared ({ caller }) func ws_open(
///     args : IcWebSocketCdkTypes.CanisterWsOpenArguments
///   ) : async IcWebSocketCdkTypes.CanisterWsOpenResult {
///     await ws.ws_open(caller, args);
///   };
///   public shared ({ caller }) func ws_close(
///     args : IcWebSocketCdkTypes.CanisterWsCloseArguments
///   ) : async IcWebSocketCdkTypes.CanisterWsCloseResult {
///     await ws.ws_close(caller, args);
///   };
///   public shared ({ caller }) func ws_message(
///     args : IcWebSocketCdkTypes.CanisterWsMessageArguments,
///     msgType : ?Ws.Msg<Rules.State, Rules.Action>,
///   ) : async IcWebSocketCdkTypes.CanisterWsMessageResult {
///     await ws.ws_message(caller, args, msgType);
///   };
///   public shared query ({ caller }) func ws_get_messages(
///     args : IcWebSocketCdkTypes.CanisterWsGetMessagesArguments
///   ) : async IcWebSocketCdkTypes.CanisterWsGetMessagesResult {
///     ws.ws_get_messages(caller, args);
///   };
///
///   // IC timers do NOT survive an upgrade on their own — reschedule them:
///   system func postupgrade() { ws.init<system>() };
///
/// See `../README.md`'s "Optional: real-time push" section for the full
/// worked example, including the frontend half.
/// ═══════════════════════════════════════════════════════════════════════════

import Map "mo:core/Map";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Time "mo:core/Time";
import IcWebSocketCdk "mo:ic-websocket-cdk";
import IcWebSocketCdkState "mo:ic-websocket-cdk/State";
import IcWebSocketCdkTypes "mo:ic-websocket-cdk/Types";
import TP "./lib";

module {

  // ────────────────────────── the wire protocol ───────────────────────────
  //
  // `ic-websocket-js` requires ONE application-message type shared by both
  // directions (it reads it straight off `ws_message`'s second, otherwise
  // unused, Candid parameter — see `attach`'s doc header) — so `Msg` is a
  // variant covering client->canister requests AND canister->client pushes,
  // not two separate types.

  /// A client -> canister request. Mirrors the engine's six mutating
  /// operations plus an explicit resync (`#status`, e.g. right after the
  /// socket opens, before any local mutation has happened).
  public type Request<M> = {
    #join : TP.Seat;
    #submit : M;
    #rematch;
    #leave;
    #reset;
    #ackEnded;
    #status;
  };

  public type Msg<S, M> = {
    #req : { sid : TP.SessionId; req : Request<M> };  // client -> canister
    #view : TP.View<S>;                               // canister -> client
    #err : TP.Err;                                     // canister -> client
  };

  /// Built at a call site where `S`/`M` are concrete (a host actor, not
  /// this generic module) via `to_candid`/`from_candid` — sidesteps any
  /// question of whether those primitives specialize cleanly inside a
  /// function still generic over `S`/`M`.
  public type Codec<S, M> = {
    encode : (Msg<S, M>) -> Blob;
    decode : (Blob) -> ?Msg<S, M>;
  };

  // ────────────────────────── sid <-> principal bridge ────────────────────

  /// Which live WebSocket connection (if any) belongs to a session, and
  /// vice versa. One `Hub` per table, created once and held by the host
  /// actor alongside its `Table`.
  public type Hub = {
    var bySid : Map.Map<TP.SessionId, Principal.Principal>;
    var byPrincipal : Map.Map<Principal.Principal, TP.SessionId>;
  };

  public func createHub() : Hub = {
    var bySid = Map.empty<TP.SessionId, Principal.Principal>();
    var byPrincipal = Map.empty<Principal.Principal, TP.SessionId>();
  };

  func remember(hub : Hub, sid : TP.SessionId, p : Principal.Principal) {
    Map.add(hub.bySid, Text.compare, sid, p);
    Map.add(hub.byPrincipal, Principal.compare, p, sid);
  };

  func forget(hub : Hub, p : Principal.Principal) {
    switch (Map.get(hub.byPrincipal, Principal.compare, p)) {
      case null {};
      case (?sid) {
        Map.remove(hub.byPrincipal, Principal.compare, p);
        Map.remove(hub.bySid, Text.compare, sid);
      };
    };
  };

  // ────────────────────────── wiring ───────────────────────────────────────

  /// Builds a ready-to-forward `IcWebSocketCdk.IcWebSocket` bound to one
  /// game's `Spec`/`Table`: every inbound `#req` is dispatched to the
  /// matching engine operation, and every connected participant of the
  /// affected match gets a fresh `#view` push. A host actor forwards its
  /// four `ws_*` Candid methods straight into the returned instance — see
  /// this module's doc header for the exact one-liners.
  public func attach<S, M>(
    spec : TP.Spec<S, M>,
    table : TP.Table<S, M>,
    hub : Hub,
    codec : Codec<S, M>,
    wsParams : IcWebSocketCdkTypes.WsInitParams,
  ) : IcWebSocketCdk.IcWebSocket {
    let wsState = IcWebSocketCdkState.IcWebSocketState(wsParams);

    func pushTo(sid : TP.SessionId, msg : Msg<S, M>) : async () {
      switch (Map.get(hub.bySid, Text.compare, sid)) {
        case null {}; // that seat isn't connected over WS (e.g. still polling)
        case (?p) {
          ignore await IcWebSocketCdk.send(wsState, p, codec.encode(msg));
        };
      };
    };

    func pushView(now : Int, sid : TP.SessionId) : async () {
      await pushTo(sid, #view(TP.status(table, now, sid)));
    };

    /// Views change for both seats on almost every mutation (a submit can
    /// resolve the round, a leave/rematch/reset can end or restart the
    /// match) — push to whichever sids are actually part of the current
    /// match, falling back to just the acting `sid` while staging/empty.
    func pushRelevant(now : Int, sid : TP.SessionId) : async () {
      switch (table.phase) {
        case (#active g) {
          await pushView(now, g.p1);
          await pushView(now, g.p2);
        };
        case (#debrief d) {
          await pushView(now, d.p1);
          await pushView(now, d.p2);
        };
        case (_) { await pushView(now, sid) };
      };
    };

    func onMessage(
      args : IcWebSocketCdkTypes.OnMessageCallbackArgs
    ) : async () {
      switch (codec.decode(args.message)) {
        case (? #req { sid; req }) {
          remember(hub, sid, args.client_principal);
          let now = Time.now();
          switch (req) {
            case (#status) { await pushView(now, sid) };
            case (#join seat) {
              switch (TP.join(spec, table, now, sid, seat)) {
                case (#ok _) { await pushRelevant(now, sid) };
                case (#err e) { await pushTo(sid, #err e) };
              };
            };
            case (#submit move) {
              switch (TP.submit(spec, table, now, sid, move)) {
                case (#ok _) { await pushRelevant(now, sid) };
                case (#err e) { await pushTo(sid, #err e) };
              };
            };
            case (#rematch) {
              switch (TP.rematch(spec, table, now, sid)) {
                case (#ok _) { await pushRelevant(now, sid) };
                case (#err e) { await pushTo(sid, #err e) };
              };
            };
            case (#leave) {
              switch (TP.leave(table, now, sid)) {
                case (#ok _) { await pushRelevant(now, sid) };
                case (#err e) { await pushTo(sid, #err e) };
              };
            };
            case (#reset) {
              switch (TP.reset(table, now, sid)) {
                case (#ok _) { await pushRelevant(now, sid) };
                case (#err e) { await pushTo(sid, #err e) };
              };
            };
            case (#ackEnded) {
              TP.ackEnded(table, sid);
              await pushView(now, sid);
            };
          };
        };
        case (_) {}; // malformed, or a client sending a canister->client
                     // variant — nothing sane to attribute this to; drop it.
      };
    };

    func onClose(args : IcWebSocketCdkTypes.OnCloseCallbackArgs) : async () {
      forget(hub, args.client_principal);
    };

    let handlers = IcWebSocketCdkTypes.WsHandlers(null, ?onMessage, ?onClose);
    IcWebSocketCdk.IcWebSocket(wsState, wsParams, handlers);
  };
};
