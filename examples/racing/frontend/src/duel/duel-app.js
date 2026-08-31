// Bootstrap for the racing duel client. Builds the actor, then hands off
// to duel-game-core's generic session/poll/render wiring for everything
// that's the same for every game on this engine (lobby, staging, rematch,
// debrief, session identity, polling) — see index.html's #screen. It also
// publishes that same actor on `window.duelActorReady` so the app's own
// esbuild bundle loaded alongside this page (see main.ts) can drive the
// actual 3D race against the identical session, without building a
// second one — see
// ../app/modules/gameplay/game-communication/utils/duel-actor.ts.
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
import { readIcEnv, deriveHost } from './node_modules/duel-game-core/ic-env.js';
import { plugin } from './duel-racing-plugin.js';

// `window.duelActorReady` / `window.__resolveDuelActor` are set up by an
// INLINE (non-module) script in index.html's <head>, so the Promise exists
// before any deferred module script runs — the app's own bundle can then
// safely `await` it no matter which of the two loads/executes first.
if (!window.__resolveDuelActor) {
  throw new Error("window.__resolveDuelActor is missing — check index.html's inline bootstrap script");
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
start({ actor, plugin });
