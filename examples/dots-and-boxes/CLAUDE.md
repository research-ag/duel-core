# dots-and-boxes duel — reference #turnBased game with follow-up moves

Classic dots and boxes: draw one line between two dots; the fourth side
of a box claims it and draws again; most boxes when the sheet is full
wins. The reference for follow-up moves (a move that grants another,
sent as one whole-turn `Action`) and for a page that morphs redraws onto
the existing DOM. Not part of either package.

- **`src/DotsAndBoxesRules.mo`** — `#turnBased`, `#p1` = Blue first;
  `Action = #draw { lines : [Nat] }` is a whole turn: every line but the
  last closes a box, the last closes none (unless it fills the board).
  `State = { size; lines; boxes; lastTurn }`; `move` checks the turn
  line by line through `drawLine`; seats strictly alternate, so `toMove`
  is the seat that did not draw `lastTurn`; `View = State`; `Options = { size }` (boxes per
  side, `checkOptions` 2..8, the page offers 3–6). Line indexing
  (horizontal first) is in the header and in `SEMANTICS`.
- **`src/Host.mo`** — the skill's Host template with BOTS and
  LEADERBOARD on (90s/60s, `#elo { k = 32 }`, keep 50 from 1200).
- **`src/BotIface.mo`** — `make_move`.
- **`bot/BotLogic.mo`** — `COMPLEXITIES = ["Easy", "Hard"]`. Easy takes
  an offered box, else any line. Hard takes boxes, else a safe line (no
  box gets a third side), else sacrifices the chain that gives away
  fewest. Unknown complexities play Easy. `chooseMove` picks a whole
  turn, line by line, through `Rules.drawLine`.
- **`bot/Bot.mo`** — `make_move` (`query`), `play(...)`, `register`/
  `unregister` (controller only; registered as "Pencil Bot").
- **`test/*.test.mo`** — `RulesUnit` (each illegal turn, the turn
  rules, each ending); `Bot` (both levels play legal turns; Hard takes
  and avoids boxes and beats Easy).
- **`frontend/`** — `dots-and-boxes-plugin.js`: the SVG paper board,
  and the turn built locally while `yourTurn`. A line that closes a box
  is a `data-line` hit area: the plugin's own listener adds it to
  `draft` and redraws the board (`morph`) with it drawn; clicking the
  draft's last line (`data-undo`) takes it back. A line that ends the
  turn is a `data-act` hit area carrying `{ draw: { lines: [...draft,
line] } }`, submitted by app.js, so the whole turn is one round trip.
  The draft belongs to the board it was drawn on and vanishes with it.
  `applyLocal` mirrors `move`. The opponent's turn arrives at once; the
  plugin diffs consecutive boards and animates `lastTurn` in order, with
  a halo on its lines. `morph-screen.js` morphs each redraw (morphdom)
  instead of replacing `#screen`; `sounds.js` is Web Audio.
  `play-test.mjs` (two headless players finish a game per size),
  `bot-test.mjs` (a game against each level, then the leaderboard),
  both taking `data-line` clicks through the plugin's `drawAgain`, and
  `check-upgrade.mjs` (stable types and Candid against the live module)
  run against a deployment.

## Live

`.icp/data/mappings/ic.ids.json`: backend `kozn2-waaaa-aaaau-ahhsq-cai`,
frontend `kh2gg-aiaaa-aaaau-ahhta-cai`, bot `ka3as-nqaaa-aaaau-ahhtq-cai`
(registered as "Pencil Bot"). To upgrade:

1. `mops test`; locally `icp deploy`, register the bot
   (`icp canister call bot register "(principal \"$(icp canister status backend -i)\", \"Pencil Bot\")"`),
   `cd frontend && node play-test.mjs && node bot-test.mjs`.
2. `cd frontend && node check-upgrade.mjs kozn2-waaaa-aaaau-ahhsq-cai`
   must exit 0. `State` sits in stable memory: any change to it needs a
   migration or a reinstall (`../../skills/duel-game-core/references/changing-a-live-game.md`).
3. `icp deploy backend -e ic` (its sync step publishes the module),
   `icp deploy bot -e ic`, then the frontend. After a REINSTALL of the
   backend, register the bot again
   (`icp canister call bot register '(principal "kozn2-waaaa-aaaau-ahhsq-cai", "Pencil Bot")' -e ic`)
   and run `play-test.mjs`/`bot-test.mjs` with
   `kozn2-waaaa-aaaau-ahhsq-cai --ic`.

## Toolchain / Build & test

Same as `examples/checkers` (moc 2.0.0; `mops test`; build
`../../frontend` first; `npm install && npm run build` in `frontend/`;
`icp deploy`). Play both seats in two tabs.

## Architecture rules

Everything in `../../CLAUDE.md`, plus: the engine and generic screens are
never vendored here. A change to `View`, `Action`, `Options` or the rules
updates `SEMANTICS` in the same change.

## Conventions

Plain interpreter tests; `msg`, not `label`; the plugin's `drawLine`,
`drawsAgain` and `applyLocal` must keep mirroring `drawLine` and `move`.
