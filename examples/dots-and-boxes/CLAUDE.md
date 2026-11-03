# dots-and-boxes duel — reference #turnBased game with follow-up moves

Classic dots and boxes: draw one line between two dots; the fourth side
of a box claims it and draws again; most boxes when the sheet is full
wins. The reference for follow-up moves (an action that grants another)
and for a page that morphs redraws onto the existing DOM. Not part of
either package.

- **`src/DotsAndBoxesRules.mo`** — `#turnBased`, `#p1` = Blue first;
  `State = { size; lines; boxes; toMove; lastLine }` stores `toMove`
  (closing a box keeps it with the mover); `move` = `validate` then
  `resolve`; `View = State`; `Options = { size }` (boxes per side,
  `checkOptions` 2..8, the page offers 3–6). `legalActions` is every
  undrawn line. Line indexing (horizontal first) is in the header and in
  `SEMANTICS`.
- **`src/Host.mo`** — the skill's Host template with BOTS and
  LEADERBOARD on (90s/60s, `#elo { k = 32 }`, keep 50 from 1200).
- **`src/BotIface.mo`** — `make_move`.
- **`bot/BotLogic.mo`** — `COMPLEXITIES = ["Easy", "Hard"]`. Easy takes
  an offered box, else any line. Hard takes boxes, else a safe line (no
  box gets a third side), else sacrifices the chain that gives away
  fewest. Unknown complexities play Easy. One line per ask: a bot's
  chain is several asks, which is why the bot sits on the backend's
  subnet.
- **`bot/Bot.mo`** — `make_move` (`query`), `play(...)`, `register`/
  `unregister` (controller only; registered as "Pencil Bot").
- **`test/*.test.mo`** — `RulesUnit` (each illegal move, the turn
  rules, each ending); `Bot` (both levels stay legal; Hard takes and
  avoids boxes and beats Easy).
- **`frontend/`** — `dots-and-boxes-plugin.js`: the SVG paper board;
  undrawn lines are `data-act` hit areas while `yourTurn`; `applyLocal`
  mirrors `resolve`, and `localToMove` (null once the board is full)
  lets a chain be clicked without waiting for each reply — the client
  queues the lines and sends them as one `duel_submit_moves`. The
  opponent's chain arrives as a burst; `State` keeps only `lastLine`, so
  the plugin diffs consecutive boards and animates `lastLine` last.
  `morph-screen.js` morphs each redraw (morphdom) instead of replacing
  `#screen`; `sounds.js` is Web Audio. `play-test.mjs` (two headless
  players finish a game per size), `bot-test.mjs` (a game against each
  level, then the leaderboard), `follow-up-test.mjs` (a three-line turn
  clicked ahead goes out as one `duel_submit_moves`) and `check-upgrade.mjs` (stable types and
  Candid against the live module) run against a deployment.

## Live

`.icp/data/mappings/ic.ids.json`: backend `kozn2-waaaa-aaaau-ahhsq-cai`,
frontend `kh2gg-aiaaa-aaaau-ahhta-cai`, bot `ka3as-nqaaa-aaaau-ahhtq-cai`
(registered as "Pencil Bot"), all on hosty.live's mainnet subnet. They
are controlled through hosty.live, not by an `icp` identity, so
`../../deploy_examples.sh` skips this example. To upgrade:

1. `mops test`; locally `icp deploy`, register the bot
   (`icp canister call bot register "(principal \"$(icp canister status backend -i)\", \"Pencil Bot\")"`),
   `cd frontend && node play-test.mjs && node bot-test.mjs && node follow-up-test.mjs`.
2. `cd frontend && node check-upgrade.mjs kozn2-waaaa-aaaau-ahhsq-cai`
   must exit 0. `State` sits in stable memory: any change to it needs a
   migration or a reinstall (`../../skills/duel-game-core/references/changing-a-live-game.md`).
3. In a hosty.live deploy session: `icp build backend`, gzip the module,
   `hosty_prepare_wasm_upload` (`mode: upgrade`,
   `snapshotBeforeUpgrade: true`), run the returned `curl`,
   `hosty_wait_for_deployment`; the frontend's `dist/` as a zip upload.
   After a REINSTALL of the backend, register the bot again.

## Toolchain / Build & test

Same as `examples/checkers` (moc 2.0.0; `mops test`; build
`../../frontend` first; `npm install && npm run build` in `frontend/`;
`icp deploy`). Play both seats in two tabs.

## Architecture rules

Everything in `../../CLAUDE.md`, plus: the engine and generic screens are
never vendored here. A change to `View`, `Action`, `Options` or the rules
updates `SEMANTICS` in the same change.

## Conventions

Plain interpreter tests; `msg`, not `label`; `legalActions` must keep
matching `validate`, and the plugin's `applyLocal` must keep mirroring
`resolve`.
