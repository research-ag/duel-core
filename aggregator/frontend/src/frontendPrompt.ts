// The prompt a player hands to an AI builder to get their own frontend
// for a listed game, one per way: caffeine.ai (a builder without a
// shell), hosty.live (a Claude Code cloud session or an agent on their
// computer), or everything their own (icp-cli on their computer). The
// procedure behind it is
// skills/duel-game-core/references/frontend-for-existing-game.md. Keep
// the two in step.

import { loadSkill, OWN_RULES } from "./cloudSession";
import type { Way } from "./cloudSession";
import type { Target } from "./types";
import { gameUrl } from "./types";

export const REPO = "https://github.com/research-ag/duel-core";
export const RAW =
  "https://raw.githubusercontent.com/research-ag/duel-core/main";

/// The skill's procedure for caffeine.ai, which Caffeine's AI reads over
/// the web (it has no hosty.live connector).
export const CAFFEINE_REF = `${RAW}/skills/duel-game-core/references/caffeine.md`;

/// How every caffeine.ai prompt hands the work to `CAFFEINE_REF`.
export function caffeineReference(section: string): string {
  return `Read ${CAFFEINE_REF}, section ${section}, and follow it: it is the procedure for exactly this task in caffeine.ai, with the code it needs. Read the other files of the same skill it names, at the same address with their own path. If you cannot open these addresses, stop and tell me: do not guess the framework.`;
}

const CLOSING = `Here is the frontend I want:
`;

export function frontendPrompt({ game, backend }: Target, way: Way): string {
  const url = gameUrl(game);
  const ref = `${RAW}/skills/duel-game-core/references`;

  const intro = `Build me my own frontend for an existing two-player game on the Internet Computer.

The game is "${game.title}", playable at ${url}. Its backend canister is ${backend}. It runs on the duel-game-core framework (${REPO}). The backend is already live and is not mine: do not build or change any backend. Build only a browser frontend that talks to that backend, so players on my frontend meet players on the original at the same tables.${way === "caffeine" ? " If this tool gives you a backend of its own, leave it empty and unused." : ""}`;

  if (way === "hosty")
    return `${intro}

${loadSkill("references/frontend-for-existing-game.md")} Put the page live on mainnet only when I ask.

${CLOSING}`;

  const rules = way === "own" ? `\n\n${OWN_RULES}` : "";

  const learn = `Work in this order.

1. Learn the game from https://${backend}.raw.icp0.io/semantics — plain text with the rules, who moves when, and the exact Candid types of View (what a seat sees, headed VIEW, or STATE in older games), Action and Options. This is the whole specification; Action appears nowhere else. Fetch any other path it mentions.

2. Read how a frontend talks to the backend: ${RAW}/frontend/README.md (the GamePlugin contract, the headless client, the transport) and the step "Write the frontend GamePlugin" in ${RAW}/skills/duel-game-core/SKILL.md. The full procedure for exactly this task is ${ref}/frontend-for-existing-game.md — read it and follow it.${way === "caffeine" ? ` ${caffeineReference(`4, "A frontend for a game already deployed"`)}` : ""}

3. Get the client library: the npm package @research-ag/duel-game-core${way === "caffeine" ? ", with @icp-sdk/core at ^6.1.1 in both package.json files" : ""}. Never rewrite the wire protocol yourself.

4. Wire the backend id into the frontend: ${way === "caffeine" ? `put it into public/duel.json as { "backend": "${backend}" }, which the page reads and the Duel dashboard finds before this app's own /env.json` : `use PUBLIC_CANISTER_ID:backend from the ic_env cookie when present, otherwise a backend id hardcoded in one constant (${backend})`}. When the page talks to a backend on mainnet, the agent host is https://icp0.io whatever the page's own address is.

5. Test by playing whole games: both seats, every kind of move, an illegal move (the backend's rejection text must show, not a crash), an ending, a rematch.`;

  const localCopy = `Download the game's module and run it as a private local copy next to the page (step 5 of the reference; the module store lookup https://api.hosty.live/modules/canister/${backend} needs no account), and play it headlessly with the skill's ${RAW}/skills/duel-game-core/templates/play-test.mjs.template against what icp deploy creates. If the lookup answers found: false, tell me its hint, build from the semantics alone, and skip every copy of the game and the tests against one: test against the live backend instead, on tables with an access code only.`;

  const computerLook = `give me the local address icp deploy printed; without a local copy, serve frontend/dist from any local web server and give me that address (it plays the live backend, on tables with an access code only)`;

  const test =
    way === "caffeine"
      ? `Test in your preview against the live backend, always on a table with an access code (never an open one), so real players are not disturbed.`
      : `${localCopy}
   Then ${computerLook}: I play it from two browsers, or a normal and a private window.`;

  const stop =
    way === "caffeine"
      ? `6. Stop once the page works and I'm happy with it. Do not put it online until I ask.

7. When I ask, I put it online with your own "Go live" action: tell me how, and then tell me the live page's address.`
      : `6. Stop once the page works and I'm happy with it. Do not put it online until I ask. Write into README.md how to build and deploy the page.

7. Later, when I ask you to put the page online: walk me through ${ref}/going-live.md, section 4. I create my icp identity and buy the cycles (2T for the page's canister, a few dollars). Then icp deploy frontend -e ic, after the reference's icp canister link backend ${backend} -e ic, which gives the page the backend's id (without a local copy, the reference's frontend-only icp.yaml of step 3 gives it instead). Give me the page's address and its canister id.`;

  return `${intro}${rules}

${learn}
   ${test}

${stop}

Whatever the design, the page's header keeps a "More games" link to the Duel Dashboard, https://games.ic0.info/, opening in a new tab.

If the semantics page is missing, stop and tell me instead of guessing the rules.

${CLOSING}`;
}
