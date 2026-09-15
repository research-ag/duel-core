# Building a strictly alternating-turn game

Read this when the rules you were handed describe a game where seats take
turns in order — chess, checkers, tic-tac-toe, any "players alternate
moves" description — rather than both seats acting simultaneously every
round. `templates/Rules.mo.template` is written for the common
`#simultaneous` case; this file covers the `#alternating` shape instead.
`examples/checkers/src/CheckersRules.mo` (in the `duel-game-core` repo
itself) is a complete, real worked example — copy its overall shape the
same way `templates/Rules.mo.template` is normally copied.

## The `TurnSpec` shape

`TP.Spec<State, Action>` is tagged by mode. Instead of
`#simultaneous { init; validate; resolve }`, build:

```motoko
public func spec() : TP.Spec<State, Action> = #alternating {
  init;
  validate;
  resolve;
};
```

Only `resolve`'s signature actually differs from the `#simultaneous`
shape:

```motoko
resolve : (State, TP.Seat, Action) -> { state : State; verdict : ?TP.Verdict }
```

It takes the ONE seat currently on turn and their one move — not two
moves at once — and runs the instant that seat submits. `init` and
`validate` keep the exact same signatures as `#simultaneous` (`validate`
is still called for whichever seat is about to act, before `resolve`
runs).

## The engine tracks whose turn it is — you never do

Do **not** add a "whose turn" field to your own `State`. The engine
already knows: it derives it from the match's own round counter (p1
always moves first, then it alternates every resolved round) and rejects
an off-turn submission itself, before your `validate` ever runs
(`Err.#notYourTurn`). This is the same trap `SKILL.md`'s own "Every phase
needs no special handling from you" pitfall warns about for a
"waiting for opponent" flag — a turn flag is exactly that pattern again,
just for a different field.

One consequence worth designing around: a submitted `Action` must be
**one full turn's worth of decision**, resolved in a single call — the
engine has no notion of "the same seat moves again" mid-turn. A game
whose rules sometimes require several linked decisions in a row before
turn passes (checkers' mandatory multi-jump chains are the standard
example) should fold the whole chain into ONE `Action` value, validated
and applied as a single atomic move — see `CheckersRules.mo`'s `#jump`
case (`path : [Nat]`, the full capture sequence) for the pattern. Turn
always passes to the other seat after every `resolve`, no exceptions.

## Idle takeover and claim-a-win still apply — with one restriction

Both work exactly as documented for `#simultaneous` games (Step 4 of the
main `SKILL.md`), with one difference: **only the seat currently WAITING
on the other's turn may claim the win** — the seat whose own turn it is
can never see or use the claim-win control, since they're the one
holding up the game, not the one waiting on it. Nothing in your own
`Rules.mo`/`Host.mo` needs to account for this; the engine enforces it,
and the generic frontend chrome (`duel-game-core/render.js`) already
hides the claim button from the on-turn seat automatically.

## The frontend needs no special handling either

`GamePlugin.renderBoard`/`renderActions` work exactly the same way for
an alternating game as a simultaneous one — `renderActions` is still
"only ever called while it's legal for THIS seat to move" (the generic
chrome hides it automatically on the seat's own off-turn screen, the same
mechanism that hides it during a simultaneous round after that seat has
already locked in a move). The one thing worth knowing: a board game
whose moves are `{from; to}` coordinate pairs (rather than a small fixed
set like `#load`/`#shoot`) usually means `renderActions` enumerates every
legal destination for every one of the mover's own pieces and renders one
button per legal move (mirroring `validate`, the same "cosmetic legality
mirror" pattern Step 6 already describes) — see
`examples/checkers/frontend/src/checkers-plugin.js` for a worked example
of that enumeration. This still fits the plain-button model; it doesn't
need `references/rich-ui.md`'s drag-and-drop/canvas escape hatch unless
your own game's UI genuinely can't be expressed as a list of buttons.
