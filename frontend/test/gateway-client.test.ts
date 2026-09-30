// Regression tests for two real bugs in `GatewayWs`'s reconnect handling: a
// request whose `ws_message` failed was never resent, and `onopen` fired only
// once, so a self-healed reconnect never resynced the caller. Driven against
// a minimal fake of the real CDK canister surface (`FakeWsCdkActor`).

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
/// surface
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
  /// `#req`.
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

  async ws_open(
    args: { client_nonce: bigint; gateway_principal: Principal },
    initial: [Uint8Array] | [] = [],
  ) {
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
    if (initial.length) this._handleApp(clientKey, initial[0]);
    return { Ok: null };
  }

  private _handleApp(clientKey: TransportClientKey, content: Uint8Array): void {
    const decoded = IDL.decode([engineTypes.WsMsg], content)[0] as {
      req?: { sid: string; req: unknown; reqId: [] | [bigint] };
    };
    if (!decoded.req) return;
    this.appMessagesProcessed += 1;
    const { sid, req, reqId } = decoded.req;
    const replyContent = encodeCandid(engineTypes.WsMsg, this.onReq(sid, req, reqId));
    this._pushEnvelope(clientKey, false, replyContent);
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
    this._handleApp(this._registered, args.msg.content);
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
