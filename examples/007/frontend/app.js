// Bootstrap for the 007 duel client. Builds the actor, then hands off to
// `duel-game-core`'s generic session/poll/render wiring — everything that
// is the same for every game on this engine lives in the npm package, not
// here. This file only knows how to reach the canister and which
// GamePlugin to use.
//
// Uses @dfinity/agent loaded from esm.sh — no build step required for
// THIS file; `duel-game-core` itself is fetched once via `npm install`
// (see package.json / .npmrc) since it has no CDN distribution, and is
// imported below by its plain on-disk path — the browser has no bare
// "duel-game-core/..." specifier resolution without an import map.

import { Actor, HttpAgent } from "https://esm.sh/@dfinity/agent@2.4.1";
import { makeIdlFactory } from "./node_modules/duel-game-core/idl.js";
import { start } from "./node_modules/duel-game-core/app.js";
import { connectWs } from "./node_modules/duel-game-core/ws.js";
import { readIcEnv, deriveHost } from "./node_modules/duel-game-core/ic-env.js";
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
const agent = await HttpAgent.create({
  host,
  shouldFetchRootKey: /localhost|127\.0\.0\.1/.test(host),
});
const idlFactory = makeIdlFactory(plugin.idlTypes);
const actor = Actor.createActor(idlFactory, { agent, canisterId });

// Real-time push over WebSocket, in place of polling — see
// ../../../backend/README.md's "Optional: real-time push" section.
// connectWs() picks the right Gateway automatically (self-hosted locally,
// public otherwise — see ../../../frontend/ws.js) and returns `undefined`
// (falling back to polling) if `?ws=0` is in the page URL.
const ws = connectWs({ canisterId, actor, host });

start({ actor, plugin, ws });
