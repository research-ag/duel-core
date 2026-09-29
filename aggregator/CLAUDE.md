# aggregator — the game registry / landing page for this framework

A standalone product on this repo's Motoko/TypeScript tooling — not part
of either `duel-game-core` package and not a game on the engine: Internet
Identity login, a developer's editable display name, and a public,
filterable grid of registered games. Two canisters (`icp.yaml`, Motoko
backend, bundled static frontend), its own Candid interface, no `ws.mo`.

- **`src/Types.mo`** — `Profile`, `Game`/`GameView` (stored record vs.
  returned view, banner blob excluded), `GameInput`/`GameEdit`, `Err`.
- **`src/Png.mo`** — reads the PNG signature + `IHDR` to recover banner
  dimensions. Pure.
- **`src/Store.mo`** — every operation (`setDisplayName`, `registerGame`,
  `updateGame`, `deregisterGame`, reads) over an explicit `State` (two
  `mo:core/Map`s). `now` is a parameter, no `Time`. A game is keyed by its
  immutable `backendCanisterId` (its `GameId`); registering the same one
  twice is rejected. `deregisterGame` uses `updateGame`'s ownership gate
  (`#notOwner`) and removes the record and banner; it never touches the
  game's own canisters.
- **`src/Main.mo`** — thin host actor: owns the `Store.State`, reads
  `msg.caller`/`Time.now()`, forwards to `Store`. Plain Candid methods are
  fine here — independent developers never contend the way two seats at
  one table do. `getBannerRequirements` lets the frontend validate
  against the exact numbers `Store.mo` enforces.
- **`test/Store.test.mo`** — interpreter suite over `Png.dimensions` and
  every `Store.mo` entry point (anonymous rejection, validation,
  ownership on edit/deregister, immutable fields, display-name
  resolution, deregistered games gone from every read path).
- **`icp.yaml`** — `src/Main.mo` as `backend`, `frontend/dist` as
  `frontend`.
- **`frontend/`** — React + TypeScript, esbuild. `idl.ts` is a
  hand-written `IDL.InterfaceFactory` for `Main.mo` (verify against
  `moc --idl` when the service changes). `api.ts` builds the actor
  (`ic-env.ts` is a local copy of `duel-game-core/ic-env.ts`'s logic).
  `hooks/useAuth.ts` wraps `AuthClient` (login required for writes;
  browsing is anonymous). `hooks/useBanner.ts` fetches `getBanner` into
  a cached object URL. `components/GameCard.tsx` shows an owner Edit and
  Delete (inline confirm, then `deregisterGame`). `TutorialWizard.tsx`
  ("Build a new game", 5 copy-pasteable steps ending in the register
  flow) and `BotTutorialWizard.tsx` ("Build a bot", 5 steps for a
  canister player against an existing game, no login-gated final step)
  share `CodeBlock.tsx`. `GameFormModal.tsx` is the register/edit form;
  picking a banner opens `ImageCropper.tsx` (`react-easy-crop`), which
  rasterizes to the exact `getBannerRequirements()` size and checks
  `maxBytes` before calling the backend (`Store.mo` remains the real
  gate).

## Toolchain

moc 1.11.2; `core` only, no `mo:base`. Frontend dependencies:
`@icp-sdk/core`, `@icp-sdk/auth`, `react`/`react-dom`, `react-easy-crop`;
`npm install --legacy-peer-deps` (same `@icp-sdk/auth` peer skew as
`../frontend`); `allowScripts` permits esbuild's postinstall.

## Build & test

```bash
cd aggregator
mops install
MOC=$(mops toolchain bin moc)
"$MOC" --check $(mops sources) src/Main.mo
"$MOC" -r $(mops sources) test/Store.test.mo

cd frontend
npm install --legacy-peer-deps
npm run build
npx tsc -p tsconfig.json
node --check dist/app.js
```

`icp deploy` runs `npm run build` itself; `npm install` stays manual.

## Conventions

House style per the root `CLAUDE.md`'s Motoko skills. Not covered by
`skills/duel-game-core` (that skill is about games on the engine).
