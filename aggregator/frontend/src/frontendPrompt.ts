// The prompt a player hands to an AI coding agent to get their own
// frontend for a listed game. The procedure it points at lives in
// skills/duel-game-core/references/frontend-for-existing-game.md; keep
// the two in step.

import type { GameView } from "./types";
import { gameUrl } from "./types";

const REFERENCE =
  "skills/duel-game-core/references/frontend-for-existing-game.md";

/// `game = undefined` leaves placeholders for the reader to fill in.
export function frontendPrompt(game: GameView | undefined): string {
  const title = game ? `"${game.title}"` : "<game title>";
  const url = game ? gameUrl(game) : "https://<game-frontend-canister-id>.icp0.io";
  return `Build a new frontend for an existing two-player game on the Internet Computer and get it ready for me to deploy.

The game is ${title}, playable at ${url}
It runs on duel-game-core (https://github.com/research-ag/duel-core). Its backend canister is live and stays untouched: you write only a browser client for it, in this empty project directory. I have icp-cli and Node.js installed.

Work in this order.

1. Install the playbook and follow its reference for exactly this task:
     npx skills add research-ag/duel-core --skill duel-game-core
   then read references/frontend-for-existing-game.md in the installed skill. If skills cannot be installed, read it at
     https://raw.githubusercontent.com/research-ag/duel-core/main/${REFERENCE}
   and clone https://github.com/research-ag/duel-core for the templates it names.

2. Find the game's backend canister id (the game's frontend publishes it in a cookie):
     BACKEND=$(curl -sI ${url}/ | grep -o 'ID%3Abackend%3D[a-z0-9%D]*cai' | head -1 | sed 's/.*%3D//; s/%2D/-/g')

3. Read the rules and the exact State and Action types, as plain text:
     curl -s https://$BACKEND.raw.icp0.io/semantics

4. Fetch the backend's Candid interface:
     icp canister metadata $BACKEND candid:service -n ic > backend.did

5. Pull the backend's wasm so you can run a private copy of the game locally:
     SNAP=$(icp canister snapshot list $BACKEND -n ic -q | head -1)
     icp canister snapshot download $BACKEND $SNAP -n ic -o snapshot
     cp snapshot/wasm_module.bin backend.wasm && shasum -a 256 backend.wasm
   The hash must equal "module_hash" at https://ic-api.internetcomputer.org/api/v3/canisters/$BACKEND

6. Build the frontend, deploy it with the pulled backend to a local network (icp network start -d, icp deploy), and play a whole game there end to end: both seats in two browser tabs, every kind of move, an ending, a rematch.

7. Do not deploy to mainnet yourself. Finish by writing a README.md with the exact commands for me to run:
     icp canister link backend $BACKEND -e ic
     icp deploy frontend -e ic
     icp canister status frontend -e ic -i

Never create tables or play on the live backend while developing; real players would see them. If the semantics are missing, there is no snapshot, or the hash does not match, stop and tell me instead of working around it.

Here is the frontend I want:
`;
}
