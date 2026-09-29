# Building a strictly alternating-turn game

Read this when seats take turns in order (chess, checkers, tic-tac-toe)
rather than both acting every round. `templates/Rules.mo.template` is
written for `#simultaneous`; `examples/checkers/src/CheckersRules.mo` in
the framework repo is the worked `#alternating` example to copy.

## The shape

```motoko
public func spec() : TP.Spec<State, Action> = #alternating {
  init;
  validate;
  resolve;
};

resolve : (State, TP.Seat, Action) -> { state : State; verdict : ?TP.Verdict };

```

`resolve` takes the one seat on turn and its move, and runs the instant
that seat submits. `init` and `validate` keep the `#simultaneous`
signatures.

## The engine tracks whose turn it is — you never do

Do not add a turn field to `State`. The engine derives it from the round
counter (p1 first, then alternating) and rejects an off-turn submission
with `Err.#notYourTurn` before `validate` runs.

An `Action` is one full turn's decision, resolved in one call; turn
always passes afterwards. A rule that needs several linked decisions
before turn passes (checkers' multi-jump chain) folds them into ONE
`Action`, validated and applied atomically — see `CheckersRules.mo`'s
`#jump { path : [Nat] }`.

## Idle takeover and claim-a-win

Both apply as documented, with one difference: only the seat WAITING on
the other's turn may claim the win. The engine enforces it and the
generic chrome hides the button from the on-turn seat.

## The frontend needs no special handling

`renderActions` is still only called while it is legal for this seat to
move. `renderBoard` receives a fourth `yourTurn` argument for a game
whose interaction lives on the board itself.

A game whose moves are coordinate pairs reads better as click-to-select
than a button list: click a piece, click a destination. The click that
FINISHES a move is a real `<button data-act=...>` (`actionAttr()`), so
`app.js` submits it unchanged; intermediate "select this piece"/"continue
this chain" clicks are local UI state (`<div data-sq=...>` handled by the
plugin's own `document.addEventListener("click", ...)`, gated by
`yourTurn`) and never reach the engine. `examples/checkers/frontend/src/checkers-plugin.js`
is the worked example; its `stepTargets`/`jumpTargets` mirror `validate`
cosmetically, deciding what to highlight. This does not need
`references/rich-ui.md` unless the UI genuinely can't be clickable
squares.
