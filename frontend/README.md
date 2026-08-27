# duel-game-core

Rules-agnostic browser client for any canister built on the
[`duel-game-core`](../backend/README.md) Motoko engine. It implements every screen
that's the same for every game — lobby, staging, rematch offer, busy
countdown, debrief chrome, the `#endedByOther` notice — plus session
identity and polling, so a new game only has to supply a small
**GamePlugin**: the two Candid types, seat labels, and how to draw the
board and action buttons.

No build step is required — every file is plain ESM, dependency-free
except for what you pass in yourself (see below).

```
npm install duel-game-core
```

(Unpublished: reference it as a local/git path dependency until it ships
to npm.)

## The GamePlugin contract

```js
const plugin = {
  // Candid types for your game's move and state, given the same `{ IDL }`
  // the Candid tooling passes to an idlFactory.
  idlTypes({ IDL }) {
    return {
      Action: IDL.Variant({ /* ... */ }),
      State: IDL.Record({ /* ... */ }),
    };
  },

  // Human label for a seat tag ("p1" | "p2").
  seatLabel(seat) {
    return { p1: "White", p2: "Black" }[seat];
  },

  // Full board markup for one game state, from `mySeat`'s point of view.
  // Called for both the live game and a finished debrief's final state —
  // render whatever makes sense in each case from `gameState` alone.
  renderBoard(gameState, mySeat, oppSeat) {
    return `<pre>${JSON.stringify(gameState, null, 2)}</pre>`;
  },

  // Action buttons for `mySeat`, only ever called while it's legal for
  // them to move (the framework hides this once they've submitted).
  // Each button must carry its move value via the `actionAttr` helper
  // from render.js so the framework's click handling can submit it as-is
  // — this works for any Action shape, not just a bare nullary variant.
  renderActions(gameState, mySeat) {
    return `<button ${actionAttr({ pass: null })}>Pass</button>`;
  },
};
```

Only `renderBoard` and `renderActions` return markup for *your* game;
everything else (turn counter, "opponent is deciding" / "locked in"
messages, verdict banner, rematch/leave/forfeit buttons) is handled by
`render.js`'s generic chrome around them.

## Wiring it up

You build the `actor` — this package doesn't import `@dfinity/agent` or
hardcode a CDN, so you're free to load it however you like (esm.sh, a
bundled dependency, a mock for tests):

```js
import { Actor, HttpAgent } from "@dfinity/agent"; // however you prefer to load it
import { makeIdlFactory } from "duel-game-core/idl.js";
import { start } from "duel-game-core/app.js";
import { plugin } from "./my-game-plugin.js";

const idlFactory = makeIdlFactory(plugin.idlTypes);
const agent = await HttpAgent.create({ host });
const actor = Actor.createActor(idlFactory, { agent, canisterId });

start({ actor, plugin });
```

`start()` expects a handful of element ids in your page (all optional,
shown here with their defaults):

```html
<span id="sid"></span>
<button id="new-sid">new</button>
<p id="error" hidden></p>
<main id="screen"></main>
<link rel="stylesheet" href="node_modules/duel-game-core/style.css" />
```

- `sid` — filled with the current session id (per-tab identity; a second
  browser tab is automatically the second player).
- `new-sid` — optional button to start a fresh session id.
- `screen` — where `renderView`'s output is written; also where clicks
  are delegated from, so re-rendering never leaks event listeners.
- `error` — where a transient rejection (`errText`) is shown.

Override any of the ids: `start({ actor, plugin, sidElId: "...", ... })`.

## Optional: `ic-env.js`

If you're deploying to the Internet Computer via an asset canister,
`readIcEnv()` and `deriveHost()` extract the canister id and the right
`HttpAgent` host from the `ic_env` cookie the asset canister sets and
from `window.location`. They're generic IC-hosting helpers, unrelated to
any game's rules — use them when building `agent`/`actor`, or don't;
`start()` never calls them itself.

## Modules

| Module        | Exports                                   |
| ------------- | ------------------------------------------ |
| `idl.js`      | `makeIdlFactory(buildGameTypes)`           |
| `render.js`   | `renderView(view, plugin)`, `errText(err)`, `actionAttr(value)`, `tag`, `val`, `esc` |
| `app.js`      | `start({ actor, plugin, ...elIds })`       |
| `ic-env.js`   | `readIcEnv()`, `deriveHost()` (optional)   |
| `style.css`   | generic layout primitives                  |

See [`../backend/README.md`](../backend/README.md) for the matching
backend `Spec` contract.
