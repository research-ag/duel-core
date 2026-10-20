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

3. Get the client library: npm package duel-game-core. If it is not on npm, use its source: the files under ${REPO}/tree/main/frontend/src (client.ts, transport.ts, idl.ts, types.ts, anon-identity.ts, identity.ts, render.ts, app.ts, ic-env.ts; each at ${RAW}/frontend/src/<file>) copied into the project as-is; they need only @icp-sdk/core and @icp-sdk/auth. Never rewrite the wire protocol yourself.

4. Wire the backend id into the frontend: use PUBLIC_CANISTER_ID:backend from the ic_env cookie when present, otherwise a backend id hardcoded in one constant (${backend}, or a staging copy's id while testing). When the page talks to a backend on mainnet, the agent host is https://icp0.io whatever the page's own address is.

5. Test by playing a whole game: both seats in two browser tabs, every kind of move, an illegal move (the backend's rejection text must show, not a crash), an ending, a rematch. Never test on the live backend when a private copy is available; the module store lookup https://api.hosty.live/modules/canister/${backend} (no account needed) gives the module's hash and its Candid.
   - If I have connected hosty.live's MCP server to you: make a staging copy of the game, its exact module in a free rented canister (hosty_rent_canister with kind "backend", then hosty_install_module with that hash and confirmReinstall; step 7 of the reference), and test the page against it, served from a local web server.
   - Else, if you can run icp-cli: download the module and run it as a private local copy next to the page (step 5 of the reference), and test against what icp deploy creates.
   - Otherwise: serve the page from a local web server, or this tool's preview, and test against the live backend, always on a table with an access code (never an open one), so real players are not disturbed.
   Before the build that goes online, point the hardcoded backend id back at ${backend}.

6. Put the page online only when I ask. If you worked on my computer, it goes online through hosty.live (https://hosty.live/), which hosts a built static page in a canister of my own, with no icp-cli: ${RAW}/skills/duel-game-core/references/going-live.md, section 2, has the procedure. The page learns its backend from the canister variable PUBLIC_CANISTER_ID:backend=${backend}, set with the upload. If I have connected hosty.live's MCP server to you, deploy through its hosty_* tools: build, zip the dist folder, hosty_prepare_zip_upload with pureAssets and canisterEnv { set: { "PUBLIC_CANISTER_ID:backend": "${backend}" } } (a deploy session I approve, unless the page already publishes it), run the curl it returns, hosty_wait_for_deployment, and give me the frontendUrl and the canister id. Otherwise finish by telling me, step by step, what to do next, and write the same steps into a README.md.

If the semantics page is missing, stop and tell me instead of guessing the rules.

Here is the frontend I want:
`;
}
