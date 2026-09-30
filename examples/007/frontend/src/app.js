// Bootstrap for the 007 duel client: build the actor and push transport,
// create duel-game-core's headless client, and mount 007's own UI over
// it (mission-ui.js). Nothing from `duel-game-core/app.js` runs here.
// Bundled by esbuild (../build.js).

import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import { makeIdlFactory } from "duel-game-core/idl.js";
import { createDuelClient } from "duel-game-core/client.js";
import { connectWs } from "duel-game-core/ws.js";
import { resolveIdentity } from "duel-game-core/identity.js";
import { readIcEnv, deriveHost } from "duel-game-core/ic-env.js";
import { renderLeaderboard } from "duel-game-core/render.js";
import { plugin } from "./duel007-plugin.js";
import { mountMissionUi } from "./mission-ui.js";

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

const ws = connectWs({ actor, principal: session.principal, gameIdlTypes: plugin.idlTypes });

const client = createDuelClient({ ws, session });

const $ = (id) => document.getElementById(id);
mountMissionUi({
  client,
  plugin,
  els: {
    screen: $("mission"),
    alert: $("alert"),
    sid: $("sid"),
    newSid: $("new-sid"),
    auth: $("auth"),
    channel: $("channel"),
    log: $("log"),
    confirmDialog: $("confirm-forfeit"),
    codeDialog: $("enter-code"),
  },
});

// Leaderboard: a full-page overlay fetched via a plain query on open.
const leaderboardPanel = $("leaderboard-panel");
const leaderboardBody = $("leaderboard-body");
$("leaderboard-toggle").addEventListener("click", async () => {
  leaderboardPanel.hidden = false;
  leaderboardBody.innerHTML = `<p class="faint">Loading…</p>`;
  try {
    const entries = await actor.get_leaderboard();
    leaderboardBody.innerHTML = renderLeaderboard(entries, plugin, { yourSid: session.sid });
  } catch (err) {
    leaderboardBody.innerHTML = `<p class="alert">Could not load the leaderboard.</p>`;
    console.error(err);
  }
});
$("leaderboard-back").addEventListener("click", () => {
  leaderboardPanel.hidden = true;
});
