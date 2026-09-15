# checkers — reference #alternating game built on duel-game-core

A complete, deployable example game that plugs into the two
`duel-game-core` packages this repo ships (`../../backend`, the Motoko
mops package; `../../frontend`, the npm package). It exists to prove the
engine's `#alternating` (strictly turn-based) mode end to end and to
give a new turn-based game something concrete to copy — `007` and
`racing` are the `#simultaneous` references; this one is not part of
either package itself.

- **`src/CheckersRules.mo`** — standard English draughts as pure
  functions. No actor, no shared functions, no storage, no Time. Plugs
  into the engine via `spec() : TP.Spec<State, Action>`, where `TP` is
  `mo:duel-game-core` (imported from `../../backend` — see `mops.toml`).
  `spec()` returns `#alternating { init; validate; resolve }` — seats
  take turns in order (Black/#p1 moves first), and `State` carries no
  "whose turn" flag of its own because the engine already tracks that
  (see `mo:duel-game-core`'s own `Spec`/`Mode` doc, and
  `../../skills/duel-game-core/references/alternating-turn-games.md`).
  See the module's own doc header for the full rules text and its
  deliberate simplifications against tournament draughts.
- **`src/Host.mo`** — the host actor: forwards every call to a
  `TP.Registry<Rules.State, Rules.Action>` (built with `Registry.new`
  from `mo:duel-game-core/registry`; a multi-table lobby — anyone may
  open a table, open or access-code protected — not a single fixed
  board; see `mo:duel-game-core`'s own doc header) with `Time.now()`
  and `Rules.spec()`, wired exactly as `../../backend/README.md`'s
  example shows — identical shape to `examples/007/src/Host.mo`/
  `examples/racing/src/Host.mo`; nothing about `#alternating` mode
  changes how a host actor is wired. Deploy target. `status` is the
  only plain Candid method on this actor (a `query`, side-effect-free —
  see `../../CLAUDE.md`'s architecture rule 8); `createTable`/
  `joinTable`/`submit`/`rematch`/`leave`/`reset`/`claimWin`/`ackEnded`
  have NO plain Candid method at all — they're reachable exclusively
  through `mo:duel-game-core/ws`'s `ws_message`, which is what
  `frontend/app.js` actually talks to. See `../../backend/README.md`'s
  "Real-time push" section for the full design.
- **`test/*.test.mo`** — interpreter-run suites. `RulesUnit.test.mo`
  drives `validate`/`resolve` directly against synthetic boards (no
  engine, no actor) — the bulk of the rule coverage: forward-only men,
  both-directions kings, mandatory capture, maximal capture chains,
  promotion, win by elimination, win by stalemate. `Engine.test.mo`
  plugs the real rules into the real `Table` primitive, focused on what
  an `#alternating` game specifically exercises through it
  (`Err.#notYourTurn`, claim-win gated to the waiting seat) — the
  engine's own generic `#alternating` mechanics already have their own
  exhaustive suite in `duel-game-core` itself
  (`../../backend/test/Alternating.test.mo`, against a trivial fixture),
  so this isn't a second copy of that. `Lifecycle.test.mo` is one short
  session narrative through the real engine — join, a couple of genuine
  opening moves, then (per
  `../../skills/duel-game-core/references/testing-deep-dive.md`'s
  technique) the live board is seeded directly via `Table.phase`'s own
  public `var` field to a position one legal capture from finishing, so
  the ending itself is still exercised for real. The `*.test.mo` suffix
  is what `mops test` discovers — a file named `FooTest.mo` is silently
  skipped, so keep the suffix when adding suites.
- **`icp.yaml`** — icp-cli manifest; deploys `src/Host.mo` as canister
  `backend` and `frontend/dist` (esbuild's bundled output — see this
  file's "Build & test" section, NOT `frontend/` itself) as an asset
  canister.
- **`frontend/`** — vanilla-JS web client (no framework), bundled with
  esbuild (`npm run build`, see this file's "Build & test" section);
  `duel-game-core` is fetched locally via `npm install`, see below.
  `checkers-plugin.js` is the whole game-specific surface: it implements
  the `GamePlugin` contract (`idlTypes`, `seatLabel`, `renderBoard`,
  `renderActions`) from `../../frontend/README.md`. Interaction is
  click-to-select, not a button list: `renderBoard` draws the 8x8 grid
  from `State.board` and, while `yourTurn` (its own 4th parameter — see
  `GamePlugin`'s doc in `duel-game-core/render.js`), highlights every
  one of the mover's own pieces that has a legal move; clicking one
  highlights its own legal destinations, clicking one of those either
  finishes the move (rendered as a real `<button data-act=...>`, so
  `app.js`'s own generic click handling submits it unchanged) or, for a
  capture that can keep going, advances the selection and highlights the
  next leg (a plain, non-submitting `<div data-sq=...>`), so a
  multi-jump chain is built up one click at a time — mirroring
  `CheckersRules.mo`'s own move generation and mandatory-capture rule
  throughout, the same "cosmetic legality mirror" every `GamePlugin`
  is (see Architecture rule 3 below). All of this selection state lives
  in a local, module-level variable in `checkers-plugin.js` alone — no
  backend change, and the `Action` finally submitted is exactly the same
  `#move`/`#jump` shape as always. The board is drawn flipped 180° for
  Red's own view (`renderBoard`'s own `flip`) so each player always sees
  their own side at the bottom, regardless of seat.
  `renderActions` itself returns nothing (an empty string) — everything
  happens by clicking the board. See
  `../../skills/duel-game-core/references/alternating-turn-games.md` for
  the general pattern a board game's interaction usually takes on this
  framework.
  The generic chrome (`duel-game-core/render.js`) already shows
  turn-accurate copy ("Your turn"/"Opponent's turn") for an
  `#alternating` table with zero plugin-side work. `app.js` calls
  `duel-game-core/identity.js`'s `resolveIdentity()` for this tab's own
  identity/`session` (a real Internet Identity login if active,
  otherwise a fresh throwaway identity — never the plain anonymous
  identity, since `ic-websocket-cdk`'s `ws_open` hard-rejects it), then
  `duel-game-core/ws.js`'s `connectWs({ actor, principal:
  session.principal, gameIdlTypes: plugin.idlTypes })` for the real push
  transport `start()` requires, and `start({ plugin, ws, session })` —
  identical wiring to `examples/007/frontend/src/app.js`, since none of
  that depends on this game's own mode. `style.css` here holds only the
  board-grid visuals, layered on top of `duel-game-core.css` (a copy of
  `duel-game-core`'s own `style.css`, placed in `dist/` by `build.js`,
  loaded first in `index.html`), which supplies the page chrome.

## Toolchain

- moc **1.11.2** (mops toolchain, pinned in `mops.toml`), node/npm for
  the frontend.
- Motoko dependencies: `duel-game-core` (path dependency on
  `../../backend` — see `mops.toml`), `core` (mo:core), and
  `ic-websocket-cdk` (only because `src/Host.mo` opts into
  `mo:duel-game-core/ws` — see `../../CLAUDE.md`'s toolchain note). Never
  import `mo:base` directly in this game's own code — it's the legacy
  library; `ic-websocket-cdk` pulling it in transitively is a
  documented, contained exception, not license to import it yourself.
- The frontend's npm dependencies split the same way `examples/007`'s
  do: `duel-game-core` (`file:../../../frontend`) and `@icp-sdk/core`
  are what `app.js` itself needs; esbuild bundles both, plus everything
  `duel-game-core` needs transitively (`@icp-sdk/auth`, `cborg`), into a
  single `dist/app.js`. `frontend/.npmrc` sets `install-links=true` so
  `npm install` COPIES `duel-game-core` into
  `node_modules/duel-game-core` instead of the default symlink.
  **Gotcha:** because it's a copy, not a symlink, a plain `npm install`
  after editing `../../frontend/` reports "up to date" and does NOT
  refresh the copy — see `../../CLAUDE.md`'s "After touching anything
  under `frontend/`" section for the actual refresh procedure (build the
  clone's own `dist/` first, then either a fast direct `rsync` copy or a
  full reinstall, depending on whether `frontend/package.json`'s own
  dependencies changed), and re-run `npm run build` HERE too afterward.

## Build & test

```bash
cd examples/checkers
mops install                       # fetches duel-game-core (../../backend) + core

# Type-check:
moc --check $(mops sources) src/CheckersRules.mo
moc --check $(mops sources) src/Host.mo

# Run the test suites (interpreter mode; they Debug.print progress and end
# with "ALL ... CHECKS PASSED"; any trap = a FAIL, exit code 1):
mops test                  # all three
mops test Engine           # one suite — the filter is a path substring
mops test Rules            # ...so this matches RulesUnit
```

```bash
# Frontend: build duel-game-core first (its dist/ is what npm install
# actually copies — see this file's own note above), fetch the local
# duel-game-core npm package, then esbuild-bundle this frontend and
# sanity-check the bundled output parses (no DOM needed to import):
(cd ../../frontend && npm run build)
cd frontend
npm install --legacy-peer-deps    # see ../../../frontend/README.md's note on @icp-sdk/auth's peer range
npm run build                     # esbuild bundle → frontend/dist/ (icp.yaml deploys THIS, not frontend/ itself)
node --check dist/app.js
```

Deploy (icp-cli; `icp network start` must be running for the local env):

```bash
cd examples/checkers
icp deploy                 # local  → http://frontend.local.localhost:8000/
icp deploy --network ic    # mainnet — spends cycles
```

Run `npm install && npm run build` inside `frontend/` before deploying —
`icp deploy` does not do this for you, and `frontend/dist/` won't exist
(or will be stale) without it. The asset-canister recipe must be **v2.3.0
or newer**: v2.1.0 syncs with an `assets` step icp-cli 1.x rejects
outright.

Play both seats by opening the deployed URL in two separate browser
tabs — create a table in one, join it from the other, and confirm a
real game (turn alternation, mandatory capture, a multi-jump chain,
promotion, claim-win while waiting on an idle opponent) plays out
correctly. The Motoko tests passing and the frontend building are both
necessary but not sufficient; nothing here automates an actual two-tab
playthrough.

## Architecture rules

This game inherits every rule in `../../CLAUDE.md`'s "Architecture
rules" section (spec passed per call / never stored, the engine owns
time, rules stay pure, `validate` is the only legality gate, etc.) —
read that file first. Rules specific to this example:

1. **The engine lives in `../../backend` and is never vendored here.**
   `src/CheckersRules.mo` and `src/Host.mo` import it as
   `mo:duel-game-core`. If you find yourself copy-pasting engine code
   into this directory to fix something, fix it in
   `../../backend/src/lib.mo`/`table.mo` instead and re-run `mops
   install` here.
2. **The generic screens live in `../../frontend` and are never
   vendored here either.** `checkers-plugin.js` supplies ONLY
   `idlTypes`/`seatLabel`/`renderBoard`/`renderActions`; the multi-table
   lobby, staging, rematch, busy, debrief chrome, and the turn-accurate
   copy for `#alternating` all come from `duel-game-core/render.js` and
   `app.js`. If a screen looks wrong, check whether the fix belongs in
   `../../frontend/src/render.ts` (every game) or `checkers-plugin.js`
   (just this one).
3. **`checkers-plugin.js`'s own `stepTargets`/`jumpTargets` and
   `CheckersRules.mo`'s own move generation are two independent
   implementations of the same rules** — one in Motoko (authoritative),
   one in JS (cosmetic, for deciding what the click-to-select UI
   highlights as legal). If they ever disagree, `CheckersRules.mo` is
   correct and the plugin has a display bug; the engine calls the REAL
   `validate` on every submission regardless of what the board showed as
   clickable. Keep both in sync when the rules change, the same way
   `duel007-plugin.js`'s `legal()` mirrors `Duel007Rules.mo`'s
   `validate`.

## Game-rule notes (src/CheckersRules.mo)

- Board: 8x8, row-major (`index = row*8 + col`), only dark squares
  (`(row+col)` odd) ever hold a piece. Black (`#p1`) starts on rows 5-7
  and moves toward row 0; Red (`#p2`) starts on rows 0-2 and moves
  toward row 7.
- A man moves/captures diagonally FORWARD only; a king does either in
  any of the four diagonal directions.
- Capturing is mandatory whenever any of the mover's own pieces has a
  capture available — a plain `#move` is illegal in that case. A single
  `#jump` submission carries the WHOLE capture chain (see `Action`'s own
  doc) — the chain must be maximal (illegal to stop early while the same
  piece could still capture again).
- A man promotes to king the instant it lands on the far row; mid-chain
  landings on that row do NOT promote (see the module's own "Deliberate
  simplifications" section) — only the chain's final landing square is
  checked.
- A seat with no legal move at all on their own turn loses — whether
  from having zero pieces or every piece being blocked. No draw
  condition is implemented.
- Turn counter (`View.inGame.turn`) counts individual PLIES (one per
  submission), not move-pairs — `#alternating` mode's own convention
  (see `mo:duel-game-core`'s `Spec`/`Mode` doc), different from
  `007`/`racing`'s `#simultaneous` `turn`, which counts resolved rounds
  (one per pair of moves).

## Motoko skills (read before editing)

Local copies of the relevant Motoko-authoring SKILL.md playbooks live in
this repo under `../../.agents/skills/` — the same set `../../CLAUDE.md`
points to (the duel-game-core-specific playbook instead lives in the
tracked `../../skills/duel-game-core/`, whose
`references/alternating-turn-games.md` this example itself is the
worked reference for). Consult those before editing
`src/CheckersRules.mo` or `src/Host.mo`.

## Conventions

- Tests are plain interpreter scripts (moc -r), not a test framework:
  `assert`/`Runtime.trap` on violation (`Engine.test.mo` additionally
  uses the `ok`/`expectErr` helper pair the other examples' suites do).
  Extend in kind. (In mo:core, `trap` lives in `Runtime`; `Debug` only
  has `print`.)
- `msg`, not `label`, for text parameters (`label` is a reserved word).
- Update all three test suites when touching `src/CheckersRules.mo`'s
  semantics, and keep `checkers-plugin.js`'s move-generation mirror in
  sync (see Architecture rule 3 above).
