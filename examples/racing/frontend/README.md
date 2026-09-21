# Racing Duel — frontend

A plain-TypeScript client — no framework — bundled with [esbuild](https://esbuild.github.io/).
It has two independent halves that share one page and one canister session:

- **`duel-app.js` + `duel-racing-plugin.js`** (`src/duel/`, esbuild-bundled
  into `dist/duel-app.js` — `duel-racing-plugin.js` is pulled in via
  `duel-app.js`'s own import, not a separate entry point) — build the
  actor and a push-shaped `ws` over it, then hand off to
  `duel-game-core`'s generic session/render wiring: lobby, staging,
  rematch, busy countdown, debrief. This is the *only* game-specific
  piece that package needs (a `GamePlugin`), exactly like the
  `examples/007` frontend. See `duel-racing-plugin.js`'s own header
  comment.
- **`src/main.ts`** — the actual 3D race (Three.js), wired by hand (no DI
  framework — see its header comment for the construction order) from the
  gameplay/physics/rendering modules under `src/app/modules/gameplay/`.
  `src/app/modules/gameplay/game-communication/services/lobby-connection.service.ts`
  is the bridge: it shares `duel-app.js`'s own push poller (via
  `window.duelActorReady`/`duelWsReady`, set up inline in `index.html`)
  rather than polling independently, and turns whatever view arrives into
  the `{ slot, step }[]` event shape the rest of the gameplay code already
  expects.

## Build

```bash
npm install --legacy-peer-deps   # see the peer-dependency note below
npm run build                    # esbuild bundle → dist/
```

`dist/` is esbuild's output (bundled `main.js` and `duel-app.js`, plus
copied `index.html` / `style.css` / `favicon.ico` / `assets/` /
`duel-game-core.css` — see `build.js`) — this is what `icp.yaml` deploys
as the `frontend` asset canister, and it carries no `node_modules`
directory: every dependency (`@icp-sdk/core`, `@icp-sdk/auth`, `cborg`,
`three`, `rxjs`, ...) is resolved and inlined into the two bundles at
build time. It is not checked in; `../icp.yaml`'s asset-canister recipe
declares `npm run build` as a `build` step, so `icp build`/`icp deploy`
runs it automatically before syncing — same as `examples/007/frontend`.

`npm run watch` rebuilds both `main.js` and `duel-app.js` on change
(`esbuild --watch`); it does not re-copy the static files, so re-run
`npm run build` if you touch `index.html` or `style.css`.

`npm run typecheck` runs `tsc --noEmit` — esbuild itself only transpiles,
it does not type-check, so this is the real compile-time safety net.

The `--legacy-peer-deps` flag works around two pre-existing peer-dependency
mismatches, neither a real incompatibility: `@gg-web-engine/three` pins
`rxjs@7.8.1` as a peer while this project (like most current rxjs users)
is on `7.8.2`; and `duel-game-core` (via `identity.js`) depends on
`@icp-sdk/auth`, which itself declares a peer dependency on
`@icp-sdk/core@^5` — one major behind the `@icp-sdk/core@^6.1.0` this
project actually uses (see `../../../frontend/README.md`'s own note).

## What lives where

- `src/app/modules/gameplay/game-physics/`, `game-rendering/`,
  `game-resources/`, `game-viewport/`, `gameplay/` — the 3D racing engine
  itself (physics, Three.js scene management, asset loading, camera,
  click-to-drive control). Framework-agnostic plain TypeScript classes,
  wired up by hand in `main.ts`.
- `src/app/modules/gameplay/game-shared/services/game-state.service.ts` —
  `GameStateService`, the page-lifetime singleton the rest of the
  gameplay code reads/writes shared per-race state through (car
  instances, `mySlot`, the `raceTime` clock — see `CLAUDE.md`'s HUD
  bullet for the "someone has to reset per-race state explicitly"
  pattern this implies).
- `src/app/modules/gameplay/game-resources/consts/resources.consts.ts` —
  `ResourcesConsts.RES_PATH`, the one base path every loader (cars/maps/
  proxies/shaders) resolves resource URLs against.
- `src/app/modules/gameplay/game-communication/` — talks to the canister
  (see above).
- `src/app/modules/api/` — `CarData` (`interfaces/car.interfaces.ts`), the
  one shared type this example's car characteristics/physics are typed
  against.
- `src/assets/` — the car, map, and proxy-prop 3D models (`.glb` + a
  `.meta` JSON sidecar each) and textures this example ships, checked
  directly into git. See `CLAUDE.md` (this directory) for the `.meta`
  sidecar/naming conventions the loaders match on.
- `src/utils/` — pure math/geometry helpers (kinematics, polar
  coordinates, angle wrapping) used by both the gameplay code and,
  independently, `../src/RacingRules.mo` (ported to Motoko — keep the two
  in sync if you change either).

See `../CLAUDE.md` for the game-rules/backend side and `CLAUDE.md` (this
directory) for notes on the 3D engine internals and the headless-browser
verification workflow.
