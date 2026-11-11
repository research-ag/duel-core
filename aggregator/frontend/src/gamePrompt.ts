// The prompt a developer hands to an AI coding agent to get a whole new
// game built from their rules, one per way: through hosty.live (a Claude
// Code cloud session first) or everything the user's own (icp-cli on
// their computer). The procedure behind it is
// skills/duel-game-core/SKILL.md and its references/going-live.md. Keep
// them in step.

import { loadSkill, OWN_RULES, SKILL_INSTALL } from "./cloudSession";
import type { Way } from "./cloudSession";
import { REPO } from "./frontendPrompt";

export function gamePrompt(way: Exclude<Way, "caffeine">): string {
  return way === "own" ? ownGamePrompt() : hostyGamePrompt();
}

const OPENING = `Build me a two-player game on the Internet Computer with the duel-game-core framework (${REPO}), from my rules at the end of this message.`;

const CLOSING = `Here are the rules of my game:
`;

function hostyGamePrompt(): string {
  return `${OPENING}

${loadSkill()} Put the game live on mainnet only when I say so.

${CLOSING}`;
}

function ownGamePrompt(): string {
  return `${OPENING}

Work in this order.

1. Setup. ${OWN_RULES}

2. Install the framework's skill into this project: ${SKILL_INSTALL}. Then read .claude/skills/duel-game-core/SKILL.md and follow it step by step; its references/going-live.md, section 4, is how the game goes online with icp-cli. Make the design calls yourself; ask me only where my rules are genuinely ambiguous about the game itself.

3. Build the whole game: the rules module, the host, the rules tests, the frontend plugin, every config file from the skill's templates, frontend/play-test.mjs included.

4. Test it before I look at it: mops test, a local network with icp deploy, and node play-test.mjs in frontend/, until every game reaches its ending.

5. Then give me the local address icp deploy printed: I play it in two browser tabs, one per seat. Every later change: test again and redeploy locally. If I ask for a bot or a leaderboard, the skill covers both.

6. When I say the game goes live, walk me through going-live.md, section 4: I create my icp identity and buy the cycles (about 5T for a backend and its page, 7T with a bot). Then deploy each canister by name, never a bare icp deploy -e ic: icp deploy backend -e ic (its sync step publishes the module to hosty.live's module store, no account needed), icp deploy frontend -e ic, then the new frontend id into index.html's tags and the page deployed again, and any bot as the skill says. Play-test it (node play-test.mjs <backend-id> --ic in frontend/) and give me the page's address and every canister id. Every later upgrade of the backend first passes node check-upgrade.mjs <backend-id> in frontend/. The game stays unlisted until I register it on the Duel dashboard.

7. Write into README.md how to build, test, deploy and update the game, and the canister ids.

${CLOSING}`;
}
