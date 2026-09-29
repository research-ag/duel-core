# Racing Duel — frontend

Plain TypeScript, no framework, bundled with
[esbuild](https://esbuild.github.io/). Two halves share one page and one
canister session:

- **`src/duel/duel-app.js` + `duel-racing-plugin.js`** — build the actor
  and push transport, then hand off to `duel-game-core`'s generic lobby/
  staging/rematch/debrief wiring. The `GamePlugin` is the only
  game-specific piece that package needs.
- **`src/main.ts`** — the 3D race (Three.js), wired by hand from the
  modules under `src/app/modules/gameplay/`.
  `game-communication/services/lobby-connection.service.ts` bridges the
  two: it shares `duel-app.js`'s connection (`window.duelActorReady`/
  `duelWsReady`, set up inline in `index.html`) and turns each view into
  the `{ slot, step }[]` events the gameplay code expects.

## Build

```bash
npm install --legacy-peer-deps
npm run build        # esbuild → dist/ (main.js, duel-app.js, static files)
npm run watch        # rebuilds both bundles; re-run build for static files
npm run typecheck    # tsc --noEmit — esbuild doesn't type-check
```

`dist/` is what `../icp.yaml` deploys; every dependency is inlined, no
`node_modules` ships. `icp deploy` runs `npm run build` itself.

`--legacy-peer-deps` works around `@gg-web-engine/three` pinning
`rxjs@7.8.1` and `@icp-sdk/auth`'s peer range on `@icp-sdk/core@^5`.

## What lives where

- `src/app/modules/gameplay/{game-physics,game-rendering,game-resources,game-viewport,gameplay}/`
  — the racing engine.
- `game-shared/services/game-state.service.ts` — `GameStateService`, the
  page-lifetime singleton for per-race state.
- `game-resources/consts/resources.consts.ts` — `RES_PATH`.
- `game-communication/` — canister bridge.
- `src/app/modules/api/` — `CarData`.
- `src/assets/` — cars, maps, proxies (`.glb` + `.meta`); see `CLAUDE.md`.
- `src/utils/` — pure math helpers, mirrored in `../src/RacingRules.mo`;
  keep the two in sync.

See `../CLAUDE.md` for the rules/backend side and `CLAUDE.md` here for
engine internals and the headless verification workflow.
