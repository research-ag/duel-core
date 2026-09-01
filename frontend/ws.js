// Optional real-time push transport — a small, batteries-included wrapper
// around `ic-websocket-js` so a game's client code never has to import it
// (or know a Gateway URL) itself.
//
// This is a deliberate, narrow exception to app.js's "never assume a
// transport-loading strategy" rule: unlike @dfinity/agent (where a game
// might reasonably want a bundled build, a different version, a custom
// identity provider, ...), the wire shape here is entirely fixed by
// `mo:duel-game-core/Ws` (see idl.js) — there's no real choice left for a
// game to make, just boilerplate to repeat. `app.js`'s `start()` itself
// still only ever takes an already-built `ws`; this module is one way to
// build one, not the only way — bring your own `ic-websocket-js` (or a
// mock, for tests) and skip this file entirely if you want to.
//
// Loaded from esm.sh, same "no build step" deal as everything else in
// this package.
//
// Usage:
//
//   import { connectWs } from "duel-game-core/ws.js";
//   const ws = connectWs({ canisterId, actor, host });
//   start({ actor, plugin, ws });   // omit `ws` (pass undefined) to fall
//                                   // back to plain polling

import {
  IcWebSocket,
  createWsConfig,
  generateRandomIdentity,
} from "https://esm.sh/ic-websocket-js@0.5.0";

const PUBLIC_GATEWAY_URL = "wss://gateway.icws.io"; // run by ic-websocket-cdk's authors; mainnet only
const LOCAL_GATEWAY_URL = "ws://localhost:8080"; // ../gateway/ in this repo, self-hosted

/// Builds a ready-to-use `ws` for `app.js`'s `start()`.
///
/// Picks the Gateway automatically: `host` looking local
/// (`localhost`/`127.0.0.1`) means `../gateway/`'s self-hosted instance
/// (see its README — `docker compose up --build` there first), otherwise
/// the public one. Two URL params override this for manual testing:
/// `?ws=0` skips WebSockets entirely (returns `undefined`, so `start()`
/// falls back to polling); `?gateway=<url>` forces a specific Gateway.
///
/// Options (all optional except `canisterId`/`actor`):
///   host       - the network URL `actor`'s agent was built against
///                (default: `location.origin`) — also how locality is
///                auto-detected, so pass the SAME value you gave
///                `HttpAgent.create({ host })`
///   gatewayUrl - override the Gateway URL outright, skipping both the
///                auto local/public choice AND `?gateway=`
///   identity   - a `SignIdentity` to sign messages with (default: a
///                fresh `generateRandomIdentity()` — fine for a game with
///                no notion of player accounts, like the examples here)
///   params     - URLSearchParams to read `ws`/`gateway` from (default:
///                `new URLSearchParams(location.search)`)
///
/// Returns `undefined` (meaning "use polling") if `?ws=0` is set.
export function connectWs({
  canisterId,
  actor,
  host = location.origin,
  gatewayUrl,
  identity,
  params = new URLSearchParams(location.search),
} = {}) {
  if (!canisterId) throw new Error("connectWs(): `canisterId` is required");
  if (!actor) throw new Error("connectWs(): `actor` is required");
  if (params.get("ws") === "0") return undefined;

  const isLocal = /localhost|127\.0\.0\.1/.test(host);
  const url =
    gatewayUrl ??
    params.get("gateway") ??
    (isLocal ? LOCAL_GATEWAY_URL : PUBLIC_GATEWAY_URL);

  const wsConfig = createWsConfig({
    canisterId,
    canisterActor: actor,
    identity: identity ?? generateRandomIdentity(),
    networkUrl: host,
  });
  return new IcWebSocket(url, undefined, wsConfig);
}
