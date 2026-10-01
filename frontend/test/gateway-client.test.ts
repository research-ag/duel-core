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
/// surface. Like the real one, the outgoing queue belongs to the gateway
/// (it outlives a connection), a poll returns what is at or past its
/// nonce, and an unknown gateway's poll is an error.
class FakeWsCdkActor implements WsActor {
  private _registered: TransportClientKey | null = null;
  private _log: Array<{ nonce: number; content: Uint8Array }> = [];
  private _nextNonce = 0;
  private _seq = 0;
  private _gatewayKnown = false;

  /// Set by a test right before an action that should fail exactly once
  /// with this error — simulating the canister having already forgotten
  /// the connection (a keep-alive eviction, an upgrade, ...).
  failNextMessage: string | null = null;
  /// How many upcoming `ws_get_messages` polls fail — the generic "some
  /// round trip blipped" case `_tick()`'s own catch reacts to.
  failPolls = 0;

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
    this._log.push({ nonce: this._nextNonce, content: cborEncode(outer) });
    this._nextNonce += 1;
  }

  /// A canister upgrade: `transient` CDK state is gone, the counter
  /// restarts, the gateway is unknown until its next `ws_open`.
  upgrade(): void {
    this._registered = null;
    this._log = [];
    this._nextNonce = 0;
    this._gatewayKnown = false;
  }

  /// A keep-alive eviction: a `CloseMessage` for the current connection,
  /// which is then unregistered (the gateway lingers).
  evict(): void {
    if (!this._registered) return;
    const content = encodeCandid(engineTypes.WebsocketServiceMessageContent, {
      CloseMessage: { reason: { KeepAliveTimeout: null } },
    });
    this._pushEnvelope(this._registered, true, content);
    this._registered = null;
  }

  /// Test hook: an unsolicited `#view`/`#err` to the current connection.
  push(msg: unknown): void {
    if (!this._registered) return;
    this._pushEnvelope(this._registered, false, encodeCandid(engineTypes.WsMsg, msg));
  }

  async ws_open(
    args: { client_nonce: bigint; gateway_principal: Principal },
    initial: [Uint8Array] | [] = [],
  ) {
    this.openCalls += 1;
    this._gatewayKnown = true;
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

  async ws_get_messages(args: { nonce: bigint }) {
    if (this.failPolls > 0) {
      this.failPolls -= 1;
      return { Err: "boom" };
    }
    if (!this._gatewayKnown) return { Err: "gateway not registered" };
    const messages = this._log
      .filter((m) => BigInt(m.nonce) >= args.nonce)
      .map((m) => ({ key: `gateway_${String(m.nonce).padStart(20, "0")}`, content: m.content }));
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

    // One failed poll is a blip and retried as is; two in a row mean the
    // canister forgot this gateway, and the transport redoes `ws_open`.
    actor.failPolls = 1;
    await waitUntil(() => actor.failPolls === 0);
    await delay(60);
    assert.equal(actor.openCalls, 1, "a single failed poll must not reconnect");
    actor.failPolls = 2;
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

function openWs(actor: FakeWsCdkActor, seed: number, requestTimeoutMs = 2000) {
  const principal = Principal.fromUint8Array(new Uint8Array([seed, seed, seed]));
  const ws = new GatewayWs({ actor, principal, gameIdlTypes, intervalMs: 15, requestTimeoutMs });
  const seen = { opens: 0, connecting: 0, closes: 0, messages: [] as unknown[] };
  ws.onopen = () => {
    seen.opens += 1;
  };
  ws.onconnecting = () => {
    seen.connecting += 1;
  };
  ws.onclose = () => {
    seen.closes += 1;
  };
  ws.onmessage = (ev) => {
    seen.messages.push(ev.data);
  };
  return { ws, seen };
}

test("after a canister upgrade (counter restarted, gateway forgotten) the tab reconnects and hears replies again", async () => {
  const actor = new FakeWsCdkActor();
  const { ws, seen } = openWs(actor, 4);
  try {
    ws.send({ req: { sid: "sid-4", req: { status: null } } });
    await waitUntil(() => seen.opens === 1 && seen.messages.length === 1);
    // Advance the tab's read position well past where a fresh counter
    // restarts.
    for (let i = 0; i < 5; i++) await ws.request("sid-4", { status: null });

    actor.upgrade();
    actor.failNextMessage = "Client with principal x doesn't have an open connection";
    const payload = await ws.request("sid-4", { status: null });
    assert.ok("view" in payload, "the reply sent after the upgrade must reach the tab");
    assert.equal(seen.opens, 2);
    assert.equal(seen.connecting, 1, "the caller hears the connection was lost");
    assert.equal(seen.closes, 0, "an upgrade is not the end of the connection");
  } finally {
    ws.close();
  }
});

test("an upgrade noticed only by polling reconnects, re-binding the sid with a #status inside ws_open", async () => {
  const actor = new FakeWsCdkActor();
  const { ws, seen } = openWs(actor, 5);
  try {
    ws.send({ req: { sid: "sid-5", req: { status: null } } });
    await waitUntil(() => seen.opens === 1 && actor.appMessagesProcessed === 1);
    actor.upgrade();
    await waitUntil(() => seen.opens === 2);
    assert.equal(actor.appMessagesProcessed, 2, "the reopen carried a #status of its own");
    await waitUntil(() => seen.messages.length === 2);
  } finally {
    ws.close();
  }
});

test("a CDK CloseMessage (keep-alive eviction) reconnects instead of closing for good", async () => {
  const actor = new FakeWsCdkActor();
  const { ws, seen } = openWs(actor, 6);
  try {
    ws.send({ req: { sid: "sid-6", req: { status: null } } });
    await waitUntil(() => seen.opens === 1);
    actor.evict();
    await waitUntil(() => seen.opens === 2);
    assert.equal(seen.closes, 0);
    assert.equal(seen.connecting, 1);
    assert.equal(ws.closed, false);
    const payload = await ws.request("sid-6", { status: null });
    assert.ok("view" in payload);
  } finally {
    ws.close();
  }
});

test("a new page ignores what an earlier connection left in the gateway's queue", async () => {
  const actor = new FakeWsCdkActor();
  const first = openWs(actor, 7);
  await waitUntil(() => first.seen.opens === 1);
  // The old page's failed call: its reply is still queued when it goes.
  actor.push({ err: { reqId: [1n], err: { notSeated: null } } });
  first.ws.close();

  const second = openWs(actor, 7);
  try {
    second.ws.send({ req: { sid: "sid-7", req: { status: null } } });
    await waitUntil(() => second.seen.opens === 1 && second.seen.messages.length === 1);
    await delay(60);
    assert.deepEqual(second.seen.messages, [{ view: { browsing: { tables: [] } } }]);
  } finally {
    second.ws.close();
  }
});

test("a request with no reply in time reconnects as well as rejecting", async () => {
  const actor = new FakeWsCdkActor();
  const { ws, seen } = openWs(actor, 8, 100);
  try {
    await waitUntil(() => seen.opens === 1);
    actor.onReq = () => ({ view: { reqId: [999n], view: { browsing: { tables: [] } } } });
    await assert.rejects(() => ws.request("sid-8", { status: null }), /timed out/);
    await waitUntil(() => seen.opens === 2);
  } finally {
    ws.close();
  }
});

test("queryStatus() uses the actor's plain status query, and rejects when there is none", async () => {
  const actor = new FakeWsCdkActor();
  const { ws } = openWs(actor, 9);
  try {
    await assert.rejects(() => ws.queryStatus("sid-9"), /no `status` query/);
    (actor as WsActor).status = async (sid: string) => ({ browsing: { tables: [] }, sid }) as never;
    assert.deepEqual(await ws.queryStatus("sid-9"), { browsing: { tables: [] }, sid: "sid-9" });
  } finally {
    ws.close();
  }
});

test("pagehide says goodbye and suspends the loop (no reopen to cancel the departure); pageshow reconnects", async () => {
  // Node's `globalThis` is no `EventTarget`; lend it one, as a window is.
  const win = new EventTarget();
  const g = globalThis as unknown as Record<string, unknown>;
  const lent = ["addEventListener", "removeEventListener", "dispatchEvent"] as const;
  for (const k of lent) g[k] = (win as unknown as Record<string, Function>)[k].bind(win);
  const actor = new FakeWsCdkActor();
  const { ws, seen } = openWs(actor, 10);
  try {
    ws.send({ req: { sid: "sid-10", req: { status: null } } });
    await waitUntil(() => seen.opens === 1);
    win.dispatchEvent(new Event("pagehide"));
    await delay(80);
    assert.equal(actor.openCalls, 1, "no tick may reopen after the goodbye");
    win.dispatchEvent(new Event("pageshow"));
    await waitUntil(() => seen.opens === 2);
    assert.equal(seen.closes, 0);
  } finally {
    ws.close();
    for (const k of lent) delete g[k];
  }
});
