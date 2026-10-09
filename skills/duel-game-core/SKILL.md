---
name: duel-game-core
description: Build a complete, deployable 2-player game on duel-game-core from nothing but a plain-English rules description in the prompt — the user supplies only the rules, you write the Motoko rules module (Spec<S,M,V,O>), Host actor, tests, and the frontend GamePlugin end to end, using this skill's own templates and (for a canvas/3D UI, an existing client to port, or a game whose ending takes many rounds to reach in a test) its references/. Use whenever someone hands you the rules for a duel/card/board/arena game (in their own words, a design doc, or a rulebook excerpt) and wants it built as a duel-game-core game, especially in a repo that does not already contain duel-game-core's own source (installed standalone via `npx skills add research-ag/duel-core --skill duel-game-core`). Also use when someone wants their own frontend (references/frontend-for-existing-game.md) or a bot (references/bot-for-existing-game.md) for an already-deployed duel-game-core game, given only its canister id.
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

A finished game is six pieces of game-specific code:

1. `src/<Rules>.mo` — a pure module exporting `State`, `Action`, `View`,
   `Options` and a `spec : TP.Spec<State, Action, View, Options>`.
2. `src/Host.mo` — a thin host actor; copy the template.
3. `test/RulesUnit.test.mo` — unit checks for your rules functions (the
   engine has its own suite).
4. `frontend/src/<game>-plugin.js` — a `GamePlugin`.
5. `frontend/src/index.html` + `app.js` + `style.css` — copy the
   templates.
6. `icp.yaml`, `publish_wasm.sh`, `mops.toml`, `frontend/package.json`,
   `frontend/.npmrc`, `frontend/build.js` — copy the templates, fill in
   names.

Every template lives in `templates/`; read each one right before adapting
it. `references/` covers six situations the templates don't:
`turn-based-games.md`, `canister-player-bots.md`, `rich-ui.md`,
`testing-deep-dive.md`, and, for a game someone else already deployed,
from its canister id alone, `frontend-for-existing-game.md` (a new
frontend) and `bot-for-existing-game.md` (a canister player) — read
them only when you hit that situation.

## Step 1 — Get the packages into the project

You are very likely in a new repo, separate from `research-ag/duel-core`.

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

Frontend: `npm view duel-game-core version`. If it resolves, keep
`"duel-game-core": "*"` and `npm install duel-game-core --save-exact`.
Otherwise set it to `"file:../duel-core/frontend"` (the template `.npmrc`'s
`install-links=true` is required for a `file:` dependency) and **build the
clone's frontend first**: `cd ../duel-core/frontend && npm install
--legacy-peer-deps && npm run build` — the package ships from `dist/`,
which a fresh clone lacks. A `file:` dependency is a copy: after a `git
pull` of the clone, rebuild it and reinstall here (see the framework's
root `CLAUDE.md`, "After touching anything under `frontend/`").

The installed package ships both READMEs:
`.mops/duel-game-core@<version>/README.md` (or
`../duel-core/backend/README.md`) and
`node_modules/duel-game-core/README.md`.

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
before its own claim window even opens. Change nothing else.

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
  a deck list) goes in as a further `(path, () -> Text)` route. The same
  mixin serves the canister's own module at `GET /wasm`, taken in
  through the controllers-only `wasm_upload_*` methods that
  `publish_wasm.sh` calls at deploy time (Step 7); nothing to wire.

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

**Canister players (optional).** Only if asked for a bot/AI opponent.
Nothing to add to `mops.toml`. The inter-canister call to the bot is
the one function only game code can write (its result type is your
`Action`), so it lives in `src/BotIface.mo` next to the bot's actor
type:

```motoko
// src/BotIface.mo
import Principal "mo:core/Principal";
import CanisterPlayers "mo:duel-game-core/canister_players";
import TP "mo:duel-game-core";
import Rules "__RULES_MODULE__";

module {
  public type CanisterPlayer = actor {
    make_move : (TP.MoveRequest<Rules.View, Rules.Action>) -> async Rules.Action;
  };

  /// Asks a seated bot canister for its move; the transport's `CallBot`.
  public func callBot<system>(bot : TP.PlayerId, req : TP.MoveRequest<Rules.View, Rules.Action>, k : <system>(?Rules.Action) -> async* ()) : async* () {
    let b : CanisterPlayer = actor (CanisterPlayers.principalOfCanisterSession(bot).toText());
    try { await* k<system>(?(await b.make_move(req))) } catch (_) {
      await* k<system>(null);
    };
  };
};

```

Then extend `Host.mo`:

```motoko
import CanisterPlayers "mo:duel-game-core/canister_players";
import CanisterPlayersActorMixin "mo:duel-game-core/canister_players_actor_mixin";
import BotIface "BotIface";

actor {
  // ...pt, duel...
  let bots = CanisterPlayers.newStore(); // the bot directory and in-flight asks — stable

  transient let env : Transport.Env<Rules.State, Rules.Action, Rules.View, Rules.Options> = {
    spec = Rules.spec;
    bots = ?{ store = bots; call = BotIface.callBot };
    scoring = null; // or a leaderboard, below
  };

  include TransportActorMixin<system>(duel.lobby(env));
  // ...the four host methods unchanged...
  include CanisterPlayersActorMixin(duel.canisterPlayers(env), bots.directory, null); // ?leaderboard once wired
};

```

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
`icp canister call bot register '(principal "<host-canister-id>", "MyBot")'`.
The bot then appears in every player's "🤖 Bots" dialog and the
leaderboard's Challenge buttons (`frontend/README.md`, "Bot registry"),
and a Rematch against it re-invites it automatically.

**Leaderboard (optional).** Only if asked for rankings. The framework
scores every finished game itself; you declare the board and pick the
rating that fits the game. A game played against each other wants Elo
(`#claimed`/`#aborted` count like a win). Nothing to add to
`mops.toml`:

```motoko
import Leaderboard "mo:duel-game-core/leaderboard";
import LeaderboardActorMixin "mo:duel-game-core/leaderboard_actor_mixin";

actor {
  let leaderboard = Leaderboard.new(50, 1200); // keep 50, start at 1200 — stable

  transient let env : Transport.Env<Rules.State, Rules.Action, Rules.View, Rules.Options> = {
    spec = Rules.spec;
    bots = null; // or the bots above
    scoring = ?{ board = leaderboard; rating = #elo { k = 32 } };
  };

  include LeaderboardActorMixin(leaderboard, 25); // get_leaderboard(), top 25
};

```

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
`cp:<principal>:<complexity>` — so a bot is rated per complexity. On
the frontend, call `actor.get_leaderboard()` (already declared by
`idl.js`) and `renderLeaderboard(entries, plugin, { yourSid: session.sid, botNames })`
(`botNames` from `actor.list_bots().catch(() => [])`). Use the examples'
panel shape: an icon-only 🏆 toggle first in `.session` opening a
full-page overlay (`#leaderboard-panel`), never an inline panel a status
view could clobber. Add `formatScore` to the plugin only for a converted
metric.

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
(`build.js` copies it). `app.js` resolves a non-spoofable anonymous
identity, builds the actor, connects the transport, and calls
`start({ plugin, transport, session })`; esbuild inlines every dependency, so
no CDN or import map. For Internet Identity login, swap
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

| Template                   | Destination             | Fill in                                 |
| -------------------------- | ----------------------- | --------------------------------------- |
| `mops.toml.template`       | `mops.toml`             | `__GAME_SLUG__`                         |
| `package.json.template`    | `frontend/package.json` | `__GAME_SLUG__`                         |
| `.npmrc.template`          | `frontend/.npmrc`       | —                                       |
| `build.js.template`        | `frontend/build.js`     | `__PLUGIN_FILE__` (header comment only) |
| `icp.yaml.template`        | `icp.yaml`              | — (unless renaming canisters)           |
| `publish_wasm.sh.template` | `publish_wasm.sh`       | — (next to `icp.yaml`)                  |

```bash
mops install && mops test
cd frontend && npm install --legacy-peer-deps && npm run build && cd ..
node --check frontend/dist/app.js
icp deploy                 # local; `icp network start` must be running
icp deploy --network ic    # mainnet — spends cycles
```

The backend always serves its own wasm: the template's `icp.yaml` runs
`sh publish_wasm.sh backend` as the backend's sync step, so every
install, reinstall and upgrade uploads the module the canister now runs
to the canister itself, and anyone can download it at `GET /wasm` and
test a frontend of their own against a local copy (backend README,
"Downloadable wasm"). Keep the step when adapting the file, and
never set `snapshot_visibility: public`: a snapshot would publish the
whole heap, access codes included. If the backend canister is renamed, pass
the new name to the script. After the first deploy, check the two
public faces of the game:

```bash
ID=$(icp canister status backend -i)
curl http://$ID.raw.localhost:8000/semantics
curl -s http://$ID.raw.localhost:8000/wasm | shasum -a 256   # equals module_hash in
icp canister status backend --json
```

The frontend deploys through the `@dfinity/static-site` recipe. Its
`build` step runs `npm run build`, so deploys always bundle current
source; `npm install` remains a manual step. The canister sends no
headers of its own: to add a CSP or `Cache-Control`, put a `_headers`
file in `frontend/src/` and copy it into `dist/` from `build.js` (see
`examples/tic-tac-toe/frontend/src/_headers`).

Then play both seats in two browser tabs: create a table in one, join
from the other, and confirm a round resolves and the debrief/rematch loop
works. Check that your move appears the instant you click, that the
opponent's move is marked when it lands, and that the debrief still
shows the final move. Tests passing and the frontend building are
necessary, not sufficient.

## Common pitfalls

- **No plain Candid method for any game mutation**, not even "to test
  with a canister call". Use the frontend or a `transport`-speaking client. (The
  HTTP mixin's `wasm_upload_*` are the engine's own, controllers-only,
  and touch no game state.)
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
