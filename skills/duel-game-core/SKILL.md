---
name: duel-game-core
description: Build a complete, deployable 2-player game on duel-game-core from nothing but a plain-English rules description in the prompt — the user supplies only the rules, you write the Motoko Spec<S,M> module, Host actor, tests, and the frontend GamePlugin end to end, using this skill's own templates and (for a canvas/3D UI, an existing client to port, or a game whose ending takes many rounds to reach in a test) its references/. Use whenever someone hands you the rules for a duel/card/board/arena game (in their own words, a design doc, or a rulebook excerpt) and wants it built as a duel-game-core game, especially in a repo that does not already contain duel-game-core's own source (installed standalone via `npx skills add research-ag/duel-core --skill duel-game-core`).
---

# Building a duel-game-core Game From Rules Alone

## What this is

`duel-game-core` (https://github.com/research-ag/duel-core) is two
rules-agnostic packages — a Motoko mops package (session engine) and an
npm package (matching browser client) — that together implement
everything a simultaneous-reveal, turn-based 2-player game needs
_except_ the game itself: a multi-table lobby (anyone may open a table,
open or access-code protected, and any number run simultaneously),
seating, round submission, debrief, idle takeover, rematch, session
identity, real-time push, and the generic lobby/staging/rematch/debrief
screens.

This skill's job is narrower than "learn the framework": the user gives
you rules, nothing else, and you produce the whole game — every file
below — from that description alone. You are expected to make the
State/Action/rendering design calls yourself; only ask the user a
clarifying question when the rules text is genuinely ambiguous about
game _logic_ (a win condition, a resource limit), never about
`duel-game-core` mechanics itself (seating, rematch, idle timeouts — all
already handled, not the user's decision to make).

A finished game is exactly six pieces of game-specific code, all of
which this skill walks you through in order:

1. `src/<Rules>.mo` — a pure Motoko module implementing
   `TP.Spec<State, Action>` (`init`, `validate`, `resolve`).
2. `src/Host.mo` — a thin host actor. Copy the template verbatim; it
   almost never changes shape between games.
3. `test/RulesUnit.test.mo` — unit checks for your own `validate`/
   `resolve`, not the engine (the engine has its own test suite —
   you're not re-testing join/leave/rematch/idle-takeover).
4. `frontend/<game>-plugin.js` — a `GamePlugin`: two Candid types, seat
   labels, and how to draw the board and action buttons.
5. `frontend/index.html` + `frontend/app.js` + `frontend/style.css` —
   copy the templates (the first two verbatim; `style.css` may start
   empty); they wire the actor and hand off to the generic client.
6. `icp.yaml`, `mops.toml`, `frontend/package.json`, `frontend/.npmrc` —
   project/deploy config. Copy the templates, filling in names.

Every template referenced below lives in this skill's own `templates/`
directory — read each one with your file-reading tool right before you
adapt it; don't retype boilerplate from memory. Steps 4, 5, and 6 below
point into this skill's `references/` directory for three situations the
templates alone don't cover — a "bot"/"AI opponent" opting into the
optional canister-players feature, a game whose ending takes many real
rounds to reach in a test, and a UI that doesn't fit buttons/text (a
canvas, a 3D scene, or an existing framework-based client you're
porting) — read those files only if you actually hit that situation.

## Step 1 — Get the packages into the project

You're very likely starting a **new repo**, separate from
`research-ag/duel-core` itself (that repo is the framework's source, not
a place to build a game inside).

If this directory has no `mops.toml` yet, `mops add` has nothing to add
a dependency line to — create a minimal one first from
`templates/mops.toml.template` (fill in `__GAME_SLUG__`, leave the
`[dependencies]` block as-is; the next command edits it in place).
Likewise, create `frontend/package.json` from
`templates/package.json.template` before the `npm` commands below (see
Step 7 for the full config file list — nothing else there needs to exist
yet).

Backend (from the new repo's `backend/`-equivalent directory, wherever
your `mops.toml` lives):

```bash
mops add duel-game-core
```

If that succeeds, you're done — `duel-game-core` is on the mops
registry. **If it fails** (package not found — check `mops.toml` still
depends on `duel-game-core = "0.1.0"` or similar with no matching
registry entry), the package hasn't shipped to mops.one yet. Fall back
to a local clone, exactly the pattern `research-ag/duel-core`'s own
example games use while unpublished:

```bash
git clone https://github.com/research-ag/duel-core.git ../duel-core
```

then in `mops.toml`:

```toml
[dependencies]
duel-game-core = "../duel-core/backend"
core = "2.6.1"
```

Frontend: try `npm view duel-game-core version` first. If it resolves,
leave `templates/package.json.template`'s `"duel-game-core": "*"` as-is
and run `npm install duel-game-core --save-exact` to pin the real
version. If not, replace that `"*"` with
`"file:../duel-core/frontend"` instead — see `templates/.npmrc.template`
(its `install-links=true` is required for a `file:` dependency here; a
plain symlink install may not survive an asset-canister sync step).
Either way, **build the clone's
frontend once before depending on it**: `cd ../duel-core/frontend && npm
install && npm run build` — the npm package ships pre-compiled from
`dist/`, and a fresh clone has no `dist/` until you build it. If you
later `git pull` the clone, rebuild it again — a `file:` dependency is a
copy, not a live symlink, so `npm install` alone in your game's own
frontend will NOT pick up the change (see this repo's own root
`CLAUDE.md`, "After touching anything under `frontend/`", for the exact
gotcha and refresh recipe if you hit it).

Once installed, the package itself ships both READMEs — read them for
anything this skill doesn't cover:

- Backend: `.mops/duel-game-core@<version>/README.md` (registry install)
  or `../duel-core/backend/README.md` (local clone).
- Frontend: `node_modules/duel-game-core/README.md`.

## Step 2 — Turn the rules into `State` / `Action`

Read the rules text fully before writing any code. Then answer these
questions from it — this is the actual design work, and the only part
of this skill that requires judgment rather than copying a template:

1. **What does one round look like — do both seats act at once, or do
   they take turns?** The engine supports both natively, chosen by which
   arm your `spec()` builds:
   - **`#simultaneous`** (the common case — rock-paper-scissors,
     simultaneous card reveals, a duel): the round resolves the instant
     BOTH seats have submitted one move each; `resolve : (State, Action,
Action) -> ...` takes both. This is what
     `templates/Rules.mo.template` is written for — use it as-is.
   - **`#alternating`** (chess, checkers, tic-tac-toe — seats take turns
     in order): the round resolves the instant the ONE seat on turn
     submits; `resolve : (State, Seat, Action) -> ...` takes just that
     seat and move, and the engine tracks whose turn it is on its own —
     your `State` never needs a turn flag (the same trap as the "Every
     phase needs no special handling from you" pitfall near the end of
     this file, just for a different field). Read
     `references/alternating-turn-games.md` before writing `Rules.mo` for
     this case; `examples/checkers/src/CheckersRules.mo` is a complete
     worked example.
2. **`Action` must be a raw decision, never a value the server could
   derive.** If your rules description mentions a computed quantity (a
   damage number, a checksum, a result) that's a function of `State`
   plus the player's actual choice, don't put it in `Action` — compute
   it inside `resolve`. Concretely: `Action = { #attack; #defend }`, not
   `Action = { #attack : { damage : Nat } }` even if a client UI happens
   to have `damage` lying around. Anything a client sends is untrusted
   input; `validate`/`resolve` are the only code that can be trusted to
   get it right (this is CLAUDE.md architecture rule 2 in the source
   repo, restated here because it's the single most common mistake
   porting an existing game's rules).
3. **What must persist in `State` across rounds, and what's just this
   round's inputs?** Keep `State` to exactly what future rounds need to
   reference (health, resources, a turn counter, board position) — no
   more. A `lastRound : ?Round` field recording the previous round's
   moves (see `templates/Rules.mo.template`) is optional but cheap, and
   lets your `GamePlugin` show narration/history without extra
   engine plumbing.
4. **What ends the game, and how?** Map every win/lose/draw condition in
   the rules to `resolve`'s `verdict : ?TP.Verdict`, where `TP.Verdict =
{ #p1Wins; #p2Wins; #draw }`. Returning `null` means "round happened,
   game continues" — don't confuse that with `?#draw`, which permanently
   ends the game as a draw.
5. **Is a number in the rules genuinely a player choice, or just fixed
   game data?** A single fixed board/deck/map is a Motoko constant
   (`let`), not a configuration field threaded through `Action`/`State`.
   Only promote something to a field if the rules say a player actually
   picks it.
6. **Two Motoko-specific traps, both easy to hit while translating rules
   into code:**
   - A module-level `let` in Motoko must be a _static_ expression — no
     function calls. `let x = computeSomething();` at the top of the
     module fails with `M0014`. Compute derived constants inline inside
     whichever function needs them instead.
   - `Nat` subtraction traps on underflow. Every `a - b` in `resolve`
     needs a guarding `a >= b` (or equivalent) check nearby, even when a
     rule seems to guarantee it can't happen — a future edit can break
     that invariant silently otherwise.
7. **If you're porting an existing game** (your own, or a third-party
   client), two more things matter specifically:
   - Document every deliberate simplification against the original in
     the rules module's own doc header (Step 3's "Rules" block) — a
     future editor, human or agent, needs to know a mismatch from the
     original is intentional, not a bug to "fix" back into parity.
   - Match any ported formula (physics, geometry, a scoring curve)
     exactly, not just its outcome. Motoko `Float` and JS `number` are
     both IEEE754 doubles — the identical formula over identical inputs
     agrees bit-for-bit between client and server, so `validate` never
     spuriously rejects a move the client's own UI just showed as legal.
     Port function-by-function against the original source, noting the
     file/line you ported each piece from in a comment.
8. **Does this game have more than one rules variant, picked once by a
   table's creator at `createTable` time (see the backend README's
   "Table variants" section)?** If the rules description names two or
   more modes — "Classic" vs "Well," standard vs a house rule, a small
   board vs a large one — decide which shape rule applies before writing
   `Action`/`State`:
   - **Same fields, different legality** (a variant only changes which
     moves are allowed, never what a move contains) → keep `Action`/
     `State` flat, add a `variant` field to `State`, and gate the
     restriction in `validate` — one more branch, no new engine
     mechanism (architecture rule 4). `Spec.init(raw : Text) : State`
     parses the table's own stored variant text into a closed type here
     — `"well"`/anything unrecognized/`""` all need a safe fallback, and
     `resolve` almost always needs no variant branch at all: build it
     against whichever variant has the MOST legal moves (a strict
     superset), since `validate` already kept anything narrower out of a
     smaller variant's own match. `examples/rock-paper-scissors`'s own
     `RockPaperScissorsRules.mo` is the worked reference (Classic vs
     Well — a fourth WELL symbol, illegal outside Well mode, nothing
     else different). When a variant also changes what a move DOES,
     `resolve` reads `s.variant` the same way — `examples/chopsticks`'s
     own `ChopsticksRules.mo` (Classic's "5 or more is out" vs
     Instructables' "exactly 5 is out, more wraps") is the worked
     reference for that shape.
   - **Different fields entirely** (a variant's data genuinely doesn't
     overlap another's) → tag `Action` into a union over each variant's
     own payload type, dispatched through a variant-keyed lookup table
     rather than a hand-matched `switch` repeated in every function —
     see `templates/Rules.mo.template`'s own commented-out alternative
     for the shape. Either way it's still exactly one Candid type for
     the whole game (the union itself) — `TableSummary` isn't generic
     over `State`/`Action` at all, so a richer per-game config type could
     never flow through it directly; that's what settles a variant's own
     wire shape as opaque `Text`, not a generic third `Spec` type
     parameter, regardless of which rule above applies.
   - A game with no variants of its own answers "no" here and moves on —
     `init` still takes the `Text` argument (every `Spec.init` does), it
     just ignores it: `init = func(_ : Text) : State = { ... }`.

Once you can state, in one or two sentences each, what `State` holds,
what `Action`'s variants are, what `validate` rejects, and what
`resolve` computes — you're ready to write the module.

### Worked mini example

Rules: _"Rock-paper-scissors. Each round both players pick rock, paper,
or scissors; the usual beats-relationship decides the round. First to 3
round wins takes the match; a tied round scores nobody."_

- `Action = { #rock; #paper; #scissors }` — a raw pick, nothing derived.
- `State = { p1Score : Nat; p2Score : Nat }` — only the running score
  needs to survive between rounds.
- `validate` — every move is always legal; return `null` unconditionally
  (not every game has illegal moves, and that's fine).
- `resolve` — compute who won _this round_ from `(a1, a2)`, bump the
  winner's score, then check `p1Score == 3`/`p2Score == 3` for the
  match's own `?TP.Verdict`; otherwise `null`. No `Nat` subtraction
  needed here at all, so no underflow guard applies.

This is small enough to hold in your head; most real rule sets are a
bigger `State` (health, ammo, hand of cards, board squares) and a bigger
`Action` variant, but the shape — raw pick in, recomputed-from-`State`
verdict out — never changes.

## Step 3 — Write the Rules module

Read `templates/Rules.mo.template`, then write `src/<YourGameName>Rules.mo`
by filling in every `__PLACEHOLDER__` and replacing every commented-out
sketch line with real code from your Step 2 design:

- `__RULES_MODULE__` → your module's own name (e.g. `RockPaperScissorsRules`).
- `__GAME_TITLE__`, `__P1_NAME__`, `__P2_NAME__` → whatever the rules
  call the two sides (plain "Player 1"/"Player 2" is fine if the rules
  don't name them).
- Replace the "Rules" doc-header block with the actual rules in your own
  words — one line per move/mechanic. This is the single most useful
  comment in the whole game: it's what lets a future reader (human or
  agent) verify the code against intent without re-reading the original
  rules text.
- Fill in `Action`, `Side`, `State`, `freshSide`, `validate`, `resolve`
  from your Step 2 design. `init` takes this table's own rules variant as
  a `Text` (`""` for a game with no variants — the common case, and
  `init`'s own parameter is then simply unused); see Step 2's variant
  question above and the template's own commented-out `Variant`/
  `parseVariant` sketch if your game has more than one.
- Keep `init`/`validate`/`resolve` pure: no `Time`, no mutation, no
  storage — build new records (`{ me with ... }`), never mutate in
  place. `Spec` is passed fresh on every engine call and never stored
  (that's what makes canister upgrades trivial — see the backend
  README's "Design" section for why).

## Step 4 — Write the host actor

Read `templates/Host.mo.template` and write `src/Host.mo`, filling in
only `__RULES_MODULE__` (must match Step 3's module name/import path),
`__IDLE_TIMEOUT_NS__` (nanoseconds; `60_000_000_000` = 60s is a
reasonable default — how long an abandoned table sits before a third
party may reclaim it; shared by every table this game's players open),
and `__CLAIM_TIMEOUT_NS__` (nanoseconds; a SEPARATE, normally much
shorter window — `15_000_000_000` = 15s is a reasonable default — how
long a player's own submitted move may sit pending against their
opponent's silence before that player may optionally claim the win
outright instead of waiting the opponent out; see "Claim a win" below).
Nothing else in this file should change between games — do not hand-roll
`createTable`/`joinTable`/`submit`/`rematch`/`leave`/`reset`/`claimWin`/
`ackEnded` as plain Candid methods on this actor. `mo:duel-game-core/ws` (wired here
via `Ws.attach` + `ActorMixin`) is the _only_ way a client can mutate
game state; a direct update call bypassing it reopens exactly the
ordering race a single WS channel exists to close (see
`mo:duel-game-core/ws`'s own doc header, shipped in the package, for the
full reasoning). `status` is the one exception, staying a plain
`query` — it's side-effect-free. Your `Host.mo` wires a
`TP.Registry<State, Action>` (built with `Registry.new`, from
`mo:duel-game-core/registry`), not a bare `TP.Table` — this game gets a
multi-table lobby for free, with zero code of your own beyond this
template: every table is browsable, open ones joinable outright and
protected ones (flagged as such in the listing) joinable once the caller
also supplies the matching access code.

**Claim a win.** Once a player's own move has sat pending for at least
`__CLAIM_TIMEOUT_NS__` against their opponent's silence, the engine
offers that player a "Claim the win" control — the generic `#inGame`
screen (`duel-game-core/render.js`, wired by `app.js`) renders it
automatically, with its own countdown, once `View.inGame.claimWinAvailable`
turns true; nothing in `GamePlugin` needs to know about it. It's the
waiting player's own optional choice — never automatic, and they may
just as well leave it alone and keep waiting. This is a separate,
normally much shorter clock than the idle takeover: `claimTimeoutNs`
governs when the STILL-SEATED, waiting player may end the match
themselves, while `idleTimeoutNs` governs when a THIRD PARTY may reclaim
a table both players have gone quiet on. The still-deciding OPPONENT
gets the mirror-image warning on the exact same clock — "your opponent
can claim the win in Ns if you don't move" — so they can see the loss
coming and act, not just find out about it after the fact; they never
get a claim button of their own, since only the player who actually
submitted may claim. In a `#alternating` game this reads the same way
from a different angle: "submitted" means "waiting on the other seat's
turn," so only the seat NOT currently on turn ever sees the claim
control — the on-turn seat gets the mirror-image warning instead, same
as above.

**Metrics (optional).** Unlike everything else in this file, wiring
Prometheus-style metrics is not part of the six required pieces — skip
it unless the user asks for observability, a `/metrics` endpoint, or
similar. If they do, add `mops add promtracker` and extend `Host.mo`
with:

```motoko
import PT "mo:promtracker";
import Http "mo:promtracker/mixins/http";
import Tracker "mo:promtracker/Tracker"; // enables pt.toValue() dot notation

persistent actor {
  let pt = PT.Tracker.new();
  transient let renderer = PT.Renderer();
  renderer.addValue(PT.allSystemMetrics); // IC/RTS metrics — optional but nearly free
  renderer.addValue(pt.toValue());

  let registry : TP.Registry<Rules.State, Rules.Action> = Registry.new(__IDLE_TIMEOUT_NS__, __CLAIM_TIMEOUT_NS__);
  registry.attachMetrics(pt); // games_started / active_games / rounds_per_game / matchmaking_wait_seconds

  // ...status/Ws.attach/ActorMixin exactly as the template already has...

  include Http(renderer.renderExposition, "/metrics");
};

```

`Http` is defined the same way `mo:duel-game-core/actor_mixin` is (a
Motoko `mixin`), so it needs the same moc version as that already does
— no extra toolchain bump beyond whatever this project already pins for
`ActorMixin`. This dependency isn't declared directly in your own
`mops.toml`: it arrives transitively through `duel-game-core`'s own
dependency on `promtracker`, the same way `ic-websocket-cdk` already
does for `mo:duel-game-core/ws`. See `mo:duel-game-core`'s own
`backend/README.md` "Metrics" section (shipped in the package) for what
each metric means, and `examples/racing/src/Host.mo` in
`research-ag/duel-core` for a complete worked example.

**Canister players (optional).** Also not part of the six required
pieces — skip it unless the user asks for a "bot"/"AI opponent"/
"canister player" that takes a seat and plays on its own account. If
they do, this lets a SECOND canister (yours or someone else's) join a
table and submit moves via a plain inter-canister call, with the same
server-side legality (`validate` still runs) and the same real-time push
to a human opponent as a browser tab gets. The same canister principal
may hold a live seat at more than one table at once — each board gets
its own independent session (see `canister_players.mo`'s own
`sidForCanister` doc) — with no extra wiring needed on your part beyond
what's below. Add nothing to `mops.toml` —
`mo:duel-game-core/canister_players` depends on nothing beyond `core`
and its sibling engine modules, already pulled in regardless — and
extend `Host.mo` with:

```motoko
import Principal "mo:core/Principal"; // enables p.toText() dot notation below
import Timer "mo:core/Timer";

import CanisterPlayers "mo:duel-game-core/canister_players";
import CanisterPlayersActorMixin "mo:duel-game-core/canister_players_actor_mixin";

import BotIface "BotIface"; // one method: make_move : (TP.MoveRequest<Rules.State, Rules.Action>) -> async Rules.Action

persistent actor {
  // ...registry/status/Ws.attach exactly as the template already has,
  // except Ws.attach's `onSettled` argument (the first `null` after
  // `WsInitParams(...)`) becomes `?settle` (below)...

  // `Ws.attach` and `CanisterPlayers.attach` each need the other's
  // result before either exists — this mutable indirection breaks that
  // cycle (see `canister_players.mo`'s own doc header for why):
  transient var settleTable : ?((Int, TP.TableId) -> async* ()) = null;
  transient let settle = func(now : Int, id : TP.TableId) : async* () {
    switch (settleTable) {
      case (?f) await* f(now, id);
      case null {};
    };
  };

  // ...attached.ws.init<system>()...

  transient let cpAttached = CanisterPlayers.attach<Rules.State, Rules.Action>(
    Rules.spec(),
    registry,
    attached.afterMutation, // reuses ws.mo's own push fan-out
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

  // The six `*_as_canister` Candid methods a canister player calls, plus
  // `register_bot`/`unregister_bot`/`list_bots` (bot DISCOVERY — see
  // below) — no hand-declared forwarding methods. (There's no
  // `rematch_as_canister`: a canister-vs-canister debrief auto-acks both
  // sides unconditionally once neither is a live human still deciding.)
  // `botDirectory` is a plain, stable field this actor owns directly
  // (same "no class, no closures" shape as `registry`); `null` here
  // means every bot's own `elo` comes back `null` from `list_bots` too —
  // pass `?leaderboard` instead once you've also wired one (below).
  let botDirectory = CanisterPlayers.newBotDirectory();
  include CanisterPlayersActorMixin(cpAttached, botDirectory, null);

  // Fold `cpAttached.sweep` into the SAME idle-sweep timer `ActorMixin`
  // already runs — no separate timer:
  transient let combinedSweep = func(now : Int) : async* () {
    await* attached.sweep(now);
    await* cpAttached.sweep(now);
  };
  include ActorMixin<system>(attached.ws, combinedSweep); // replaces the plain `attached.sweep` the template passes
};

```

You'll also need a small `BotIface.mo` (the `CanisterPlayer` Candid
interface your bot canister implements — one method, `make_move`) and,
if you're also writing the bot itself, a `Bot.mo`/`BotLogic.mo` pair the
same shape `examples/racing/bot/`/`examples/checkers/bot/` use. See
`mo:duel-game-core`'s own `backend/README.md` "Canister players" section
(shipped in the package) for the full design — the call/response
protocol, the `settle`/`armClaimCheck` wiring, unattended
canister-vs-canister matches — and `examples/racing/src/Host.mo`/
`examples/checkers/src/Host.mo` in `research-ag/duel-core` for it wired
end to end, bot canister included.

`make_move`'s own request (`TP.MoveRequest<Rules.State, Rules.Action>`)
carries more than just the current game state — `turn`/`gen` (a round
number and a per-match identity that survives a rematch reusing the
same table), `opponent` (the opposing seat's own stable identity),
`opponentLastMove` (their most recently resolved move), and
`lastRoundDurationNs` (how long the last round took) are all there too.
The two reference bots above never touch any of that — both are pure
functions of `game`/`seat`/`turn` alone, declared `query`, and that's
the right shape for "the user just wants a working opponent." If the
bot needs to be smarter than that — remembering a match's own move
history, or building a model of a specific opponent's tendencies over
many games — read `references/canister-player-bots.md` before writing
it: the moment a bot needs to remember anything across calls,
`make_move` can no longer be a `query` method (a hard IC constraint on
state durability, not a style choice), which changes both `Bot.mo`'s
own declaration and how a host should size its timeouts.

A bot that should be human-CHALLENGEABLE — found and picked from a "🤖
Bots" dialog, rather than only fillable via a hardcoded table id/seat/
code someone already handed it — self-registers with your host, once,
after both canisters are deployed:

```motoko
// on the BOT canister itself, alongside its existing `play`/`make_move`:
public shared ({ caller }) func register(host : Principal.Principal, name : Text) : async () {
  assert Principal.isController(caller);
  let h : actor { register_bot : (Text, [Text]) -> async () } = actor (host.toText());
  await h.register_bot(name, BotLogic.COMPLEXITIES);
};

```

`BotLogic.COMPLEXITIES` is the bot's own list of ways to play — opaque
strings it alone defines and interprets, an "Easy"/"Medium"/"Hard"
ladder, "Rabbit"/"Fox"/"Lion", "Look-ahead"/"Reactive", whatever fits
the game — declared once as a constant in the bot's own code (if it
ever changes, the bot just re-registers). A bot with ONE way to play
passes `[]` and is listed under `"Default"`; nothing else about it
changes. A challenger picks one entry per game, and every `make_move`
ask then carries it as `req.complexity` (see below) — a bot with several
ways to play switches on that field (treating a value it doesn't
recognize as its own default, never trapping), and each one is rated
separately on the leaderboard, "Bot (Hard)" apart from "Bot (Easy)".
`examples/tic-tac-toe/bot/BotLogic.mo` is the worked two-way shape
(`["Easy", "Hard"]`, a deterministic pick vs. a full minimax).

There's no deploy-time mechanism for one canister to learn a sibling's
principal automatically, so trigger this by hand once both are live:
`icp canister call bot register '(principal "<host-canister-id>", "RacerBot")'`.
Once it succeeds, the bot shows up in every player's own challenge dialog
and leaderboard Challenge button (one row per complexity), with no
hardcoded canister id anywhere on the frontend — see
`mo:duel-game-core`'s own `backend/README.md` "Canister players"
section, "Bot discovery" subsection, for the full `BotDirectory`/
`list_bots` design, and `frontend/README.md`'s "Bot registry" section
for `renderBotList`/`renderSeatChoice`/`renderLeaderboard`'s own
Challenge button and the unified challenge flow a game's own
`duel-app.js`/`app.js` wires (`examples/racing`/`examples/checkers` in
`research-ag/duel-core`, both wired end to end).

**Leaderboard (optional).** Also not part of the six required pieces —
skip it unless the user asks for rankings, ratings, or a "top players"
screen. If they do, first work out which shape your game needs: a
win/lose/draw game (any `Spec`, either `Mode`) wants a classic chess-ELO
rating, always moving after every game — `#claimed`/`#aborted` count the
same as a clean `#finished` win, since leaving mid-game or stalling out
shouldn't be a free way to protect a rating. A game scored by some other
metric (a personal-best time, a high score, ...) wants that metric
tracked directly instead — every `Board` this framework ships sorts
highest-score-first, always, so a metric where LOWER is better (a lap
time, say) needs converting to a higher-is-better score before it's ever
stored (see the worked "best lap" example below). Add nothing to
`mops.toml` — none of `mo:duel-game-core/leaderboard`,
`mo:duel-game-core/elo`, or `mo:duel-game-core/leaderboard_actor_mixin`
depends on anything beyond `core`/`leaderboard.mo` itself — and extend
`Host.mo` with:

```motoko
import Leaderboard "mo:duel-game-core/leaderboard";
import LeaderboardActorMixin "mo:duel-game-core/leaderboard_actor_mixin";
import Elo "mo:duel-game-core/elo"; // only for the ELO shape, below

persistent actor {
  // ...registry/status exactly as the template already has...

  // keep 50, show the top 25 — pick your own two numbers. Second argument
  // is YOUR starting-score choice for a never-recorded player — elo.mo
  // takes no view on it; 1200 is the common chess convention.
  let STARTING_ELO : Int = 1200;
  let leaderboard = Leaderboard.new(50, STARTING_ELO);

  // ── ELO shape (win/lose/draw games) ──────────────────────────────────
  func onGameEnded(_id : TP.TableId, p1 : TP.SessionId, p2 : TP.SessionId, d : TP.Debrief<Rules.State>) {
    let outcome : Elo.Outcome = switch (d.end) {
      case (#finished(#p1Wins)) #aWins;
      case (#finished(#p2Wins)) #bWins;
      case (#finished(#draw)) #draw;
      case (#claimed(#p1)) #aWins;
      case (#claimed(#p2)) #bWins;
      case (#aborted(#p1)) #bWins; // p1 left — p2 credited with the win
      case (#aborted(#p2)) #aWins;
    };
    let k1 = Ws.playerKey(p1);
    let k2 = Ws.playerKey(p2);
    let (r1, r2) = Elo.update(Leaderboard.scoreOf(leaderboard, k1), Leaderboard.scoreOf(leaderboard, k2), outcome, 32);
    let now = Time.now();
    Leaderboard.setScore(leaderboard, k1, r1, now);
    Leaderboard.setScore(leaderboard, k2, r2, now);
  };

  // ...registry/status/Ws.attach exactly as the template already has,
  // except Ws.attach's `onGameEnded` argument (the second `null` after
  // `WsInitParams(...)`) becomes `?onGameEnded`...

  // Supplies get_leaderboard() — no hand-declared query needed:
  include LeaderboardActorMixin(leaderboard, 25);
};

```

The other shape — a metric that isn't a `Verdict`-driven rating, like a
best-completed-lap-time leaderboard — needs to know when a match STARTED
too, since nothing in the engine timestamps that on its own. First check
whether your own game state can already tell you: `examples/racing`'s
own `Host.mo` never wires `onGameStarted` at all, because that game
resolves one fixed-duration round per submission — its `lapMsFor` derives
the winner's exact in-game time straight from `Debrief.turns` (rounds
resolved × that fixed duration) and the winning car's own final state
(how far PAST the finish line its last round's motion carried it, over
how fast it was going, gives the fraction of that final round still left
over — see that file's own doc comment for the full reasoning). If YOUR
game has a similar "one round = one fixed slice of in-game time"
property, prefer that: it's exact, and needs no bookkeeping at all.

Only reach for real-world wall-clock time — via `Ws.attach`'s
`onGameStarted` parameter (the THIRD `null` after `WsInitParams(...)`,
right after `onGameEnded`) — when your metric genuinely has no
from-game-state shortcut (nothing about "how long this took" is
recoverable from the final state alone). This shape never looks up a
"current" score before computing a new one, so `Leaderboard.new`'s own
`defaultScore` argument is inert here — any placeholder value works:

```motoko
let leaderboard = Leaderboard.new(50, 0); // 0 is a placeholder — this shape never reads it

let ONE_HOUR_MS : Int = 3_600_000; // headroom for the conversion below — pick your own ceiling
func scoreFromYourMetric(raw : Int) : Int = Int.max(0, ONE_HOUR_MS - raw); // "lower is better" -> "higher is better"

let matchStarts = Map.empty<TP.TableId, Int>();
func onGameStarted(id : TP.TableId, _p1 : TP.SessionId, _p2 : TP.SessionId) {
  matchStarts.add(id, Time.now());
};
func onGameEnded(id : TP.TableId, p1 : TP.SessionId, p2 : TP.SessionId, d : TP.Debrief<Rules.State>) {
  // ...read whatever you need out of d.end/d.finalGame, look up
  // matchStarts.get(id) for the elapsed real-world time since
  // onGameStarted fired, and call
  // Leaderboard.recordIfBetter(leaderboard, Ws.playerKey(winner), scoreFromYourMetric(raw), Time.now())...
  matchStarts.remove(id);
};

```

If your game also wires canister players (above), a bot's session id is
PER-TABLE (`sidForCanister`), not per-player — special-case
`CanisterPlayers.leaderboardKeyOfSession(sid)` before falling back to
`Ws.playerKey`, so one bot's score accumulates across every table it
plays instead of resetting per board. That key is per bot AND per
complexity (`"cp:" # p.toText() # ":" # complexity`, the same
`leaderboardKey(p, complexity)` convention `list_bots` itself joins each
of a bot's ratings with — see "Canister players" above's own "Bot
discovery" part), so "Bot (Hard)" and "Bot (Easy)" are separate rows
and a bot's leaderboard rows and its own rows in a challenge dialog
always agree. On the frontend, `get_leaderboard`
is already declared on every actor `idl.js` builds and needs no wiring
of your own; call `actor.get_leaderboard()` and render the result with
`duel-game-core/render.js`'s
`renderLeaderboard(entries, plugin, { yourSid: session.sid })` wherever
your own layout puts the panel — `yourSid` (the caller's own
`session.sid`) badges that player's own row ("You") if they're on the
ranked list, via a small `playerKeyOf(sid)` helper `renderLeaderboard`
already calls internally, so nothing on your side needs to derive the
key itself. If your game also wires bot discovery, fetch
`actor.list_bots()` alongside `get_leaderboard()` (`.catch(() => [])`
it — a bot list is a nice-to-have here, never a reason to fail the whole
panel) and pass `botNames: new Map(bots.map((b) => [b.principal.toString(), b.name]))`
too, so a bot's row shows its own registered name instead of a bare
principal — as "Name (Complexity)", the complexity always spelled out. All three reference examples use the same panel shape, worth
copying rather than inventing your own: an icon-only 🏆 toggle button —
NOT a "Leaderboard"-labeled one — positioned FIRST in `.session`, before
the player id, that opens a dedicated full-page overlay
(`#leaderboard-panel`, styled `position: fixed; inset: 0` by
`duel-game-core.css`) with its own "← Back" button, rather than a small
inline panel next to `#screen` — a full takeover avoids any risk of the
generic chrome's own live status pushes re-rendering `#screen` out from
under an inline panel sitting alongside it. Add `formatScore(score)` to
your `plugin.js` only if you used the second (converted-metric) shape
above, to invert that conversion for display (see
`templates/plugin.js.template`'s own commented-out example). See
`mo:duel-game-core`'s own `backend/README.md` "Leaderboard" section
(shipped in the package) for the full design and both worked examples in
detail, and `examples/007/src/Host.mo` (ELO) /
`examples/racing/src/Host.mo` (best lap) in `research-ag/duel-core` for
them wired end to end, frontend panel included.

## Step 5 — Write the rules unit tests

Read `templates/RulesUnit.test.mo.template` and write
`test/RulesUnit.test.mo`. Cover, at minimum:

- `init("")` produces the state your rules describe as the starting
  position, and `spec()` really does hand out your own
  `init`/`validate`/`resolve` (the wiring-sanity check in the template's
  section 1 — cheap, and it has caught real copy-paste mistakes before).
  If your game has variants (Step 2's question 8), also cover `init` with
  each variant's own key, plus one unrecognized string, to confirm the
  safe-default fallback actually holds.
- One `validate` case per way a move can be illegal in your rules
  (running out of a resource, moving out of turn, etc.) — assert it's
  rejected (`?_`) and every legal case is accepted (`null`).
- One `resolve` case per win/lose/draw path your rules define, plus any
  edge case in the _scoring/elimination_ logic specifically (simultaneous
  outcomes, a tie-breaking rule, a resource hitting exactly its limit).

You do **not** need to test `join`/`leave`/`rematch`/idle-takeover/
session-status behavior — that's the engine's own job, already covered
by `duel-game-core`'s own test suite (ships with the package; you're
depending on it, not reimplementing it). Testing your own `validate`/
`resolve` directly, with synthetic states, is both sufficient and far
faster than trying to drive a real multi-round game through the engine
to reach a particular scenario.

**If your game's ending takes many real rounds to reach** (a long race,
a multi-round tournament — anything that isn't naturally over in a
handful of moves) and you also need a genuine end-to-end test that
drives the real engine to a finished `#debrief`, read
`references/testing-deep-dive.md` before attempting it: driving a full
realistic playthrough through the interpreter is both slow and prone to
getting a hand-written "AI" stuck in a loop — there's a fast, reliable
alternative.

Run it (adjust paths to wherever `mops install` placed things):

```bash
moc -r --package core <path-to-core/src> \
       --package duel-game-core <path-to-duel-game-core-backend/src> \
       test/RulesUnit.test.mo
```

or, if your project's own `mops.toml` already lists `duel-game-core`
and `core` as dependencies, simply `mops test` from that directory.

## Step 6 — Write the frontend GamePlugin

Read `templates/plugin.js.template` and write
`frontend/src/<game>-plugin.js`. This is the only game-specific frontend
code — everything else (the multi-table lobby — create a table, open or
access-code protected; browse and join both kinds, a protected row
flagged as such and prompting for its code on click — staging, rematch,
busy countdown, debrief chrome, the turn counter, "opponent is
deciding"/"locked in", the verdict banner) is generic and comes from the
npm package itself, via `render.js`/`app.js`.

- `idlTypes({ IDL })` must describe **exactly** the Candid shape of your
  `State`/`Action` from Step 3 — same field names, same variant names,
  same nesting, and ONLY your own game's shapes (the engine's own
  `Verdict`/`Err`/etc. types are already known to the npm package's own
  Candid plumbing; don't redeclare them here). A Motoko `Nat`/`Int`
  decodes to a JS `bigint` in this function's caller, not `number`; a
  Motoko tuple decodes to a plain array (`[x, y]`), not `.0`/`.1` — keep
  both straight if your `State` has either.
- `seatLabel(seat)` — your `__P1_NAME__`/`__P2_NAME__` from Step 3.
- `renderBoard(gameState, mySeat, oppSeat)` — return an HTML string.
  Called for both a live game and a finished debrief's final state, so
  it must make sense given only `gameState`. Use the `esc()` helper
  (imported at the top of the template) on any text that came from
  game state, never interpolate it raw.
- `renderActions(gameState, mySeat)` — one `<button>` per `Action`
  variant, each carrying its move via the `actionAttr()` helper so
  `render.js`'s generic click delegation can submit it as-is. Disable a
  button when your own `legal()` mirror of Step 3's `validate` says the
  move isn't currently legal — this is cosmetic only (the engine calls
  the REAL `validate` for both seats on every submission regardless), so
  keep the two in sync but never rely on this half alone.
- `formatScore(score)` — optional, and only relevant if you wired the
  Leaderboard section above with the converted-metric shape (a
  best-lap-time game, say): renders one leaderboard entry's raw `score`
  back into what a player should actually see. Omit it for the ELO shape
  — the library's own default (the plain integer) is already correct.
- `variantChoices()`/`formatVariant(variant)` — optional, both, and only
  relevant if Step 2's question 8 gave your game more than one rules
  variant. `variantChoices()` returns the `{ key, label }` list
  `renderBrowsing`'s "Start a new table" section turns into a radio-
  button picker (its FIRST entry is the default selection; each `key` is
  exactly the `Text` your backend's `Spec.init(variant)` receives).
  `formatVariant(variant)` turns a browsed table's own stored
  `TableSummary.variant` back into the same label text, so a table row
  and the picker that created it read identically. A game with no
  variants implements neither — no picker renders, and no table row
  shows variant text.

Then copy `templates/index.html.template` → `frontend/src/index.html`,
`templates/app.js.template` → `frontend/src/app.js`, and
`templates/style.css.template` → `frontend/src/style.css` (fill in
`__GAME_TITLE__` in its header comment; the file may otherwise stay
empty — see its own comment for when to add to it), filling in
`__GAME_TITLE__`, `__PLUGIN_FILE__`, and `__IDLE_TIMEOUT_SECONDS__`
(match Step 4's timeout) in the first two. `build.js` (Step 7) copies
`src/style.css` to `dist/style.css` unconditionally — skipping this file
breaks the build, even if you leave it empty. Neither `index.html`/
`app.js` should need any other change —
they resolve a real, non-spoofable player identity with no login step
(`duel-game-core/anon-identity.js`'s `resolveAnonymousIdentity()`), build
the actor from it, build a real-time-push `ws` over the same identity
(`connectWs()`, required — there is no polling fallback, and no plain
mutating Candid method to poll in the first place), and hand off to the
generic `start({ plugin, ws, session })`. `app.js` is esbuild's bundle
entry point (see Step 7's `build.js.template`) — every dependency it and
`duel-game-core` need (`@icp-sdk/core`, `cborg`) is resolved from
`node_modules` and inlined at build time, so the deployed page loads
nothing from a CDN and needs no import map.

Every player gets a real, non-spoofable identity by default — no login,
no setup — and this template makes no distinction between players beyond
that, and nothing in Steps 2–5 needs to either. A game that also wants
real, _permanent_ player identity — someone logged in via Internet
Identity, playing in the very same lobby as anonymous players with zero
rules changes — swaps in `duel-game-core/identity.js`'s
`resolveIdentity()` instead of this template's own
`resolveAnonymousIdentity()` call (both return the same
`{ identity, principal, sid }` shape `start({ plugin, ws, session })`
expects, `resolveIdentity()` just adds the login/logout branch on top);
see `frontend/README.md`'s "Logging in with Internet Identity" section
(in the `duel-game-core` npm package) for the exact, complete pattern —
nothing further to design here.

**If your game's whole UI genuinely doesn't fit buttons and text** (a
canvas, drag-and-drop, a 3D scene, or you're porting an existing
framework-based client wholesale rather than writing a plugin from
scratch) — this skill's templates assume it does, which covers the
large majority of rules-described games (anything you'd naturally
describe as "pick a move each round"). For the richer case, read
`references/rich-ui.md` before writing `frontend/src/app.js`: it covers
running your own persistent-DOM UI alongside the generic screens,
sharing one `ws` connection between the two, and de-frameworking an
existing client (Angular/React/etc.) down to the plain logic underneath.

## Step 7 — Project/deploy config

Read and fill in each of these (all in `templates/`), placing them at
the paths shown:

| Template                | Destination             | Fill in                                                                                        |
| ----------------------- | ----------------------- | ---------------------------------------------------------------------------------------------- |
| `mops.toml.template`    | `mops.toml`             | `__GAME_SLUG__` (dependency line already resolved in Step 1)                                   |
| `package.json.template` | `frontend/package.json` | `__GAME_SLUG__` (dependency value already resolved in Step 1)                                  |
| `.npmrc.template`       | `frontend/.npmrc`       | (none — copy verbatim)                                                                         |
| `build.js.template`     | `frontend/build.js`     | `__PLUGIN_FILE__` (in its header comment only — the entry point itself is always `src/app.js`) |
| `icp.yaml.template`     | `icp.yaml`              | (none, unless you rename the canisters)                                                        |

Build/test the whole thing:

```bash
# Backend
mops install
mops test                              # runs test/RulesUnit.test.mo (and any other *.test.mo)

# Frontend
cd frontend && npm install --legacy-peer-deps && npm run build && cd ..
node --check frontend/dist/app.js

# Deploy (icp-cli; `icp network start` must be running for the local env)
icp deploy                             # local  → prints a *.localhost URL
icp deploy --network ic                # mainnet — spends cycles
```

The asset-canister recipe in `icp.yaml.template` must stay **v2.3.0 or
newer** (v2.1.0 uses a sync step icp-cli 1.x rejects outright). Its
`configuration.build` step runs `npm run build` inside `frontend/`
automatically, so `icp build`/`icp deploy` always rebuilds
`frontend/dist/` (esbuild's bundled output, what `icp.yaml` actually
deploys) from current source before syncing it — there's no separate
manual build step to remember before deploying. `npm install
--legacy-peer-deps` itself is still a one-time (or as-needed) manual
step that populates `frontend/node_modules` in the first place (see the
build/test block above) — the automatic `build` step only re-bundles
from whatever's already installed there, it doesn't run `npm install`
for you.

Play both seats by opening the deployed URL in two separate browser
tabs (each tab is its own session automatically) — create a table in
one tab, join it from the other, and confirm a full round resolves and
the debrief/rematch loop actually works. The Motoko tests passing and
the frontend building are both necessary but not sufficient; nothing
here automates an actual two-tab playthrough.

## Common pitfalls (all specific to the rules-only workflow)

- **Don't add a plain Candid method for `createTable`/`joinTable`/
  `submit`/`rematch`/`leave`/`reset`/`claimWin`/`ackEnded`**, "just to test with
  `dfx canister call`" or similar — `Host.mo`'s template deliberately has
  none. Every
  mutation goes through `mo:duel-game-core/ws`'s `ws_message`, wired by
  `ActorMixin`. Use the deployed frontend (or a `ws`-speaking test
  client) to exercise it manually, not a raw Candid call.
- **Don't let a client-supplied value stand in for something `resolve`
  should compute.** This is the #1 mistake translating an existing
  game's client-side logic into `Action`/`resolve` — see Step 2, point 2.
- **`validate` is the only legality gate, full stop.** If your
  `GamePlugin`'s `legal()` and `Rules.mo`'s `validate` ever disagree,
  `validate` is correct and the plugin has a cosmetic bug — the engine
  calls `validate` for both seats on every submission regardless of what
  the UI allowed.
- **Every phase needs no special handling from you** — seating, staging,
  debrief, idle takeover, and rematch races are entirely the engine's
  job. If you find yourself adding a timestamp field or a "waiting for
  opponent" flag to your own `State`, stop: that's already `duel-game-
core`'s job via `Table`'s own bookkeeping, and duplicating it in `State`
  is very likely a sign the design has drifted from "just the rules."
- **A `null` verdict means "continue," not "no winner ever."** Only
  return `?#draw`/`?#p1Wins`/`?#p2Wins` when the rules actually say the
  match itself has ended.
