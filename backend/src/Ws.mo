/// ═══════════════════════════════════════════════════════════════════════════
/// duel-game-core/Ws — the REQUIRED real-time push transport, built on the
/// `ic-websocket-cdk` package (a browser <-> canister WebSocket relayed by
/// an off-chain Gateway, e.g. `wss://gateway.icws.io` — the IC itself has
/// no native WebSocket support).
///
/// Every host actor built on this package MUST wire this module: it's the
/// only way a client can mutate game state at all (`lib.mo`'s `TP.join`/
/// `TP.submit`/... are not exposed as plain Candid methods anywhere — see
/// `lib.mo`'s "How a host actor wires it" section). There is no
/// dependency-free polling fallback any more — a direct update call
/// bypassing this module is exactly the race a single, ordered WS channel
/// exists to close (two independent update calls have no guaranteed
/// relative processing order once both are in flight, so a plain `submit`
/// racing this module's own traffic could resolve out of order against
/// it). `status` is the one exception: it stays a plain public `query`
/// (side-effect-free, no race risk) for tooling/tests that don't want a WS
/// handshake.
///
/// This module is layered ON TOP of the pure engine (`lib.mo`), never
/// merged into it: `lib.mo` stays free of `Time`, actor context, and every
/// dependency but `core`. `Ws.mo` is the only place in this package that
/// imports `ic-websocket-cdk` (and, transitively, the legacy `mo:base`
/// that CDK itself is built on) — kept as a separate module purely to
/// confine that dependency, not because wiring it is optional.
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
///   import Time "mo:core/Time";
///   import TP "mo:duel-game-core";
///   import IcWebSocketCdk "mo:ic-websocket-cdk";
///   import IcWebSocketCdkTypes "mo:ic-websocket-cdk/Types";
///   import Ws "mo:duel-game-core/Ws";
///   import ActorMixin "mo:duel-game-core/ActorMixin";
///
///   let hub : Ws.Hub = Ws.createHub();
///   let attached = Ws.attach<system, Rules.State, Rules.Action>(
///     Rules.spec(),
///     table,
///     hub,
///     {
///       encode = func(m) = to_candid (m);
///       decode = func(b) = from_candid (b);
///     },
///     IcWebSocketCdkTypes.WsInitParams(null, null),
///   );
///   attached.ws.init<system>();  // starts the CDK's ack timers — this bare
///                                // top-level call reruns automatically on
///                                // every upgrade too (see `../README.md`'s
///                                // worked example), so no `postupgrade`
///                                // override is needed to restart it
///
///   // `ActorMixin` supplies all four `ws_*` Candid methods (open, close,
///   // message, get_messages) plus the idle-sweep timer — a host actor
///   // never has to hand-declare any of them. Wiring `attached.sweep`
///   // (not a bare `TP.sweep(table, Time.now())`) is what makes a
///   // still-connected tab whose game the sweep just ended get a fresh
///   // push instead of silently keeping a stale view — see `Attached`'s
///   // own doc below.
///   include ActorMixin<system>(attached.ws, attached.sweep);
///
/// `ws_message`'s second Candid parameter — `ActorMixin`'s own `msgType`
/// — is a plain `Blob`, not `Ws.Msg<S, M>` itself: the CDK ignores its
/// VALUE either way (it exists only so a canister's `.did` exposes SOME
/// app-message type, for tooling that introspects it — see
/// `ic-websocket-cdk`'s own doc comment on `ws_message`), and `S`/`M`
/// aren't in scope inside a mixin that only ever holds the already-built
/// `ws`. Nothing is lost: the real message this connection is acting on
/// always arrives through `args`'s own `content` field and is decoded via
/// `codec.decode` inside this module's own `onMessage` (see `attach`
/// below), exactly as before. A caller that ever wants to reconstruct
/// `msgType` itself can still do
/// `from_candid(msgType) : ?Ws.Msg<Rules.State, Rules.Action>` — the
/// identical decode `codec.decode` already performs on the live path.
///
/// See `../README.md`'s "Real-time push" section for the full worked
/// example, including the frontend half.
/// ═══════════════════════════════════════════════════════════════════════════

import Map "mo:core/Map";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Time "mo:core/Time";
import Timer "mo:core/Timer";
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

  /// `reqId` is an opaque token the CLIENT makes up and this module only
  /// ever echoes back verbatim — never inspected or generated here. It
  /// exists because a single WS connection's incoming stream mixes two
  /// unrelated things a client cannot otherwise tell apart: the direct
  /// reply to ITS OWN outstanding request, and an unsolicited push this
  /// same connection gets because the OTHER seat just did something (see
  /// `pushRelevant` below — a submit/join/etc. pushes a fresh view to
  /// BOTH participants, not just the acting one). Before this field
  /// existed, a client-side FIFO match-the-next-message-to-the-oldest-
  /// pending-request scheme (the only thing available) could have an
  /// opponent's broadcast steal the slot meant for this connection's own
  /// reply — the caller's own request then hangs forever (the real reply
  /// arrives to an already-empty queue) while resolving with someone
  /// else's payload instead. `#view`/`#err` pass `reqId` straight through
  /// from whichever `#req` triggered them; a push to the OTHER
  /// participant (who asked for nothing) carries `null`, same as this
  /// connection's own periodic keep-alive/service traffic which never
  /// touches this type at all.
  public type Msg<S, M> = {
    #req : { sid : TP.SessionId; req : Request<M>; reqId : ?Nat64 }; // client -> canister
    #view : { reqId : ?Nat64; view : TP.View<S> };                   // canister -> client
    #err : { reqId : ?Nat64; err : TP.Err };                         // canister -> client
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
    // Bumped by every `remember()` call for a given sid — including an
    // otherwise-idempotent re-registration under the SAME principal (a
    // same-tab reconnect: `SelfGatewayTransport` reuses one fixed
    // principal for its whole lifetime, only the `client_key` nonce
    // changes across a reopen — see `gateway-transport.ts`'s `open()`).
    // `bySid`/`byPrincipal` alone can't tell a stale close for such a
    // reconnect apart from a genuine departure, because nothing about
    // EITHER map actually changes across it; this counter is the extra
    // signal `Ws.mo`'s deferred-close check needs — see its own doc.
    var generation : Map.Map<TP.SessionId, Nat>;
  };

  public func createHub() : Hub = {
    var bySid = Map.empty<TP.SessionId, Principal.Principal>();
    var byPrincipal = Map.empty<Principal.Principal, TP.SessionId>();
    var generation = Map.empty<TP.SessionId, Nat>();
  };

  /// This sid's current generation counter (0 if never remembered at
  /// all) — see `Hub.generation`'s own doc.
  public func generationOf(hub : Hub, sid : TP.SessionId) : Nat {
    switch (Map.get(hub.generation, Text.compare, sid)) {
      case (?g) g;
      case null 0;
    };
  };

  /// Binds `sid` to `p`, replacing whichever principal it was bound to
  /// before (if any) — a session reconnecting under a NEW principal (a
  /// page reload: `sid` survives in sessionStorage, but every one of this
  /// package's reference frontends deliberately mints a FRESH principal
  /// on every load — see `examples/racing/frontend/src/duel/duel-app.js`'s
  /// own doc on why, a real `ic-websocket-cdk@0.4.1` bookkeeping quirk).
  /// Cleans up the OLD principal's own `byPrincipal` entry right here,
  /// not just `bySid`'s — see `forget`'s own doc for the bug leaving it
  /// dangling produces. Exposed (not just called internally) so it's
  /// unit-testable against `Hub`'s two maps directly, without needing a
  /// full `IcWebSocketCdk` actor. Always bumps `generation`, even when
  /// `p` is unchanged from before — see `Hub.generation`'s own doc.
  public func remember(hub : Hub, sid : TP.SessionId, p : Principal.Principal) {
    switch (Map.get(hub.bySid, Text.compare, sid)) {
      case (?oldP) {
        if (Principal.notEqual(oldP, p)) {
          Map.remove(hub.byPrincipal, Principal.compare, oldP);
        };
      };
      case null {};
    };
    Map.add(hub.bySid, Text.compare, sid, p);
    Map.add(hub.byPrincipal, Principal.compare, p, sid);
    Map.add(hub.generation, Text.compare, sid, generationOf(hub, sid) + 1);
  };

  /// Un-binds `p`, but only clears `bySid[sid]` if `p` is STILL that
  /// session's current principal — never a stale one. Without this
  /// guard, a belated close for an OLD, already-superseded connection
  /// (see `remember`'s own doc: a reload's own `ws_close`, fired from
  /// `pagehide`, has no guarantee of completing before the tab tears
  /// down, so it can arrive well after the SAME session has already
  /// reconnected under a fresh principal) would erase the CURRENT, live
  /// registration out from under a session that never actually left —
  /// `onClose`'s caller would then find `sid` still resolvable from the
  /// stale principal, run `disconnectSession` on it, and silently abort
  /// a game two still-connected players were mid-round on, crediting the
  /// reconnected (not gone) player as the one who walked away. A real,
  /// observed bug, not hypothetical: this is the analogous problem to
  /// the `ic-websocket-cdk` quirk `remember`'s own doc references,
  /// except one layer up, in this module's OWN `Hub` — a fresh principal
  /// per page load sidesteps the CDK's version of it but does nothing
  /// for this one, since `Hub` deliberately keeps tracking the SAME
  /// `sid` across that reload.
  public func forget(hub : Hub, p : Principal.Principal) {
    switch (Map.get(hub.byPrincipal, Principal.compare, p)) {
      case null {};
      case (?sid) {
        Map.remove(hub.byPrincipal, Principal.compare, p);
        switch (Map.get(hub.bySid, Text.compare, sid)) {
          case (?curP) {
            if (Principal.equal(curP, p)) {
              Map.remove(hub.bySid, Text.compare, sid);
            };
          };
          case null {};
        };
      };
    };
  };

  // ────────────────────────── wiring ───────────────────────────────────────

  /// What `attach` hands back to a host actor. `ws` is the raw CDK object
  /// (`ws.init<system>()`, and `ActorMixin`'s four `ws_*` methods forward
  /// straight into it). `sweep` is the idle-sweep hook `ActorMixin` wires
  /// to its own recurring timer — it runs the engine's own `TP.sweep`
  /// AND, unlike a bare `TP.sweep(table, Time.now())` would, pushes a
  /// fresh view to every session it just evicted from a #staging/#active/
  /// #debrief phase that sweep just collapsed to #empty. Without going
  /// through here, that eviction is invisible to `hub`/`pushRelevant`
  /// entirely (`ActorMixin.mo`'s timer has no access to either), so a
  /// still-connected tab whose game the sweep just ended would keep
  /// showing a stale view until it happened to send a request of its own.
  public type Attached = {
    ws : IcWebSocketCdk.IcWebSocket;
    sweep : (Int) -> async ();
  };

  /// How long `onClose` waits before actually treating a closed
  /// connection as a genuine departure — see `onClose`'s own doc for the
  /// race this closes. Comfortably longer than one client poll tick
  /// (`DEFAULT_INTERVAL_MS` in `frontend/ws/gateway-client.ts`, 500ms) so
  /// a same-tab reconnect's first `#req` has landed well before this
  /// fires, while staying short next to the CDK's own ~60-120s
  /// keep-alive-timeout detection floor — this grace period is layered
  /// UNDER that floor for the cooperative-close path, not instead of it.
  let CLOSE_GRACE : Time.Duration = #seconds(3);

  /// Builds a ready-to-forward `IcWebSocketCdk.IcWebSocket` bound to one
  /// game's `Spec`/`Table`: every inbound `#req` is dispatched to the
  /// matching engine operation, and every connected participant of the
  /// affected match gets a fresh `#view` push. A host actor forwards its
  /// four `ws_*` Candid methods straight into the returned `ws` — see
  /// this module's doc header for the exact one-liners — and wires the
  /// returned `sweep` to `ActorMixin`'s own idle-sweep timer instead of
  /// calling `TP.sweep` directly (see `Attached`'s own doc for why).
  /// Needs the `<system>` capability (like `ActorMixin`'s own
  /// `mixin<system>`) because `onClose` below schedules a deferred check
  /// via `Timer.setTimer<system>` — see its own doc.
  public func attach<system, S, M>(
    spec : TP.Spec<S, M>,
    table : TP.Table<S, M>,
    hub : Hub,
    codec : Codec<S, M>,
    wsParams : IcWebSocketCdkTypes.WsInitParams,
  ) : Attached {
    let wsState = IcWebSocketCdkState.IcWebSocketState(wsParams);

    func pushTo(sid : TP.SessionId, msg : Msg<S, M>) : async () {
      switch (Map.get(hub.bySid, Text.compare, sid)) {
        case null {}; // that seat isn't connected over WS (e.g. still polling)
        case (?p) {
          ignore await IcWebSocketCdk.send(wsState, p, codec.encode(msg));
        };
      };
    };

    /// `reqId` is `null` unless `sid` is the session whose OWN request
    /// triggered this push — see `pushRelevant`'s doc for why a push to
    /// anyone else always passes `null` here.
    func pushView(now : Int, sid : TP.SessionId, reqId : ?Nat64) : async () {
      await pushTo(sid, #view({ reqId; view = TP.status(table, now, sid) }));
    };

    /// Views change for both seats on almost every mutation (a submit can
    /// resolve the round, a leave/rematch/reset can end or restart the
    /// match) — push to whichever sids are actually part of the current
    /// match, falling back to just the acting `sid` while staging/empty.
    /// `reqId` (the acting session's own request token, see `Msg`'s doc)
    /// is passed through ONLY to `sid` itself; the partner's push is
    /// always an unsolicited broadcast from their point of view, `null`
    /// regardless of what `sid` passed in.
    func pushRelevant(now : Int, sid : TP.SessionId, reqId : ?Nat64) : async () {
      func forSid(other : TP.SessionId) : ?Nat64 {
        if (other == sid) reqId else null;
      };
      switch (table.phase) {
        case (#active g) {
          await pushView(now, g.p1, forSid(g.p1));
          await pushView(now, g.p2, forSid(g.p2));
        };
        case (#debrief d) {
          await pushView(now, d.p1, forSid(d.p1));
          await pushView(now, d.p2, forSid(d.p2));
        };
        case (_) {
          // No fixed pair of participants yet (#empty / #staging) — the
          // engine has no notion of "who else is watching an open seat"
          // the way #active/#debrief's own p1/p2 fields do, so the only
          // place that DOES know is this transport's own `hub`: everyone
          // currently connected over WS, seated or not. Push to all of
          // them, not just the session that acted — otherwise a tab
          // sitting in the lobby watching for an opponent never finds out
          // a seat was taken (or freed) until it happens to send a
          // request of its own. `sid` itself is always among `hub.bySid`
          // here (`remember` ran at the top of `onMessage`, before this),
          // so it needs no special case — `forSid` still gives it its own
          // `reqId` like any other branch.
          for (other in Map.keys(hub.bySid)) {
            await pushView(now, other, forSid(other));
          };
        };
      };
    };

    func onMessage(
      args : IcWebSocketCdkTypes.OnMessageCallbackArgs
    ) : async () {
      switch (codec.decode(args.message)) {
        case (? #req { sid; req; reqId }) {
          remember(hub, sid, args.client_principal);
          let now = Time.now();
          switch (req) {
            case (#status) { await pushView(now, sid, reqId) };
            case (#join seat) {
              switch (TP.join(spec, table, now, sid, seat)) {
                case (#ok _) { await pushRelevant(now, sid, reqId) };
                case (#err e) { await pushTo(sid, #err({ reqId; err = e })) };
              };
            };
            case (#submit move) {
              switch (TP.submit(spec, table, now, sid, move)) {
                case (#ok _) { await pushRelevant(now, sid, reqId) };
                case (#err e) { await pushTo(sid, #err({ reqId; err = e })) };
              };
            };
            case (#rematch) {
              switch (TP.rematch(spec, table, now, sid)) {
                case (#ok _) { await pushRelevant(now, sid, reqId) };
                case (#err e) { await pushTo(sid, #err({ reqId; err = e })) };
              };
            };
            case (#leave) {
              switch (TP.leave(table, now, sid)) {
                case (#ok _) { await pushRelevant(now, sid, reqId) };
                case (#err e) { await pushTo(sid, #err({ reqId; err = e })) };
              };
            };
            case (#reset) {
              switch (TP.reset(table, now, sid)) {
                case (#ok _) { await pushRelevant(now, sid, reqId) };
                case (#err e) { await pushTo(sid, #err({ reqId; err = e })) };
              };
            };
            case (#ackEnded) {
              TP.ackEnded(table, sid);
              await pushView(now, sid, reqId);
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

    /// The actual disconnect work `onClose` defers behind `CLOSE_GRACE` —
    /// see that function's own doc for why. `seenGen` is this sid's
    /// `Hub.generation` as of the ORIGINAL close event; if a reconnect's
    /// first `#req` bumped it since (`remember()` ran again for `s`),
    /// this close turned out to be stale after all — back off entirely
    /// rather than abort a game a still-connected player never left.
    func finishClose(s : TP.SessionId, seenGen : Nat) : async () {
      if (generationOf(hub, s) != seenGen) return; // reconnected since — false alarm
      let now = Time.now();
      await disconnectSession(now, s);
      // Both gone: free the board now instead of leaving it occupied
      // until the idle timeout notices. Only reachable via #debrief
      // here, since disconnectSession() above already collapsed
      // #active into #debrief and #staging into #empty.
      //
      // Caveat: `hub.bySid` only tracks sessions connected over THIS
      // WS transport — if a table were ever driven by two genuinely
      // different transports (one seat on a real `GatewayWs`, the
      // other on some hand-rolled non-WS mock never registered in
      // this `hub`), this would wrongly treat a still-active partner
      // as gone. Not engineered around: this package ships no other
      // transport any more (mutation is exclusively via `ws_message`
      // — see this module's own doc header), and a single game
      // deployment uses one frontend build for every player, so this
      // is a theoretical edge, not a practical one. A partner found
      // disconnected here is NOT itself re-checked against its own
      // generation/grace period — by this point `s`'s own close has
      // already survived one full `CLOSE_GRACE`, so compounding a
      // second deferral on top for the partner is not worth the extra
      // latency it would add to freeing a genuinely doubly-abandoned
      // board.
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
      await pushRelevant(now, s, null);
    };

    /// Fires when the CDK detects a connection is gone — either the
    /// client's own `ws_close` (a cooperative goodbye) or the CDK's
    /// internal keep-alive timeout (an involuntary disappearance: crash,
    /// force-quit, network drop — see this module's doc header and
    /// `../README.md`'s real-time-push section for the ~60-120s detection
    /// floor that timeout imposes). Either way this is normally the one
    /// place a disappearing player can be told apart from one who's
    /// merely gone quiet mid-thought — EXCEPT for one race
    /// `OnCloseCallbackArgs` can't resolve on its own: it carries only
    /// `client_principal`, never which CONNECTION (client_key) closed,
    /// and `SelfGatewayTransport` reuses ONE fixed principal across a
    /// same-tab reconnect (only the client_key nonce changes on reopen —
    /// see `Hub.generation`'s own doc). A stale close for the OLD
    /// connection can therefore arrive AFTER a NEW one has already opened
    /// under that SAME principal but BEFORE that new connection's first
    /// `#req` re-registers it (`remember()` only ever runs from
    /// `onMessage` — there is no `onOpen` handler wired here, so `Hub`
    /// learns nothing at `ws_open` time itself). This is genuinely racy,
    /// not a bug in a single call's own ordering: the old close and the
    /// new connection's first message are two INDEPENDENTLY dispatched
    /// canister calls with no guaranteed relative processing order.
    /// Treating a stale close as a real departure immediately silently
    /// aborted a game two still-connected players were mid-round on. Not
    /// solvable by tightening `forget`'s own guard alone (tried first):
    /// that guard compares principals, and a same-tab reconnect's
    /// principal never changes, so it can't tell the two cases apart
    /// either. The actual fix — `finishClose`, above — defers the real
    /// disconnect by `CLOSE_GRACE` and re-checks this sid's `generation`
    /// once that elapses.
    func onClose(args : IcWebSocketCdkTypes.OnCloseCallbackArgs) : async () {
      let p = args.client_principal;
      let sid = Map.get(hub.byPrincipal, Principal.compare, p);
      forget(hub, p);
      switch (sid) {
        case null {}; // this principal was never registered to a sid — nothing to do
        case (?s) {
          let seenGen = generationOf(hub, s);
          ignore Timer.setTimer<system>(
            CLOSE_GRACE,
            func() : async () { await finishClose(s, seenGen) },
          );
        };
      };
    };

    let handlers = IcWebSocketCdkTypes.WsHandlers(null, ?onMessage, ?onClose);

    /// See `Attached`'s own doc. Captures who occupied the phase BEFORE
    /// running `TP.sweep`, then — only if that phase actually collapsed to
    /// #empty, i.e. this round's sweep really did evict someone — pushes
    /// each of them a fresh (now #lobby/#endedByOther) view, the same way
    /// `pushRelevant` already does for every other mutation.
    func sweepAndPush(now : Int) : async () {
      let before = table.phase;
      TP.sweep(table, now);
      let becameEmpty = switch (table.phase) { case (#empty) true; case (_) false };
      if (not becameEmpty) return; // nothing timed out this round
      switch (before) {
        case (#staging st) { await pushView(now, st.session, null) };
        case (#active g) {
          await pushView(now, g.p1, null);
          await pushView(now, g.p2, null);
        };
        case (#debrief d) {
          await pushView(now, d.p1, null);
          await pushView(now, d.p2, null);
        };
        case (#empty) {}; // already empty going in — this sweep did nothing
      };
    };

    { ws = IcWebSocketCdk.IcWebSocket(wsState, wsParams, handlers); sweep = sweepAndPush };
  };
};
