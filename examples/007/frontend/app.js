// Bootstrap for the 007 duel client. Builds the actor and a push-shaped
// `ws` over it, then hands off to `duel-game-core`'s generic session/
// render wiring — everything that is the same for every game on this
// engine lives in the npm package, not here. This file only knows how to
// reach the canister and which GamePlugin to use.
//
// Uses @icp-sdk/core loaded from esm.sh — no build step required for
// THIS file; `duel-game-core` itself is fetched once via `npm install`
// (see package.json / .npmrc) since it has no CDN distribution, and is
// imported below by its plain on-disk path, under `dist/` — that's
// where duel-game-core's own compiled output lands (its source is
// TypeScript now; see ../../../CLAUDE.md's "After touching anything
// under frontend/" section — `npm run build` there has to run BEFORE
// this example's own `npm install`, since this repo's `allow-scripts`
// gate blocks duel-game-core's own `prepare` script from doing it
// automatically) — the browser has no bare "duel-game-core/..."
// specifier resolution without an import map.

import { Actor, HttpAgent } from "https://esm.sh/@icp-sdk/core@6.1.0/agent";
import { makeIdlFactory } from "./node_modules/duel-game-core/dist/idl.js";
import { start } from "./node_modules/duel-game-core/dist/app.js";
import { connectWs } from "./node_modules/duel-game-core/dist/ws.js";
import { resolveIdentity } from "./node_modules/duel-game-core/dist/identity.js";
import { readIcEnv, deriveHost } from "./node_modules/duel-game-core/dist/ic-env.js";
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
// one's already active, otherwise a fresh throwaway identity plus a
// plain, self-generated agent id, both exactly as before this game had a
// login option at all. See duel-game-core/README.md's "Logging in with
// Internet Identity" section for the full mechanism.
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
