# caffeine.ai: a game, a bot or a frontend built there

Read this when the work happens in caffeine.ai: its AI builder, from a
user's chat, or an agent driving its CLI. Caffeine builds and hosts
every app as one Motoko canister named `backend` and a React frontend,
and keeps the source itself. Caffeine's own skills (`caffeine-app`,
`writing-motoko`, `migrating-motoko-actors`) still apply; the files of
`references/caffeine/` say what a duel-game-core game, bot or frontend
needs on top of them, with the code.

| Task                                   | Files                                                                               |
| -------------------------------------- | ----------------------------------------------------------------------------------- |
| A game                                 | `caffeine/game.md`, then `caffeine/game-backend.md` and `caffeine/game-frontend.md` |
| Every later change of a game           | `caffeine/changes.md`                                                               |
| A bot for a game already deployed      | `caffeine/bot.md`, then `caffeine/bot-page.md`                                      |
| A frontend for a game already deployed | `caffeine/frontend.md`, with `caffeine/game-frontend.md`                            |

Caffeine's AI reads them over the web, and its fetch returns about the
first 10,000 characters of a page. So each of them stays under 8,000
characters and names, of the rest of the skill, only files that fit
too: `templates/Rules.mo.template`, `templates/plugin.js.template`,
`templates/BotIface.mo.template`, `turn-based-games.md` and
`rich-ui.md`.

What differs from the rest of this skill:

- **The layout is Caffeine's.** `src/backend/main.mo` with `lib/`,
  `mixins/` and `migrations/`, and `src/frontend/` (React, Vite,
  pnpm). The templates `Host.mo`, `icp.yaml`, `publish_wasm.sh`,
  `build.js`, `index.html`, `app.js`, `play-test.mjs` and
  `check-upgrade.mjs` have no place there.
- **Stable fields get no value where they are declared.** The first
  migration creates them. Caffeine's `MixinAuthorization` (its lint
  requires it) and `Expose` stay.
- **No shell, no local network**, so no `mops test`. Caffeine builds
  with the compiler and its stable check, and checks with its lint,
  `tsc` and Biome. Then the user plays the draft in the preview.
- **Draft and live are different canisters.** A draft comes from a
  shared pool, is reinstalled empty after about two hours idle, and its
  ids change. Go live creates the permanent canisters: those are what
  players use, what bots register with and what the Duel dashboard
  lists.
- **The module stays with Caffeine.** It is not in hosty.live's module
  store, so `/semantics` is all a third party gets: their frontends and
  bots are built from it and tested against the live game, on
  access-code tables, in caffeine.ai or with a shell
  (`frontend-for-existing-game.md`, step 3; `bot-for-existing-game.md`,
  "Without the game's module").
- **Caffeine pays the cycles.** It tops up the live canisters from the
  owner's Caffeine credits.

## The CLI

With a shell and a paid Caffeine plan, an agent can build locally
(`npm install -g @caffeineai/cli`, `caffeine auth login`) and upload
with `caffeine preview --build`; Caffeine then builds the source
itself. Uploading needs an active subscription or a saved card, and
answers 403 without one. The project shape is Caffeine's `caffeine-app`
skill's, the code is `references/caffeine/`'s, and the local tools of
the rest of this skill work too: `mops test`, and
`src/backend/dist/backend.wasm` on a local network through icp-cli's
`@dfinity/prebuilt` recipe for `play-test.mjs`.
