/// duel-game-core/transport — the REQUIRED client transport: one update
/// method for requests, one query polled for changes, both fully typed. The only way a
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
/// status whenever its `rev` moved. Nothing is queued. Silence only ends
/// presence; departure is the engine's own business.
///
/// This is a library, not a mixin (a mixin cannot take type parameters):
/// the host declares the two methods with its own `State`/`Action` and
/// passes them through. Wiring — see `../README.md`, "Transport":
///
///   transient let hub : Transport.Hub = Transport.createHub();
///   transient let attached = Transport.attach<Rules.State, Rules.Action>(
///     Rules.spec(), registry, hub,
///     null, null, null, // onSettled, onGameEnded, onGameStarted
///   );
///   Transport.startSweeping<system>(attached.sweep);
///
///   public shared ({ caller }) func duel_request(sid : Text, req : Transport.DuelRequest<Rules.Action>) : async Transport.Reply<Rules.State> {
///     attached.reply(sid, await* attached.request(caller, sid, req));
///   };
///
///   public shared query ({ caller }) func duel_poll(sid : Text, rev : Nat) : async Transport.PollResult<Rules.State> {
///     attached.poll(caller, sid, rev);
///   };

import Array "mo:core/Array";
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
  /// first request of a connection, and the heartbeat). `#submit`/
  /// `#leave`/`#reset`/`#claimWin` carry the `gen` (and `#submit` the
  /// `turn`) the client last observed, so a stale replay is rejected as
  /// `#stale`.
  public type DuelRequest<M> = {
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

  /// The caller's fresh status. `rev` orders views: a client drops any
  /// view not newer than the last it applied.
  public type Snapshot<S> = { rev : Nat; view : TP.SessionStatus<S> };

  /// What `duel_request` returns.
  public type Reply<S> = { #view : Snapshot<S>; #err : TP.Err };

  /// What `duel_poll` returns. `#unknown`: no link for this session (an
  /// upgrade, a pruned or departed one) — the client sends `#status`
  /// again.
  public type PollResult<S> = { #unchanged; #changed : Snapshot<S>; #unknown };

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
  /// `lastSeen` is its last request.
  public type Link = { var rev : Nat; var lastSeen : Int };

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
  public func seen(hub : Hub, sid : TP.SessionId, now : Int) : Link {
    switch (hub.links.get(sid)) {
      case (?l) {
        l.lastSeen := now;
        l;
      };
      case null {
        let l : Link = {
          var rev = freshRev(hub);
          var lastSeen = now;
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

  /// Drops every link that stopped being present.
  public func prune(hub : Hub, now : Int) {
    for ((sid, l) in hub.links.toArray().values()) {
      if (now - l.lastSeen >= PRESENCE_TTL_NS) hub.links.remove(sid);
    };
  };

  /// `request` runs a request and returns its error, if any; `reply`
  /// turns that into `duel_request`'s reply (two steps because an
  /// `async*` result must be a shared type, which the generic `Reply<S>`
  /// is not). `poll` is `duel_poll`. `sweep` runs `Registry.sweep`, marks every linked session changed
  /// when something was evicted (a bare `registry.sweep` would leave a
  /// polling tab stale), and prunes links that stopped being present.
  /// `afterMutation(now, sid, id, broadcastLobby)` is the fan-out a
  /// request runs, exposed so `canister_players.mo` reuses it for a
  /// canister-driven mutation.
  public type Attached<S, M> = {
    request : (Principal, TP.SessionId, DuelRequest<M>) -> async* ?TP.Err;
    reply : (TP.SessionId, ?TP.Err) -> Reply<S>;
    poll : (Principal, TP.SessionId, Nat) -> PollResult<S>;
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

  /// Binds the transport to one game's `Spec`/`Registry`.
  public func attach<S, M>(
    spec : TP.Spec<S, M>,
    registry : TP.Registry<S, M>,
    hub : Hub,
    onSettled : ?OnSettled,
    onGameEnded : ?OnGameEnded<S>,
    onGameStarted : ?OnGameStarted,
  ) : Attached<S, M> {
    if (hub.nextRev == 0) hub.nextRev := Int.abs(Time.now());

    func viewOf(now : Int, sid : TP.SessionId) : Snapshot<S> {
      { rev = revOf(hub, sid); view = registry.status(spec, now, sid) };
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

    func request(caller : Principal, sid : TP.SessionId, req : DuelRequest<M>) : async* ?TP.Err {
      if (not isAuthorizedSid(sid, caller)) return ?#unauthorized;
      let now = Time.now();
      ignore seen(hub, sid, now);
      // Captured before the request runs: submit/rematch/leave/reset/
      // claimWin/ackEnded return no `TableId` of their own.
      let priorId = registry.bySession.get(sid);
      let res : TP.Res<(?TP.TableId, Bool)> = switch (req) {
        case (#status) return null;
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
        case (#err err) ?err;
        case (#ok(id, broadcastLobby)) {
          await* afterMutation(now, sid, id, broadcastLobby);
          null;
        };
      };
    };

    // Read at `Time.now()`: `onSettled` may have awaited a canister
    // player's move.
    func reply(sid : TP.SessionId, err : ?TP.Err) : Reply<S> {
      switch (err) {
        case (?e) #err e;
        case null #view(viewOf(Time.now(), sid));
      };
    };

    func poll(caller : Principal, sid : TP.SessionId, rev : Nat) : PollResult<S> {
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
      func isLive(t : TP.Table<S, M>) : Bool = switch (t.phase) {
        case (#empty) false;
        case (_) true;
      };
      let live = registry.tables.toArray().filter(func((_, t)) = isLive(t));
      registry.sweep(now, func(sid) = isPresent(hub, sid, now));
      prune(hub, now);
      var anyTableFreedUp = false;
      for ((id, _) in live.values()) {
        switch (registry.tables.get(id)) {
          case (?t) if (not isLive(t)) anyTableFreedUp := true;
          case null anyTableFreedUp := true;
        };
      };
      if (not anyTableFreedUp) return;
      for (sid in hub.links.keys()) {
        touch(hub, sid);
      };
    };

    { request; reply; poll; sweep; afterMutation };
  };

  /// Runs `sweep` (`Attached.sweep`, or a host's combination with
  /// `CanisterPlayers.Attached.sweep`) every five minutes. Call once from
  /// the actor body.
  public func startSweeping<system>(sweep : (Int) -> async* ()) {
    ignore Timer.recurringTimer<system>(
      #seconds(300),
      func() : async () { await* sweep(Time.now()) },
    );
  };
};
