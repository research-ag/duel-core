// The prompt a developer hands to an AI coding agent to get a bot for a
// listed game, one per way: through hosty.live (a Claude Code cloud
// session first) or everything the user's own (icp-cli on their
// computer). The procedure behind it is
// skills/duel-game-core/references/bot-for-existing-game.md. Keep the
// two in step.

import { OWN_RULES, SESSION_RULES, SKILL_INSTALL } from "./cloudSession";
import type { Way } from "./cloudSession";
import { RAW, REPO } from "./frontendPrompt";
import type { Target } from "./types";
import { gameUrl } from "./types";

export function botPrompt(
  { game, backend }: Target,
  way: Exclude<Way, "caffeine">
): string {
  const url = gameUrl(game);
  const ref = `${RAW}/skills/duel-game-core/references`;
  const subnetLookup = `curl -sf https://ic-api.internetcomputer.org/api/v3/canisters/${backend} | grep -o '"subnet_id":"[^"]*"'`;
  const register = `icp canister call bot register '(principal "${backend}", "<bot name>")' -e ic`;
  const listBots = `     icp canister call ${backend} list_bots '()' -n ic --query --identity anonymous`;

  const setup =
    way === "hosty"
      ? `1. Setup. This needs icp-cli (https://github.com/dfinity/icp-cli) and mops (https://mops.one); check icp --version and mops --version first. ${SESSION_RULES} Install the framework's skill into this repository and commit it: ${SKILL_INSTALL}. Its files are then under .claude/skills/duel-game-core/, the same as the links below.`
      : `1. Setup. ${OWN_RULES} Install the framework's skill into this project: ${SKILL_INSTALL}. Its files are then under .claude/skills/duel-game-core/, the same as the links below.`;

  const tryOut =
    way === "hosty"
      ? `

5. If I want to see the bot play online before paying for its canister, the reference's step 5 ("Online before paying for its canister") has two free ways: by default a temporary cloud engine copy of the game on hosty.live (hosty_create_canister with network "cloud" for a backend, hosty_install_module with the game's hash, the bot beside it, register on the copy; tell me it is an empty copy, not the real game), or a rented mainnet canister for the bot against the live game, which you unregister before the rental ends. Ask me which, and do neither on your own.`
      : "";

  const goLive =
    way === "hosty"
      ? `6. Do not put anything online until I ask. First look up the game's subnet: ${subnetLookup}. If the call fails or prints no subnet_id, stop and tell me: deploy and install nothing until the subnet is known. The bot's canister must sit on that same subnet, because the game asks the bot once per move and an ask across subnets takes seconds (${ref}/bot-for-existing-game.md, step 6). hosty.live creates every mainnet canister on subnet c4isl-65rwf-emhk5-5ta5m-ngl73-rgrl3-tcc56-2hkja-4erqd-iivmy-7ae; if the game is on another subnet, the bot goes up with icp-cli from my computer instead: tell me so; there it is icp deploy bot -e ic --subnet <the game's subnet> for a new canister, or, into a canister I name (after the same subnet lookup as below), icp canister link bot <its id> -e ic and then icp deploy bot -e ic without --subnet; then the register call of step 8 (${register}), then the list_bots check below. Otherwise it goes through hosty.live (${ref}/going-live.md, section 3), in one deploy session I approve in its web app: hosty_create_canister with kind "backend" and alias "<game name> bot" (a mainnet canister, 1.5 TC from my balance; a free cloud engine canister cannot host a bot for a live game, since a bot and its game must share one network) unless I name a canister; a canister I name gets the same subnet lookup first (curl -sf https://ic-api.internetcomputer.org/api/v3/canisters/<its id>, with the same stop when it fails or prints no subnet_id), and if its subnet differs from the game's, tell me and install nothing. Then icp build bot, the install with hosty_prepare_wasm_upload, then hosty_call_canister on the bot, method register, argument (principal "${backend}", "<bot name>"), as an update call; check the reply's caller is my principal. Then check the game lists it (a read-only query):
${listBots}
   and give me the bot's canister id.

7. Every later change: test locally again, then upgrade the same bot canister, never a new one: through hosty.live, hosty_prepare_wasm_upload with its id and snapshotBeforeUpgrade; a bot that went up with icp-cli is upgraded from my computer with icp deploy bot -e ic (after icp canister link bot <bot id> -e ic when .icp/data/mappings/ic.ids.json has no bot entry): tell me so. Call register again if its name or levels changed, and check list_bots again.

8. Write into README.md how to build, test and update the bot, the bot's canister id, the hosty.live steps above, and, for my own computer only, the icp-cli way. The first deploy creates the bot's canister:`
      : `5. Do not put anything online until I ask. Then walk me through ${ref}/going-live.md, section 4: I create my icp identity and buy the cycles (at the time of writing about 3T, a few dollars). First look up the game's subnet: ${subnetLookup}. If the call fails or prints no subnet_id, stop and tell me: deploy nothing until the subnet is known. The bot's canister must sit on that same subnet, because the game asks the bot once per move and an ask across subnets takes seconds (${ref}/bot-for-existing-game.md, step 6). Then icp deploy bot -e ic --subnet <the game's subnet> for a new canister, or, into a canister I name, the same subnet lookup for it first, then icp canister link bot <its id> -e ic and icp deploy bot -e ic without --subnet. Then ${register}, and check the game lists it (a read-only query):
${listBots}
   and give me the bot's canister id.

6. Every later change: test locally again, then upgrade the same bot canister, never a new one: icp deploy bot -e ic (after icp canister link bot <bot id> -e ic when .icp/data/mappings/ic.ids.json has no bot entry). Call register again if its name or levels changed, and check list_bots again.

7. Write into README.md how to build, test and update the bot, and the bot's canister id. The first deploy creates the bot's canister:`;

  return `Build me a bot for an existing two-player game on the Internet Computer: a canister of my own that plays the game by itself, which players can challenge.

The game is "${game.title}", playable at ${url}. Its backend canister is ${backend}. It runs on the duel-game-core framework (${REPO}). The backend is already live and is not mine: never deploy to it, and never call it except for the read-only checks below. The game calls my bot's make_move whenever it is the bot's turn, and the reply is the move.

Work in this order.

${setup}

2. Learn the game from https://${backend}.raw.icp0.io/semantics — plain text with the rules, who moves when, the variants, and the exact Candid types of State and Action. This is the whole specification; there is no source code to read. Fetch any other path it mentions.

3. The full procedure for exactly this task is ${ref}/bot-for-existing-game.md — read it and follow it. What make_move receives, and how to choose the bot's shape, is in ${ref}/canister-player-bots.md. In short:
   - Download the exact module the game runs: read its module_hash from icp canister status ${backend} -n ic -p --json (drop the 0x) as HASH, then curl -sf https://api.hosty.live/modules/$HASH -o backend.wasm (never with --compressed); its SHA-256 must equal HASH. Declare it as a canister named backend with the @dfinity/prebuilt recipe, so a private copy of the game runs locally next to the bot.
   - Check icp canister metadata ${backend} candid:service -n ic for register_bot and join_table_as_canister. Without them the game takes no bots: stop and tell me.
   - Translate State and Action literally from the Candid in the semantics into Motoko, and the rules the strategy needs from its RULES section.
   - Run icp canister link backend ${backend} -e ic once.

4. Test: unit-test the move logic with mops test. Then deploy locally (icp network start -d, icp deploy) and play whole games against the bot on the local copy of the game with the reference's sparring canister: every difficulty level, the bot in both seats, every variant. Every game must reach its real ending, with the bot answering every move.${tryOut}

${goLive}
     icp canister link backend ${backend} -e ic --force
     icp deploy bot -e ic --subnet <the game's subnet>
     ${register}
   Every upgrade goes into that recorded canister, without --subnet (the link only when .icp/data/mappings/ic.ids.json has no bot entry):
     icp canister link bot <bot id> -e ic
     icp deploy bot -e ic

If the semantics page or the wasm is missing, or the hashes differ, stop and tell me instead of guessing.

Here is the bot I want (its name, how it should play, and any difficulty levels):
`;
}
