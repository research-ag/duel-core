# caffeine.ai: a bot for a game already deployed

A bot is a canister that plays a duel-game-core game by itself: the
game calls its `make_move` whenever the bot is due and plays what it
answers. Here it is a Caffeine app of its own, with
`mops add duel-game-core` and `mops add promtracker`. This file is its
backend; `references/caffeine/bot-page.md` is its page and how it goes
live. Every file of this skill is at
`https://api.hosty.live/skills/duel-game-core/<path>`,
and these two are all a bot needs.

Caffeine runs no shell and installs no prebuilt module, so there is no
copy of the game to test against: the bot is tried as its live
canister, against the live game.

1. **The game.** `https://<backend-id>.raw.icp0.io/semantics` is the
   whole specification: `MODE`, `SEATS`, `OPTIONS`, the exact Candid of
   `View` (headed `VIEW`, or `STATE` in older games) and `Action`,
   `RULES`, `ENDINGS` and `CLIENT NOTES`. A 404 lists the paths the
   backend serves; fetch any the semantics names. Without it, stop and
   tell the user. Only a game with bot support seats a bot: when the
   game's page has no 🤖 list, or the first try is rejected for a
   missing `join_table_as_canister`, stop and tell the user.
2. **`src/backend/lib/GameTypes.mo`**: `View`, `Action` and `Options`
   translated literally from that Candid. `record { a : nat }` is
   `{ a : Nat }`, `variant { x; y : T }` is `{ #x; #y : T }`, `opt T`
   is `?T`, `vec T` is `[T]`, `record { T; U }` is `(T, U)`, and
   `variant { p1; p2 }` is `TP.Seat` itself. Names must match exactly:
   a mismatch fails the call, which the game treats as silence.
3. **`src/backend/lib/BotLogic.mo`**, a plain module with no actor,
   `Time` or storage: `COMPLEXITIES`, the levels the user asked for
   (`[]` for one, listed as `Default`), and
   `chooseMove(req : TP.MoveRequest<Game.View, Game.Action>) : Game.Action`.
   `req` carries `game` (the bot's `View`, never the hidden state),
   `seat` (the bot's side: pass it to every function that needs it,
   never work it out from the view), `step` (actions applied so far, or rounds resolved),
   `complexity` (switch on it; treat an unknown one as the default and
   never trap), `opponentLastMove` (`null` at step 0) and `retryReason`
   (on a second ask after an illegal reply, its rejection text; after
   that the game falls silent and its timeouts apply). Re-implement
   from `RULES` only what the strategy needs, typically the legal moves.
   A random pick must not come from `step` and `seat` alone, or the bot
   plays the same sequence every match. A bot that picks at random gives
   `chooseMove` a second parameter, `now : Int`, which it hashes with
   `req.seat`; `make_move` below then passes it
   `BotLogic.chooseMove(req, Time.now())`, with `mo:core/Time` imported.
4. **`src/backend/mixins/BotApi.mo`**:

   ```motoko
   import Principal "mo:core/Principal";

   import TP "mo:duel-game-core";

   import BotLogic "../lib/BotLogic";
   import Game "../lib/GameTypes";

   mixin (owner : Principal) {
     type Host = actor {
       join_table_as_canister : (TP.TableId, TP.Seat, ?Text, Text) -> async TP.Res<TP.JoinOk>;
       register_bot : (Text, [Text]) -> async ();
       unregister_bot : () -> async ();
     };

     public shared func play(host : Principal, tableId : TP.TableId, seat : TP.Seat, code : ?Text, complexity : Text) : async TP.Res<TP.JoinOk> {
       let h : Host = actor (host.toText());
       await h.join_table_as_canister(tableId, seat, code, complexity);
     };

     public shared ({ caller }) func register(host : Principal, name : Text) : async () {
       assert caller == owner;
       let h : Host = actor (host.toText());
       await h.register_bot(name, BotLogic.COMPLEXITIES);
     };

     public shared ({ caller }) func unregister(host : Principal) : async () {
       assert caller == owner;
       let h : Host = actor (host.toText());
       await h.unregister_bot();
     };

     public query func make_move(req : TP.MoveRequest<Game.View, Game.Action>) : async Game.Action {
       BotLogic.chooseMove(req);
     };
   };

   ```

   `play`'s signature is fixed: game pages call it to seat the bot.
   `make_move` stays a `query` unless the bot remembers something
   across calls; a bot that does is an ordinary `public func` (a query
   commits no state), keys its memory by `(tableId, gen, seat, step)`
   and overwrites by that key, since a retry repeats it.

5. **`src/backend/main.mo`**, which serves promtracker's system metrics
   at `GET /metrics` like every bot (the Duel dashboard reads its
   balance there) and names the owner. `register` and `unregister`
   accept that one caller: the canister's controller is Caffeine, and
   the app's admin role goes to whoever signs in first on each new
   canister, so neither identifies the bot's owner. The first migration
   is Caffeine's own, creating `accessControlState`:

   ```motoko
   import Principal "mo:core/Principal";

   import AccessControl "mo:caffeineai-authorization/access-control";
   import MixinAuthorization "mo:caffeineai-authorization/MixinAuthorization";
   import Expose "mo:caffeineai-oql/Expose";
   import HttpActorMixin "mo:duel-game-core/http_actor_mixin";
   import PT "mo:promtracker";

   import BotApi "mixins/BotApi";

   actor {
     let accessControlState : AccessControl.AccessControlState;
     include MixinAuthorization(accessControlState, null);
     include Expose({ entities = [] });

     // The owner's principal, as this app's sign-in shows it to them. Until
     // it is set, aaaaa-aa (the management canister) matches no caller.
     transient let owner = Principal.fromText("aaaaa-aa");

     transient let renderer = PT.Renderer();
     renderer.addValue(PT.allSystemMetrics);

     include BotApi(owner);
     include HttpActorMixin([("/metrics", renderer.renderExposition)]);
   };

   ```
