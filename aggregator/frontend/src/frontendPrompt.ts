// The prompt a player hands to an AI builder (a Claude Code cloud
// session, caffeine.ai, or a coding agent on their own computer) to get
// their own frontend for a listed game. It adapts to what the builder can
// run; the procedure behind it is
// skills/duel-game-core/references/frontend-for-existing-game.md. Keep
// the two in step.

import { SESSION_RULES } from "./cloudSession";
import type { Target } from "./types";
import { gameUrl } from "./types";

export const REPO = "https://github.com/research-ag/duel-core";
export const RAW =
  "https://raw.githubusercontent.com/research-ag/duel-core/main";

export function frontendPrompt({ game, backend }: Target): string {
  const url = gameUrl(game);
  return `Build me my own frontend for an existing two-player game on the Internet Computer.

The game is "${game.title}", playable at ${url}. Its backend canister is ${backend}. It runs on the duel-game-core framework (${REPO}). The backend is already live and is not mine: do not build or change any backend. Build only a browser frontend that talks to that backend, so players on my frontend meet players on the original at the same tables. If this tool gives you a backend of its own anyway, leave it empty and unused.

${SESSION_RULES}

Work in this order.

1. Learn the game from https://${backend}.raw.icp0.io/semantics — plain text with the rules, who moves when, and the exact Candid types of State and Action. This is the whole specification; Action appears nowhere else. Fetch any other path it mentions.

2. Read how a frontend talks to the backend: ${RAW}/frontend/README.md (the GamePlugin contract, the headless client, the transport) and the step "Write the frontend GamePlugin" in ${RAW}/skills/duel-game-core/SKILL.md. The full procedure for exactly this task is ${RAW}/skills/duel-game-core/references/frontend-for-existing-game.md — read it and follow it.

3. Get the client library: the npm package @research-ag/duel-game-core. Never rewrite the wire protocol yourself.

4. Wire the backend id into the frontend: use PUBLIC_CANISTER_ID:backend from the ic_env cookie when present, otherwise a backend id hardcoded in one constant (${backend}, or a staging copy's id while testing). When the page talks to a backend on mainnet, the agent host is https://icp0.io whatever the page's own address is.

5. Test by playing whole games: both seats, every kind of move, an illegal move (the backend's rejection text must show, not a crash), an ending, a rematch. The module store lookup https://api.hosty.live/modules/canister/${backend} (no account needed) gives the module's hash and its Candid.
   - If you can run icp-cli (a Claude Code cloud session, or my computer): download the module and run it as a private local copy next to the page (step 5 of the reference), and play it headlessly with the skill's ${RAW}/skills/duel-game-core/templates/play-test.mjs.template against what icp deploy creates.
   - Then let me look. In a cloud session, put the page into a free rented hosty.live canister (hosty_rent_canister, then hosty_prepare_zip_upload with pureAssets; step 7 of the reference), playing the live backend through the hardcoded constant, and give me its address: I play it in two browser tabs, on tables with an access code only. On my computer, give me the local address icp deploy printed; without icp-cli there but with hosty.live's MCP server connected, make a staging copy of the game in a rented backend canister instead (hosty_install_module with that hash, step 7 of the reference) and serve the page from a local web server.
   - In a builder without a shell: test in its preview against the live backend, always on a table with an access code (never an open one), so real players are not disturbed.
   Before the build that goes online, point the hardcoded backend id back at ${backend}.

6. Stop once the page works and I'm happy with it. Do not put it online and do not create any canister for it: the rental in step 5 is the only canister you take without asking. Write into README.md how to build the page and zip the dist folder for upload, and the backend id it needs, PUBLIC_CANISTER_ID:backend=${backend}.

7. Later, when I ask you to put the page online: it goes online through hosty.live (https://hosty.live/), into a canister of my own: ${RAW}/skills/duel-game-core/references/going-live.md, section 3, has the procedure. With hosty.live's MCP server connected, in a deploy session I approve: hosty_create_canister with kind "frontend" (0.84 TC from my balance) unless I name a canister, build, zip the dist folder, hosty_prepare_zip_upload with pureAssets and canisterEnv { set: { "PUBLIC_CANISTER_ID:backend": "${backend}" } }, run the curl it returns, hosty_wait_for_deployment, and give me the frontendUrl and the canister id. If you cannot deploy for me (no hosty.live MCP server, or a builder with its own "Go live" action), tell me the steps instead.

Whatever the design, the page's header keeps a "More games" link to the Duel Dashboard, https://games.ic0.info/, opening in a new tab.

If the semantics page is missing, stop and tell me instead of guessing the rules.

Here is the frontend I want:
`;
}
