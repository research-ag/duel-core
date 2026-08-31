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
  wiring example.
- **`frontend/`** — the npm package (`duel-game-core`): the matching
  client plumbing (session identity, polling, the generic
  lobby/staging/rematch/busy/debrief screens, Candid IDL scaffolding).
  See [`frontend/README.md`](frontend/README.md) for the `GamePlugin`
  contract (Candid types, seat labels, board/action rendering) a game
  implements.
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
- Only Motoko dependency: `core` (mo:core, the current Motoko standard
  library). Never import `mo:base` — it is the legacy library.
- `bench-helper` is a dev-dependency, used only by `backend/bench/`.
  Benchmarking requires `[toolchain] pocket-ic` and `wasm-opt` pinned in
  `mops.toml` (already done) — `mops bench` fails outright without them.
- The frontend package has no npm dependencies of its own — it takes an
  already-constructed IC `actor` from its caller (see
  `frontend/README.md`), so it never hardcodes an agent-loading strategy.

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
node --check frontend/app.js frontend/render.js frontend/idl.js frontend/ic-env.js
```

With mops installed, `<path-to-core/src>` is typically
`.mops/core@<version>/src` (or use `mops toolchain` / `mops test` wiring),
resolved relative to `backend/`.

## Architecture rules (violating these reintroduces shipped bugs)

1. **Spec is passed per call, never stored.** Function values aren't stable
   types; storing the `Spec` in state would break canister upgrades. Every
   engine entry point takes `spec` as its first parameter.
2. **The engine owns time.** `now : Int` (nanoseconds, `Time.now()` at the
   host) is a parameter everywhere; neither module may import `Time`.
   This is what makes the test suites deterministic.
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
    `start()` takes an already-built `actor`; it doesn't import
    `@dfinity/agent` or hardcode a CDN. Don't reintroduce that coupling.

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
