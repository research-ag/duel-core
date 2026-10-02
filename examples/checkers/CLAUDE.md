# checkers — reference #alternating game built on duel-game-core

Standard English draughts, proving the engine's `#alternating` mode end
to end. Not part of either package.

- **`src/CheckersRules.mo`** — pure rules; `spec()` returns `#alternating
{ init; validate; resolve }` (Black/`#p1` first; no turn flag in
  `State`). `legalActions(s, seat)` enumerates every legal `Action`
  (only maximal `#jump` chains when a capture is mandatory) and is what
  `BotLogic.mo` consumes. The doc header lists the deliberate
  simplifications against tournament draughts.
- **`src/Host.mo`** — `Registry` (90s/60s), `status`, `Ws.attach` +
  `ActorMixin`, metrics, canister players (`CanisterPlayers.attach`
  reusing `attached.afterMutation`; `callBot` recovers the bot principal
  via `principalOfCanisterSession` and `await`s `make_move` in a
  `try`/`catch`; `onSettled` → `cpAttached.settle` through a mutable
  indirection; `armClaimCheck` via `Timer.setTimer`; `cpAttached.sweep`
  folded into the idle-sweep timer), `include
CanisterPlayersActorMixin(cpAttached, botDirectory, ?leaderboard)`, and
  an ELO leaderboard whose local `playerKey` special-cases `cp:` sessions
  to `CanisterPlayers.leaderboardKeyOfSession` so each bot complexity
  accumulates one rating across tables. See `../../backend/README.md`.
- **`src/BotIface.mo`** — the `CanisterPlayer` interface (`make_move`),
  imported by `Host.mo` to type the remote bot.
- **`bot/BotLogic.mo`** — `chooseMove` picks `legalActions(...)[turn %
n]`; no lookahead. Separate from `Bot.mo` so `Bot.test.mo` calls it
  directly.
- **`bot/Bot.mo`** — the bot canister: `make_move` as a `query`,
  `play(host, tableId, seat, code, complexity)` (Flow 1 self-join via
  `join_table_as_canister`), `register(host, name)`/`unregister(host)`
  (registers `[]`, listed as "Default"). Register once by hand:
  `icp canister call bot register '(principal "<backend-canister-id>", "CheckersBot")'`.
- **`test/*.test.mo`** — `RulesUnit` (synthetic boards: forward-only men,
  kings, mandatory capture, maximal chains, promotion, win by elimination
  and stalemate); `Lifecycle` (join, opening moves, then seed
  `Table.phase` to one capture from the end); `Bot` (`chooseMove` stays
  within `legalActions`, then two canister-seated bots play several real
  plies through `canister_players`).
- **`icp.yaml`** — `backend`, `bot`, and `frontend/dist`.
- **`frontend/`** — `checkers-plugin.js` renders the 8x8 board
  click-to-select: while `yourTurn`, movable pieces highlight, clicking
  one shows destinations, and the finishing click is a real `<button
data-act>` while intermediate clicks are local `<div data-sq>` state
  handled by the plugin's own listener; a multi-jump chain is built one
  click at a time; the board is flipped for Red. The opponent's last move
  (origin `.cb-last-from`, landing `.cb-last-to`, captured pieces as
  faded ghosts `.cb-last-captured`) is found by diffing consecutive
  boards, since `State` has no move history. `applyLocal` mirrors
  `resolve` (captures, crowning) so your own move shows while it is in
  flight. `renderActions` returns `""`. `app.js` wires identity, `connectWs`, `start()`, the 🏆
  leaderboard overlay (fetching `list_bots()` alongside for bot names),
  and the 🤖 Bots overlay: `list_bots()` → `renderBotList`; picking a bot
  fills the player's own staged table or shows `renderSeatChoice` and
  creates one via `ws.request(createTable)`, then calls the bot's `play`
  via `buildBotPlayIdlFactory`; a Rematch re-issues the same `play` when
  the reserved `stagingYou` lands (remembered in `sessionStorage`).

## Toolchain

moc 1.11.2. Same dependency notes as `examples/007/CLAUDE.md`; see
`../../CLAUDE.md` for the frontend refresh procedure.

## Build & test

```bash
cd examples/checkers
mops install
moc --check $(mops sources) src/CheckersRules.mo
moc --check $(mops sources) src/Host.mo
mops test                  # all four; `mops test Bot` for the bot

(cd ../../frontend && npm run build)
cd frontend && npm install --legacy-peer-deps && npm run build && node --check dist/app.js && cd ..

icp deploy
icp deploy --network ic
```

Then play both seats in two tabs: turn alternation, mandatory capture, a
multi-jump chain, promotion, claim-win against an idle opponent.

## Architecture rules

Everything in `../../CLAUDE.md`, plus:

1. **The engine is never vendored here.**
2. **The generic screens are never vendored here.**
3. **`checkers-plugin.js`'s `stepTargets`/`jumpTargets` and
   `CheckersRules.mo`'s move generation are independent implementations
   of the same rules** — Motoko is authoritative, JS is cosmetic. Keep
   both in sync.

## Game-rule notes (src/CheckersRules.mo)

- 8x8, row-major (`index = row*8 + col`), dark squares only (`(row+col)`
  odd). Black (`#p1`) starts on rows 5–7 moving toward row 0; Red (`#p2`)
  on rows 0–2 moving toward row 7.
- A man moves/captures diagonally forward; a king in all four diagonals.
- Capturing is mandatory; a `#jump` carries the whole chain and must be
  maximal.
- A man promotes on landing on the far row at the END of its chain only.
- No legal move on your turn = you lose. No draw condition.
- `turn` counts plies, not move pairs.

## Conventions

Plain interpreter tests; `msg`, not `label`; update
`RulesUnit`/`Lifecycle` when the rules change (`legalActions`
must keep matching `validate`) and keep the plugin's mirror in sync.
