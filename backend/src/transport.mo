/// duel-game-core/transport — the REQUIRED client transport: one update
/// method for requests, one query polled for changes. The only way a
/// client mutates game state: none of `Registry`'s mutating operations is
/// a plain Candid method (two independent update calls have no guaranteed
/// relative order). `status` stays a plain `query`.
///
/// Every legal `sid` is principal-bound: `PRINCIPAL_SID_PREFIX` (`"ii:"`,
/// Internet Identity) or `ANON_SID_PREFIX` (`"an:"`, a persisted local
/// keypair), both `sidFor(prefix, p)`; anything else is `#unauthorized`.
/// A request reuses `Registry`'s operations with `Time.now()`, replies
/// with the caller's fresh `SessionStatus`, and bumps the `rev` of every
/// other session whose status changed; `duel_poll` hands a session its
/// status whenever its `rev` moved. Nothing is queued. A `#bye` drives an
/// implicit `Registry.leave`; silence only ends presence.
///
/// Wiring — see `../README.md`, "Transport":
///
///   transient let hub : Transport.Hub = Transport.createHub();
///   transient let attached = Transport.attach<system, Rules.State, Rules.Action>(
///     Rules.spec(), registry, hub,
///     { encode = func(m) = to_candid (m); decode = func(b) = from_candid (b) },
///     null, null, null, // onSettled, onGameEnded, onGameStarted
///   );
///   include ActorMixin<system>(attached.endpoint, attached.sweep);

import Int "mo:core/Int";
import Map "mo:core/Map";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Time "mo:core/Time";
import Timer "mo:core/Timer";

import TP "./lib";
import Registry "./registry";

module {

  /// Mirrors `Registry`'s operations plus `#status` (a resync, the
  /// first request of a connection, and the heartbeat) and `#bye` (the
  /// cooperative goodbye). `#submit`/`#leave`/`#reset`/`#claimWin` carry
  /// the `gen` (and `#submit` the `turn`) the client last observed, so a
  /// stale replay is rejected as `#stale`.
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
    #bye;
  };

  /// One message type for both directions. `epoch` is a token the client
  /// picks per connection (page load or resume), so a late `#bye` from a
  /// superseded one is ignored. `rev` orders views: a client drops any
  /// view not newer than the last it applied.
  public type Msg<S, M> = {
    #req : { sid : TP.SessionId; epoch : Nat64; req : Request<M> };
    #view : { rev : Nat; view : TP.SessionStatus<S> };
    #err : { err : TP.Err };
  };

  /// `#unknown`: no link for this session (an upgrade, a pruned or
  /// departed one) — the client sends `#status` again.
  public type PollResult = { #unchanged; #changed : Blob; #unknown };

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

  /// Whether `sid` is legal for a caller authenticated as `p`; never for
  /// the anonymous principal.
  public func isAuthorizedSid(sid : TP.SessionId, p : Principal.Principal) : Bool {
    if (p.isAnonymous()) return false;
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

  /// How long after its last request a session still counts as present.
  /// The client sends a `#status` after 120s without any other request.
  public let PRESENCE_TTL_NS : Int = 180_000_000_000;

  /// One connected session: `rev` changes whenever its status may have,
  /// `lastSeen` is its last request, `epoch` its current connection.
  public type Link = { var rev : Nat; var lastSeen : Int; var epoch : Nat64 };

  /// `nextRev` is seeded from the clock by `attach`, so revisions keep
  /// increasing across an upgrade that wipes this transient state.
  public type Hub = {
    links : Map.Map<TP.SessionId, Link>;
    var nextRev : Nat;
  };

  public func createHub() : Hub = {
    links = Map.empty<TP.SessionId, Link>();
    var nextRev = 0;
  };

  func freshRev(hub : Hub) : Nat {
    hub.nextRev += 1;
    hub.nextRev;
  };

  /// Records a request from `sid`, creating its link on first contact.
  public func seen(hub : Hub, sid : TP.SessionId, now : Int, epoch : Nat64) : Link {
    switch (hub.links.get(sid)) {
      case (?l) {
        l.lastSeen := now;
        l.epoch := epoch;
        l;
      };
      case null {
        let l : Link = {
          var rev = freshRev(hub);
          var lastSeen = now;
          var epoch;
        };
        hub.links.add(sid, l);
        l;
      };
    };
  };

  /// Marks `sid`'s status as changed; a no-op for a session with no link.
  public func touch(hub : Hub, sid : TP.SessionId) {
    switch (hub.links.get(sid)) {
      case (?l) l.rev := freshRev(hub);
      case null {};
    };
  };

  public func revOf(hub : Hub, sid : TP.SessionId) : Nat {
    switch (hub.links.get(sid)) {
      case (?l) l.rev;
      case null 0;
    };
  };

  public func isPresent(hub : Hub, sid : TP.SessionId, now : Int) : Bool {
    switch (hub.links.get(sid)) {
      case (?l) now - l.lastSeen < PRESENCE_TTL_NS;
      case null false;
    };
  };

  /// Whether a `#bye` taken at `at` under `epoch` still stands: no later
  /// request, no newer connection.
  public func byeStands(hub : Hub, sid : TP.SessionId, epoch : Nat64, at : Int) : Bool {
    switch (hub.links.get(sid)) {
      case (?l) l.epoch == epoch and l.lastSeen <= at;
      case null false;
    };
  };

  /// Drops every link that stopped being present.
  public func prune(hub : Hub, now : Int) {
    for ((sid, l) in hub.links.toArray().values()) {
      if (now - l.lastSeen >= PRESENCE_TTL_NS) hub.links.remove(sid);
    };
  };

  /// What `actor_mixin.mo` exposes as `duel_request`/`duel_poll`.
  public type Endpoint = {
    request : (Principal, Blob) -> async* Blob;
    poll : (Principal, TP.SessionId, Nat) -> PollResult;
  };

  /// `sweep` runs `Registry.sweep`, marks every linked session changed
  /// when something was evicted (a bare `registry.sweep` would leave a
  /// polling tab stale), and prunes links that stopped being present.
  /// `afterMutation(now, sid, id, broadcastLobby)` is the fan-out a
  /// request runs, exposed so `canister_players.mo` reuses it for a
  /// canister-driven mutation.
  public type Attached = {
    endpoint : Endpoint;
    sweep : (Int) -> async* ();
    afterMutation : (Int, TP.SessionId, ?TP.TableId, Bool) -> async* ();
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

  /// Grace before a `#bye` counts as a genuine departure: a reload's new
  /// page may land its first request just after the old page's goodbye.
  let BYE_GRACE : Time.Duration = #seconds(3);

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

  /// Binds the transport to one game's `Spec`/`Registry`. Needs
  /// `<system>` because `#bye` schedules a deferred check.
  public func attach<system, S, M>(
    spec : TP.Spec<S, M>,
    registry : TP.Registry<S, M>,
    hub : Hub,
    codec : Codec<S, M>,
    onSettled : ?OnSettled,
    onGameEnded : ?OnGameEnded<S>,
    onGameStarted : ?OnGameStarted,
  ) : Attached {
    if (hub.nextRev == 0) hub.nextRev := Int.abs(Time.now());

    func viewOf(now : Int, sid : TP.SessionId) : Blob {
      codec.encode(#view({ rev = revOf(hub, sid); view = registry.status(spec, now, sid) }));
    };

    /// Marks changed: `sid`, the table's other occupants — including a
    /// rematch reservation's partner — and, with `broadcastLobby`, every
    /// other linked session not at a table. Then `onSettled`, the only
    /// await.
    func afterMutation(now : Int, sid : TP.SessionId, id : ?TP.TableId, broadcastLobby : Bool) : async* () {
      touch(hub, sid);
      switch (id) {
        case null {};
        case (?id) switch (registry.tables.get(id)) {
          case null {};
          case (?t) {
            switch (t.phase) {
              case (#empty) {};
              case (#staging st) {
                touch(hub, st.session);
                switch (st.reservedFor) {
                  case (?partner) touch(hub, partner);
                  case null {};
                };
              };
              case (#active g) {
                touch(hub, g.p1);
                touch(hub, g.p2);
                if (isFreshMatch(g, now)) {
                  switch (onGameStarted) {
                    case (?f) f(id, g.p1, g.p2);
                    case null {};
                  };
                };
              };
              case (#debrief d) {
                touch(hub, d.p1);
                touch(hub, d.p2);
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
        for (other in hub.links.keys()) {
          if (other != sid) {
            switch (registry.bySession.get(other)) {
              case null touch(hub, other);
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

    /// The table's own current `gen` — this leave is driven by a goodbye,
    /// not by a stamped client request, so it must always go through.
    func genOfSessionsTable(sid : TP.SessionId) : ?Nat = switch (registry.bySession.get(sid)) {
      case null null;
      case (?id) switch (registry.tables.get(id)) {
        case null null;
        case (?t) ?t.gen;
      };
    };

    /// Two `leave`s, each re-resolving the current table: the first does
    /// whatever `leave` means in the current phase (an abort does not
    /// auto-ack the leaver), the second acks that debrief, since a
    /// departed session will never click "leave" again.
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

    /// The deferred departure; backs off if the session came back. Also
    /// frees a table whose partner is no longer present.
    func finishBye(sid : TP.SessionId, epoch : Nat64, at : Int) : async* () {
      if (not byeStands(hub, sid, epoch, at)) return;
      hub.links.remove(sid);
      let now = Time.now();
      let priorId = registry.bySession.get(sid);
      disconnectSession(now, sid);
      switch (priorId) {
        case null {};
        case (?id) switch (registry.tables.get(id)) {
          case null {};
          case (?t) switch (t.phase) {
            case (#debrief d) {
              if (d.p1 == sid or d.p2 == sid) {
                let partner = if (d.p1 == sid) d.p2 else d.p1;
                if (not isPresent(hub, partner, now)) disconnectSession(now, partner);
              };
            };
            case (_) {};
          };
        };
      };
      await* afterMutation(now, sid, priorId, true);
    };

    /// See `../README.md`, "Disappearance handling". Not counted as a
    /// request: a goodbye must not refresh presence or adopt its epoch.
    func bye<system>(sid : TP.SessionId, epoch : Nat64) {
      switch (hub.links.get(sid)) {
        case (?l) {
          if (l.epoch != epoch) return;
          let at = l.lastSeen;
          ignore Timer.setTimer<system>(
            BYE_GRACE,
            func() : async () { await* finishBye(sid, epoch, at) },
          );
        };
        case null {};
      };
    };

    func request(caller : Principal, msg : Blob) : async* Blob {
      let ?#req({ sid; epoch; req }) = codec.decode(msg) else {
        return codec.encode(#err({ err = #unauthorized }));
      };
      if (not isAuthorizedSid(sid, caller)) {
        return codec.encode(#err({ err = #unauthorized }));
      };
      let now = Time.now();
      switch (req) {
        case (#bye) {
          bye<system>(sid, epoch);
          return viewOf(now, sid);
        };
        case (_) {};
      };
      ignore seen(hub, sid, now, epoch);
      // Captured before the request runs: submit/rematch/leave/reset/
      // claimWin/ackEnded return no `TableId` of their own.
      let priorId = registry.bySession.get(sid);
      let res : TP.Res<(?TP.TableId, Bool)> = switch (req) {
        case (#status or #bye) return viewOf(now, sid);
        case (#createTable { seat; visibility; variant }) {
          switch (registry.createTable(spec, now, sid, seat, visibility, variant)) {
            case (#ok id) #ok(?id, true);
            case (#err e) #err e;
          };
        };
        case (#joinTable { id; seat; code }) {
          switch (registry.joinTable(spec, now, sid, id, seat, code)) {
            case (#ok _) #ok(?id, true);
            case (#err e) #err e;
          };
        };
        case (#submit { gen; turn; move }) {
          switch (registry.submit(spec, now, sid, gen, turn, move)) {
            case (#ok _) #ok(priorId, false);
            case (#err e) #err e;
          };
        };
        case (#claimWin { gen }) {
          switch (registry.claimWin(spec, now, sid, gen)) {
            case (#ok _) #ok(priorId, false);
            case (#err e) #err e;
          };
        };
        case (#rematch) {
          switch (registry.rematch(spec, now, sid)) {
            case (#ok _) #ok(priorId, rematchOpenedLobby(registry, priorId));
            case (#err e) #err e;
          };
        };
        case (#leave { gen }) {
          switch (registry.leave(now, sid, gen)) {
            case (#ok _) #ok(priorId, true);
            case (#err e) #err e;
          };
        };
        case (#reset { gen }) {
          switch (registry.reset(now, sid, gen)) {
            case (#ok _) #ok(priorId, true);
            case (#err e) #err e;
          };
        };
        case (#ackEnded) {
          registry.ackEnded(sid);
          #ok(priorId, true);
        };
      };
      switch (res) {
        case (#err err) codec.encode(#err({ err }));
        case (#ok(id, broadcastLobby)) {
          await* afterMutation(now, sid, id, broadcastLobby);
          // `onSettled` may have awaited a canister player's move.
          viewOf(Time.now(), sid);
        };
      };
    };

    func poll(caller : Principal, sid : TP.SessionId, rev : Nat) : PollResult {
      if (not isAuthorizedSid(sid, caller)) return #unknown;
      switch (hub.links.get(sid)) {
        case null #unknown;
        case (?l) {
          if (l.rev == rev) #unchanged else #changed(viewOf(Time.now(), sid));
        };
      };
    };

    /// A present session keeps its waiting staging alive.
    func sweep(now : Int) : async* () {
      let snapshot = registry.tables.toArray();
      registry.sweep(now, func(sid) = isPresent(hub, sid, now));
      prune(hub, now);
      var anyTableFreedUp = false;
      for ((_, t) in snapshot.values()) {
        switch (t.phase) {
          case (#empty) anyTableFreedUp := true;
          case (_) {};
        };
      };
      if (not anyTableFreedUp) return;
      for (sid in hub.links.keys()) {
        touch(hub, sid);
      };
    };

    { endpoint = { request; poll }; sweep; afterMutation };
  };
};
