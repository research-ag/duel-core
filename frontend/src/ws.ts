// The real-time push transport `start()` requires: a `GatewayWs`
// speaking `mo:duel-game-core/ws`'s CDK protocol directly, each tab
// self-registered as its own Gateway. There is no polling fallback.
//
//   const ws = connectWs({ actor, principal, gameIdlTypes: plugin.idlTypes });
//   start({ plugin, ws, session });
//
// `principal` is the identity `actor` signs with; `gameIdlTypes` is the
// same function passed to `makeIdlFactory()`.

import type { Principal } from "@icp-sdk/core/principal";
import { GatewayWs } from "./ws/gateway-client.js";
import type { WsActor } from "./ws/gateway-transport.js";
import type { BuildGameTypes } from "./idl.js";

/// `intervalMs` (default 500) is the poll interval; `requestTimeoutMs`
/// (default 15000) is how long `request()` waits for its reply.
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
