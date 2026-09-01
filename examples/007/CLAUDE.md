# 007 duel — reference game built on duel-game-core

A complete, deployable example game that plugs into the two
`duel-game-core` packages this repo ships (`../../backend`, the Motoko
mops package; `../../frontend`, the npm package). It exists to prove the
two packages are usable end to end and to give a new game something
concrete to copy — it is **not** part of either package itself.

- **`Duel007Rules.mo`** — the 007 duel game logic as pure functions. No
  actor, no shared functions, no storage, no Time. Plugs into the engine
  via `spec() : TP.Spec<State, Action>`, where `TP` is
  `mo:duel-game-core` (imported from `../../backend` — see
  `mops.toml`).
- **`src/Host.mo`** — the host actor: forwards every call to the
  engine with `Time.now()` and `Rules.spec()`, wired exactly as
  `../../backend/README.md`'s example shows. Deploy target. Also wires
  `mo:duel-game-core/Ws` (the optional WebSocket push transport) side by
  side with the 7 plain methods — both forward into the SAME `table`, so
  they always agree; see `../../backend/README.md`'s "Optional: real-time
  push" section for the design this mirrors.
- **`test/*.test.mo`** — interpreter-run suites. `Lifecycle.test.mo` and
  `Rules.test.mo` are scenario walks (one long session / the headline
  game rules); `Engine.test.mo` and `RulesUnit.test.mo` are per-operation
  unit suites covering the error variants, takeover gates, status views,
  and `resolve` branches the scenarios never reach. `Engine.test.mo` and
  `Lifecycle.test.mo` exercise the SAME engine code the `../../backend`
  package ships (via the mops dependency below) with these rules plugged
  in — they are not a second copy of the engine's own test suite. The
  `*.test.mo` suffix is what `mops test` discovers — a file named
  `FooTest.mo` is silently skipped, so keep the suffix when adding
  suites.
- **`icp.yaml`** — icp-cli manifest; deploys `src/Host.mo` as
  canister `backend` and `frontend/` as an asset canister.
- **`frontend/`** — vanilla-JS web client, no bundler/build step (uses
  `@dfinity/agent` from esm.sh; `duel-game-core` fetched locally via
  `npm install`, see below). `duel007-plugin.js` is the whole
  game-specific surface: it implements the `GamePlugin` contract
  (`idlTypes`, `seatLabel`, `renderBoard`, `renderActions`) from
  `../../frontend/README.md`. `app.js` builds the actor, calls
  `duel-game-core/ws.js`'s `connectWs({ canisterId, actor, host })` for
  real-time push (see `../../backend/README.md`'s "Optional: real-time
  push" section) — this game's own code never touches `ic-websocket-js`
  or a Gateway URL directly; `connectWs()` picks `../../gateway/`'s
  self-hosted Gateway for a local deploy or the public one on mainnet
  automatically (`?ws=0` forces plain polling either way; `?gateway=<url>`
  overrides) — and calls `start({ actor, plugin, ws })` —
  every screen that's the same for every game (lobby, staging, rematch,
  busy countdown, debrief chrome, session identity, polling/push) comes
  from the npm package. `style.css` here holds only 007-specific visuals
  (narration box, agent stat panels, resource pips), layered on top of
  `node_modules/duel-game-core/style.css` (loaded first in `index.html`),
  which supplies the page chrome and the CSS custom properties this file
  reuses.

## Toolchain

- moc **1.11.2** (mops toolchain), node/npm for the frontend.
- Motoko dependencies: `duel-game-core` (path dependency on
  `../../backend` — see `mops.toml`), `core` (mo:core), and
  `ic-websocket-cdk` (only because `src/Host.mo` opts into
  `mo:duel-game-core/Ws` — see `../../CLAUDE.md`'s toolchain note). Never
  import `mo:base` directly in this game's own code — it's the legacy
  library; `ic-websocket-cdk` pulling it in transitively is a
  documented, contained exception, not license to import it yourself.
  `duel-game-core` re-exports nothing of `core`'s own surface, so
  `src/Host.mo`'s direct `mo:core/Time` import needs `core` listed here
  too, same as any real game repo would.
- The frontend's only npm dependency is `duel-game-core` itself, pulled
  in as a `file:../../../frontend` dependency (see
  `frontend/package.json`). `frontend/.npmrc` sets `install-links=true`
  so `npm install` COPIES those files into `node_modules/duel-game-core`
  instead of the default symlink — this is a static asset canister with
  no build step, so whatever lands in `node_modules/` is what gets
  served, byte for byte, and a symlink may not survive an asset-sync
  step. `npm install` is the only "build" this frontend needs, exactly
  as `mops install` is for the backend. **Gotcha:** because it's a copy,
  not a symlink, a plain `npm install` after editing `../../../frontend/`
  reports "up to date" and does NOT refresh the copy — npm only re-copies
  a local `file:` dependency when it thinks something changed (a version
  bump, or the target simply not existing yet). To force a refresh after
  touching the root package, `rm -rf node_modules/duel-game-core && npm
  install`. `ic-websocket-js` is NOT an npm dependency here — `app.js`
  never imports it; `duel-game-core/ws.js` (see `../../../CLAUDE.md`'s
  toolchain note) is the one place that does, loaded from esm.sh, so no
  bundler is needed to resolve its own dependency tree.

## Build & test

```bash
cd examples/007
mops install                       # fetches duel-game-core (../../backend) + core

# Type-check:
moc --check $(mops sources) src/Duel007Rules.mo
moc --check $(mops sources) src/Host.mo

# Run the test suites (interpreter mode; they Debug.print progress and end
# with "ALL ... CHECKS PASSED"; any trap = a FAIL, exit code 1):
mops test                  # all four
mops test Engine           # one suite — the filter is a path substring
mops test Rules            # ...so this matches Rules AND RulesUnit
```

```bash
# Frontend: fetch the local duel-game-core npm package, then sanity-check
# every JS module parses (no DOM needed to import):
cd frontend
npm install
node --check app.js duel007-plugin.js
```

Deploy (icp-cli; `icp network start` must be running for the local env):

```bash
cd examples/007
icp deploy                 # local  → http://frontend.local.localhost:8000/
icp deploy --network ic    # mainnet — spends cycles
```

Run `npm install` inside `frontend/` before deploying — `icp deploy`
does not do this for you, and the page 404s on
`/node_modules/duel-game-core/*.js` without it.

The asset-canister recipe must be **v2.3.0 or newer**: v2.1.0 syncs with
an `assets` step that icp-cli 1.x rejects ("no longer supports the
`assets` sync step type"). v2.3.0 is the first plugin-based release.

Known-benign warnings: two `M0155` (Nat subtraction may trap) in
`Duel007Rules.mo` — both subtractions are guarded by an explicit `> 0`
check the compiler can't see. Don't "fix" them by removing the guards.

## Architecture rules

This game inherits every rule in `../../CLAUDE.md`'s "Architecture
rules" section (spec passed per call / never stored, the engine owns
time, rules stay pure, `validate` is the only legality gate, etc.) — read
that file first. Two rules specific to this example:

1. **The engine lives in `../../backend` and is never vendored here.**
   `Duel007Rules.mo` and `src/Host.mo` import it as
   `mo:duel-game-core`. If you find yourself copy-pasting engine code
   into this directory to fix something, fix it in `../../backend/src/lib.mo`
   instead and re-run `mops install` here.
2. **The generic screens live in `../../frontend` and are never
   vendored here either.** `duel007-plugin.js` supplies ONLY
   `idlTypes`/`seatLabel`/`renderBoard`/`renderActions`; the lobby,
   staging, rematch, busy, debrief chrome, and the `#endedByOther`
   notice all come from `duel-game-core/render.js` and `app.js`. If a
   screen looks wrong, check whether the fix belongs in
   `../../frontend/render.js` (every game) or `duel007-plugin.js` (just
   this one).

## Game-rule notes (Duel007Rules.mo)

- Seats: `#p1` = BOND, `#p2` = SILVA (names used only in narration and in
  the frontend's `SEAT_NAME` map in `duel007-plugin.js` — keep both in
  sync, since the client's copy is cosmetic-only per CLAUDE.md
  architecture rule 4).
- Laser: charged by 5 CONSECUTIVE loads (`charge` field); firing spends
  the charge, not ammo; pierces shield and mirror. The deployed 007
  backend instead uses "any shot at ammo >= 5 is a laser" — to mimic it,
  change `hasLaser` to `a.ammo >= 5`.
- Shield: 3rd absorbed hit still saves the defender but breaks the
  shield; raising a broken shield is rejected by `validate`.
- Mirror: 3 uses; consumed on use whether or not a shot arrives; reflects
  normal shots only. Both-shoot (any weapon mix) = both die = `#draw`.
- Turn counter counts COMPLETED rounds: a fresh game is `turn == 0`.

## Motoko skills (read before editing)

Local copies of the relevant SKILL.md playbooks live in this repo under
`../../.agents/skills/` — the same set `../../CLAUDE.md` points to.
Consult those before editing `Duel007Rules.mo` or `src/Host.mo`.

## Conventions

- Tests are plain interpreter scripts (moc -r), not a test framework:
  `ok`/`expectErr` helpers + `Runtime.trap` on violation. Extend in kind.
  (In mo:core, `trap` lives in `Runtime`; `Debug` only has `print`.)
- `msg`, not `label`, for text parameters (`label` is a reserved word).
- Update ALL FOUR test suites when touching `Duel007Rules.mo`'s
  semantics.
