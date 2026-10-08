# duel-game-core — generic 2-player session engine + client

Two rules-agnostic packages, both named `duel-game-core` (one per
registry), for 2-player games on the Internet Computer. A game is either
`#simultaneous` (both seats act every round) or `#alternating` (seats
take turns), chosen by the `Mode` tag on its `Spec`. Neither package
knows any particular game.

- **`backend/`** — the Motoko mops package. `src/types.mo` defines the
  shared type surface (`Spec`, `Seat`, `Phase`, `View`, `Err`, `Res`,
  `Table`, `Registry`, ...), re-exported by `src/lib.mo`
  (`mo:duel-game-core`). Modules, each on its own import subpath:
  - `table.mo` — the single-table primitive: `Table.new` plus
    `join`/`submit`/`rematch`/`leave`/`reset`/`claimWin`/`ackEnded`/
    `status`/`sweep`.
  - `registry.mo` — the multi-table router built on it: `Registry.new`,
    `createTable`/`createTableReserving`/`listTables`/`joinTable`/
    `peekNextTableId`, the same caller-facing operations routed to the
    right table, `sweep`, `setTimeouts` (every host calls it on the line
    after the declaration: a stable `registry` skips `Registry.new` on
    upgrade), and the optional `attachMetrics(pt)` (`mo:promtracker`). Tables are `#open` or `#code`-protected, carry an
    opaque `variant : Text` picked by their creator and read only by
    the game's own `Spec.init(variant)`. No game logic is reimplemented
    here.
  - `transport.mo` — MANDATORY. One update (`duel_request`, whose reply
    is the caller's fresh status) and one polled query (`duel_poll`,
    answering from a per-session `rev` in the transient `Hub`; nothing
    is queued). It is the only transport that can mutate game state: no
    `Registry` mutating operation is a plain Candid method on a host;
    `status` is the one plain `query`. Also drives disappearance
    handling (a `#bye` implicitly leaves after a grace; silence only
    ends presence, checked lazily against `PRESENCE_TTL_NS`) and offers
    optional hooks `onSettled`/`onGameEnded`/`onGameStarted`.
  - `actor_mixin.mo` — `include ActorMixin<system>(endpoint, sweepFunc)`:
    `duel_request`/`duel_poll` plus the 5-minute idle-sweep timer.
  - `canister_players.mo` — OPTIONAL. Lets a canister take a seat under a
    third sid namespace `cp:<principal>:<tableId>:<complexity>`
    (`sidForCanister`), one session per board, derived from
    `msg.caller` so nothing is spoofable. The game canister calls the
    bot's `make_move` and treats the reply as the move (`registry.submit`
    via the same `afterMutation` fan-out `transport.mo` uses); silence, a trap,
    or a still-illegal move after one retry leaves the ordinary timeout
    machinery to act. `settle(now, id)` asks a due seat, claims a win for
    an overdue WAITING seat, or acks a finished debrief once no live
    human partner is still deciding; `armClaimCheck` (host-supplied,
    `Timer.setTimer`) schedules the one wakeup nothing else triggers.
    `sweep` is the slow full-registry fallback, folded into the existing
    idle-sweep timer. Also holds bot DISCOVERY: `BotDirectory`,
    `registerBot`/`unregisterBot`/`listBots`/`rankedBots`,
    `leaderboardKey(p, complexity)`/`leaderboardKeyOfSession` (the
    per-bot, per-complexity leaderboard key every `Host.mo` uses).
  - `canister_players_actor_mixin.mo` — `include
CanisterPlayersActorMixin(cpAttached, botDirectory, ?leaderboard)`:
    the six `*_as_canister` methods (create/join/leave/ack_ended/
    claim_win/reset — each taking an explicit `tableId`; no
    `submit_as_canister`, no `rematch_as_canister`) plus
    `register_bot(name, complexities)`/`unregister_bot()`/`list_bots()`.
  - `http.mo`, `wasm.mo`, `http_actor_mixin.mo` — MANDATORY. `include
HttpActorMixin(routes)` supplies `http_request` over plain-text
    `(path, () -> Text)` routes; every host routes `/semantics` to its
    rules module's `SEMANTICS` text (`/metrics` and game data such as
    racing's `/track` ride the same list). `Http.respond` is the pure
    router. The same mixin serves the canister's own wasm: a stable
    `Wasm.Store` holds the canister's own module, filled by the
    controllers-only `wasm_upload_begin`/`wasm_upload_chunk`/
    `wasm_upload_commit(size)` that `publish_wasm.sh` calls from the
    `icp.yaml` sync step, and streamed to anyone at `GET /wasm`
    (`http_request_streaming_callback`).
  - `leaderboard.mo`, `elo.mo`, `leaderboard_actor_mixin.mo` — OPTIONAL,
    game-agnostic. A top-N highest-first `Board` (`new(keep,
defaultScore)`, `setScore`, `recordIfBetter`, `scoreOf`, `top`), the
    pure chess-ELO `update`, and `include LeaderboardActorMixin(board,
n)` supplying `get_leaderboard`. Filled from `Transport.attach`'s
    `onGameEnded`/`onGameStarted` hooks. A lower-is-better metric is
    converted to higher-is-better by the game before storing.
    See `backend/README.md` for the `Spec<S, M>` contract and full wiring.
- **`frontend/`** — the npm package (TypeScript in `src/`, ships
  compiled `dist/`), in three layers. `client.js` is the headless
  client: `createDuelClient({ ws, session })` owns the transport, the
  current `Status`, the one call in flight, error lifetime, the identity
  lock, and the stale-view resync, and publishes immutable `ClientState`
  snapshots; no DOM, no HTML. Its pure `withLocalMove` overlays a
  pending submit through the optional `GamePlugin.applyLocal`, so every
  UI shows the player's own move before the reply. `render.js` is the default UI: one pure
  `view -> HTML` function per generic screen (lobby/staging/rematch/
  busy/debrief/...), collected in `defaultScreens`, plus
  `renderLeaderboard`/`renderBotList`/`renderSeatChoice`, which a game
  mounts itself. `app.js` is the default shell: `start({ plugin, ws,
session, screens?, confirm?, promptCode? })` binds client to screens in
  `#screen` (delegated clicks, spinner, countdowns, header controls,
  error banner, overlays) and returns the client. Also session identity,
  the `DuelTransport` client (`transport.js`: serialized
  `duel_request`s, a 500 ms `duel_poll` loop with a 3 s per-poll timeout, a `#status` heartbeat
  after 120 s of quiet), and Candid IDL scaffolding (`idl.js`, which also declares
  `get_leaderboard`/`register_bot`/`unregister_bot`/`list_bots`
  unconditionally, and `buildBotPlayIdlFactory` for calling a discovered
  bot's `play`). See `frontend/README.md` for the `GamePlugin` contract,
  "Replacing screens", and "The headless client".
- **`backend/test/*.test.mo`** — interpreter suites (`mops test`
  discovers the `.test.mo` suffix only). `Engine`/`Lifecycle` cover
  `table.mo`; `Lobby`/`LobbyLifecycle` cover `registry.mo` (including
  `createTableReserving`); `Alternating` covers `#alternating` mode;
  `Hub`/`TransportBroadcast` cover `transport.mo`'s pure helpers
  (`attach` itself needs a real actor); `CanisterPlayers` covers
  `canister_players.mo` with stubbed `afterMutation`/`armClaimCheck`;
  `Leaderboard`/`Elo`/`Http`/`Wasm` cover their modules directly. `FakeGame.mo`/
  `FakeTurnGame.mo` are throwaway specs for these suites.
- **`backend/bench/engine.bench.mo`** — `mops bench`, engine overhead
  only.

`examples/` holds reference games, each a pure rules module + thin host
actor + `GamePlugin` frontend + deploy config, with its own `CLAUDE.md`:
`007`, `racing`, `rock-paper-scissors` (`#simultaneous`); `checkers`,
`tic-tac-toe`, `ultimate-tic-tac-toe`, `chopsticks` (`#alternating`).
`rock-paper-scissors` (Classic/Well, gated in `validate`) and
`chopsticks` (Classic/Instructables, branching in `validate` and
`resolve`) are the table-variant references. `007` and `chopsticks` are
the custom-UI references (every screen their own, over `client.js`
alone; `chopsticks` is a port of an existing app's design, with an
opponent-move replay and a client-side move history);
`rock-paper-scissors` replaces one screen through `start({ screens })`.
Every example but `racing` (whose 3D scene is its own) keeps the
opponent's last move visible, debrief included, and implements
`applyLocal`.
All ship a `bot/` canister player; `007` (`["Easy", "Medium"]`), `tic-tac-toe` (`["Easy", "Hard"]`) and
`chopsticks` (`["Bunny", "Fox", "Bear"]`) are the multi-complexity
references. A real game lives in its own repo with the same layout —
start from `skills/duel-game-core/SKILL.md`.

`aggregator/` is a separate product (Internet Identity login, developer
profiles, a public registry of games) built on the same tooling, not a
game on the engine. See `aggregator/CLAUDE.md`.

## Toolchain

- moc **1.11.2** (pinned in `backend/mops.toml` and every example but
  `examples/racing`, which pins 1.14.0) type-checks and tests everything
  in this repo, `mixin` declarations included.
- Engine code is `mo:core` only — never `mo:base`. `types.mo`/
  `registry.mo` import `promtracker` (opt-in wiring, always-compiled
  dependency); nothing else has a third-party dependency.
  Any new module needs the same "why not in lib.mo" scrutiny before
  growing a dependency.
- `bench-helper`, `pocket-ic`, `wasm-opt` are dev-only, for `mops bench`.
- Frontend: `app.js`, `render.js`, `idl.js`, `ic-env.js` have zero npm
  dependencies. `transport.js` depends on `@icp-sdk/core/candid`;
  `identity.js` on `@icp-sdk/auth` + `@icp-sdk/core/identity`;
  `anon-identity.js` on `@icp-sdk/core/identity` only. Nothing else may
  grow a dependency.

## Build & test

```bash
cd backend
mops install
moc --check $(mops sources) src/lib.mo
mops test                  # all suites; "ALL ... CHECKS PASSED", any trap = fail
mops test Engine           # filter is a path substring
mops bench
```

```bash
cd frontend && npm install --legacy-peer-deps && npm run build && npm test
node --check dist/app.js dist/render.js dist/idl.js dist/ic-env.js dist/transport.js dist/identity.js dist/anon-identity.js
```

`--legacy-peer-deps` is needed everywhere `duel-game-core` is installed:
`@icp-sdk/auth` declares a peer range on `@icp-sdk/core@^5`, one major
behind the `^6.1.0` actually used.

### After touching anything under `frontend/`: refresh every example

`frontend/dist/` is gitignored and produced by `npm run build`. Each
example's `frontend/.npmrc` sets `install-links=true`, so
`duel-game-core` is COPIED into its `node_modules`, and npm treats a
`file:` dependency as up to date whenever the version matches — a plain
`npm install` after editing `frontend/` silently keeps stale code. The
examples' `allowScripts` gate also blocks `duel-game-core`'s `prepare`
script, so nothing rebuilds `dist/` for you. Do this every time,
unprompted:

```bash
cd frontend && npm run build && cd ..
for ex in examples/*/frontend; do
  target="$ex/node_modules/duel-game-core"
  rsync -a --delete frontend/dist/ "$target/dist/"
  cp frontend/package.json frontend/style.css frontend/README.md "$target/"
  (cd "$ex" && npm run build)
done
```

If `frontend/package.json`'s `dependencies` changed, the copy is not
enough — wipe and reinstall each example (`rm -rf node_modules
package-lock.json && npm install --legacy-peer-deps`); a stale lockfile
entry otherwise makes npm skip the new sub-dependencies. Verify with
`ls node_modules/<new package>`.

`./deploy_examples.sh` builds `frontend/`, reinstalls each example, and
deploys all of them to the IC.

## Architecture rules (violating these reintroduces shipped bugs)

1. **Spec is passed per call, never stored.** Function values are not
   stable; every engine entry point takes `spec` as a parameter.
2. **The engine owns time.** `now : Int` (ns) is a parameter everywhere;
   `lib.mo`/`types.mo`/`table.mo`/`registry.mo` never import `Time`.
   `transport.mo`, `actor_mixin.mo`, `canister_players.mo`, and the mixins play
   the host's role and call `Time.now()` themselves.
3. **Rules stay pure.** `init`/`validate`/`resolve` build new records,
   never mutate.
4. **`validate` is the only legality gate.** Called for both seats on
   every submission; a client's disabled buttons are cosmetic.
5. **Every phase carries a timestamp** (`since`/`lastActivity`) so idle
   eviction works from any phase.
6. **Rematch is create-then-join.** A rematch stages the SAME table with
   `reservedFor = partner` (or unreserved if the partner already acked
   the debrief); the partner's `rematch`/`join` matches that staging;
   `leave` while reserved declines it. Actor serialization makes
   simultaneous clicks race-free. Never replace with flag-and-poll.
7. **No silent endings.** `leave` from a live game gives both a shared
   `#aborted` debrief; `claimWin` (after `claimTimeoutNs`, never
   automatic, only the WAITING seat) gives `#claimed`; an idle takeover
   records the evicted players in `lastEnded` so `status` shows
   `#endedByOther` until acked (a takeover of an expired debrief
   pre-acks them). `Table.pruneEnded` drops a notice nobody will ever
   ack, since `gcIfQuiesced` refuses to drop a table with an outstanding
   notice.
8. **`status` is side-effect-free** — a host exposes it as a `query`.
   Lazy idle resets happen only in mutating calls.
9. **Pending moves are hidden by construction**: `status` exposes only
   Booleans about the opponent's pending move.
10. **The frontend never assumes an agent-loading strategy.** `start()`
    and `createDuelClient()` take a required WebSocket-shaped `ws` and a
    required `session` built by the game; they import no agent, no CDN,
    and know no other transport.
11. **`transport.mo` is the sole mutation entry point and reimplements no game
    logic.** Every request dispatches to `Registry`'s operations; none
    is also a plain Candid method. The `*_as_canister` methods are the
    one deliberate exception, reachable only under the `cp:` namespace
    `transport.mo` never authenticates, and `submit` is never exposed even
    there. The `wasm_upload_*` methods touch no game state and are
    controllers-only.
12. **Leave means left.** `status`/`join`/`rematch` use
    `activeDebriefSeat` so a session that acked its debrief stops being
    a participant even while the phase lingers for the partner; `leave`
    itself stays idempotent via plain `seatInDebrief`.
13. **`client.js` is headless and `render.js` is pure.** Neither touches
    `document`, storage, or timers other than the error TTL; every DOM
    concern lives in `app.js` or the game. Anything a game might want
    to redraw goes through `ClientState` or a `Screens` entry, never a
    private hook in `start()`.
14. **Timeouts are re-applied after the declaration.** `persistent actor`
    makes `registry` stable, so `Registry.new()` (argument-free, 90s/60s
    defaults) runs on first install only; the next line is always
    `registry.setTimeouts(...)` with the host's numbers, and the stored
    `Registry`/`Table` fields stay `var`. A `var` field inside a stable
    record is invariant across upgrades, so any
    further change to either stable type needs an explicit actor
    migration or a reinstall.

15. **Every backend serves its own wasm and describes itself.** Its `icp.yaml`
    entry carries the sync step `sh publish_wasm.sh backend` (the script
    sits next to `icp.yaml`, copied from the skill's template), which
    after every install/reinstall/upgrade uploads the module the
    canister now runs to the canister itself, so `GET /wasm` serves it;
    `snapshot_visibility` is never set to `public`, because a snapshot
    is the whole heap, access codes and pending moves included. Its host serves
    `Rules.SEMANTICS` at `/semantics`. That text, the `candid:service`
    metadata and the wasm at `/wasm` are all a third party has to build
    a frontend
    (`skills/duel-game-core/references/frontend-for-existing-game.md`,
    which the aggregator's `frontendPrompt.ts` condenses); `Action` is
    described nowhere else. Any change to a game's `State`, `Action`,
    `validate` or `resolve` updates its `SEMANTICS` in the same change.
    See `backend/README.md`, "Semantics over HTTP" and
    "Downloadable wasm".

## Skills (read before editing)

- `skills/duel-game-core/SKILL.md` (tracked, installable via `npx skills
add research-ag/duel-core --skill duel-game-core`) — building a game
  from a rules description: `Spec` design, templates, and `references/`
  for canister bots, alternating games, rich UIs, long-game testing, and
  a new frontend for an already-deployed game.
  Read it first for any game-building task, here or elsewhere.
- `.agents/skills/` (local, untracked) — general Motoko playbooks:
  `motoko-general-style-guidelines` (2-space indent, 80 cols),
  `motoko-performance-optimizations` (never `Array.concat` in a loop;
  `table.mo`'s `pushAck` is fine because its list is bounded at 2),
  `motoko-compiler-warnings-fixes`, `motoko-core-code-improvements`
  (import order core / third-party / local; dot notation still needs the
  module imported), `motoko-dot-notation-migration`,
  `motoko-base-to-core-migration`, `motoko-doc-strings`, and the
  mops/CI/benchmark playbooks.

### Keeping `skills/` current

`skills/duel-game-core/` ships to third parties who read it cold.
Whenever a change touches anything it describes (an API, a `GamePlugin`
contract, a build command, a template shape, an example's structure),
update it in the same change, written as if fresh: no "used to",
"previously", "no longer", "deprecated", or any changelog voice. After
editing, re-read the whole affected file and its templates for
second-order staleness.

## Conventions

- Tests are plain interpreter scripts: `ok`/`expectErr` helpers +
  `Runtime.trap`. Extend in kind (`trap` lives in `Runtime`; `Debug`
  only has `print`).
- `msg`, not `label`, for text parameters (`label` is reserved).
- Touching engine semantics means updating the affected suites, both
  READMEs, `lib.mo`'s doc header, and `skills/`.
- Comments are sparse: no restating the code, no justifying imports,
  point to the README instead of duplicating it.
- Format with `npx -y prettier --plugin prettier-plugin-motoko --write
'**/*.{mo,json,md}'`; CI checks it.
