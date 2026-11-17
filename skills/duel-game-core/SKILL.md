---
name: duel-game-core
description: Build a complete, deployable 2-player game on duel-game-core from a plain-English rules description, writing the Motoko rules module (Spec<S,M,V,O>), the host actor, the tests and the frontend GamePlugin end to end from this skill's templates, and putting it online through hosty.live or with icp-cli. Use whenever someone hands you the rules of a duel, card, board or arena game (in their own words, a design doc or a rulebook excerpt) and wants it built on duel-game-core, especially in a repo without duel-game-core's own source. Also use to change a live game of one's own (bot support, a leaderboard, a bot), or to build a frontend or a bot for a duel-game-core game already deployed, given only its canister id.
---

# Building a duel-game-core Game From Rules Alone

## What this is

`duel-game-core` (https://github.com/research-ag/duel-core) is two
rules-agnostic packages: a Motoko mops package (the session engine)
and an npm package (the browser client). Together they handle
everything a 2-player game needs except the game itself: a lobby of
open and access-code tables, seating, rounds, the debrief, rematch,
idle takeover and claiming a win, player identity, and default screens
that a game can replace one at a time or entirely.

The user gives you rules, nothing else; you produce the whole game.
Make the State/Action/rendering design calls yourself. Ask only when
the rules leave game logic open (a win condition, a limit), never about
engine mechanics such as seating, rematch or timeouts, which the engine
handles.

Two words recur. **Bot support** is the game seating canister players:
the Host's BOTS lines, `src/BotIface.mo`, and the page's 🤖 dialog. **A
bot** is a separate canister that plays (`bot/`), which needs bot
support first. "Add bots" can mean either; when the words don't settle
it, ask.

A finished game is six pieces of game-specific code:

1. `src/<Rules>.mo`: a pure module exporting `State`, `Action`, `View`,
   `Options` and a `spec : TP.Spec<State, Action, View, Options>`.
2. `src/Host.mo`: a thin host actor; copy the template (with bot
   support, `src/BotIface.mo` too).
3. `test/RulesUnit.test.mo`: unit checks for your rules functions (the
   engine has its own suite).
4. `frontend/src/<game>-plugin.js`: a `GamePlugin`.
5. `frontend/src/index.html` + `app.js` + `style.css`: copy the
   templates.
6. `icp.yaml`, `publish_wasm.sh`, `mops.toml`, `frontend/package.json`,
   `frontend/build.js`, `frontend/play-test.mjs`: copy the templates,
   fill in names.

Every template lives in `templates/`; read each one right before
adapting it. `references/` covers nine situations the templates don't.
Read each one only when you get there:

- `cloud-session.md`: a Claude Code cloud session's setup (read it
  first there).
- `turn-based-games.md`: a game that waits for one seat.
- `canister-player-bots.md`: writing a bot.
- `rich-ui.md`: a canvas, 3D or framework UI, or a client to port.
- `testing-deep-dive.md`: a game whose ending takes many rounds to
  reach in a test.
- `going-live.md`: putting any of this online, through hosty.live or
  with icp-cli.
- `changing-a-live-game.md`: bot support, a leaderboard or any other
  change to a game already online.
- `frontend-for-existing-game.md` and `bot-for-existing-game.md`: a new
  frontend or a bot for a game someone else deployed, from its canister
  id alone.

**Where these files are.** Installed, they sit next to this `SKILL.md`.
Loaded through hosty.live's connector (`hosty_get_skill { url }`), read
one with `hosty_get_skill { url, path }` (`path:
"templates/Host.mo.template"`), or save it with `curl -sSfL -o
<destination> <download URL>` from the index. Saving needs a network
that reaches `raw.githubusercontent.com`, which a cloud session's often
does not. A new session loads the skill again the same way.

## Step 1: Get the packages into the project

In a Claude Code cloud session (claude.ai/code), read
`references/cloud-session.md` before anything else: its setup script
installs what the session cannot download by itself. Wherever you run,
the build needs `icp` (icp-cli) and `mops` 3.4.1 or later (an older one
fails `mops build` or, with moc 2.0, `mops test`):

```bash
icp --version || npm install -g @icp-sdk/icp-cli
v=$(mops --version 2>/dev/null | sed -n 's/^CLI //p')
[ -n "$v" ] && [ "$(printf '3.4.1\n%s\n' "$v" | sort -V | head -1)" = 3.4.1 ] ||
  npm install -g ic-mops
```

If there is no `mops.toml`, create one from `templates/mops.toml.template`
first; likewise `frontend/package.json` from
`templates/package.json.template` before any `npm` command.

```bash
mops add duel-game-core
```

If that fails (not on mops.one yet), clone the framework and use a path
dependency, as its own examples do:

```bash
git clone https://github.com/research-ag/duel-core.git ../duel-core
```

```toml
[dependencies]
duel-game-core = "../duel-core/backend"
core = "2.6.2"
promtracker = "1.0.1"
```

`promtracker` is always needed, since the Host template serves metrics
at `GET /metrics`. With `mops add duel-game-core` working, also run
`mops add promtracker`.

Frontend: `cd frontend && npm install @research-ag/duel-game-core --save-exact`.

The installed packages ship both READMEs:
`.mops/duel-game-core@<version>/README.md` (or
`../duel-core/backend/README.md`) and
`node_modules/@research-ag/duel-game-core/README.md`.

## Step 2: Turn the rules into `State` / `Action` / `View` / `Options`

Read the rules fully, then answer:

1. **Do both seats act at once, or does the game wait for one seat?**
   `#simultaneous` (both submit;
   `validate : (State, Seat, Action) -> ?Text` and
   `resolve : (State, Action, Action, Rng) -> ...`) is what
   `templates/Rules.mo.template` is written for. `#turnBased` (the
   rules say whose action is next through `toMove : State -> Seat`, and
   `move : (State, Seat, Action, Rng) -> { #ok; #err }` checks and
   applies one action) covers alternation, a turn of several actions
   (draw, then place) and repeat turns alike. Read
   `references/turn-based-games.md`; `examples/checkers` and
   `examples/tic-tac-toe` in the framework repo are worked examples.
2. **`Action` is a raw decision, never a derived value.** A damage number
   or result that is a function of `State` plus the choice belongs in
   the rules, not `Action`: `{ #attack; #defend }`, not
   `{ #attack : { damage : Nat } }`. Client input is untrusted. Ported games get this
   wrong most often.
3. **What persists in `State` across rounds?** Only what future rounds
   need, plus whatever the client needs to show the opponent's last move
   (Step 6). No timestamps and no "waiting for opponent" flags: the
   engine keeps those. A `#simultaneous` game whose state doesn't reveal
   both picks (rock-paper-scissors) carries a `lastRound : ?Round`; a
   board game can leave it out, since the plugin can diff two boards. A
   `#turnBased` game keeps whose turn it is (and a turn's progress) in
   `State`, or derives it (tic-tac-toe counts marks).
4. **What ends the game?** Map every win/lose/draw to the
   `verdict : ?TP.Verdict` (`#p1Wins`/`#p2Wins`/`#draw`) that `resolve`/`move`
   returns. `null` means "continue", not "draw".
5. **Is a number a player choice or fixed data?** A fixed board/deck is a
   `let`, not a field.
6. **Two Motoko traps:** a module-level `let` must be static (no function
   calls, `M0014`); `Nat` subtraction traps on underflow, so guard every
   `a - b` with `a >= b`.
7. **Porting an existing game:** document every deliberate simplification
   in the rules module's doc header, and match ported formulas exactly
   (Motoko `Float` and JS `number` are both IEEE754 doubles, so client and
   server agree bit-for-bit). Note the source file and line per piece.
8. **Does the creator pick anything at table time?** That is `Options`,
   the game's own type (the backend README's "Table options"). It is
   `{}` when there is nothing to pick, a variant for a choice between
   rule sets (`examples/chopsticks`), or a record for parameters
   (`examples/rock-paper-scissors`: `{ variant; winsNeeded }`, 1..9).
   `checkOptions` returns `?"why"` for a nonsensical value, and the
   table is refused. `init(options, rng)` copies onto `State` whatever
   the rules need later (the variant, the target), so
   `validate`/`resolve`/`move` read the state alone. When variants share
   a move shape, write `resolve` for the variant with the most legal
   moves and refuse the rest in `validate`; branch on `s.variant` only
   when a variant changes what a move does.
9. **Is anything hidden from a seat?** Then `View` is its own type and
   `view(s, seat, over)` builds it: the own hand in full, the opponent's
   as a count, and everything revealed once `over` is true, so the
   debrief shows the final position. The frontend and a bot receive only
   the `View`, so a `View = State` for a game with a hidden hand ships
   the opponent's cards to every client. When nothing is hidden,
   `View = State` and `view` returns the state, as in every example in
   the framework repo; `references/turn-based-games.md` sketches a
   hiding `View`.
10. **Does anything need randomness?** A shuffled deck, a die: use the
    `rng` handed to `init`/`resolve`/`move` (`rng.below(n)`,
    `rng.shuffle(xs)`), never `Time` and never your own seed. The
    framework keeps one generator per canister, so the rules stay pure,
    and a unit test seeds its own (`Rng.new(42)`).

Once you can state in a sentence each what `State` holds, what
`Action`'s variants are, what `Options` a creator picks, what a seat
sees, what gets rejected, and what `resolve` (or `move`) computes,
write the module.

### Worked mini example

_"Rock-paper-scissors. Each round both pick; the usual beats-relationship
decides the round. First to 3 round wins takes the match; a tie scores
nobody."_

- `Action = { #rock; #paper; #scissors }`.
- `State = { p1Score : Nat; p2Score : Nat; lastRound : ?Round }`;
  `View = State`; `Options = {}`.
- `checkOptions` and `validate` return `null` unconditionally.
- `resolve` decides the round, bumps a score, returns `?#p1Wins`/
  `?#p2Wins` at 3, else `null`.

## Step 3: Write the Rules module

From `templates/Rules.mo.template`, write `src/<YourGame>Rules.mo`:

- `__RULES_MODULE__`, `__GAME_TITLE__`, `__P1_NAME__`, `__P2_NAME__`.
- Replace the "Rules" doc block with the actual rules, one line per
  mechanic.
- Fill in `Action`, `Side`, `State`, `View`, `Options`, `freshSide`,
  `checkOptions`, `init`, `validate`, `resolve`, `view`.
  `init(options, rng)` takes the table's options and the framework's random-number
  generator; both parameters are unused for a game without options or
  randomness.
- Keep everything pure: no `Time`, no mutation, no storage;
  `{ me with ... }`, never in-place. `spec` is a constant record of these functions,
  handed to the framework on every call and never stored by it.
- Write `SEMANTICS` last, once the types and rules are settled. The host
  serves it at `GET /semantics`. The `.did` gives a third party the
  types but not what they mean, so this text is the only full
  description they build a frontend or a bot from. Give the exact
  Candid of `View`, `Action` and `Options` (`Nat` is `nat`, `?T` is
  `opt T`, `[T]` is `vec T`, a tuple is a positional record), what each
  field means and what a seat does not see, every rejection, every
  ending, and anything a UI must compute itself. The backend README's
  "Semantics over HTTP" has the section-by-section contract. Update it
  in the same change as `View`, `Action`, `Options` or the rules: a
  stale one breaks every client built from it.

## Step 4: Write the host actor

How the pieces interact (identity, the lobby and table queries with
their `rev`s, one update at a time, keep-alive, bots) is drawn in the
repo's `DESIGN.md` (https://github.com/research-ag/duel-core/blob/main/DESIGN.md).
In short: a player is the caller's principal, all data lives in one
plain stable record (`duel`), one transient `env` carries your rules,
and every framework call is `duel.f(env, …)`.

From `templates/Host.mo.template`, write `src/Host.mo`. Fill in only
`__RULES_MODULE__` and the two timeouts:

- `__IDLE_TIMEOUT_NS__` (`90_000_000_000` = 90 s): how long an
  abandoned game sits before a third party may take it over, and how
  long a table waiting for an opponent survives once its creator's tab
  is gone. An access-code table is an invite and waits 30 minutes
  instead; its first moves also get 10 more minutes on both clocks.
  Both are the engine's, not yours to set.
- `__CLAIM_TIMEOUT_NS__` (`60_000_000_000` = 60 s): how long your
  submitted move may wait on a silent opponent before you may claim the
  win.

Keep the idle timeout at least 15 s above the claim timeout; otherwise
a third party can take over an idle game before its own claim window
opens. Both go into `duel.registry.setTimeouts` on the line after
`Transport.new()`. That line runs on every upgrade, while the stable
`duel` is initialized on the first install only. Change nothing else,
except the lines marked BOTS or LEADERBOARD, which you turn on only for
a feature the user asked for (below).

The template wires everything else: the stable `duel`, the `env` with
your `spec`, the transport mixin, the four methods whose Candid types
name your `Options`, `Action` or `View`, promtracker's metrics, and the
HTTP routes `GET /semantics` (`Rules.SEMANTICS`) and `GET /metrics`.
Data a client needs but `State` does not carry (a fixed map, a deck
list) goes in as another `(path, () -> Text)` route. A game with
counters of its own adds them to the same `pt` (`pt.newCounter(name,
labels)`, `pt.newGauge(...)`; promtracker's README); the four game
metrics are in the backend README's "Metrics".

Do not add plain Candid methods for any game operation, not even to
test with a canister call: `mo:duel-game-core/transport` is the only
path, and the frontend sends its update calls one at a time so they
apply in order. Drive a test through the frontend or `play-test.mjs`.

**Canister players (optional).** Only if asked for bots ("Two words
recur" above). Uncomment every Host line marked BOTS and swap the
`null` it stands next to, and copy `templates/BotIface.mo.template` to
`src/BotIface.mo`, filling in `__RULES_MODULE__`. Nothing goes into
`mops.toml`. The host then supplies `join_table_as_canister` and the
other `*_as_canister` methods, `register_bot`, `unregister_bot` and
`list_bots`. A bot sits at up to 25 tables per complexity at once, a
human at 3. The page's half is Step 6.

If you write the bot too, it is a canister of its own, `bot`:
`bot/Bot.mo` (its `play`, `register`, `unregister` and `make_move`, as
in `references/bot-for-existing-game.md`, section 4) and
`bot/BotLogic.mo` (the strategy). Add it to `icp.yaml` (the backend's
Motoko recipe, without its sync step) and to `mops.toml`'s
`[canisters]` (`bot = "bot/Bot.mo"`), as `examples/checkers/` does; the
backend README's "Canister players" has the full design. Read
`references/canister-player-bots.md` before writing it: what
`make_move` receives (the bot's own `View`, what a human at its seat
sees), when it stays a `query` (the default), and what a bot that picks
at random or remembers anything needs. On mainnet the bot's canister
goes on its backend's subnet, since the backend asks it once per action
and a cross-subnet ask takes seconds (same file, "Where the bot
canister lives").

A bot lists itself in the game's bot directory once, by hand, after
both canisters are deployed, and again after any reinstall of the game:
its controller-only `register(host, name)` calls the game's
`register_bot(name, BotLogic.COMPLEXITIES)`. `BotLogic.COMPLEXITIES` is
the bot's own list of ways to play ("Easy"/"Hard", ...), `[]` for one
way, listed as "Default". A challenger picks one per game, every
`make_move` carries it as `req.complexity`, and each is rated
separately. On a local network:

```bash
icp canister call bot register '(principal "<host-canister-id>", "MyBot")'
```

On mainnet through hosty.live, `hosty_call_canister` with the same
method and argument (`going-live.md`, section 3). The bot then appears
in the page's "🤖 Bots" dialog and on the leaderboard's Challenge
buttons (Step 6), and a Rematch against it re-invites it.

**Leaderboard (optional).** Only if asked for rankings. The framework
scores every finished game itself; you pick the rating that fits the
game. Uncomment the Host lines marked LEADERBOARD and swap the `null`
they stand next to; nothing goes into `mops.toml`. They declare a
stable `Leaderboard.new(50, 1200)` (keep 50 entries, start at 1200),
put `scoring = ?{ board = leaderboard; rating = #elo { k = 32 } }` in
the `env`, and include `LeaderboardActorMixin(leaderboard, 25)`
(`get_leaderboard()`, the top 25). Elo fits a game where the players
beat each other; `#claimed` and `#aborted` endings count as wins.

A game where each player achieves something on their own (a best time,
a high score, a count of correct answers) wants a `#best` rating
instead: a function from the finished game's `Debrief` to a score for
each seat it credits (zero, one or both), each kept only when it
improves that player's entry. Derive the metric from the game state
(`examples/racing` turns `Debrief.steps` and the final state into the
winner's lap time), and turn a lower-is-better metric into a
higher-is-better score:

```motoko
func scoreFromLapMs(ms : Int) : Int = Int.max(0, 3_600_000 - ms);

func bestLap(d : TP.Debrief<Rules.State>) : [(TP.Seat, Int)] {
  switch (d.end) {
    case (#finished(#p1Wins)) [(#p1, scoreFromLapMs(lapMsFor(d.finalGame.p1, d.steps)))];
    case (#finished(#p2Wins)) [(#p2, scoreFromLapMs(lapMsFor(d.finalGame.p2, d.steps)))];
    case (_) [];
  };
};
// rating = #best bestLap

```

The board is keyed by player id (a human's principal, a bot's
`cp:<principal>:<complexity>`), so a bot is rated per complexity. The
page's half is Step 6; add `formatScore` to the plugin only for a
converted metric.

## Step 5: Write the rules unit tests

From `templates/RulesUnit.test.mo.template`, write `test/RulesUnit.test.mo`.
Cover at minimum:

- `checkOptions` accepts the default options, `init` is the starting
  position and `spec` hands out your own functions (section 1 of the
  template). With options, also `init` per option value plus one
  `checkOptions` rejection.
- One rejection case per way a move can be illegal (`validate`, or
  `move`'s `#err`); every legal case accepted.
- One case per win/lose/draw path, plus scoring edge cases.
- With a hiding `View`: what each seat sees, and that `over = true`
  reveals it.

Do not test join/leave/rematch/takeover: the engine's suite does.
Synthetic states are enough, and much faster than driving the engine.
If an end-to-end test needs a game that takes many rounds to finish,
read `references/testing-deep-dive.md` first. Run the tests with `mops
test`.

## Step 6: Write the frontend GamePlugin

From `templates/plugin.js.template`, write `frontend/src/<game>-plugin.js`:

- `idlTypes({ IDL })` must match your `Action`/`View`/`Options` Candid
  shapes exactly, and only those (the engine's own types are already
  known). `Nat`/`Int` decode to `bigint`; a tuple decodes to an array.
  `Options` is `IDL.Record({})` for a game without any.
- `seatLabel(seat)`.
- `renderBoard(gameState, mySeat, oppSeat)`: an HTML string from the
  seat's `View`, valid for a live game and a debrief. `esc()` any text
  from it. It must show the opponent's most recent move, live and in the
  debrief, so the player sees what just happened: a highlighted cell, a
  piece's origin and landing, captured pieces as ghosts, or both picks
  of the last round. Without `lastRound` in `View`, find the move by
  diffing the board against the previous one the plugin saw
  (`examples/tic-tac-toe`, `examples/checkers`).
- `renderActions(gameState, mySeat)`: one `<button>` per action via
  `actionAttr()`. Disable buttons through a cosmetic `legal()` mirror
  of `validate`; the rules still decide, and a `legal()` that disagrees
  with them is a plugin bug.
- `applyLocal(gameState, mySeat, move)`: the view with the player's
  own move applied, again a cosmetic mirror of the rules (for
  `#turnBased`, the board after the move; for `#simultaneous`, usually
  `gameState` unchanged). The default UI draws it the moment the move
  is sent, so a player never stares at an unchanged board while the
  submit, or a bot's reply, is in flight. Return `null` only for a move
  whose outcome you can't predict (a draw from a face-down pile). Write
  it for every game.
- `formatScore(score)`: only for a converted-metric leaderboard.
- `optionChoices()`/`formatOptions(options)`: only with options. The
  first choice is the default, each entry's `options` is the typed
  value `duel_create_table` receives (Nat fields as bigint), and
  `formatOptions` labels a table's options in the lobby.

Copy `index.html.template`, `app.js.template` and `style.css.template`
into `frontend/src/`, and fill in `__GAME_TITLE__`, `__PLUGIN_FILE__`,
`__IDLE_TIMEOUT_SECONDS__` and `__GAME_DESCRIPTION__` (one sentence for
search results and link previews: the game, against a friend or a bot,
in the browser). `style.css` may stay empty but must exist (`build.js`
copies it).

Keep the "More games ↗" link beside the title (`.header-title` and
`.more-games` in the package's stylesheet), in any header of your own
too. It leads to the Duel Dashboard, https://games.ic0.info/, where
players find every listed game.

`app.js` reads the backend's id from the `ic_env` cookie the frontend
canister sets, resolves a non-spoofable anonymous identity, builds the
actor, connects the transport, and calls `start({ plugin, transport,
session })`. esbuild inlines every dependency, so there is no CDN and no
import map. `start()` also follows the page's links: a friend's invite
(`#t=<table>&c=<code>`, shared from a protected table's waiting screen)
and a link to a new table or a game against a bot (`frontend/README.md`,
"Links"). One anonymous player per browser serves every tab.

- With bot support or a leaderboard, uncomment the lines marked BOTS or
  LEADERBOARD in both `app.js` and `index.html`. `bots.js`'s
  `mountBotChallenge` is "Add Bot" on the waiting screen, the bot list,
  the seat choice and the invite; `mountLeaderboard` is the 🏆 overlay,
  whose bot rows challenge too (`frontend/README.md`, "Bots and the
  leaderboard").
- For Internet Identity login, swap `resolveAnonymousIdentity()` for
  `identity.js`'s `resolveIdentity()` (`frontend/README.md`, "Logging
  in with Internet Identity").

`start()` returns the headless `DuelClient` it drives, and takes
`screens` (any subset of the default screens, replaced by your own
`view -> HTML` functions), `confirm` and `promptCode`. Use `screens`
when the user wants a screen in the game's own voice (a themed debrief,
a lobby with its own layout) while the interaction is still buttons and
text. A replaced `debrief` still draws the final board, or at least the
final round. When the UI does not fit that (canvas, 3D, drag and drop, a
framework client, its own lobby), read `references/rich-ui.md` before
writing `app.js`: it binds `createDuelClient()` directly, and shows your
own move at once.

## Step 7: Project and deploy config

| Template                     | Destination                  | Fill in                                        |
| ---------------------------- | ---------------------------- | ---------------------------------------------- |
| `mops.toml.template`         | `mops.toml`                  | `__GAME_SLUG__`                                |
| `package.json.template`      | `frontend/package.json`      | `__GAME_SLUG__`                                |
| `build.js.template`          | `frontend/build.js`          | `__PLUGIN_FILE__` (header comment only)        |
| `icp.yaml.template`          | `icp.yaml`                   | nothing (rename a canister in `mops.toml` too) |
| `publish_wasm.sh.template`   | `publish_wasm.sh`            | nothing (next to `icp.yaml`)                   |
| `play-test.mjs.template`     | `frontend/play-test.mjs`     | `__GAME_TITLE__`, `__PLUGIN_FILE__`            |
| `mcp.json.template`          | `.mcp.json`                  | nothing (token setup only, `cloud-session.md`) |
| `BotIface.mo.template`       | `src/BotIface.mo`            | `__RULES_MODULE__` (bot support only)          |
| `check-upgrade.mjs.template` | `frontend/check-upgrade.mjs` | `__HOST_FILE__` (`Host.mo`)                    |
| `CLAUDE.md.template`         | `CLAUDE.md`                  | every `__...__`, at the first deploy           |

```bash
mops install && mops test
cd frontend && npm install && npm run build && cd ..
node --check frontend/dist/app.js
icp network start -d       # once; a private copy of the Internet Computer
icp deploy                 # both canisters, locally; prints the frontend's URL
ID=$(icp canister status backend -i)
curl http://$ID.raw.localhost:8000/semantics   # the game's public face
curl http://$ID.raw.localhost:8000/metrics
cd frontend && node play-test.mjs && cd ..
```

`play-test.mjs` is the browser test without a browser: two players
with fresh keys play a whole game per `optionChoices()` entry through
the real client, every move taken from the plugin's own `actionAttr`
buttons (board and action panel), then a rematch, a leave, and both
debriefs acked. A rejected move from an enabled button, a seat due with
nothing enabled to click, or a game that never ends fails it with the
last status. It also tries one disabled button's move and expects the
rules to refuse it. A game whose moves are not single clicks (a
two-click selection, a canvas) lists its legal moves in
`offeredMoves` itself.

Anyone can download the module a backend runs from hosty.live's module
store, to test a frontend or a bot of their own against a local copy
(backend README, "Downloadable wasm"). hosty.live stores what it
installs. For `icp deploy -e ic`, the backend's sync step in
`icp.yaml`, `sh publish_wasm.sh backend`, uploads the module after
every mainnet install, reinstall and upgrade, and does nothing on a
local deploy. Keep the step, and pass the new name to the script if you
rename the backend canister. Never set `snapshot_visibility: public`: a
snapshot is the whole heap, access codes included.

The local frontend deploys through the `@dfinity/static-site` recipe,
whose `build` step runs `npm run build`. The canister sends no headers
of its own: for a CSP or `Cache-Control`, put a `_headers` file in
`frontend/src/` and copy it into `dist/` from `build.js`
(`examples/tic-tac-toe/frontend/src/_headers`). Its `Permissions-Policy`
keeps `web-share=(self)` and `clipboard-write=(self)`: the invite's
share button needs both.

Then look at the game the way a player does: both seats from two
browsers, or a normal and a private window (a browser's tabs share one
player), an invite table created in one and its link opened in the
other, a round played, and the debrief and rematch. Check that your move
appears the moment you click, that the opponent's move is marked when it
lands, and that the debrief still shows the final move. `play-test.mjs`
proves the moves; this proves what a player sees.

Do it yourself first, with Playwright on the local URL `icp deploy`
printed: two browser contexts (two players with their own keys), a
screenshot after each step, and look at every screenshot. In a cloud
session Chromium and Playwright are installed (`require('playwright')`,
`chromium.launch()` with no options); on a computer, `npm install
playwright && npx playwright install chromium` in a scratch directory
outside the project.

Then the user plays. On their computer, that is the same local URL. In
a cloud session nobody can open it: offer the first look on free
hosty.live cloud engine canisters (`references/going-live.md`, section
3, "Canisters"), and put the game there when the user agrees. Then run
`(cd frontend && node play-test.mjs <backend-id> --ic)` and give the
user the `frontendUrl`. Every later change goes into the same
canisters.

## Step 8: Go live

Only when the user asks. Follow `references/going-live.md` step by
step, and leave the same steps in the project's `README.md`. Keep the
whole game on one route: through hosty.live (setups 1 and 2; the only
route from a cloud session, and the right one for a user new to the
Internet Computer), or with icp-cli (setup 3, on the user's own
computer only).

Through hosty.live, the live game is new mainnet canisters, bought
after the user approves one deploy session. Their ids go into
`index.html`'s tags and the README, and the cloud engine copies can be
deleted. If the first look already went onto mainnet canisters (no
cloud engine, or no free slot), those are the live ones: buy nothing
more. From then on every change the user approves upgrades the live
canisters (`snapshotBeforeUpgrade: true` for the backend), never the
copies.

Either way, every later upgrade of the backend first passes `(cd
frontend && node check-upgrade.mjs <backend-id>)`
(`references/changing-a-live-game.md`). The user lists the frontend on
the Duel dashboard (`going-live.md`, section 5); until then the game is
online but unlisted. The `README.md`
says how to build, test and update the game, and lists every canister
id, saying which ones are the live game. Once the canister ids exist,
write the game's `CLAUDE.md` from its template, and keep the game on
the default branch.
