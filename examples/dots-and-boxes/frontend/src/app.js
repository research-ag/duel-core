// Bootstrap for Dots & Boxes: build the actor and transport, hand off to
// duel-game-core's generic wiring, and wire the page's own sound toggle.
// Bundled by esbuild (../build.js) into dist/app.js, so every import
// resolves from node_modules at build time. The lines marked BOTS or
// LEADERBOARD go with the Host's lines of the same name, and index.html's.

import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import { safeGetCanisterEnv } from "@icp-sdk/core/agent/canister-env";
import { makeIdlFactory } from "@research-ag/duel-game-core/idl.js";
import { start } from "@research-ag/duel-game-core/app.js";
import { botPlayer, mountBotChallenge, mountLeaderboard } from "@research-ag/duel-game-core/bots.js"; // BOTS, LEADERBOARD
import { connectTransport } from "@research-ag/duel-game-core/transport.js";
import { resolveAnonymousIdentity } from "@research-ag/duel-game-core/anon-identity.js";
import { deriveHost } from "@research-ag/duel-game-core/ic-env.js";
import { viewTagOf } from "@research-ag/duel-game-core/client.js";
import { plugin } from "./dots-and-boxes-plugin.js";
import { steadyScreen } from "./morph-screen.js";
import { setSoundEnabled, soundEnabled, unlockAudio } from "./sounds.js";

// Pencil sounds: unlocked by the first gesture, muted with the 🔊 button.
const soundBtn = document.getElementById("sound-toggle");
function syncSound() {
  if (!soundBtn) return;
  const on = soundEnabled();
  soundBtn.textContent = on ? "🔊" : "🔇";
  soundBtn.title = on ? "Pencil sounds on — click to mute" : "Pencil sounds off — click to unmute";
  soundBtn.setAttribute("aria-pressed", String(on));
}
soundBtn?.addEventListener("click", () => {
  setSoundEnabled(!soundEnabled());
  syncSound();
});
syncSound();
document.addEventListener("pointerdown", () => unlockAudio(), { passive: true });
document.addEventListener("keydown", () => unlockAudio());

const env = safeGetCanisterEnv();
const canisterId = env?.["PUBLIC_CANISTER_ID:backend"];
if (!canisterId) {
  document.body.innerHTML =
    "<p style='color:#c8372d;padding:2rem'>Could not find " +
    "<code>PUBLIC_CANISTER_ID:backend</code> in the <code>ic_env</code> " +
    "cookie. Serve this page from its frontend canister, with that " +
    "canister environment variable set to the backend's id.</p>";
  throw new Error("missing canister id");
}

const host = deriveHost();
// The same identity must build the agent and sign the transport calls;
// the backend checks the two match on every request.
const session = resolveAnonymousIdentity();
const agent = await HttpAgent.create({
  host,
  identity: session.identity,
  rootKey: env.IC_ROOT_KEY,
});
const idlFactory = makeIdlFactory(plugin.idlTypes);
const actor = Actor.createActor(idlFactory, { agent, canisterId });

const transport = connectTransport({ actor, gameIdlTypes: plugin.idlTypes });

// Redraws morph the existing screen instead of replacing it (no flicker,
// no restarted animations); a change of screen kind still replaces it.
let client = null;
steadyScreen(document.getElementById("screen"), () => (client ? (viewTagOf(client.getState().status) ?? "connecting") : "connecting"));

client = start({ plugin, transport, session });

// BOTS: "Add Bot" on the waiting screen and the "🤖 Bots" dialog.
const bots = mountBotChallenge({ client, actor, plugin, play: botPlayer(agent, canisterId) });
// LEADERBOARD: the 🏆 overlay, one line of the two.
mountLeaderboard({ actor, plugin, sid: session.sid, onChallenge: bots.pick }); // with BOTS
// mountLeaderboard({ actor, plugin, sid: session.sid }); // without
