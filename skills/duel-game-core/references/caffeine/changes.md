# caffeine.ai: changing a game

Every change after the first build of a game made with
`references/caffeine/game.md`. Caffeine's `migrating-motoko-actors`
skill holds: a migration the deployed version already ran is never
edited, and each new stable field comes from a new migration in
`src/backend/migrations/`. A change of `View`, `Action`, `Options` or
the rules updates `SEMANTICS` and the plugin in the same change.

**Turning on bot support or a leaderboard** adds their fields. The
lines marked BOTS or LEADERBOARD in
`references/caffeine/game-backend.md` go into `main.mo` (and
`lib/BotIface.mo`), the page's in `references/caffeine/game-frontend.md`
into `duel.ts` and `App.tsx`, and the first migration stays as it is.
The new one, here for both; for one of them, keep only its lines:

```motoko
import CanisterPlayers "mo:duel-game-core/canister_players"; // BOTS
import Leaderboard "mo:duel-game-core/leaderboard"; // LEADERBOARD

module {
  public type OldActor = {};
  public type NewActor = {
    bots : CanisterPlayers.Store; // BOTS
    leaderboard : Leaderboard.Board; // LEADERBOARD
  };

  public func migration(_ : OldActor) : NewActor {
    {
      bots = CanisterPlayers.newStore(); // BOTS
      leaderboard = Leaderboard.new(50, 1200); // LEADERBOARD
    };
  };
};

```

**Changing `State`, `Action` or `Options`** changes the type of
`duel`, whose stored records cannot change type (their `var` fields
make it invariant), so the build fails until a migration replaces it.
Spell out the old types: `{ duel : Any }` is refused as silently
dropping data.

```motoko
import Transport "mo:duel-game-core/transport";

module {
  // The new types (copied from lib/Rules.mo), and the old ones as the
  // deployed version had them.
  type Variant = { #classic; #well };
  type Options = { variant : Variant; winsNeeded : Nat };
  type Action = { #rock; #paper; #scissors; #well; #lizard };
  type Round = { p1Action : Action; p2Action : Action };
  type State = {
    p1Score : Nat;
    p2Score : Nat;
    lastRound : ?Round;
    variant : Variant;
    winsNeeded : Nat;
  };
  type OldAction = { #rock; #paper; #scissors; #well };
  type OldRound = { p1Action : OldAction; p2Action : OldAction };
  type OldState = {
    p1Score : Nat;
    p2Score : Nat;
    lastRound : ?OldRound;
    variant : Variant;
    winsNeeded : Nat;
  };

  public type OldActor = {
    duel : Transport.Duel<OldState, OldAction, Options>;
  };
  public type NewActor = { duel : Transport.Duel<State, Action, Options> };

  public func migration(_ : OldActor) : NewActor {
    { duel = Transport.new<State, Action, Options>() };
  };
};

```

Every table in progress ends and table numbers start again at 1; bots
and the leaderboard stay.

A live game changes in the same app: try the change in the preview,
then Go live again, into the same canisters (no credits). The address
and the players' tables stay, apart from what a type change ends.
