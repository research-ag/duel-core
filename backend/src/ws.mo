/// ═══════════════════════════════════════════════════════════════════════════
/// duel-game-core/ws — the REQUIRED real-time push transport, built on the
/// `ic-websocket-cdk` package (a browser <-> canister WebSocket relayed by
/// an off-chain Gateway, e.g. `wss://gateway.icws.io` — the IC itself has
/// no native WebSocket support).
///
/// Every host actor built on this package MUST wire this module: it's the
/// only way a client can mutate game state at all (`registry.mo`'s
/// `createTable`/`joinTable`/`submit`/... are not exposed as
/// plain Candid methods anywhere — see `lib.mo`'s "How a host actor wires
/// it" section). There is no dependency-free polling fallback any more —
/// a direct update call bypassing this module is exactly the race a
/// single, ordered WS channel exists to close (two independent update
/// calls have no guaranteed relative processing order once both are in
/// flight, so a plain `submit` racing this module's own traffic could
/// resolve out of order against it). `status` is the one exception: it
/// stays a plain public `query` (side-effect-free, no race risk) for
/// tooling/tests that don't want a WS handshake.
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
/// from any IC principal by default (see `../README.md`/`../../frontend`'s
/// `sid` — one per browser tab). A WebSocket connection, however, is keyed
/// by the caller's principal (each browser tab signs with its own identity,
/// generated or supplied by `ic-websocket-js`). `Hub` bridges the two: it
/// learns `sid <-> principal` from the `sid` every inbound `Msg` carries,
/// and forgets it on `ws_close`.
///
/// A game MAY opt a session into a real, non-spoofable identity instead —
/// e.g. a player who logged in via Internet Identity — by using a `sid` of
/// the form `sidForPrincipal(p)` (below): a pure, permanent function of
/// `p`, so nothing needs to be allocated or stored to "issue" it — the
/// first login already produces it, and it can never change so long as the
/// same login resolves to the same principal. This module is what makes
/// that binding real rather than a naming convention: `onMessage` (below)
/// rejects any inbound `sid` in that reserved namespace whose principal
/// doesn't match `args.client_principal` with `#unauthorized`, before the
/// request ever reaches `Hub`/`Registry`. A `sid` NOT in that namespace
/// keeps the fully decoupled, client-asserted trust model described above,
/// unchanged — the two kinds of session sit at the very same tables, since
/// `Table`/`Registry` never look at a `SessionId` beyond comparing it for
/// equality.
///
/// Every mutating request re-uses `Registry`'s own routed operations
/// (`createTable`, `joinTable`, `submit`, ...) with `Time.now()` —
/// nothing about game state, table routing, or legality is reimplemented
/// here — then pushes a fresh `TP.SessionStatus` to every session that
/// needs to see it: the affected table's own current occupants (both
/// seats, so an opponent's screen updates the instant a round resolves,
/// not on their next poll) and, whenever the open-table list itself may
/// have changed, every OTHER connected session that isn't currently at a
/// table (see `attach`'s `afterMutation`).
///
/// `ws_close` — whether the client's own goodbye or the CDK's internal
/// keep-alive timeout catching an involuntary disappearance (crash,
/// force-quit, network drop) — also drives an implicit `Registry.leave`
/// on behalf of that session (see `attach`'s `onClose`/
/// `disconnectSession`): a live game a player vanished from ends in a
/// shared debrief instead of leaving their opponent staring at a move
/// that's never coming, and a table BOTH players vanished from frees
/// itself instead of sitting occupied with nobody left to poll it into
/// freeing lazily. The CDK's keep-alive timeout is fixed at 60s (not
/// configurable via `WsInitParams`), so involuntary disappearance has a
/// real detection floor of roughly 60-120s depending on where in the ack
/// cycle it happens — see `../README.md`'s real-time-push section.
///
/// ── How a host actor wires it ──────────────────────────────────────────
///
///   import Time "mo:core/Time";
///   import TP "mo:duel-game-core";
///   import Registry "mo:duel-game-core/registry";
///   import IcWebSocketCdk "mo:ic-websocket-cdk";
///   import IcWebSocketCdkTypes "mo:ic-websocket-cdk/Types";
///   import Ws "mo:duel-game-core/Ws";
///   import ActorMixin "mo:duel-game-core/actor_mixin";
///
///   let registry : TP.Registry<Rules.State, Rules.Action> =
///     Registry.new(60_000_000_000); // 60 s idle timeout, per table
///   let hub : Ws.Hub = Ws.createHub();
///   let attached = Ws.attach<system, Rules.State, Rules.Action>(
///     Rules.spec(),
///     registry,
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
///   // (not a bare `registry.sweep(Time.now())`) is what makes
///   // a still-connected tab whose game the sweep just ended get a fresh
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
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Time "mo:core/Time";
import Timer "mo:core/Timer";
import IcWebSocketCdk "mo:ic-websocket-cdk";
import IcWebSocketCdkState "mo:ic-websocket-cdk/State";
import IcWebSocketCdkTypes "mo:ic-websocket-cdk/Types";

import TP "./lib";
import Registry "./registry";

module {

  // ────────────────────────── the wire protocol ───────────────────────────
  //
  // `ic-websocket-js` requires ONE application-message type shared by both
  // directions (it reads it straight off `ws_message`'s second, otherwise
  // unused, Candid parameter — see `attach`'s doc header) — so `Msg` is a
  // variant covering client->canister requests AND canister->client pushes,
  // not two separate types.

  /// A client -> canister request. Mirrors `Registry`'s own operations
  /// plus an explicit resync (`#status`, e.g. right after the socket
  /// opens, before any local mutation has happened) — `#status` already
  /// returns the open-table list whenever the caller isn't currently at
  /// a table (see `TP.SessionStatus`), so there's no separate "list
  /// tables" request to send.
  ///
  /// `#submit`/`#leave`/`#reset`/`#claimWin` carry the `gen` (and, for
  /// `#submit`, `turn`) the client last observed via `View` — see
  /// `TP.Table.gen`'s own doc for why: it's what lets
  /// `Registry.submit`/`leave`/`reset`/`claimWin` reject a stale replay
  /// (most commonly a client-side resend of a call whose original attempt
  /// secretly already landed — see
  /// `../../frontend/src/ws/gateway-client.ts`'s resend-queue doc) as
  /// `#stale` instead of silently applying it to whatever match/round is
  /// current by the time it's processed. `#createTable`/`#joinTable`/
  /// `#rematch`/`#ackEnded` need no such binding — see the engine doc
  /// header's guarantee 6.
  public type Request<M> = {
    #createTable : { seat : TP.Seat; visibility : TP.TableVisibility };
    #joinTable : { id : TP.TableId; seat : TP.Seat; code : ?Text };
    #submit : { gen : Nat; turn : Nat; move : M };
    #rematch;
    #leave : { gen : Nat };
    #reset : { gen : Nat };
    // Claim the win when the opponent's move has sat pending past this
    // table's own `claimTimeoutNs` — see `TP.Table.claimWin`'s own doc.
    // Purely optional: a client is never required to send this even once
    // `View.inGame.claimWinAvailable` turns true.
    #claimWin : { gen : Nat };
    #ackEnded;
    #status;
  };

  /// `reqId` is an opaque token the CLIENT makes up and this module only
  /// ever echoes back verbatim — never inspected or generated here. It
  /// exists because a single WS connection's incoming stream mixes two
  /// unrelated things a client cannot otherwise tell apart: the direct
  /// reply to ITS OWN outstanding request, and an unsolicited push this
  /// same connection gets because the OTHER seat just did something (see
  /// `afterMutation` below — a submit/joinTable/etc. pushes a fresh
  /// status to BOTH participants, not just the acting one). Before this field
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
    #view : { reqId : ?Nat64; view : TP.SessionStatus<S> }; // canister -> client
    #err : { reqId : ?Nat64; err : TP.Err }; // canister -> client
  };

  /// Built at a call site where `S`/`M` are concrete (a host actor, not
  /// this generic module) via `to_candid`/`from_candid` — sidesteps any
  /// question of whether those primitives specialize cleanly inside a
  /// function still generic over `S`/`M`.
  public type Codec<S, M> = {
    encode : (Msg<S, M>) -> Blob;
    decode : (Blob) -> ?Msg<S, M>;
  };

  // ────────────────────────── principal-bound identity ────────────────────

  /// Reserved `SessionId` namespace for a real, non-spoofable identity —
  /// see this module's own doc header. Never used internally by `Table`/
  /// `Registry`, which treat every `SessionId` as opaque text; this prefix
  /// only ever matters to `onMessage`'s own guard, below.
  public let PRINCIPAL_SID_PREFIX : Text = "ii:";

  /// The permanent player id for principal `p` — a pure function, so it's
  /// "issued" for free the first time `p` ever logs in (nothing to
  /// allocate or store) and can never change for as long as the same login
  /// keeps resolving to the same principal. A frontend deriving a session's
  /// `sid` this way (see `../../frontend/src/identity.ts`'s
  /// `sidForPrincipal`, which MUST compute the identical value) gets that
  /// guarantee automatically; `isAuthorizedSid` below is what makes it
  /// non-spoofable rather than just a naming convention.
  public func sidForPrincipal(p : Principal.Principal) : TP.SessionId {
    PRINCIPAL_SID_PREFIX # Principal.toText(p);
  };

  /// Whether `sid` is legal for a request arriving over a connection
  /// authenticated as `p`. A `sid` outside the reserved namespace is
  /// always authorized — the plain, client-asserted trust model this
  /// module always had is unchanged for it. A `sid` inside the reserved
  /// namespace is authorized only if it's exactly `sidForPrincipal(p)` —
  /// anything else is an attempt to claim an identity that isn't this
  /// caller's own. Pulled out as its own pure function (mirroring
  /// `rematchOpenedLobby`'s own doc on why) so it's unit-testable without
  /// the `IcWebSocketCdk` actor machinery `onMessage` itself needs.
  public func isAuthorizedSid(sid : TP.SessionId, p : Principal.Principal) : Bool {
    if (not Text.startsWith(sid, #text PRINCIPAL_SID_PREFIX)) return true;
    Text.equal(sid, sidForPrincipal(p));
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
    // Pruned (unlike a plain idle counter would be) once `finishClose`
    // confirms a genuine, un-superseded departure — see its own doc —
    // so this map doesn't grow by one entry per distinct sid for the
    // life of the canister.
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
  /// to its own recurring timer — it runs `Registry.sweep` (across EVERY
  /// table in the registry) AND, unlike a bare
  /// `registry.sweep(Time.now())` would, pushes a fresh status
  /// to every connected session in `hub` when that sweep just timed
  /// something out. Without going through here, that eviction is
  /// invisible to `hub`/`afterMutation` entirely (`actor_mixin.mo`'s timer
  /// has no access to either), so a still-connected tab — whether one of
  /// the evicted participants or just a lobby tab browsing the table
  /// list — would keep showing a stale status until it happened to send
  /// a request of its own.
  public type Attached = {
    ws : IcWebSocketCdk.IcWebSocket;
    sweep : (Int) -> async* ();
  };

  /// `async*`/`await*`, not `async`/`await`, on `sweep` here and on every
  /// push helper below (`pushTo`/`pushStatus`/`afterMutation`/
  /// `finishClose`/`sweepAndPush`): only `pushTo`'s own call to
  /// `IcWebSocketCdk.send` is a genuine `await` — everything that calls
  /// it, directly or transitively, is a thin wrapper (a fan-out loop, a
  /// phase-based dispatch) with no awaiting of its own to do. A plain
  /// `async`/`await` chain would still pay a real cost for each one of
  /// those wrappers: on the IC, every `async` function call is its own
  /// message with its own commit point, so e.g. `afterMutation`'s
  /// multi-session fan-out would compile to one extra round trip through
  /// the scheduler per session even though nothing in either wrapper
  /// actually suspends. `async*`/`await*` inlines a call into its
  /// caller's own async state machine instead of starting a new one, so
  /// the whole `sweep`/`onMessage`/`onClose` call tree down to `pushTo`'s
  /// single real `await` compiles to ONE message, not one per wrapper —
  /// the same number of genuine sends, far fewer commit points and
  /// continuation-closure allocations. Never widen one of these back to
  /// plain `async`/`await` just to make a call site read more familiarly;
  /// it silently reintroduces that per-wrapper overhead.
  /// `disconnectSession` below goes one step further and drops `async`
  /// entirely — it calls only `Registry.leave` (fully synchronous engine
  /// code, no `await`/`await*` of any kind inside it), so there is no
  /// async state machine to build at all.

  /// How long `onClose` waits before actually treating a closed
  /// connection as a genuine departure — see `onClose`'s own doc for the
  /// race this closes. Comfortably longer than one client poll tick
  /// (`DEFAULT_INTERVAL_MS` in `frontend/ws/gateway-client.ts`, 500ms) so
  /// a same-tab reconnect's first `#req` has landed well before this
  /// fires, while staying short next to the CDK's own ~60-120s
  /// keep-alive-timeout detection floor — this grace period is layered
  /// UNDER that floor for the cooperative-close path, not instead of it.
  let CLOSE_GRACE : Time.Duration = #seconds(3);

  /// Whether a JUST-SUCCEEDED `#rematch` opened a fresh, unreserved
  /// staging worth telling every other browsing session about — `id` is
  /// the caller's OWN table (`priorId` at the `attach()` call site below,
  /// since `RematchOk` carries no id of its own). A rematch usually can't
  /// change which tables are open at all (see `afterMutation`'s own
  /// doc) — its normal outcome either reserves the open seat for the
  /// departing partner (unreserved-and-unexpired, so `Registry.openness`
  /// already excludes it from `listTables`, exactly as before this call)
  /// or starts the game outright (also excluded, now `#active`). The one
  /// case that DOES open a fresh listing is the partner having already
  /// acked their own debrief (`Table.rematchPartner`'s own doc): the new
  /// staging comes back UNRESERVED, freshly browsable the instant it
  /// exists — without telling every browsing session, a tab already
  /// sitting in the lobby (e.g. the departed partner's own) never learns
  /// a seat just opened up, showing "No open tables right now" for the
  /// whole idle window (see the 007 retest's "rematch after your
  /// opponent leaves strands you at an invisible table" finding). Pulled
  /// out of `attach()`'s own `onMessage` specifically so it's testable
  /// without the `IcWebSocketCdk` actor machinery `attach()` itself
  /// needs, which isn't exercisable in this repo's interpreter test
  /// harness (see `Hub.test.mo`'s own doc for the same constraint).
  public func rematchOpenedLobby<S, M>(registry : TP.Registry<S, M>, id : ?TP.TableId) : Bool {
    switch (id) {
      case null false;
      case (?id) switch (registry.tables.get(id)) {
        case null false;
        case (?t) switch (t.phase) {
          case (#staging st) st.reservedFor == null;
          case (_) false;
        };
      };
    };
  };

  /// Builds a ready-to-forward `IcWebSocketCdk.IcWebSocket` bound to one
  /// game's `Spec`/`Registry`: every inbound `#req` is dispatched to
  /// the matching `Registry` operation, and every session that needs to
  /// see the result — the affected table's own occupants, and, when the
  /// open-table list itself might have changed, every other browsing
  /// session — gets a fresh `#view` push. A host actor forwards its four
  /// `ws_*` Candid methods straight into the returned `ws` — see this
  /// module's doc header for the exact one-liners — and wires the
  /// returned `sweep` to `ActorMixin`'s own idle-sweep timer instead of
  /// calling `Registry.sweep` directly (see `Attached`'s own doc for why).
  /// Needs the `<system>` capability (like `ActorMixin`'s own
  /// `mixin<system>`) because `onClose` below schedules a deferred check
  /// via `Timer.setTimer<system>` — see its own doc.
  public func attach<system, S, M>(
    spec : TP.Spec<S, M>,
    registry : TP.Registry<S, M>,
    hub : Hub,
    codec : Codec<S, M>,
    wsParams : IcWebSocketCdkTypes.WsInitParams,
  ) : Attached {
    let wsState = IcWebSocketCdkState.IcWebSocketState(wsParams);

    func pushTo(sid : TP.SessionId, msg : Msg<S, M>) : async* () {
      switch (Map.get(hub.bySid, Text.compare, sid)) {
        case null {}; // that seat isn't connected over WS (e.g. still polling)
        case (?p) {
          ignore await* IcWebSocketCdk.send(wsState, p, codec.encode(msg));
        };
      };
    };

    /// `reqId` is `null` unless `sid` is the session whose OWN request
    /// triggered this push — see `afterMutation`'s doc for why a push to
    /// anyone else always passes `null` here. Always truthful and always
    /// safe to call for any `sid`, seated or browsing: `Registry.status`
    /// itself resolves which of the two it currently is.
    func pushStatus(now : Int, sid : TP.SessionId, reqId : ?Nat64) : async* () {
      await* pushTo(sid, #view({ reqId; view = registry.status(now, sid) }));
    };

    /// The fan-out every successful mutating request runs after itself.
    /// `sid` always gets its own fresh status first, correlated via
    /// `reqId`. If `id` names a table that still exists, its own current
    /// occupants (`#active`/`#debrief`'s `p1`/`p2`, `#staging`'s solo
    /// occupant AND, if present, whoever a rematch reservation names —
    /// worth pushing proactively so the invitation reaches them without
    /// waiting for a request of their own) each get an unsolicited,
    /// `reqId = null` push too — skipping `sid` itself, already covered
    /// above. If `broadcastLobby` is set, every OTHER hub-connected
    /// session that ISN'T currently at any table (i.e. genuinely
    /// browsing) also gets a fresh push, since the open-table list itself
    /// may have changed (a table created, filled, freed, or GC'd) —
    /// `submit` always passes `false` here, since it can never change
    /// which tables are open to begin with; `#rematch`'s own call site
    /// computes this per-outcome via `rematchOpenedLobby` above instead
    /// of a fixed `false`, since ONE of its outcomes (the partner already
    /// left) does open a fresh listing.
    func afterMutation(now : Int, sid : TP.SessionId, reqId : ?Nat64, id : ?TP.TableId, broadcastLobby : Bool) : async* () {
      await* pushStatus(now, sid, reqId);
      switch (id) {
        case null {};
        case (?id) switch (registry.tables.get(id)) {
          case null {}; // GC'd — nobody left to reach through it
          case (?t) {
            switch (t.phase) {
              case (#empty) {};
              case (#staging st) {
                if (st.session != sid) {
                  await* pushStatus(now, st.session, null);
                };
                switch (st.reservedFor) {
                  case (?partner) {
                    if (partner != sid) {
                      await* pushStatus(now, partner, null);
                    };
                  };
                  case null {};
                };
              };
              case (#active g) {
                if (g.p1 != sid) { await* pushStatus(now, g.p1, null) };
                if (g.p2 != sid) { await* pushStatus(now, g.p2, null) };
              };
              case (#debrief d) {
                if (d.p1 != sid) { await* pushStatus(now, d.p1, null) };
                if (d.p2 != sid) { await* pushStatus(now, d.p2, null) };
              };
            };
          };
        };
      };
      if (broadcastLobby) {
        for (other in Map.keys(hub.bySid)) {
          if (other != sid) {
            switch (Map.get(registry.bySession, Text.compare, other)) {
              case null { await* pushStatus(now, other, null) }; // genuinely browsing
              case (?_) {}; // seated somewhere — already reached above if relevant
            };
          };
        };
      };
    };

    func onMessage(
      args : IcWebSocketCdkTypes.OnMessageCallbackArgs
    ) : async* () {
      switch (codec.decode(args.message)) {
        case (?#req { sid; req; reqId }) {
          if (not isAuthorizedSid(sid, args.client_principal)) {
            // `sid` claims the reserved principal-bound namespace but
            // doesn't belong to this connection's own authenticated
            // principal — reject before `remember` (which would otherwise
            // bind this sid to a principal it was never legitimately
            // issued to) or `Registry` ever see it. Sent straight to
            // `args.client_principal`, not via `pushTo`/`sid` — `pushTo`
            // resolves ITS target principal from `hub.bySid[sid]`, exactly
            // the mapping this caller just failed to prove ownership of.
            ignore await* IcWebSocketCdk.send(
              wsState,
              args.client_principal,
              codec.encode(#err({ reqId; err = #unauthorized })),
            );
            return;
          };
          remember(hub, sid, args.client_principal);
          let now = Time.now();
          // This session's table BEFORE the request runs — the only way
          // `submit`/`rematch`/`leave`/`reset`/`claimWin`/`ackEnded`
          // (none of which hand back a `TableId` of their own) can tell `afterMutation`
          // which table's own occupants to also reach. `createTable`/
          // `joinTable` don't need it: they return their own id directly.
          let priorId = Map.get(registry.bySession, Text.compare, sid);
          switch (req) {
            case (#status) { await* pushStatus(now, sid, reqId) };
            case (#createTable { seat; visibility }) {
              switch (registry.createTable(spec, now, sid, seat, visibility)) {
                case (#ok id) await* afterMutation(now, sid, reqId, ?id, true);
                case (#err e) await* pushTo(sid, #err({ reqId; err = e }));
              };
            };
            case (#joinTable { id; seat; code }) {
              switch (registry.joinTable(spec, now, sid, id, seat, code)) {
                case (#ok _) {
                  await* afterMutation(now, sid, reqId, ?id, true);
                };
                case (#err e) { await* pushTo(sid, #err({ reqId; err = e })) };
              };
            };
            case (#submit { gen; turn; move }) {
              switch (registry.submit(spec, now, sid, gen, turn, move)) {
                case (#ok _) {
                  await* afterMutation(now, sid, reqId, priorId, false);
                };
                case (#err e) { await* pushTo(sid, #err({ reqId; err = e })) };
              };
            };
            case (#claimWin { gen }) {
              switch (registry.claimWin(now, sid, gen)) {
                case (#ok _) {
                  await* afterMutation(now, sid, reqId, priorId, false);
                };
                case (#err e) { await* pushTo(sid, #err({ reqId; err = e })) };
              };
            };
            case (#rematch) {
              switch (registry.rematch(spec, now, sid)) {
                case (#ok _) {
                  await* afterMutation(now, sid, reqId, priorId, rematchOpenedLobby(registry, priorId));
                };
                case (#err e) { await* pushTo(sid, #err({ reqId; err = e })) };
              };
            };
            case (#leave { gen }) {
              switch (registry.leave(now, sid, gen)) {
                case (#ok _) {
                  await* afterMutation(now, sid, reqId, priorId, true);
                };
                case (#err e) { await* pushTo(sid, #err({ reqId; err = e })) };
              };
            };
            case (#reset { gen }) {
              switch (registry.reset(now, sid, gen)) {
                case (#ok _) {
                  await* afterMutation(now, sid, reqId, priorId, true);
                };
                case (#err e) { await* pushTo(sid, #err({ reqId; err = e })) };
              };
            };
            case (#ackEnded) {
              registry.ackEnded(sid);
              await* afterMutation(now, sid, reqId, priorId, true);
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
    /// The table's OWN CURRENT `gen`, not a caller-supplied value — this
    /// leave is driven by the socket closing, not by any `#req` a client
    /// sent, so there's no earlier-observed generation to validate
    /// against and it must always go through. (Unrelated to
    /// `Hub.generation`/`seenGen` below, which tracks WS *connection*
    /// identity, not match epochs.) `null` if `sid` isn't at any table.
    func genOfSessionsTable(sid : TP.SessionId) : ?Nat = switch (Map.get(registry.bySession, Text.compare, sid)) {
      case null null;
      case (?id) switch (Map.get(registry.tables, Nat.compare, id)) {
        case null null;
        case (?t) ?t.gen;
      };
    };

    /// Two calls, each re-resolving `sid`'s CURRENT table fresh (unlike
    /// the single-table engine, `Registry.leave` can change — or clear —
    /// which table `sid` even maps to in between them): the first
    /// performs whatever `leave` means for `sid`'s CURRENT phase
    /// (staging -> empty / active -> shared `#aborted` debrief, which
    /// does NOT auto-ack `sid`'s own side — see `Registry.leave`'s own
    /// doc — / debrief -> ack); the second, re-resolved, call then acks
    /// that same debrief immediately, since a session whose socket just
    /// closed will never come back to click "leave" a second time itself
    /// the way a still-connected player would. A no-op call (nothing
    /// left to resolve `sid` to) is silently skipped rather than passed
    /// a made-up `gen`.
    func disconnectSession(now : Int, sid : TP.SessionId) {
      switch (genOfSessionsTable(sid)) {
        case (?g) ignore registry.leave(now, sid, g);
        case null {};
      };
      switch (genOfSessionsTable(sid)) {
        case (?g) ignore registry.leave(now, sid, g);
        case null {};
      };
    };

    /// The actual disconnect work `onClose` defers behind `CLOSE_GRACE` —
    /// see that function's own doc for why. `seenGen` is this sid's
    /// `Hub.generation` as of the ORIGINAL close event; if a reconnect's
    /// first `#req` bumped it since (`remember()` ran again for `s`),
    /// this close turned out to be stale after all — back off entirely
    /// rather than abort a game a still-connected player never left. On
    /// a genuine departure, also prunes `s`'s own `hub.generation` entry
    /// once the suspension below (`await* afterMutation`, which still
    /// reaches a real IC `await` down in `pushTo` — `async*`/`await*`
    /// removes the extra per-wrapper MESSAGE, not the underlying
    /// suspension itself, see `Attached`'s own doc) has had its chance to
    /// be raced by a reconnect (re-checked against `seenGen` again right
    /// before the prune, not just at entry) — `bySid`/`byPrincipal`
    /// already get cleaned up this way via `forget`, but `generation`
    /// otherwise never shrinks, growing by one entry per distinct sid for
    /// the life of the canister. The re-check matters: a reconnect
    /// landing in the window that suspension opens up would have bumped
    /// the generation again, and pruning the entry out from under that
    /// bumped counter would silently reset it to 0 — a LATER stale close
    /// for the connection that reconnect superseded could then wrongly
    /// match again. (`disconnectSession` just above is no longer part of
    /// this race at all — it's plain synchronous code now, not even
    /// `async*`, so calling it opens no window for anything to land in.)
    func finishClose(s : TP.SessionId, seenGen : Nat) : async* () {
      if (generationOf(hub, s) != seenGen) return; // reconnected since — false alarm
      let now = Time.now();
      // Captured BEFORE disconnecting: `s`'s own mapping is always fully
      // cleared by the time `disconnectSession` returns (see its own
      // doc), so this is the only chance to know which table to check
      // for a doubly-abandoned partner below.
      let priorId = Map.get(registry.bySession, Text.compare, s);
      disconnectSession(now, s);
      // Both gone: free the table now instead of leaving it occupied
      // until the idle timeout notices. Only reachable via #debrief
      // here, since disconnectSession() above already collapsed
      // #active into #debrief-then-acked-for-`s` and #staging into
      // #empty.
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
      switch (priorId) {
        case null {};
        case (?id) switch (Map.get(registry.tables, Nat.compare, id)) {
          case null {}; // already GC'd — nothing left to check
          case (?t) switch (t.phase) {
            case (#debrief d) {
              if (d.p1 == s or d.p2 == s) {
                let partner = if (d.p1 == s) d.p2 else d.p1;
                switch (Map.get(hub.bySid, Text.compare, partner)) {
                  case null disconnectSession(now, partner);
                  case (?_) {}; // partner is still connected — nothing to do
                };
              };
            };
            case (_) {};
          };
        };
      };
      await* afterMutation(now, s, null, priorId, true);
      // Safe to prune only if nothing bumped the generation again while
      // that suspended — see this function's own doc.
      if (generationOf(hub, s) == seenGen) {
        Map.remove(hub.generation, Text.compare, s);
      };
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
    func onClose(args : IcWebSocketCdkTypes.OnCloseCallbackArgs) : async* () {
      let p = args.client_principal;
      let sid = Map.get(hub.byPrincipal, Principal.compare, p);
      forget(hub, p);
      switch (sid) {
        case null {}; // this principal was never registered to a sid — nothing to do
        case (?s) {
          let seenGen = generationOf(hub, s);
          ignore Timer.setTimer<system>(
            CLOSE_GRACE,
            func() : async () { await* finishClose(s, seenGen) },
          );
        };
      };
    };

    let handlers = IcWebSocketCdkTypes.WsHandlers(null, ?onMessage, ?onClose);

    /// See `Attached`'s own doc. Only if `Registry.sweep` actually evicted
    /// someone from AT LEAST ONE table (checked by snapshotting every
    /// table's phase before sweeping, then checking which are #empty
    /// afterward — so a registry with nothing to evict does no further
    /// work) does this push a fresh status — to EVERY currently connected
    /// session in `hub`, not just the sweep's own former occupants of
    /// whichever table(s) actually timed out. This mirrors
    /// `afterMutation`'s own lobby-broadcast branch exactly, and for the
    /// same reason: `hub.bySid` is the only place that knows about a tab
    /// browsing the table list, and such a tab is never one of the former
    /// participants a narrower, participants-only push would reach —
    /// without this, it wouldn't learn a table just freed up (or
    /// disappeared entirely, once GC'd) until it happened to send a
    /// request of its own.
    func sweepAndPush(now : Int) : async* () {
      // Snapshot the CURRENT tables — `Table<S, M>`'s own `var phase`
      // makes each one a genuine mutable reference, so after
      // `Registry.sweep` mutates (and possibly GCs) them below, this
      // snapshot's own entries still read whatever the sweep just did to
      // them, even for one removed from `registry.tables` itself in the
      // meantime.
      let snapshot = Map.toArray(registry.tables);
      registry.sweep(now);
      var anyTableFreedUp = false;
      for ((_, t) in snapshot.values()) {
        switch (t.phase) {
          case (#empty) anyTableFreedUp := true; // this one just timed out
          case (_) {}; // still occupied — nothing timed out for it this round
        };
      };
      if (not anyTableFreedUp) return; // nothing to tell anyone about
      for (sid in Map.keys(hub.bySid)) {
        await* pushStatus(now, sid, null);
      };
    };

    {
      ws = IcWebSocketCdk.IcWebSocket(wsState, wsParams, handlers);
      sweep = sweepAndPush;
    };
  };
};
