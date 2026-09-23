/// ═══════════════════════════════════════════════════════════════════════════
/// duel-game-core/canister_players — lets a CANISTER take a seat at a
/// `Registry` table and play, against a human or another canister, with no
/// polling and no second inbound entry point for a move to arrive through.
///
/// ── Why this needs no transport of its own ─────────────────────────────────
///
/// `ws.mo` exists because the IC has no native WebSocket, so a browser tab
/// has to fake real-time push by polling over a relay it invents for
/// itself. A canister player needs none of that: two canisters calling each
/// other with `async`/`await` already IS a real, ordered, request-response
/// channel — the primitive the whole IC is built on. This module lets the
/// GAME canister call the PLAYER canister directly and treat the reply as
/// the move (see `notifyAndApply` below) — never the other way around. A
/// one-way "your turn" notice followed by the player canister calling back
/// independently would reopen exactly the unordered-second-channel problem
/// architecture rule 11 closes (two independent update calls have no
/// guaranteed relative processing order once both are in flight); a single
/// `await` whose return value IS the chosen action needs no second inbound
/// entry point at all, so there is nothing new for a stray caller to hit
/// and nothing to spoof — the reply can only ever come from the one
/// principal this module itself decided to call.
///
/// ── Identity: a third `sid` namespace ───────────────────────────────────
///
/// `Table`/`Registry` never look at a `SessionId` beyond comparing it for
/// equality — `ws.mo` already uses that to give a human two non-spoofable
/// identities (`ii:`/`an:`, both of the form `sidFor(prefix, p)`) with no
/// engine change at all. `CP_SID_PREFIX` (`"cp:"`) is a third such
/// namespace, mirroring `Ws.sidFor`'s own shape (see `sidForCanister`'s
/// own doc for why it's a small duplicated one-liner rather than an
/// import of `ws.mo` itself). It's actually simpler here than
/// for a browser: `ws.mo` has to cross-check a client-ASSERTED `sid`
/// against a separately authenticated WebSocket connection, because that
/// transport decouples the two. A plain canister-to-canister Candid call
/// has no such gap — `msg.caller` already IS the authenticated identity —
/// so every entry point below computes `sidForCanister(caller)` itself and
/// never accepts a client-supplied `sid` at all. There is nothing to check,
/// because there is nothing to spoof.
///
/// ── The call/response protocol ──────────────────────────────────────────
///
/// `notifyAndApply` is the whole protocol: build a `T.MoveRequest<S>` from
/// the table's OWN current, truthful status (reusing `Registry.status` —
/// never a second, divergent read of `Table`'s internals), `await` the
/// host-supplied `callBot`, re-read `gen`/`turn` FRESH (not the copies
/// closed over from before that `await` — the table can legitimately
/// change underneath a long-running bot call: the human claims a win,
/// leaves, or gets idle-swept while the bot is still thinking), then apply
/// the reply via `registry.submit` and run the exact same push fan-out
/// `ws.mo` itself runs, so a human opponent's browser learns about a
/// canister-driven move in real time. `settle` decides WHEN to call it —
/// eagerly, right after whichever mutation (canister- or, via
/// `Ws.attach`'s `onSettled`, human-driven) just made a seat due. No
/// polling timer involved; see `backend/README.md`'s "Canister players"
/// section for the full wiring.
///
/// A bot canister can fail in every ordinary way software fails: it traps,
/// it's out of cycles, it's mid-upgrade, it times out, or it just returns
/// an illegal move. None of that needs new machinery — `duel-game-core`
/// already has a complete story for "a seat didn't move"
/// (`claimTimeoutNs`, `idleTimeoutNs`, `#aborted` debriefs), and a
/// misbehaving bot is, from the engine's point of view, indistinguishable
/// from a human who put the phone down. So `notifyAndApply`'s own failure
/// handling is almost trivially small: catch a trapped/errored call or an
/// `#err(#illegalMove _)` result, retry the bot once, and otherwise do
/// NOTHING — let the existing timeout machinery take it from there. The
/// one retry isn't blind: its own `T.MoveRequest<S>` carries
/// `retryReason`, the exact rejection text the game's own `validate`
/// returned for the first reply, so a bot that wants to can correct
/// specifically what was wrong (a trapped/errored call has no such text
/// to give — `callBot`'s own `k(null)` never retries at all, see below).
///
/// ── A finished game still needs acking ───────────────────────────────────
///
/// A game ending puts BOTH seats in a `#debrief`. A human's own frontend
/// acks it on "return to lobby"; a canister seat has no such click, so
/// `settle` acks it on the seat's behalf once the OTHER seat is no longer
/// a live participant either (already acked, gone, or itself
/// canister-seated) — never cutting short a still-deciding human
/// partner's own rematch window. `sweep` (below) is the slow fallback for
/// whatever `settle` never gets called for at all.
///
/// ── How a host actor wires it ──────────────────────────────────────────
///
///   let cpAttached = CanisterPlayers.attach<Rules.State, Rules.Action>(
///     Rules.spec(), registry, attached.afterMutation, callBot, armClaimCheck,
///   );
///
/// `attached` (`Ws.attach`) and `cpAttached` each need the other's result,
/// so a host resolves the cycle with a small mutable indirection —
/// `armClaimCheck` schedules a `Timer.setTimer` back into `cpAttached.settle`.
/// See `../README.md`'s "Canister players" section for the full worked
/// example (including that indirection), `examples/racing/bot/Bot.mo` for
/// a minimal bot, and `skills/duel-game-core/SKILL.md` for the authoring
/// guide.
/// ═══════════════════════════════════════════════════════════════════════════

import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Time "mo:core/Time";

import Registry "./registry";
import Table "./table";
import T "./types";

module {

  /// Reserved `SessionId` namespace for a canister-seated player, bound to
  /// the CALLING canister's own principal — see this module's own doc
  /// header. Never used internally by `Table`/`Registry`, which treat
  /// every `SessionId` as opaque text.
  public let CP_SID_PREFIX : Text = "cp:";

  /// The permanent player id for canister `p` — pure, so it's "issued" for
  /// free the first time `p` is ever seen. Mirrors `Ws.sidFor`/
  /// `Ws.sidForPrincipal` exactly (duplicated in miniature here, rather
  /// than imported, to keep this module's own dependency surface to just
  /// `core` plus its sibling `registry.mo`/`types.mo` — see the root
  /// `CLAUDE.md`'s toolchain note on why `ws.mo`'s own dependency on
  /// `ic-websocket-cdk` stays confined to that one module; importing
  /// `ws.mo` here for one line would pull that dependency in transitively
  /// for no real reason, since every actual byte of it is unrelated to
  /// canister players).
  public func sidForCanister(p : Principal.Principal) : T.SessionId = CP_SID_PREFIX # p.toText();

  /// Whether `session` names a canister-seated player under this module's
  /// namespace — a purely cosmetic check for a lobby frontend wanting to
  /// render "vs 🤖" (`TableSummary.p1Session`/`p2Session` already carry the
  /// raw text), and the check `settle`/`sweep` themselves use to decide
  /// which seats are their own responsibility.
  public func isCanisterSession(session : T.SessionId) : Bool = session.startsWith(#text CP_SID_PREFIX);

  /// What a host actor gets back from `attach`: `submit` is deliberately
  /// absent (see this module's own doc header), and `settle`/`sweep` are
  /// the eager and slow-fallback ways to ask/claim/ack a canister seat —
  /// see `maybeSettleBoth` below.
  public type Attached = {
    createTable : (Principal.Principal, T.Seat, T.TableVisibility) -> async* T.Res<T.TableId>;
    joinTable : (Principal.Principal, T.TableId, T.Seat, ?Text) -> async* T.Res<T.JoinOk>;
    leave : (Principal.Principal, Nat) -> async* T.Res<()>;
    rematch : (Principal.Principal) -> async* T.Res<T.RematchOk>;
    ackEnded : (Principal.Principal) -> async* ();
    claimWin : (Principal.Principal, Nat) -> async* T.Res<()>;
    reset : (Principal.Principal, Nat) -> async* T.Res<()>;
    settle : (Int, T.TableId) -> async* ();
    sweep : (Int) -> async* ();
  };

  /// `armClaimCheck(id, secs)` schedules one future `settle(now, id)` —
  /// a host-supplied hook since only an actor holds `Timer.setTimer`'s
  /// `<system>` capability, which keeps this module `<system>`-free and
  /// testable with a plain stub (see `CanisterPlayers.test.mo`).
  public func attach<S, M>(
    spec : T.Spec<S, M>,
    registry : T.Registry<S, M>,
    afterMutation : (Int, T.SessionId, ?Nat64, ?T.TableId, Bool) -> async* (),
    // Continuation-passing (`k`), not a plain `(...) -> async M` — Motoko
    // rejects `async M` as a type for an unconstrained generic `M` (see
    // this module's own doc header's wiring example). The host's own
    // implementation calls `k(?move)` on success or `k(null)` on a
    // trapped/errored call — the one place able to `try`/`catch` the
    // actual inter-canister call, since `M` is concrete there.
    callBot : (T.SessionId, T.MoveRequest<S>, (?M) -> async* ()) -> async* (),
    armClaimCheck : (T.TableId, Nat) -> async* (), // async* so its body can reach `system` — see `ws.mo`'s `onClose`

  ) : Attached {

    // Guards against asking the SAME due seat twice before the first ask
    // resolves. Lost across an upgrade harmlessly (only suppresses a
    // redundant ask).
    let inFlight = Map.empty<Text, ()>();
    func flightKey(id : T.TableId, seat : T.Seat) : Text {
      id.toText() # (switch (seat) { case (#p1) "/p1"; case (#p2) "/p2" });
    };

    /// Builds this session's own `T.MoveRequest<S>` from the table's
    /// current, truthful `#inGame` view — never a second, divergent read
    /// of `Table`'s own internals. `null` unless `session` is seated
    /// in-game AND it's genuinely their move right now: `not youSubmitted`
    /// is "due to move" in EITHER mode (see `Table.status`'s own doc for
    /// why that one Boolean already means the right thing for both
    /// `#simultaneous` and `#alternating`).
    func dueRequest(now : Int, id : T.TableId, session : T.SessionId) : ?T.MoveRequest<S> {
      switch (registry.status(spec, now, session)) {
        case (#atTable { view = #inGame ig }) {
          if (ig.youSubmitted) { null } else {
            ?{
              tableId = id;
              seat = ig.seat;
              game = ig.game;
              mode = ig.mode;
              turn = ig.turn;
              gen = ig.gen;
              retryReason = null; // a fresh ask, not (yet) a retry — see notifyAndApply
            };
          };
        };
        case (_) null;
      };
    };

    /// Ask `session` (already confirmed due) for its move, apply it, and
    /// push the result to its human opponent — the full protocol this
    /// module's own doc header describes. Always clears its own in-flight
    /// flag before returning, success or failure alike.
    func notifyAndApply(id : T.TableId, session : T.SessionId, req : T.MoveRequest<S>) : async* () {
      let key = flightKey(id, req.seat);
      inFlight.add(key, ());

      // One retry on an illegal move (`triesLeft`), then silence — see
      // this module's own doc header. A trapped/errored call (`callBot`
      // invoking `k(null)`) never retries at all, same as any other
      // failure that isn't specifically an illegal move. The retry's
      // OWN request carries `retryReason`, the exact text `validate`
      // rejected the first reply with, re-read fresh (never `req`'s own
      // stale copy) so the bot can act on specifically why it was wrong
      // instead of just resubmitting blind.
      func tryOnce(triesLeft : Nat, thisReq : T.MoveRequest<S>) : async* () {
        await* callBot(
          session,
          thisReq,
          func(maybeMove : ?M) : async* () {
            switch (maybeMove) {
              case null {}; // trapped/errored — treat exactly like silence
              case (?move) {
                let now = Time.now();
                // Re-read gen/turn FRESH — never `req`'s own copies,
                // captured before `callBot`'s own `await` — see this
                // module's doc header.
                switch (dueRequest(now, id, session)) {
                  case null {}; // no longer due at all — table moved on underneath the bot
                  case (?fresh) switch (registry.submit(spec, now, session, fresh.gen, fresh.turn, move)) {
                    case (#ok _) {
                      await* afterMutation(now, session, null, ?id, false);
                      await* maybeSettleBoth(now, id);
                    };
                    case (#err(#illegalMove reason)) {
                      if (triesLeft > 0) {
                        await* tryOnce(triesLeft - 1 : Nat, { fresh with retryReason = ?reason });
                      };
                    };
                    case (#err _) {}; // #stale/#notYourTurn/#wrongPhase/... — table moved on; stop, don't retry
                  };
                };
              };
            };
          },
        );
      };

      await* tryOnce(1, req);
      inFlight.remove(key);
    };

    /// If `session` is due, ask and apply — see `notifyAndApply`. If it's
    /// the WAITING seat and overdue, claim the win on its behalf. If
    /// waiting but not yet overdue, arm `armClaimCheck` for the remaining
    /// `secondsUntilClaimable` instead of polling for it (redundant
    /// re-arming is harmless — each wakeup re-reads truth fresh). No-op
    /// outside `#active`. Shared by every eager trigger and by `sweep`.
    func maybeNotify(now : Int, id : T.TableId, session : T.SessionId) : async* () {
      if (not isCanisterSession(session)) return;
      switch (registry.status(spec, now, session)) {
        case (#atTable { view = #inGame ig }) {
          if (not ig.youSubmitted) {
            if (inFlight.get(flightKey(id, ig.seat)) == null) {
              await* notifyAndApply(id, session, { tableId = id; seat = ig.seat; game = ig.game; mode = ig.mode; turn = ig.turn; gen = ig.gen; retryReason = null });
            };
          } else if (ig.claimWinAvailable) {
            switch (registry.claimWin(spec, now, session, ig.gen)) {
              case (#ok _) await* afterMutation(now, session, null, ?id, true);
              case (#err _) {}; // raced/stale by the time this ran — harmless; the next check re-verifies
            };
          } else {
            await* armClaimCheck(id, ig.secondsUntilClaimable);
          };
        };
        case (_) {};
      };
    };

    /// Auto-acks a canister seat's own finished `#debrief` (via
    /// `registry.leave`, same as a human's "return to lobby") once the
    /// OTHER seat is no longer a live participant either — never cutting
    /// short a still-deciding human partner's rematch window. If the
    /// other seat is ALSO canister-seated, both ack unconditionally
    /// instead of deadlocking on each other's ack.
    func maybeAckDebrief(now : Int, id : T.TableId, t : T.Table<S, M>, d : T.Debrief<S>, session : T.SessionId) : async* () {
      if (not isCanisterSession(session)) return;
      if (t.activeDebriefSeat(d, session) == null) return; // already acked — nothing to do
      let partner = if (d.p1 == session) { d.p2 } else { d.p1 };
      let partnerGoneOrCanister = isCanisterSession(partner) or t.activeDebriefSeat(d, partner) == null;
      if (not partnerGoneOrCanister) return;
      switch (registry.leave(now, session, t.gen)) {
        case (#ok _) await* afterMutation(now, session, null, ?id, true);
        case (#err _) {}; // raced/stale by the time this ran — harmless; the next check re-verifies
      };
    };

    /// Whether a just-succeeded `rematch` opened a fresh, unreserved
    /// staging worth telling every browsing session about — mirrors
    /// `Ws.rematchOpenedLobby` exactly (duplicated in miniature rather
    /// than imported — see `sidForCanister`'s own doc for why).
    func rematchOpenedLobby(id : ?T.TableId) : Bool {
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

    /// Checks both seats of `id`'s current phase — exposed to the host as
    /// `settle`; also driven by `sweep`'s full-registry scan.
    func maybeSettleBoth(now : Int, id : T.TableId) : async* () {
      switch (registry.tables.get(id)) {
        case null {};
        case (?t) switch (t.phase) {
          case (#active g) {
            await* maybeNotify(now, id, g.p1);
            await* maybeNotify(now, id, g.p2);
          };
          case (#debrief d) {
            await* maybeAckDebrief(now, id, t, d, d.p1);
            await* maybeAckDebrief(now, id, t, d, d.p2);
          };
          case (_) {};
        };
      };
    };

    {
      createTable = func(caller : Principal.Principal, seat : T.Seat, visibility : T.TableVisibility) : async* T.Res<T.TableId> {
        let session = sidForCanister(caller);
        let now = Time.now();
        switch (registry.createTable(spec, now, session, seat, visibility)) {
          case (#ok id) {
            await* afterMutation(now, session, null, ?id, true);
            #ok(id);
          };
          case (#err e) #err(e);
        };
      };

      joinTable = func(caller : Principal.Principal, id : T.TableId, seat : T.Seat, code : ?Text) : async* T.Res<T.JoinOk> {
        let session = sidForCanister(caller);
        let now = Time.now();
        switch (registry.joinTable(spec, now, session, id, seat, code)) {
          case (#ok j) {
            await* afterMutation(now, session, null, ?id, true);
            // Eager trigger: don't wait for `sweep` if this join settles anything now.
            await* maybeSettleBoth(Time.now(), id);
            #ok(j);
          };
          case (#err e) #err(e);
        };
      };

      leave = func(caller : Principal.Principal, gen : Nat) : async* T.Res<()> {
        let session = sidForCanister(caller);
        let now = Time.now();
        switch (registry.bySession.get(session)) {
          case null #err(#notSeated);
          case (?id) switch (registry.leave(now, session, gen)) {
            case (#ok _) {
              await* afterMutation(now, session, null, ?id, true);
              #ok(());
            };
            case (#err e) #err(e);
          };
        };
      };

      rematch = func(caller : Principal.Principal) : async* T.Res<T.RematchOk> {
        let session = sidForCanister(caller);
        let now = Time.now();
        let priorId = registry.bySession.get(session);
        switch (registry.rematch(spec, now, session)) {
          case (#ok r) {
            await* afterMutation(now, session, null, priorId, rematchOpenedLobby(priorId));
            switch (priorId, r) {
              case (?id, #started) await* maybeSettleBoth(Time.now(), id);
              case (_, _) {};
            };
            #ok(r);
          };
          case (#err e) #err(e);
        };
      };

      ackEnded = func(caller : Principal.Principal) : async* () {
        let session = sidForCanister(caller);
        let now = Time.now();
        let priorId = registry.bySession.get(session);
        registry.ackEnded(session);
        await* afterMutation(now, session, null, priorId, true);
      };

      // Lets a canister participant act immediately instead of waiting on
      // `armClaimCheck`'s wakeup; routes through `registry.bySession` like `leave`.
      claimWin = func(caller : Principal.Principal, gen : Nat) : async* T.Res<()> {
        let session = sidForCanister(caller);
        let now = Time.now();
        switch (registry.bySession.get(session)) {
          case null #err(#notSeated);
          case (?id) switch (registry.claimWin(spec, now, session, gen)) {
            case (#ok _) {
              await* afterMutation(now, session, null, ?id, true);
              #ok(());
            };
            case (#err e) #err(e);
          };
        };
      };

      reset = func(caller : Principal.Principal, gen : Nat) : async* T.Res<()> {
        let session = sidForCanister(caller);
        let now = Time.now();
        switch (registry.bySession.get(session)) {
          case null #err(#notSeated);
          case (?id) switch (registry.reset(now, session, gen)) {
            case (#ok _) {
              await* afterMutation(now, session, null, ?id, true);
              #ok(());
            };
            case (#err e) #err(e);
          };
        };
      };

      settle = maybeSettleBoth;

      sweep = func(now : Int) : async* () {
        // slow full-registry fallback for whatever `settle` misses
        for ((id, _) in registry.tables.toArray().values()) {
          await* maybeSettleBoth(now, id);
        };
      };
    };
  };
};
