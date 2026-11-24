// The prompt a developer hands to an AI builder to get a bot for a
// listed game, one per way: caffeine.ai, through hosty.live (a Claude
// Code cloud session first) or everything the user's own (icp-cli on
// their computer). The procedure behind it is
// skills/duel-game-core/references/bot-for-existing-game.md, and
// references/caffeine.md for caffeine.ai. Keep them in step.

import { loadSkill, OWN_RULES, SKILL_INSTALL } from "./cloudSession";
import type { Way } from "./cloudSession";
import { caffeineReference, RAW, REPO } from "./frontendPrompt";
import type { Target } from "./types";
import { gameUrl } from "./types";

const CLOSING = `Here is the bot I want (its name, how it should play, and any difficulty levels):
`;

export function botPrompt({ game, backend }: Target, way: Way): string {
  const url = gameUrl(game).replace(/\/+$/, "");
  const ref = `${RAW}/skills/duel-game-core/references`;
  const subnetLookup = `curl -sf https://ic-api.internetcomputer.org/api/v3/canisters/${backend} | grep -o '"subnet_id":"[^"]*"'`;
  const register = `icp canister call bot register '(principal "${backend}", "<bot name>")' -e ic`;
  const listBots = `     icp canister call ${backend} list_bots '()' -n ic --query --identity anonymous`;

  const intro = `Build me a bot for an existing two-player game on the Internet Computer: a canister of my own that plays the game by itself, which players can challenge.

The game is "${game.title}", playable at ${url}. Its backend canister is ${backend}. It runs on the duel-game-core framework (${REPO}). The backend is already live and is not mine: never deploy to it, and never call it except for read-only checks. The game calls my bot's make_move whenever it is the bot's turn, and the reply is the move.`;

  if (way === "hosty")
    return `${intro}

${loadSkill("references/bot-for-existing-game.md")} Put nothing online and buy no canister until I ask.

${CLOSING}`;

  if (way === "caffeine")
    return `${intro}

Work in this order.

1. Learn the game from https://${backend}.raw.icp0.io/semantics — plain text with the rules, who moves when, the variants, and the exact Candid types of View (what a seat sees, headed VIEW, or STATE in older games), Action and Options. This is the whole specification; there is no source code to read. Fetch any other path it mentions.

2. ${caffeineReference(`3, "A bot for a game already deployed"`)}

3. This app is the bot alone. Keep this project's own setup and add mops add duel-game-core and mops add promtracker. The bot's page stays on this project's own frontend packages. Register and Unregister accept one caller, owner, a principal written into the backend code as the reference shows: this project's admin role goes to whoever signs in first, so it does not bind the bot to me.

4. The bot's page shows its name and its canister id; a try-out form that takes the invite link of an access-code table on the game (#t=<table>&c=<code>), the seat the bot takes and the level, and calls the bot's own play with the game's backend ${backend}, that table, seat and code; and for each level a link that starts a game against it on the game's own page, for players once the bot is live: ${url}/#new&b= followed by encodeURIComponent of "<this bot's canister id>:<level>" (Default for a bot without levels). It also has a sign-in with Internet Identity that shows my principal, and the buttons Register, which calls register with the game's backend ${backend} and the bot's name, and Unregister.

5. Then I try the draft at access-code tables only: I open one with "Invite a friend" on the game's page and paste its invite link into your preview's try-out form. Never use the links for that, they open a table anyone can see. Never register the draft. I sign in there and give you the principal it shows: put it into owner.

6. Do not go live until I ask, and not before owner is set. After Go live I sign in on the live bot's page; if it shows another principal, put that one into owner and I go live again. Then I press Register.

If the semantics page is missing, stop and tell me instead of guessing.

${CLOSING}`;

  return `${intro}

Work in this order.

1. Setup. ${OWN_RULES} Install the framework's skill into this project: ${SKILL_INSTALL}. Its files are then under .claude/skills/duel-game-core/, the same as the links below.

2. Learn the game from https://${backend}.raw.icp0.io/semantics — plain text with the rules, who moves when, the variants, and the exact Candid types of View (what a seat sees, headed VIEW, or STATE in older games), Action and Options. This is the whole specification; there is no source code to read. Fetch any other path it mentions.

3. The full procedure for exactly this task is ${ref}/bot-for-existing-game.md — read it and follow it. What make_move receives, and how to choose the bot's shape, is in ${ref}/canister-player-bots.md. In short:
   - Download the exact module the game runs: read its module_hash from icp canister status ${backend} -n ic -p --json (drop the 0x) as HASH, then curl -sf https://api.hosty.live/modules/$HASH -o backend.wasm (never with --compressed); its SHA-256 must equal HASH. Declare it as a canister named backend with the @dfinity/prebuilt recipe, so a private copy of the game runs locally next to the bot.
   - Check icp canister metadata ${backend} candid:service -n ic for register_bot and join_table_as_canister. Without them the game takes no bots: stop and tell me.
   - Translate View (VIEW or STATE), Action and Options literally from the Candid in the semantics into Motoko, and the rules the strategy needs from its RULES section.
   - The bot serves GET /metrics with promtracker's system metrics, as the reference's Bot.mo does; the Duel dashboard shows its balance from there.
   - Run icp canister link backend ${backend} -e ic once.

4. Test: unit-test the move logic with mops test. Then deploy locally (icp network start -d, icp deploy) and play whole games against the bot on the local copy of the game with the reference's sparring canister: every difficulty level, the bot in both seats, every variant. Every game must reach its real ending, with the bot answering every move.

5. Do not put anything online until I ask. Then walk me through ${ref}/going-live.md, section 4: I create my icp identity and buy the cycles (about 3T, a few dollars). First look up the game's subnet: ${subnetLookup}. If the call fails or prints no subnet_id, stop and tell me: deploy nothing until the subnet is known. The bot's canister must sit on that same subnet, because the game asks the bot once per move and an ask across subnets takes seconds (${ref}/bot-for-existing-game.md, step 6). Then icp deploy bot -e ic --subnet <the game's subnet> for a new canister, or, into a canister I name, the same subnet lookup for it first, then icp canister link bot <its id> -e ic and icp deploy bot -e ic without --subnet. Then ${register}, and check the game lists it (a read-only query):
${listBots}
   and that the bot's metrics answer: curl -sf https://<bot id>.raw.icp0.io/metrics | grep '^cycles_balance'
   Then give me the bot's canister id.

6. Every later change: test locally again, then upgrade the same bot canister, never a new one: icp deploy bot -e ic (after icp canister link bot <bot id> -e ic when .icp/data/mappings/ic.ids.json has no bot entry). Call register again if its name or levels changed, and check list_bots again.

7. Write into README.md how to build, test and update the bot, and the bot's canister id. The first deploy creates the bot's canister:
     icp canister link backend ${backend} -e ic --force
     icp deploy bot -e ic --subnet <the game's subnet>
     ${register}
   Every upgrade goes into that recorded canister, without --subnet (the link only when .icp/data/mappings/ic.ids.json has no bot entry):
     icp canister link bot <bot id> -e ic
     icp deploy bot -e ic

If the semantics page or the wasm is missing, or the hashes differ, stop and tell me instead of guessing. For a missing wasm, look the game up at https://api.hosty.live/modules/canister/${backend}: if it answers found: false, tell me its hint (the module store keeps a game's module, not the canister, and the hint says how the game's owner adds it); if it answers found: true, tell me the download failed, with the hashes, since the canister may have been upgraded since you read its module_hash.

${CLOSING}`;
}
