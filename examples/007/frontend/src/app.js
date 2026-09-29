// Bootstrap for the 007 duel client: build the actor and push transport,
// hand off to duel-game-core's generic wiring, then wire the leaderboard
// overlay. Bundled by esbuild (../build.js).

import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import { makeIdlFactory } from "duel-game-core/idl.js";
import { start } from "duel-game-core/app.js";
import { connectWs } from "duel-game-core/ws.js";
import { resolveIdentity } from "duel-game-core/identity.js";
import { readIcEnv, deriveHost } from "duel-game-core/ic-env.js";
import { renderLeaderboard } from "duel-game-core/render.js";
import { plugin } from "./duel007-plugin.js";

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

start({ plugin, ws, session });

// Leaderboard: a full-page overlay fetched via a plain query on open.
const leaderboardToggle = document.getElementById("leaderboard-toggle");
const leaderboardBack = document.getElementById("leaderboard-back");
const leaderboardPanel = document.getElementById("leaderboard-panel");
const leaderboardBody = document.getElementById("leaderboard-body");
leaderboardToggle.addEventListener("click", async () => {
  leaderboardPanel.hidden = false;
  leaderboardBody.innerHTML = `<p class="muted">Loading…</p>`;
  try {
    const entries = await actor.get_leaderboard();
    leaderboardBody.innerHTML = renderLeaderboard(entries, plugin, { yourSid: session.sid });
  } catch (err) {
    leaderboardBody.innerHTML = `<p class="error">Could not load the leaderboard.</p>`;
    console.error(err);
  }
});
leaderboardBack.addEventListener("click", () => {
  leaderboardPanel.hidden = true;
});
