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
/// `ws_close` — whether the client's own goodbye or the CDK's internal
/// keep-alive timeout catching an involuntary disappearance (crash,
/// force-quit, network drop) — also drives an implicit `TP.leave` on
/// behalf of that session (see `attach`'s `onClose`/`disconnectSession`):
/// a live game a player vanished from ends in a shared debrief instead of
/// leaving their opponent staring at a move that's never coming, and a
/// board BOTH players vanished from frees itself instead of sitting
/// occupied with nobody left to poll it into freeing lazily. The CDK's
/// keep-alive timeout is fixed at 60s (not configurable via
/// `WsInitParams`), so involuntary disappearance has a real detection
/// floor of roughly 60-120s depending on where in the ack cycle it
/// happens — see `../README.md`'s real-time-push section.
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
/// See `../README.md`'s "Real-time push" section for the full worked
/// example, including the frontend half.
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

    /// Drives an implicit `#leave` on behalf of a session whose socket
    /// just closed — reuses the exact same plain engine operation a
    /// client's own `#leave` request already dispatches to (rule 11: no
    /// second code path for what's legal). Two calls: the first performs
    /// whatever `leave` means for the session's CURRENT phase (staging ->
    /// empty / active -> shared `#aborted` debrief / debrief -> ack); the
    /// second acks that same debrief immediately, since a session whose
    /// socket just closed will never come back to click "leave" a second
    /// time itself the way a still-connected player would.
    func disconnectSession(now : Int, sid : TP.SessionId) : async () {
      ignore TP.leave(table, now, sid);
      ignore TP.leave(table, now, sid);
    };

    /// Fires when the CDK detects a connection is gone — either the
    /// client's own `ws_close` (a cooperative goodbye) or the CDK's
    /// internal keep-alive timeout (an involuntary disappearance: crash,
    /// force-quit, network drop — see this module's doc header and
    /// `../README.md`'s real-time-push section for the ~60-120s detection
    /// floor that timeout imposes). Either way this is the one place a
    /// disappearing player can be told apart from one who's merely gone
    /// quiet mid-thought, so both `disconnectSession(s)` (ends/acks
    /// THEIR game instead of leaving a still-present opponent staring at
    /// a move that's never coming) and the "is the partner ALSO gone"
    /// check below (frees the board instead of it sitting occupied with
    /// nobody left to poll it) live here rather than in `lib.mo`.
    func onClose(args : IcWebSocketCdkTypes.OnCloseCallbackArgs) : async () {
      let p = args.client_principal;
      let sid = Map.get(hub.byPrincipal, Principal.compare, p);
      forget(hub, p);
      switch (sid) {
        case null {}; // this principal was never registered to a sid — nothing to do
        case (?s) {
          let now = Time.now();
          await disconnectSession(now, s);
          // Both gone: free the board now instead of leaving it occupied
          // until the idle timeout notices. Only reachable via #debrief
          // here, since disconnectSession() above already collapsed
          // #active into #debrief and #staging into #empty.
          //
          // Caveat: `hub.bySid` only tracks sessions connected over THIS
          // WS transport — if a table were ever driven by mixed
          // transports (one seat on this real gateway client, the other
          // on `frontend/ws/poller.js`'s plain-polling `PollingWs`), this
          // would wrongly treat a still-active `PollingWs` player as
          // gone. Not engineered around: a single game deployment uses
          // one transport for both seats (the frontend build is the same
          // for every player), so this is a theoretical edge, not a
          // practical one.
          switch (table.phase) {
            case (#debrief d) {
              if (d.p1 == s or d.p2 == s) {
                let partner = if (d.p1 == s) d.p2 else d.p1;
                switch (Map.get(hub.bySid, Text.compare, partner)) {
                  case null { await disconnectSession(now, partner) };
                  case (?_) {}; // partner is still connected — nothing to do
                };
              };
            };
            case (_) {};
          };
          await pushRelevant(now, s);
        };
      };
    };

    let handlers = IcWebSocketCdkTypes.WsHandlers(null, ?onMessage, ?onClose);
    IcWebSocketCdk.IcWebSocket(wsState, wsParams, handlers);
  };
};
