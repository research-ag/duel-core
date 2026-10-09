# 007 duel — reference game built on duel-game-core

A deployable `#simultaneous` example on `../../backend` and
`../../frontend`. Not part of either package.

- **`src/Duel007Rules.mo`** — the rules as pure functions (no actor, no
  storage, no `Time`), exported as `spec : TP.Spec<State, Action, View,
Options>` (`View = State`, `Options = {}`).
- **`src/Host.mo`** — the host actor, same shape as
  `../checkers/src/Host.mo`: stable `duel` (90s idle timeout, 60s claim
  window), bots store and leaderboard; one transient `env` carrying the
  rules, `BotIface.callBot` and an Elo rating (k=32, every ending
  re-rates both seats, read via `include
LeaderboardActorMixin(leaderboard, 25)`); the transport and
  canister-player mixins, the host's own `duel_create_table`/
  `duel_lobby`/`duel_submit`/`duel_table`, and Prometheus metrics
  (`attachMetrics` + a `/metrics` route on `HttpActorMixin`).
- **`src/BotIface.mo`** — the bot's `make_move` type and `callBot`.
- **`bot/BotLogic.mo`** — `COMPLEXITIES = ["Easy", "Medium"]`.
  `chooseMove(req, entropy)` (`entropy` = `Time.now()` from `Bot.mo`,
  hashed with the seat) picks from `legalActions` (every `Action`
  `validate` accepts) and returns only a move `validate` accepts, LOAD
  as the fallback. Easy: uniform over the legal moves. Medium: a weighted
  random pick over both agents' public stats — LOAD while the opponent
  cannot shoot, shoot when it cannot fail (own laser, or the opponent
  has no usable shield or mirror), shoot for the draw against a laser,
  mirror/shield against an armed opponent. Unknown complexity = Easy.
- **`bot/Bot.mo`** — `make_move` (`query`), `play(...)`, `register`/
  `unregister` (sends `COMPLEXITIES`).
- **`test/*.test.mo`** — `Lifecycle`/`Rules` are scenario walks;
  `RulesUnit` is the per-operation unit suite. `Lifecycle` drives the
  real engine from `../../backend` with these rules plugged in.
  `Bot` proves legality for every stat combination, Medium's tactics,
  Medium beating Easy over full games, and two canister bots playing real
  matches.
- **`icp.yaml`** — deploys `src/Host.mo` as `backend`, `bot/Bot.mo` as
  `bot`, and `frontend/dist` as a static-site canister.
- **`frontend/`** — vanilla JS bundled with esbuild, and the framework's
  CUSTOM-UI reference: nothing from `duel-game-core/app.js` runs here,
  and the look is its own (light paper, typewriter headings, red stamp
  buttons, a sticky sidebar). `duel007-plugin.js` is the `GamePlugin`
  (board and action buttons; `applyLocal` returns the state unchanged);
  `mission-ui.js` draws through `withLocalMove`, so an order shows as
  committed the moment it is sent, and is every screen (the lobby
  as a file index table, one "File it" form with the seat as a radio),
  the sidebar (agent identity, a channel light driven by
  `connection`/`pending`, an in-memory log of the current game's
  round narrations), the alert strip, two native `<dialog>`s, and the
  once-a-second clock patching, all bound to `createDuelClient()`'s
  state (`client.subscribe`) and actions with its own
  `data-op`/`data-key` attributes; `app.js` resolves the
  identity (`resolveIdentity()`), builds the actor and `connectTransport()`
  transport, creates the client, mounts the UI, and wires the 🏆 toggle
  that opens the full-page `#leaderboard-panel` and renders
  `actor.get_leaderboard()` (names from `list_bots()`) via `renderLeaderboard(entries, plugin, {
yourSid })`. Bots are `app.js`'s too: the 🤖 toggle opens
  `#bots-panel` (`renderBotList` over `actor.list_bots()`), and a
  "Engage" button (there or on a leaderboard bot row; `render.js`'s "Challenge" relabelled in `app.js`, styled as a stamp) either fills the
  open seat of the file the player is standing by on, or, from the index,
  asks for a seat in `#challenge-seat` (`renderSeatChoice`), stages an
  open file, and calls the bot's own `play`. The staging screen's "Add a
  bot" (`data-op="add-bot"`, handled through `mountMissionUi`'s
  `onAddBot`; the returned `setInviting` shows "Calling in …") skips the
  seat step. After a rematch the staged file is reserved for the bot, so
  `app.js` re-issues the same `play` from the id/complexity kept in
  `sessionStorage`. `style.css` is self-contained; `duel-game-core.css`
  is not loaded.

## Toolchain

moc 2.0.0 (`mops.toml`). Dependencies: `duel-game-core` (path to
`../../backend`), `core`; `promtracker` arrives transitively. Never import `mo:base`. The frontend depends on
`duel-game-core` (`file:../../../frontend`, copied via `install-links`)
and `@icp-sdk/core`; see `../../CLAUDE.md`'s "After touching anything
under `frontend/`" for the refresh procedure.

## Build & test

```bash
cd examples/007
mops install
moc --check $(mops sources) src/Duel007Rules.mo
moc --check $(mops sources) src/Host.mo
moc --check $(mops sources) bot/Bot.mo
mops test                  # all four; `mops test Rules` matches Rules and RulesUnit

(cd ../../frontend && npm run build)
cd frontend && npm install --legacy-peer-deps && npm run build && node --check dist/app.js && cd ..

icp deploy                 # local; `icp network start` must be running
icp deploy --network ic    # mainnet — spends cycles
```

The `@dfinity/static-site` recipe's `build` step rebuilds
`frontend/dist/` on every deploy; response headers come from
`frontend/src/_headers`.

## Architecture rules

Everything in `../../CLAUDE.md` applies. Additionally:

1. **The engine is never vendored here** — fix it in `../../backend`.
2. **No framework UI code is vendored here.** `mission-ui.js` draws
   from `ClientState` and calls the client; it never reimplements what
   `client.js` does (call serialization, gen stamping, stale resync,
   error lifetime, identity lock). If a screen needs something the state
   lacks, add it to `client.js`.
3. **`mission-ui.js` imports only `client.js` and `esc`.** The point of
   this example is that the rest is the game's own. Bot discovery and
   the challenge flow stay in `app.js`; `mission-ui.js` only exposes the
   `onAddBot` hook and `setInviting`.

## Game-rule notes (src/Duel007Rules.mo)

- Seats: `#p1` = BOND, `#p2` = SILVA (narration and the plugin's
  `SEAT_NAME` only).
- Laser: charged by 5 CONSECUTIVE loads (`charge`); firing spends the
  charge, pierces shield and mirror. (The deployed 007 backend treats any
  shot at ammo >= 5 as a laser; set `hasLaser` to `a.ammo >= 5` to mimic.)
- Shield: the 3rd absorbed hit saves the defender but breaks the shield;
  raising a broken shield is rejected by `validate`.
- Mirror: 3 uses, consumed whether or not a shot arrives; reflects normal
  shots only. Both shoot (any weapon mix) → both die → `#draw`.
- `step` counts COMPLETED rounds; a fresh game is `step == 0`.

## Conventions

Plain interpreter tests (`ok`/`expectErr` + `Runtime.trap`); `msg`, not
`label`; update all four suites when `Duel007Rules.mo`'s semantics
change. Motoko playbooks live in `../../.agents/skills/`.
