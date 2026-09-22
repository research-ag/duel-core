# aggregator — the game registry / landing page for this framework

A standalone product built on this repo's Motoko/TypeScript tooling —
**not** part of either `duel-game-core` package and not a game built on
`../backend`'s session engine. It's the landing page for the framework:
Internet Identity login, a developer's own editable display name, and a
public, filterable grid of every game registered against it. Two
canisters, wired the same way every `examples/*` game is
(`icp.yaml` + a Motoko backend + a bundled static frontend), but its own
independent Candid interface — no `ws.mo`, no `Registry`, no `Spec`.

- **`src/Types.mo`** — the Candid-facing record/variant shapes:
  `Profile` (display name only), `Game`/`GameView` (the stored record vs.
  what `listGames`/`getGame` actually return — see its own doc for why
  the banner blob is excluded), `GameInput`/`GameEdit`, and `Err`.
- **`src/Png.mo`** — reads just the PNG signature + `IHDR` chunk of a
  banner upload to recover its pixel width/height, without pulling in a
  full image-decoding library. Pure, independently testable.
- **`src/Store.mo`** — every mutating/validating operation
  (`setDisplayName`, `registerGame`, `updateGame`, `deregisterGame`, plus
  the read paths) as plain functions over an explicit `State` (two
  `mo:core/Map`s: by principal for profiles, by backend-canister-principal
  for games). No `Time` import — `now` is a parameter, same discipline
  `../backend`'s own engine modules follow, so this module runs under a
  plain interpreter test with no actor at all. A game is keyed by its own
  `backendCanisterId`, which is therefore immutable and doubles as its
  `GameId` — there's no separate incrementing id to keep in sync with
  it, and registering the same backend canister twice is rejected
  outright rather than silently reassigning ownership. `deregisterGame`
  gates on the same ownership check `updateGame` uses (`existing.developer
== caller`, else `#notOwner`) and reuses `updateGame`'s own
  `#noSuchGame`/`#notOwner` `Err` arms rather than adding new ones — it
  removes the game (and, since the banner lives on the same record, its
  banner) from the registry outright; it has no effect on the game's own
  backend/frontend canisters, which this product never controls.
- **`src/Main.mo`** — the thin host actor: owns the one `Store.State`,
  reads `msg.caller`/`Time.now()`, and forwards to `Store.mo`. Unlike
  `../backend`'s own `Registry`, every mutating method here is a plain,
  ordinary Candid method — there is no `ws.mo`-style single-channel
  requirement, because two developers editing their own, independent
  games never contend with each other the way two seats submitting into
  the SAME table do (`../CLAUDE.md`'s rule 11 is about `../backend`
  specifically, not this actor). `getBannerRequirements` exists so the
  frontend's upload form validates against the exact numbers `Store.mo`
  enforces, rather than a hand-copied constant that could drift.
- **`test/Store.test.mo`** — interpreter-run suite (`moc -r`, same style
  as `../backend/test/*.test.mo`) covering `Png.dimensions` and every
  `Store.mo` entry point: anonymous-caller rejection, validation errors,
  ownership gating on edit and deregistration, the immutable
  `backendCanisterId`/developer fields, `developerDisplayName`
  resolution, and that a deregistered game (and its banner) is actually
  gone from every read path afterward.
- **`icp.yaml`** — icp-cli manifest; deploys `src/Main.mo` as canister
  `backend` and `frontend/dist` (esbuild's bundled output) as canister
  `frontend`, the same shape every `../examples/*` game uses.
- **`frontend/`** — a small React + TypeScript client, bundled with
  esbuild (no dev server framework, no CSS framework — see `build.js`).
  `idl.ts` is a hand-written, fixed `IDL.InterfaceFactory` for
  `src/Main.mo`'s own service (verified against `moc --idl`'s generated
  `.did` — re-verify the same way if `Main.mo`'s service surface ever
  changes). `api.ts` builds the actor (reads the `ic_env` cookie for the
  backend canister id, derives the right agent host for wherever the
  page is currently served — `ic-env.ts` is a small local copy of
  `duel-game-core/ic-env.ts`'s logic, not a dependency on that package,
  since this product isn't a game on that engine).
  `hooks/useAuth.ts` wraps `@icp-sdk/auth`'s `AuthClient` directly (a
  real Internet Identity login is required for
  `setDisplayName`/`registerGame`/`updateGame`; browsing the public grid
  works anonymously). `hooks/useBanner.ts` fetches a game's banner via
  the separate `getBanner` query and turns it into a cached object URL.
  `components/GameCard.tsx` shows an owner (its `developer` matches the
  logged-in principal) an Edit and a Delete button on their own card;
  Delete opens an inline confirm dialog (not a native `window.confirm`,
  to match the rest of the UI) before calling `deregisterGame` and
  reloading the grid — `Store.mo`'s own `#notOwner` gate is still the
  real enforcement, this is just the client-side prompt.
  `components/TutorialWizard.tsx` is the other on-ramp, next to
  `GameFormModal.tsx`'s "register a game you already built" flow: a
  5-step guide ("Build a new game", opened from the header, no login
  required until its last step) for someone who hasn't built a game
  yet — prerequisites (`icp-cli`, an identity, enough cycles for 2
  canisters), project/GitHub setup, generating the skeleton (pointing at
  `skills/duel-game-core/SKILL.md`, both as an `npx skills add
research-ag/duel-core --skill duel-game-core` install for an AI
  assistant and as a plain GitHub link for a human), deploying to
  mainnet (`icp deploy -e ic -y`), then handing off into the SAME
  `GameFormModal` register flow for the final step. It's a browser page,
  so every step is copy-pasteable commands for the developer's own
  terminal, never something this frontend runs itself — there is nothing
  here to verify a step actually succeeded before moving to the next
  one.
  `components/GameFormModal.tsx` is the register/edit form: picking a
  banner file opens `components/ImageCropper.tsx` (built on
  `react-easy-crop`) rather than uploading it as-is — the developer drags
  and zooms a crop box locked to the registry's own banner aspect ratio,
  and "Use crop" rasterizes exactly that area onto a canvas sized to the
  exact `width`/`height` `getBannerRequirements()` returns, so the
  resulting PNG always matches `Store.mo`'s required size by
  construction (no separate client-side dimension check is needed
  anymore); it still checks the cropped file's byte size against
  `getBannerRequirements()`'s `maxBytes` before ever calling
  `registerGame`/`updateGame`, so an oversized upload never reaches the
  network — `Store.mo`'s own validation is still the actual gate, this
  is purely a fast, friendly first check. The whole crop step is
  frontend-only; `Store.mo`/`Main.mo` and the Candid interface are
  unchanged.

## Toolchain

- moc **1.11.2** (mops toolchain, pinned in `mops.toml`) — matches
  `../backend`'s own pin; nothing here needs a newer compiler (no
  `mixin`/`ActorMixin`, since there's no WebSocket transport in this
  product).
- `core` (`mo:core`) is the only Motoko dependency — no `mo:base`,
  same rule as `../backend`.
- `frontend/`'s only npm dependencies are `@icp-sdk/core` (agent/Candid),
  `@icp-sdk/auth` (Internet Identity), `react`/`react-dom`, and
  `react-easy-crop` (the banner crop dialog in
  `components/ImageCropper.tsx`). Its own
  `package.json` needs `--legacy-peer-deps` on `npm install` for the same
  reason `../frontend`'s does (`@icp-sdk/auth`'s peer range on
  `@icp-sdk/core` trails the version actually used) — see `../CLAUDE.md`'s
  own note on this. `allowScripts` in `frontend/package.json` allows
  esbuild's own postinstall (fetches its platform binary) — without it,
  `npm install` silently leaves `esbuild` uninstalled the same way it
  silently leaves `duel-game-core`'s `dist/` unbuilt for the `examples/*`
  games (see `../CLAUDE.md`'s own note on that gate).

## Build & test

```bash
cd aggregator
mops install                       # fetches core per mops.toml

# Type-check / run the interpreter suite (same invocation shape as ../backend):
MOC=$(mops toolchain bin moc)
"$MOC" --check $(mops sources) src/Main.mo
"$MOC" -r $(mops sources) test/Store.test.mo

cd frontend
npm install --legacy-peer-deps
npm run build                      # esbuild -> dist/
npx tsc -p tsconfig.json           # typecheck (noEmit)
node --check dist/app.js
```

`icp.yaml`'s asset-canister recipe declares `npm run build` (inside
`frontend/`) as a `build` step, so `icp build`/`icp deploy` also runs it
automatically before syncing `frontend/dist/` — the sequence above is
for local typechecking/sanity-checking, not a manual step you must
repeat before every deploy. `npm install --legacy-peer-deps` is still a
separate, manual step that populates `frontend/node_modules` in the
first place; the automatic `build` step only re-bundles from whatever is
already installed there.

## Conventions

Same house style as the rest of this repo — see the root `CLAUDE.md`'s
"Skills" section, in particular
`.agents/skills/motoko-general-style-guidelines/SKILL.md` and
`.agents/skills/motoko-compiler-warnings-fixes/SKILL.md`. This product
is not part of `skills/duel-game-core`'s shipped documentation (that
skill is about building a GAME on `../backend`/`../frontend`, which this
isn't), so nothing here needs mirroring there.
