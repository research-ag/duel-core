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

An action that earns the same seat another one — dots and boxes'
line closing a box, battleship's hit — is a repeat turn on the server
(`resolve` keeps `toMove`). Each action is still one `step`, and the
engine runs `move` on every one of them.

A client may send several actions of one turn in one call,
`duel_submit_moves(tableId, gen, step, actions)`, stamped with the
`step` before the first. The engine applies them in order and stops at
the first that is illegal, comes after the turn has passed, or comes
after the game ended: the actions before it stay applied, the rest are
dropped, and only a failing FIRST action is the call's error. A
`#simultaneous` game takes exactly one action per call. The method is
opt-in: a host whose actions can grant another turns on the FOLLOW-UP
lines of `templates/Host.mo.template`; any other host leaves it out.

On the page this is one hook. When the outcome of an action is
deterministic, write `localToMove(gameState)` beside `applyLocal`: the
seat on turn in the board `applyLocal` drew, `null` once that board
cannot tell (it is full, the game is over).

```js
localToMove(gameState) {
  const board = unpack(gameState);
  return board.lines.some((l) => l === null) ? board.toMove : null;
},
```

With both hooks, `start()` keeps the move buttons live while a submit is
in flight and the predicted board still has this seat on turn. Each
further click is drawn at once and queued (`ClientState.queued`), and
the whole queue goes out as one call when the reply lands, so a chain
of N actions takes about two round trips instead of N. If the reply
shows the turn already passed, the queue is dropped (`CallOutcome`
reason `"dropped"`) and the board shows the truth. A custom UI over
`createDuelClient` gets the same by passing `plugin` to it and drawing
`withLocalMove(state.status, state.pending, plugin.applyLocal, {
queued: state.queued, localToMove: plugin.localToMove })`;
`client.submitMoves(moves)` sends a turn it planned itself.

When the outcome is hidden from the mover (battleship: a shot's hit or
miss), the page cannot know whether the turn continues: `localToMove`
returns `null` (or is left out), each shot goes as its own call, and the
player sees the result before choosing the next one. That needs nothing
beyond the repeat turn itself.

Show the opponent's whole turn, not only its last action: keep the
latest turn's actions on `State` (`lastTurn : [Action]`, or the game's
own shape such as the line indices `lastTurn : [Nat]`), appended while
the same seat keeps moving and restarted when the turn passes, so the
plugin replays them in order. `examples/dots-and-boxes` keeps only
`lastLine`, so its plugin diffs consecutive boards and animates a burst
of new lines ending on `lastLine`. Adding such a field to a game that is
already live changes its stable `State` type: that is an actor migration
or a reinstall (`changing-a-live-game.md`).

A canister bot is asked once per action, also within a chain, so its
canister belongs on the game's subnet (`canister-player-bots.md`).
