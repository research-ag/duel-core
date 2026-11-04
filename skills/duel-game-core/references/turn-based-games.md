# Building a turn-based game

Read this when the game is not "both seats act every round": seats take
turns (chess, checkers, tic-tac-toe), a turn is several actions (draw a
card, then place it), or an action can grant another turn.
`templates/Rules.mo.template` is written for `#simultaneous`;
`examples/checkers/src/CheckersRules.mo` and
`examples/tic-tac-toe/src/TicTacToeRules.mo` in the framework repo are
the worked `#turnBased` examples to copy;
`examples/dots-and-boxes` is the one whose action can grant another
("Follow-up moves", below).

## The shape

```motoko
public func toMove(s : State) : TP.Seat;

public func move(s : State, seat : TP.Seat, a : Action, rng : TP.Rng) : {
  #ok : { state : State; verdict : ?TP.Verdict };
  #err : Text;
};

public let spec : TP.Spec<State, Action, View, Options> = #turnBased {
  checkOptions;
  init;
  toMove;
  move;
  view;
};

```

`toMove` says whose action the game is waiting for. `move` checks and
applies one action of that seat in a single call: `#err why` is a
rejection the player sees (the equivalent of `validate`'s `?Text`),
`#ok` the next state and, if the game ended, the verdict. The engine
rejects an action from any other seat with `#notYourTurn` before `move`
runs. `checkOptions`, `init` and `view` are as in `#simultaneous`.

Write `move` as `validate` plus `resolve`, as the examples do, so the
unit tests and a bot's `legalActions` can call the check alone:

```motoko
public func move(s : State, seat : TP.Seat, a : Action, _ : TP.Rng) : {
  #ok : { state : State; verdict : ?TP.Verdict };
  #err : Text;
} = switch (validate(s, seat, a)) {
  case (?why) #err why;
  case null #ok(resolve(s, seat, a));
};

```

## The rules decide whose turn it is

The engine never guesses: after every action it asks `toMove` again.
That is what makes every turn structure a plain matter of state:

- **Strict alternation.** Either derive it (tic-tac-toe: an even number
  of marks means X) or keep `toMove : TP.Seat` on `State` and flip it in
  `resolve` (checkers, chopsticks).
- **Several actions per turn.** Keep the turn's progress on `State` and
  leave `toMove` unchanged until the turn is complete: Rack-O stores
  `drawn : ?Nat` after `#drawFromPile`, so the same seat is asked again
  for `#placeDrawn`/`#discardDrawn`. The engine counts each action as a
  `step`; your state counts turns if the game wants to show them.
- **A repeat turn** (a capture grants another move) is the same thing:
  `resolve` simply does not flip `toMove` ("Follow-up moves", below).
- **A turn that must stay atomic** can still be ONE `Action` validated
  and applied as a whole — checkers' `#jump { path : [Nat] }` carries
  the entire capture chain, because a half-chain is never a legal
  position.

A bot is asked once per action, each time with the view as it then is,
so a multi-action turn needs no special handling in `make_move`
(`canister-player-bots.md`).

## Hidden information

`view(s, seat, over)` is the only thing a seat, human or bot, receives.
A game with hidden state (a hand, a face-down draw) gives `View` its own
shape — the own side in full, the opponent's as what is visible — and
reveals everything once `over` is true, so the debrief can show the
final position. `rack-o`'s `View` (`SideView = { rack : ?[Nat]; score }`,
`null` for the hidden rack; `drawn` only for the drawer) is the
reference; `templates/Rules.mo.template`'s `View = State` is right
whenever nothing is hidden.

## Idle takeover and claim-a-win

Both apply as documented, with one difference: only the seat NOT on
turn may claim the win. The engine enforces it and the generic chrome
hides the button from the seat on turn.

## The frontend

`renderActions` is only called while it is this seat's turn, and the
in-game view carries `toMove` and `step`. A multi-action turn is
server-driven: render the action buttons from what the view says the
seat may do now (Rack-O: slot buttons for the discard plus "draw" until
`drawn` is set, then slot buttons for the drawn card plus "discard").
Every button is an ordinary `data-act`; nothing is kept locally, so a
reload shows exactly where the turn stands.

Two things matter more here than in a simultaneous game, because every
action is a visible change. `applyLocal` (SKILL.md, Step 6) places your
piece the instant you click; without it the board sits unchanged until
the reply, and against a canister bot your move and the bot's answer
land together. Return `null` for an action whose outcome you cannot
predict (a draw from a face-down pile). And the opponent's last move
gets a mark: when `View` records none, the plugin keeps the previous
board and diffs (one cell went from empty to theirs; for checkers, an
origin, a landing, and the captured squares), resetting to "no mark"
whenever the difference isn't exactly one opponent move.
`examples/tic-tac-toe`, `examples/ultimate-tic-tac-toe` and
`examples/checkers` do both.

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

## Follow-up moves

An action that earns the same seat another one — dots and boxes' line
closing a box, a capture that moves again — works as one action per
`move` with `resolve` keeping `toMove`, but then every follow-up is a
round trip with the board locked while it is out. When the mover can
tell whether the turn continues (nothing hidden or random decides it),
make the `Action` the whole turn instead, as checkers' `#jump { path }`
is the whole capture chain. Dots and boxes' `#draw { lines : [Nat] }`
carries every line of the turn in order; `move` checks them one by one
(every line but the last must close a box, the last must not unless it
fills the board) and then passes the turn. A turn is one submit, one
`step` and one bot ask, seats strictly alternate, and `State` records
the whole turn (`lastTurn : [Nat]`) so the opponent's page replays it
in order.

The page builds the turn locally, the way checkers builds a jump chain.
A click that grants another action is local state: a plain button the
plugin's own listener handles, adding the action to a draft and
redrawing the board with the draft applied (and offering to take the
last one back). The click that ends the turn is a real `data-act`
button carrying the draft plus that action, so `app.js` submits the
whole turn unchanged, and `applyLocal` applies it all while it is in
flight. The draft belongs to the board it was drawn on: a new view
clears it. `examples/dots-and-boxes/frontend/src/dots-and-boxes-plugin.js`
is the worked example; its `play-test.mjs` drives the same clicks
headlessly. The claim clock runs over the whole turn, as over any move.

When the outcome is hidden from the mover (battleship: a shot's hit or
miss), the page cannot know whether the turn continues: keep one action
per call, let `resolve` keep `toMove` on a hit, and the player sees each
result before choosing the next shot.

A bot answers with the whole turn too: pick the actions one after
another over the rules' own helper (dots and boxes' `drawLine`) until
one ends the turn.
