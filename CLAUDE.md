# duel-game-core — generic 2-player session engine + client

Two independent, rules-agnostic packages, both named `duel-game-core`
(one per registry), for building simultaneous-reveal, turn-based
2-player games on the Internet Computer. Neither package knows anything
about any particular game — that's supplied by whoever builds a game on
top.

- **`backend/`** — the Motoko mops package (`duel-game-core`): the
  session engine (a multi-table lobby — table creation/discovery/join,
  round submission, debrief, early leave, rematch, idle takeover,
  per-caller status views, all routed to the right table). Its shared
  type surface — `Spec`, `Seat`, `Phase`, `View`, `Err`, `Res`, `Table`,
  `Registry`, and everything else — is defined once in
  `backend/src/types.mo` and re-exported from `backend/src/lib.mo` (the
  package's entry point — import it as `mo:duel-game-core`, no
  subpath), so a host actor names all of them off one import. The actual
  operations live in two sibling modules, each importable by its own
  subpath: `backend/src/table.mo` (`mo:duel-game-core/table`) is the
  low-level, single-table primitive (`Table.new` plus
  `join`/`submit`/`rematch`/`leave`/`reset`/`ackEnded`/`status`/`sweep`
  on the table it returns); `backend/src/registry.mo`
  (`mo:duel-game-core/registry`) is the multi-table router built on top
  of it (`Registry.new` plus the same seven caller-facing operations,
  routed to the right table, plus `createTable`/`listTables`/`sweep`).
  Any number of tables run independently and simultaneously
  (`TP.Registry`, created with `Registry.new`); a table can be `#open`
  (browsable/joinable by anyone) or protected with an access code
  (joinable only by id + code, shared with a friend out of band).
  `Registry`'s own operations
  (`createTable`/`listTables`/`joinTable`/`submit`/`rematch`/`leave`/
  `reset`/`ackEnded`/`status`/`sweep`) delegate straight into the
  matching `Table` operation — no game logic or legality is
  reimplemented at this layer; a game that genuinely wants exactly one
  fixed board with no lobby of its own can use `Table` directly instead.
  See [`backend/README.md`](backend/README.md) for the `Spec<S, M>`
  contract a game implements and a full host-actor wiring example.
  `backend/src/ws.mo` (`mo:duel-game-core/ws`) is a separate module
  layered on top of `table.mo`/`registry.mo`, never merged into `lib.mo`
  (see the toolchain note below), but MANDATORY, not optional: real-time
  push over `ic-websocket-cdk` — the live transport `frontend/ws.js`
  actually talks to (not an unused reference add-on) — is the ONLY way a
  client can mutate game state at all. None of `Registry`'s
  `createTable`/`joinTable`/`submit`/`rematch`/`leave`/`reset`/
  `ackEnded` is exposed as a plain Candid method on a host actor; a
  direct update call bypassing `ws.mo` is exactly the race a single,
  ordered WS channel exists to close (two independent update calls have
  no guaranteed relative processing order once both are in flight).
  `status` is the one exception, staying a plain public `query`
  (side-effect-free, no race risk). `ws.mo` also drives the disappearance
  handling a real WS close signal makes possible (ending a game a
  vanished player left mid-round, freeing a table both walked away from
  — see `backend/README.md`'s "Real-time push" section). `backend/src/actor_mixin.mo`
  (`mo:duel-game-core/actor_mixin`) is a fourth module — a Motoko
  `mixin`, `include`d in the host actor as `include
  ActorMixin<system>(ws, sweepFunc)`: it supplies the four `ws_*` Candid
  methods (`ws_open`/`ws_close`/`ws_message`/`ws_get_messages`,
  forwarding each straight to the `ws` built from `Ws.attach`) plus the
  idle-sweep timer, so no host actor hand-declares any of the four.
- **`frontend/`** — the npm package (`duel-game-core`): the matching
  client plumbing (session identity, real-time push, the generic
  multi-table lobby/staging/rematch/busy/debrief screens, Candid IDL
  scaffolding).
  See [`frontend/README.md`](frontend/README.md) for the `GamePlugin`
  contract (Candid types, seat labels, board/action rendering) a game
  implements, and its "Real-time push" section for the required `ws`
  param — there is no plain-polling fallback, `start()` throws without a
  `ws`, and a host actor built on this framework has no plain mutating
  method to poll in the first place. `frontend/ws.js`'s `connectWs()`
  builds a `GatewayWs` (`frontend/ws/gateway-*.js`) that speaks
  `backend/src/ws.mo`'s real `ic-websocket-cdk` protocol directly: each
  browser tab self-registers as its own Gateway via plain Candid
  `ws_open`/`ws_message`/`ws_close` calls (the CDK allows this — no
  pre-registered Gateway principal required), then a timer drives
  `ws_get_messages` — a genuine round-trip poll, not a browser<->canister
  WebSocket (the IC has none), exactly what a real, separate Gateway
  process would also be doing on the client's behalf. `GatewayWs` still
  exposes a WebSocket-SHAPED surface (`onopen`/`onmessage`/`onclose`) to
  its own caller, and the CDK's own sequence-numbered envelopes plus
  keep-alive/close semantics are real, canister-driven state, not a
  client-side illusion — but the transport underneath that surface is
  Candid calls on an interval, so there's no external relay *process* to
  run, and no genuine browser WebSocket either. A real Gateway-backed
  transport (swapped in under the same `GatewayWs` surface, see
  `frontend/README.md`'s transport-split table) is what a deployment
  actually wanting browser WebSocket semantics needs.
- **`backend/test/*.test.mo`** — interpreter-run suites for the engine.
  `Lifecycle.test.mo` walks one long session narrative; `Engine.test.mo`
  drives each entry point in isolation, covering the error variants,
  takeover gates, and status views the narrative never reaches — both
  exercise `table.mo`'s per-table primitive (`Table.new`, then
  `t.join`/`t.submit`/...) directly. `Lobby.test.mo` and
  `LobbyLifecycle.test.mo` do the same for `registry.mo`'s `Registry`
  itself: per-operation unit checks (table creation/discovery/join,
  routing across several live tables at once, garbage collection, id
  non-reuse) and a multi-table narrative (two tables running
  independently and interleaved) respectively. `Hub.test.mo` covers
  `ws.mo`'s `Hub` — the sid<->principal bridge behind the real-time push
  transport — in isolation, against its two maps directly, since the
  full `IcWebSocketCdk` actor machinery isn't exercisable in this
  interpreter harness. All are plugged into `backend/test/FakeGame.mo` —
  a deliberately trivial throwaway `Spec` that exists only to exercise
  the engine; it is not a real game and ships no rendering. The
  `*.test.mo` suffix is what `mops test` discovers — a file named
  `FooTest.mo` is silently skipped, so keep the suffix when adding
  suites.
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
`duel-game-core` skill (`skills/duel-game-core/SKILL.md`) before
starting — it's written for a third party building from nothing but a
rules description, with no other context, and is installable standalone
in that party's own repo (see that file's own header and the root
README's "Building a game" section), but is equally the right starting
point when working in this repo.

## Toolchain

- moc **1.11.2** (mops toolchain, pinned in `backend/mops.toml`) — enough
  to type-check `lib.mo`/`types.mo`/`table.mo`/`registry.mo`/`ws.mo` and
  run every `backend/test/*.test.mo` suite. `actor_mixin.mo`'s top-level
  `mixin <system>(...)` declaration needs a newer moc — `examples/racing`
  pins **1.14.0** for exactly this reason (see its own `CLAUDE.md`'s
  toolchain note); any consumer whose `Host.mo` wires
  `mo:duel-game-core/actor_mixin` needs at least that version even though
  the package itself is developed against 1.11.2.
- The engine (`src/lib.mo`/`types.mo`/`table.mo`/`registry.mo`) has
  exactly one Motoko dependency: `core` (mo:core, the current Motoko
  standard library). Never import `mo:base` in any of it — that's the
  legacy library. `src/ws.mo` is the sole exception: it additionally
  depends on `ic-websocket-cdk` (vendored in this repo at
  `backend/src/ic-websocket-cdk/src`, migrated to `mo:core` throughout —
  it has no `mo:base` import left) — confined there so the engine
  modules themselves stay exactly as pure as the architecture rules
  require, NOT because wiring `ws.mo` is optional (every host actor
  built on this package must wire it — see the `backend/` bullet above).
  `ic-websocket-cdk` in turn depends on the third-party
  `ic-certification` mops package for its Merkle certification tree,
  which still uses `mo:base` internally — genuinely outside this repo's
  control, unlike `ic-websocket-cdk` itself. Any FUTURE module added
  here still needs the same "why is this not in lib.mo" scrutiny before
  it grows a new dependency.
- `bench-helper` is a dev-dependency, used only by `backend/bench/`.
  Benchmarking requires `[toolchain] pocket-ic` and `wasm-opt` pinned in
  `mops.toml` (already done) — `mops bench` fails outright without them.
- `app.js`, `render.js`, `idl.js`, and `ic-env.js` — everything but
  `frontend/ws/gateway-*.js` — have no npm dependencies at all, full
  stop: `app.js`'s `start()` takes an already-constructed IC `actor`
  (and a WebSocket-like `ws`, required) from its caller (see
  `frontend/README.md`), so it never hardcodes an agent-loading
  strategy. `frontend/ws.js` builds that `ws` FOR the caller — a
  `GatewayWs` speaking `backend/src/ws.mo`'s real `ic-websocket-cdk`
  protocol, no external relay library, no Gateway URL, nothing to load
  from a CDN — but `gateway-*.js` itself is the one documented, narrow
  exception: it depends on `@icp-sdk/core` (Candid encode/decode) and
  `cborg` (CBOR-decoding `ws_get_messages`' certified envelope) — see
  rule 10. Don't let a real npm dependency creep into ANY OTHER file in
  this package.

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
# Frontend (from the repo root): `frontend/` is TypeScript — build first
# (see "After touching anything under frontend/" below), THEN
# syntax/sanity-check the compiled dist/ output the package actually
# ships; there is no bare frontend/app.js etc. any more to check
# directly, and no DOM needed to import the compiled output either:
(cd frontend && npm run build)
node --check frontend/dist/app.js frontend/dist/render.js frontend/dist/idl.js frontend/dist/ic-env.js frontend/dist/ws.js frontend/dist/ws/gateway-client.js frontend/dist/ws/gateway-transport.js frontend/dist/ws/gateway-protocol.js
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
for the `@icp-sdk/core`/`cborg` addition to `frontend/ws/gateway-*.js`):
`rm -rf node_modules/duel-game-core && npm install` alone silently
under-installs. The existing `package-lock.json` has a cached entry for
`duel-game-core` recorded from a PREVIOUS install with a DIFFERENT
(often empty) `dependencies` list; npm trusts that cached entry instead
of re-reading `frontend/package.json`'s current one, so the new
sub-dependencies never get resolved at all — no error, just missing
packages. Only a full `node_modules` + lockfile wipe forces npm to
re-resolve from scratch. Verify it worked: `ls
node_modules/@icp-sdk node_modules/cborg` (or whatever the new package
was) should exist afterward, not just `node_modules/duel-game-core`.

## Architecture rules (violating these reintroduces shipped bugs)

1. **Spec is passed per call, never stored.** Function values aren't stable
   types; storing the `Spec` in state would break canister upgrades. Every
   engine entry point takes `spec` as its first parameter.
2. **The engine owns time.** `now : Int` (nanoseconds, `Time.now()` at the
   host) is a parameter everywhere; none of `lib.mo`/`types.mo`/
   `table.mo`/`registry.mo` may import `Time`. This is what makes the
   test suites deterministic. `ws.mo` and `actor_mixin.mo` are the two
   documented exceptions — both play the HOST's role (each calls
   `Time.now()` itself, same as any host actor would, then hands it to
   the engine as a parameter exactly like the plain wiring does); neither
   is part of the engine and must never fold into `lib.mo`.
3. **Rules stay pure.** `init`/`validate`/`resolve` in a game's `Spec`
   must remain pure functions over immutable records. State transitions
   build new records (`{ me with ... }`), never mutate.
4. **`validate` is the only legality gate.** The engine calls it for BOTH
   seats on every submission — a game's UI's disabled buttons are
   cosmetic. Any new rule constraint goes in `validate`, not in the client.
5. **Every phase carries a timestamp** (`since` / `lastActivity`) so idle
   takeover works from any phase — no ghost lobbies.
6. **Rematch is create-then-join.** A rematch request stages a game with
   `reservedFor = partner` — unless `partner` already acked (left) that
   same debrief, in which case `Table.rematchPartner` reserves nobody and
   the seat opens immediately instead of waiting on a partner who's gone
   for good; the partner's own rematch/join pattern-matches that staging.
   Actor message serialization makes simultaneous clicks race-free. Don't
   replace this with a flag-and-poll scheme. The reserved partner isn't
   only able to accept, either: `leave` while `reservedFor == ?session`
   declines it, clearing just the reservation (the requester's own
   staging survives, now open to anyone) — the `#awaitingRematch` view
   carries a `gen` for exactly this call. At the
   `Registry` layer a rematch reuses the SAME `TableId` — it never
   allocates a new table.
7. **No silent endings.** `leave` from an active game produces a shared
   `#aborted` debrief for both players. An idle takeover of an ACTIVE game
   records evicted players in `lastEnded` so `status` shows `#endedByOther`
   until they `ackEnded`; takeover of an expired DEBRIEF marks them
   pre-acked (they already saw their debrief) — this asymmetry is
   intentional, see LifecycleTest steps 6–7. A `lastEnded` entry nobody's
   plausibly still coming back to ack (a session that will never return,
   most commonly) doesn't wait forever either: `Table.sweep` also prunes
   any entry older than a generous multiple of `idleTimeoutNs`, via
   `Table.pruneEnded`. This matters beyond just that one entry — at the
   `Registry` layer, `gcIfQuiesced` refuses to drop an `#empty` table
   while ANY `lastEnded` entry is still outstanding, so one permanently
   un-acked notice otherwise pins that table's id in the registry (and
   in `listTables`, looking freshly "open" — `waitingSecs == 0` — forever,
   including across later, unrelated, cleanly-finished games on the same
   freed board) for good.
8. **`status` must stay side-effect-free** — a host exposes it as a
   `query`. Lazy idle-reset happens only in mutating calls.
9. **Pending moves are hidden by construction**: `status` exposes only
   Booleans for the opponent's pending move, never the move itself.
10. **The frontend never assumes an agent-loading strategy.** `app.js`'s
    `start()` takes an already-built `actor` (and an already-built `ws`,
    required — there is no plain-polling fallback any more); it doesn't
    import `@icp-sdk/core/agent` or hardcode a CDN, and never will — that
    rule is absolute, not just "no dependencies yet". Dependencies are a
    narrower, deliberate exception: `frontend/ws/gateway-*.js` (the real
    `mo:duel-game-core/ws` client `frontend/ws.js`'s `connectWs()`
    always builds) depends on `@icp-sdk/core` (Candid encode/decode of
    the message content blob) and `cborg` (CBOR-decoding
    `ws_get_messages`' certified envelope) — confined there for the same
    reason `ic-websocket-cdk` is confined to `backend/src/ws.mo`: every
    OTHER file in this package (`app.js`, `render.js`, `idl.js`,
    `ic-env.js`) stays dependency-free. `start()` itself stays exactly as
    transport-agnostic as before — a caller may still hand it any
    WebSocket-shaped mock (e.g. for tests) instead of a real `GatewayWs`.
11. **`ws.mo` reimplements no game logic, and is the sole entry point for
    mutation.** Every WebSocket request dispatches to `registry.mo`'s own
    `Registry` operations (`createTable`, `joinTable`, `submit`, ...)
    directly — none of those seven operations is ALSO exposed as a plain
    Candid method on a host actor (only `status` is, being
    side-effect-free). There is no second transport for the same calls to
    (dis)agree with; a game that ever adds a plain mutating Candid method
    alongside `ws.mo` reopens exactly the race this design closes.
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

Two kinds of `SKILL.md` playbook are relevant here, in different places
because only one of them ships to third parties:

- **`skills/`** (repo root, tracked in git, installable standalone via
  `npx skills add research-ag/duel-core --skill <name>`) — the
  duel-game-core-specific playbook:
  - `skills/duel-game-core/SKILL.md` — building a new game (or adapting
    an existing client) on these two packages, from nothing but a
    plain-English rules description: the `Spec<S, M>` design process,
    copy-and-fill templates for every game-specific file, and (in its
    `references/`) the generic-chrome-vs-rich-UI frontend decision and
    lessons learned building `examples/007` and `examples/racing`.
    Covers both backend and frontend — read this one first if that's the
    task, before the Motoko-specific skills below. Written to be
    installed standalone in a game's OWN repo, but equally the right
    starting point when working here.
- **`.agents/skills/`** (local dev setup, not tracked in git — general
  Motoko authoring skills, not specific to this project) — consult these
  when working here, in order of relevance to this package:

- `.agents/skills/motoko-general-style-guidelines/SKILL.md` — naming,
  layout, 2-space indent, 80-char margin, type-annotation rules. House
  style for ALL code in this repo.
- `.agents/skills/motoko-performance-optimizations/SKILL.md` — allocation
  reduction, text construction in blocks, loop shape. NOTE the cardinal
  rule: NEVER call `Array.concat` (or `.concat`) inside a loop — repeated
  concat is O(n²); accumulate in a `mo:core/List` (or VarArray) and
  convert once at the end. (The single `.concat` in `pushAck()` in
  `table.mo` is fine: called once per update, on a list bounded at 2
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

### Keeping `skills/` current

`skills/duel-game-core/SKILL.md`, its `templates/`, and its
`references/` are shipped documentation — installed standalone via
`npx skills add research-ag/duel-core --skill duel-game-core` into a
third party's OWN repo, read cold by an agent with none of this repo's
history or this session's context. Whenever a change here touches
anything any of them describes — an engine/`ws.mo`/`ActorMixin` API, a
`GamePlugin`/`app.js`/`ws.js` contract, a build/deploy command, a type
shape a template mirrors, an example game's structure — update the
affected file(s) in the SAME change, not as a follow-up.

Write the affected passage as if authoring it fresh against today's
architecture, never as a patch over yesterday's. Concretely, nothing
under `skills/` may ever contain:

- Before/after framing — "used to be X, now Y", "previously",
  "as of this change", "was renamed from X".
- Removal notices — "X is gone", "no longer exists", "don't use X
  anymore", "deprecated".
- Any other changelog voice ("recently", "this used to require...").

A reader of `skills/*` should never be able to tell an edit happened —
only ever what's true now. A grep for the changed name catches direct
mentions, not a worked example, a template's own inline comment, or a
"why" aside elsewhere in the same file that quietly assumed the old
shape — after changing anything a skill references, re-read the WHOLE
affected file (and its `templates/`) for exactly that kind of
second-order staleness, not just the passage you edited on purpose.

## Conventions

- Tests are plain interpreter scripts (moc -r), not a test framework:
  `ok`/`expectErr` helpers + `Runtime.trap` on violation. Extend in kind.
  (In mo:core, `trap` lives in `Runtime`; `Debug` only has `print`.)
- `msg`, not `label`, for text parameters (`label` is a reserved word).
- Update the affected test suite(s) when touching engine semantics —
  `Lifecycle.test.mo`/`Engine.test.mo` for `table.mo`'s per-table
  primitive, `LobbyLifecycle.test.mo`/`Lobby.test.mo` for `registry.mo`'s
  `Registry` routing; the doc-header in `backend/src/lib.mo` (wiring
  example + design guarantees) must be kept in sync with reality, as
  must both READMEs and `skills/` (see "Keeping `skills/` current" above
  — as clean rewritten documentation, never a changelog-style patch
  note).
