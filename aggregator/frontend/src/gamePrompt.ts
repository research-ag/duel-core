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

5. Then put it online for me to look at, for free: check hosty_whoami for free cloudEngine slots (two, three if the game has a bot) and create the game's canisters on hosty.live's cloud engine (hosty_create_canister with network "cloud", a backend and a frontend, and a bot if the game has one, alias "<game name> backend", "<game name> frontend" and "<game name> bot"; no deploy session, no cycles), install the backend (icp build backend, hosty_prepare_wasm_upload), install any bot the same way and register it with that backend as the skill says, upload the page with PUBLIC_CANISTER_ID:backend set to the backend (hosty_prepare_zip_upload with canisterEnv), run node play-test.mjs <backend-id> --ic in frontend/, and give me the page's address. Remind me that these are free test canisters: hosty.live may delete them, and the Duel dashboard will not list them. If hosty.live has no cloud engine or no free slots, the first look is the mainnet canisters of step 7 instead: tell me the cost, the bot's included, wait for my go-ahead and buy nothing outside a deploy session I approve in the hosty.live web app.

6. Every later change while I am still looking: test locally again, then redeploy into the same canisters step 5 used, on the cloud engine or the mainnet ones it fell back to (snapshotBeforeUpgrade for the backend). If hosty.live has deleted a cloud engine canister, create its replacement on the cloud engine as in step 5, never on mainnet, set the page's PUBLIC_CANISTER_ID:backend to the current backend again, and give me the new ids and the page's address. If I ask for a bot or a leaderboard, the skill covers both.

7. When I say the game goes live: in a deploy session I approve in the hosty.live web app, buy its mainnet canisters (hosty_create_canister, a backend and a frontend, and a bot if the game has one, with the same aliases, about 2.5 TC from my balance, about 4 TC with a bot; if step 5 already bought mainnet canisters, keep using those ids and buy nothing), put the new frontend id into index.html's tags, build, install and upload that build there, install any bot there and register it with the mainnet backend, play-test it, and give me the page's address and every canister id. From then on every approved change upgrades the mainnet canisters (snapshotBeforeUpgrade for the backend), never the preview copies. The game stays unlisted until I register it on the Duel dashboard; the cloud engine copies can then be deleted.

8. Write into README.md how to build, test and update the game, and the canister ids, saying which ones are the live game.

Here are the rules of my game:
`;
}
