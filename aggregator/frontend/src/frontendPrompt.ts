// The prompt a player hands to an AI builder (caffeine.ai or a coding
// agent on their own computer) to get their own frontend for a listed
// game. It adapts to what the builder can run; the procedure behind it is
// skills/duel-game-core/references/frontend-for-existing-game.md. Keep
// the two in step.

import type { GameView } from "./types";
import { gameUrl } from "./types";

const REPO = "https://github.com/research-ag/duel-core";
const RAW = "https://raw.githubusercontent.com/research-ag/duel-core/main";

/// `game = undefined` leaves placeholders for the reader to fill in.
export function frontendPrompt(game: GameView | undefined): string {
  const title = game ? `"${game.title}"` : "<game title>";
  const url = game ? gameUrl(game) : "https://<the game's address>";
  return `Build me my own frontend for an existing two-player game on the Internet Computer.

The game is ${title}, playable at ${url}
It runs on the duel-game-core framework (${REPO}). Its backend canister is already live and is not mine: do not build or change any backend. Build only a browser frontend that talks to that backend, so players on my frontend meet players on the original at the same tables. If this tool gives you a backend of its own anyway, leave it empty and unused.

Work in this order.

1. Find the game's backend canister id. The game's page publishes it in one of two places: the ic_env cookie that ${url} sets contains PUBLIC_CANISTER_ID:backend (with a shell: curl -sI ${url}/ | grep -o 'ID%3Abackend%3D[a-z0-9%D]*cai' | head -1 | sed 's/.*%3D//; s/%2D/-/g'); if the cookie has no such entry, look for <meta name="duel-backend" content="..."> in the page's HTML. Ask me for it only if both are missing. Below, <BACKEND> stands for that id (it looks like xxxxx-xxxxx-xxxxx-xxxxx-cai); replace it everywhere, it is never a literal value.

2. Learn the game from https://<BACKEND>.raw.icp0.io/semantics — plain text with the rules, who moves when, and the exact Candid types of State and Action. This is the whole specification; Action appears nowhere else. Fetch any other path it mentions.

3. Read how a frontend talks to the backend: ${RAW}/frontend/README.md (the GamePlugin contract, the headless client, the transport) and the step "Write the frontend GamePlugin" in ${RAW}/skills/duel-game-core/SKILL.md. The full procedure for exactly this task is ${RAW}/skills/duel-game-core/references/frontend-for-existing-game.md — read it and follow it.

4. Get the client library: npm package duel-game-core. If it is not on npm, use its source: the files under ${REPO}/tree/main/frontend/src (client.ts, transport.ts, idl.ts, types.ts, anon-identity.ts, render.ts, app.ts, ic-env.ts; each at ${RAW}/frontend/src/<file>) copied into the project as-is; they need only @icp-sdk/core and @icp-sdk/auth. Never rewrite the wire protocol yourself.

5. Wire the backend id into the frontend: use PUBLIC_CANISTER_ID:backend from the ic_env cookie when present, otherwise <BACKEND> hardcoded. When the page talks to the live backend, the agent host is https://icp0.io whatever the page's own address is. Put <meta name="duel-backend" content="<BACKEND>"> (the real id, not the placeholder) in index.html: a page hosted elsewhere has no such cookie, and that tag is how the dashboard finds the game behind my page.

6. Test by playing a whole game: both seats in two browser tabs, every kind of move, an illegal move (the backend's rejection text must show, not a crash), an ending, a rematch.
   - If you can run icp-cli: the backend is pullable. Download its wasm (curl -s https://<BACKEND>.raw.icp0.io/wasm -o backend.wasm; step 4 of the reference has the hash check against the canister's module_hash), run it as a private copy on a local network, and test against that; never touch the live backend while developing.
   - If you cannot: serve the page from a local web server, or this tool's preview, and test against the live backend, always on a table with an access code (never an open one), so real players are not disturbed.

7. Do not put anything online yourself. Finish by telling me, step by step, what to do next: where the page is now, how to take it live from here, and how to find the live page's address and its canister id afterwards. If you worked on my computer, also write those steps into a README.md, with these commands, <BACKEND> filled in:
     icp canister link backend <BACKEND> -e ic
     icp deploy frontend -e ic
     icp canister status frontend -e ic -i

If the semantics page is missing, stop and tell me instead of guessing the rules.

Here is the frontend I want:
`;
}
