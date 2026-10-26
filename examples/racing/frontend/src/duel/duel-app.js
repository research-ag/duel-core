// Bootstrap for the racing duel client: build the actor and push
// transport, hand off to duel-game-core's generic wiring, publish both on
// `window.duelActorReady`/`duelTransportReady` so main.ts's own bundle drives the
// 3D race over the same session and connection, and mount the leaderboard
// and bot-challenge overlays. Bundled by esbuild (../../build.js).

import { Actor, HttpAgent } from '@icp-sdk/core/agent';
import { safeGetCanisterEnv } from '@icp-sdk/core/agent/canister-env';
import { makeIdlFactory } from '@research-ag/duel-game-core/idl.js';
import { start } from '@research-ag/duel-game-core/app.js';
import { botPlayer, mountBotChallenge, mountLeaderboard } from '@research-ag/duel-game-core/bots.js';
import { connectTransport } from '@research-ag/duel-game-core/transport.js';
import { resolveIdentity } from '@research-ag/duel-game-core/identity.js';
import { deriveHost } from '@research-ag/duel-game-core/ic-env.js';
import { plugin } from './duel-racing-plugin.js';

// Set up by an inline script in index.html's <head>, before any module runs.
if (!window.__resolveDuelActor || !window.__resolveDuelTransport) {
  throw new Error("window.__resolveDuelActor/__resolveDuelTransport is missing — check index.html's inline bootstrap script");
}

const env = safeGetCanisterEnv();
const canisterId = env?.['PUBLIC_CANISTER_ID:backend'];
if (!canisterId) {
  document.body.innerHTML =
    "<p style='color:#ff7b72;padding:2rem'>Could not find " +
    '<code>PUBLIC_CANISTER_ID:backend</code> in the <code>ic_env</code> ' +
    'cookie. Serve this page from the frontend canister after ' +
    '<code>icp deploy</code>.</p>';
  throw new Error('missing canister id');
}

const host = deriveHost();

// An Internet Identity login if active, else a persisted anonymous keypair
// (the backend rejects the anonymous principal outright). The keypair is
// stable across a reload and `sid` derives from it, as `isAuthorizedSid`
// requires.
const session = await resolveIdentity();
const agent = await HttpAgent.create({
  host,
  identity: session.identity,
  rootKey: env.IC_ROOT_KEY,
});
const idlFactory = makeIdlFactory(plugin.idlTypes);
const actor = Actor.createActor(idlFactory, { agent, canisterId });

window.__resolveDuelActor(actor);

// Shared with lobby-connection.service.ts via window.duelTransportReady, so the
// race runs over this one connection instead of a second poller.
const transport = connectTransport({ actor, gameIdlTypes: plugin.idlTypes });
window.__resolveDuelTransport(transport);

const client = start({ plugin, transport, session });

// "🤖 Bots" (the waiting screen's "Add Bot" and a leaderboard row's
// Challenge) and the 🏆 overlay, whose rows `plugin.formatScore` turns back
// into lap times. See frontend/README.md, "Bots and the leaderboard".
const bots = mountBotChallenge({ client, actor, plugin, play: botPlayer(agent, canisterId) });
mountLeaderboard({ actor, plugin, sid: session.sid, onChallenge: bots.pick });
