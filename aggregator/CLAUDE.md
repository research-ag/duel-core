# aggregator — the game registry / landing page for this framework

A standalone product on this repo's Motoko/TypeScript tooling — not part
of either `duel-game-core` package and not a game on the engine: Internet
Identity login, a developer's editable display name, and a public,
filterable grid of registered games. Two canisters (`icp.yaml`, Motoko
backend, bundled static frontend), its own Candid interface, no `transport.mo`.

- **`src/Types.mo`** — `Profile`, `Game`/`GameView` (stored record vs.
  returned view, banner blob excluded), `GameInput`/`GameEdit`, `Err`.
- **`src/Png.mo`** — reads the PNG signature + `IHDR` to recover banner
  dimensions. Pure.
- **`src/Store.mo`** — every operation (`setDisplayName`, `registerGame`,
  `updateGame`, `deregisterGame`, reads) over an explicit `State` (two
  `mo:core/Map`s). `now` is a parameter, no `Time`. A game is keyed by its
  `frontendCanisterId` (its `GameId`), the only canister id a listing
  holds; registering the same one twice is rejected, and an edit that
  changes it re-keys the game (`#gameAlreadyRegistered` if taken).
  `deregisterGame` uses `updateGame`'s ownership gate
  (`#notOwner`) and removes the record and banner; it never touches the
  game's own canisters.
- **`src/Main.mo`** — thin host actor: owns the `Store.State`, reads
  `msg.caller`/`Time.now()`, forwards to `Store`. Plain Candid methods are
  fine here — independent developers never contend the way two seats at
  one table do. `getBannerRequirements` lets the frontend validate
  against the exact numbers `Store.mo` enforces.
- **`test/Store.test.mo`** — interpreter suite over `Png.dimensions` and
  every `Store.mo` entry point (anonymous rejection, validation,
  ownership on edit/deregister, re-keying on a frontend change,
  display-name resolution, deregistered games gone from every read
  path).
- **`src/Migration.mo`** + **`test/Migration.test.mo`** — one-off
  `(with migration = Migration.run)` on `Main.mo`, converting the
  backend-keyed registry to this shape. Delete both, and the clause,
  once the live canister is upgraded: it traps on any later upgrade.
- **`icp.yaml`** — `src/Main.mo` as `backend`, `frontend/dist` as
  `frontend`.
- **`frontend/`** — React + TypeScript, esbuild. `idl.ts` is a
  hand-written `IDL.InterfaceFactory` for `Main.mo` (verify against
  `moc --idl` when the service changes). `api.ts` builds the actor
  (`ic-env.ts` is a local copy of `duel-game-core/ic-env.ts`'s logic).
  `hooks/useAuth.ts` wraps `AuthClient` (login required for writes;
  browsing is anonymous). `hooks/useBanner.ts` fetches `getBanner` into
  a cached object URL (`invalidateBanner` after a banner edit).
  `App.tsx` lays out the page: `Header.tsx` (sticky topbar; the
  logged-in developer's chip is `DisplayNameEditor.tsx`, a popover to
  rename or log out, with a principal-derived `avatarStyle`), `Hero.tsx`
  (headline over a slow crossfade of the registered banners, paused
  under `prefers-reduced-motion`), `GameGrid.tsx` (search with a `/`
  shortcut, developer chips, skeleton cards while loading) and a footer.
  `GameCard.tsx` is a banner-led card whose body glows with a blurred
  copy of its own banner; owners get Edit/Deregister icon buttons (the
  deregister confirm is a `Modal`). `Modal.tsx` is the one dialog shell
  (blurred backdrop, Escape/backdrop close, scroll lock) and `Wizard.tsx`
  the two-pane stepper `TutorialWizard.tsx` ("Build a new game", 5
  copy-pasteable steps ending in the register flow) and
  `BotTutorialWizard.tsx` ("Build a bot", 5 steps for a canister player
  against an existing game, no login-gated final step) are built on;
  `FrontendTutorialWizard.tsx` ("Make own frontend", opened from the
  header or from the `card-own` button on every `GameCard`, which
  passes its game) walks a player through getting their own client for a
  listed game and ends in the register flow; its step 2 shows
  `frontendPrompt.ts`'s prompt for an AI coding agent, filled with the
  game's title and URL. The prompt condenses
  `../skills/duel-game-core/references/frontend-for-existing-game.md`;
  change the two together. All three share `CodeBlock.tsx` (`wrap` for
  prose). `Icons.tsx` holds the inline SVG icons and
  the brand mark. `GameFormModal.tsx` is the register/edit form; dropping
  or picking a banner opens `ImageCropper.tsx` (`react-easy-crop`), which
  rasterizes to the exact `getBannerRequirements()` size and checks
  `maxBytes` before calling the backend (`Store.mo` remains the real
  gate). `style.css` is the whole design system (tokens at `:root`,
  dark only); the display serif (Instrument Serif) and text face
  (Manrope) are vendored as woff2 in `src/fonts/` and copied by
  `build.js`, because `_headers`' CSP allows only same-origin
  fonts.

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
"$MOC" -r $(mops sources) test/Migration.test.mo

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
