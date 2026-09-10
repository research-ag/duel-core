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
// Uses @icp-sdk/core loaded from esm.sh — no build step required for
// THIS file; `duel-game-core` itself is fetched once via `npm install`
// (see package.json / .npmrc) since it has no CDN distribution, and is
// imported below by its plain on-disk path, under `dist/` — that's
// where duel-game-core's own compiled output lands (its source is
// TypeScript now; see ../../../../CLAUDE.md's "After touching anything
// under frontend/" section — `npm run build` there has to run BEFORE
// this example's own `npm install`, since this repo's `allow-scripts`
// gate blocks duel-game-core's own `prepare` script from doing it
// automatically) — the browser has no bare "duel-game-core/..."
// specifier resolution without an import map. This
// file is copied byte-for-byte into the build output (see build.js's
// cpSync list), same as `duel-racing-plugin.js`.

// `agent` and `identity` are both submodules of the SAME `@icp-sdk/core`
// package, so pinning one exact version on both esm.sh URLs is enough to
// keep them mutually consistent — no separate cross-package version-pin
// trick needed the way independently versioned packages would require.
import { Actor, HttpAgent } from 'https://esm.sh/@icp-sdk/core@6.1.0/agent';
import { Ed25519KeyIdentity } from 'https://esm.sh/@icp-sdk/core@6.1.0/identity';
import { makeIdlFactory } from './node_modules/duel-game-core/dist/idl.js';
import { start } from './node_modules/duel-game-core/dist/app.js';
import { connectWs } from './node_modules/duel-game-core/dist/ws.js';
import { readIcEnv, deriveHost } from './node_modules/duel-game-core/dist/ic-env.js';
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
// A fresh, throwaway Ed25519 identity generated on EVERY page load —
// deliberately NOT anonymous, and deliberately NOT derived from/stable
// across this tab's own sid either (an earlier version of this file
// derived it from `sid` so it stayed the same across a reload — reverted
// after that turned out to actively cause "Connection closed — reload
// to reconnect" / `ws_message: Client with principal ... doesn't have an
// open connection", see below).
//
// This game has no login (see ../../CLAUDE.md: no auth, players are
// told apart by seat/sid, never by principal — the engine's own identity
// is the client-chosen `sid`, decoupled from IC principal on purpose,
// see ../../../../backend/src/ws.mo's doc header), so
// `HttpAgent.create()` with no `identity` would sign every call,
// including ws_open, as the anonymous principal — and
// `ic-websocket-cdk`'s `ws_open` hard-rejects an anonymous caller
// ("Anonymous principal is not allowed"), so the WS handshake, and with
// it the whole app (there's no polling fallback), never came up. Any
// real, non-anonymous identity fixes that; a FRESH one every load is the
// right choice specifically BECAUSE of a real bug in
// `ic-websocket-cdk@0.4.1`'s own bookkeeping: `remove_client` (in its
// `State.mo`) deletes its principal->client_key lookup by PRINCIPAL
// ALONE, not scoped to the exact client_key being removed. A plain page
// reload gives the OLD page's own `ws_close()` (fired from
// `pagehide`/`visibilitychange`, see
// `../../../../../frontend/ws/gateway-client.js`) no guarantee of
// completing before the tab is torn down — so if that stale close (or
// its eventual keep-alive-timeout eviction) is still pending when the
// NEW page's `ws_open` registers, and BOTH share the same principal
// (which a sid-derived identity guarantees across a reload), the stale
// close can land AFTER and silently erase the NEW, perfectly-live
// connection's own lookup entry. A fresh random principal every load
// means no two registrations ever share a principal in the first place,
// so this whole class of collision can't happen — the engine's own
// player identity (`sid`) already persists across reload regardless,
// completely independent of this principal, so nothing player-visible
// is lost by NOT also pinning the WS-layer principal.
const agent = await HttpAgent.create({
  host,
  identity: Ed25519KeyIdentity.generate(),
  shouldFetchRootKey: /localhost|127\.0\.0\.1/.test(host),
});
const idlFactory = makeIdlFactory(plugin.idlTypes);
const actor = Actor.createActor(idlFactory, { agent, canisterId });

window.__resolveDuelActor(actor);

// A real push transport for the generic lobby/staging/rematch/debrief
// chrome below — see ../../../../../frontend/README.md's "Real-time
// push" section. connectWs() builds a GatewayWs that speaks
// mo:duel-game-core/ws's ic-websocket-cdk protocol directly,
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
