# A bot for a game that is already deployed

Read this when the task is a canister player for somebody else's
duel-game-core game: you have the game's backend canister id and a
description of how the bot should play, and no access to the game's
source. The bot is a Motoko canister of its own. The game's backend
stays where it is and calls the bot's `make_move` whenever the bot is
due; the reply is the move. Players challenge the bot from any frontend
of that game.

Everything you need comes from the backend canister id:

| What                       | From                                                               |
| -------------------------- | ------------------------------------------------------------------ |
| Rules, `State`, `Action`   | `GET /semantics` on the backend                                    |
| Whether it takes bots      | the `candid:service` metadata section                              |
| The wasm, for a local copy | `GET /wasm` on the backend                                         |
| `make_move`'s contract     | `canister-player-bots.md`, the backend README's "Canister players" |

This needs `icp-cli` and `mops` on the user's computer. A bot cannot be
tested against the live game without first being deployed, so there is
no browser-only route.

## 1. Resolve, read, download

Steps 1–4 of `frontend-for-existing-game.md`, unchanged: the backend id
(`BACKEND`), the semantics text, `backend.did`, and `backend.wasm` with
its hash checked against the live `module_hash`. Every stop condition
there applies here too.

Then check `backend.did` for `register_bot` and
`join_table_as_canister`. Without them the game seats no canister
players: stop and tell the user.

## 2. Lay out the project

```
icp.yaml
mops.toml
backend.wasm
backend.did
src/
  GameTypes.mo     State and Action, from the semantics
  GameRules.mo     the rules your strategy needs, from RULES
  BotLogic.mo      chooseMove; no actor, no Time, no storage
  Bot.mo           the canister
  Sparring.mo      local tests only: the bot's opponent
test/
  BotLogic.test.mo
README.md
```

`mops.toml` from `templates/mops.toml.template`, then `mops add
duel-game-core` (`SKILL.md` Step 1 has the fallback when that fails).

```yaml
canisters:
  - name: backend
    recipe:
      type: "@dfinity/prebuilt@v2.1.0"
      configuration:
        path: backend.wasm
        sha256: <the hash from step 1, without 0x>
  - name: bot
    recipe:
      type: "@dfinity/motoko@v4.1.0"
      configuration:
        main: src/Bot.mo
  - name: sparring
    recipe:
      type: "@dfinity/motoko@v4.1.0"
      configuration:
        main: src/Sparring.mo
```

`sparring` plays against the bot in local tests and never goes to
mainnet. Then, once:

```bash
icp canister link backend $BACKEND -e ic
```

As in `frontend-for-existing-game.md` step 5: a local `icp deploy` still
creates a fresh copy of the game, and a mistaken bare `icp deploy -e ic`
fails on `backend` instead of installing a second copy of the game on
mainnet. Keep `.icp/data/mappings/ic.ids.json` in version control.

## 3. Translate the types

`GameTypes.mo` holds `State` and `Action` translated literally from
`STATE (Candid)` and `ACTION (Candid)`:

| Candid                         | Motoko                      |
| ------------------------------ | --------------------------- |
| `record { a : nat; b : text }` | `{ a : Nat; b : Text }`     |
| `variant { x; y : T }`         | `{ #x; #y : T }`            |
| `opt T`                        | `?T`                        |
| `vec T`                        | `[T]`                       |
| `record { T; U }`              | `(T, U)`                    |
| `nat`/`int`/`nat8`/`int32`…    | `Nat`/`Int`/`Nat8`/`Int32`… |
| `bool`/`text`/`principal`      | `Bool`/`Text`/`Principal`   |

Motoko types are structural, so `variant { p1; p2 }` is `TP.Seat`
itself. Field and tag names must match exactly: the game sends `State`
inside every `MoveRequest` and decodes your `Action` reply against its
own type. A mismatch fails the call, which the engine treats as silence.

`GameRules.mo` re-implements, from `RULES`, only what the strategy
needs (typically the legal moves and the effect of one). The game's own
`validate` stays the judge: an illegal reply comes back once with
`retryReason` set to its rejection text, then the engine falls silent
and its timeouts apply.

## 4. Write the bot

`BotLogic.mo` follows `canister-player-bots.md`: `chooseMove(req)` over
`TP.MoveRequest<Game.State, Game.Action>`, the simple shape unless the
strategy needs memory. If the user asked for several difficulty
levels, list them in `COMPLEXITIES` and switch on `req.complexity`,
treating unknown values as the default.

```motoko
import Principal "mo:core/Principal";

import TP "mo:duel-game-core";

import BotLogic "BotLogic";
import Game "GameTypes";

actor {

  type Host = actor {
    join_table_as_canister : (TP.TableId, TP.Seat, ?Text, Text) -> async TP.Res<TP.JoinOk>;
    register_bot : (Text, [Text]) -> async ();
    unregister_bot : () -> async ();
  };

  // Called by frontends to challenge this bot.
  public shared func play(host : Principal.Principal, tableId : TP.TableId, seat : TP.Seat, code : ?Text, complexity : Text) : async TP.Res<TP.JoinOk> {
    let h : Host = actor (host.toText());
    await h.join_table_as_canister(tableId, seat, code, complexity);
  };

  public shared ({ caller }) func register(host : Principal.Principal, name : Text) : async () {
    assert Principal.isController(caller);
    let h : Host = actor (host.toText());
    await h.register_bot(name, BotLogic.COMPLEXITIES);
  };

  public shared ({ caller }) func unregister(host : Principal.Principal) : async () {
    assert Principal.isController(caller);
    let h : Host = actor (host.toText());
    await h.unregister_bot();
  };

  public query func make_move(req : TP.MoveRequest<Game.State, Game.Action>) : async Game.Action {
    BotLogic.chooseMove(req);
  };

};

```

`play`'s signature is fixed: frontends call it to seat the bot at a
table they opened.

## 5. Test

**Unit tests.** `test/BotLogic.test.mo` in the style of `SKILL.md`
Step 5: from a handful of positions built by hand, `chooseMove` returns
a move `GameRules` accepts, for every complexity, and the obvious tactical
cases (take a win, block a loss) where the strategy claims them.

```bash
mops test
```

**Whole games against the local copy.** `Sparring.mo` takes the other
seat the way a player's browser does: as an ordinary `an:` session
through the transport's methods, one request per call, choosing its moves with
your own `BotLogic`. The game asks the bot exactly as it will live:
right after each of sparring's moves, inside that same call.

```motoko
import Principal "mo:core/Principal";

import TP "mo:duel-game-core";
import Transport "mo:duel-game-core/transport";

import BotLogic "BotLogic";
import Game "GameTypes";

// Local tests only: takes the bot's opponent seat as a human session
// would, one request per call.
actor Sparring {

  type Reply = Transport.Reply<Game.State>;
  type Host = actor {
    duel_create_table : (Text, TP.Seat, TP.TableVisibility, Text) -> async Transport.Ack;
    duel_ack_ended : (Text) -> async Transport.Ack;
    duel_ping : (Text) -> async Transport.Ack;
    duel_submit : (Text, Nat, Nat, Game.Action) -> async Reply;
    duel_poll : query (Text, Nat) -> async Transport.PollResult<Game.State>;
  };

  func sid() : Text = Transport.sidFor(Transport.ANON_SID_PREFIX, Principal.fromActor(Sparring));
  func hostOf(host : Principal.Principal) : Host = actor (host.toText());

  // The fresh view after an acked request (`duel_poll` with rev 0 always
  // answers it).
  func view(host : Principal.Principal, ack : Transport.Ack) : async Reply {
    switch ack {
      case (#err e) #err e;
      case (#ok _) switch (await hostOf(host).duel_poll(sid(), 0)) {
        case (#changed v) #view v;
        case _ #err(#wrongPhase "no link");
      };
    };
  };

  public func open_table(host : Principal.Principal, seat : TP.Seat, variant : Text) : async Reply {
    await view(host, await hostOf(host).duel_create_table(sid(), seat, #open, variant));
  };

  // One move when this seat is due; the fresh status either way.
  public func step(host : Principal.Principal, complexity : Text) : async Reply {
    let status = await view(host, await hostOf(host).duel_ping(sid()));
    switch status {
      case (#view { view = #atTable { id; view = #inGame g } }) {
        if (g.youSubmitted) return status;
        let move = BotLogic.chooseMove({
          tableId = id;
          seat = g.seat;
          game = g.game;
          mode = g.mode;
          turn = g.turn;
          gen = g.gen;
          complexity;
          retryReason = null;
          opponent = "";
          opponentLastMove = null;
          lastRoundDurationNs = null;
        });
        await hostOf(host).duel_submit(sid(), g.gen, g.turn, move);
      };
      case _ status;
    };
  };

  public func ack_ended(host : Principal.Principal) : async Reply {
    await view(host, await hostOf(host).duel_ack_ended(sid()));
  };

};

```

```bash
icp network start -d
icp deploy
HOST=$(icp canister status backend -i)
icp canister call sparring open_table "(principal \"$HOST\", variant { p1 }, \"\")"
# ... atTable = record { id = <table id> : nat; ...
icp canister call bot play "(principal \"$HOST\", <table id> : nat, variant { p2 }, null, \"<complexity>\")"
# (variant { ok = variant { started = variant { p2 } } })
icp canister call sparring step "(principal \"$HOST\", \"<complexity>\")"
```

Repeat `step` until its reply is a `debrief`: `end` says how the game
ended (`finished` with the verdict, for a game played out), `turns`
how long it took, `finalGame` the last state. Each `step` reply shows
`turn` moving on by two in `#alternating` (sparring's move, then the
bot's) and by one in `#simultaneous`. A `step` that returns the same
`inGame` view with `youSubmitted = true` means the bot did not reply:
its move was rejected twice (compare with `RULES`) or did not decode
(compare `GameTypes.mo` with `backend.did`); a sparring call whose
types do not match `backend.did` is rejected by Candid decoding. `ack_ended` clears the debrief
before the next `open_table`.

Play at least one game per complexity, with the bot in each seat
(`open_table`'s seat is sparring's; give `play` the other one), and
one per variant `VARIANTS` lists (`open_table`'s last argument).

```bash
icp network stop
```

## 6. Going live

Never deploy anything yourself: going live spends the user's money and
is theirs to trigger. Finish by telling them, step by step, what comes
next, and leave the same in `README.md`:

```bash
icp canister link backend <backend-id> -e ic --force   # step 2's link
icp deploy bot -e ic                                   # the bot only
icp canister call bot register '(principal "<backend-id>", "<Bot Name>")' -e ic
```

Always name `bot` on the deploy line: a bare `icp deploy -e ic` also
attempts `backend` (which fails) and `sparring` (a paid canister with
no use on mainnet). `register` lists the bot, under its name and complexities,
in the game's bot directory (`list_bots`), where every frontend that
shows bots offers it as an opponent. Calling it again updates the
entry; `unregister` takes it off:

```bash
icp canister call bot unregister '(principal "<backend-id>")' -e ic
```
