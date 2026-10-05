// Bootstrap for the chopsticks client: build the actor and push transport,
// create duel-game-core's headless client, and mount chopsticks' own UI
// over it (chopsticks-ui.js). Nothing from `duel-game-core/app.js` runs
// here. Bundled by esbuild (../build.js).

import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { makeIdlFactory, buildBotPlayIdlFactory } from "duel-game-core/idl.js";
import { createDuelClient } from "duel-game-core/client.js";
import { connectTransport } from "duel-game-core/transport.js";
import { resolveIdentity } from "duel-game-core/identity.js";
import { readIcEnv, deriveHost } from "duel-game-core/ic-env.js";
import { plugin } from "./chopsticks-plugin.js";
import { mountChopsticksUi } from "./chopsticks-ui.js";

const env = readIcEnv();
const canisterId = env["PUBLIC_CANISTER_ID:backend"];
if (!canisterId) {
  document.body.innerHTML =
    "<p style='color:#ff7b72;padding:2rem'>Could not find " +
    "<code>PUBLIC_CANISTER_ID:backend</code> in the <code>ic_env</code> " +
    "cookie. Serve this page from the asset canister after " +
    "<code>icp deploy</code>.</p>";
  throw new Error("missing canister id");
}

const host = deriveHost();

// An Internet Identity login if active, else a persisted anonymous keypair.
const session = await resolveIdentity();

const agent = await HttpAgent.create({
  host,
  identity: session.identity,
  shouldFetchRootKey: /localhost|127\.0\.0\.1/.test(host),
});
const idlFactory = makeIdlFactory(plugin.idlTypes);
const actor = Actor.createActor(idlFactory, { agent, canisterId });

const ws = connectTransport({ actor, gameIdlTypes: plugin.idlTypes });

const client = createDuelClient({ ws, session });

// The plain queries the UI reads and the one call it makes on a
// discovered bot's own canister (`play`, never through `transport.mo`). See
// ../../../frontend/README.md, "Bot registry".
const hostPrincipal = Principal.fromText(canisterId);
const services = {
  leaderboard: () => actor.get_leaderboard(),
  listBots: () => actor.list_bots(),
  playBot(principalText, tableId, openSeat, code, complexity) {
    const bot = Actor.createActor(buildBotPlayIdlFactory, { agent, canisterId: principalText });
    return bot.play(hostPrincipal, tableId, openSeat, code, complexity);
  },
};

const $ = (id) => document.getElementById(id);
mountChopsticksUi({
  client,
  plugin,
  services,
  els: {
    screen: $("screen"),
    overlay: $("overlay"),
    alert: $("alert"),
    sid: $("sid"),
    switchBtn: $("new-sid"),
    authBtn: $("duel-auth-btn"),
    leaderboardBtn: $("leaderboard-toggle"),
    tutorialBtn: $("tutorial-toggle"),
    confirmDialog: $("confirm-forfeit"),
    codeDialog: $("enter-code"),
  },
});
