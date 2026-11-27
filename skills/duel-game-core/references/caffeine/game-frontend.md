# caffeine.ai: the game's page

The React page over the npm package `@research-ag/duel-game-core`,
after `references/caffeine/game.md`. It does not use Caffeine's
generated `backend.ts`, its types (`@/backend`) or `useActor`: the
package's transport builds its own actor, signed by the player's
anonymous key (one per browser, kept in `localStorage`), and the
backend checks every call against it.
The game needs no sign-in; Caffeine's providers in `main.tsx` may stay
or go.

`src/frontend/src/plugin.ts`, from `templates/plugin.js.template`,
typed as `GamePlugin<View, Options>` from
`@research-ag/duel-game-core/types.js`, with TypeScript mirrors of the
Candid declared in `plugin.ts` itself (`nat` is `bigint`; `opt T` is
`[] | [T]`, so the last round is `view.lastRound[0]`; a variant is
`{ tag: payload }` with `null` for none; a tuple is an array). The
plugin receives raw Candid values. Caffeine's generated types make an
`opt` field optional and a variant an enum: `view.lastRound ?? null`
type-checks with them and crashes on `[]`.

- `idlTypes({ IDL })`: exactly the Candid of `Action`, `View` and
  `Options`, nothing else; `Options` is `IDL.Record({})` for none. One
  wrong field and no status decodes.
- `seatLabel(seat)`.
- `renderBoard(view, mySeat, oppSeat)`: an HTML string for a live game
  and for the debrief, with `esc()` around any text. It shows the
  opponent's most recent move, live and in the debrief: both picks of
  the last round, a highlighted cell.
- `renderActions(view, mySeat)`: one `<button>` per action through
  `actionAttr()`, disabled by a `legal()` mirror of the rules. It is
  cosmetic: the backend decides.
- `applyLocal(view, mySeat, move)`: the view with the player's own move
  applied, drawn the moment it is sent; for `#simultaneous` usually the
  view unchanged. `null` only for an outcome it cannot know.
- With options, `optionChoices()` (the first is the default, each
  `options` the typed value `duel_create_table` takes, `Nat` fields as
  `bigint`) and `formatOptions(options)`, the lobby's label. With a
  `#best` leaderboard, `formatScore(score)`.

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
the overlays fill, then boots. `start()` owns everything inside them;
React never re-renders them:

```tsx
import { useEffect, useState } from "react";
import { bootDuel } from "./duel";

let booted = false;

export default function App() {
  const [bootError, setBootError] = useState<string | null>(null);
  const boot = () => {
    if (booted) return;
    booted = true;
    setBootError(null);
    bootDuel().catch((e) => {
      console.error("duel boot failed", e);
      booted = false; // a retry boots again
      setBootError(e instanceof Error ? e.message : String(e));
    });
  };
  useEffect(boot, []);

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
        {bootError ? (
          <p role="alert">
            Could not connect to the game: {bootError}{" "}
            <button type="button" onClick={boot}>
              Retry
            </button>
          </p>
        ) : (
          <p className="muted">Connecting…</p>
        )}
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
stays in any header of your own. Biome fails on an unused parameter:
name it `_seat`.

How far to depart from the default screens is the user's call:
`start({ screens })` replaces single screens (`lobby`, `debrief`, ...)
with `view -> HTML` functions of the game's own, and a replaced
debrief still draws the final board. A UI that does not fit buttons
and HTML (a canvas, React components for every screen) binds
`createDuelClient()` instead, as `references/rich-ui.md` describes.
