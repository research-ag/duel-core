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
  `legalActions(s, seat)` enumerates every legal `Action` for `seat` on
  the current board — the same legality `validate` enforces (only
  `#jump`s, each already carrying its full maximal chain, when a capture
  is mandatory), exported specifically so a caller doesn't have to
  re-derive those rules itself; `BotLogic.mo`'s canister player is its
  first real consumer, but it's plain, pure, reusable data either way.
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
  "Real-time push" section for the full design. `Host.mo` also wires
  Prometheus-style metrics onto the registry via
  `Registry.attachMetrics(pt)` (`pt : mo:promtracker`'s `Tracker`),
  rendered at a `/metrics` endpoint (`include
Http(renderer.renderExposition, "/metrics")`, from
  `mo:promtracker/mixins/http` — the same kind of `mixin` as
  `mo:duel-game-core/actor_mixin`) alongside `PT.allSystemMetrics`
  (cycles/RTS metrics, no `Tracker` of its own needed). Unlike `ws.mo`,
  this is entirely optional instrumentation — see
  `../../backend/README.md`'s "Metrics" section for the metrics it
  exposes and the full reasoning.
  `Host.mo` also wires canister players (`mo:duel-game-core/canister_players`,
  see `../../CLAUDE.md`'s "Canister players" note): `CanisterPlayers.attach`
  shares this same `registry` and reuses `attached.afterMutation` (`Ws.attach`'s
  own push fan-out) so a bot's move reaches a human opponent's browser in
  real time, same as `ws.mo` itself; the `callBot` closure passed to it
  recovers which bot canister to call via
  `CanisterPlayers.principalOfCanisterSession(session)` (`sidForCanister`'s
  own inverse), then makes the actual `await bot.make_move(req)`
  inter-canister call (a `try`/`catch` around it, since `Rules.Action` is
  concrete only here — see `CanisterPlayers.attach`'s own doc for why
  that can't live inside the module). `create_table_as_canister`/
  `join_table_as_canister`/`leave_as_canister`/`ack_ended_as_canister`/
  `claim_win_as_canister`/`reset_as_canister` — plus `register_bot`/
  `unregister_bot`/`list_bots` (bot DISCOVERY, see below) — all come from
  one `include CanisterPlayersActorMixin(cpAttached, botDirectory, ?leaderboard)`
  (`mo:duel-game-core/canister_players_actor_mixin`, the
  `canister_players.mo` counterpart to `ActorMixin` above; `botDirectory`
  is a plain, stable `CanisterPlayers.BotDirectory` field this actor owns
  directly, `CanisterPlayers.newBotDirectory()`) — no
  hand-declared forwarding methods here; each of the six `*_as_canister`
  ones derives the caller's
  `cp:` session from `msg.caller` AND the `tableId` it names (never
  client-supplied — nothing to spoof), since the same bot canister may
  hold a live seat at more than one table at once — see
  `../../CLAUDE.md`'s "Canister players" note on per-board identity;
  there is no `rematch_as_canister`, since a canister-vs-canister
  debrief auto-acks both sides unconditionally the moment neither is a
  live human still deciding, and there is no `submit_as_canister` at
  all, since a canister
  player's move only ever arrives as the direct reply to a call this
  module made, never a separately-arriving request. `Host.mo` also wires
  `Ws.attach`'s own optional `onSettled` parameter to `cpAttached.settle`
  through a small mutable indirection (breaking the circular dependency
  between the two `attach` calls — see `canister_players.mo`'s own doc
  header for why), so a HUMAN's own move/leave/rematch asks a canister
  opponent to move (or acks its own finished debrief) the instant that
  human's own action makes it due — for an `#alternating` game like this
  one, that's whichever ONE seat is currently on turn, never both at once
  (see `canister_players.mo`'s own `dueRequest` doc on why `youSubmitted`
  already means the right thing in either mode). A canister-driven
  mutation reaches the same `settle` directly, in-line, with no
  `onSettled` hop needed. The one case neither eager path reaches — a
  stalled opponent's silence — is covered by `armClaimCheck`, a host
  closure using `Timer.setTimer`'s own `<system>` capability to schedule
  exactly one precisely-timed wakeup back into `settle`, claiming the win
  automatically on behalf of any canister seat that's the WAITING one
  once it's entitled to (the unattended, canister-vs-canister case
  included, since it fires the same way regardless of who the opponent
  is); `claim_win_as_canister`/`reset_as_canister` exist mainly so a
  canister participant can act the instant it's entitled to instead of
  waiting on that wakeup. `cpAttached.sweep` — the slow, full-registry
  safety net for whatever `settle` never gets called for — is folded into
  the SAME already-mandatory 5-minute idle-sweep timer `ActorMixin` runs, so
  none of this costs a separate timer of its own.
  `Host.mo` also wires an ELO leaderboard: a stable
  `leaderboard : Leaderboard.Board` field (`mo:duel-game-core/leaderboard`,
  `Leaderboard.new(50, STARTING_ELO)` — 50 kept, 25 shown;
  `STARTING_ELO = 1200` is this game's OWN local constant, since
  `mo:duel-game-core/elo` takes no view on a new player's starting
  rating), filled in by an `onGameEnded` closure wired to `Ws.attach`'s
  own optional parameter of that name — every ending
  (`#finished`/`#claimed`/`#aborted` alike, and mode-agnostic: this reads
  only `Debrief.end`, never `finalGame`, so it works the same way for
  this `#alternating` game as it does for `#simultaneous` ones) maps to a
  win/loss/draw `Elo.Outcome` (`mo:duel-game-core/elo`), re-rating both
  seats via `Elo.update` (`k = 32`) against `Leaderboard.scoreOf`'s own
  current ratings — and read back through `get_leaderboard()`, supplied
  by `include LeaderboardActorMixin(leaderboard, 25)`
  (`mo:duel-game-core/leaderboard_actor_mixin`), no hand-declared query
  needed. A local `playerKey` wrapper
  special-cases a `cp:` canister-player session down to
  `CanisterPlayers.leaderboardKeyOfSession(sid)`
  before falling back to `Ws.playerKey` for everything else — the one
  place this actor already has both `Ws`/`CanisterPlayers` wired — so each
  of a bot's complexities is rated on its own ("Hard" apart from "Easy")
  and that rating accumulates across every table it plays instead of
  resetting per board — the SAME `leaderboardKey(p, complexity)`
  convention `list_bots()` itself joins each complexity's own `elo` with
  (see the "Canister players" note above), so a bot's leaderboard rows
  and its own rows in the "🤖 Bots" dialog always agree. See `../../backend/README.md`'s "Leaderboard"
  section for the full worked example this Host.mo follows.
- **`src/BotIface.mo`** — the `CanisterPlayer` Candid interface a checkers
  canister player must implement: one method, `make_move : (TP.MoveRequest<Rules.State, Rules.Action>)
-> async Rules.Action`, the exact counterpart to a browser's own
  `GamePlugin`. Lives in `src/`, not `bot/`, because it's `src/Host.mo`
  (the GAME canister) that imports it — to type the remote bot actor it
  calls — not `bot/Bot.mo`/`bot/BotLogic.mo` (the bot canister), which
  never import it at all.
- **`bot/BotLogic.mo`** — the checkers bot's move-selection logic, as a
  plain pure module (no actor, no `Time`, matching `CheckersRules.mo`'s
  own style): `chooseMove` reuses `CheckersRules.legalActions` directly
  (never re-deriving mandatory-capture/maximal-chain itself) and picks one
  result deterministically from `req.turn` and the position — no
  lookahead, no material evaluation, the milestone-02 baseline. Kept
  separate from `Bot.mo` specifically so `test/Bot.test.mo` can call
  `chooseMove` directly, with no actor/Candid round-trip.
- **`bot/Bot.mo`** — the bot canister itself: implements
  `BotIface.CanisterPlayer`'s `make_move` as a `query` (a thin shell over
  `BotLogic.chooseMove` — pure and stateless, so there's nothing an
  update call's replication would buy it), plus
  `play(host, tableId, seat, code, complexity)`, this bot's own Flow 1 "self-join"
  entry point (see the canister-players design's "Lobby & opponent
  selection" section) — hand it a checkers `Host.mo`-shaped canister's
  id, a table id, a seat, and that table's access code (however you like;
  entirely outside this engine's concern), and it calls that canister's
  own `join_table_as_canister` on its own account. Deploy target (see
  `icp.yaml` below). Because every reply is drawn from `legalActions`,
  this bot can never submit an illegal move, even without any lookahead
  of its own. This same `play` method is also what the frontend's own
  "🤖 Bots" challenge dialog calls directly, on whichever bot a player
  picked (see the `frontend/` bullet below) — a plain Candid call from
  the browser straight to that canister, not routed through
  `Host.mo`/`ws.mo` at all. `Bot.mo` also implements
  `register(host, name)`/`unregister(host)`, mirroring `play`'s own
  `(host, ...)` shape: each forwards to `host`'s own
  `register_bot`/`unregister_bot` — `register` with an empty complexity
  list, since this bot has one way to play and is listed under "Default"
  (`examples/tic-tac-toe/bot/` is the two-way reference) — (see the `src/Host.mo` bullet above's
  own "Canister players" note) so this bot becomes discoverable in the
  first place — a one-time call made by hand after both this canister and
  its host are deployed
  (`icp canister call bot register '(principal "<backend-canister-id>", "CheckersBot")'`),
  not something the frontend ever triggers.
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
  the ending itself is still exercised for real. `test/Bot.test.mo`
  covers `BotLogic.mo`: it confirms `chooseMove` only ever returns a
  `CheckersRules.legalActions`-listed move on a handful of synthetic
  positions (including one with a mandatory capture, where exactly one
  result exists at all) with no engine involved, then separately wires
  `BotLogic.chooseMove` through a live `mo:duel-game-core/canister_players`
  as the `callBot` continuation (no real second canister needed for
  this — see the file's own doc header) so TWO canister-seated bots play
  each other through several real `#alternating` plies — the specific
  proof this milestone calls for: `#p1` moving first, then the due seat
  correctly alternating as the turn passes. The `*.test.mo` suffix
  is what `mops test` discovers — a file named `FooTest.mo` is silently
  skipped, so keep the suffix when adding suites.
- **`icp.yaml`** — icp-cli manifest; deploys `src/Host.mo` as canister
  `backend`, `bot/Bot.mo` as canister `bot` (this example's own
  milestone-02 canister player — see that file's own doc header), and
  `frontend/dist` (esbuild's bundled output — see this
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
  `app.js` also wires a small "🤖 Bots" control (`index.html`'s
  `#bot-challenge-toggle`, header, beside `#leaderboard-toggle`, opening
  `#bot-challenge-panel` — a full-page overlay sibling of `#screen`,
  styled entirely by the shared `duel-game-core/style.css`, not this
  game's own) — the human-facing DISCOVERY + challenge entry point for
  whichever bots have self-registered with this deploy's own `backend`
  canister (see `../../CLAUDE.md`'s "Canister players" note, "Bot
  discovery"): clicking it calls `actor.list_bots()` (a plain Candid
  query, no `ws` round-trip) and renders the ranked result via
  `duel-game-core/render.js`'s `renderBotList(bots, plugin)`; a bot's own
  row in the leaderboard panel below (`renderLeaderboard`'s own Challenge
  button) reaches the exact same flow. Picking a bot either fills THIS
  player's own already-staged table directly (if they're on the "Waiting
  for an opponent" screen — `render.js`'s `stagingYou`, tracked off a
  `ws.addEventListener("message", ...)` listener, the same
  `GatewayWs`-as-`EventTarget` technique the duel-game-core skill's
  rich-UI pattern describes) or, otherwise, shows a seat-choice step
  (`duel-game-core/render.js`'s `renderSeatChoice(plugin)`) and issues a
  `createTable` request directly over the shared `ws` (`ws.request`, a
  correlatable, scoped-reply call — still the one `ws.mo` channel, not a
  second transport) to create one first. Either way, the final step is
  the same plain Candid call Flow 1 always used — straight to the CHOSEN
  bot's own `play(host, tableId, seat, code, complexity)` (built from
  `duel-game-core/idl.js`'s exported `buildBotPlayIdlFactory`, so `Seat`/
  `TableId`/`Err` aren't redeclared by hand, and never routed through
  `ws.mo`'s protocol) — the bot then joins on its own account via
  `join_table_as_canister`, exactly Flow 1's "self-join" shape, just
  aimed at whichever canister id a player actually picked rather than a
  `PUBLIC_CANISTER_ID:bot` env var (this frontend hardcodes no bot
  canister id anywhere). The generic chrome (`duel-game-core/render.js`) already shows
  turn-accurate copy ("Your turn"/"Opponent's turn") for an
  `#alternating` table with zero plugin-side work. `app.js` calls
  `duel-game-core/identity.js`'s `resolveIdentity()` for this tab's own
  identity/`session` (a real Internet Identity login if active,
  otherwise a persisted, non-spoofable anonymous keypair — never the
  plain anonymous identity, since `ic-websocket-cdk`'s `ws_open`
  hard-rejects it), then
  `duel-game-core/ws.js`'s `connectWs({ actor, principal:
session.principal, gameIdlTypes: plugin.idlTypes })` for the real push
  transport `start()` requires, and `start({ plugin, ws, session })` —
  identical wiring to `examples/007/frontend/src/app.js`, since none of
  that depends on this game's own mode. `style.css` here holds only the
  board-grid visuals, layered on top of `duel-game-core.css` (a copy of
  `duel-game-core`'s own `style.css`, placed in `dist/` by `build.js`,
  loaded first in `index.html`), which supplies the page chrome.
  `app.js` also wires a header 🏆 toggle button (`index.html`'s
  `#leaderboard-toggle` — icon-only, no "Leaderboard" label, positioned
  FIRST in `.session`, before the Player ID — that opens
  `#leaderboard-panel`, a full-page overlay sibling of `#screen`, not a
  small inline panel, so the generic chrome's own live status pushes
  updating `#screen` underneath can never clobber it) that, on click,
  calls the SAME `actor` `start()` already uses for
  `actor.get_leaderboard()` — a plain Candid `query`, no `ws` round-trip
  — fetched alongside `actor.list_bots()` (same class of query,
  tolerantly `.catch`'d to an empty array so a `list_bots()` failure
  never breaks the leaderboard itself) purely so a bot's own row can show
  its self-reported `name` instead of a bare principal, and renders the
  result via `duel-game-core/render.js`'s
  `renderLeaderboard(entries, plugin, { yourSid: session.sid, botNames })`
  (`botNames` a `Map<string, string>` from bot principal text to name),
  which badges the caller's own row ("You") if they're on the ranked
  list; `#leaderboard-back` (inside the overlay) closes it back to
  `#screen`.
  `checkers-plugin.js` supplies no `formatScore` of its own, so
  `renderLeaderboard`'s default (the plain ELO integer) is already
  correct.

## Toolchain

- moc **1.11.2** (mops toolchain, pinned in `mops.toml`), node/npm for
  the frontend.
- Motoko dependencies: `duel-game-core` (path dependency on
  `../../backend` — see `mops.toml`), `core` (mo:core), `ic-websocket-cdk`
  (only because `src/Host.mo` opts into `mo:duel-game-core/ws`), and
  `promtracker` (only because `src/Host.mo` opts into the metrics wiring
  described above) — see `../../CLAUDE.md`'s toolchain note for both of
  the latter. Neither is listed under `mops.toml`'s own `[dependencies]`
  here — both arrive transitively through `duel-game-core`'s own
  `mops.toml`, same as `ic-websocket-cdk` already did before promtracker
  existed; `mops sources` resolves the whole tree regardless of which
  `mops.toml` first declared a package. Never import `mo:base` directly
  in this game's own code — it's the legacy library; `ic-websocket-cdk`
  pulling it in transitively is a documented, contained exception, not
  license to import it yourself. `src/Host.mo`'s third opt-in,
  `mo:duel-game-core/canister_players`, needs nothing further: that
  module depends on nothing but `core` and its sibling engine modules,
  already pulled in regardless.
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
mops test                  # all four
mops test Engine           # one suite — the filter is a path substring
mops test Rules            # ...so this matches RulesUnit
mops test Bot              # BotLogic.mo, offline and wired through canister_players
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

`icp.yaml`'s asset-canister recipe declares `npm run build` (inside
`frontend/`) as a `build` step, so `icp build`/`icp deploy` runs it
automatically and `frontend/dist/` is always rebuilt from current
source before syncing. `npm install --legacy-peer-deps` is still a
separate, manual step that populates `frontend/node_modules` in the
first place — the automatic `build` step only re-bundles from whatever
is already installed there, it doesn't run `npm install` for you (see
this file's own toolchain note above on when to re-run it). The
asset-canister recipe must be **v2.3.0 or newer**: v2.1.0 syncs with an
`assets` step icp-cli 1.x rejects outright.

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
`src/CheckersRules.mo`, `src/Host.mo`, or `bot/Bot.mo`/`bot/BotLogic.mo`.

## Conventions

- Tests are plain interpreter scripts (moc -r), not a test framework:
  `assert`/`Runtime.trap` on violation (`Engine.test.mo` additionally
  uses the `ok`/`expectErr` helper pair the other examples' suites do).
  Extend in kind. (In mo:core, `trap` lives in `Runtime`; `Debug` only
  has `print`.)
- `msg`, not `label`, for text parameters (`label` is a reserved word).
- Update `RulesUnit.test.mo`/`Engine.test.mo`/`Lifecycle.test.mo` when
  touching `src/CheckersRules.mo`'s semantics (including `legalActions` —
  it must keep returning exactly what `validate` would accept), and keep
  `checkers-plugin.js`'s move-generation mirror in
  sync (see Architecture rule 3 above).
