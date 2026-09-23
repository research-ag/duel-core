// Bootstrap for the 007 duel client. Builds the actor and a push-shaped
// `ws` over it, then hands off to `duel-game-core`'s generic session/
// render wiring — everything that is the same for every game on this
// engine lives in the npm package, not here. This file only knows how to
// reach the canister and which GamePlugin to use.
//
// This file is bundled by esbuild (see ../build.js) into dist/app.js, so
// every import below — @icp-sdk/core and duel-game-core alike — resolves
// normally from node_modules at build time and ships as one self-
// contained bundle; the deployed asset canister carries no node_modules
// directory of its own. `duel-game-core` itself is fetched once via
// `npm install` (see package.json / .npmrc) — its own dist/ is what
// these imports resolve against (its source is TypeScript; see
// ../../../CLAUDE.md's "After touching anything under frontend/"
// section — `npm run build` there has to run BEFORE this example's own
// `npm install`, since this repo's `allow-scripts` gate blocks
// duel-game-core's own `prepare` script from doing it automatically).

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

// This tab's own identity — a real, permanent Internet Identity login if
// one's already active, otherwise a persisted, non-spoofable anonymous
// keypair (no login required). See duel-game-core/README.md's "Logging
// in with Internet Identity" section for the full mechanism.
const session = await resolveIdentity();

const agent = await HttpAgent.create({
  host,
  identity: session.identity,
  shouldFetchRootKey: /localhost|127\.0\.0\.1/.test(host),
});
const idlFactory = makeIdlFactory(plugin.idlTypes);
const actor = Actor.createActor(idlFactory, { agent, canisterId });

// A real push transport — see ../../../frontend/README.md's "Real-time
// push" section. connectWs() builds a GatewayWs that speaks
// mo:duel-game-core/ws's ic-websocket-cdk protocol directly, self-
// registering this tab as its own Gateway (see
// ../../../frontend/ws/gateway-transport.js) — genuine canister push,
// and a genuine server-side signal if this tab goes quiet. `principal`
// is the same identity `agent`/`actor` already sign calls with;
// `gameIdlTypes` supplies the Candid shape of this game's own
// Action/State (needed to decode the message content blob). `app.js`'s
// start() sends every action and refresh over this — there is no
// plain-actor-call/polling code path any more, `ws` is required.
const ws = connectWs({ actor, principal: session.principal, gameIdlTypes: plugin.idlTypes });

start({ plugin, ws, session });

// The leaderboard: a dedicated full-page overlay (#leaderboard-panel,
// styled `position: fixed; inset: 0` — see duel-game-core.css — so the
// generic chrome's own live status pushes updating #screen underneath it
// can never clobber it), fetched fresh via a plain Candid query on the
// SAME actor `start()` already built (get_leaderboard needs no `ws`
// round-trip — see duel-game-core/README.md's "Leaderboard" section)
// each time it's opened, rather than kept live-pushed like the game
// screen itself. `yourSid: session.sid` lets renderLeaderboard pick out
// and badge this player's own row, if they're on the ranked list.
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
