// Bootstrap for the rock-paper-scissors client: build the actor and push transport,
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
import { debriefVerdict, esc, tag } from "@research-ag/duel-game-core/render.js";
import { plugin, renderLastRound } from "./rps-plugin.js";

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

// The debrief is this game's own: a final scoreline and the deciding
// round instead of the generic board. Every other screen stays the default.
function renderRpsDebrief(v, p) {
  const me = tag(v.seat);
  const opp = me === "p1" ? "p2" : "p1";
  const score = (seat) => (seat === "p1" ? v.finalGame.p1Score : v.finalGame.p2Score);
  const { title, outcome } = debriefVerdict(v.end, me);
  return `
    <h2 class="verdict ${outcome}">${title}</h2>
    <p class="rps-final">
      <span class="rps-final-you">${score(me)}</span>
      <span class="vs">–</span>
      <span class="rps-final-opp">${score(opp)}</span>
    </p>
    ${renderLastRound(v.finalGame, me, opp)}
    <p class="muted">${v.steps} round${v.steps === 1n ? "" : "s"} of ${esc(p.formatOptions({ variant: v.finalGame.variant, winsNeeded: v.finalGame.winsNeeded }))}.</p>
    <p>
      <button data-rematch class="primary">Play again</button>
      <button data-leave class="ghost">Back to the lobby</button>
    </p>`;
}

const client = start({ plugin, transport, session, screens: { debrief: renderRpsDebrief } });

// "🤖 Bots" (the waiting screen's "Add Bot" and a leaderboard row's
// Challenge) and the 🏆 overlay. See frontend/README.md, "Bots and the
// leaderboard".
const bots = mountBotChallenge({ client, actor, plugin, play: botPlayer(agent, canisterId) });
mountLeaderboard({ actor, plugin, sid: session.sid, onChallenge: bots.pick });
