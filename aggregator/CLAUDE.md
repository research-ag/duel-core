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
  copy of its own banner; an info icon button opens `GameInfoModal.tsx`,
  and owners also get Edit/Deregister (the deregister confirm is a
  `Modal`). `Modal.tsx` is the one dialog shell
  (blurred backdrop, Escape/backdrop close, scroll lock) and `Wizard.tsx`
  the two-pane stepper every guide is built on (`initialStep`, and
  `reachable` locking later steps). `TutorialWizard.tsx` ("Build a new
  game", 5 copy-pasteable steps ending in the register flow) stands
  alone. The other two guides are about one listed game, opened either
  from the header on step 0, `GamePicker.tsx` (every listing, each
  checked by `support.ts` and disabled with its reason when the guide
  can't be followed for it: no published backend, no `/semantics`, or,
  for a bot, no `list_bots`), or from `GameInfoModal.tsx`'s two actions
  already filled in for that game (`Target`: the listing plus its
  backend id). `FrontendTutorialWizard.tsx` ("Make your own frontend")
  is written for a player with no ICP or coding background: two routes,
  caffeine.ai (chat builder, builds and hosts itself, paid plan) or an
  AI coding tool on their own computer (icp-cli, identity and cycles
  only appear in the "Put it online" step), ending in the register
  flow. Its prompt step shows `frontendPrompt.ts`'s prompt, filled with
  the game's title, URL and backend id, which adapts to what the
  builder can run (local wasm copy with icp-cli, else the live backend
  on code-protected tables; client package from npm, else its source
  files from GitHub). `BotTutorialWizard.tsx` ("Build a bot") has only
  the coding-tool route, since the bot is tested against a local copy
  of the game: `botPrompt.ts`'s prompt, then deploy and the bot's own
  `register` call with the backend id filled in (a bot is never listed
  on this dashboard). The prompts condense
  `../skills/duel-game-core/references/frontend-for-existing-game.md`
  and `bot-for-existing-game.md`; change each pair together. Pricing
  facts in the wizards are dated "at the time of writing".
  `GameInfoModal.tsx` (the card's info button) shows a listing's details
  and, one click further, its backend: `/metrics` and `/semantics`
  links, its Grafana dashboard, the semantics text, and
  every listed frontend playing the same backend. `grafana.ts` asks the
  promtracker dashboard registry (`iu7kc-saaaa-aaaao-bbama-cai`, the
  openapi-scraper project) with `getDashboard`; with none yet, and only
  for a backend serving `/metrics`, it calls `requestRegisterDashboard`
  and asks once more after 12 s. Nothing about the backend is stored:
  `canisterHttp.ts` calls other canisters' `http_request` as an
  anonymous Candid query (no CORS, no cookie filtering), reading each
  frontend's `PUBLIC_CANISTER_ID:backend` from its asset canister's
  `ic_env` cookie, cached per page load. All three share `CodeBlock.tsx` (`wrap` for
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

moc 1.16.1; `core` only, no `mo:base`. Frontend dependencies:
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
