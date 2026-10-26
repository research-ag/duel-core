---
name: duel-game-core
description: Build a complete, deployable 2-player game on duel-game-core from nothing but a plain-English rules description in the prompt — the user supplies only the rules, you write the Motoko rules module (Spec<S,M,V,O>), Host actor, tests, and the frontend GamePlugin end to end, using this skill's own templates and (for a canvas/3D UI, an existing client to port, a game whose ending takes many rounds to reach in a test, or putting the result online, through hosty.live from a Claude Code cloud session or a computer, or with icp-cli) its references/. Use whenever someone hands you the rules for a duel/card/board/arena game (in their own words, a design doc, or a rulebook excerpt) and wants it built as a duel-game-core game, especially in a repo that does not already contain duel-game-core's own source (installed standalone via `npx skills add research-ag/duel-core --skill duel-game-core`). Also use when someone wants to change a live game of their own — add bot support, a leaderboard, a bot, or anything else (references/changing-a-live-game.md) — or wants their own frontend (references/frontend-for-existing-game.md) or a bot (references/bot-for-existing-game.md) for an already-deployed duel-game-core game, given only its canister id.
---

# Building a duel-game-core Game From Rules Alone

## What this is

`duel-game-core` (https://github.com/research-ag/duel-core) is two
rules-agnostic packages — a Motoko mops package (session engine) and an
npm package (browser client) — implementing everything a 2-player game
needs except the game itself: a multi-table lobby (open or access-code
protected tables), seating, round submission, debrief, idle takeover,
rematch, claim-win, player identity, the polling transport, a headless client
holding all of that browser-side, and default screens over it that a
game can replace one at a time or entirely.

The user gives you rules, nothing else; you produce the whole game. Make
the State/Action/rendering design calls yourself. Ask only when the rules
are genuinely ambiguous about game logic (a win condition, a limit),
never about engine mechanics (seating, rematch, timeouts — already
handled).

Two words recur. **Bot support** is the game seating canister players:
the Host's BOTS lines, `src/BotIface.mo`, and the page's 🤖 dialog. **A
bot** is a separate canister that plays (`bot/`), which needs bot
support first. "Add bots" can mean either; when the words don't settle
it, ask.

A finished game is six pieces of game-specific code:

1. `src/<Rules>.mo` — a pure module exporting `State`, `Action`, `View`,
   `Options` and a `spec : TP.Spec<State, Action, View, Options>`.
2. `src/Host.mo` — a thin host actor; copy the template (with bot
   support, `src/BotIface.mo` too).
3. `test/RulesUnit.test.mo` — unit checks for your rules functions (the
   engine has its own suite).
4. `frontend/src/<game>-plugin.js` — a `GamePlugin`.
5. `frontend/src/index.html` + `app.js` + `style.css` — copy the
   templates.
6. `icp.yaml`, `publish_wasm.sh`, `mops.toml`, `frontend/package.json`,
   `frontend/build.js`, `frontend/play-test.mjs` — copy the templates,
   fill in names.

Every template lives in `templates/`; read each one right before adapting
it. `references/` covers eight situations the templates don't:
`turn-based-games.md`, `canister-player-bots.md`, `rich-ui.md`,
`testing-deep-dive.md`, `going-live.md` (a Claude Code cloud
session's setup, and putting any of this online, through hosty.live or
with icp-cli), `changing-a-live-game.md` (bot support, a leaderboard or
any other change to a game already online), and, for a game
someone else already deployed, from its canister id alone,
`frontend-for-existing-game.md` (a new frontend) and
`bot-for-existing-game.md` (a canister player) — read them only when
you hit that situation.

## Step 1 — Get the packages into the project

You are very likely in a new repo, separate from `research-ag/duel-core`,
and quite possibly in a Claude Code cloud session (claude.ai/code): a
VM the user never sees into, where you build and test and from which
everything goes online through hosty.live's MCP server.
`references/going-live.md`, section 2, is that session's setup; check
it before anything else. Wherever you run, the build needs `icp`
(icp-cli) and `mops`:

```bash
icp --version && mops --version || npm install -g @icp-sdk/icp-cli ic-mops
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

`promtracker` is always needed: the Host template serves metrics at
`GET /metrics` (Step 4). With `mops add duel-game-core` working, also
run `mops add promtracker`. (`prng`, which the framework's `rng` is
built on, arrives transitively.)

Frontend: `cd frontend && npm install @research-ag/duel-game-core --save-exact`.

The installed package ships both READMEs:
`.mops/duel-game-core@<version>/README.md` (or
`../duel-core/backend/README.md`) and
`node_modules/@research-ag/duel-game-core/README.md`.

## Step 2 — Turn the rules into `State` / `Action` / `View` / `Options`

Read the rules fully, then answer:

1. **Do both seats act at once, or does the game wait for one seat?**
   `#simultaneous` (both submit; `validate : (State, Seat, Action) ->
?Text` and `resolve : (State, Action, Action, Rng) -> ...`) is what
   `templates/Rules.mo.template` is written for. `#turnBased` (the
   rules say whose action is next through `toMove : State -> Seat`, and
   `move : (State, Seat, Action, Rng) -> { #ok; #err }` checks and
   applies one action) covers alternation, a turn of several actions
   (draw, then place) and repeat turns alike — read
   `references/turn-based-games.md`; `examples/checkers` and
   `examples/tic-tac-toe` in the framework repo are the worked examples.
2. **`Action` is a raw decision, never a derived value.** A damage number
   or result that is a function of `State` plus the choice belongs in
   the rules, not `Action`: `{ #attack; #defend }`, not `{ #attack : {
damage : Nat } }`. Client input is untrusted. This is the single most
   common mistake when porting an existing game.
3. **What persists in `State` across rounds?** Only what future rounds
   need, plus whatever the client needs to show the opponent's last move
   (Step 6). A `#simultaneous` game whose state doesn't reveal both
   picks (rock-paper-scissors) carries a `lastRound : ?Round`; a board
   game can leave it out, since the plugin can diff two boards. A
   `#turnBased` game keeps whose turn it is (and a turn's progress) in
   `State`, or derives it (tic-tac-toe counts marks).
4. **What ends the game?** Map every win/lose/draw to the `verdict :
?TP.Verdict` (`#p1Wins`/`#p2Wins`/`#draw`) that `resolve`/`move`
   returns. `null` means "continue", not "draw".
5. **Is a number a player choice or fixed data?** A fixed board/deck is a
   `let`, not a field.
6. **Two Motoko traps:** a module-level `let` must be static (no function
   calls — `M0014`); `Nat` subtraction traps on underflow, so guard every
   `a - b` with `a >= b`.
7. **Porting an existing game:** document every deliberate simplification
   in the rules module's doc header, and match ported formulas exactly
   (Motoko `Float` and JS `number` are both IEEE754 doubles, so client and
   server agree bit-for-bit) — note the source file/line per piece.
8. **Does the creator pick anything at table time?** That is `Options`,
   the game's own type (see the backend README's "Table options"):
   `{}` when there is nothing to pick; a variant for a choice between
   rule sets (`examples/chopsticks`); a record for parameters, with
   `checkOptions` returning `?"why"` for a nonsensical value so the
   table is refused (`examples/rock-paper-scissors`: `{ variant;
winsNeeded }`, 1..9). `init(options, rng)` copies onto `State`
   whatever the rules need later (the variant, the target), so
   `validate`/`resolve`/`move` branch on the state alone. Build
   `resolve` against the variant with the most legal moves and gate the
   rest in `validate` when variants share a move shape; branch on
   `s.variant` only when a variant changes what a move does.
9. **Is anything hidden from a seat?** Then `View` is its own type and
   `view(s, seat, over)` builds it: the own hand in full, the opponent's
   as a count, and everything revealed once `over` is true (the debrief
   shows the final position). Both the frontend and a bot receive only
   the `View`. When nothing is hidden, `View = State` and `view` returns
   the state (every example in the framework repo; `rack-o` is the
   hiding reference).
10. **Does anything need randomness?** A shuffled deck, a die: use the
    `rng` handed to `init`/`resolve`/`move` (`rng.below(n)`,
    `rng.shuffle(xs)`), never `Time` and never your own seed — the
    framework keeps one generator per canister, so the rules stay pure
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

## Step 3 — Write the Rules module

From `templates/Rules.mo.template`, write `src/<YourGame>Rules.mo`:

- `__RULES_MODULE__`, `__GAME_TITLE__`, `__P1_NAME__`, `__P2_NAME__`.
- Replace the "Rules" doc block with the actual rules, one line per
  mechanic — the most useful comment in the game.
- Fill in `Action`, `Side`, `State`, `View`, `Options`, `freshSide`,
  `checkOptions`, `init`, `validate`, `resolve`, `view`. `init(options,
rng)` takes the table's options and the framework's random-number
  generator; both parameters are unused for a game without options or
  randomness.
- Keep everything pure: no `Time`, no mutation, no storage; `{ me with
... }`, never in-place. `spec` is a constant record of these functions,
  handed to the framework on every call and never stored by it.
- Write `SEMANTICS` last, once the types and rules are settled. The host
  serves it at `GET /semantics`, and it is all a third party gets to
  build their own frontend for your game: the `.did` gives the types
  but not what they mean, so this text is its only full description. Give the
  exact Candid of `View`, `Action` and `Options` (`Nat` is `nat`, `?T`
  is `opt T`, `[T]` is `vec T`, a tuple is a positional record), what
  each field means and what a seat does not see, every rejection, every
  ending, and anything a UI must compute itself. The backend README's
  "Semantics over HTTP" has the section-by-section contract. Change it
  whenever `View`, `Action`, `Options` or the rules change.

## Step 4 — Write the host actor

How the pieces interact — identity, the lobby/table queries with their
`rev`s, one update at a time, keep-alive, bots — is drawn in the
repo's `DESIGN.md` (https://github.com/research-ag/duel-core/blob/main/DESIGN.md).
The short version a host needs: a player is the caller's principal; all
data lives in one plain stable record (`duel`); one transient `env`
carries your rules, and every framework call is `duel.f(env, …)`.

From `templates/Host.mo.template`, write `src/Host.mo`, filling in only
`__RULES_MODULE__`, `__IDLE_TIMEOUT_NS__` (`90_000_000_000` = 90s: how
long an abandoned game sits before a third party may take it over, and
how long a table waiting for an opponent survives once its creator's
tab is gone), and `__CLAIM_TIMEOUT_NS__` (`60_000_000_000` = 60s: how
long your submitted move may sit against the opponent's silence before
you may claim the win). Both go into `duel.registry.setTimeouts` on
the line after `Transport.new()`: a stable `duel` runs its initializer
only on first install, while `setTimeouts` runs on every upgrade. Keep
`idleTimeoutNs` comfortably above `claimTimeoutNs` (at least 15s of
margin) — an idle game can otherwise be taken over by a third party
before its own claim window even opens. Change nothing else, except
the lines marked BOTS or LEADERBOARD, which you turn on only for a
feature the user asked for (below).

What the template wires:

- `let duel = Transport.new<Rules.State, Rules.Action, Rules.Options>()`
  — the tables, the lobby, the random-number generator: plain stable
  data.
- `transient let env : Transport.Env<…> = { spec = Rules.spec; bots =
null; scoring = null }` — your rules (function values cannot be
  stable, so the `env` is rebuilt on every upgrade). The two `null`s
  are canister players and a leaderboard, below.
- `include TransportActorMixin<system>(duel.lobby(env))` — every method
  that names none of your types (`duel_join_table`, `duel_rematch`,
  `duel_leave`, `duel_reset`, `duel_claim_win`, `duel_ack_ended`,
  `duel_keep_alive`) and the sweep timer.
- `duel_create_table`, `duel_lobby`, `duel_submit` and `duel_table` —
  the four methods whose Candid types name your `Options`, `Action` or
  `View`, as one-line pass-throughs (a mixin cannot take type
  parameters; the explicit type arguments are what moc requires once
  `<system>` is given).
- promtracker metrics and `HttpActorMixin`, whose routes answer
  `GET /semantics` with `Rules.SEMANTICS` and `GET /metrics` with the
  metrics; data a client needs but `State` does not carry (a fixed map,
  a deck list) goes in as a further `(path, () -> Text)` route; nothing
  else to wire.

Do not add plain Candid methods for any game operation:
`mo:duel-game-core/transport` is the only path, and the frontend sends
its update calls one at a time so they apply in order.

**Claim a win.** The generic `#inGame` screen renders a "Claim the win"
button with its own countdown once `claimWinAvailable` turns true, and
shows the deciding opponent the mirror warning. Nothing in `GamePlugin`
is involved. In a `#turnBased` game only the seat NOT on turn ever
sees the control.

**Metrics.** The template wires promtracker for every game:
`duel.registry.attachMetrics(pt)` records `games_started`,
`active_games`, `rounds_per_game` and `matchmaking_wait_seconds` (the
backend README's "Metrics"), next to promtracker's system metrics
(memory, cycles, instructions), all served at `GET /metrics` in
Prometheus format. Keep the `import Tracker "mo:promtracker/Tracker"`
line: it is what brings `pt.toValue()` into scope, and without it the
host does not compile. A game with its own counters adds them to the
same `pt` (`pt.newCounter(name, labels)`, `pt.newGauge(...)`; see
promtracker's README). Check after a deploy:

```bash
curl http://$ID.raw.localhost:8000/metrics
```

**Canister players (optional).** Only if asked for bots ("Two words
recur" above). Nothing to add to `mops.toml`. Uncomment every Host line
marked BOTS and swap the `null` it stands next to, and copy
`templates/BotIface.mo.template` to `src/BotIface.mo`: the
inter-canister call to the bot is the one function only game code can
write, since its result type is your `Action`. The host then has
`let bots = CanisterPlayers.newStore()` (the bot directory and
in-flight asks, stable), `bots = ?{ store = bots; call =
BotIface.callBot }` in the `env`, and `include
CanisterPlayersActorMixin(duel.canisterPlayers(env), bots.directory,
null)` (`?leaderboard` once that is wired too), which supplies
`join_table_as_canister` and the other `*_as_canister` methods,
`register_bot`, `unregister_bot` and `list_bots`. A bot sits at up to
25 tables per complexity at once (`MAX_TABLES_PER_CANISTER_PLAYER`); a
human at 3. The page's half is Step 6.

If writing the bot, add a `bot/Bot.mo`/`bot/BotLogic.mo` pair like
`examples/checkers/bot/`. The backend README's "Canister players" has
the full design. `MoveRequest<View, Action>` carries `game` (the bot's
own `View` — a bot sees exactly what a human at its seat sees), `seat`,
`mode`, `step`/`gen`, `complexity`, `opponent`, `opponentLastMove`, and
`lastStepDurationNs`; a bot that only reads `game`/`seat`/`step` is a
pure `query`, which is the right default; a bot that needs randomness
stays one by seeding from `Time.now()`. Read
`references/canister-player-bots.md` before writing a bot that picks at
random or remembers anything — the latter makes `make_move` no longer a
`query`.

A challengeable bot self-registers once, by hand, after both canisters
are deployed (and again after any reinstall of the game):

```motoko
public shared ({ caller }) func register(host : Principal.Principal, name : Text) : async () {
  assert Principal.isController(caller);
  let h : actor { register_bot : (Text, [Text]) -> async () } = actor (host.toText());
  await h.register_bot(name, BotLogic.COMPLEXITIES);
};

```

`BotLogic.COMPLEXITIES` is the bot's own list of ways to play
("Easy"/"Hard", ...) — `[]` for one way, listed as "Default". A
challenger picks one per game; every `make_move` carries it as
`req.complexity`, and each is rated separately. Trigger with
`icp canister call bot register '(principal "<host-canister-id>", "MyBot")'`
on a local network; on mainnet through hosty.live, `hosty_call_canister`
with the same method and argument (`going-live.md`, section 3).
The bot then appears in the page's "🤖 Bots" dialog and the
leaderboard's Challenge buttons (Step 6, `frontend/README.md`, "Bots
and the leaderboard"), and a Rematch against it re-invites it
automatically.

**Leaderboard (optional).** Only if asked for rankings. The framework
scores every finished game itself; you declare the board and pick the
rating that fits the game. Nothing to add to `mops.toml`: uncomment the
Host lines marked LEADERBOARD and swap the `null` they stand next to.
They declare `let leaderboard = Leaderboard.new(50, 1200)` (keep 50,
start at 1200; stable), put `scoring = ?{ board = leaderboard; rating =
#elo { k = 32 } }` in the `env`, and `include
LeaderboardActorMixin(leaderboard, 25)` (`get_leaderboard()`, the top
25). A game played against each other wants that Elo
(`#claimed`/`#aborted` count like a win).

A game where each player achieves something on their own (a best time,
a high score, a count of correct answers) wants a `#best` rating: a
function from the finished game's `Debrief` to a score for each seat it
credits — zero, one or both — each kept only when it improves that
player's entry. Derive the metric from game state — `examples/racing`
turns `Debrief.steps` and the final state into the winner's lap time —
and convert a lower-is-better metric to higher-is-better:

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

Keys are player ids — a human's principal, a bot's
`cp:<principal>:<complexity>` — so a bot is rated per complexity. The
page's half is Step 6. Add `formatScore` to the plugin only for a
converted metric.

## Step 5 — Write the rules unit tests

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

Do not test join/leave/rematch/takeover — the engine's suite does.
Synthetic states are sufficient and far faster than driving the engine.
If a genuine end-to-end test needs a game that takes many rounds to
finish, read `references/testing-deep-dive.md` first.

```bash
moc -r --package core <path-to-core/src> --package duel-game-core <path-to-backend/src> --package prng <path-to-prng/src> test/RulesUnit.test.mo
# or, with mops.toml listing them: mops test
```

## Step 6 — Write the frontend GamePlugin

From `templates/plugin.js.template`, write `frontend/src/<game>-plugin.js`:

- `idlTypes({ IDL })` must match your `Action`/`View`/`Options` Candid
  shapes exactly, and only those (the engine's own types are already
  known). `Nat`/`Int` decode to `bigint`; a tuple decodes to an array.
  `Options` is `IDL.Record({})` for a game without any.
- `seatLabel(seat)`.
- `renderBoard(gameState, mySeat, oppSeat)` — an HTML string from the
  seat's `View`, valid for a live game and a debrief. `esc()` any text
  from it. It must show the opponent's most recent move, live and in the
  debrief: a highlighted cell, a piece's origin and landing, captured
  pieces as ghosts, or both picks of the last round. Without `lastRound`
  in `View`, find the move by diffing the board against the previous one
  the plugin saw (`examples/tic-tac-toe`, `examples/checkers`).
- `renderActions(gameState, mySeat)` — one `<button>` per action via
  `actionAttr()`. Disable via a cosmetic `legal()` mirror of `validate`;
  the engine still runs the real one.
- `applyLocal(gameState, mySeat, move)` — the view with the player's
  own move applied, a cosmetic mirror of the rules (for `#turnBased`,
  the board after the move; for `#simultaneous`, usually `gameState`
  unchanged). The default UI draws it the moment the move is sent, so a
  player never stares at an unchanged board while the submit, or a
  bot's reply, is in flight. Return `null` only for a move whose
  outcome you can't predict (a draw from a face-down pile). Write it
  for every game.
- `formatScore(score)` — only for a converted-metric leaderboard.
- `optionChoices()`/`formatOptions(options)` — only with options; the
  first choice is the default, each entry's `options` is the typed
  value `duel_create_table` receives (Nat fields as bigint), and
  `formatOptions` labels a table's options in the lobby.

Copy `index.html.template`, `app.js.template`, `style.css.template` into
`frontend/src/`, filling `__GAME_TITLE__`, `__PLUGIN_FILE__`,
`__IDLE_TIMEOUT_SECONDS__`. `style.css` may stay empty but must exist
(`build.js` copies it). `app.js` reads the backend's id from the `ic_env`
cookie the frontend canister sets, resolves a non-spoofable anonymous
identity, builds the actor, connects the transport, and calls
`start({ plugin, transport, session })`; esbuild inlines every dependency, so
no CDN or import map. With bot support or a leaderboard, uncomment the
lines marked BOTS or LEADERBOARD in both `app.js` and `index.html`:
`bots.js`'s `mountBotChallenge` is "Add Bot" on the waiting screen, the
bot list, the seat choice and the invite (a Rematch re-invites the bot
by itself), and `mountLeaderboard` is the 🏆 overlay, whose bot rows
challenge too (`frontend/README.md`, "Bots and the leaderboard"). For Internet Identity login, swap
`resolveAnonymousIdentity()` for `identity.js`'s `resolveIdentity()`
(`frontend/README.md`, "Logging in with Internet Identity").

`start()` returns the headless `DuelClient` it drives, and takes
`screens` (any subset of the default screens replaced by your own
`view -> HTML` functions), `confirm`, and `promptCode`. Reach for
`screens` when the user wants a screen in the game's own voice (a themed
debrief, a lobby with its own layout) but the interaction model is still
buttons and text. A replaced `debrief` still draws the final board
(or at least the final round): the move that ended the game is the one
the player most wants to see. If the UI genuinely doesn't fit that
(canvas, 3D, drag and drop, a framework client, its own lobby), read
`references/rich-ui.md` before writing `app.js`: it covers binding
`createDuelClient()` directly, including showing your own move at once.

## Step 7 — Project/deploy config

| Template                     | Destination                  | Fill in                                 |
| ---------------------------- | ---------------------------- | --------------------------------------- |
| `mops.toml.template`         | `mops.toml`                  | `__GAME_SLUG__`                         |
| `package.json.template`      | `frontend/package.json`      | `__GAME_SLUG__`                         |
| `build.js.template`          | `frontend/build.js`          | `__PLUGIN_FILE__` (header comment only) |
| `icp.yaml.template`          | `icp.yaml`                   | — (unless renaming canisters)           |
| `publish_wasm.sh.template`   | `publish_wasm.sh`            | — (next to `icp.yaml`)                  |
| `play-test.mjs.template`     | `frontend/play-test.mjs`     | `__GAME_TITLE__`, `__PLUGIN_FILE__`     |
| `mcp.json.template`          | `.mcp.json`                  | — (cloud session only, `going-live.md`) |
| `BotIface.mo.template`       | `src/BotIface.mo`            | `__RULES_MODULE__` (bot support only)   |
| `check-upgrade.mjs.template` | `frontend/check-upgrade.mjs` | `__HOST_FILE__` (`Host.mo`)             |
| `CLAUDE.md.template`         | `CLAUDE.md`                  | every `__...__`, at the first deploy    |

```bash
mops install && mops test
cd frontend && npm install && npm run build && cd ..
node --check frontend/dist/app.js
icp network start -d       # once; a private copy of the Internet Computer
icp deploy                 # both canisters, locally; prints the frontend's URL
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

Anyone can download the module a backend runs and test a frontend or a
bot of their own against a local copy: clients look it up in
hosty.live's module store by the canister's certified `module_hash`
(backend README, "Downloadable wasm"). A backend that goes live through
hosty.live is stored there by hosty.live; for one deployed with `icp
deploy -e ic`, the template's `icp.yaml` runs `sh publish_wasm.sh
backend` as the backend's sync step, which uploads the module the
canister now runs to the store after every mainnet install, reinstall
and upgrade (with the user's hosty.live token in `HOSTY_TOKEN`), and
does nothing on a local deploy. Keep the step when adapting the file,
and never set `snapshot_visibility: public`: a snapshot would publish
the whole heap, access codes included. If the backend canister is
renamed, pass the new name to the script. After the first deploy,
check the game's public face:

```bash
ID=$(icp canister status backend -i)
curl http://$ID.raw.localhost:8000/semantics
```

The local frontend deploys through the `@dfinity/static-site` recipe.
Its `build` step runs `npm run build`, so deploys always bundle current
source; `npm install` remains a manual step. The canister sends no
headers of its own: to add a CSP or `Cache-Control`, put a `_headers`
file in `frontend/src/` and copy it into `dist/` from `build.js` (see
`examples/tic-tac-toe/frontend/src/_headers`).

Then the game wants human eyes: both seats in two browser tabs, a table
created in one and joined from the other, a round resolved and the
debrief/rematch loop. Check that your move appears the instant you
click, that the opponent's move is marked when it lands, and that the
debrief still shows the final move. On the user's computer that is the
local URL `icp deploy` printed. In a cloud session nobody can open it:
once the three checks above pass, tell the user the game is ready for
its first look, which is online in its own two canisters (about 2.5 TC
from their hosty.live balance, kept unlisted until they register it),
and go on with Step 8 when they agree. Tests passing and the frontend
building are necessary, not sufficient.

## Step 8 — Go live

Do this only when the user asks, following `references/going-live.md`
step by step; leave the same steps in the project's `README.md`. Keep
the whole game on one route:

- **Through hosty.live** (setups 1 and 2; the only one in a cloud
  session, and the right one for a user new to the Internet Computer):
  an Internet Identity login and a balance paid by card. You create the
  backend, bot and page canisters with `hosty_create_canister`, install
  the backend's module (`icp build backend`) with
  `hosty_prepare_wasm_upload`, and upload the zipped `dist` with
  `hosty_prepare_zip_upload`, setting the page's
  `PUBLIC_CANISTER_ID:backend` canister variable with that upload, all
  after the user approves one deploy session in the hosty.live web app.
  Then `(cd frontend && node play-test.mjs <backend-id> --ic)` and the
  `frontendUrl` for
  the user.
- **With icp-cli** (setup 3, on the user's own computer only): the
  user's own identity (`icp identity new`), cycles bought by card at
  cycle.express, and `icp deploy backend -e ic` / `icp deploy frontend
-e ic`, with the hosty.live API token in `HOSTY_TOKEN` so the sync
  step can publish the module.

Either way, the user then lists the frontend on the Duel dashboard;
until then the game is online but unlisted. Write the repository's
`CLAUDE.md` from its template once the canister ids exist, and keep the
game on the default branch. Every later upgrade of the backend first
passes `(cd frontend && node check-upgrade.mjs <backend-id>)`
(`references/changing-a-live-game.md`).

## Common pitfalls

- **No plain Candid method for any game mutation**, not even "to test
  with a canister call". Use the frontend or a `transport`-speaking client.
- **Never let a client value stand in for something the rules should
  compute** (Step 2, point 2).
- **The rules are the only legality gate** (`validate`, or `move`'s
  `#err`). If the plugin's `legal()` disagrees, the plugin has a
  cosmetic bug; so does an `applyLocal` that disagrees with the rules.
- **Nothing a seat must not see leaves `view`.** A `View = State` for a
  game with a hidden hand ships the opponent's cards to every client.
- **Never hide the last move.** A debrief showing only a verdict or a
  score, or a board with no mark on what the opponent just did, leaves
  the player guessing what happened.
- **No engine bookkeeping in `State`.** A timestamp or "waiting for
  opponent" flag in your state means the design drifted from "just the
  rules".
- **`null` verdict means continue**, not "no winner ever".
- **A stale `SEMANTICS` is a broken public contract.** Third-party
  frontends are generated from that text alone; re-read it after every
  rules change.
