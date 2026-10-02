---
name: duel-game-core
description: Build a complete, deployable 2-player game on duel-game-core from nothing but a plain-English rules description in the prompt — the user supplies only the rules, you write the Motoko Spec<S,M> module, Host actor, tests, and the frontend GamePlugin end to end, using this skill's own templates and (for a canvas/3D UI, an existing client to port, or a game whose ending takes many rounds to reach in a test) its references/. Use whenever someone hands you the rules for a duel/card/board/arena game (in their own words, a design doc, or a rulebook excerpt) and wants it built as a duel-game-core game, especially in a repo that does not already contain duel-game-core's own source (installed standalone via `npx skills add research-ag/duel-core --skill duel-game-core`).
---

# Building a duel-game-core Game From Rules Alone

## What this is

`duel-game-core` (https://github.com/research-ag/duel-core) is two
rules-agnostic packages — a Motoko mops package (session engine) and an
npm package (browser client) — implementing everything a 2-player game
needs except the game itself: a multi-table lobby (open or access-code
protected tables), seating, round submission, debrief, idle takeover,
rematch, claim-win, session identity, the polling transport, a headless client
holding all of that browser-side, and default screens over it that a
game can replace one at a time or entirely.

The user gives you rules, nothing else; you produce the whole game. Make
the State/Action/rendering design calls yourself. Ask only when the rules
are genuinely ambiguous about game logic (a win condition, a limit),
never about engine mechanics (seating, rematch, timeouts — already
handled).

A finished game is six pieces of game-specific code:

1. `src/<Rules>.mo` — a pure module implementing `TP.Spec<State, Action>`.
2. `src/Host.mo` — a thin host actor; copy the template.
3. `test/RulesUnit.test.mo` — unit checks for your `validate`/`resolve`
   (the engine has its own suite).
4. `frontend/src/<game>-plugin.js` — a `GamePlugin`.
5. `frontend/src/index.html` + `app.js` + `style.css` — copy the
   templates.
6. `icp.yaml`, `mops.toml`, `frontend/package.json`, `frontend/.npmrc`,
   `frontend/build.js` — copy the templates, fill in names.

Every template lives in `templates/`; read each one right before adapting
it. `references/` covers four situations the templates don't:
`alternating-turn-games.md`, `canister-player-bots.md`, `rich-ui.md`,
`testing-deep-dive.md` — read them only when you hit that situation.

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
core = "2.6.1"
```

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

## Step 2 — Turn the rules into `State` / `Action`

Read the rules fully, then answer:

1. **Do both seats act at once, or take turns?** `#simultaneous` (both
   submit; `resolve : (State, Action, Action) -> ...`) is what
   `templates/Rules.mo.template` is written for. `#alternating` (the
   on-turn seat submits; `resolve : (State, Seat, Action) -> ...`; the
   engine tracks whose turn it is, so `State` needs no turn flag) — read
   `references/alternating-turn-games.md`; `examples/checkers` in the
   framework repo is the worked example.
2. **`Action` is a raw decision, never a derived value.** A damage number
   or result that is a function of `State` plus the choice belongs in
   `resolve`, not `Action`: `{ #attack; #defend }`, not `{ #attack : {
damage : Nat } }`. Client input is untrusted. This is the single most
   common mistake when porting an existing game.
3. **What persists in `State` across rounds?** Only what future rounds
   need, plus whatever the client needs to show the opponent's last move
   (Step 6). A `#simultaneous` game whose state doesn't reveal both
   picks (rock-paper-scissors) carries a `lastRound : ?Round`; a board
   game can leave it out, since the plugin can diff two boards.
4. **What ends the game?** Map every win/lose/draw to `resolve`'s
   `verdict : ?TP.Verdict` (`#p1Wins`/`#p2Wins`/`#draw`). `null` means
   "continue", not "draw".
5. **Is a number a player choice or fixed data?** A fixed board/deck is a
   `let`, not a field.
6. **Two Motoko traps:** a module-level `let` must be static (no function
   calls — `M0014`); `Nat` subtraction traps on underflow, so guard every
   `a - b` with `a >= b`.
7. **Porting an existing game:** document every deliberate simplification
   in the rules module's doc header, and match ported formulas exactly
   (Motoko `Float` and JS `number` are both IEEE754 doubles, so client and
   server agree bit-for-bit) — note the source file/line per piece.
8. **More than one rules variant, picked by a table's creator?** (see the
   backend README's "Table variants")
   - **Same fields, different legality** → flat `Action`/`State`, a
     `variant` field on `State`, and a branch in `validate`.
     `init(raw : Text)` parses the stored text into a closed type with a
     safe default for `""`/unrecognized. Build `resolve` against the
     variant with the most legal moves (`examples/rock-paper-scissors`);
     branch `resolve` on `s.variant` only when a variant changes what a
     move does (`examples/chopsticks`).
   - **Different fields entirely** → tag `Action` into a union over each
     variant's payload, dispatched through a variant-keyed lookup (see the
     template's commented-out alternative). Still one Candid type; the
     wire shape stays opaque `Text`.
   - No variants: `init` still takes the `Text`, and ignores it.

Once you can state in a sentence each what `State` holds, what
`Action`'s variants are, what `validate` rejects, and what `resolve`
computes, write the module.

### Worked mini example

_"Rock-paper-scissors. Each round both pick; the usual beats-relationship
decides the round. First to 3 round wins takes the match; a tie scores
nobody."_

- `Action = { #rock; #paper; #scissors }`.
- `State = { p1Score : Nat; p2Score : Nat }`.
- `validate` returns `null` unconditionally.
- `resolve` decides the round, bumps a score, returns `?#p1Wins`/
  `?#p2Wins` at 3, else `null`.

## Step 3 — Write the Rules module

From `templates/Rules.mo.template`, write `src/<YourGame>Rules.mo`:

- `__RULES_MODULE__`, `__GAME_TITLE__`, `__P1_NAME__`, `__P2_NAME__`.
- Replace the "Rules" doc block with the actual rules, one line per
  mechanic — the most useful comment in the game.
- Fill in `Action`, `Side`, `State`, `freshSide`, `validate`, `resolve`.
  `init` takes the table's variant text (`""` for a game without
  variants; the parameter is then unused).
- Keep everything pure: no `Time`, no mutation, no storage; `{ me with
... }`, never in-place. `Spec` is passed fresh on every call and never
  stored.

## Step 4 — Write the host actor

From `templates/Host.mo.template`, write `src/Host.mo`, filling in only
`__RULES_MODULE__`, `__IDLE_TIMEOUT_NS__` (`90_000_000_000` = 90s: how
long an abandoned game sits before a third party may take it over, and
how long a waiting seat whose player has disconnected is kept), and
`__CLAIM_TIMEOUT_NS__` (`60_000_000_000` = 60s: how long your submitted
move may sit against the opponent's silence before you may claim the
win). Both go into `registry.setTimeouts` on the line after
`Registry.new()`: a stable `registry` runs its initializer only on first
install, while `setTimeouts` runs on every upgrade. Keep
`idleTimeoutNs` comfortably above `claimTimeoutNs` (at least 15s of
margin) — an idle game can otherwise be taken over by a third party
before its own claim window even opens. Change nothing else. Do not add plain Candid methods for
`createTable`/`joinTable`/`submit`/`rematch`/`leave`/`reset`/`claimWin`/
`ackEnded` — `mo:duel-game-core/transport` (`Transport.attach` + `ActorMixin`) is the
only mutation path; a direct update call reopens the ordering race it
closes. `status` stays a plain `query`. The template wires a
`Registry`, so the game gets a multi-table lobby for free.

**Claim a win.** The generic `#inGame` screen renders a "Claim the win"
button with its own countdown once `claimWinAvailable` turns true, and
shows the deciding opponent the mirror warning. Nothing in `GamePlugin`
is involved. In an `#alternating` game only the seat NOT on turn ever
sees the control.

**Metrics (optional).** Only if asked for observability: `mops add
promtracker` and

```motoko
import PT "mo:promtracker";
import Http "mo:promtracker/mixins/http";

persistent actor {
  let pt = PT.Tracker.new();
  transient let renderer = PT.Renderer();
  renderer.addValue(PT.allSystemMetrics);
  renderer.addValue(pt.toValue());

  let registry : TP.Registry<Rules.State, Rules.Action> = Registry.new();
  registry.setTimeouts(__IDLE_TIMEOUT_NS__, __CLAIM_TIMEOUT_NS__);
  registry.attachMetrics(pt); // games_started / active_games / rounds_per_game / matchmaking_wait_seconds

  // ...status/Transport.attach/ActorMixin as in the template...
  include Http(renderer.renderExposition, "/metrics");
};

```

See the backend README's "Metrics" and `examples/racing/src/Host.mo`.

**Canister players (optional).** Only if asked for a bot/AI opponent.
Nothing to add to `mops.toml`. Extend `Host.mo`:

```motoko
import Principal "mo:core/Principal";
import Timer "mo:core/Timer";
import CanisterPlayers "mo:duel-game-core/canister_players";
import CanisterPlayersActorMixin "mo:duel-game-core/canister_players_actor_mixin";
import BotIface "BotIface"; // make_move : (TP.MoveRequest<Rules.State, Rules.Action>) -> async Rules.Action

persistent actor {
  // ...registry/status; Transport.attach's onSettled argument becomes ?settle...

  transient var settleTable : ?((Int, TP.TableId) -> async* ()) = null;
  transient let settle = func(now : Int, id : TP.TableId) : async* () {
    switch (settleTable) { case (?f) await* f(now, id); case null {} };
  };

  transient let cpAttached = CanisterPlayers.attach<Rules.State, Rules.Action>(
    Rules.spec(),
    registry,
    attached.afterMutation,
    true, // afterMutationSettles: `attached` runs `settle` via onSettled
    func(session, req, k) : async* () {
      let p = CanisterPlayers.principalOfCanisterSession(session);
      let bot : BotIface.CanisterPlayer = actor (p.toText());
      try { await* k(?(await bot.make_move(req))) } catch (_) { await* k(null) };
    },
    func(id : TP.TableId, secs : Nat) : async* () {
      ignore Timer.setTimer<system>(#seconds secs, func() : async () { await* settle(Time.now(), id) });
    },
  );
  settleTable := ?cpAttached.settle;

  let botDirectory = CanisterPlayers.newBotDirectory();
  include CanisterPlayersActorMixin(cpAttached, botDirectory, null); // ?leaderboard once wired

  transient let combinedSweep = func(now : Int) : async* () {
    await* attached.sweep(now);
    await* cpAttached.sweep(now);
  };
  include ActorMixin<system>(attached.endpoint, combinedSweep);
};

```

Add `src/BotIface.mo` (one method, `make_move`) and, if writing the bot,
a `bot/Bot.mo`/`bot/BotLogic.mo` pair like `examples/checkers/bot/`. The
backend README's "Canister players" has the full design. `MoveRequest`
also carries `turn`/`gen`, `opponent`, `opponentLastMove`, and
`lastRoundDurationNs`; a bot that only reads `game`/`seat`/`turn` is a
pure `query`, which is the right default; a bot that needs randomness
stays one by seeding from `Time.now()`. Read
`references/canister-player-bots.md` before writing a bot that picks at
random or remembers anything — the latter makes `make_move` no longer a
`query`.

A challengeable bot self-registers once, by hand, after both canisters
are deployed:

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

**Leaderboard (optional).** Only if asked for rankings. A win/lose/draw
game wants ELO (`#claimed`/`#aborted` count like a win); another metric
is tracked directly, converted to higher-is-better if needed. Nothing to
add to `mops.toml`:

```motoko
import Leaderboard "mo:duel-game-core/leaderboard";
import LeaderboardActorMixin "mo:duel-game-core/leaderboard_actor_mixin";
import Elo "mo:duel-game-core/elo";

persistent actor {
  let STARTING_ELO : Int = 1200; // your call; elo.mo has no opinion
  let leaderboard = Leaderboard.new(50, STARTING_ELO); // keep 50, show 25

  func onGameEnded(_id : TP.TableId, p1 : TP.SessionId, p2 : TP.SessionId, d : TP.Debrief<Rules.State>) {
    let outcome : Elo.Outcome = switch (d.end) {
      case (#finished(#p1Wins)) #aWins;
      case (#finished(#p2Wins)) #bWins;
      case (#finished(#draw)) #draw;
      case (#claimed(#p1)) #aWins;
      case (#claimed(#p2)) #bWins;
      case (#aborted(#p1)) #bWins;
      case (#aborted(#p2)) #aWins;
    };
    let (k1, k2) = (Transport.playerKey(p1), Transport.playerKey(p2));
    let (r1, r2) = Elo.update(Leaderboard.scoreOf(leaderboard, k1), Leaderboard.scoreOf(leaderboard, k2), outcome, 32);
    let now = Time.now();
    Leaderboard.setScore(leaderboard, k1, r1, now);
    Leaderboard.setScore(leaderboard, k2, r2, now);
  };

  // ...Transport.attach's onGameEnded argument becomes ?onGameEnded...
  include LeaderboardActorMixin(leaderboard, 25);
};

```

For a metric like a best time, first check whether game state already
tells you (`examples/racing` derives the lap time from `Debrief.turns`
and the final state). Only when real elapsed time is genuinely needed,
wire `onGameStarted` (the third `null` after the codec):

```motoko
let leaderboard = Leaderboard.new(50, 0); // defaultScore unused by this shape
func scoreFromYourMetric(raw : Int) : Int = Int.max(0, 3_600_000 - raw); // lower-is-better -> higher

let matchStarts = Map.empty<TP.TableId, Int>();
func onGameStarted(id : TP.TableId, _p1 : TP.SessionId, _p2 : TP.SessionId) {
  matchStarts.add(id, Time.now());
};
func onGameEnded(id : TP.TableId, p1 : TP.SessionId, p2 : TP.SessionId, d : TP.Debrief<Rules.State>) {
  // read d.end/d.finalGame, elapsed = Time.now() - matchStarts.get(id),
  // Leaderboard.recordIfBetter(leaderboard, Transport.playerKey(winner), scoreFromYourMetric(raw), Time.now())
  matchStarts.remove(id);
};

```

With canister players, special-case
`CanisterPlayers.leaderboardKeyOfSession(sid)` before `Transport.playerKey`, so
a bot's rating accumulates across tables, per complexity. On the
frontend, call `actor.get_leaderboard()` (already declared by `idl.js`)
and `renderLeaderboard(entries, plugin, { yourSid: session.sid, botNames })`
(`botNames` from `actor.list_bots().catch(() => [])`). Use the examples'
panel shape: an icon-only 🏆 toggle first in `.session` opening a
full-page overlay (`#leaderboard-panel`), never an inline panel a status
view could clobber. Add `formatScore` to the plugin only for a converted
metric.

## Step 5 — Write the rules unit tests

From `templates/RulesUnit.test.mo.template`, write `test/RulesUnit.test.mo`.
Cover at minimum:

- `init("")` is the starting position and `spec()` hands out your own
  functions (section 1 of the template). With variants, also `init` per
  key plus one unrecognized string.
- One `validate` case per way a move can be illegal; every legal case
  accepted.
- One `resolve` case per win/lose/draw path, plus scoring edge cases.

Do not test join/leave/rematch/takeover — the engine's suite does.
Synthetic states are sufficient and far faster than driving the engine.
If a genuine end-to-end test needs a game that takes many rounds to
finish, read `references/testing-deep-dive.md` first.

```bash
moc -r --package core <path-to-core/src> --package duel-game-core <path-to-backend/src> test/RulesUnit.test.mo
# or, with mops.toml listing both: mops test
```

## Step 6 — Write the frontend GamePlugin

From `templates/plugin.js.template`, write `frontend/src/<game>-plugin.js`:

- `idlTypes({ IDL })` must match your `State`/`Action` Candid shape
  exactly, and only those (the engine's own types are already known).
  `Nat`/`Int` decode to `bigint`; a tuple decodes to an array.
- `seatLabel(seat)`.
- `renderBoard(gameState, mySeat, oppSeat)` — an HTML string, valid for
  a live game and a debrief. `esc()` any text from game state. It must
  show the opponent's most recent move, live and in the debrief: a
  highlighted cell, a piece's origin and landing, captured pieces as
  ghosts, or both picks of the last round. Without `lastRound` in
  `State`, find the move by diffing the board against the previous one
  the plugin saw (`examples/tic-tac-toe`, `examples/checkers`).
- `renderActions(gameState, mySeat)` — one `<button>` per action via
  `actionAttr()`. Disable via a cosmetic `legal()` mirror of `validate`;
  the engine still runs the real one.
- `applyLocal(gameState, mySeat, move)` — the state with the player's
  own move applied, a cosmetic mirror of `resolve` (for
  `#alternating`, the board after the move; for `#simultaneous`,
  usually `gameState` unchanged). The default UI draws it the moment the
  move is sent, so a player never stares at an unchanged board while the
  submit, or a bot's reply, is in flight. Return `null` only for a move
  you can't predict. Write it for every game.
- `formatScore(score)` — only for a converted-metric leaderboard.
- `variantChoices()`/`formatVariant(variant)` — only with variants; the
  first choice is the default, each `key` is what `init` receives.

Copy `index.html.template`, `app.js.template`, `style.css.template` into
`frontend/src/`, filling `__GAME_TITLE__`, `__PLUGIN_FILE__`,
`__IDLE_TIMEOUT_SECONDS__`. `style.css` may stay empty but must exist
(`build.js` copies it). `app.js` resolves a non-spoofable anonymous
identity, builds the actor, connects the transport, and calls
`start({ plugin, ws, session })`; esbuild inlines every dependency, so
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

| Template                | Destination             | Fill in                                 |
| ----------------------- | ----------------------- | --------------------------------------- |
| `mops.toml.template`    | `mops.toml`             | `__GAME_SLUG__`                         |
| `package.json.template` | `frontend/package.json` | `__GAME_SLUG__`                         |
| `.npmrc.template`       | `frontend/.npmrc`       | —                                       |
| `build.js.template`     | `frontend/build.js`     | `__PLUGIN_FILE__` (header comment only) |
| `icp.yaml.template`     | `icp.yaml`              | — (unless renaming canisters)           |

```bash
mops install && mops test
cd frontend && npm install --legacy-peer-deps && npm run build && cd ..
node --check frontend/dist/app.js
icp deploy                 # local; `icp network start` must be running
icp deploy --network ic    # mainnet — spends cycles
```

The asset-canister recipe must be v2.3.0 or newer (v2.1.0's sync step is
rejected by icp-cli 1.x). Its `build` step runs `npm run build`, so
deploys always bundle current source; `npm install` remains a manual
step.

Then play both seats in two browser tabs: create a table in one, join
from the other, and confirm a round resolves and the debrief/rematch loop
works. Check that your move appears the instant you click, that the
opponent's move is marked when it lands, and that the debrief still
shows the final move. Tests passing and the frontend building are
necessary, not sufficient.

## Common pitfalls

- **No plain Candid method for any mutation**, not even "to test with a
  canister call". Use the frontend or a `ws`-speaking client.
- **Never let a client value stand in for something `resolve` should
  compute** (Step 2, point 2).
- **`validate` is the only legality gate.** If the plugin's `legal()`
  disagrees, the plugin has a cosmetic bug; so does an `applyLocal` that
  disagrees with `resolve`.
- **Never hide the last move.** A debrief showing only a verdict or a
  score, or a board with no mark on what the opponent just did, leaves
  the player guessing what happened.
- **No engine bookkeeping in `State`.** A timestamp or "waiting for
  opponent" flag in your state means the design drifted from "just the
  rules".
- **`null` verdict means continue**, not "no winner ever".
