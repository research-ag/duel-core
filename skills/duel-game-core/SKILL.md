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
*except* the game itself: a multi-table lobby (anyone may open a table,
open or access-code protected, and any number run simultaneously),
seating, round submission, debrief, idle takeover, rematch, session
identity, real-time push, and the generic lobby/staging/rematch/debrief
screens.

This skill's job is narrower than "learn the framework": the user gives
you rules, nothing else, and you produce the whole game — every file
below — from that description alone. You are expected to make the
State/Action/rendering design calls yourself; only ask the user a
clarifying question when the rules text is genuinely ambiguous about
game *logic* (a win condition, a resource limit), never about
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
5. `frontend/index.html` + `frontend/app.js` — copy the templates
   verbatim; they wire the actor and hand off to the generic client.
6. `icp.yaml`, `mops.toml`, `frontend/package.json`, `frontend/.npmrc` —
   project/deploy config. Copy the templates, filling in names.

Every template referenced below lives in this skill's own `templates/`
directory — read each one with your file-reading tool right before you
adapt it; don't retype boilerplate from memory. Steps 5 and 6 below
point into this skill's `references/` directory for two situations the
templates alone don't cover — a game whose ending takes many real
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
   - A module-level `let` in Motoko must be a *static* expression — no
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

Once you can state, in one or two sentences each, what `State` holds,
what `Action`'s variants are, what `validate` rejects, and what
`resolve` computes — you're ready to write the module.

### Worked mini example

Rules: *"Rock-paper-scissors. Each round both players pick rock, paper,
or scissors; the usual beats-relationship decides the round. First to 3
round wins takes the match; a tied round scores nobody."*

- `Action = { #rock; #paper; #scissors }` — a raw pick, nothing derived.
- `State = { p1Score : Nat; p2Score : Nat }` — only the running score
  needs to survive between rounds.
- `validate` — every move is always legal; return `null` unconditionally
  (not every game has illegal moves, and that's fine).
- `resolve` — compute who won *this round* from `(a1, a2)`, bump the
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
  from your Step 2 design.
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
via `Ws.attach` + `ActorMixin`) is the *only* way a client can mutate
game state; a direct update call bypassing it reopens exactly the
ordering race a single WS channel exists to close (see
`mo:duel-game-core/ws`'s own doc header, shipped in the package, for the
full reasoning). `status` is the one exception, staying a plain
`query` — it's side-effect-free. Your `Host.mo` wires a
`TP.Registry<State, Action>` (built with `Registry.new`, from
`mo:duel-game-core/registry`), not a bare `TP.Table` — this game gets a
multi-table lobby (open tables browsable by anyone, protected ones
joinable by id + access code) for free, with zero code of your own
beyond this template.

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

## Step 5 — Write the rules unit tests

Read `templates/RulesUnit.test.mo.template` and write
`test/RulesUnit.test.mo`. Cover, at minimum:

- `init()` produces the state your rules describe as the starting
  position, and `spec()` really does hand out your own
  `init`/`validate`/`resolve` (the wiring-sanity check in the template's
  section 1 — cheap, and it has caught real copy-paste mistakes before).
- One `validate` case per way a move can be illegal in your rules
  (running out of a resource, moving out of turn, etc.) — assert it's
  rejected (`?_`) and every legal case is accepted (`null`).
- One `resolve` case per win/lose/draw path your rules define, plus any
  edge case in the *scoring/elimination* logic specifically (simultaneous
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
code — everything else (the multi-table lobby — create a table,
open or access-code protected, browse open ones, join by code — staging,
rematch, busy countdown, debrief chrome, the turn counter, "opponent is
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

Then copy `templates/index.html.template` → `frontend/src/index.html`
and `templates/app.js.template` → `frontend/src/app.js`, filling in
`__GAME_TITLE__`, `__PLUGIN_FILE__`, and `__IDLE_TIMEOUT_SECONDS__`
(match Step 4's timeout). Neither file should need any other change —
they build the actor, build a real-time-push `ws` over it
(`connectWs()`, required — there is no polling fallback, and no plain
mutating Candid method to poll in the first place), and hand off to the
generic `start({ plugin, ws })`. `app.js` is esbuild's bundle entry point
(see Step 7's `build.js.template`) — every dependency it and
`duel-game-core` need (`@icp-sdk/core`, `@icp-sdk/auth`, `cborg`) is
resolved from `node_modules` and inlined at build time, so the deployed
page loads nothing from a CDN and needs no import map.

Every player is a plain, anonymous, self-generated `sid` by default —
this template makes no distinction between players beyond that, and
nothing in Steps 2–5 needs to either. A game that also wants real,
permanent player identity — someone logged in via Internet Identity,
playing in the very same lobby as anonymous players with zero rules
changes — swaps in `duel-game-core/identity.js`'s `resolveIdentity()`
instead of this template's own throwaway-identity block, and passes its
result as `start({ plugin, ws, session })`; see
`frontend/README.md`'s "Logging in with Internet Identity" section (in
the `duel-game-core` npm package) for the exact, complete pattern —
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

| Template | Destination | Fill in |
|---|---|---|
| `mops.toml.template` | `mops.toml` | `__GAME_SLUG__` (dependency line already resolved in Step 1) |
| `package.json.template` | `frontend/package.json` | `__GAME_SLUG__` (dependency value already resolved in Step 1) |
| `.npmrc.template` | `frontend/.npmrc` | (none — copy verbatim) |
| `build.js.template` | `frontend/build.js` | `__PLUGIN_FILE__` (in its header comment only — the entry point itself is always `src/app.js`) |
| `icp.yaml.template` | `icp.yaml` | (none, unless you rename the canisters) |

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
newer** (v2.1.0 uses a sync step icp-cli 1.x rejects outright). Run
`npm install && npm run build` inside `frontend/` before deploying —
`icp deploy` does not do this for you, and `frontend/dist/` (esbuild's
bundled output, what `icp.yaml` actually deploys) won't exist without
it.

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
