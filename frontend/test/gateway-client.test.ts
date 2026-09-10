// Regression tests for two real bugs in `GatewayWs`'s reconnect handling,
// both observed live in a running game (see the commit that added this
// file for the full incident writeup):
//
//   1. A player's tab that had shown the correct #endedByOther screen
//      clicked "Return to lobby" (`ackEnded`) and nothing happened. The
//      underlying `ws_message` call failed with the CDK's own "Client
//      with principal ... doesn't have an open connection" — the
//      canister had already forgotten this connection (e.g. a keep-alive
//      eviction), so `ws.mo`'s `onMessage` never ran for this request at
//      all. `request()` reconnected but never actually RESENT the
//      `ackEnded` message — it just waited for a reply that could now
//      never arrive, eventually timing out with a swallowed error toast
//      and no screen change.
//   2. A second tab, still showing an in-game view, never learned its
//      game had ended, and its own move submissions kept failing
//      silently. `GatewayWs` only ever fires `onopen` ONCE per instance
//      (guarded by `_opened`) — but this class silently reconnects many
//      times over its life (any failed poll/send invalidates and redoes
//      the `ws_open` handshake). `app.js`'s ONLY automatic resync hook is
//      `ws.onopen = () => refresh()`; once that stopped re-firing after
//      the very first connection, a reconnect this class self-healed
//      never told the caller a gap in coverage had occurred, so a state
//      change synced only server-side (e.g. `Registry.sweep`'s idle takeover —
//      see `../../backend/src/actor_mixin.mo`'s `sweepFunc`, which has no
//      WS/push awareness of its own) was never picked up.
//
// Both are exercised here against a from-scratch, minimal simulation of
// the real `ic-websocket-cdk` canister surface (`FakeWsCdkActor`), driving
// the actual `GatewayWs`/`SelfGatewayTransport`/`GatewayProtocol` code —
// not a higher-level mock that would bypass the very class these bugs
// live in.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { IDL } from "@icp-sdk/core/candid";
import { Principal } from "@icp-sdk/core/principal";
import { encode as cborEncode } from "cborg";
import { GatewayWs } from "../src/ws/gateway-client.js";
import { buildEngineTypes } from "../src/idl.js";
import type { WsActor, TransportClientKey } from "../src/ws/gateway-transport.js";

/// A trivial `{Action, State}` pair — these tests never touch game-move
/// content, only the transport/protocol/reconnect machinery around it.
const gameIdlTypes = () => ({ Action: IDL.Null, State: IDL.Null });
const engineTypes = buildEngineTypes({ IDL, Action: IDL.Null, State: IDL.Null });

function encodeCandid(type: IDL.Type, value: unknown): Uint8Array {
  const buf = IDL.encode([type], [value]);
  return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
}

/// Minimal from-scratch stand-in for the real `ic-websocket-cdk` canister
/// surface — just enough of `ws_open`/`ws_message`/`ws_get_messages`/
/// `ws_close`'s real behavior to drive `GatewayWs` through a genuine
/// open -> app-message -> reconnect cycle, including the exact failure
/// mode ic-websocket-cdk@0.4.1's own `ws_message` produces
/// (`get_client_key_from_principal`'s "doesn't have an open connection")
/// when it rejects a call BEFORE ever invoking the app's `onMessage` —
/// see `backend/.mops/ic-websocket-cdk@0.4.1/src/lib.mo`.
class FakeWsCdkActor implements WsActor {
  private _registered: TransportClientKey | null = null;
  private _queue: Uint8Array[] = [];
  private _msgIndex = 0;
  private _seq = 0;

  /// Set by a test right before an action that should fail exactly once
  /// with this error — simulating the canister having already forgotten
  /// the connection (a keep-alive eviction, an upgrade, ...).
  failNextMessage: string | null = null;
  /// Set by a test to fail the very next `ws_get_messages` poll — the
  /// generic "some round trip blipped" case `_tick()`'s own catch reacts
  /// to by invalidating and redoing the handshake.
  failNextPoll = false;

  openCalls = 0;
  /// How many times a NON-service app message actually reached this
  /// point — i.e., how many times the real equivalent of `ws.mo`'s
  /// `onMessage` would have run.
  appMessagesProcessed = 0;

  /// Test hook: build the `#view`/`#err` reply content for one decoded
  /// `#req`. Defaults to a canned `#view{browsing}` echoing the request's
  /// own `reqId`, which is enough for these tests — they only care
  /// whether a request eventually gets a MATCHING reply, not what status
  /// it carries.
  onReq: (sid: string, req: unknown, reqId: [] | [bigint]) => unknown = (
    _sid,
    _req,
    reqId,
  ) => ({
    view: { reqId, view: { browsing: { tables: [] } } },
  });

  private _pushEnvelope(clientKey: TransportClientKey, isService: boolean, content: Uint8Array): void {
    this._seq += 1;
    const outer = {
      client_key: {
        client_principal: clientKey.client_principal.toUint8Array(),
        client_nonce: clientKey.client_nonce,
      },
      sequence_num: BigInt(this._seq),
      timestamp: BigInt(Date.now()) * 1_000_000n,
      is_service_message: isService,
      content,
    };
    this._queue.push(cborEncode(outer));
  }

  async ws_open(args: { client_nonce: bigint; gateway_principal: Principal }) {
    this.openCalls += 1;
    const clientKey: TransportClientKey = {
      client_principal: args.gateway_principal,
      client_nonce: args.client_nonce,
    };
    this._registered = clientKey;
    const openContent = encodeCandid(engineTypes.WebsocketServiceMessageContent, {
      OpenMessage: { client_key: clientKey },
    });
    this._pushEnvelope(clientKey, true, openContent);
    return { Ok: null };
  }

  async ws_close(_args: { client_key: TransportClientKey }) {
    this._registered = null;
    return { Ok: null };
  }

  async ws_message(
    args: { msg: { is_service_message: boolean; content: Uint8Array } },
    _msgType: [Uint8Array] | [],
  ) {
    if (this.failNextMessage != null) {
      const err = this.failNextMessage;
      this.failNextMessage = null;
      return { Err: err };
    }
    if (!this._registered) {
      return { Err: "Client doesn't have an open connection" };
    }
    if (args.msg.is_service_message) {
      return { Ok: null }; // keep-alive ack reply — no reply of our own needed here
    }
    const decoded = IDL.decode([engineTypes.WsMsg], args.msg.content)[0] as {
      req?: { sid: string; req: unknown; reqId: [] | [bigint] };
    };
    if (decoded.req) {
      this.appMessagesProcessed += 1;
      const { sid, req, reqId } = decoded.req;
      const reply = this.onReq(sid, req, reqId);
      const replyContent = encodeCandid(engineTypes.WsMsg, reply);
      this._pushEnvelope(this._registered, false, replyContent);
    }
    return { Ok: null };
  }

  async ws_get_messages(_args: { nonce: bigint }) {
    if (this.failNextPoll) {
      this.failNextPoll = false;
      return { Err: "boom" };
    }
    const messages = this._queue.map((content) => {
      const key = `gateway_${this._msgIndex}_${this._msgIndex}`;
      this._msgIndex += 1;
      return { key, content };
    });
    this._queue = [];
    return { Ok: { messages, is_end_of_queue: true } };
  }
}

async function waitUntil(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil: condition never became true");
    }
    await delay(5);
  }
}

test("onopen fires again after a self-healed reconnect, not just the first connection", async () => {
  const actor = new FakeWsCdkActor();
  const principal = Principal.fromUint8Array(new Uint8Array([1, 1, 1]));
  const ws = new GatewayWs({
    actor,
    principal,
    gameIdlTypes,
    intervalMs: 15,
    requestTimeoutMs: 500,
  });
  try {
    let opens = 0;
    ws.onopen = () => {
      opens += 1;
    };

    await waitUntil(() => opens === 1);
    assert.equal(actor.openCalls, 1);

    // Simulate a transient round-trip blip — the same thing a keep-alive
    // eviction, a cold-starting canister, or a redeploy produces: the
    // NEXT poll fails, `_tick()` invalidates, and the transport redoes
    // the `ws_open` handshake from scratch.
    actor.failNextPoll = true;
    await waitUntil(() => actor.openCalls === 2);

    // The whole point: a caller relying solely on `onopen` to resync
    // (exactly what `app.js`'s `refresh()` does) must be told about this
    // second connection too, not just the first.
    await waitUntil(() => opens === 2);
  } finally {
    ws.close();
  }
});

test("request() resends the app message after a connection-registration send failure instead of only waiting for a reply that can never arrive", async () => {
  const actor = new FakeWsCdkActor();
  const principal = Principal.fromUint8Array(new Uint8Array([2, 2, 2]));
  const ws = new GatewayWs({
    actor,
    principal,
    gameIdlTypes,
    intervalMs: 15,
    requestTimeoutMs: 2000,
  });
  try {
    let opens = 0;
    ws.onopen = () => {
      opens += 1;
    };
    await waitUntil(() => opens === 1);

    // Simulate the canister having already forgotten this connection —
    // ic-websocket-cdk@0.4.1's own `ws_message` rejects a call like this
    // BEFORE ever calling into `ws.mo`'s `onMessage`, so no reply for it
    // can ever exist server-side.
    actor.failNextMessage = "Client with principal x doesn't have an open connection";

    const started = Date.now();
    const payload = await ws.request!("sid-1", { status: null });
    const elapsed = Date.now() - started;

    assert.ok("view" in payload, `expected a view reply, got ${JSON.stringify(payload)}`);
    // Resolved via the resend-after-reconnect path, not the 2000ms
    // timeout backstop.
    assert.ok(elapsed < 1500, `resolved too slowly (${elapsed}ms) — looks like it fell through to the timeout instead of resending`);
    // Processed exactly once: the first attempt never reached the fake
    // canister's app-message handling at all (it failed before that), so
    // only the resend actually counted.
    assert.equal(actor.appMessagesProcessed, 1);
  } finally {
    ws.close();
  }
});

test("send() (fire-and-forget) also resends after a connection-registration send failure", async () => {
  const actor = new FakeWsCdkActor();
  const principal = Principal.fromUint8Array(new Uint8Array([3, 3, 3]));
  const ws = new GatewayWs({
    actor,
    principal,
    gameIdlTypes,
    intervalMs: 15,
    requestTimeoutMs: 2000,
  });
  try {
    let opens = 0;
    ws.onopen = () => {
      opens += 1;
    };
    await waitUntil(() => opens === 1);

    actor.failNextMessage = "Client with principal x doesn't have an open connection";
    ws.send({ req: { sid: "sid-2", req: { status: null } } });

    await waitUntil(() => actor.appMessagesProcessed === 1);
  } finally {
    ws.close();
  }
});
