// The prompt a developer hands to an AI coding agent (a Claude Code cloud
// session first) to get a whole new game built from their rules. The
// procedure behind it is skills/duel-game-core/SKILL.md and its
// references/going-live.md. Keep them in step.

import { SESSION_RULES, SKILL_INSTALL } from "./cloudSession";
import { REPO } from "./frontendPrompt";

export function gamePrompt(): string {
  return `Build me a two-player game on the Internet Computer with the duel-game-core framework (${REPO}), from my rules at the end of this message.

Work in this order.

1. Setup. ${SESSION_RULES}

2. Install the framework's skill into this repository and commit it: ${SKILL_INSTALL}. Then read .claude/skills/duel-game-core/SKILL.md and follow it step by step; its references/going-live.md has the cloud session's setup and every way of going online. Make the design calls yourself; ask me only where my rules are genuinely ambiguous about the game itself.

3. Build the whole game: the rules module, the host, the rules tests, the frontend plugin, every config file from the skill's templates, frontend/play-test.mjs included.

4. Test it before I look at it: mops test, a local network with icp deploy, and node play-test.mjs in frontend/, until every game reaches its ending.

5. Then ask me before anything goes online. Through hosty.live, in a deploy session I approve in its web app: create the game's two canisters in my account (hosty_create_canister, a backend and a frontend, about 2.5 TC from my balance), install the backend (icp build backend, hosty_prepare_wasm_upload), upload the page with PUBLIC_CANISTER_ID:backend set to the backend (hosty_prepare_zip_upload with canisterEnv), run node play-test.mjs <backend-id> --ic in frontend/, and give me the page's address and both canister ids. The game stays unlisted until I register it on the Duel dashboard.

6. Every later change: test locally again, then upgrade the same two canisters (snapshotBeforeUpgrade for the backend). If I ask for a bot or a leaderboard, the skill covers both.

7. Write into README.md how to build, test and update the game, and the two canister ids.

Here are the rules of my game:
`;
}
