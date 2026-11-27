# caffeine.ai: a frontend for a game already deployed

A page of its own for a duel-game-core game someone else runs: it plays
that game's live backend, so its players meet the original's at the
same tables. Every file of this skill is at
`https://api.hosty.live/skills/duel-game-core/<path>`;
this one, `references/caffeine/game-frontend.md` (the page, written for
a game's own frontend) and `templates/plugin.js.template` are all it
takes. Caffeine's own backend stays as its template made it, unused.

**The game.** `https://<backend-id>.raw.icp0.io/semantics` is the whole
specification: `MODE` (`simultaneous`: both seats act every round;
`turnBased`: the seat on turn acts, possibly several actions per turn),
`SEATS`, `OPTIONS`, the exact Candid of `View` (headed `VIEW`, or
`STATE` in older games) and `Action` with every field explained,
`RULES`, `ENDINGS` and `CLIENT NOTES`. A 404 lists the paths the
backend serves; fetch any the semantics names. Without it there is
nothing to build from: stop and tell the user.

**The packages** are the page's half of a game's:
`pnpm add @research-ag/duel-game-core` in `src/frontend/`, and
`@icp-sdk/core` at `^6.1.1` in both `package.json` files (Caffeine's
template pins `^5.3.0`, and with it `tsc` fails); no mops package.

**The backend id** goes into `src/frontend/public/duel.json`, served as
`/duel.json`, where the page reads it and the Duel dashboard finds it
before `/env.json` (which names Caffeine's unused backend):

```json
{ "backend": "<backend id>" }
```

**The page** is `game-frontend.md`'s, with the semantics standing in
for the rules module and two changes in `duel.ts`: the backend comes
from `/duel.json`, and the host is `https://icp0.io`:

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

`botPlayer(agent, backend)` takes the same id. In the plugin,
`idlTypes` translates `VIEW` (or `STATE`), `ACTION` and `OPTIONS`
literally (`OPTIONS` `none` is `IDL.Record({})`; `nat` is `IDL.Nat`,
`opt T` `IDL.Opt(T)`, `vec T` `IDL.Vec(T)`, a variant case without
payload `IDL.Null`); `legal()` and `applyLocal` mirror `RULES`, and the
opponent's last move shows the way `CLIENT NOTES` says it can be found.
Without a shell there is no Candid to tell whether the game has bot
support or a leaderboard: mount both overlays and let their calls fail
quietly.

How far to depart from the default screens is the user's description's
call. Whatever the UI, a player can still create a table, join one,
play, see the result, and rematch or leave, and the header keeps the
"More games" link.

**Trying it** plays the real game. Ask the user to open the preview in
two browsers (or a normal and a private window: a browser's tabs share
one player) and play both seats: create every table with "Invite a
friend" (an access code), never an open one, so real players are not
drawn in; open its invite link in the other browser; play a whole game
with every kind of move and one illegal move (the backend's reason
shows, nothing crashes), rematch once, leave once. A status that never
arrives, or a decode error in the console, is an `idlTypes` mismatch.
Keep the testing short.

**Going live** is the user's: Caffeine's Go live (4 credits, $2). They
list the page on the Duel dashboard (https://games.ic0.info/) by its
address, as a game of its own.
