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
/// canister-driven move in real time. `nudge` is what decides WHEN to call
/// it: swept periodically (see a host's own fast timer, alongside the
/// existing idle-sweep one) rather than hooked eagerly into `ws.mo` itself
/// (which stays completely unchanged — see architecture rule 11: it is
/// still the ONLY transport a human ever mutates through) — a canister
/// seat's own mutations (its own `joinTable`/its own move landing in a
/// bot-vs-bot match) additionally trigger `nudge` eagerly right after they
/// succeed, so the common case never waits for the next tick.
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
/// A game ending puts BOTH seats in a `#debrief` — a human's own frontend
/// acks it (`leave`/`ackEnded`, wired to a "return to lobby" click) the
/// instant they're not rematching, freeing their session for a fresh
/// `createTable`/`joinTable` elsewhere. A canister seat has no such click:
/// left alone, it stays pinned to that finished table — `Registry` still
/// considers it "at a table" — until the much slower, passive idle-sweep
/// timer eventually force-clears it, often minutes later. `nudge` covers
/// this too, the same way it covers a stalled `#active` game: once the
/// OTHER seat is no longer a live participant of that SAME debrief either
/// (already acked, or never filled), it acks the canister seat's own side
/// immediately — never cutting short a still-deciding HUMAN partner's own
/// rematch window, since that partner not having acked yet is exactly what
/// keeps this from firing. When the other seat is ALSO canister-seated
/// (nobody around to decide anything), both seats ack unconditionally
/// instead of waiting on each other — see `maybeAckDebrief`'s own doc for
/// why the mirrored "wait for my partner" rule would otherwise deadlock
/// two canister seats forever.
///
/// ── How a host actor wires it ──────────────────────────────────────────
///
///   import CanisterPlayers "mo:duel-game-core/canister_players";
///
///   let cpAttached = CanisterPlayers.attach<Rules.State, Rules.Action>(
///     Rules.spec(),
///     registry,
///     attached.afterMutation, // from `Ws.attach` — see its own `Attached` doc
///     // Continuation-passing, not a plain `async Rules.Action` return —
///     // Motoko rejects `async M` for an unconstrained generic `M` (this
///     // module's own `S`/`M` stay fully generic), so the actual
///     // inter-canister call, and the one place a trap/reject is
///     // catchable, lives here, where `Rules.Action` is concrete:
///     func(session, req, k) : async* () {
///       let p = Principal.fromText(
///         session.trimStart(#text (CanisterPlayers.CP_SID_PREFIX))
///       );
///       let bot : BotIface.CanisterPlayer = actor (p.toText());
///       try { await* k(?(await bot.make_move(req))) } catch (_) { await* k(null) };
///     },
///   );
///
///   public shared ({ caller }) func create_table_as_canister(seat : TP.Seat, visibility : TP.TableVisibility) : async TP.Res<TP.TableId> {
///     await* cpAttached.createTable(caller, seat, visibility);
///   };
///   // ...join_table_as_canister / leave_as_canister / rematch_as_canister /
///   // ack_ended_as_canister / claim_win_as_canister / reset_as_canister
///   // forward the same way — see `Attached`'s own doc for the full set.
///   // `submit` is deliberately absent: a canister player's move never
///   // arrives as an independent inbound call under this design (see this
///   // module's doc header above). `claim_win_as_canister`/
///   // `reset_as_canister` matter most for an unattended, canister-vs-
///   // canister match: `nudge` below already claims a stalled game
///   // automatically, but a canister participant that wants to act the
///   // instant it's entitled to, rather than wait for the next tick, can
///   // call either directly.
///
///   // Alongside the existing 30s idle-sweep timer:
///   ignore Timer.recurringTimer<system>(#seconds(3), func() : async () {
///     await* cpAttached.nudge(Time.now());
///   });
///
/// See `../README.md`'s "Canister players" section for the full worked
/// example, `examples/racing/src/Bot.mo` for a minimal hardcoded-script
/// bot, and `skills/duel-game-core/SKILL.md` for the authoring guide.
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
  /// raw text), and the check `nudge` itself uses to decide which seats
  /// are its own responsibility.
  public func isCanisterSession(session : T.SessionId) : Bool = session.startsWith(#text CP_SID_PREFIX);

  /// What a host actor gets back from `attach` — seven table-lifecycle
  /// operations (never `submit`: a canister player's move is always
  /// applied by `notifyAndApply` below, as the direct reply to a call THIS
  /// module made, not as a separately-arriving request — see this
  /// module's own doc header) plus `nudge`, the periodic sweep a host
  /// wires onto its own timer that, per table, either asks a due, idle
  /// canister seat for its next move, claims the win against a stalled
  /// opponent on that seat's behalf, or acks a finished `#debrief` on that
  /// seat's behalf once nobody's plausibly still deciding on a rematch —
  /// see `maybeNotify`/`maybeAckDebrief` below for exactly which of the
  /// three applies (this module's own doc header's §3 note on the
  /// unattended, canister-vs-canister case covers both the claim-win and
  /// the debrief-ack side of that: `claimWin`/`reset` exist mainly so a
  /// canister participant CAN act immediately instead of waiting for the
  /// next `nudge` tick, not because `nudge` itself needs them called from
  /// the outside). Each lifecycle op takes the CALLING canister's own
  /// principal (from `msg.caller` at the host actor's own entry point —
  /// never a client-supplied `sid`) and derives `sidForCanister` itself.
  public type Attached = {
    createTable : (Principal.Principal, T.Seat, T.TableVisibility) -> async* T.Res<T.TableId>;
    joinTable : (Principal.Principal, T.TableId, T.Seat, ?Text) -> async* T.Res<T.JoinOk>;
    leave : (Principal.Principal, Nat) -> async* T.Res<()>;
    rematch : (Principal.Principal) -> async* T.Res<T.RematchOk>;
    ackEnded : (Principal.Principal) -> async* ();
    claimWin : (Principal.Principal, Nat) -> async* T.Res<()>;
    reset : (Principal.Principal, Nat) -> async* T.Res<()>;
    nudge : (Int) -> async* ();
  };

  /// Builds a ready-to-wire `Attached` bound to one game's `Spec`/
  /// `Registry`. `afterMutation` is `Ws.Attached.afterMutation` — reusing
  /// the EXACT push fan-out `ws.mo` itself runs after a human-driven
  /// mutation, so a canister-driven one (a bot joining, moving, leaving,
  /// ...) reaches a human opponent's browser in real time too, with no
  /// second, divergent implementation of that fan-out (see this module's
  /// doc header). `callBot` is the one piece only the host actor can
  /// supply: given the acting session (to recover the target canister's
  /// own principal — see `sidForCanister`'s doc) and a `T.MoveRequest<S>`,
  /// make the actual inter-canister call and return its `M`. Kept as a
  /// plain function parameter (never stored — architecture rule 1's
  /// "`Spec` is passed per call, never stored" applies here too, for the
  /// same reason) so this module never has to know the game's own
  /// `CanisterPlayer` Candid interface.
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
  ) : Attached {

    // One bit per (table, seat) currently mid-`callBot` — guards against
    // asking the SAME due seat twice before the first ask resolves (a
    // fresh eager trigger racing an overlapping `nudge` tick). Keyed as
    // plain text rather than a nested mutable record: simpler, and this
    // module's own traffic is never hot enough for the allocation to
    // matter. Transient by construction (a local `var` closed over by the
    // functions below, never stored in stable state) — safe to lose across
    // an upgrade, since it only ever suppresses a redundant ask, never
    // correctness.
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

    /// If `session` is due to move right now (and not already
    /// mid-`callBot`), ask and apply — see `notifyAndApply`. Otherwise, if
    /// `session` is the WAITING seat and may `claimWin` against a stalled
    /// opponent, claim it on `session`'s own behalf: this module's own
    /// account of "there's nobody looking at a screen to click Claim Win"
    /// in an unattended, canister-vs-canister match (see this module's own
    /// doc header §3). A no-op either way if neither condition currently
    /// holds, or the table isn't `#active` at all. Shared by every eager
    /// trigger below and by `nudge`'s own periodic scan.
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
              case (#err _) {}; // raced/stale by the time this ran — harmless; the next nudge tick re-checks
            };
          };
        };
        case (_) {};
      };
    };

    /// Auto-acks a canister-seated occupant's own finished `#debrief` —
    /// the debrief-phase counterpart to `maybeNotify`'s `#active`-phase
    /// checks above, and the fix for a gap this module otherwise leaves
    /// wide open: nothing ever tells a canister-seated player its own game
    /// just ended (`ws.mo` stays untouched — rule 11 — and a bot has no
    /// browser polling `status` on its own initiative), so left unhandled
    /// it stays pinned to that finished table indefinitely from
    /// `Registry`'s point of view — refusing `createTable`/`joinTable` for
    /// that same `cp:` session — until the much slower, passive idle-sweep
    /// timer eventually force-clears it, often minutes later. Acks via
    /// `registry.leave` — the exact call a human's own "return to lobby"
    /// makes for a `#debrief` — the instant the OTHER seat is no longer a
    /// live participant of THIS SAME debrief either:
    /// `Table.activeDebriefSeat` already returns `null` for a seat that
    /// acked or was never filled, the identical "partner's gone for good"
    /// signal `Table.rematchPartner` already uses to decide a rematch
    /// reservation is pointless — so a still-deciding HUMAN partner's own
    /// rematch window is never cut short by this. When the other seat is
    /// ALSO canister-seated there is nobody deciding anything at all (the
    /// same unattended, canister-vs-canister case `maybeNotify`'s own
    /// claim-win branch already covers), so both seats ack unconditionally
    /// — independent of whether the OTHER one has acked yet — rather than
    /// each waiting on the other's own ack first: mirroring the human-side
    /// rule literally (ack once my partner's gone) would have two canister
    /// seats wait on each other forever, since neither's `nudge` tick
    /// would ever see the other as "gone".
    func maybeAckDebrief(now : Int, id : T.TableId, t : T.Table<S, M>, d : T.Debrief<S>, session : T.SessionId) : async* () {
      if (not isCanisterSession(session)) return;
      if (t.activeDebriefSeat(d, session) == null) return; // already acked — nothing to do
      let partner = if (d.p1 == session) { d.p2 } else { d.p1 };
      let partnerGoneOrCanister = isCanisterSession(partner) or t.activeDebriefSeat(d, partner) == null;
      if (not partnerGoneOrCanister) return;
      switch (registry.leave(now, session, t.gen)) {
        case (#ok _) await* afterMutation(now, session, null, ?id, true);
        case (#err _) {}; // raced/stale by the time this ran — harmless; the next nudge tick re-checks
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

    /// Both seats of `id`'s CURRENT phase, checked for whatever's due right
    /// now: due-to-move or claim-win-eligible in `#active` (`maybeNotify`),
    /// or ack-eligible in `#debrief` (`maybeAckDebrief`) — a no-op in every
    /// other phase. Shared by every eager trigger (a canister-driven join,
    /// rematch, or move landing) and by `nudge`'s own periodic scan, so
    /// neither a bot-vs-bot match starting nor one settling ever waits on
    /// the next tick for the common case.
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
            // Eager trigger: if this join just started the game (or the
            // OTHER seat is also canister-seated and was already waiting),
            // don't wait for the next `nudge` tick.
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

      // `claimWin`/`reset` below give a canister PARTICIPANT the same
      // agency a human has — act immediately rather than wait for the
      // next `nudge` tick's own auto-claim (see `maybeNotify`'s doc).
      // Both route through `registry.bySession`, exactly like `leave`
      // above: only ever "my own table," never an arbitrary one by id —
      // a supervising orchestrator resetting/claiming ANY table (not just
      // one it's seated at) is tournament-orchestrator territory, out of
      // scope here (see `../../CLAUDE.md`'s "Canister players" note).
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

      nudge = func(now : Int) : async* () {
        for ((id, _) in registry.tables.toArray().values()) {
          await* maybeSettleBoth(now, id);
        };
      };
    };
  };
};
