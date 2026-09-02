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
  `mo:duel-game-core/Ws` side by side with the 7 plain methods — this
  IS what `frontend/app.js` talks to (`duel-game-core/ws.js`'s
  `GatewayWs`, a real `ic-websocket-cdk` client that self-registers each
  tab as its own Gateway, not client-side polling), for genuine
  canister-driven push and real close-detection-driven disappearance
  handling. See `../../backend/README.md`'s "Real-time push" section.
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
  `../../frontend/README.md`. `app.js` builds the actor and this tab's
  own `principal` — an Ed25519 identity DERIVED from this tab's sid
  (`getOrCreateSid()`, from `duel-game-core/app.js`; `seedFromSid()`
  SHA-256-hashes it into the 32-byte seed `Ed25519KeyIdentity.generate()`
  wants), not the plain anonymous identity `HttpAgent.create({ host })`
  defaults to. This game has no login, but `ic-websocket-cdk`'s
  `ws_open` hard-rejects an anonymous caller outright, so building
  `agent` with no `identity` at all breaks the WS handshake completely
  (there's no polling fallback) — see
  `../../frontend/README.md`'s "Real-time push" section for why, and why
  deriving from `sid` rather than a fresh keypair per load also keeps
  the same principal across a plain reload. Then calls
  `duel-game-core/ws.js`'s `connectWs({ actor,
  principal, gameIdlTypes: plugin.idlTypes })` for the real push
  transport `start()` requires (see `../../frontend/README.md`'s
  "Real-time push" section) — this game's own code never touches
  `mo:duel-game-core/Ws`'s protocol directly (`duel-game-core/ws/
  gateway-*.js` does, registering this tab as its own WS Gateway) or
  imports any third-party library itself; `index.html`'s import map
  resolves `duel-game-core`'s own `@dfinity/candid`/`cborg` dependencies
  (bare specifiers a raw browser can't resolve on its own — see that
  file's comment) — and calls `start({ plugin, ws })` — every screen
  that's the same for every game (lobby, staging, rematch, busy
  countdown, debrief chrome, session identity, push) comes from the npm
  package. There is no polling fallback anywhere in this stack any more —
  `ws` is required, `start()` throws without one (`duel-game-core/ws/
  poller.js`'s `PollingWs` remains available as an explicit opt-in if a
  canister ever needs the dependency-free fallback instead). `style.css`
  here holds only 007-specific visuals (narration box, agent stat panels,
  resource pips), layered on top of `node_modules/duel-game-core/style.css`
  (loaded first in `index.html`), which supplies the page chrome and the
  CSS custom properties this file reuses.

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
- The frontend's direct npm dependency is `duel-game-core` itself, pulled
  in as a `file:../../../frontend` dependency (see
  `frontend/package.json`). `frontend/.npmrc` sets `install-links=true`
  so `npm install` COPIES those files into `node_modules/duel-game-core`
  instead of the default symlink — this is a static asset canister with
  no build step, so whatever lands in `node_modules/` is what gets
  served, byte for byte, and a symlink may not survive an asset-sync
  step. `npm install` is the only "build" this frontend needs, exactly
  as `mops install` is for the backend. **Gotcha:** because it's a copy,
  not a symlink, a plain `npm install` after editing `../../../frontend/`
  reports "up to date" and does NOT refresh the copy. See
  `../../../CLAUDE.md`'s "After touching anything under `frontend/`"
  section for the actual refresh procedure (a fast direct `rsync` copy
  in the common case; a full `node_modules`+lockfile reinstall only if
  `frontend/package.json`'s own `dependencies` changed) — do this
  proactively after any change there, not just when asked to deploy.
  `duel-game-core/ws.js` (see `../../../CLAUDE.md`'s toolchain
  note) talks to `mo:duel-game-core/Ws`'s real `ic-websocket-cdk`
  protocol, and pulls in `@dfinity/candid`/`cborg` transitively through
  `duel-game-core`'s own `package.json` (a normal `npm install` picks
  them up — nothing to add here) — resolved in the browser via
  `index.html`'s import map, since bare specifiers deep inside a COPIED
  `node_modules/duel-game-core` file have no other way to resolve.

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
