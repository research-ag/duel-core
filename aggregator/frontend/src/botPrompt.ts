// The prompt a developer hands to an AI coding agent to get a bot for a
// listed game. The procedure behind it is
// skills/duel-game-core/references/bot-for-existing-game.md. Keep the
// two in step.

import { RAW, REPO } from "./frontendPrompt";
import type { Target } from "./types";
import { gameUrl } from "./types";

export function botPrompt({ game, backend }: Target): string {
  const url = gameUrl(game);
  const ref = `${RAW}/skills/duel-game-core/references`;
  return `Build me a bot for an existing two-player game on the Internet Computer: a canister of my own that plays the game by itself, which players can challenge.

The game is "${game.title}", playable at ${url}. Its backend canister is ${backend}. It runs on the duel-game-core framework (${REPO}). The backend is already live and is not mine: never deploy to it and never call it while developing. The game calls my bot's make_move whenever it is the bot's turn, and the reply is the move.

Work in this order.

1. Tools: this needs icp-cli (https://github.com/dfinity/icp-cli) and mops (https://mops.one) on this computer. Check icp --version and mops --version; install whatever is missing, or tell me how if you can't.

2. Learn the game from https://${backend}.raw.icp0.io/semantics — plain text with the rules, who moves when, the variants, and the exact Candid types of State and Action. This is the whole specification; there is no source code to read. Fetch any other path it mentions.

3. The full procedure for exactly this task is ${ref}/bot-for-existing-game.md — read it and follow it. What make_move receives, and how to choose the bot's shape, is in ${ref}/canister-player-bots.md. In short:
   - Download the game's wasm (curl -s https://${backend}.raw.icp0.io/wasm -o backend.wasm), check its SHA-256 against the module_hash from icp canister status ${backend} -n ic -p --json, and declare it as a canister named backend with the @dfinity/prebuilt recipe, so a private copy of the game runs locally next to the bot.
   - Check icp canister metadata ${backend} candid:service -n ic for register_bot and join_table_as_canister. Without them the game takes no bots: stop and tell me.
   - Translate State and Action literally from the Candid in the semantics into Motoko, and the rules the strategy needs from its RULES section.
   - Run icp canister link backend ${backend} -e ic once.

4. Test: unit-test the move logic with mops test. Then deploy locally (icp network start -d, icp deploy) and play whole games against the bot on the local copy of the game with the reference's sparring canister: every difficulty level, the bot in both seats, every variant. Every game must reach its real ending, with the bot answering every move.

5. Do not put anything online yourself. Finish by telling me, step by step, what to do next, and write the same into a README.md, with these commands:
     icp canister link backend ${backend} -e ic --force
     icp deploy bot -e ic
     icp canister call bot register '(principal "${backend}", "<bot name>")' -e ic

If the semantics page or the wasm is missing, or the hashes differ, stop and tell me instead of guessing.

Here is the bot I want (its name, how it should play, and any difficulty levels):
`;
}
