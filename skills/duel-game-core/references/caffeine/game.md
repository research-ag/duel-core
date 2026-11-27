# caffeine.ai: a game

A duel-game-core game built by caffeine.ai's AI builder. Caffeine builds
every app as one Motoko canister named `backend` and a React frontend
(`src/backend/`, `src/frontend/`), and keeps the source itself. Its own
skills (`caffeine-app`, `writing-motoko`, `migrating-motoko-actors`)
still apply; these files say what the game needs on top of them.

Every file of this skill is at
`https://api.hosty.live/skills/duel-game-core/<path>`.
A game takes five, each short enough for one fetch: this one,
`references/caffeine/game-backend.md`,
`references/caffeine/game-frontend.md`, `templates/Rules.mo.template`
and `templates/plugin.js.template`. A game that waits for one seat
also takes `references/turn-based-games.md`. The rest of the skill is
for builders with a shell and is not needed here. Every later change
starts from `references/caffeine/changes.md`.

## Packages

```bash
mops add duel-game-core
mops add promtracker
```

Keep the project's own `core` version. In `src/frontend/`:

```bash
pnpm add @research-ag/duel-game-core
```

Set `@icp-sdk/core` to `^6.1.1` in both `package.json` files (the
root's `devDependencies`, the frontend's `dependencies`). Caffeine's
template pins `^5.3.0`, Vite dedupes it, and the package's types come
from 6: with 5, `tsc` fails though the page runs.

## The rules: `src/backend/lib/Rules.mo`

A pure module, from `templates/Rules.mo.template`: `State`, `Action`,
`View`, `Options`, `spec` and the `SEMANTICS` text. Before writing it,
settle these:

- **Who acts when.** Both seats every round is `#simultaneous`
  (`validate` checks one seat's action, `resolve` applies both), what
  the template is written for. When the rules say whose action is next,
  it is `#turnBased` (`toMove`, `move`), in
  `references/turn-based-games.md`.
- **`Action` is the raw decision**, never a value the rules can derive:
  `{ #attack; #defend }`, not `{ #attack : { damage : Nat } }`. Client
  input is untrusted.
- **`State`** holds what later rounds need, plus what shows the
  opponent's most recent move: a simultaneous game whose state does not
  reveal both picks keeps `lastRound : ?Round`. No timestamps and no
  "waiting" flags: the engine keeps those. Fixed data (a board layout)
  is a `let`, not a field.
- **Endings.** `resolve` (or `move`) returns `?#p1Wins`, `?#p2Wins` or
  `?#draw`; `null` means the game goes on.
- **`Options`** is what a table's creator picks, `{}` for nothing.
  `checkOptions` returns `?"why"` for a value to refuse, and
  `init(options, rng)` copies onto `State` what the rules read later.
- **Hidden information** makes `View` a type of its own, built by
  `view(s, seat, over)`: the opponent's part hidden, everything shown
  once `over` is true. Otherwise `View = State`.
- **Pure.** No `Time`, no mutation, no storage: `{ s with ... }`.
  Randomness only from the `rng` handed in (`rng.below(n)`,
  `rng.shuffle(xs)`). A module-level `let` must be static (M0014), and
  every `Nat` subtraction `a - b` needs `a >= b` first.

`SEMANTICS` comes last, once the types and rules are settled. The host
serves it at `GET /semantics`, and it is all anyone else gets to build
a frontend or a bot for the game: Caffeine keeps the module. Keep the
template's section names and give the exact Candid of `View`, `Action`
and `Options`, copied field by field from the types as they end up,
never from memory (`Nat` is `nat`, `?T` is `opt T`, `[T]` is `vec T`):
a name that differs breaks every bot and frontend built from it. Then
what each field means and what a seat does not see, every rejection,
every ending, and what a UI must work out itself. Keep it under 8,000
characters, since a builder like this one reads about 10,000 of a page.
Every change of the types or the rules updates it.

## Trying it

Caffeine has no shell, so no `mops test`: it builds with the compiler
and its stable check, and checks with its lint, `tsc` and Biome. Then
ask the user to open the preview in two browsers (or a normal and a
private window: a browser's tabs share one player), create a table
with "Invite a friend" in one, open its invite link in the other, and
play a whole game: every kind of move, one illegal move (the backend's
reason shows, nothing crashes), the ending, a rematch, a leave. Their
own move appears the moment they click; the opponent's is marked when
it lands.

Caffeine's own browser check plays one seat, so it gets no further
than a table waiting for an opponent: plan its checks that far (the
lobby, a table opened from each seat, its waiting screen, leaving it)
and leave the game itself to the user's two browsers.

The preview runs a draft: canisters from a shared pool, reinstalled
empty after about two hours idle, with ids that change. Nobody but the
user plays there.

## Going live and the dashboard

Only when the user asks: Caffeine's **Go live** (4 credits, $2). The
live app has canisters of its own, which Caffeine tops up from the
owner's credits, and an address `https://<name>.caffeine.xyz`. The user
lists it on the Duel dashboard (https://games.ic0.info/) by that
address: the dashboard finds the frontend canister behind it and the
backend in its `/env.json`.
