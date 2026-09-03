# duel-game-core — generic 2-player session engine + client

Two independent, rules-agnostic packages, both named `duel-game-core`
(one per registry), for building simultaneous-reveal, turn-based
2-player games on the Internet Computer. Neither package knows anything
about any particular game — that's supplied by whoever builds a game on
top.

- **`backend/`** — the Motoko mops package (`duel-game-core`): the
  session engine (join/seating, round submission, debrief, early leave,
  rematch, idle takeover, per-caller status views), source at
  `backend/src/lib.mo` (the package's entry point — import it as
  `mo:duel-game-core`, no subpath). See [`backend/README.md`](backend/README.md)
  for the `Spec<S, M>` contract a game implements and a full host-actor
  wiring example. `backend/src/Ws.mo` (`mo:duel-game-core/Ws`) is a
  separate module layered on top of the engine, never merged into
  `lib.mo` (see the toolchain note below), but MANDATORY, not optional:
  real-time push over `ic-websocket-cdk` — the live transport
  `frontend/ws.js` actually talks to (not an unused reference add-on) —
  is the ONLY way a client can mutate game state at all. None of
  `join`/`submit`/`rematch`/`leave`/`reset`/`ackEnded` is exposed as a
  plain Candid method on a host actor; a direct update call bypassing
  `Ws.mo` is exactly the race a single, ordered WS channel exists to
  close (two independent update calls have no guaranteed relative
  processing order once both are in flight). `status` is the one
  exception, staying a plain public `query` (side-effect-free, no race
  risk). `Ws.mo` also drives the disappearance handling a real WS close
  signal makes possible (ending a game a vanished player left mid-round,
  freeing a board both walked away from — see `backend/README.md`'s
  "Real-time push" section). `backend/src/ActorMixin.mo`
  (`mo:duel-game-core/ActorMixin`) is a third module, `include`d in the
  host actor as `include ActorMixin<system>(ws, sweepFunc)`: it supplies
  the four `ws_*` Candid methods (`ws_open`/`ws_close`/`ws_message`/
  `ws_get_messages`, forwarding each straight to the `ws` built from
  `Ws.attach`) plus the idle-sweep timer, so no host actor hand-declares
  any of the four.
- **`frontend/`** — the npm package (`duel-game-core`): the matching
  client plumbing (session identity, real-time push, the generic
  lobby/staging/rematch/busy/debrief screens, Candid IDL scaffolding).
  See [`frontend/README.md`](frontend/README.md) for the `GamePlugin`
  contract (Candid types, seat labels, board/action rendering) a game
  implements, and its "Real-time push" section for the required `ws`
  param — there is no plain-polling fallback, `start()` throws without a
  `ws`, and a host actor built on this framework has no plain mutating
  method to poll in the first place. `frontend/ws.js`'s `connectWs()`
  builds a `GatewayWs` (`frontend/ws/gateway-*.js`) that speaks
  `backend/src/Ws.mo`'s real `ic-websocket-cdk` protocol directly: each
  browser tab registers itself as its own Gateway (the CDK allows this —
  no pre-registered Gateway principal required) and polls its own
  messages, so there's still no external relay *process* to run, just a
  real WS handshake and genuine canister-driven push instead of
  client-side polling wearing a push-shaped interface.
- **`backend/test/*.test.mo`** — interpreter-run suites for the engine.
  `Lifecycle.test.mo` walks one long session narrative; `Engine.test.mo`
  drives each entry point in isolation, covering the error variants,
  takeover gates, and status views the narrative never reaches. Both are
  plugged into `backend/test/FakeGame.mo` — a deliberately trivial
  throwaway `Spec` that exists only to exercise the engine; it is not a
  real game and ships no rendering. The `*.test.mo` suffix is what
  `mops test` discovers — a file named `FooTest.mo` is silently skipped,
  so keep the suffix when adding suites.
- **`backend/bench/*.bench.mo`** — `mops bench` suites. `engine.bench.mo`
  measures the engine's own overhead (not any game's `resolve` cost)
  using the same `FakeGame.mo` spec, across `join`+`leave`, a full
  submitted round, and repeated `status` queries.

This repo is the framework the two packages are built from, not a game
itself — `examples/007/` and `examples/racing/` are reference games built
on top of it (a pure rules module implementing `TP.Spec<S, M>` plus a
thin host actor for the backend; a `GamePlugin` plus `index.html` and
deploy config for the frontend), kept here to prove the packages are
usable end to end and to give a new game something concrete to copy. A
real game normally lives in its own repo, structured the same way.
Building one — whether from scratch or by adapting an existing client —
is a whole workflow with its own hard-won lessons: see the
`duel-game-core-new-game` skill
(`.agents/skills/duel-game-core-new-game/SKILL.md`) before starting.

## Toolchain

- moc **1.11.2** (mops toolchain).
- `src/lib.mo` (the engine) has exactly one Motoko dependency: `core`
  (mo:core, the current Motoko standard library). Never import `mo:base`
  in it — that's the legacy library. `src/Ws.mo` is the sole exception:
  it additionally depends on `ic-websocket-cdk` (which is itself built on
  `mo:base` — outside this repo's control) — confined there so `lib.mo`
  itself stays exactly as pure as the architecture rules require, NOT
  because wiring `Ws.mo` is optional (every host actor built on this
  package must wire it — see the `backend/` bullet above). Any FUTURE
  module added here still needs the same "why is this not in lib.mo"
  scrutiny before it grows a new dependency.
- `bench-helper` is a dev-dependency, used only by `backend/bench/`.
  Benchmarking requires `[toolchain] pocket-ic` and `wasm-opt` pinned in
  `mops.toml` (already done) — `mops bench` fails outright without them.
- The frontend package has no npm dependencies at all, full stop —
  `app.js`'s `start()` takes an already-constructed IC `actor` (and a
  WebSocket-like `ws`, required) from its caller (see
  `frontend/README.md`), so it never hardcodes an agent-loading strategy.
  `frontend/ws.js` builds that `ws` FOR the caller — a `GatewayWs`
  speaking `backend/src/Ws.mo`'s real `ic-websocket-cdk` protocol, no
  external relay library, no Gateway URL, nothing to load from a CDN.
  Don't let a real npm dependency creep into this package anywhere — see
  rule 10.

## Build & test

`mops.toml` lives in `backend/`, not the repo root — run all mops/moc
commands from there:

```bash
cd backend
mops install                       # fetches core per mops.toml

# Type-check:
moc --check --package core <path-to-core/src> src/lib.mo

# Run the test suites (interpreter mode; they Debug.print progress and end
# with "ALL ... CHECKS PASSED"; any trap = a FAIL, exit code 1):
mops test                  # both suites
mops test Engine           # one suite — the filter is a path substring
mops test Lifecycle

# Equivalent single-file invocation, if you need raw moc flags:
moc -r --package core <path-to-core/src> test/Engine.test.mo

# Benchmarks (needs [toolchain] pocket-ic / wasm-opt, already pinned):
mops bench
```

```bash
# Frontend (from the repo root): syntax/sanity check — no build step, no
# DOM needed to import:
node --check frontend/app.js frontend/render.js frontend/idl.js frontend/ic-env.js frontend/ws.js frontend/ws/gateway-client.js frontend/ws/gateway-transport.js frontend/ws/gateway-protocol.js
```

With mops installed, `<path-to-core/src>` is typically
`.mops/core@<version>/src` (or use `mops toolchain` / `mops test` wiring),
resolved relative to `backend/`.

### After touching anything under `frontend/`: refresh both examples

`frontend/` is a TypeScript package — its source lives in `frontend/src/`
(and `frontend/test/`), but what it actually SHIPS is `frontend/dist/`
(compiled `.js` + `.d.ts`, gitignored, produced by `npm run build`
— see `frontend/package.json`'s `build` script). **Always run `npm run
build` inside `frontend/` first**, before anything below — neither the
fast copy nor a full reinstall picks up a source edit that was never
compiled; `frontend/dist/` is stale (or missing entirely, on a fresh
clone) until you do.

`examples/007/frontend` and `examples/racing/frontend` each depend on
`duel-game-core` as `file:../../../frontend`, with `install-links=true`
in their `.npmrc` — so it's **copied** into their own
`node_modules/duel-game-core`, not symlinked (an asset canister with no
build step needs real files there, not a symlink that may not survive an
asset-sync step). npm treats a `file:` dependency as unchanged whenever
its declared `version` and lockfile entry look the same, so a plain `npm
install` after editing `frontend/` reports "up to date" and silently
serves stale code — do this instead, every time `frontend/` changes,
without waiting to be asked:

**If `frontend/package.json`'s `dependencies` did NOT change** (the
common case — editing a `.ts` file, adding a function): build, then copy
directly, no further npm involved, effectively instant:

```bash
cd frontend && npm run build && cd ..
for ex in examples/007/frontend examples/racing/frontend; do
  target="$ex/node_modules/duel-game-core"
  rsync -a --delete frontend/dist/ "$target/dist/"
  cp frontend/package.json frontend/style.css frontend/README.md "$target/"
done
```

(This mirrors exactly `frontend/package.json`'s own `files` field — the
same set a real `install-links=true` copy or `npm pack` would produce —
so it never leaks `frontend/src/`/`frontend/test/` source into a
deployed asset canister.) This is enough for `node --check`/a local
`dfx` reload; for `examples/racing`, also re-run `npm run build` there
too (fast, esbuild only — no network) so ITS OWN `dist/` picks up the
change.

**If `frontend/package.json`'s `dependencies` DID change** (e.g. a new
package added): the copy above is not enough — the new package itself
still needs fetching into the example's OWN `node_modules`. Do a full
reinstall (after building — see above), and delete `package-lock.json`
too, not just `node_modules/duel-game-core`:

```bash
cd frontend && npm run build && cd ..
cd examples/007/frontend    && rm -rf node_modules package-lock.json && npm install
cd examples/racing/frontend && rm -rf node_modules package-lock.json && npm install --legacy-peer-deps
```

`frontend/package.json` also declares a `prepare` script (`npm run
build`) — npm normally runs a `file:` dependency's `prepare` script the
same way it does a git dependency's, which would make this automatic.
**Don't rely on that here**: both examples' `allow-scripts` gate (see
their own `package.json`'s `allowScripts` / npm's `allow-scripts`
tooling) blocks `duel-game-core`'s `prepare` from actually running on
install — confirmed live: `npm install` in either example completes with
only a warning (`1 package has install scripts not yet covered by
allowScripts`), `dist/` is silently NOT (re)built, and the copy step
happily copies whatever was already sitting in `frontend/dist/` from
before, stale or not. The explicit `npm run build` above is the one step
actually doing the work — run it every time, don't assume `npm install`
alone did it.

**Why the lockfile has to go too** (a real bug hit doing exactly this
for the `@dfinity/candid`/`cborg` addition to `frontend/ws/gateway-*.js`):
`rm -rf node_modules/duel-game-core && npm install` alone silently
under-installs. The existing `package-lock.json` has a cached entry for
`duel-game-core` recorded from a PREVIOUS install with a DIFFERENT
(often empty) `dependencies` list; npm trusts that cached entry instead
of re-reading `frontend/package.json`'s current one, so the new
sub-dependencies never get resolved at all — no error, just missing
packages. Only a full `node_modules` + lockfile wipe forces npm to
re-resolve from scratch. Verify it worked: `ls
node_modules/@dfinity node_modules/cborg` (or whatever the new package
was) should exist afterward, not just `node_modules/duel-game-core`.

## Architecture rules (violating these reintroduces shipped bugs)

1. **Spec is passed per call, never stored.** Function values aren't stable
   types; storing the `Spec` in state would break canister upgrades. Every
   engine entry point takes `spec` as its first parameter.
2. **The engine owns time.** `now : Int` (nanoseconds, `Time.now()` at the
   host) is a parameter everywhere; `lib.mo` itself may not import `Time`.
   This is what makes the test suites deterministic. `Ws.mo` is the one
   documented exception — it plays the HOST's role (it calls `Time.now()`
   itself, same as any host actor would, then hands it to the engine as a
   parameter exactly like the plain wiring does); it is not part of the
   engine and must never fold into `lib.mo`.
3. **Rules stay pure.** `init`/`validate`/`resolve` in a game's `Spec`
   must remain pure functions over immutable records. State transitions
   build new records (`{ me with ... }`), never mutate.
4. **`validate` is the only legality gate.** The engine calls it for BOTH
   seats on every submission — a game's UI's disabled buttons are
   cosmetic. Any new rule constraint goes in `validate`, not in the client.
5. **Every phase carries a timestamp** (`since` / `lastActivity`) so idle
   takeover works from any phase — no ghost lobbies.
6. **Rematch is create-then-join.** A rematch request stages a game with
   `reservedFor = partner`; the partner's own rematch/join pattern-matches
   that staging. Actor message serialization makes simultaneous clicks
   race-free. Don't replace this with a flag-and-poll scheme.
7. **No silent endings.** `leave` from an active game produces a shared
   `#aborted` debrief for both players. An idle takeover of an ACTIVE game
   records evicted players in `lastEnded` so `status` shows `#endedByOther`
   until they `ackEnded`; takeover of an expired DEBRIEF marks them
   pre-acked (they already saw their debrief) — this asymmetry is
   intentional, see LifecycleTest steps 6–7.
8. **`status` must stay side-effect-free** — a host exposes it as a
   `query`. Lazy idle-reset happens only in mutating calls.
9. **Pending moves are hidden by construction**: `status` exposes only
   Booleans for the opponent's pending move, never the move itself.
10. **The frontend never assumes an agent-loading strategy.** `app.js`'s
    `start()` takes an already-built `actor` (and an already-built `ws`,
    required — there is no plain-polling fallback any more); it doesn't
    import `@dfinity/agent` or hardcode a CDN, and never will — that rule
    is absolute, not just "no dependencies yet". Dependencies are a
    narrower, deliberate exception: `frontend/ws/gateway-*.js` (the real
    `mo:duel-game-core/Ws` client `frontend/ws.js`'s `connectWs()`
    always builds) depends on `@dfinity/candid` (Candid encode/decode of
    the message content blob) and `cborg` (CBOR-decoding
    `ws_get_messages`' certified envelope) — confined there for the same
    reason `ic-websocket-cdk` is confined to `backend/src/Ws.mo`: every
    OTHER file in this package (`app.js`, `render.js`, `idl.js`,
    `ic-env.js`) stays dependency-free. `start()` itself stays exactly as
    transport-agnostic as before — a caller may still hand it any
    WebSocket-shaped mock (e.g. for tests) instead of a real `GatewayWs`.
11. **`Ws.mo` reimplements no game logic, and is the sole entry point for
    mutation.** Every WebSocket request dispatches to `lib.mo`'s own
    plain engine operations (`TP.join`, `TP.submit`, ...) directly — none
    of those six operations is ALSO exposed as a plain Candid method on a
    host actor (only `status` is, being side-effect-free). There is no
    second transport for the same calls to (dis)agree with; a game that
    ever adds a plain mutating Candid method alongside `Ws.mo` reopens
    exactly the race this design closes.
12. **Leave means left.** `status`/`join`/`rematch` all treat a session
    that already acked its own debrief (via `leave`) as no longer a
    participant of it (`activeDebriefSeat`, not plain `seatInDebrief`),
    even while the phase itself legitimately lingers in `#debrief` for
    the still-deciding partner. `leave` itself keeps using plain
    `seatInDebrief` — it must stay idempotently callable to ack in the
    first place. Skipping this gate anywhere it's needed reintroduces a
    real shipped bug: "Return to lobby" showing that player the identical
    debrief screen — with live Rematch/Leave buttons — until the partner
    ALSO left, indistinguishable from the button doing nothing.

## Skills (read before editing)

Local copies of the relevant SKILL.md playbooks live in this repo under
`.agents/skills/` — consult these when working here, in order of
relevance to this package:

- `.agents/skills/duel-game-core-new-game/SKILL.md` — building a new
  game (or adapting an existing client) on these two packages: the
  `Spec<S, M>` design process, the generic-chrome-vs-rich-UI frontend
  decision, and lessons learned building `examples/007` and
  `examples/racing`. Covers both backend and frontend — read this one
  first if that's the task, before the Motoko-specific skills below.
- `.agents/skills/motoko-general-style-guidelines/SKILL.md` — naming,
  layout, 2-space indent, 80-char margin, type-annotation rules. House
  style for ALL code in this repo.
- `.agents/skills/motoko-performance-optimizations/SKILL.md` — allocation
  reduction, text construction in blocks, loop shape. NOTE the cardinal
  rule: NEVER call `Array.concat` (or `.concat`) inside a loop — repeated
  concat is O(n²); accumulate in a `mo:core/List` (or VarArray) and
  convert once at the end. (The single `.concat` in `push()` in
  `lib.mo` is fine: called once per update, on a list bounded at 2
  elements — do not let that pattern grow.)
- `.agents/skills/motoko-compiler-warnings-fixes/SKILL.md` — M0194/M0244
  fix recipes; fix one warning class at a time, never `_`-rename record
  fields.
- `.agents/skills/motoko-core-code-improvements/SKILL.md` — import
  ordering (core / third-party / local, alphabetical), unused-import
  cleanup. CAUTION: dot notation creates implicit import needs —
  `xs.concat(..)` / `i.toNat()` still require `import Array` / `import
  Int` even though the module name no longer appears (they carry
  comments here saying so; don't remove them).
- `.agents/skills/motoko-dot-notation-migration/SKILL.md` — prefer
  `self.func(...)` dot notation for core functions with a `self` first
  parameter (this repo already uses it); factory functions
  (`Array.repeat`, `Blob.fromArray`) must NOT be converted; parenthesize
  before dotting infix results.
- `.agents/skills/motoko-base-to-core-migration/SKILL.md` — base→core API
  map (`.vals()` → `.values()`, `Debug.trap` → `Runtime.trap`, etc.);
  reference if legacy idioms sneak in.
- `.agents/skills/motoko-doc-strings/SKILL.md` — `///` doc-comment format
  for mo-doc, if documenting the public API further.
- `.agents/skills/motoko-mops-package-maintenance/SKILL.md`,
  `.agents/skills/motoko-github-ci-workflow/SKILL.md`,
  `.agents/skills/motoko-benchmarks-generation/SKILL.md` — when
  publishing this package, adding CI, or benchmarking the engine.

## Conventions

- Tests are plain interpreter scripts (moc -r), not a test framework:
  `ok`/`expectErr` helpers + `Runtime.trap` on violation. Extend in kind.
  (In mo:core, `trap` lives in `Runtime`; `Debug` only has `print`.)
- `msg`, not `label`, for text parameters (`label` is a reserved word).
- Update BOTH test suites when touching engine semantics; the doc-header
  in `backend/src/lib.mo` (wiring example + design guarantees) must
  be kept in sync with reality, as must both READMEs.
