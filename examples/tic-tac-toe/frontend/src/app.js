// Bootstrap for the tic-tac-toe client: build the actor and push transport,
// hand off to duel-game-core's generic wiring, then mount the leaderboard
// and bot-challenge overlays. Bundled by esbuild (../build.js).

import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import { safeGetCanisterEnv } from "@icp-sdk/core/agent/canister-env";
import { makeIdlFactory } from "@research-ag/duel-game-core/idl.js";
import { start } from "@research-ag/duel-game-core/app.js";
import { botPlayer, mountBotChallenge, mountLeaderboard } from "@research-ag/duel-game-core/bots.js";
import { connectTransport } from "@research-ag/duel-game-core/transport.js";
import { resolveIdentity } from "@research-ag/duel-game-core/identity.js";
import { deriveHost } from "@research-ag/duel-game-core/ic-env.js";
import { plugin } from "./tictactoe-plugin.js";

const env = safeGetCanisterEnv();
const canisterId = env?.["PUBLIC_CANISTER_ID:backend"];
if (!canisterId) {
  document.body.innerHTML =
    "<p style='color:#ff7b72;padding:2rem'>Could not find " +
    "<code>PUBLIC_CANISTER_ID:backend</code> in the <code>ic_env</code> " +
    "cookie. Serve this page from the frontend canister after " +
    "<code>icp deploy</code>.</p>";
  throw new Error("missing canister id");
}

const host = deriveHost();

// An Internet Identity login if active, else a persisted anonymous keypair.
const session = await resolveIdentity();

const agent = await HttpAgent.create({
  host,
  identity: session.identity,
  rootKey: env.IC_ROOT_KEY,
});
const idlFactory = makeIdlFactory(plugin.idlTypes);
const actor = Actor.createActor(idlFactory, { agent, canisterId });

const transport = connectTransport({ actor, gameIdlTypes: plugin.idlTypes });

const client = start({ plugin, transport, session });

// "🤖 Bots" (the waiting screen's "Add Bot" and a leaderboard row's
// Challenge) and the 🏆 overlay. See frontend/README.md, "Bots and the
// leaderboard".
const bots = mountBotChallenge({ client, actor, plugin, play: botPlayer(agent, canisterId) });
mountLeaderboard({ actor, plugin, sid: session.sid, onChallenge: bots.pick });
