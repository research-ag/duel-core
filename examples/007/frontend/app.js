// Bootstrap for the 007 duel client. Builds the actor and a push-shaped
// `ws` over it, then hands off to `duel-game-core`'s generic session/
// render wiring — everything that is the same for every game on this
// engine lives in the npm package, not here. This file only knows how to
// reach the canister and which GamePlugin to use.
//
// Uses @dfinity/agent loaded from esm.sh — no build step required for
// THIS file; `duel-game-core` itself is fetched once via `npm install`
// (see package.json / .npmrc) since it has no CDN distribution, and is
// imported below by its plain on-disk path — the browser has no bare
// "duel-game-core/..." specifier resolution without an import map.

import { Actor, HttpAgent } from "https://esm.sh/@dfinity/agent@2.4.1";
import { Ed25519KeyIdentity } from "https://esm.sh/@dfinity/identity@2.4.1";
import { makeIdlFactory } from "./node_modules/duel-game-core/idl.js";
import { start, getOrCreateSid } from "./node_modules/duel-game-core/app.js";
import { connectWs } from "./node_modules/duel-game-core/ws.js";
import { readIcEnv, deriveHost } from "./node_modules/duel-game-core/ic-env.js";
import { plugin } from "./duel007-plugin.js";

// Deterministically derives a 32-byte Ed25519 seed from this tab's own
// sid (see getOrCreateSid() below) — SHA-256 of the sid's UTF-8 bytes is
// exactly 32 bytes, which is what Ed25519KeyIdentity.generate() wants.
async function seedFromSid(sid) {
  const bytes = new TextEncoder().encode(sid);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(digest);
}

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
// A per-tab identity derived from this tab's own sid — NOT anonymous,
// and NOT a fresh random keypair on every load either. This game has no
// login (players are told apart by seat/sid, never by principal — see
// ../../../backend/src/Ws.mo's doc header: the engine's own identity is
// the client-chosen `sid`, decoupled from IC principal on purpose), so
// `HttpAgent.create()` with no `identity` would sign every call,
// including ws_open, as the anonymous principal — and
// `ic-websocket-cdk`'s `ws_open` hard-rejects an anonymous caller
// ("Anonymous principal is not allowed"), so the WS handshake, and with
// it the whole app (there's no polling fallback), never came up. Deriving
// the identity's seed from `sid` instead of generating it fresh each
// time means a plain page reload — which `getOrCreateSid()` keeps pinned
// to the SAME sid via sessionStorage — also keeps the SAME principal; it
// only changes when the sid does (clicking "play as someone else", a
// `?sid=` override, or clearing site storage — see `getOrCreateSid()`'s
// own doc).
const sid = getOrCreateSid();
const seed = await seedFromSid(sid);
const agent = await HttpAgent.create({
  host,
  identity: Ed25519KeyIdentity.generate(seed),
  shouldFetchRootKey: /localhost|127\.0\.0\.1/.test(host),
});
const idlFactory = makeIdlFactory(plugin.idlTypes);
const actor = Actor.createActor(idlFactory, { agent, canisterId });

// A real push transport — see ../../../frontend/README.md's "Real-time
// push" section. connectWs() builds a GatewayWs that speaks
// mo:duel-game-core/Ws's ic-websocket-cdk protocol directly, self-
// registering this tab as its own Gateway (see
// ../../../frontend/ws/gateway-transport.js) — genuine canister push,
// and a genuine server-side signal if this tab goes quiet. `principal`
// is the same identity `agent`/`actor` already sign calls with;
// `gameIdlTypes` supplies the Candid shape of this game's own
// Action/State (needed to decode the message content blob). `app.js`'s
// start() sends every action and refresh over this — there is no
// plain-actor-call/polling code path any more, `ws` is required.
const principal = await agent.getPrincipal();
const ws = connectWs({ actor, principal, gameIdlTypes: plugin.idlTypes });

start({ plugin, ws });
