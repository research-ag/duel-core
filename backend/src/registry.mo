import Array "mo:core/Array";
import Int "mo:core/Int";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Option "mo:core/Option";
import Text "mo:core/Text";

import Table "./table";
import T "./types";

/// A multi-table extension of the single-`Table`: many
/// independent boards, each identified by a `TableId`, created and
/// discovered through one shared `Registry`. Every function here is a
/// thin router — it resolves which `Table` a call is actually about
/// (by `TableId`, for `createTable`/`joinTable`; by looking up the
/// caller's own current table otherwise) and delegates straight into
/// the matching operation above; no game state or legality is
/// reimplemented in this module. A host actor wires `Ws.attach` to a
/// `Registry` (see `../README.md`'s "Real-time push" section) instead
/// of a bare `Table` — that's the only thing that changes in how a
/// game gets plugged in; `Spec`'s `init`/`validate`/`resolve` don't
/// know or care how many tables exist.
///
/// A game that genuinely wants exactly one fixed board can still use
/// `create`/`join`/`submit`/... directly above — `Lobby` is built on
/// top of them, not a replacement for them.
module {

  public type Registry<S, M> = T.Registry<S, M>;

  public func new<S, M>(idleTimeoutNs : Int) : Registry<S, M> = {
    idleTimeoutNs;
    var tables = Map.empty<T.TableId, T.Table<S, M>>();
    var bySession = Map.empty<T.SessionId, T.TableId>();
    var tableIdNonce = 1;
  };

  // ────────────────────── internal helpers ──────────────────────────────

  /// Whether (and since when) a table would present an open seat to a
  /// generic, not-yet-seated visitor right now — the same outsider
  /// view `status` above already computes per phase, minus the
  /// per-session `unackedEnded` check (meaningless for a listing
  /// nobody has "asked" about yet). `null` = not currently joinable
  /// (occupied, or reserved/idle-but-not-yet-expired). This is what
  /// keeps an idle-abandoned table — in ANY phase — reachable through
  /// `listTables`, not just a table whose id a visitor already
  /// happens to know: without it, "no ghost lobbies" would silently
  /// stop applying to every table but the one you already have a link
  /// to.
  func openness<S, M>(t : T.Table<S, M>, now : Int) : ?{
    p1Open : Bool;
    p2Open : Bool;
    since : Int;
  } {
    switch (t.phase) {
      case (#empty) ?{ p1Open = true; p2Open = true; since = now };
      case (#staging st) {
        let ex = t.isExpired(st.since, now);
        if (Option.isSome(st.reservedFor) and not ex) { null } else {
          ?{
            p1Open = st.seat != #p1 or ex;
            p2Open = st.seat != #p2 or ex;
            since = st.since;
          };
        };
      };
      case (#active g) {
        if (t.isExpired(g.lastActivity, now)) {
          ?{ p1Open = true; p2Open = true; since = g.lastActivity };
        } else { null };
      };
      case (#debrief d) {
        if (t.isExpired(d.since, now)) {
          ?{ p1Open = true; p2Open = true; since = d.since };
        } else { null };
      };
    };
  };

  func waitingSecs(since : Int, now : Int) : Nat {
    let elapsed = now - since;
    if (elapsed <= 0) { 0 } else { elapsed.toNat() / 1_000_000_000 };
  };

  /// A table that's quiesced (`#empty`, and nobody is still owed an
  /// `#endedByOther` notice) carries no state worth keeping around —
  /// drop it from the registry so ids don't accumulate forever. Skipped
  /// otherwise: an `#empty` table can still owe an ack (see
  /// `noteEnded`'s own doc), and only that ack — not this GC — may
  /// clear it.
  func gcIfQuiesced<S, M>(reg : Registry<S, M>, id : T.TableId, t : T.Table<S, M>) {
    switch (t.phase) {
      case (#empty) {
        if (t.lastEnded.size() == 0) {
          reg.tables.remove(id);
        };
      };
      case (_) {};
    };
  };

  func alreadyAtATable<S, M>(reg : Registry<S, M>, session : T.SessionId) : Bool = Option.isSome(reg.bySession.get(session));

  /// Resolves `session`'s current table (if any) and runs `op` against
  /// it — the shared shape every routed mutating call below follows.
  func withTable<S, M, T>(
    reg : Registry<S, M>,
    session : T.SessionId,
    op : (T.Table<S, M>) -> T.Res<T>,
  ) : T.Res<T> {
    switch (reg.bySession.get(session)) {
      case null #err(#notSeated);
      case (?id) switch (reg.tables.get(id)) {
        case null #err(#notSeated); // stale mapping onto an already-GC'd table
        case (?t) op(t);
      };
    };
  };

  /// Clears `session`'s own table mapping after a successful `leave`/
  /// `reset` — see `leave`'s own doc below — and GCs that table if
  /// this was the last thing keeping it around.
  func returnToLobby<S, M>(reg : Registry<S, M>, session : T.SessionId) {
    switch (reg.bySession.get(session)) {
      case null {};
      case (?id) {
        reg.bySession.remove(session);
        switch (reg.tables.get(id)) {
          case (?t) gcIfQuiesced(reg, id, t);
          case null {};
        };
      };
    };
  };

  // ────────────────────── operations ─────────────────────────────────────

  public func listTables<S, M>(self : Registry<S, M>, now : Int) : [T.TableSummary] {
    let withSummaries = Map.filterMap<T.TableId, T.Table<S, M>, T.TableSummary>(
      self.tables,
      Nat.compare,
      func(id, t) {
        let protected = t.visibility != #open;
        if (protected) { null } else {
          switch (openness(t, now)) {
            case null null;
            case (?o) ?{
              id;
              p1Open = o.p1Open;
              p2Open = o.p2Open;
              waitingSecs = waitingSecs(o.since, now);
            };
          };
        };
      },
    );
    withSummaries.toArray().map<(T.TableId, T.TableSummary), T.TableSummary>(func((_, v)) = v);
  };

  /// Create a fresh table and seat `session` in `seat` on it. Rejects
  /// with `#wrongPhase` if `session` already has unfinished business
  /// at another table (a live seat, an open debrief, an unacked
  /// `#endedByOther` notice) — leave/ack that first.
  public func createTable<S, M>(
    self : Registry<S, M>,
    spec : T.Spec<S, M>,
    now : Int,
    session : T.SessionId,
    seat : T.Seat,
    visibility : T.TableVisibility,
  ) : T.Res<T.TableId> {
    if (alreadyAtATable(self, session)) {
      return #err(#wrongPhase("you are already at another table"));
    };
    let id = self.tableIdNonce;
    let t = Table.new<S, M>(self.idleTimeoutNs, visibility, session);
    switch (t.join(spec, now, session, seat)) {
      case (#err e) #err(e); // unreachable on a brand-new table; kept for exhaustiveness
      case (#ok _) {
        self.tableIdNonce += 1;
        self.tables.add(id, t);
        self.bySession.add(session, id);
        #ok(id);
      };
    };
  };

  /// Join a specific table by id. Covers every case plain `join` above
  /// does (switching seats while alone staging, a veteran rejoining
  /// from their own debrief to start a rematch, idle takeover of an
  /// abandoned table) — `code` is only inspected for a `#code`
  /// -protected table, and must match exactly.
  public func joinTable<S, M>(
    self : Registry<S, M>,
    spec : T.Spec<S, M>,
    now : Int,
    session : T.SessionId,
    id : T.TableId,
    seat : T.Seat,
    code : ?Text,
  ) : T.Res<T.JoinOk> {
    if (alreadyAtATable(self, session)) {
      return #err(#wrongPhase("you are already at another table"));
    };
    let t = switch (self.tables.get(id)) {
      case (?t) switch (t.visibility) {
        case (#code c) { if (code != ?c) return #err(#badCode) else { t } };
        case (#open) t;
      };
      case null return #err(#noSuchTable);
    };
    switch (t.join(spec, now, session, seat)) {
      case (#err e) #err(e);
      case (#ok j) {
        self.bySession.add(session, id);
        #ok(j);
      };
    };
  };

  public func submit<S, M>(
    self : Registry<S, M>,
    spec : T.Spec<S, M>,
    now : Int,
    session : T.SessionId,
    gen : Nat,
    turn : Nat,
    move : M,
  ) : T.Res<T.SubmitOk> = withTable<S, M, T.SubmitOk>(self, session, func(t) = t.submit(spec, now, session, gen, turn, move));

  public func rematch<S, M>(self : Registry<S, M>, spec : T.Spec<S, M>, now : Int, session : T.SessionId) : T.Res<T.RematchOk> = withTable<S, M, T.RematchOk>(self, session, func(t) = t.rematch(spec, now, session));

  /// Whether a `leave`/`reset` call about to run against `t` is the
  /// ABORT case — leaving a live game — rather than a plain staging
  /// walkout or a debrief ack. Decided from the phase BEFORE the call:
  /// `leave`'s own `#active` branch turns it INTO a shared `#aborted`
  /// debrief in that same step, and the leaver is deliberately NOT
  /// auto-acked by it (see plain `leave`'s own doc / architecture rule
  /// 7 "no silent endings") — they still see that debrief themselves,
  /// same as their opponent, so `session` must stay mapped to this
  /// table for their own next `status` to resolve it. Only a call that
  /// ISN'T an abort (a solo staging walkout, or a genuine debrief ack)
  /// returns `session` to "browsing".
  func isAbort<S, M>(t : T.Table<S, M>) : Bool = switch (t.phase) {
    case (#active _) true;
    case (_) false;
  };

  public func leave<S, M>(self : Registry<S, M>, now : Int, session : T.SessionId, gen : Nat) : T.Res<()> = withTable<S, M, ()>(
    self,
    session,
    func(t) {
      let abort = isAbort(t);
      let r = t.leave(now, session, gen);
      switch (r) {
        case (#ok _) { if (not abort) returnToLobby(self, session) };
        case (#err _) {};
      };
      r;
    },
  );

  public func reset<S, M>(self : Registry<S, M>, now : Int, session : T.SessionId, gen : Nat) : T.Res<()> = withTable<S, M, ()>(
    self,
    session,
    func(t) {
      let abort = isAbort(t);
      let r = t.reset(now, session, gen);
      switch (r) {
        case (#ok _) { if (not abort) returnToLobby(self, session) };
        case (#err _) {};
      };
      r;
    },
  );

  /// Same as plain `ackEnded` above, except it ALSO returns `session`
  /// to "browsing" — acking an `#endedByOther` notice IS the "return
  /// to lobby" action, so it should hand the session back to the
  /// browsable list, not leave it pointed at the table it just left.
  public func ackEnded<S, M>(self : Registry<S, M>, session : T.SessionId) {
    switch (self.bySession.get(session)) {
      case null {};
      case (?id) switch (self.tables.get(id)) {
        case (?t) t.ackEnded(session);
        case null {};
      };
    };
    returnToLobby(self, session);
  };

  public func status<S, M>(self : Registry<S, M>, now : Int, session : T.SessionId) : T.SessionStatus<S> {
    switch (self.bySession.get(session)) {
      case (?id) switch (self.tables.get(id)) {
        case (?t) #atTable({ id; view = t.status(now, session) });
        case null #browsing({ tables = listTables(self, now) }); // stale mapping onto an already-GC'd table
      };
      case null #browsing({ tables = listTables(self, now) });
    };
  };

  /// Idle-eviction across every table in the registry — see plain
  /// `sweep` above for what it does per table. Meant to be driven by a
  /// host's own periodic timer, same as `sweep` itself. Snapshots the
  /// table list into a plain array first: table GC below mutates
  /// `reg.tables` in place, and doing that while an iterator over the
  /// same live `Map` is still walking it is not something to rely on.
  public func sweep<S, M>(self : Registry<S, M>, now : Int) {
    for ((id, t) in Map.toArray(self.tables).values()) {
      t.sweep(now);
      gcIfQuiesced(self, id, t);
    };
  };
};
