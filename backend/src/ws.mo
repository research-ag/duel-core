/// duel-game-core/ws — the REQUIRED real-time push transport, built on
/// `ic-websocket-cdk`. The only way a client mutates game state: none of
/// `Registry`'s mutating operations is a plain Candid method (two
/// independent update calls have no guaranteed relative order). `status`
/// stays a plain `query`. Kept separate from `lib.mo` to confine the CDK
/// dependency, not because wiring it is optional.
///
/// `Hub` bridges the engine's `SessionId` to the connection's principal.
/// Every legal `sid` is principal-bound: `PRINCIPAL_SID_PREFIX` (`"ii:"`,
/// Internet Identity) or `ANON_SID_PREFIX` (`"an:"`, a persisted local
/// keypair), both `sidFor(prefix, p)`; `onMessage` rejects anything else
/// with `#unauthorized`. Every request reuses `Registry`'s operations with
/// `Time.now()` and then pushes a fresh `SessionStatus` to whoever needs
/// it. `ws_close` (cooperative or the CDK's 60s keep-alive timeout, giving
/// a 60–180s floor) drives an implicit `Registry.leave`.
///
/// Wiring — see `../README.md`, "Real-time push":
///
///   transient let hub : Ws.Hub = Ws.createHub();
///   transient let attached = Ws.attach<system, Rules.State, Rules.Action>(
///     Rules.spec(), registry, hub,
///     { encode = func(m) = to_candid (m); decode = func(b) = from_candid (b) },
///     IcWebSocketCdkTypes.WsInitParams(null, ?120_000),
///     null, null, null, // onSettled, onGameEnded, onGameStarted
///   );
///   attached.ws.init<system>();
///   include ActorMixin<system>(attached.ws, attached.sweep);
///
/// `ws_message`'s second Candid parameter is a plain `?Blob` — the CDK
/// ignores its value; the real message arrives in `args.content`.
/// `ws_open`'s second parameter is also a `?Blob`, but a real one: an
/// encoded `Msg` handled by `onMessage` inside the same update call, so a
/// client's first request (its `#status`) costs no round trip of its own.

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

  /// Mirrors `Registry`'s operations plus an explicit `#status` resync.
  /// `#submit`/`#leave`/`#reset`/`#claimWin` carry the `gen` (and
  /// `#submit` the `turn`) the client last observed, so a stale replay is
  /// rejected as `#stale`.
  public type Request<M> = {
    #createTable : {
      seat : TP.Seat;
      visibility : TP.TableVisibility;
      variant : Text;
    };
    #joinTable : { id : TP.TableId; seat : TP.Seat; code : ?Text };
    #submit : { gen : Nat; turn : Nat; move : M };
    #rematch;
    #leave : { gen : Nat };
    #reset : { gen : Nat };
    #claimWin : { gen : Nat };
    #ackEnded;
    #status;
  };

  /// One message type for both directions (the CDK reads it off
  /// `ws_message`'s second parameter). `reqId` is a client-chosen token
  /// echoed back only on that session's own reply; a push to anyone else
  /// carries `null`, so a client can tell its reply from an unsolicited
  /// broadcast caused by the other seat acting.
  public type Msg<S, M> = {
    #req : { sid : TP.SessionId; req : Request<M>; reqId : ?Nat64 };
    #view : { reqId : ?Nat64; view : TP.SessionStatus<S> };
    #err : { reqId : ?Nat64; err : TP.Err };
  };

  /// Built where `S`/`M` are concrete, via `to_candid`/`from_candid`.
  public type Codec<S, M> = {
    encode : (Msg<S, M>) -> Blob;
    decode : (Blob) -> ?Msg<S, M>;
  };

  public let PRINCIPAL_SID_PREFIX : Text = "ii:";

  public let ANON_SID_PREFIX : Text = "an:";

  public func sidFor(prefix : Text, p : Principal.Principal) : TP.SessionId {
    prefix # p.toText();
  };

  public func sidForPrincipal(p : Principal.Principal) : TP.SessionId {
    sidFor(PRINCIPAL_SID_PREFIX, p);
  };

  /// Whether `sid` is legal for a connection authenticated as `p`.
  public func isAuthorizedSid(sid : TP.SessionId, p : Principal.Principal) : Bool {
    if (sid.startsWith(#text PRINCIPAL_SID_PREFIX)) {
      return sid.equal(sidFor(PRINCIPAL_SID_PREFIX, p));
    };
    if (sid.startsWith(#text ANON_SID_PREFIX)) {
      return sid.equal(sidFor(ANON_SID_PREFIX, p));
    };
    false;
  };

  /// Stable per-player key for a leaderboard: strips `ii:`/`an:` down to
  /// the principal text. Any other sid (a per-table `cp:` session) is
  /// returned unchanged — a host wiring canister players special-cases
  /// `CanisterPlayers.leaderboardKeyOfSession` first.
  public func playerKey(sid : TP.SessionId) : Text {
    if (sid.startsWith(#text PRINCIPAL_SID_PREFIX)) {
      return sid.trimStart(#text PRINCIPAL_SID_PREFIX);
    };
    if (sid.startsWith(#text ANON_SID_PREFIX)) {
      return sid.trimStart(#text ANON_SID_PREFIX);
    };
    sid;
  };

  /// sid <-> principal bridge. `generation` is bumped by every `remember`
  /// (even under an unchanged principal — a same-tab reconnect) so a stale
  /// close for a superseded connection can be told apart from a genuine
  /// departure; see `onClose`. Pruned in `finishClose`.
  public type Hub = {
    var bySid : Map.Map<TP.SessionId, Principal.Principal>;
    var byPrincipal : Map.Map<Principal.Principal, TP.SessionId>;
    var generation : Map.Map<TP.SessionId, Nat>;
  };

  public func createHub() : Hub = {
    var bySid = Map.empty<TP.SessionId, Principal.Principal>();
    var byPrincipal = Map.empty<Principal.Principal, TP.SessionId>();
    var generation = Map.empty<TP.SessionId, Nat>();
  };

  public func generationOf(hub : Hub, sid : TP.SessionId) : Nat {
    switch (hub.generation.get(sid)) {
      case (?g) g;
      case null 0;
    };
  };

  /// Binds `sid` to `p`, scrubbing both the old principal's `byPrincipal`
  /// entry and the same principal's old sid (a "new sid" swap on a live
  /// connection would otherwise leave a phantom browsing session that
  /// `broadcastLobby` pushes stale status to).
  public func remember(hub : Hub, sid : TP.SessionId, p : Principal.Principal) {
    switch (hub.bySid.get(sid)) {
      case (?oldP) {
        if (oldP.notEqual(p)) {
          hub.byPrincipal.remove(oldP);
        };
      };
      case null {};
    };
    switch (hub.byPrincipal.get(p)) {
      case (?oldSid) {
        if (oldSid.notEqual(sid)) {
          hub.bySid.remove(oldSid);
        };
      };
      case null {};
    };
    hub.bySid.add(sid, p);
    hub.byPrincipal.add(p, sid);
    hub.generation.add(sid, generationOf(hub, sid) + 1);
  };

  /// Un-binds `p`, clearing `bySid[sid]` only if `p` is still that
  /// session's current principal — a belated close for a superseded
  /// connection must not erase a live registration (a real bug: it
  /// aborted a game two connected players were mid-round on). The
  /// vendored CDK's `remove_client` has the matching guard one layer down;
  /// both are needed.
  public func forget(hub : Hub, p : Principal.Principal) {
    switch (hub.byPrincipal.get(p)) {
      case null {};
      case (?sid) {
        hub.byPrincipal.remove(p);
        switch (hub.bySid.get(sid)) {
          case (?curP) {
            if (curP.equal(p)) {
              hub.bySid.remove(sid);
            };
          };
          case null {};
        };
      };
    };
  };

  /// `sweep` runs `Registry.sweep` AND pushes to every connected session
  /// when something was evicted (a bare `registry.sweep` would leave a
  /// still-connected tab stale). `afterMutation` is the push fan-out
  /// `onMessage` runs, exposed so `canister_players.mo` reuses it for a
  /// canister-driven mutation (`reqId` `null`; `pushTo` is a no-op for a
  /// session that is not WS-connected).
  public type Attached = {
    ws : IcWebSocketCdk.IcWebSocket;
    sweep : (Int) -> async* ();
    afterMutation : (Int, TP.SessionId, ?Nat64, ?TP.TableId, Bool) -> async* ();
  };

  /// Runs after `afterMutation` for every successful mutation that touched
  /// a table — wired to `canister_players.mo`'s `settle`.
  public type OnSettled = (Int, TP.TableId) -> async* ();

  /// Fires once per game ending: the mutating request left a `#debrief`
  /// freshly created this call (`Debrief.since == now`). Synchronous. Never
  /// fires for an idle-sweep eviction (no `Verdict` to score).
  public type OnGameEnded<S> = (TP.TableId, TP.SessionId, TP.SessionId, TP.Debrief<S>) -> ();

  /// Fires once per match, when a table freshly enters `#active` — see
  /// `isFreshMatch`. Synchronous. For a host that needs real elapsed time.
  public type OnGameStarted = (TP.TableId, TP.SessionId, TP.SessionId) -> ();

  // Every push helper below is `async*`: only `pushTo`'s `IcWebSocketCdk.send`
  // is a genuine await; plain `async` wrappers would each be their own
  // message with its own commit point. Don't widen them back.

  /// Grace before a close counts as a genuine departure — longer than a
  /// client poll tick, far shorter than the CDK's keep-alive floor.
  let CLOSE_GRACE : Time.Duration = #seconds(3);

  /// Whether a just-succeeded `#rematch` opened an unreserved staging
  /// (the partner had already acked), which every browsing session must
  /// hear about — otherwise a lobby tab shows "No open tables" for the
  /// whole idle window. Pulled out of `attach()` so it is unit-testable.
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

  /// `Active` has no `since`, so a fresh match is the one field
  /// combination only true at creation: turn 0, no pending move, touched
  /// this call.
  public func isFreshMatch<S, M>(g : TP.Active<S, M>, now : Int) : Bool {
    let noPending = switch (g.pending1, g.pending2) {
      case (null, null) true;
      case (_, _) false;
    };
    g.turn == 0 and noPending and g.lastActivity == now;
  };

  /// Builds the CDK `IcWebSocket` bound to one game's `Spec`/`Registry`.
  /// Needs `<system>` because `onClose` schedules a deferred check.
  public func attach<system, S, M>(
    spec : TP.Spec<S, M>,
    registry : TP.Registry<S, M>,
    hub : Hub,
    codec : Codec<S, M>,
    wsParams : IcWebSocketCdkTypes.WsInitParams,
    onSettled : ?OnSettled,
    onGameEnded : ?OnGameEnded<S>,
    onGameStarted : ?OnGameStarted,
  ) : Attached {
    let wsState = IcWebSocketCdkState.IcWebSocketState(wsParams);

    func pushTo(sid : TP.SessionId, msg : Msg<S, M>) : async* () {
      switch (hub.bySid.get(sid)) {
        case null {};
        case (?p) {
          ignore await* IcWebSocketCdk.send(wsState, p, codec.encode(msg));
        };
      };
    };

    func pushStatus(now : Int, sid : TP.SessionId, reqId : ?Nat64) : async* () {
      await* pushTo(sid, #view({ reqId; view = registry.status(spec, now, sid) }));
    };

    /// `sid` gets its own status (with `reqId`); the table's other
    /// occupants — including a rematch reservation's partner — get an
    /// unsolicited one; with `broadcastLobby`, so does every other
    /// connected session not at a table. Then `onSettled`.
    func afterMutation(now : Int, sid : TP.SessionId, reqId : ?Nat64, id : ?TP.TableId, broadcastLobby : Bool) : async* () {
      await* pushStatus(now, sid, reqId);
      switch (id) {
        case null {};
        case (?id) switch (registry.tables.get(id)) {
          case null {};
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
                if (isFreshMatch(g, now)) {
                  switch (onGameStarted) {
                    case (?f) f(id, g.p1, g.p2);
                    case null {};
                  };
                };
              };
              case (#debrief d) {
                if (d.p1 != sid) { await* pushStatus(now, d.p1, null) };
                if (d.p2 != sid) { await* pushStatus(now, d.p2, null) };
                if (d.since == now) {
                  switch (onGameEnded) {
                    case (?f) f(id, d.p1, d.p2, d);
                    case null {};
                  };
                };
              };
            };
          };
        };
      };
      if (broadcastLobby) {
        for (other in hub.bySid.keys()) {
          if (other != sid) {
            switch (registry.bySession.get(other)) {
              case null { await* pushStatus(now, other, null) };
              case (?_) {};
            };
          };
        };
      };
      switch (onSettled, id) {
        case (?f, ?id) await* f(now, id);
        case (_, _) {};
      };
    };

    func onMessage(
      args : IcWebSocketCdkTypes.OnMessageCallbackArgs
    ) : async* () {
      switch (codec.decode(args.message)) {
        case (?#req { sid; req; reqId }) {
          if (not isAuthorizedSid(sid, args.client_principal)) {
            // Sent straight to the connection's principal — `pushTo` would
            // resolve via the very mapping this caller failed to prove.
            ignore await* IcWebSocketCdk.send(
              wsState,
              args.client_principal,
              codec.encode(#err({ reqId; err = #unauthorized })),
            );
            return;
          };
          remember(hub, sid, args.client_principal);
          let now = Time.now();
          // Captured before the request runs: submit/rematch/leave/reset/
          // claimWin/ackEnded return no `TableId` of their own.
          let priorId = registry.bySession.get(sid);
          switch (req) {
            case (#status) { await* pushStatus(now, sid, reqId) };
            case (#createTable { seat; visibility; variant }) {
              switch (registry.createTable(spec, now, sid, seat, visibility, variant)) {
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
              switch (registry.claimWin(spec, now, sid, gen)) {
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
        case (_) {}; // malformed, or a canister->client variant — drop it
      };
    };

    /// The table's own current `gen` — this leave is driven by the socket
    /// closing, not by a client request, so it must always go through.
    func genOfSessionsTable(sid : TP.SessionId) : ?Nat = switch (registry.bySession.get(sid)) {
      case null null;
      case (?id) switch (registry.tables.get(id)) {
        case null null;
        case (?t) ?t.gen;
      };
    };

    /// Two `leave`s, each re-resolving the current table: the first does
    /// whatever `leave` means in the current phase (an abort does not
    /// auto-ack the leaver), the second acks that debrief, since a closed
    /// session will never click "leave" again.
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

    /// The deferred disconnect. If a reconnect bumped `generation` since
    /// the close event, back off. Also frees a table whose partner is also
    /// disconnected, and prunes the generation entry once the suspension
    /// in `afterMutation` has had its chance to be raced.
    func finishClose(s : TP.SessionId, seenGen : Nat) : async* () {
      if (generationOf(hub, s) != seenGen) return;
      let now = Time.now();
      let priorId = registry.bySession.get(s);
      disconnectSession(now, s);
      switch (priorId) {
        case null {};
        case (?id) switch (registry.tables.get(id)) {
          case null {};
          case (?t) switch (t.phase) {
            case (#debrief d) {
              if (d.p1 == s or d.p2 == s) {
                let partner = if (d.p1 == s) d.p2 else d.p1;
                switch (hub.bySid.get(partner)) {
                  case null disconnectSession(now, partner);
                  case (?_) {};
                };
              };
            };
            case (_) {};
          };
        };
      };
      await* afterMutation(now, s, null, priorId, true);
      if (generationOf(hub, s) == seenGen) {
        hub.generation.remove(s);
      };
    };

    /// `OnCloseCallbackArgs` carries only the principal, and a same-tab
    /// reconnect reuses one principal, so a stale close for the OLD
    /// connection can arrive after the NEW one opened but before its first
    /// `#req` re-registers it. Deferring by `CLOSE_GRACE` and re-checking
    /// `generation` is what tells the two apart.
    func onClose(args : IcWebSocketCdkTypes.OnCloseCallbackArgs) : async* () {
      let p = args.client_principal;
      let sid = hub.byPrincipal.get(p);
      forget(hub, p);
      switch (sid) {
        case null {};
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

    /// Pushes to EVERY connected session (a browsing tab is never a
    /// former participant) but only if the sweep actually freed a table.
    func sweepAndPush(now : Int) : async* () {
      let snapshot = registry.tables.toArray();
      registry.sweep(now);
      var anyTableFreedUp = false;
      for ((_, t) in snapshot.values()) {
        switch (t.phase) {
          case (#empty) anyTableFreedUp := true;
          case (_) {};
        };
      };
      if (not anyTableFreedUp) return;
      for (sid in hub.bySid.keys()) {
        await* pushStatus(now, sid, null);
      };
    };

    {
      ws = IcWebSocketCdk.IcWebSocket(wsState, wsParams, handlers);
      sweep = sweepAndPush;
      afterMutation;
    };
  };
};
