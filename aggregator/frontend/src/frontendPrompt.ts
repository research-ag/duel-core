// The prompt a player hands to an AI builder (caffeine.ai or a coding
// agent on their own computer) to get their own frontend for a listed
// game. It adapts to what the builder can run; the procedure behind it is
// skills/duel-game-core/references/frontend-for-existing-game.md. Keep
// the two in step.

import type { Target } from "./types";
import { gameUrl } from "./types";

export const REPO = "https://github.com/research-ag/duel-core";
export const RAW =
  "https://raw.githubusercontent.com/research-ag/duel-core/main";

export function frontendPrompt({ game, backend }: Target): string {
  const url = gameUrl(game);
  return `Build me my own frontend for an existing two-player game on the Internet Computer.

The game is "${game.title}", playable at ${url}. Its backend canister is ${backend}. It runs on the duel-game-core framework (${REPO}). The backend is already live and is not mine: do not build or change any backend. Build only a browser frontend that talks to that backend, so players on my frontend meet players on the original at the same tables. If this tool gives you a backend of its own anyway, leave it empty and unused.

Work in this order.

1. Learn the game from https://${backend}.raw.icp0.io/semantics — plain text with the rules, who moves when, and the exact Candid types of State and Action. This is the whole specification; Action appears nowhere else. Fetch any other path it mentions.

2. Read how a frontend talks to the backend: ${RAW}/frontend/README.md (the GamePlugin contract, the headless client, the transport) and the step "Write the frontend GamePlugin" in ${RAW}/skills/duel-game-core/SKILL.md. The full procedure for exactly this task is ${RAW}/skills/duel-game-core/references/frontend-for-existing-game.md — read it and follow it.

3. Get the client library: npm package duel-game-core. If it is not on npm, use its source: the files under ${REPO}/tree/main/frontend/src (client.ts, transport.ts, idl.ts, types.ts, anon-identity.ts, render.ts, app.ts, ic-env.ts; each at ${RAW}/frontend/src/<file>) copied into the project as-is; they need only @icp-sdk/core and @icp-sdk/auth. Never rewrite the wire protocol yourself.

4. Wire the backend id into the frontend: use PUBLIC_CANISTER_ID:backend from the ic_env cookie when present, otherwise ${backend} hardcoded. When the page talks to the live backend, the agent host is https://icp0.io whatever the page's own address is.

5. Test by playing a whole game: both seats in two browser tabs, every kind of move, an illegal move (the backend's rejection text must show, not a crash), an ending, a rematch.
   - If you can run icp-cli: the backend serves its own wasm. Download it (curl -s https://${backend}.raw.icp0.io/wasm -o backend.wasm), check its SHA-256 against the module_hash from icp canister status ${backend} -n ic -p --json, declare it as a canister named backend with the @dfinity/prebuilt recipe (path + that sha256), run icp canister link backend ${backend} -e ic once (steps 4 and 5 of the reference), and test against the private local copy icp deploy creates; never touch the live backend while developing.
   - If you cannot: serve the page from a local web server, or this tool's preview, and test against the live backend, always on a table with an access code (never an open one), so real players are not disturbed.

6. Do not put anything online yourself. Finish by telling me, step by step, what to do next: where the page is now, how to take it live from here, and how to find the live page's address and its canister id afterwards. If you worked on my computer, also write those steps into a README.md, with these commands:
     icp canister link backend ${backend} -e ic --force
     icp deploy frontend -e ic
     icp canister status frontend -e ic -i

If the semantics page is missing, stop and tell me instead of guessing the rules.

Here is the frontend I want:
`;
}
