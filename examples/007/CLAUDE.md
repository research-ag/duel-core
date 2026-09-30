# 007 duel — reference game built on duel-game-core

A deployable `#simultaneous` example on `../../backend` and
`../../frontend`. Not part of either package.

- **`src/Duel007Rules.mo`** — the rules as pure functions (no actor, no
  storage, no `Time`), plugged in via `spec() : TP.Spec<State, Action>`.
- **`src/Host.mo`** — the host actor: a `Registry` (90s idle timeout, 60s
  claim window), `status` as the only plain query, `Ws.attach` +
  `include ActorMixin`, Prometheus metrics (`attachMetrics` + a
  `/metrics` route via `mo:promtracker/mixins/http`), and an ELO
  leaderboard (`Leaderboard.new(50, 1200)`, re-rated in `onGameEnded`
  with `Elo.update` at k=32 for every ending, read via `include
LeaderboardActorMixin(leaderboard, 25)`). Follows
  `../../backend/README.md`'s worked examples exactly. No bot.
- **`test/*.test.mo`** — `Lifecycle`/`Rules` are scenario walks;
  `Engine`/`RulesUnit` are per-operation unit suites. `Engine`/`Lifecycle`
  drive the real engine from `../../backend` with these rules plugged in.
- **`icp.yaml`** — deploys `src/Host.mo` as `backend` and `frontend/dist`
  as an asset canister.
- **`frontend/`** — vanilla JS bundled with esbuild. `duel007-plugin.js`
  is the whole `GamePlugin`; `app.js` resolves the identity
  (`resolveIdentity()`), builds the actor and `connectWs()` transport,
  calls `start()`, and wires the 🏆 toggle (first in `.session`) that
  opens the full-page `#leaderboard-panel` and renders
  `actor.get_leaderboard()` via `renderLeaderboard(entries, plugin, {
yourSid })`. `style.css` holds only 007 visuals over
  `duel-game-core.css`.

## Toolchain

moc 1.11.2 (`mops.toml`). Dependencies: `duel-game-core` (path to
`../../backend`), `core`; `ic-websocket-cdk` and `promtracker` arrive
transitively. Never import `mo:base`. The frontend depends on
`duel-game-core` (`file:../../../frontend`, copied via `install-links`)
and `@icp-sdk/core`; see `../../CLAUDE.md`'s "After touching anything
under `frontend/`" for the refresh procedure.

## Build & test

```bash
cd examples/007
mops install
moc --check $(mops sources) src/Duel007Rules.mo
moc --check $(mops sources) src/Host.mo
mops test                  # all four; `mops test Rules` matches Rules and RulesUnit

(cd ../../frontend && npm run build)
cd frontend && npm install --legacy-peer-deps && npm run build && node --check dist/app.js && cd ..

icp deploy                 # local; `icp network start` must be running
icp deploy --network ic    # mainnet — spends cycles
```

The asset-canister recipe must be v2.3.0 or newer; its `build` step
rebuilds `frontend/dist/` on every deploy.

## Architecture rules

Everything in `../../CLAUDE.md` applies. Additionally:

1. **The engine is never vendored here** — fix it in `../../backend`.
2. **The generic screens are never vendored here** — `duel007-plugin.js`
   supplies only `idlTypes`/`seatLabel`/`renderBoard`/`renderActions`.

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
- `turn` counts COMPLETED rounds; a fresh game is `turn == 0`.

## Conventions

Plain interpreter tests (`ok`/`expectErr` + `Runtime.trap`); `msg`, not
`label`; update all four suites when `Duel007Rules.mo`'s semantics
change. Motoko playbooks live in `../../.agents/skills/`.
