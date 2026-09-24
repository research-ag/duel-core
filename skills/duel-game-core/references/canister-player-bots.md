# Writing a canister-player bot: simple vs. stateful

Read this when you're building the BOT canister itself (`Bot.mo`/
`BotLogic.mo`, called from a host's `mo:duel-game-core/canister_players`
wiring — see `SKILL.md`'s "Canister players (optional)" step for how
that wiring goes) and the bot needs to be more than "always play the
same fixed thing" or "pick deterministically from the board." Both
shipped reference bots (`examples/racing/bot/`/`examples/checkers/bot/`
in `research-ag/duel-core`) are the SIMPLE shape this file's first half
describes; neither remembers anything, and neither needs to. This file
exists for the other shape: a bot that tracks a match's own move
history, or builds a model of a specific opponent's tendencies across
many games. Both shapes are legitimate; which one you need is a decision
the user's own rules description should make for you — don't reach for
the stateful shape "for robustness" if nothing about the bot's own
strategy actually calls for memory.

## What `make_move` receives

`TP.MoveRequest<S, M>` (`S` = your game's `State`, `M` = your `Action`)
is what a canister-seated bot's `make_move(req)` is called with — see
`mo:duel-game-core`'s own `types.mo` doc comment (shipped in the
package) for the exhaustive field-by-field reasoning; the short version,
grouped by what each field is for:

- `game`, `seat`, `mode`, `turn` — exactly what a human's own screen
  would show right now: the board, which seat you are, whether the game
  is `#simultaneous`/`#alternating`, and the round number.
- `gen` — this specific MATCH's own identity. It bumps on every fresh
  `stage()` — a join, a takeover, a REMATCH included — so a board
  replayed on the exact same `tableId` still hands you a `gen` you've
  never seen. You never submit it anywhere yourself (you never call
  `submit` at all — see "The call/response protocol, in one sentence"
  below, the engine re-reads it fresh on your behalf); its only use to
  YOU is as a per-match memory key (see "Keying your own memory"
  below). `turn == 0` is an equivalent signal for "this is a fresh
  match" if you'd rather not carry `gen` around.
- `retryReason` — `null` on a fresh ask; if your PREVIOUS reply this
  round was illegal, you're asked again with this set to the exact text
  your own `validate` rejected it with, so you can correct specifically
  what was wrong instead of guessing.
- `opponent` — the opposing seat's own `SessionId`, raw. For a human
  (`ii:`/`an:`) this reads the SAME on every table they ever play — a
  ready-made, stable key for modeling one specific player over many
  games. For another canister (`cp:`) it's deliberately per-TABLE
  instead; recover its stable principal with
  `CanisterPlayers.principalOfCanisterSession(req.opponent)` if you want
  to model a specific bot opponent across several boards the same way.
- `opponentLastMove` — the opponent's own most recently RESOLVED move.
  Never the current round's still-secret one (nothing in this package
  ever hands a pending move to the opponent's own side — that guarantee
  is untouched); this is strictly history, already public via the
  round's own resolved outcome. `null` exactly when `turn == 0`.
- `lastRoundDurationNs` — wall-clock nanoseconds the last round/turn
  took. `#simultaneous`: both seats' combined time (the round resolves
  only once both moved, so there's no way to attribute the delay to one
  side); `#alternating`: unambiguously that one mover's own time, since
  only one seat moves per turn. `null` under the same `turn == 0`
  condition as `opponentLastMove`.

## The call/response protocol, in one sentence

The GAME canister calls YOUR `make_move`, and your reply IS the move —
you never call anything back (`submit`, `leave`, ...) yourself. See
`mo:duel-game-core`'s own `backend/README.md` "Canister players" section
(shipped in the package) for the full protocol; all you need to know
here is that `make_move` is a plain request/reply
method, called once per round you're due to move, and an illegal reply
gets you asked exactly once more with `retryReason` set before the
engine gives up and lets the ordinary timeout machinery take over.

## Two development curves

**Simple: a pure function, `query`.** If your bot's whole strategy is a
function of `game`/`seat`/`turn` alone — a fixed script, a rule-following
lookup, a minimax search over the current board — write `make_move` as a
`query`:

```motoko
public query func make_move(req : TP.MoveRequest<Rules.State, Rules.Action>) : async Rules.Action {
  BotLogic.chooseMove(req);
};
```

This is `examples/racing/bot/Bot.mo` and `examples/checkers/bot/Bot.mo`
verbatim (in `research-ag/duel-core`). A `query` call is near-instant
and doesn't touch consensus —
strictly better than an `update` call for a bot that has nothing to
persist. Keep the actual move-selection logic (`BotLogic.mo`) in a
separate, plain module with no `actor`/`Time`/storage of its own, the
same way both examples do — it makes the logic directly unit-testable
(`test/Bot.test.mo` calls `BotLogic.chooseMove` straight, no actor/Candid
round-trip needed) and keeps `Bot.mo` itself a thin shell.

**Stateful: remembers across calls, `update`.** The moment your bot
wants to remember ANYTHING between one `make_move` call and the next —
a match's own move history, a running model of one opponent's
tendencies — `make_move` can no longer be a `query`. This is a hard IC
constraint, not a style choice: a query call's own state mutations are
never durably committed (the call runs against a snapshot and is
discarded the instant it returns), regardless of who called it or from
what context. Declare it as an ordinary `public func` instead:

```motoko
public func make_move(req : TP.MoveRequest<Rules.State, Rules.Action>) : async Rules.Action {
  BotLogic.chooseMove(req, opponentModels); // opponentModels: this actor's own stable memory, below
};
```

Nothing else in the design changes to allow this: `BotIface.mo`'s own
`CanisterPlayer` type never declared `make_move` as `query` in the first
place (only your bot's own concrete `Bot.mo` does), so this is entirely
your own canister's choice — no change needed to `Host.mo`, to
`BotIface.mo`, or to the engine. The real cost is latency: an `update`
call goes through full consensus (typically a couple of seconds) where a
`query` call is near-instant, so a host wiring a stateful bot should size
`claimTimeoutNs`/`idleTimeoutNs` more generously than it would for a
purely reactive bot — a stateful bot that's still "thinking" (awaiting
its own consensus round) when the opponent's own claim-win window opens
will lose ties it didn't need to.

A `persistent actor` bot — the shape every example bot already uses —
needs no further ceremony to make that memory durable across upgrades:
a plain

```motoko
persistent actor {
  var opponentModels : Map.Map<TP.SessionId, OpponentModel> = Map.empty();
  ...
};
```

field is automatically stable. No manual pre/post-upgrade hooks, no
separate stable-var shadow copy.

## Keying your own memory

Two different lifetimes call for two different keys, and `MoveRequest`
gives you a stable one for each:

- **Per-MATCH** memory (a move history for the game currently being
  played, reset for the next one) — key off `(req.tableId, req.gen)`.
  `gen` changes on every fresh match, a rematch on the SAME `tableId`
  included, so this pair is never accidentally shared between two
  separate games on the same board. Watching for `req.turn == 0` is an
  equivalent, slightly cruder signal for "this is a fresh match, reset
  my per-match state" if you don't want to carry `gen` around at all.
- **Per-OPPONENT** memory (a model of one specific player's tendencies,
  carried across every table they ever play you) — key off
  `req.opponent` directly for a human (`ii:`/`an:`) opponent, since it's
  already stable across tables. For a canister opponent, key off
  `CanisterPlayers.principalOfCanisterSession(req.opponent)` instead —
  `req.opponent` itself is per-TABLE for a `cp:` session (mirroring
  `Ws.playerKey`'s own documented `cp:` caveat for the SAME reason: a
  canister principal can hold a live seat at several boards at once, so
  its raw session can't double as a per-PLAYER key the way a human's
  already does).

## The retry pitfall: make your own writes idempotent

`notifyAndApply` retries a rejected reply exactly once, calling
`make_move` a SECOND time for the SAME round (`retryReason` set, every
other field — `tableId`/`gen`/`turn` included — unchanged). If your bot
records its OWN move history by blindly appending on every call, a
retried round gets logged twice. There's also no separate "your move was
accepted" callback — `make_move` returning is the end of your bot's own
involvement in that round, whether the engine ends up accepting the
reply or not (a stale table, a race with the opponent leaving, etc. can
all still make even a LEGAL reply not land — see `mo:duel-game-core`'s
own `canister_players.mo` `notifyAndApply` doc, shipped in the package).
The fix for both
problems is the same: treat `(req.tableId, req.gen, req.turn)` as the
identity of one decision point and **upsert** (`Map.add`/overwrite by
that key) rather than append/push. A retry naturally overwrites the same
slot with your corrected move instead of creating a second entry, and a
reply that silently never lands just leaves a harmless, eventually
overwritten guess sitting in your own history — never a phantom
duplicate.

## A worked sketch

The shape below is deliberately generic — swap `Rules.State`/
`Rules.Action` for your own game's types, and `OpponentModel` for
whatever your bot's own strategy actually wants to remember (a move
histogram, a rolling win rate, a simple pattern counter — the ENGINE has
no opinion on any of this; everything past `req.opponent`/
`req.opponentLastMove` is entirely your own bot's design):

```motoko
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";

import TP "mo:duel-game-core";
import CanisterPlayers "mo:duel-game-core/canister_players";

import Rules "../src/RockPaperScissorsRules"; // however your game is named

persistent actor {

  type OpponentModel = {
    var movesSeen : Nat;
    var rockCount : Nat;
    var paperCount : Nat;
    var scissorsCount : Nat;
  };

  // Per-opponent, cross-table — keyed by the opponent's own stable
  // identity (see "Keying your own memory" above). A plain Text key, and
  // `.get`/`.add` called with dot notation (this package's own house
  // style — see the root CLAUDE.md's dot-notation-migration note) infer
  // their own comparator for a `Text` key with no explicit argument.
  var opponentModels : Map.Map<Text, OpponentModel> = Map.empty();

  // Per-match, reset every fresh game — keyed by "tableId/gen" (both
  // Nat, joined into one Text key — simplest way to combine two values
  // into a single Map key with no custom comparator to write).
  var matchHistory : Map.Map<Text, [Rules.Action]> = Map.empty();

  func matchKey(req : TP.MoveRequest<Rules.State, Rules.Action>) : Text {
    Nat.toText(req.tableId) # "/" # Nat.toText(req.gen);
  };

  // `req.opponent` itself for a human; a canister opponent's own stable
  // principal instead, since ITS raw session is per-table — see "Keying
  // your own memory" above.
  func opponentKey(req : TP.MoveRequest<Rules.State, Rules.Action>) : Text {
    if (CanisterPlayers.isCanisterSession(req.opponent)) {
      Principal.toText(CanisterPlayers.principalOfCanisterSession(req.opponent));
    } else {
      req.opponent;
    };
  };

  func modelFor(key : Text) : OpponentModel {
    switch (opponentModels.get(key)) {
      case (?m) m;
      case null {
        let fresh = { var movesSeen = 0; var rockCount = 0; var paperCount = 0; var scissorsCount = 0 };
        opponentModels.add(key, fresh);
        fresh;
      };
    };
  };

  // Record the OPPONENT's own last move (never your bot's own guess) —
  // opponentLastMove is already history by the time you see it, so
  // there's nothing to hide here (see "What make_move receives" above).
  func learnFrom(req : TP.MoveRequest<Rules.State, Rules.Action>) {
    switch (req.opponentLastMove) {
      case null {}; // turn == 0 — nothing to learn yet
      case (?move) {
        let m = modelFor(opponentKey(req));
        m.movesSeen += 1;
        switch (move) {
          case (#rock) m.rockCount += 1;
          case (#paper) m.paperCount += 1;
          case (#scissors) m.scissorsCount += 1;
        };
      };
    };
  };

  public func make_move(req : TP.MoveRequest<Rules.State, Rules.Action>) : async Rules.Action {
    learnFrom(req);
    let m = modelFor(opponentKey(req));
    // ...pick a move that counters `m`'s own most frequent count...
    let chosen : Rules.Action = #rock; // placeholder — your own strategy goes here
    // Upsert by (tableId, gen), not append — see "The retry pitfall"
    // above. A real bot would grow this into "the array so far, with
    // `chosen` appended", not overwrite it outright; shown as a single
    // upsert here only to keep the sketch to the one idea it's making.
    matchHistory.add(matchKey(req), [chosen]);
    chosen;
  };

};
```

## What NOT to do

- Don't try to read the opponent's CURRENT, still-pending move — there
  is no field for it, on purpose (a pending move is hidden from the
  opponent's own side by construction, and `MoveRequest` never breaks
  that for a canister-seated opponent either). `opponentLastMove` is
  always history, never the live secret.
- Don't assume `opponentLastMove`/`lastRoundDurationNs` are populated —
  both are `null` on a fresh match's very first ask (`turn == 0`) and a
  bot that force-unwraps them traps its own call, which the engine
  treats exactly like a silent/trapping bot (no retry, no move, the
  ordinary timeout machinery takes over — see `mo:duel-game-core`'s own
  `canister_players.mo` "silence is already a first-class outcome" doc,
  shipped in the package).
- Don't key per-match state by `req.turn` alone — a `turn` counter resets
  to `0` on every fresh match, so two DIFFERENT matches on the same
  `tableId` (a rematch) would collide on that key alone. Always pair it
  with `req.gen` (or key on `req.tableId`/`req.gen` directly, without
  `turn` at all, as this file's own worked sketch does).
- Don't reach for the stateful shape by default. A stateless, `query`
  bot is simpler, faster, and cheaper — the right choice unless the
  user's own rules description specifically calls for a bot that learns
  or remembers.
