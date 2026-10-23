// The prompt a developer hands to an AI coding agent (a Claude Code cloud
// session first) to get a bot for a listed game. The procedure behind it is
// skills/duel-game-core/references/bot-for-existing-game.md. Keep the
// two in step.

import { SESSION_RULES, SKILL_INSTALL } from "./cloudSession";
import { RAW, REPO } from "./frontendPrompt";
import type { Target } from "./types";
import { gameUrl } from "./types";

export function botPrompt({ game, backend }: Target): string {
  const url = gameUrl(game);
  const ref = `${RAW}/skills/duel-game-core/references`;
  return `Build me a bot for an existing two-player game on the Internet Computer: a canister of my own that plays the game by itself, which players can challenge.

The game is "${game.title}", playable at ${url}. Its backend canister is ${backend}. It runs on the duel-game-core framework (${REPO}). The backend is already live and is not mine: never deploy to it, and never call it except for the read-only checks below. The game calls my bot's make_move whenever it is the bot's turn, and the reply is the move.

Work in this order.

1. Setup. This needs icp-cli (https://github.com/dfinity/icp-cli) and mops (https://mops.one); check icp --version and mops --version first. ${SESSION_RULES} Install the framework's skill into this repository and commit it: ${SKILL_INSTALL}. Its files are then under .claude/skills/duel-game-core/, the same as the links below.

2. Learn the game from https://${backend}.raw.icp0.io/semantics — plain text with the rules, who moves when, the variants, and the exact Candid types of State and Action. This is the whole specification; there is no source code to read. Fetch any other path it mentions.

3. The full procedure for exactly this task is ${ref}/bot-for-existing-game.md — read it and follow it. What make_move receives, and how to choose the bot's shape, is in ${ref}/canister-player-bots.md. In short:
   - Download the exact module the game runs: read its module_hash from icp canister status ${backend} -n ic -p --json (drop the 0x) as HASH, then curl -sf https://api.hosty.live/modules/$HASH -o backend.wasm (never with --compressed); its SHA-256 must equal HASH. Declare it as a canister named backend with the @dfinity/prebuilt recipe, so a private copy of the game runs locally next to the bot.
   - Check icp canister metadata ${backend} candid:service -n ic for register_bot and join_table_as_canister. Without them the game takes no bots: stop and tell me.
   - Translate State and Action literally from the Candid in the semantics into Motoko, and the rules the strategy needs from its RULES section.
   - Run icp canister link backend ${backend} -e ic once.

4. Test: unit-test the move logic with mops test. Then deploy locally (icp network start -d, icp deploy) and play whole games against the bot on the local copy of the game with the reference's sparring canister: every difficulty level, the bot in both seats, every variant. Every game must reach its real ending, with the bot answering every move.

5. Do not put anything online until I ask. Then it goes through hosty.live (${ref}/going-live.md, section 3), in one deploy session I approve in its web app: hosty_create_canister with kind "backend" (1.5 TC from my balance) unless I name a canister, icp build bot, the install with hosty_prepare_wasm_upload, then hosty_call_canister on the bot, method register, argument (principal "${backend}", "<bot name>"), as an update call; check the reply's caller is my principal. Then check the game lists it (a read-only query):
     icp canister call ${backend} list_bots '()' -n ic --query --identity anonymous
   and give me the bot's canister id.

6. Every later change: test locally again, then upgrade the same bot canister (hosty_prepare_wasm_upload with its id and snapshotBeforeUpgrade), never a new one; call register again if its name or levels changed, and check list_bots again.

7. Write into README.md how to build, test and update the bot, the bot's canister id, the hosty.live steps above, and, for my own computer only, the icp-cli way:
     icp canister link backend ${backend} -e ic --force
     icp deploy bot -e ic
     icp canister call bot register '(principal "${backend}", "<bot name>")' -e ic

If the semantics page or the wasm is missing, or the hashes differ, stop and tell me instead of guessing.

Here is the bot I want (its name, how it should play, and any difficulty levels):
`;
}
