// The prompt a player hands to an AI builder to get their own frontend
// for a listed game, one per way: caffeine.ai (a builder without a
// shell), hosty.live (a Claude Code cloud session or an agent on their
// computer), or everything their own (icp-cli on their computer). The
// procedure behind it is
// skills/duel-game-core/references/frontend-for-existing-game.md. Keep
// the two in step.

import { OWN_RULES, SESSION_RULES } from "./cloudSession";
import type { Way } from "./cloudSession";
import type { Target } from "./types";
import { gameUrl } from "./types";

export const REPO = "https://github.com/research-ag/duel-core";
export const RAW =
  "https://raw.githubusercontent.com/research-ag/duel-core/main";

export function frontendPrompt({ game, backend }: Target, way: Way): string {
  const url = gameUrl(game);
  const env = `canisterEnv { set: { "PUBLIC_CANISTER_ID:backend": "${backend}" } }`;
  const ref = `${RAW}/skills/duel-game-core/references`;

  const intro = `Build me my own frontend for an existing two-player game on the Internet Computer.

The game is "${game.title}", playable at ${url}. Its backend canister is ${backend}. It runs on the duel-game-core framework (${REPO}). The backend is already live and is not mine: do not build or change any backend. Build only a browser frontend that talks to that backend, so players on my frontend meet players on the original at the same tables.${way === "caffeine" ? " If this tool gives you a backend of its own, leave it empty and unused." : ""}`;

  const rules =
    way === "hosty"
      ? `\n\n${SESSION_RULES}`
      : way === "own"
        ? `\n\n${OWN_RULES}`
        : "";

  const learn = `Work in this order.

1. Learn the game from https://${backend}.raw.icp0.io/semantics — plain text with the rules, who moves when, and the exact Candid types of State and Action. This is the whole specification; Action appears nowhere else. Fetch any other path it mentions.

2. Read how a frontend talks to the backend: ${RAW}/frontend/README.md (the GamePlugin contract, the headless client, the transport) and the step "Write the frontend GamePlugin" in ${RAW}/skills/duel-game-core/SKILL.md. The full procedure for exactly this task is ${ref}/frontend-for-existing-game.md — read it and follow it.

3. Get the client library: the npm package @research-ag/duel-game-core. Never rewrite the wire protocol yourself.

4. Wire the backend id into the frontend: use PUBLIC_CANISTER_ID:backend from the ic_env cookie when present, otherwise a backend id hardcoded in one constant (${backend}). When the page talks to a backend on mainnet, the agent host is https://icp0.io whatever the page's own address is.

5. Test by playing whole games: both seats, every kind of move, an illegal move (the backend's rejection text must show, not a crash), an ending, a rematch.`;

  const localCopy = `Download the game's module and run it as a private local copy next to the page (step 5 of the reference; the module store lookup https://api.hosty.live/modules/canister/${backend} needs no account; if it answers found: false, tell me its hint and build from the semantics alone, without the local copy), and play it headlessly with the skill's ${RAW}/skills/duel-game-core/templates/play-test.mjs.template against what icp deploy creates.`;

  const test =
    way === "caffeine"
      ? `Test in your preview against the live backend, always on a table with an access code (never an open one), so real players are not disturbed.`
      : way === "hosty"
        ? `${localCopy}
   Then let me look. In a cloud session, put the page into a free hosty.live cloud engine canister (hosty_whoami for a free cloudEngine slot, hosty_create_canister with network "cloud" and kind "frontend", then hosty_prepare_zip_upload with pureAssets and ${env}; step 7 of the reference), and give me its address: I play it in two browser tabs, on tables with an access code only. On my computer, give me the local address icp deploy printed.`
        : `${localCopy}
   Then give me the local address icp deploy printed: I play it in two browser tabs.`;

  const stop =
    way === "caffeine"
      ? `6. Stop once the page works and I'm happy with it. Do not put it online until I ask.

7. When I ask, I put it online with your own "Go live" action: tell me how, and then tell me the live page's address and its frontend canister id.`
      : way === "hosty"
        ? `6. Stop once the page works and I'm happy with it. Do not put it live and do not buy any canister for it: the free cloud engine canisters in step 5 are the only ones you take without asking. Write into README.md how to build the page and zip the dist folder for upload, and the backend id it needs, PUBLIC_CANISTER_ID:backend=${backend}.

7. Later, when I ask you to put the page live: it goes live on mainnet through hosty.live (https://hosty.live/), into a canister of my own; a cloud engine page never counts as live, and the Duel dashboard refuses it: ${ref}/going-live.md, section 3, has the procedure. In a deploy session I approve: hosty_create_canister with kind "frontend" and alias "<game name> frontend" (a mainnet canister, 0.84 TC from my balance) unless I name a canister, build, zip the dist folder, hosty_prepare_zip_upload with pureAssets and ${env}, run the curl it returns, hosty_wait_for_deployment, and give me the frontendUrl and the canister id. If the hosty_* tools are missing, tell me the steps instead.`
        : `6. Stop once the page works and I'm happy with it. Do not put it online until I ask. Write into README.md how to build and deploy the page.

7. Later, when I ask you to put the page online: walk me through ${ref}/going-live.md, section 4. I create my icp identity and buy the cycles (at the time of writing 2T for the page's canister, a few dollars). Then icp deploy frontend -e ic, after the reference's icp canister link backend ${backend} -e ic, which gives the page the backend's id. Give me the page's address and its canister id.`;

  return `${intro}${rules}

${learn}
   ${test}

${stop}

Whatever the design, the page's header keeps a "More games" link to the Duel Dashboard, https://games.ic0.info/, opening in a new tab.

If the semantics page is missing, stop and tell me instead of guessing the rules.

Here is the frontend I want:
`;
}
