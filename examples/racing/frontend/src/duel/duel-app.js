// Bootstrap for the racing duel client. Builds the actor and a
// push-shaped `ws` over it, then hands off to duel-game-core's generic
// session/render wiring for everything that's the same for every game on
// this engine (lobby, staging, rematch, debrief) — see index.html's
// #screen. It also publishes that same actor AND `ws` on
// `window.duelActorReady`/`duelWsReady` so the app's own esbuild bundle
// loaded alongside this page (see main.ts) can drive the actual 3D race
// against the identical session and the SAME poller, without building
// either a second actor or a second poll loop — see
// ../app/modules/gameplay/game-communication/utils/duel-actor.ts and
// game-communication/services/lobby-connection.service.ts.
//
// Uses @dfinity/agent loaded from esm.sh — no build step required for
// THIS file; `duel-game-core` itself is fetched once via `npm install`
// (see package.json / .npmrc) since it has no CDN distribution, and is
// imported below by its plain on-disk path — the browser has no bare
// "duel-game-core/..." specifier resolution without an import map. This
// file is copied byte-for-byte into the build output (see build.js's
// cpSync list), same as `duel-racing-plugin.js`.

import { Actor, HttpAgent } from 'https://esm.sh/@dfinity/agent@2.4.1';
import { makeIdlFactory } from './node_modules/duel-game-core/idl.js';
import { start } from './node_modules/duel-game-core/app.js';
import { connectWs } from './node_modules/duel-game-core/ws.js';
import { readIcEnv, deriveHost } from './node_modules/duel-game-core/ic-env.js';
import { plugin } from './duel-racing-plugin.js';

// `window.duelActorReady` / `window.__resolveDuelActor` are set up by an
// INLINE (non-module) script in index.html's <head>, so the Promise exists
// before any deferred module script runs — the app's own bundle can then
// safely `await` it no matter which of the two loads/executes first.
if (!window.__resolveDuelActor || !window.__resolveDuelWs) {
  throw new Error("window.__resolveDuelActor/__resolveDuelWs is missing — check index.html's inline bootstrap script");
}

const env = readIcEnv();
const canisterId = env['PUBLIC_CANISTER_ID:backend'];
if (!canisterId) {
  document.body.innerHTML =
    "<p style='color:#ff7b72;padding:2rem'>Could not find " +
    '<code>PUBLIC_CANISTER_ID:backend</code> in the <code>ic_env</code> ' +
    'cookie. Serve this page from the asset canister after ' +
    '<code>icp deploy</code>.</p>';
  throw new Error('missing canister id');
}

const host = deriveHost();
const agent = await HttpAgent.create({
  host,
  shouldFetchRootKey: /localhost|127\.0\.0\.1/.test(host),
});
const idlFactory = makeIdlFactory(plugin.idlTypes);
const actor = Actor.createActor(idlFactory, { agent, canisterId });

window.__resolveDuelActor(actor);

// A real push transport for the generic lobby/staging/rematch/debrief
// chrome below — see ../../../../../frontend/README.md's "Real-time
// push" section. connectWs() builds a GatewayWs that speaks
// mo:duel-game-core/Ws's ic-websocket-cdk protocol directly,
// self-registering this tab as its own Gateway (see
// ../../../../../frontend/ws/gateway-transport.js) — genuine canister
// push, and a genuine server-side signal if this tab goes quiet.
// `principal` is the same identity `agent`/`actor` already sign calls
// with; `gameIdlTypes` supplies this game's own Action/State Candid
// shape (needed to decode the message content blob). `app.js`'s start()
// sends every action and refresh over this — there is no
// plain-actor-call/polling code path any more, `ws` is required.
//
// Published on window.duelWsReady (same pattern as the actor above) so
// lobby-connection.service.ts shares this EXACT client for the actual
// race instead of running a second independent one — `GatewayWs`
// extends EventTarget for exactly this, see its own header.
const principal = await agent.getPrincipal();
const ws = connectWs({ actor, principal, gameIdlTypes: plugin.idlTypes });
window.__resolveDuelWs(ws);

start({ plugin, ws });
