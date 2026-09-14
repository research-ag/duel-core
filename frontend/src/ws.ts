// The real-time push transport — the ONLY one `start()` supports, and the
// ONLY way to mutate game state at all: `connectWs()` builds a `GatewayWs`
// (`./ws/gateway-client.js`), a client that speaks `mo:duel-game-core/ws`'s
// real `ic-websocket-cdk` protocol directly, self-registering each tab
// as its own Gateway (see `./ws/gateway-transport.js`'s header for why
// that's a legitimate use of the protocol, not a hack) — genuine
// canister-driven push, and a genuine server-side signal when a
// connection goes quiet (crash, force-quit, network drop; see
// `../backend/src/ws.mo`'s doc header for the resulting detection
// floor), not client-side polling wearing a push-shaped interface. There
// is no plain-polling fallback: a canister built on this package has no
// join/submit/rematch/leave/reset/claimWin/ackEnded Candid method to
// poll in the first place — `mo:duel-game-core/ws` is mandatory, not opt-in (see
// `../backend/src/ws.mo`'s doc header).
//
// Usage:
//
//   import { connectWs } from "duel-game-core/ws.js";
//   const ws = connectWs({ actor, principal, gameIdlTypes: plugin.idlTypes });
//   start({ plugin, ws });
//
// `principal` is the SAME identity `actor` itself signs calls with (e.g.
// `await agent.getPrincipal()`) — needed to self-register as a Gateway.
// `gameIdlTypes` is the SAME `buildGameTypes` function already passed to
// `makeIdlFactory()` (see `./idl.js`) — needed to Candid-encode/decode
// the message content blob, which embeds the game's own `Action`/`State`
// types.

import type { Principal } from "@icp-sdk/core/principal";
import { GatewayWs } from "./ws/gateway-client.js";
import type { WsActor } from "./ws/gateway-transport.js";
import type { BuildGameTypes } from "./idl.js";

/// Builds a ready-to-use `ws` for `app.js`'s `start()` — a `GatewayWs`
/// wired to `actor`/`principal`/`gameIdlTypes`. See this file's header
/// for what it actually does and why.
///
/// Options (all required except `intervalMs`/`requestTimeoutMs`):
///   actor            - the game's actor, already built with an agent/identity
///   principal        - that same identity's own Principal
///   gameIdlTypes     - the `buildGameTypes` function passed to `makeIdlFactory`
///   intervalMs       - how often to poll `ws_get_messages`, in ms (default 500)
///   requestTimeoutMs - how long `request()` waits for its correlated
///                      reply before giving up, in ms (default 15000) —
///                      see `./ws/gateway-client.js`'s `request()` doc
export function connectWs({
  actor,
  principal,
  gameIdlTypes,
  intervalMs,
  requestTimeoutMs,
}: {
  actor: WsActor;
  principal: Principal;
  gameIdlTypes: BuildGameTypes;
  intervalMs?: number;
  requestTimeoutMs?: number;
}): GatewayWs {
  return new GatewayWs({ actor, principal, gameIdlTypes, intervalMs, requestTimeoutMs });
}

export { GatewayWs };
