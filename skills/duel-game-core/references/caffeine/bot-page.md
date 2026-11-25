# caffeine.ai: the bot's page, going live, trying it

The bot's page and its way to the game's list of bots, after
`references/caffeine/bot.md`.

**The page**, on Caffeine's own frontend packages as they are (its
generated `backend.ts`, `useActor` and sign-in; no duel-game-core
package):

- The bot's name and its canister id (`backend_canister_id` from
  `/env.json`).
- A try-out form: the invite link of an access-code table on the game,
  the seat the bot takes (`p1` or `p2`, the one the table's creator
  left free) and the level. It reads the table and the code from the
  link with `readInvite` below, calls the bot's own `play` with the
  game's backend id, the table, the seat, `?<code>` and the level, and
  shows the answer; `#seatTaken` means the other seat.
- Per level, a link that starts a game against the bot on the game's
  own page, for players once the bot is listed: `playLink` below, with
  the bot's own canister id and the level exactly as `COMPLEXITIES`
  spells it (`Default` for a bot without levels). It opens a table
  anyone can see before the bot sits down.
- A sign-in with Internet Identity that shows the signed-in principal,
  and two buttons, **Register** (`register(<backend id>, <name>)`) and
  **Unregister**, which the bot accepts from `owner` alone.

Both links are the game's address (the one the user gave) with a
fragment, never a path or a query: an invite link is
`https://<game>/#t=37&c=fy5gupaw` (table 37, code `fy5gupaw`), and a
level's link is `https://<game>/#new&b=` followed by the encoded
`<bot canister id>:<level>`. `src/frontend/src/links.ts`:

```ts
export function readInvite(link: string) {
  const fragment = link.split("#")[1];
  if (fragment === undefined) return null;
  const p = new URLSearchParams(fragment);
  const t = p.get("t");
  if (t === null || !/^\d+$/.test(t)) return null;
  return { tableId: BigInt(t), code: p.get("c") || null };
}

export function playLink(game: string, botId: string, level: string) {
  return `${game.replace(/\/+$/, "")}/#new&b=${encodeURIComponent(`${botId}:${level}`)}`;
}
```

**Going live, then trying it.** The draft's preview shows the page, but
the draft bot never plays the live game: its canister goes back to
Caffeine's pool while every game it played stays on the game's
leaderboard under its id, and its sign-in shows another principal than
the live app's (Caffeine writes an app's Internet Identity origin files
only at Go live). Caffeine's own browser check cannot sign in with
Internet Identity either: plan its checks on the page signed out (the
name and canister id, a link `readInvite` refuses, Register and
Unregister disabled). So the bot is tried as its live canister, before
it is registered:

1. When the user asks: Go live (4 credits, $2), with `owner` still
   `aaaaa-aa`.
2. The user signs in on the live bot's page and gives you the principal
   it shows. Put it into `owner` and go live again (going live again
   costs no credits). Until then Register and Unregister refuse every
   caller, so nobody else can claim the bot.
3. Through the try-out form, never the links: on the game's own page
   the user opens a table with "Invite a friend", copies its invite link
   and pastes it into the form, which seats the bot there. Play whole
   games at every level, the bot in either seat, and leave when done.
   Each fix is another Go live.
4. The user presses Register, and the bot appears in the game's 🤖 list
   and on its leaderboard, rated per level.

Caffeine picks the canister's subnet. The game asks the bot once per
move, so on another subnet than the game's each move takes a few
seconds. Later changes are builds of the same app; press Register
again when the name or the levels change.
