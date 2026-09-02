/// ═══════════════════════════════════════════════════════════════════════════
/// Optional mixin: splices the game-agnostic HALF of a host actor's wiring
/// straight into it — `join`, `rematch`, `leave`, `reset`, `ackEnded`, and
/// the idle-sweep timer `backend/README.md`'s wiring example otherwise has
/// every host hand-write. `include Session<system>(...)` in place of those
/// six pieces of boilerplate; see `backend/README.md`'s "Session mixin"
/// section for the full before/after.
///
/// `submit` and `status` are deliberately OUT of scope, not an oversight:
/// their Candid signatures are game-specific (`submit` takes the game's own
/// `M`; `status` returns `View<S>`), and Motoko `mixin` declarations cannot
/// be generic — no `mixin <S, M>(...)` (confirmed against moc 1.11.2; the
/// upstream feature notes list type parameters as "not currently
/// supported"). `join`/`rematch`/`leave`/`reset`/`ackEnded` are the only
/// five operations whose signature never mentions `S` or `M` at all (see
/// their types in `lib.mo`) — that's what makes THIS mixin expressible as
/// one file for every game, while `submit`/`status` stay written directly
/// against `TP.submit(spec, table, ...)`/`TP.status(table, ...)` exactly as
/// the plain wiring example already shows.
///
/// Each parameter is a plain (non-async) closure the host builds inline,
/// e.g. `func(sid : Text, seat : TP.Seat) : TP.Res<TP.JoinOk> =
/// TP.join(Rules.spec(), table, Time.now(), sid, seat)` — closing over the
/// host's own `table`/`Rules.spec()`, never passed as separate arguments
/// here (that would need the generics this mixin can't have). Per Motoko's
/// mixin semantics, these bind as TRANSIENT lets inside the including
/// actor — never stored in stable state — so this never risks the failure
/// mode rule 1 in the root CLAUDE.md warns about (a `Spec`'s functions
/// aren't a stable type; storing them would break upgrades). Rule 11
/// ("Ws.mo reimplements no game logic") applies here too: every method
/// below is a one-line forward into the closure the host supplies, itself
/// forwarding into the same plain `TP.*` operations `Ws.mo` and the manual
/// wiring both call — a third transport for the same calls, not a third
/// code path.
///
/// `<system>` (on both the `mixin` declaration and the `include` call
/// site) is required because the sweep timer needs the `system` capability
/// — only legal at an actor's own top level, so `include Session<system>`
/// can only appear there directly (also: Motoko mixins cannot nest inside
/// another mixin). `startSweeping` itself is a PRIVATE mixin declaration —
/// per Motoko's mixin semantics, private members still splice into the
/// including actor's own scope (just not its Candid interface), so call it
/// BY NAME from your own `postupgrade`:
///
///   system func postupgrade() { startSweeping<system>() };
///
/// A mixin cannot declare a second `postupgrade` of its own (lifecycle
/// hooks are actor-top-level-only — confirmed: `system func postupgrade`
/// inside a `mixin` body fails to compile), so the host must still supply
/// this one line; nothing here does it silently on your behalf.
///
/// ── A known moc 1.11.2 limitation, not a bug in this file ─────────────────
/// This compiles, type-checks, and produces the correct Candid (`--check`/
/// `-c`/`--idl` all verified against a real host actor using it) — but
/// `moc -r` (the interpreter `mops test` runs) crashes on ANY `include`,
/// even the trivial one-liner from Motoko's own mixin documentation
/// (`Fatal error: exception ... Interpret.import_lib ... Assertion
/// failed`). That's why there is no `Session.test.mo`: an interpreter
/// suite exercising `include` itself cannot run on this toolchain version.
/// Correctness risk stays low regardless — every method here is a
/// one-line forward, and the `TP.*` operations underneath already have
/// full interpreter coverage in `test/Engine.test.mo`/`test/Lifecycle.test.mo`.
/// ═══════════════════════════════════════════════════════════════════════════

import TP "./lib";
import Timer "mo:core/Timer";

mixin <system>(
  join_ : (TP.SessionId, TP.Seat) -> TP.Res<TP.JoinOk>,
  rematch_ : (TP.SessionId) -> TP.Res<TP.RematchOk>,
  leave_ : (TP.SessionId) -> TP.Res<()>,
  reset_ : (TP.SessionId) -> TP.Res<()>,
  ackEnded_ : (TP.SessionId) -> (),
  sweepOnce : () -> (),
  sweepIntervalSeconds : Nat,
) {
  public func join(sid : TP.SessionId, seat : TP.Seat) : async TP.Res<TP.JoinOk> {
    join_(sid, seat);
  };
  public func rematch(sid : TP.SessionId) : async TP.Res<TP.RematchOk> {
    rematch_(sid);
  };
  public func leave(sid : TP.SessionId) : async TP.Res<()> {
    leave_(sid);
  };
  public func reset(sid : TP.SessionId) : async TP.Res<()> {
    reset_(sid);
  };
  public func ackEnded(sid : TP.SessionId) : async () {
    ackEnded_(sid);
  };

  // Frees an abandoned board with no visitor required to trigger it — see
  // `TP.sweep`'s own doc comment in `lib.mo`. Private: not part of the
  // including actor's Candid interface, but callable BY NAME from its own
  // `postupgrade` (see this file's doc header) since timers don't survive
  // an upgrade on their own.
  func startSweeping<system>() {
    ignore Timer.recurringTimer<system>(
      #seconds(sweepIntervalSeconds),
      func() : async () { sweepOnce() },
    );
  };
  startSweeping<system>();
};
