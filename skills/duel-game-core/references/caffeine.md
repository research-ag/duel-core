# caffeine.ai: a game, a bot or a frontend built there

Read this when the work happens in caffeine.ai: its AI builder, from a
user's chat, or an agent driving its CLI. Caffeine builds and hosts
every app as one Motoko canister named `backend` and a React frontend,
and keeps the source itself. Caffeine's own skills (`caffeine-app`,
`writing-motoko`, `migrating-motoko-actors`) still apply; this file
says what a duel-game-core game, bot or frontend needs on top of them.

Sections: 1 a game, 2 changing it later, 3 a bot for a deployed game,
4 a frontend for a deployed game, 5 the CLI.

Every other file of this skill is at
`https://raw.githubusercontent.com/research-ag/duel-core/main/skills/duel-game-core/<path>`,
`SKILL.md` and `templates/Rules.mo.template` among them.

What differs from the rest of this skill:

- **The layout is Caffeine's.** `src/backend/main.mo` with `lib/`,
  `mixins/` and `migrations/`, and `src/frontend/` (React, Vite,
  pnpm). The templates `Host.mo`, `icp.yaml`, `publish_wasm.sh`,
  `build.js`, `index.html`, `app.js`, `play-test.mjs` and
  `check-upgrade.mjs` have no place here; the code below replaces them.
- **Stable fields get no value where they are declared.** The first
  migration creates them (section 1). Keep Caffeine's
  `MixinAuthorization` (its lint requires it) and `Expose`.
- **No shell, no local network.** Caffeine builds with the compiler
  and its stable check, and checks with its lint, `tsc` and Biome. Then
  the user plays the draft in the preview.
- **Draft and live are different canisters.** A draft comes from a
  shared pool, is reinstalled empty after about two hours idle, and its
  ids change. Go live creates the permanent canisters: those are what
  players use, what bots register with and what the Duel dashboard
  lists.
- **The module stays with Caffeine.** It is not in hosty.live's module
  store, so `/semantics` is all a third party gets: their frontends and
  bots are built from it and tested against the live game, on
  access-code tables.
- **Caffeine pays the cycles.** It tops up the live canisters from the
  owner's Caffeine credits.

## 1. A game

### Packages

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
from 6: with 5, `tsc` fails though the page runs. Caffeine's providers
in `main.tsx` still render on 6.

### The rules: `src/backend/lib/Rules.mo`

`SKILL.md` Steps 2 and 3, from `templates/Rules.mo.template`
(`references/turn-based-games.md` for a game that waits for one seat):
`State`, `Action`, `View`, `Options`, `spec`, and the `SEMANTICS` text,
which the host serves at `GET /semantics`. A pure module: no state, no
`Time`, randomness only from the `rng` handed in.

### The host

`src/backend/main.mo`:

```motoko
import Registry "mo:duel-game-core/registry";
import Transport "mo:duel-game-core/transport";
import TransportActorMixin "mo:duel-game-core/transport_actor_mixin";
import HttpActorMixin "mo:duel-game-core/http_actor_mixin";
// import CanisterPlayers "mo:duel-game-core/canister_players"; // BOTS
// import CanisterPlayersActorMixin "mo:duel-game-core/canister_players_actor_mixin"; // BOTS
// import Leaderboard "mo:duel-game-core/leaderboard"; // LEADERBOARD
// import LeaderboardActorMixin "mo:duel-game-core/leaderboard_actor_mixin"; // LEADERBOARD
import AccessControl "mo:caffeineai-authorization/access-control";
import MixinAuthorization "mo:caffeineai-authorization/MixinAuthorization";
import Expose "mo:caffeineai-oql/Expose";
import PT "mo:promtracker";
import Tracker "mo:promtracker/Tracker";

// import BotIface "lib/BotIface"; // BOTS
import Rules "lib/Rules";
import DuelApi "mixins/DuelApi";

actor {
  let accessControlState : AccessControl.AccessControlState;
  include MixinAuthorization(accessControlState, null);
  include Expose({ entities = [] });

  let pt : PT.Tracker;
  transient let renderer = PT.Renderer();
  renderer.addValue(PT.allSystemMetrics);
  renderer.addValue(pt.toValue());

  let duel : Transport.Duel<Rules.State, Rules.Action, Rules.Options>;
  duel.registry.setTimeouts(90_000_000_000, 60_000_000_000);
  duel.registry.attachMetrics(pt);

  // let bots : CanisterPlayers.Store; // BOTS
  // let leaderboard : Leaderboard.Board; // LEADERBOARD

  transient let env : Transport.Env<Rules.State, Rules.Action, Rules.View, Rules.Options> = {
    spec = Rules.spec;
    bots = null; // BOTS: ?{ store = bots; call = BotIface.callBot }
    scoring = null; // LEADERBOARD: ?{ board = leaderboard; rating = #elo { k = 32 } }
    sweeper = Transport.sweeper();
  };

  include TransportActorMixin<system>(duel.lobby(env));
  include DuelApi(duel, env);
  // include CanisterPlayersActorMixin(duel.canisterPlayers(env), bots.directory, null); // BOTS; ?leaderboard with LEADERBOARD
  // include LeaderboardActorMixin(leaderboard, 25); // LEADERBOARD
  include HttpActorMixin([
    ("/semantics", func() : Text = Rules.SEMANTICS),
    ("/metrics", renderer.renderExposition),
  ]);
};

```

`Registry` and `Tracker` look unused, but `duel.registry.setTimeouts`
and `pt.toValue()` need them. The two timeouts (90 s idle, 60 s claim)
are `SKILL.md` Step 4's; that line runs on every upgrade. Add no other
public method for a game operation: the transport is the only path.

`src/backend/mixins/DuelApi.mo`, the four methods whose types name the
game's own:

```motoko
import TP "mo:duel-game-core";
import Transport "mo:duel-game-core/transport";

import Rules "../lib/Rules";

mixin (
  duel : Transport.Duel<Rules.State, Rules.Action, Rules.Options>,
  env : Transport.Env<Rules.State, Rules.Action, Rules.View, Rules.Options>,
) {
  public shared ({ caller }) func duel_create_table(seat : TP.Seat, visibility : TP.TableVisibility, options : Rules.Options) : async Transport.Ack {
    await* duel.createTable<system, Rules.State, Rules.Action, Rules.View, Rules.Options>(env, caller, seat, visibility, options);
  };

  public shared query ({ caller }) func duel_lobby(rev : Nat) : async Transport.LobbyResult<Rules.Options> {
    duel.lobbyView(caller, rev);
  };

  public shared ({ caller }) func duel_submit(tableId : TP.TableId, gen : Nat, step : Nat, action : Rules.Action) : async Transport.Reply<Rules.View> {
    duel.reply(env, caller, tableId, await* duel.submit<system, Rules.State, Rules.Action, Rules.View, Rules.Options>(env, caller, tableId, gen, step, action));
  };

  public shared query ({ caller }) func duel_table(tableId : TP.TableId, rev : Nat) : async Transport.TableResult<Rules.View> {
    duel.table(env, caller, tableId, rev);
  };
};

```

`src/backend/migrations/00000000_000000.mo`, which creates every stable
field. Caffeine's lint refuses a relative import in a migration, so the
rules' `State`, `Action` and `Options` (and every type they use) are
copied in. Engine types (`TP.Seat`, ...) may come from
`mo:duel-game-core`. Here for rock-paper-scissors:

```motoko
import AccessControl "mo:caffeineai-authorization/access-control";
import Transport "mo:duel-game-core/transport";
// import CanisterPlayers "mo:duel-game-core/canister_players"; // BOTS
// import Leaderboard "mo:duel-game-core/leaderboard"; // LEADERBOARD
import PT "mo:promtracker";

module {
  // lib/Rules.mo's State, Action and Options, copied: a migration
  // imports nothing from the project.
  type Variant = { #classic; #well };
  type Options = { variant : Variant; winsNeeded : Nat };
  type Action = { #rock; #paper; #scissors; #well };
  type Round = { p1Action : Action; p2Action : Action };
  type State = {
    p1Score : Nat;
    p2Score : Nat;
    lastRound : ?Round;
    variant : Variant;
    winsNeeded : Nat;
  };

  public type OldActor = {};
  public type NewActor = {
    accessControlState : AccessControl.AccessControlState;
    pt : PT.Tracker;
    duel : Transport.Duel<State, Action, Options>;
    // bots : CanisterPlayers.Store; // BOTS
    // leaderboard : Leaderboard.Board; // LEADERBOARD
  };

  public func migration(_ : OldActor) : NewActor {
    {
      accessControlState = AccessControl.initState();
      pt = PT.Tracker.new();
      duel = Transport.new<State, Action, Options>();
      // bots = CanisterPlayers.newStore(); // BOTS
      // leaderboard = Leaderboard.new(50, 1200); // LEADERBOARD
    };
  };
};

```

**Bot support and a leaderboard** only when the user asks
(`SKILL.md`'s "Two words recur" and Step 4). Bot support is every line
marked BOTS, in both files, and `src/backend/lib/BotIface.mo` from
`templates/BotIface.mo.template` with `__RULES_MODULE__` set to
`Rules`. A leaderboard is every line marked LEADERBOARD; with both, the
`CanisterPlayersActorMixin` line passes `?leaderboard`. Elo fits a game
where the players beat each other; `SKILL.md` Step 4 has the `#best`
rating for a score of one's own. Turned on after the first build, they
are a migration of their own (section 2).

### The frontend

The game's page does not use Caffeine's generated `backend.ts` or
`useActor`: the package's transport builds its own actor, signed by
the player's anonymous key (one per browser, kept in `localStorage`),
and the backend checks every call against it. The game needs no
sign-in; Caffeine's providers in `main.tsx` may stay or go.

`src/frontend/src/plugin.ts`: the `GamePlugin` of `SKILL.md` Step 6
(`templates/plugin.js.template`), typed as `GamePlugin<View, Options>`
from `@research-ag/duel-game-core/types.js`, with TypeScript mirrors of
the Candid: `nat` is `bigint`, `opt T` is `[] | [T]`, a variant is
`{ tag: payload }` with `null` for none. It must show the opponent's
most recent move, live and in the debrief, and implement `applyLocal`.

`src/frontend/src/duel.ts`, the wiring. The backend's id and host come
from `/env.json`, which Caffeine fills in for the draft and for the
live app:

```ts
import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import { resolveAnonymousIdentity } from "@research-ag/duel-game-core/anon-identity.js";
import { start } from "@research-ag/duel-game-core/app.js";
import {
  botPlayer,
  mountBotChallenge,
  mountLeaderboard,
} from "@research-ag/duel-game-core/bots.js";
import {
  type DuelActor,
  makeIdlFactory,
} from "@research-ag/duel-game-core/idl.js";
import { connectTransport } from "@research-ag/duel-game-core/transport.js";
import { plugin } from "./plugin";

export async function bootDuel() {
  const env = await (await fetch("/env.json")).json();
  const canisterId: string = env.backend_canister_id;
  const session = resolveAnonymousIdentity();
  const agent = await HttpAgent.create({
    host: env.backend_host,
    identity: session.identity,
  });
  const actor = Actor.createActor<DuelActor>(makeIdlFactory(plugin.idlTypes), {
    agent,
    canisterId,
  });
  const transport = connectTransport({ actor, gameIdlTypes: plugin.idlTypes });
  const client = start({ plugin, transport, session });
  const bots = mountBotChallenge({
    client,
    actor,
    plugin,
    play: botPlayer(agent, canisterId),
  });
  mountLeaderboard({ actor, plugin, sid: session.sid, onChallenge: bots.pick });
}
```

`mountBotChallenge` is "Add Bot" on the waiting screen and the "🤖
Bots" dialog, `mountLeaderboard` the 🏆 overlay. Without bot support,
drop `mountBotChallenge`, `botPlayer`, `onChallenge` and the `client`
they take (keep the `start(...)` call); without a leaderboard, drop
`mountLeaderboard`.

`src/frontend/src/App.tsx` renders, once, the elements `start()` and
the overlays fill (ids from `templates/index.html.template`), then
boots. `start()` owns everything inside them; React never re-renders
them:

```tsx
import { useEffect } from "react";
import { bootDuel } from "./duel";

let booted = false;

export default function App() {
  useEffect(() => {
    if (booted) return;
    booted = true;
    bootDuel().catch((e) => console.error("duel boot failed", e));
  }, []);

  return (
    <>
      <header>
        <div className="header-title">
          <h1>Game title</h1>
          <a
            className="more-games"
            href="https://games.ic0.info/"
            target="_blank"
            rel="noopener noreferrer"
          >
            More games ↗
          </a>
        </div>
        <div className="session">
          <button
            type="button"
            id="leaderboard-toggle"
            title="Leaderboard"
            aria-label="Leaderboard"
          >
            🏆
          </button>
          <span className="label">Player ID</span>
          <code id="sid">…</code>
          <button
            type="button"
            id="new-sid"
            title="Play as a different player in this tab"
          >
            new
          </button>
        </div>
      </header>
      <div id="leaderboard-panel" hidden>
        <div className="leaderboard-header">
          <button type="button" id="leaderboard-back" className="ghost">
            ← Back
          </button>
          <h2>🏆 Top players</h2>
        </div>
        <div id="leaderboard-body" className="leaderboard-list" />
      </div>
      <div id="bot-challenge-panel" hidden>
        <div className="bot-challenge-header">
          <button type="button" id="bot-challenge-back" className="ghost">
            ← Back
          </button>
          <h2>🤖 Bots</h2>
        </div>
        <div id="bot-challenge-body" className="bot-challenge-body" />
      </div>
      <p id="error" className="error" hidden />
      <main id="screen">
        <p className="muted">Connecting…</p>
      </main>
      <div id="bot-add-panel" hidden>
        <button type="button" id="bot-add-trigger" className="ghost">
          Add Bot 🤖 to the open seat
        </button>
      </div>
    </>
  );
}
```

Without a leaderboard, leave out `#leaderboard-toggle` and
`#leaderboard-panel`; without bot support, the two bot panels. In
`main.tsx`, import `@research-ag/duel-game-core/style.css` after
`index.css`, then the game's own stylesheet. The "More games" link
stays in any header of your own.

How far to depart from the default screens is the user's call:
`start({ screens })` replaces single screens, and a UI of its own (a
canvas, React components for every screen) binds `createDuelClient()`
as `references/rich-ui.md` describes. Biome fails on an unused
parameter: name it `_seat`.

### Trying it

There is no `mops test` or `play-test.mjs` here: Caffeine's build is
the check, then the user plays the draft in the preview. Ask them to
open it in two browsers (or a normal and a private window: a browser's
tabs share one player), create a table with "Invite a friend" in one,
open its invite link in the other, and play a whole game: every kind
of move, one illegal move (the backend's reason shows, nothing
crashes), the ending, a rematch, a leave. Their own move appears the
moment they click; the opponent's is marked when it lands. Draft
tables vanish when the draft is reinstalled.

### Going live and the dashboard

Only when the user asks: Caffeine's **Go live** (4 credits, $2, on
Caffeine's mainnet cloud). The live app has its own canisters and an
address `https://<name>.caffeine.xyz`. The user lists it on the Duel
dashboard (https://games.ic0.info/) with that address: the dashboard
finds the frontend canister behind it and, with no `/duel.json` there,
the backend in its `/env.json`.

## 2. Changing it later

Caffeine's `migrating-motoko-actors` skill holds: a migration the
deployed version already ran is never edited, and each new stable field
comes from a new migration in `src/backend/migrations/`.

**Turning on bot support or a leaderboard** adds their fields. The
lines marked BOTS or LEADERBOARD go into `main.mo` (and
`lib/BotIface.mo`), and the first migration stays as it is:

```motoko
import CanisterPlayers "mo:duel-game-core/canister_players";
import Leaderboard "mo:duel-game-core/leaderboard";

module {
  public type OldActor = {};
  public type NewActor = {
    bots : CanisterPlayers.Store;
    leaderboard : Leaderboard.Board;
  };

  public func migration(_ : OldActor) : NewActor {
    {
      bots = CanisterPlayers.newStore();
      leaderboard = Leaderboard.new(50, 1200);
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
and the leaderboard stay. Update `SEMANTICS` and the plugin in the same
change: every frontend and bot of the game is built from that text.

## 3. A bot for a game already deployed

A second Caffeine app of its own. `bot-for-existing-game.md` holds the
contract; on Caffeine its local copy of the game is replaced by tries
against the live game, and its controller check by an owner principal
written into the code. Caffeine controls the canisters, and its admin
role goes to whoever signs in first on each new canister, the live one
included, so neither binds the bot to its owner.

1. Learn the game from `https://<backend-id>.raw.icp0.io/semantics`
   (`frontend-for-existing-game.md`, step 2). Only a game with bot
   support seats a bot; the Duel dashboard's bot guide offers no other.
   When the game's page has no 🤖 list, or the first try (below) is
   rejected for a missing `join_table_as_canister`, stop and tell the
   user.
2. `src/backend/lib/GameTypes.mo`: `View`, `Action` and `Options`
   translated literally from the Candid in the semantics
   (`bot-for-existing-game.md`, step 3).
3. `src/backend/lib/BotLogic.mo`: `COMPLEXITIES` (the levels, `[]` for
   one) and `chooseMove`, as `canister-player-bots.md` describes, the
   simple shape unless the strategy needs memory.
4. `src/backend/mixins/BotApi.mo`:

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

5. `src/backend/main.mo`, which serves promtracker's system metrics at
   `GET /metrics` like every bot (the dashboard reads its balance
   there) and names the owner; the first migration is Caffeine's own,
   creating `accessControlState`:

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

6. The bot's page, on Caffeine's own frontend packages as they are
   (its generated `backend.ts`, `useActor` and sign-in; no
   duel-game-core package): the bot's name, its canister id
   (`backend_canister_id` from `/env.json`), and per level a link that
   starts a game against it on the game's own page:
   `<game address>/#new&b=` followed by
   `encodeURIComponent("<bot canister id>:<level>")`, as the client
   package's `linkFragment` writes it (`Default` for a bot without
   levels). The link works before the bot is registered. A sign-in with
   Internet Identity that shows the signed-in principal, and two
   buttons, **Register** (`register(<backend id>, <name>)`) and
   **Unregister**, which the bot accepts from `owner` alone.

**Trying it.** On the draft's page the links seat the draft bot at a
new table on the live game: play whole games at every level, the bot in
either seat (the link takes `&s=p2` for the player to take the second
seat), and leave when done. Never register the draft: its canister
goes back to Caffeine's pool. The user signs in on the draft's page and
gives you the principal it shows; that goes into `owner`.

**Going live.** Only when the user asks, and only with `owner` set:
Go live, then the user signs in on the live bot's page. When it shows
another principal than the draft did, put that one into `owner` and go
live again (an update of a live app costs nothing); until `owner`
matches, Register and Unregister refuse every caller, so nobody else can
claim the bot. Then the user presses Register, and the bot appears in
the game's 🤖 list and on its leaderboard. Caffeine picks the
canister's subnet; on another subnet than the game, each of the bot's
moves takes a few seconds (`canister-player-bots.md`, "Where the bot canister lives").
Later changes are Caffeine builds of the same app; press Register again
when the name or the levels change.

## 4. A frontend for a game already deployed

`frontend-for-existing-game.md`'s steps 2, 6 and 7 ("Against the live
backend") apply, with the backend id the user gives. Caffeine's own
backend stays as its template made it, unused, and `/env.json` names
that one. The game's backend goes into `src/frontend/public/duel.json`,
served as `/duel.json`, where the page reads it and the Duel dashboard
finds it before `/env.json`:

```json
{ "backend": "<backend id>" }
```

The page is section 1's frontend with two changes in `duel.ts`: the
backend comes from `/duel.json`, and the host is `https://icp0.io`:

```ts
const { backend } = await (await fetch("/duel.json")).json();
const agent = await HttpAgent.create({
  host: "https://icp0.io",
  identity: session.identity,
});
const actor = Actor.createActor<DuelActor>(makeIdlFactory(plugin.idlTypes), {
  agent,
  canisterId: backend,
});
```

`botPlayer(agent, backend)` takes the same id.

Without a shell there is no Candid to tell whether the game has bot
support or a leaderboard: mount both overlays and let their calls fail
quietly (`frontend-for-existing-game.md`, step 3). Test in the preview
against the live game, always on access-code tables. Go live is the user's;
they list the page on the dashboard by its address, as a game of its
own.

## 5. The CLI

With a shell and a paid Caffeine plan, an agent can build locally
(`npm install -g @caffeineai/cli`, `caffeine auth login`) and upload
with `caffeine preview --build`; Caffeine then builds the source
itself. Uploading needs an active subscription or a saved card, and
answers 403 without one. The project shape is Caffeine's `caffeine-app`
skill's, the code is this file's, and the local tools of the rest of
this skill work too: `mops test`, and `src/backend/dist/backend.wasm`
on a local network through icp-cli's `@dfinity/prebuilt` recipe for
`play-test.mjs`.
