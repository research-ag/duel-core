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
  `updateGame`, `deregisterGame`, `transferGame`, reads) over an explicit `State` (two
  `mo:core/Map`s). `now` is a parameter, no `Time`. A game is keyed by its
  `frontendCanisterId` (its `GameId`), the only canister id a listing
  holds; registering the same one twice is rejected, and an edit that
  changes it re-keys the game (`#gameAlreadyRegistered` if taken).
  `deregisterGame` uses `updateGame`'s ownership gate
  (`#notOwner`) and removes the record and banner; it never touches the
  game's own canisters. `transferGame(now, id, from, to)` hands a listing
  to another developer: `from` must be its developer (`#notOwner`), `to`
  not anonymous (`#anonymousDeveloper`).
- **`src/Main.mo`** — thin host actor: owns the `Store.State`, reads
  `msg.caller`/`Time.now()`, forwards to `Store`. `transferGame(id,
from, to)` is the one admin method: controllers only
  (`#notController`). Plain Candid methods are
  fine here — independent developers never contend the way two seats at
  one table do. `mo:promtracker/mixins/http` serves `/metrics` (promtracker's
  system metrics, cycles included, plus a `games_registered` gauge) so
  the dashboard can show its own backend's balance in the footer. `getBannerRequirements` lets the frontend validate
  against the exact numbers `Store.mo` enforces.
- **`test/Store.test.mo`** — interpreter suite over `Png.dimensions` and
  every `Store.mo` entry point (anonymous rejection, validation,
  ownership on edit/deregister, re-keying on a frontend change,
  transfers,
  display-name resolution, deregistered games gone from every read
  path).
- **`icp.yaml`** — `src/Main.mo` as `backend` (built by `mops build`,
  from `mops.toml`'s `[canisters]`), `frontend/dist` as `frontend`.
- **`frontend/`** — React + TypeScript, esbuild. `idl.ts` is a
  hand-written `IDL.InterfaceFactory` for `Main.mo` (verify against
  `moc --idl` when the service changes). `api.ts` builds the actor
  (`ic-env.ts` is a local copy of `@research-ag/duel-game-core/ic-env.ts`'s logic).
  `hooks/useAuth.ts` wraps `AuthClient` (login required for writes;
  browsing is anonymous). `hooks/useBanner.ts` fetches `getBanner` into
  a cached object URL (`invalidateBanner` after a banner edit).
  `App.tsx` lays out the page: `Header.tsx` (sticky topbar; the
  logged-in developer's chip is `DisplayNameEditor.tsx`, a popover with
  the principal, to rename or log out, with a principal-derived
  `avatarStyle`), `Hero.tsx`
  (headline over a slow crossfade of the registered banners, paused
  under `prefers-reduced-motion`), `GameGrid.tsx` (search with a `/`
  shortcut, developer chips, skeleton cards while loading) and a footer.
  `GameCard.tsx` is a banner-led card whose body glows with a blurred
  copy of its own banner; an info icon button opens `GameInfoModal.tsx`,
  and owners also get Edit/Deregister (the deregister confirm is a
  `Modal`). `Modal.tsx` is the one dialog shell
  (blurred backdrop, Escape/backdrop close, scroll lock) and `Wizard.tsx`
  the two-pane stepper every guide is built on (`initialStep`, and
  `reachable` locking later steps). Every guide ends its "How it works"
  step in `WayPicker.tsx`, a choice between the ways of `cloudSession.ts`'s
  `Way` (generic over its keys, so `HostySetup` reuses it), and shows
  only that way's steps and prompt afterwards (later steps
  stay locked until one is picked): `"caffeine"` (caffeine.ai alone, the
  frontend guide only), `"hosty"` (hosty.live, from a Claude Code cloud
  session or an agent on the computer) and `"own"` (icp-cli on the
  computer, the user's own key and cycles, no hosty.live).
  `CloudSessionSetup.tsx` holds the shared steps: `HostySetup` (the
  hosty.live connector once, `ConnectorSteps`, then one path picked for
  where the agent runs, each naming the desktop app's Code tab: "In the
  cloud" is `CloudSessionSetup`, one GitHub repository for all the
  user's work and `ENV_SETUP_PROMPT`, the message that has a session
  create the claude.ai environment (network domains, setup script
  (`SETUP_SCRIPT`, the same as `cloud-session.md`'s), launcher variable)
  with its `create_environment` tool, the wildcard domains added by hand
  after its approval card, and the same values for the dialog collapsed
  behind "Or set up the environment by hand", then `TokenSetup`, the
  `hl_` token, `.mcp.json` and network secret for a plan without
  connectors, collapsed behind "No connectors on your Team/Enterprise
  plan?"; "On your computer" is `LocalAgentSetup`), `OwnSetup`, and for
  going live `HostyCycles`
  (the three ways hosty.live's Cycles page tops up a balance),
  `DeploySessionNote` (what needs a deploy session, and checking its
  request code) and `IcpIdentitySteps` (an icp identity and cycles). The texts are in
  `cloudSession.ts`: `loadSkill`, the one paragraph every hosty.live
  prompt carries (load the skill from `SKILL_URL` with the connector's
  `hosty_get_skill`, or one of its references for the task, and what to
  say when the `hosty_*` tools are missing; every other rule of that way
  lives in the skill, `cloud-session.md` and `going-live.md`), and
  `OWN_RULES`, the opening of the own way's prompts, which install the
  skill with `SKILL_INSTALL`; each prompt function takes the way.
  `TutorialWizard.tsx` ("Build a new game", ways `hosty` and `own`)
  stands alone: how it works, the set-up, `gamePrompt.ts`'s prompt
  finished with the user's rules (on hosty.live the skill builds, tests
  with `play-test.mjs`, shows the game on free cloud engine canisters
  and buys the mainnet ones, unlisted, when the user says it goes live;
  on the own way the prompt's own steps: a local address, then `icp
deploy`), trying it, going live and the register flow. The other two guides are about one listed game, opened
  either from the header on step 0, `GamePicker.tsx` (every listing,
  each checked by `support.ts` and disabled with its reason when the
  guide can't be followed for it: no published backend, no `/semantics`,
  or, for a bot, no `list_bots`), or from `GameInfoModal.tsx`'s two
  actions already filled in for that game (`Target`: the listing plus
  its backend id). `FrontendTutorialWizard.tsx` ("Make your own
  frontend") is written for a player with no ICP or coding background,
  all three ways, ending in the register flow. Its prompt step shows
  `frontendPrompt.ts`'s prompt for the way, filled with the game's title,
  URL and backend id: caffeine.ai tests in its preview on the live
  backend's code-protected tables and goes live with its own action;
  hosty.live tests against a local wasm copy with icp-cli and the
  play-test, then, in a cloud session, puts the page on a free cloud
  engine canister on the live backend's code-protected tables, and goes
  live in a canister paid by card; the own way tests on the local copy
  and goes live with `icp deploy frontend`. `BotTutorialWizard.tsx`
  ("Build a bot", ways `hosty` and `own`, since the bot is tested
  against a local copy of the game): `botPrompt.ts`'s prompt, then going
  live through hosty.live (the agent creates, installs and registers in
  one deploy session) or with icp-cli, each ending in the bot's own
  `register` call with the backend id filled in (a bot is never listed on
  this dashboard). The own and caffeine.ai prompts condense
  `../skills/duel-game-core/SKILL.md` with `references/going-live.md`
  (`gamePrompt.ts`), `references/frontend-for-existing-game.md` and
  `bot-for-existing-game.md`, which the hosty.live prompts hand the work
  to; change each pair together.
  `GameInfoModal.tsx` (the card's info button) shows a listing's details
  and, one click further, its backend: `/metrics` and `/semantics`
  links, its Grafana dashboard, the semantics text, and
  every listed frontend playing the same backend, and its cycle balance
  with a **Top up** page. `cycles.ts` is the balance side: one page-wide
  store (`useSyncExternalStore`) of frontend → backend and backend →
  `cycles_balance`, read from the backend's `/metrics` through
  `canisterHttp.ts`'s `fetchText` once per page load (`trackGame`,
  started by `GameGrid.tsx` for every listing; a failed call is retried
  twice, then reads as `null` like a missing gauge) and re-read on
  demand (`refreshCycles`, which keeps a known balance over a failed
  read); the bands (`HEALTHY_TC` 0.5, `LOW_TC` 0.2) behind
  `CyclesBadge.tsx` (the dot on every card and in the modal; a
  `critical` card gets a red edge), the `Low on cycles` chip and the
  logged-in developer's `OwnerStrip` in `GameGrid.tsx`; and the top-up
  links. `TopUp.tsx` is the modal's third page: a whole-dollar amount
  (1 to 100; under 5 CyclePay asks the payer to sign in) into a
  prefilled CyclePay checkout
  (`cyclepay.org/c/<backend>/<usd>`, anyone can pay), Cycle Express
  (`cycle.express/?to=<backend>`) and,
  for the game's developer, the canister's hosty.live page and the
  icp-cli command; after any of them it re-reads `/metrics` every 5 s
  for two minutes and shows what arrived. The dashboard never holds a
  hosty.live token and never takes a payment itself; the TC-per-dollar
  figure is an estimate at a fixed XDR rate. A frontend canister's
  balance is not shown: an asset canister serves no `/metrics`.
  `grafana.ts` asks the
  promtracker dashboard registry (`iu7kc-saaaa-aaaao-bbama-cai`, the
  openapi-scraper project) with `getDashboard`; with none yet, and only
  for a backend serving `/metrics`, it calls `requestRegisterDashboard`
  and asks once more after 12 s. Nothing about the backend is stored:
  `canisterHttp.ts` calls other canisters' `http_request` as an
  anonymous Candid query (no CORS, no cookie filtering), reading each
  frontend's `PUBLIC_CANISTER_ID:backend` from its asset canister's
  `ic_env` cookie, cached per page load. All three share `CodeBlock.tsx` (`wrap` for
  prose; `CopyId`, a principal with a copy button, in the info dialog's
  Developer row and the profile popover). A card shows the developer's
  display name with the principal shortened beside it. `Icons.tsx` holds the inline SVG icons and
  the brand mark. `GameFormModal.tsx` is the register/edit form. Before
  calling the backend it refuses a page, or a page whose cookie names a
  backend, on hosty.live's cloud engine (`canisterHttp.ts`'s
  `onCloudEngine`: the canister's subnet from a certified `read_state`
  delegation against `CLOUD_ENGINE_SUBNETS`), with a message telling the
  developer to buy mainnet canisters; the check is client-side only, an
  unreadable canister passes to the backend's own checks. Dropping
  or picking a banner opens `ImageCropper.tsx` (`react-easy-crop`), which
  rasterizes to the exact `getBannerRequirements()` size and checks
  `maxBytes` before calling the backend (`Store.mo` remains the real
  gate). `style.css` is the whole design system (tokens at `:root`,
  dark only); the display serif (Instrument Serif) and text face
  (Manrope) are vendored as woff2 in `src/fonts/` and copied by
  `build.js`, because `_headers`' CSP allows only same-origin
  fonts.
  The live site is the Duel Dashboard at https://games.ic0.info/
  (`.well-known/ic-domains`): `index.html` carries its canonical URL,
  Open Graph/Twitter tags, JSON-LD (the site plus the reference games'
  URLs) and a `<noscript>` list of those games for crawlers without
  JavaScript; `og.jpg` (1200×630, the reference games' banners behind
  the headline), `favicon.svg`, `apple-touch-icon.png`, `robots.txt`
  and `sitemap.xml` are copied by `build.js`.

## Toolchain

moc 2.0.0; `core` only, no `mo:base`. Frontend dependencies:
`@icp-sdk/core`, `@icp-sdk/auth`, `react`/`react-dom`, `react-easy-crop`;
`npm install --legacy-peer-deps` (`@icp-sdk/auth` 8 declares a peer
range on `@icp-sdk/core@^5`); `allowScripts` permits esbuild's postinstall.

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
node check-setup-script.mjs   # SETUP_SCRIPT = cloud-session.md's script (CI)
```

`icp deploy` runs `npm run build` itself; `npm install` stays manual.

## Conventions

House style per the root `CLAUDE.md`'s Motoko skills. Not covered by
`skills/duel-game-core` (that skill is about games on the engine).
